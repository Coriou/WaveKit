import type { ChannelProvider } from "../../channelizer/types.js"
import type { CleanupOutcome } from "../../channelizer/settlement-observer.js"
import { WaveKitError } from "../../../utils/errors.js"
import type {
	ScannerChannelAttempt,
	ScannerChannelOwnership,
	ScannerChannelProfile,
} from "./consumer-types.js"
import {
	prepareDirectChannel,
	type PreparedScannerChannel,
} from "./provider-observer.js"

const RATE = 48_000
const MAX_SAMPLES = 96_000
const MAX_BYTES = MAX_SAMPLES * 8
const OK: CleanupOutcome = Object.freeze({ ok: true })

export interface ChannelTapResult {
	readonly attempt: ScannerChannelAttempt
	readonly samples: Float32Array
	readonly outputRateHz: 48000
	readonly format: "cf32"
	readonly gaps: boolean
}
export interface ChannelTapRequest {
	readonly attempt: ScannerChannelAttempt
	readonly current: () => boolean
	readonly minMs: number
	/** Private callback may hand the SAME live native tap to analog after classifier drain. */
	readonly collected: (result: ChannelTapResult, tap: ChannelTapHandle) => void
}
export interface ChannelTapHandle {
	readonly prepared: PreparedScannerChannel
	readonly current: boolean
	/** Called after synchronous classifier drain, BEFORE analog construction/effects. */
	beginAnalog(): boolean
	attachAnalog(consumer: ChannelAnalogConsumer): boolean
	sealIntake(): void
	/** Producer settlement may release logically without awaiting its own component drain. */
	releaseLogical(): Promise<void>
	finish(): Promise<void>
	cancel(): void
}
export interface ChannelAnalogConsumer {
	/** Bounded downstream intake; the consumer owns asynchronous writes until settled. */
	readonly push: (samples: Float32Array) => void
	readonly cancel: () => void
	readonly settled: Promise<CleanupOutcome>
}
interface Slot {
	readonly input: ChannelTapRequest
	readonly prepared: PreparedScannerChannel
	readonly handle: ChannelTapHandle
	samples: Float32Array | undefined
	readonly start: number
	phase: "pending" | "collecting" | "handoff" | "analog" | "closing"
	count: number
	tail: Buffer
	gaps: boolean
	collected: boolean
	collectionStart: number
	acquisition: Promise<void> | undefined
	drain: Promise<void> | undefined
	offData: (() => void) | undefined
	analog: ChannelAnalogConsumer | undefined
	analogBegun: boolean
	cleanupFailed: boolean
}

/** ONE source owner includes pending, collecting, handoff, closing and unknown tombstones. */
export class ChannelTaps {
	private readonly slots = new Map<string, Slot>()
	private sealed = false
	private stopPromise: Promise<CleanupOutcome> | undefined
	constructor(
		private readonly deps: {
			readonly channels: ChannelProvider | null | undefined
			readonly ownership: ScannerChannelOwnership | undefined
			readonly profile: ScannerChannelProfile | null | undefined
			readonly maxSources: number
			readonly now: () => number
		},
	) {
		if (!Number.isSafeInteger(deps.maxSources) || deps.maxSources < 1)
			throw new WaveKitError(
				"Bounded channel sources required",
				"SCANNER_CHANNEL_BOUND",
			)
	}
	get ownerCount(): number {
		return this.slots.size
	}

