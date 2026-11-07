/**
 * Shared harness for the WidebandAnalogRecorder tests: a fake engine ring, fake analog
 * operations with the store's admission rules, synthetic NFM input and track snapshots.
 *
 * NFM chain path: the recorder's chains come from the process runtime, which under vitest looks for
 * wideband-nfm.wasm next to the module source and so runs the JS chain. To run these tests on the
 * built kernel, point WAVEKIT_RECORDER_DSP_WASM at it, and add WAVEKIT_REQUIRE_NFM_WASM=1 so a
 * missing, invalid or stale artefact fails instead of falling back (recorder-dsp-required.ts):
 *
 *   native/wavekit-nfm/build.sh
 *   WAVEKIT_RECORDER_DSP_WASM=$PWD/dist/wideband-nfm.wasm WAVEKIT_REQUIRE_NFM_WASM=1 \
 *     pnpm exec vitest run --maxWorkers=1 tests/unit/core/scanner
 */
import "./recorder-dsp-required.js"
import pino from "pino"
import {
	WidebandAnalogRecorder,
	type WidebandEngineView,
	type WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	MAX_ACTIVE_ANALOG_PER_SOURCE,
	type AnalogCut,
	type AnalogHandle,
	type AnalogInput,
	type AnalogReceipt,
} from "../../../../src/core/scanner/store/analog-operations.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import { IqRing } from "../../../../src/core/spectrum/iq-ring.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { NfmSource } from "./wideband-nfm-fixtures.js"

export const FS = 1_024_000
export const CENTRE = 100_000_000
export const OFFSET = 50_000

/** A low rate for the long (> 120 s) cases: the chain needs at least 48 kHz. */
export const LOW_FS = 96_000
export const LOW_OFFSET = 20_000

export class FakeEngine implements WidebandEngineView {
	readonly format = "U8_IQ"
	epoch = {
		stream: 1,
		epoch: 1,
		startSample: 0 as number | null,
		centreHz: CENTRE,
		sampleRateHz: FS,
		tuningTrust: "commanded" as "commanded" | "relay" | "unverified",
	}
	private readonly ring: IqRing
	/** `ringSeconds`: the real ring capacity (ringSeconds × fs), as the engine sizes it. */
	constructor(fs = FS, ringSeconds = 3) {
		this.epoch.sampleRateHz = fs
		this.ring = new IqRing({
			bytesPerSample: 2,
			capacitySamples: Math.round(ringSeconds * fs),
		})
	}
	/** Oldest sample the ring still holds (test inspection only; not in WidebandEngineView). */
	get oldestSample(): number {
		return this.ring.oldestSample
	}
	private readonly taps = new Set<(s: number, b: Uint8Array) => void>()
	currentEpoch() {
		return { ...this.epoch }
	}
	liveEdge(): number {
		return this.ring.newestSample
	}
	readRing(from: number, to: number) {
		return this.ring.read(from, to)
	}
	tap(listener: (s: number, b: Uint8Array) => void): () => void {
		this.taps.add(listener)
		return () => this.taps.delete(listener)
	}
	/** Appends IQ `skip` samples after the newest one (a skip leaves a ring gap). */
	write(bytes: Uint8Array, skip = 0): void {
		const at = this.ring.newestSample + skip
		this.ring.write(at, bytes)
		for (const t of this.taps) t(at, bytes)
	}
	get tapCount(): number {
		return this.taps.size
	}
}

export interface FakeOp {
	input: AnalogInput
	frames: number
	cut: AnalogCut | null
	cancelled: AnalogCut | null
	/** Settled outcome; "failed" when the binding was no longer live at the finish. */
	outcome: "finalized" | "aborted" | "failed" | null
	denied: boolean
	/** Gaps reported through addGap. */
	gaps: number
}

export const microtasks = async (n: number): Promise<void> => {
	for (let i = 0; i < n; i++) await Promise.resolve()
}

/**
 * Fake analog operations with the store's rules: at most MAX_ACTIVE_ANALOG_PER_SOURCE active
 * per source (a slot is held until the operation settles), the binding must be live at
 * admission and again at the finish, and the finish takes a few turns (I/O) to settle.
 */
