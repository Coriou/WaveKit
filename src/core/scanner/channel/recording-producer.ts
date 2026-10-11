/** Current-grant bridge to accepted analog evidence; native lifetime proof stays external. */
import { WaveKitError } from "../../../utils/errors.js"
import type { CleanupOutcome } from "../../channelizer/settlement-observer.js"
import { AnalogReceiptSchema } from "../store/analog-operations.js"
import type {
	AnalogCut,
	AnalogGap,
	AnalogHandle,
	AnalogInput,
	AnalogReceipt,
} from "../store/analog-operations.js"
import {
	RecordingBindingSchema,
	RecordingIdentitySchema,
	type RecordingBinding,
} from "../store/recording-operation.js"
import { AnalogRecorder } from "./analog-recorder.js"

export interface RecordingGrantIdentity {
	readonly binding: RecordingBinding
	readonly provider: object
	readonly token: object
}
/** Adapt only an exact core ownership inspection/proof, never a logical release promise. */
export interface RecordingNativeOutcome {
	readonly status: "released" | "unknown"
	readonly provider: object
	readonly token: object
}
export interface RecordingProducerInput extends RecordingGrantIdentity {
	readonly discoveryId: string
	readonly observationId: string
	readonly recordAudio: boolean
	readonly analogFm: boolean
	readonly encrypted: boolean
	readonly nativeOwnershipSettled: Promise<RecordingNativeOutcome>
	readonly thresholdDbfs: number | null
	readonly hangMs?: number
	readonly deemphasisUs?: number | null
}
export interface RecordingProducerDeps {
	readonly enabled: boolean
	readonly profileReady: boolean
	readonly adoptionReady: boolean
	/** Existing bounded source/tap ownership, supplied by composition; no inferred profile. */
	readonly maxOwners: number
	readonly isCurrentCommitted: (identity: RecordingGrantIdentity) => boolean
	readonly beginAnalogComponent: (identity: RecordingGrantIdentity) => boolean
	readonly beginAnalog: (input: AnalogInput) => AnalogHandle
	readonly releaseLogical: (identity: RecordingGrantIdentity) => Promise<void>
}
export interface RecordingProducerSettlement {
	readonly receipt: AnalogReceipt | null
	readonly error: WaveKitError | null
	readonly filesystem: CleanupOutcome
	readonly operation: CleanupOutcome
	readonly operationSettled: boolean
	readonly logicalReleased: boolean
	readonly componentClosed: boolean
}
export interface RecordingProducerHandle {
	readonly identity: RecordingGrantIdentity
	readonly ready: Promise<void>
	/** Actual producer/operation and logical-release attempts only; never awaits native proof. */
	readonly settled: Promise<RecordingProducerSettlement>
	push(cf32: Float32Array): Promise<void>
	gap(gap: AnalogGap): void
	finish(cut?: AnalogCut): Promise<AnalogReceipt>
	cancel(cut?: AnalogCut): void
}
interface Entry {
	readonly key: string
	readonly discoveryId: string
	readonly observationId: string
	readonly identity: RecordingGrantIdentity
	readonly sourceId: string
	readonly created: Promise<void>
	readonly creationDone: () => void
	readonly settled: Promise<RecordingProducerSettlement>
	readonly settle: (result: RecordingProducerSettlement) => void
	operation: AnalogHandle | null
	recorder: AnalogRecorder | null
	ready: Promise<void>
	terminal: Promise<AnalogReceipt> | null
	accepting: boolean
	live: boolean
	cancelled: AnalogCut | null
	creationError: WaveKitError | null
	producerClosed: boolean
	nativeClosed: boolean
}
function fail(message: string, cause?: unknown): WaveKitError {
	return new WaveKitError(
		message,
		"SCANNER_RECORDING_PRODUCER",
		cause instanceof Error ? cause : undefined,
	)
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(done => {
		resolve = done
	})
	return { promise, resolve }
}
function unknownCleanup(detail: string): CleanupOutcome {
	return Object.freeze({ ok: false, state: "unknown", detail })
}
function receiptOutcomes(
	entry: Entry,
	receipt: AnalogReceipt | null,
	operationSettled: boolean,
): { readonly filesystem: CleanupOutcome; readonly operation: CleanupOutcome } {
	const parsed = AnalogReceiptSchema.safeParse(receipt)
	if (
		!operationSettled ||
		!entry.operation ||
		!parsed.success ||
		parsed.data.operationId !== entry.operation.operationId ||
		parsed.data.discoveryId !== entry.discoveryId ||
		parsed.data.observationId !== entry.observationId ||
		bindingKey(parsed.data.binding) !== entry.key
	) {
		return {
			filesystem: unknownCleanup(
				"No validated matching settled filesystem receipt",
			),
			operation: unknownCleanup("No validated matching operation settlement"),
		}
	}
	const r = parsed.data
	const cleanupComplete =
		r.cleanup === "complete" && r.residueBytes === 0 && r.closure !== "unknown"
	const filesystem: CleanupOutcome = cleanupComplete
		? Object.freeze({ ok: true })
		: unknownCleanup(
				"Filesystem closure or disposable cleanup remains unconfirmed",
			)
	const operation: CleanupOutcome =
		r.outcome === "finalized" || (r.outcome === "aborted" && cleanupComplete)
			? Object.freeze({ ok: true })
			: r.outcome === "failed" && cleanupComplete
				? Object.freeze({
						ok: false,
						state: "failed",
						detail: "Analog operation failed",
					})
				: unknownCleanup("Analog operation cleanup remains unsettled")
	return { filesystem, operation }
}
function bindingKey(binding: RecordingBinding): string {
	return JSON.stringify([
		binding.sourceId,
		binding.engineInstanceId,
		binding.stream,
		binding.epoch,
		binding.channelId,
		binding.channelGeneration,
		binding.inputFormat,
		binding.inputSampleRateHz,
		binding.groupDelayInputSamples,
		binding.targetHz,
		binding.captureCentreHz,
		binding.tuningTrust,
	])
}
function realizedBinding(binding: RecordingBinding): RecordingBinding {
	const parsed = RecordingBindingSchema.safeParse(binding)
	if (!parsed.success) throw fail("Invalid recording grant binding")
	const b = parsed.data
	if (
		b.sourceId === null ||
		b.engineInstanceId === null ||
		b.stream === null ||
		b.epoch === null ||
		b.channelId === null ||
		b.channelGeneration === null ||
		b.inputFormat !== "cf32" ||
		b.inputSampleRateHz !== 48000 ||
		b.groupDelayInputSamples === null ||
		b.targetHz === null ||
		b.captureCentreHz === null ||
		b.tuningTrust === null
	)
		throw fail("Realized 48 kHz cf32 grant and delay required")
	return Object.freeze(b)
}