	begin(input: ChannelTapRequest): ChannelTapHandle | undefined {
		this.reap()
		if (
			this.sealed ||
			this.slots.has(input.attempt.sourceId) ||
			this.slots.size >= this.deps.maxSources ||
			!Number.isFinite(input.minMs) ||
			input.minMs < 300 ||
			input.minMs > 2000 ||
			!input.current()
		)
			return undefined
		let slot: Slot | undefined
		const prepared = prepareDirectChannel({
			channels: this.deps.channels,
			ownership: this.deps.ownership,
			profile: this.deps.profile,
			attempt: input.attempt,
			request: {
				centerHz: input.attempt.targetHz,
				bandwidthHz: 16_000,
				transitionHz: 4_000,
				outputRateHz: RATE,
				format: "cf32",
			},
			current: () => !this.sealed && input.current(),
			ended: () => {
				if (slot) void this.close(slot).catch(() => undefined)
			},
		})
		if (!prepared) return undefined
		const handle: ChannelTapHandle = Object.freeze({
			prepared,
			get current() {
				return prepared.lifecycle.live
			},
			beginAnalog: () => {
				if (
					!slot ||
					slot.phase !== "handoff" ||
					!prepared.lifecycle.live ||
					prepared.handle.snapshot().components.classifier !== "settled" ||
					slot.analogBegun
				)
					return false
				slot.analogBegun = prepared.analog.begin()
				return slot.analogBegun
			},
			attachAnalog: (consumer: ChannelAnalogConsumer) =>
				this.attachAnalog(slot!, consumer),
			sealIntake: () => {
				slot!.offData?.()
				slot!.offData = undefined
				slot!.tail = Buffer.alloc(0)
			},
			releaseLogical: () => {
				prepared.lifecycle.invalidate()
				return prepared.lifecycle.logicalDrain()
			},
			finish: () => this.close(slot!),
			cancel: () => {
				void this.close(slot!).catch(() => undefined)
			},
		})
		slot = {
			input,
			prepared,
			handle,
			samples: undefined,
			start: this.deps.now(),
			phase: "pending",
			count: 0,
			tail: Buffer.alloc(0),
			gaps: false,
			collected: false,
			collectionStart: 0,
			acquisition: undefined,
			drain: undefined,
			offData: undefined,
			analog: undefined,
			analogBegun: false,
			cleanupFailed: false,
		}
		this.slots.set(input.attempt.sourceId, slot)
		const original = slot
		// Own acquisition before any continuation; no pregrant ID derivation/release.
		let acquired!: () => void
		let failed!: (cause: unknown) => void
		original.acquisition = new Promise<void>((yes, no) => {
			acquired = yes
			failed = no
		})
		void original.acquisition.catch(() => {
			original.handle.cancel()
		})
		void this.acquire(original).then(acquired, failed)
		return handle
	}

	/** Uses the existing service tick; no extra timer or expiry-based native credit. */
	tick(): void {
		for (const slot of this.slots.values()) {
			if (!slot.input.current()) {
				slot.handle.cancel()
				continue
			}
			if (slot.phase === "pending" && this.deps.now() - slot.start >= 5000)
				slot.handle.cancel()
			else if (
				slot.phase === "collecting" &&
				this.deps.now() - slot.collectionStart >= 2000
			)
				this.deliver(slot)
		}
		this.reap()
	}

	cancelSource(sourceId: string): void {
		this.slots.get(sourceId)?.handle.cancel()
	}
	sealAdmission(): void {
		this.sealed = true
		for (const slot of this.slots.values()) slot.handle.cancel()
	}

	/** Phase40 drains own classifier/intake/logical attempts, NEVER native accounting. */
	stop(): Promise<CleanupOutcome> {
		if (this.stopPromise) return this.stopPromise
		let resolve!: (outcome: CleanupOutcome) => void
		let reject!: (cause: unknown) => void
		this.stopPromise = new Promise<CleanupOutcome>((yes, no) => {
			resolve = yes
			reject = no
		})
		void this.stopPromise.catch(() => undefined)
		// Own the first handle before sealing can synchronously reenter stop.
		void this.stopComponents().then(resolve, reject)
		return this.stopPromise
	}

	private async stopComponents(): Promise<CleanupOutcome> {
		this.sealAdmission()
		const outcomes = await Promise.allSettled(
			[...this.slots.values()].map(slot => this.close(slot)),
		)
		return outcomes.some(outcome => outcome.status === "rejected")
			? {
					ok: false,
					state: "failed",
					detail: "Scanner channel component cleanup failed",
				}
			: OK
	}