export function fakeOps(
	live: (b: RecordingBinding) => boolean,
	opts: {
		refuse?: boolean
		hold?: Promise<void>
		/** Admission (readiness) waits for this. */
		readyHold?: Promise<void>
	} = {},
) {
	const ops: FakeOp[] = []
	const active = new Set<FakeOp>()
	const begin = (input: AnalogInput): AnalogHandle => {
		const op: FakeOp = {
			input,
			frames: 0,
			cut: null,
			cancelled: null,
			outcome: null,
			denied: false,
			gaps: 0,
		}
		ops.push(op)
		let resolveSettled!: (r: AnalogReceipt) => void
		const settled = new Promise<AnalogReceipt>(r => {
			resolveSettled = r
		})
		const settle = (outcome: "finalized" | "aborted" | "failed") => {
			if (op.outcome !== null) return
			op.outcome = outcome
			active.delete(op)
			resolveSettled({ outcome } as unknown as AnalogReceipt)
		}
		const sameSource = [...active].filter(
			o => o.input.binding.sourceId === input.binding.sourceId,
		).length
		const capacity = sameSource < MAX_ACTIVE_ANALOG_PER_SOURCE
		if (capacity) active.add(op)
		else op.denied = true
		const ready =
			opts.refuse || !capacity
				? Promise.reject(new Error("admission-denied"))
				: Promise.resolve(opts.readyHold)
						.then(() => microtasks(2))
						.then(() => {
							if (!live(input.binding)) throw new Error("invalid-binding")
						})
		ready.catch(() => settle("aborted"))
		let admitted = false
		void ready.then(
			() => {
				admitted = true
			},
			() => undefined,
		)
		return {
			operationId: `op-${ops.length}`,
			ready,
			settled,
			push: pcm => {
				if (!admitted || op.cut !== null || op.cancelled !== null)
					return Promise.reject(new Error("write-failed"))
				op.frames += pcm.length
				return Promise.resolve()
			},
			addGap: () => {
				op.gaps++
			},
			finish: async (cut = "completed") => {
				op.cut = cut
				await opts.hold
				await microtasks(3)
				settle(live(input.binding) ? "finalized" : "failed")
				return { outcome: op.outcome } as unknown as AnalogReceipt
			},
			cancel: (cut = "cancelled") => {
				if (op.outcome !== null) return
				op.cancelled = cut
				settle("aborted")
			},
		}
	}
	return { ops, begin }
}