/** One owner per source includes opening, writing, draining and retained native/unknown tombstones. */
export class RecordingProducers {
	private readonly tuples = new Map<string, Entry>()
	private readonly sources = new Map<string, Entry>()
	private sealed = false
	private readonly deps: RecordingProducerDeps
	constructor(deps: RecordingProducerDeps) {
		this.deps = Object.freeze({ ...deps })
		if (!Number.isSafeInteger(deps.maxOwners) || deps.maxOwners <= 0)
			throw fail("Bounded recording ownership required")
	}
	get ownerCount(): number {
		return this.sources.size
	}
	bindingLive(binding: RecordingBinding): boolean {
		const parsed = RecordingBindingSchema.safeParse(binding)
		if (!parsed.success) return false
		const entry = this.tuples.get(bindingKey(parsed.data))
		if (!entry?.live || entry.nativeClosed) return false
		try {
			const current = this.deps.isCurrentCommitted(entry.identity)
			return (
				current &&
				entry.live &&
				!entry.nativeClosed &&
				this.tuples.get(entry.key) === entry
			)
		} catch {
			return false
		}
	}
	begin(input: RecordingProducerInput): RecordingProducerHandle {
		if (
			this.sealed ||
			this.deps.enabled !== true ||
			this.deps.profileReady !== true ||
			this.deps.adoptionReady !== true ||
			input.recordAudio !== true ||
			input.analogFm !== true ||
			input.encrypted !== false
		)
			throw fail("Recording producer admission denied")
		if (
			input.provider === null ||
			typeof input.provider !== "object" ||
			input.token === null ||
			typeof input.token !== "object" ||
			!RecordingIdentitySchema.safeParse(input.discoveryId).success ||
			!RecordingIdentitySchema.safeParse(input.observationId).success ||
			(input.thresholdDbfs !== null && !Number.isFinite(input.thresholdDbfs)) ||
			(input.hangMs !== undefined &&
				(!Number.isFinite(input.hangMs) || input.hangMs < 0)) ||
			(input.deemphasisUs !== undefined &&
				input.deemphasisUs !== null &&
				input.deemphasisUs !== 750)
		)
			throw fail("Invalid recording association or audio options")
		const binding = realizedBinding(input.binding)
		const snapshot = Object.freeze({ ...input, binding })
		const sourceId = binding.sourceId!
		const key = bindingKey(binding)
		if (
			this.tuples.has(key) ||
			this.sources.has(sourceId) ||
			this.sources.size >= this.deps.maxOwners
		)
			throw fail("Recording ownership collision or retained source")
		const identity = Object.freeze({
			binding,
			provider: snapshot.provider,
			token: snapshot.token,
		})
		const creation = deferred<void>(),
			settlement = deferred<RecordingProducerSettlement>()
		const entry: Entry = {
			key,
			discoveryId: snapshot.discoveryId,
			observationId: snapshot.observationId,
			sourceId,
			identity,
			created: creation.promise,
			creationDone: () => creation.resolve(),
			settled: settlement.promise,
			settle: settlement.resolve,
			operation: null,
			recorder: null,
			ready: Promise.resolve(),
			terminal: null,
			accepting: true,
			live: true,
			cancelled: null,
			creationError: null,
			producerClosed: false,
			nativeClosed: false,
		}
		// Own the original tuple before any injected callback, component or operation creation.
		this.tuples.set(key, entry)
		this.sources.set(sourceId, entry)
		try {
			void snapshot.nativeOwnershipSettled
				.then(
					outcome => {
						this.observeNativeOwnership(identity, outcome)
					},
					() => {
						/* Unknown native proof retains the bounded original owner. */
					},
				)
				.catch(() => {
					/* Malformed proof never retires an owner. */
				})
			this.requireCurrent(entry)
			if (!this.deps.beginAnalogComponent(identity))
				throw fail("Analog component refused")
			this.requireCurrent(entry)
			entry.operation = this.deps.beginAnalog({
				discoveryId: snapshot.discoveryId,
				observationId: snapshot.observationId,
				binding,
			})
			// Record the returned original operation before any further reentrant predicate.
			this.requireCurrent(entry)
			entry.recorder = new AnalogRecorder({
				operation: entry.operation,
				thresholdDbfs: snapshot.thresholdDbfs,
				...(snapshot.hangMs !== undefined ? { hangMs: snapshot.hangMs } : {}),
				...(snapshot.deemphasisUs !== undefined
					? { deemphasisUs: snapshot.deemphasisUs }
					: {}),
			})
		} catch (cause) {
			entry.creationError = fail("Recording producer creation failed", cause)
		} finally {
			entry.creationDone()
		}
		entry.ready = entry.created.then(async () => {
			if (entry.creationError) throw entry.creationError
			if (!entry.operation) throw fail("Missing recording operation")
			await entry.operation.ready
			this.requireCurrent(entry)
		})
		void entry.ready.catch(() => {
			this.cancelEntry(entry, "channel-invalidated")
		})
		return Object.freeze({
			identity,
			ready: entry.ready,
			settled: entry.settled,
			push: (cf32: Float32Array) => {
				if (!entry.accepting || !entry.recorder)
					return Promise.reject(fail("Recording intake fenced"))
				try {
					this.requireCurrent(entry)
				} catch (cause) {
					this.cancelEntry(entry, "channel-invalidated")
					return Promise.reject(cause)
				}
				return entry.recorder.push(cf32)
			},
			gap: (gap: AnalogGap) => {
				if (entry.accepting) entry.recorder?.gap(gap)
			},
			finish: (cut: AnalogCut = "completed") => this.finishEntry(entry, cut),
			cancel: (cut: AnalogCut = "cancelled") => this.cancelEntry(entry, cut),
		})
	}
	/** Later exact proof may retire a clean producer tombstone; unknown never changes its owner. */
	observeNativeOwnership(
		identity: RecordingGrantIdentity,
		outcome: RecordingNativeOutcome,
	): boolean {
		const parsed = RecordingBindingSchema.safeParse(identity.binding)
		if (!parsed.success) return false
		const entry = this.tuples.get(bindingKey(parsed.data))
		if (
			!entry ||
			outcome.status !== "released" ||
			identity.provider !== entry.identity.provider ||
			identity.token !== entry.identity.token ||
			outcome.provider !== entry.identity.provider ||
			outcome.token !== entry.identity.token
		)
			return false
		entry.nativeClosed = true
		if (entry.live) this.cancelEntry(entry, "channel-invalidated")
		this.retire(entry)
		return true
	}
	cancelSource(sourceId: string, cut: AnalogCut = "source-lost"): void {
		const entry = this.sources.get(sourceId)
		if (entry) this.cancelEntry(entry, cut)
	}
	stop(): Promise<readonly RecordingProducerSettlement[]> {
		this.sealed = true
		const entries = [...this.sources.values()]
		for (const entry of entries) this.cancelEntry(entry, "shutdown")
		return Promise.all(entries.map(entry => entry.settled))
	}
	private requireCurrent(entry: Entry): void {
		if (
			!entry.live ||
			entry.nativeClosed ||
			entry.cancelled ||
			this.sealed ||
			this.tuples.get(entry.key) !== entry
		)
			throw fail("Recording grant invalidated")
		const current = this.deps.isCurrentCommitted(entry.identity)
		if (
			!current ||
			!entry.live ||
			entry.nativeClosed ||
			entry.cancelled ||
			this.sealed ||
			this.tuples.get(entry.key) !== entry
		)
			throw fail("Recording grant is not current and committed")
	}
	private cancelEntry(entry: Entry, cut: AnalogCut): void {
		entry.accepting = false
		entry.live = false
		entry.cancelled ??= cut
		entry.recorder?.cancel(cut)
		entry.operation?.cancel(cut)
		void this.finishEntry(entry, cut).catch(() => undefined)
	}
	private finishEntry(entry: Entry, cut: AnalogCut): Promise<AnalogReceipt> {
		entry.accepting = false
		entry.terminal ??= this.drain(entry, cut)
		return entry.terminal
	}
	private async drain(entry: Entry, cut: AnalogCut): Promise<AnalogReceipt> {
		await entry.created
		let error = entry.creationError
		let receipt: AnalogReceipt | null = null
		let operationSettled = false,
			logicalReleased = false
		try {
			if (entry.recorder)
				receipt = await entry.recorder.finish(entry.cancelled ?? cut)
			else if (entry.operation)
				receipt = await entry.operation.finish(entry.cancelled ?? cut)
		} catch (cause) {
			error ??= fail("Recording producer drain failed", cause)
		}
		if (entry.operation) {
			try {
				receipt = await entry.operation.settled
				operationSettled = true
			} catch (cause) {
				error ??= fail("Recording operation settlement failed", cause)
			}
		}
		// These facts come only from the original operation's settled receipt, before logical release.
		const outcomes = receiptOutcomes(entry, receipt, operationSettled)
		// Natural finish keeps the grant live until actual operation settlement; release is only logical.
		entry.live = false
		try {
			await this.deps.releaseLogical(entry.identity)
			logicalReleased = true
		} catch (cause) {
			error ??= fail("Recording logical release failed", cause)
		}
		const closed =
			receipt !== null &&
			((receipt.outcome === "finalized" && receipt.closure === "closed") ||
				(receipt.cleanup === "complete" && receipt.closure !== "unknown"))
		if (operationSettled && !closed)
			error ??= fail("Recording cleanup remains unsettled")
		entry.producerClosed =
			operationSettled && logicalReleased && error === null && closed
		entry.settle(
			Object.freeze({
				receipt,
				error,
				filesystem: outcomes.filesystem,
				operation: outcomes.operation,
				operationSettled,
				logicalReleased,
				componentClosed: entry.producerClosed,
			}),
		)
		this.retire(entry)
		if (receipt) return receipt // Immutable marker decision is never reversed by a later release failure.
		throw error ?? fail("Recording operation produced no receipt")
	}
	private retire(entry: Entry): void {
		if (!entry.producerClosed || !entry.nativeClosed) return
		if (this.tuples.get(entry.key) === entry) this.tuples.delete(entry.key)
		if (this.sources.get(entry.sourceId) === entry)
			this.sources.delete(entry.sourceId)
	}
}