	private async acquire(slot: Slot): Promise<void> {
		const channels = this.deps.channels!
		const result = await channels.requestChannel(
			slot.input.attempt.sourceId,
			slot.input.attempt.decoderId,
			slot.prepared.request,
			{
				kind: "iq",
				format: "U8_IQ",
				sampleRate: slot.input.attempt.captureRateHz,
				centerFreq: slot.input.attempt.captureCentreHz,
				exclusive: false,
			},
		)
		if (!result.ok) {
			slot.prepared.classifier.sealNeverStarted()
			slot.prepared.analog.sealNeverStarted()
			slot.prepared.lifecycle.invalidate()
			this.fence(slot)
			return
		}
		if (
			!slot.prepared.lifecycle.adopt(result) ||
			this.sealed ||
			slot.phase === "closing" ||
			!slot.prepared.classifier.begin()
		) {
			slot.prepared.classifier.sealNeverStarted()
			slot.prepared.analog.sealNeverStarted()
			slot.prepared.lifecycle.invalidate()
			return
		}
		slot.samples = new Float32Array(MAX_SAMPLES * 2)
		slot.phase = "collecting"
		slot.collectionStart = this.deps.now()
		const onData = (bytes: unknown): void => {
			if (
				!Buffer.isBuffer(bytes) ||
				!slot.prepared.lifecycle.live ||
				slot.phase !== "collecting"
			)
				return
			this.push(slot, bytes)
		}
		result.stream.on("data", onData)
		slot.offData = () => result.stream.off("data", onData)
		if (!slot.prepared.lifecycle.live) slot.handle.cancel()
	}

	private push(slot: Slot, bytes: Buffer): void {
		const remaining = MAX_BYTES - slot.count * 8
		if (bytes.length > remaining + 7 - slot.tail.length) {
			slot.gaps = true
			slot.handle.cancel()
			return
		}
		const data = slot.tail.length ? Buffer.concat([slot.tail, bytes]) : bytes
		const complete = data.length - (data.length % 8)
		for (let index = 0; index < complete; index += 8) {
			const real = data.readFloatLE(index),
				imaginary = data.readFloatLE(index + 4)
			if (!Number.isFinite(real) || !Number.isFinite(imaginary)) {
				slot.gaps = true
				slot.handle.cancel()
				return
			}
			slot.samples![slot.count * 2] = real
			slot.samples![slot.count * 2 + 1] = imaginary
			slot.count++
		}
		slot.tail = Buffer.from(data.subarray(complete))
		if (
			slot.count >= Math.ceil((RATE * Math.max(500, slot.input.minMs)) / 1000)
		)
			this.deliver(slot)
	}

	private deliver(slot: Slot): void {
		if (
			slot.collected ||
			slot.phase !== "collecting" ||
			!slot.prepared.lifecycle.live
		)
			return
		slot.collected = true
		slot.phase = "handoff"
		slot.offData?.()
		slot.offData = undefined
		const result = Object.freeze({
			attempt: slot.input.attempt,
			samples: slot.samples!.subarray(0, slot.count * 2),
			outputRateHz: RATE as 48000,
			format: "cf32" as const,
			gaps: slot.gaps || slot.tail.length !== 0,
		})
		let outcome: CleanupOutcome = OK
		try {
			slot.input.collected(result, slot.handle)
		} catch {
			outcome = {
				ok: false,
				state: "failed",
				detail: "Scanner classifier component failed",
			}
			slot.handle.cancel()
		} finally {
			// The synchronous consumer has finished; do not refund F with its buffer retained.
			slot.samples = undefined
			slot.tail = Buffer.alloc(0)
			slot.prepared.classifier.settle(outcome)
		}
	}

	private fence(slot: Slot): void {
		const alreadyClosing = slot.phase === "closing"
		slot.phase = "closing"
		try {
			slot.offData?.()
		} catch {
			slot.cleanupFailed = true
		}
		slot.offData = undefined
		if (!alreadyClosing) {
			try {
				slot.analog?.cancel()
			} catch {
				slot.cleanupFailed = true
			}
		}
	}