export function harness(
	opts: {
		refuse?: boolean
		budget?: number
		fs?: number
		offset?: number
		hold?: Promise<void>
		readyHold?: Promise<void>
		source?: Partial<ConstructorParameters<typeof NfmSource>[0]>
		reserveCores?: (cores: number) => (() => void) | null
		/** The recorder's per-turn budget clock (milliseconds); default performance.now. */
		clock?: () => number
		/**
		 * settings().ringSeconds and the FakeEngine's real ring capacity; default absent (the
		 * recorder assumes 3 s, the FakeEngine's default ring).
		 */
		ringSeconds?: number
		/** Wraps the fake store's beginAnalog (failure injection: a throw, a rejected push). */
		beginWrap?: (
			begin: (input: AnalogInput) => AnalogHandle,
		) => (input: AnalogInput) => AnalogHandle
	} = {},
) {
	const fs = opts.fs ?? FS
	const engine = new FakeEngine(fs, opts.ringSeconds ?? 3)
	let rec!: WidebandAnalogRecorder
	const { ops, begin } = fakeOps(b => rec.bindingLive(b), opts)
	const queue: (() => void)[] = []
	const tones: { observationId: string; hz: number }[] = []
	const warnings: unknown[] = []
	const logger = pino({ level: "silent" })
	rec = new WidebandAnalogRecorder({
		engine: () => engine,
		settings: () => ({
			preRollMs: 300,
			hangMs: 2000,
			cpuBudgetCores: opts.budget ?? 1,
			...(opts.ringSeconds !== undefined
				? { ringSeconds: opts.ringSeconds }
				: {}),
		}),
		beginAnalog: opts.beginWrap ? opts.beginWrap(begin) : begin,
		recordTone: (observationId, hz) => tones.push({ observationId, hz }),
		...(opts.reserveCores ? { reserveCores: opts.reserveCores } : {}),
		logger,
		now: () => 1_700_000_000_000,
		schedule: run => queue.push(run),
		...(opts.clock ? { clock: opts.clock } : {}),
	})
	const origWarn = (rec as unknown as { warn(e: unknown): void }).warn.bind(rec)
	;(rec as unknown as { warn(e: unknown): void }).warn = e => {
		warnings.push(e)
		origWarn(e)
	}
	const src = new NfmSource({
		fs,
		offsetHz: opts.offset ?? OFFSET,
		...opts.source,
	})
	let pumps = 0
	const pump = async (): Promise<void> => {
		for (let i = 0; i < 1000 && queue.length > 0; i++) {
			queue.shift()!()
			await microtasks(8)
		}
		// A long scene runs only microtasks: every 1 s of signal (40 chunks) one macrotask turn
		// lets the test worker answer its runner (vitest's onTaskUpdate RPC times out after
		// 60 s otherwise). The recorder's work stays on `queue`, so the yield runs none of it.
		if (++pumps % 40 === 0) await new Promise(r => setImmediate(r))
	}
	/**
	 * One event-loop turn: runs only the drain tasks queued before it (one per session), like
	 * setImmediate callbacks queued during a check phase run on the next turn.
	 */
	const turn = async (): Promise<void> => {
		for (const run of queue.splice(0)) run()
		await microtasks(8)
	}
	/** Feeds seconds of IQ in 25 ms chunks, running the recorder in between. */
	const feed = async (
		seconds: number,
		on: boolean,
		each?: () => void,
	): Promise<void> => {
		const chunk = fs / 40
		for (let i = 0; i < Math.round((seconds * fs) / chunk); i++) {
			engine.write(src.next(chunk, on))
			each?.()
			await pump()
		}
	}
	return { engine, ops, begin, rec, tones, warnings, feed, pump, turn, src, fs }
}

export function snapshot(
	id: string,
	start: number,
	last: number,
	extra: Partial<TrackSnapshot> = {},
): TrackSnapshot {
	return {
		trackId: id,
		sourceId: "rtl",
		stream: 1,
		epoch: 1,
		startSample: start,
		lastSample: last,
		centreHz: CENTRE + OFFSET,
		obwHz: 11_000,
		obwMethod: "-20dB",
		peakDbfs: -20,
		meanDbfs: -25,
		snrDb: 30,
		floorDbfs: -60,
		thresholdDb: 10,
		blocks: 10,
		maxBlockSnrDb: 30,
		dutyCycle: 1,
		spectralShape: "peaked",
		flags: {
			overload: false,
			gap: false,
			truncated: false,
			edge: false,
			skirt: false,
			obwBiased: false,
			burst: false,
			iqImage: false,
			spur: false,
		},
		tuningTrust: "commanded",
		...extra,
	}
}

export function input(
	observationId: string,
	track: TrackSnapshot,
	extra: Partial<WidebandTrackInput> = {},
): WidebandTrackInput {
	return {
		observationId,
		discoveryId: "d_1",
		sourceId: "rtl",
		track,
		analogFm: true,
		encrypted: false,
		recordAllowed: true,
		channelOwned: false,
		...extra,
	}
}

/** One transmission [onset, onset + seconds), reported 100 ms late, closed 600 ms late. */
export async function transmission(
	h: ReturnType<typeof harness>,
	id: string,
	seconds: number,
	extra: Partial<WidebandTrackInput> = {},
	track: Partial<TrackSnapshot> = {},
): Promise<void> {
	const onset = h.engine.liveEdge()
	const end = onset + seconds * h.fs
	await h.feed(seconds, true, () => {
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * h.fs)
			h.rec.track(
				input(id, snapshot(id, onset, Math.min(edge, end), track), extra),
			)
	})
	await h.feed(0.6, false)
	h.rec.closed(id, snapshot(id, onset, end, track), null)
}

export const LOW = { centreHz: CENTRE + LOW_OFFSET }