	private attachAnalog(slot: Slot, consumer: ChannelAnalogConsumer): boolean {
		if (slot.analog || !slot.analogBegun) return false
		// Retain the original consumer before its cancellation can reenter.
		slot.analog = consumer
		void consumer.settled.catch(() => undefined)
		const stream = slot.prepared.lifecycle.readable
		if (!stream || slot.phase !== "handoff" || this.sealed) {
			consumer.cancel()
			void this.close(slot).catch(() => undefined)
			return false
		}
		slot.phase = "analog"
		const onData = (bytes: unknown): void => {
			if (
				!Buffer.isBuffer(bytes) ||
				slot.phase !== "analog" ||
				!slot.prepared.lifecycle.live
			)
				return
			if (bytes.length > MAX_BYTES - slot.tail.length) {
				slot.handle.cancel()
				return
			}
			const data = slot.tail.length ? Buffer.concat([slot.tail, bytes]) : bytes
			const complete = data.length - (data.length % 8)
			const samples = new Float32Array(complete / 4)
			for (let index = 0; index < complete; index += 4) {
				const value = data.readFloatLE(index)
				if (!Number.isFinite(value)) {
					slot.handle.cancel()
					return
				}
				samples[index / 4] = value
			}
			slot.tail = Buffer.from(data.subarray(complete))
			try {
				if (samples.length > 0) consumer.push(samples)
			} catch {
				slot.handle.cancel()
			}
		}
		stream.on("data", onData)
		slot.offData = () => stream.off("data", onData)
		if (!slot.prepared.lifecycle.live) {
			slot.handle.cancel()
			return false
		}
		return true
	}

	private close(slot: Slot): Promise<void> {
		if (slot.drain) return slot.drain
		let resolve!: () => void
		let reject!: (cause: unknown) => void
		slot.drain = new Promise<void>((yes, no) => {
			resolve = yes
			reject = no
		})
		void slot.drain.catch(() => undefined)
		// Claim before ended/release callbacks can reenter this same owner.
		this.fence(slot)
		slot.prepared.lifecycle.invalidate()
		void this.drain(slot).then(resolve, reject)
		return slot.drain
	}
	private async drain(slot: Slot): Promise<void> {
		let failure: WaveKitError | undefined
		try {
			await slot.acquisition
		} catch {
			failure = new WaveKitError(
				"Scanner channel acquisition cleanup failed",
				"SCANNER_CHANNEL_CLEANUP_FAILED",
			)
		}
		slot.samples = undefined
		slot.tail = Buffer.alloc(0)
		slot.prepared.classifier.settle(OK)
		if (slot.analog) {
			let outcome: CleanupOutcome
			try {
				outcome = await slot.analog.settled
			} catch {
				outcome = {
					ok: false,
					state: "failed",
					detail: "Scanner analog component cleanup failed",
				}
			}
			slot.prepared.analog.settle(outcome)
			if (!outcome.ok)
				failure ??= new WaveKitError(
					"Scanner analog component cleanup failed",
					"SCANNER_CHANNEL_CLEANUP_FAILED",
				)
		} else if (slot.analogBegun) {
			slot.prepared.analog.settle({
				ok: false,
				state: "unknown",
				detail: "Scanner analog owner missing",
			})
			failure ??= new WaveKitError(
				"Scanner analog owner missing",
				"SCANNER_CHANNEL_CLEANUP_PENDING",
			)
		} else slot.prepared.analog.sealNeverStarted()
		try {
			await slot.prepared.lifecycle.logicalDrain()
		} catch {
			failure ??= new WaveKitError(
				"Scanner logical channel release failed",
				"SCANNER_CHANNEL_CLEANUP_FAILED",
			)
		}
		if (slot.cleanupFailed)
			failure ??= new WaveKitError(
				"Scanner channel intake cleanup failed",
				"SCANNER_CHANNEL_CLEANUP_FAILED",
			)
		if (failure) throw failure
	}
	private reap(): void {
		for (const [source, slot] of this.slots) {
			if (
				slot.phase === "closing" &&
				!slot.cleanupFailed &&
				slot.prepared.lifecycle.reclaimIfSettled()
			)
				this.slots.delete(source)
		}
	}
}
