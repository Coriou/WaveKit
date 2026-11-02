/**
 * Default-on analog voice recorder fed from the scanner's own wideband IQ ring. It needs no
 * channelizer and no channel tier: a narrow analog-fm track starts one session per channel,
 * which reads the engine ring from `hold.preRollMs` before the onset, demodulates NFM
 * (`WidebandNfmChain`) and writes 8 kHz WAV files through the evidence store's analog
 * operations (`recordings/analog/<discoveryId>/`, storage cap, disk-low and retention apply).
 * `TransmissionSegmenter` decides the files: one per transmission, a gap shorter than
 * `hold.hangMs` never splits. Work runs in bounded slices off the engine's tap callback.
 * A file whose audio inside the tracks never sounds like voice (`VoiceActivityGate`: a spur,
 * an idle or CTCSS-only carrier) is cancelled instead of kept.
 */
import type { TrackSnapshot, TuningTrust } from "../../spectrum/types.js"
import { safeErrorFields } from "../../../decoders/safe-error-fields.js"
import { createComponentLogger, type Logger } from "../../../utils/logger.js"
import { CtcssBank } from "../../audio-tones/ctcss.js"
import { ulid } from "../ids.js"
import type {
	AnalogCut,
	AnalogGap,
	AnalogHandle,
	AnalogInput,
	AnalogReceipt,
} from "../store/analog-operations.js"
import { MAX_ACTIVE_ANALOG_PER_SOURCE } from "../store/analog-operations.js"
import {
	RecordingBindingSchema,
	recordingEngineInstanceId,
	type RecordingBinding,
} from "../store/recording-operation.js"
import { ANALOG_AUDIO_RATE_HZ } from "./fm-audio.js"
import {
	TransmissionSegmenter,
	type SegmentEndCut,
	type SegmentEvent,
} from "./transmission-segmenter.js"
import { VoiceActivityGate } from "./voice-activity.js"
import { MAX_SLICE_SAMPLES, WidebandNfmChain } from "./wideband-nfm.js"
import type { ProofAnalogInput } from "../scanner-redesign-contract.js"

/** Same bound as the channel-tier trigger: a 25 kHz NFM channel's occupied bandwidth. */
export const WIDEBAND_MAX_OBW_HZ = 16_000
/** A track this close to a recording channel joins it (under half a 12.5 kHz raster step). */
export const WIDEBAND_JOIN_TOLERANCE_HZ = 5_000
/**
 * How late a decision may be: the engine closes a track one 500 ms track hang after it went
 * quiet and reports opens a few 10 to 50 ms blocks late, so 1000 ms covers both with margin.
 * At 8 kHz s16 that is 8000 frames (16 KB) held per recording.
 */
export const WIDEBAND_HOLDBACK_MS = 1_000
/** WAV and analog-operation bound: 960 000 frames = 120 s at 8 kHz (MAX_WAV_DURATION_SECONDS). */
export const WIDEBAND_MAX_FILE_MS = 120_000
/**
 * Queued audio per recording before it is dropped: pre-roll (≤ 10 s, the hold.preRollMs
 * bound) + holdback (1 s) + 5 s of writer readiness = 16 s · 8000 = 128 000 frames (256 KB).
 * The same bound covers a continuation waiting for its admission: it is admitted only after
 * the previous file's operation settled (that one still holds an analog slot), so it buffers
 * the 1 s carried holdback plus the previous file's final flush, finish and its own admission;
 * 16 s of that wait drops the continuation.
 */
export const WIDEBAND_MAX_QUEUED_FRAMES = 16 * ANALOG_AUDIO_RATE_HZ
/** One writer push: 4096 frames = 8 KB, under the WAV writer's 64 KB queue bound. */
const PUSH_FRAMES = 4_096
/**
 * IQ per drain slice: 25 ms of signal. At the measured cost below that is 25 · 59 / 1000 ≈ 1.5 ms
 * of main-thread work at 1.024 Msps and 25 · 71 / 1000 ≈ 1.8 ms at 2.4 Msps (the 2 ms rule).
 */
export const WIDEBAND_SLICE_MS = 25
/**
 * Measured chain cost per recording, CPU ms per second of IQ: 59 at 1.024 Msps and 71 at
 * 2.4 Msps on a shared Mac at load average 56 (33 and 49 at load average 7.5; docs/SCANNER.md
 * "Analog voice recordings"). The cap uses the loaded run, a linear fit:
 * fixed + slope · Msps = 50 + 9 · Msps (59.2 and 71.6).
 */
export const WIDEBAND_CPU_FIXED_MS = 50
export const WIDEBAND_CPU_MS_PER_MSPS = 9
/** Share of `cpuBudgetCores` concurrent recordings on one source may use. */
export const WIDEBAND_CPU_SHARE = 0.25
/**
 * Missing input longer than this, summed over consecutive unreadable slices (a ring overrun
 * reads as many 25 ms gaps), ends the file instead of inserting silence.
 */
export const WIDEBAND_MAX_SILENCE_GAP_MS = 1_000
/**
 * The voice gate only hears audio inside a joined track, trimmed by this at both ends: the
 * engine reports a track's last sample to the 10 to 50 ms block, so the squelch-open noise
 * after a carrier drops (which is loud and not a carrier's quieted audio) stays out.
 */
export const WIDEBAND_GATE_EDGE_TRIM_MS = 100
/** Activity intervals kept per session (open tracks and closed ones not yet written). */
const MAX_ACTIVITY = 64
/** Gaps held for a continuation not admitted yet (the analog operation keeps 64 too). */
const MAX_PENDING_GAPS = 64
/**
 * Files of one session waiting for a slot: a roll-over or a new transmission while the previous
 * file still settles, and one more behind it. At WIDEBAND_MAX_QUEUED_FRAMES each that is at
 * most 2 · 256 KB of audio held per recording.
 */
export const MAX_WAITING_FILES = 2
/** Remembered file ends per manager (pre-roll clamp of the next file on the same channel). */
const RECENT_ENDS = 32

/**
 * Concurrent recordings per source at `inputRateHz`:
 * floor(share · cpuBudgetCores · 1000 ms / (fixed + slope · rate in Msps)), at least 1 (a voice
 * is always kept) and at most MAX_ACTIVE_ANALOG_PER_SOURCE (the analog operations' own limit).
 * Default budget 1 core: floor(250 / 71.6) = 3 → 2 at 2.4 Msps, floor(250 / 59.2) = 4 → 2 at
 * 1.024 Msps; a 0.1-core budget gives floor(25 / 59.2) = 0 → 1.
 */
export function widebandRecordingCap(
	inputRateHz: number,
	cpuBudgetCores: number,
): number {
	if (!(inputRateHz > 0) || !Number.isFinite(cpuBudgetCores)) return 1
	const perRecordingMs =
		WIDEBAND_CPU_FIXED_MS + (WIDEBAND_CPU_MS_PER_MSPS * inputRateHz) / 1e6
	const budgetMs = WIDEBAND_CPU_SHARE * Math.max(0, cpuBudgetCores) * 1000
	return Math.max(
		1,
		Math.min(
			MAX_ACTIVE_ANALOG_PER_SOURCE,
			Math.floor(budgetMs / perRecordingMs),
		),
	)
}

/** A standard CTCSS tone heard over a finalized recording: analog-tone evidence (no voice claim). */
export function widebandToneEvidence(
	ctcssHz: number,
	at: number,
): ProofAnalogInput {
	return {
		outcome: "decoded",
		mode: "nfm",
		voice: false,
		tone: { ctcssHz, dcs: null },
		transport: "live",
		at,
	}
}

/** The engine surface the recorder reads (SpectrumEngine satisfies it). */
export interface WidebandEngineView {
	readonly format: string
	currentEpoch(): {
		stream: number
		epoch: number
		startSample: number | null
		centreHz: number
		sampleRateHz: number
		tuningTrust: TuningTrust
	}
	liveEdge(): number
	readRing(
		fromSample: number,
		toSample: number,
	): { startSample: number; bytes: Uint8Array } | null
	tap(listener: (startSample: number, bytes: Uint8Array) => void): () => void
}

export interface WidebandAnalogDeps {
	engine(sourceId: string): WidebandEngineView | undefined
	settings(): { preRollMs: number; hangMs: number; cpuBudgetCores: number }
	beginAnalog(input: AnalogInput): AnalogHandle
	/** A standard CTCSS tone heard over a finalized file of this observation. */
	recordTone?(observationId: string, ctcssHz: number, at: number): void
	logger: Logger
	now(): number
	/** Next-turn scheduler for drain slices; default setImmediate. */
	schedule?(run: () => void): void
}

export interface WidebandTrackInput {
	readonly observationId: string
	readonly discoveryId: string | null
	readonly sourceId: string
	readonly track: TrackSnapshot
	readonly analogFm: boolean
	readonly encrypted: boolean
	/** No covering job, or a covering job with record.analog. */
	readonly recordAllowed: boolean
	/** The channel-tier recorder owns this observation: stand down. */
	readonly channelOwned: boolean
}

/** Written audio and its tone-band twin, frame for frame (the CTCSS bank's input). */
interface Frames {
	readonly pcm: Int16Array
	readonly tone: Int16Array
}

class FrameQueue {
	private readonly parts: Frames[] = []
	length = 0
	push(f: Frames): void {
		if (f.pcm.length === 0) return
		this.parts.push(f)
		this.length += f.pcm.length
	}
	/** Removes the oldest `n` frames as one pair (a copy only when parts are joined). */
	take(n: number): Frames {
		const want = Math.min(n, this.length)
		const head = this.parts[0]
		if (head && head.pcm.length >= want) {
			this.length -= want
			if (head.pcm.length === want) this.parts.shift()
			else
				this.parts[0] = {
					pcm: head.pcm.subarray(want),
					tone: head.tone.subarray(want),
				}
			return {
				pcm: head.pcm.subarray(0, want),
				tone: head.tone.subarray(0, want),
			}
		}
		const pcm = new Int16Array(want)
		const tone = new Int16Array(want)
		let o = 0
		while (o < want) {
			// Whole head parts only: each take below is the single-part case.
			const part = this.take(Math.min(this.parts[0]!.pcm.length, want - o))
			pcm.set(part.pcm, o)
			tone.set(part.tone, o)
			o += part.pcm.length
		}
		return { pcm, tone }
	}
	/** Removes the newest `n` frames, oldest first. */
	takeTail(n: number): Frames[] {
		const out: Frames[] = []
		let excess = Math.min(n, this.length)
		while (excess > 0) {
			const part = this.parts.at(-1)!
			if (part.pcm.length <= excess) {
				out.unshift(part)
				this.parts.pop()
				excess -= part.pcm.length
				this.length -= part.pcm.length
				continue
			}
			const cut = part.pcm.length - excess
			out.unshift({
				pcm: part.pcm.subarray(cut),
				tone: part.tone.subarray(cut),
			})
			this.parts[this.parts.length - 1] = {
				pcm: part.pcm.subarray(0, cut),
				tone: part.tone.subarray(0, cut),
			}
			this.length -= excess
			excess = 0
		}
		return out
	}
}

interface FileState {
	readonly generation: number
	/** Null until admitted: a continuation waits for the previous operation to settle. */
	handle: AnalogHandle | null
	/** Gaps found before the operation began (replayed on begin). */
	readonly gaps: AnalogGap[]
	/** Input samples missing over consecutive unreadable slices, from `gapFrom`. */
	gapRun: number
	gapFrom: number
	/** Voice/activity check over the written audio: a file that never qualifies is discarded. */
	readonly gate: VoiceActivityGate
	startSample: number
	endSample: number | null
	cut: AnalogCut
	ready: boolean
	failed: boolean
	readonly queue: FrameQueue
	/** Frames produced for this file (written + queued). */
	frames: number
	writing: boolean
	finishing: boolean
}

interface Session {
	readonly id: string
	readonly sourceId: string
	readonly engine: WidebandEngineView
	readonly stream: number
	readonly epoch: number
	readonly fs: number
	readonly captureCentreHz: number
	readonly targetHz: number
	readonly tuningTrust: "commanded" | "relay"
	readonly owner: string
	readonly discoveryId: string
	readonly observations: Set<string>
	/** Track spans per observation (open: still active), the voice gate's input window. */
	readonly activity: Map<string, { start: number; last: number; open: boolean }>
	readonly seg: TransmissionSegmenter
	readonly chain: WidebandNfmChain
	/** Fed at write time with the frames between the first onset and the last active sample. */
	readonly ctcss: CtcssBank
	readonly onset: number
	/** Newest sample a joined track was reported on. */
	lastActive: number
	readonly groupDelay: number
	/** Next input sample to demodulate. */
	next: number
	/** No sample at or past this is read (an epoch change). */
	limit: number
	/** Cut reason of the next non-quiet end (retune, stream change); null = completed. */
	endCut: AnalogCut | null
	file: FileState | null
	/** Files waiting, oldest first, for this session's previous operation to settle. */
	readonly waiting: FileState[]
	/** Operations of this session not settled yet. */
	ops: number
	/** A start event waiting for the current file to finish (roll-over or a new transmission). */
	pendingStart: number | null
	generation: number
	untap: () => void
	scheduled: boolean
	done: boolean
}

type Usable = "commanded" | "relay"

function usableTrust(trust: TuningTrust): trust is Usable {
	return trust === "commanded" || trust === "relay"
}

function cleanTrack(track: TrackSnapshot): boolean {
	return (
		Number.isFinite(track.obwHz) &&
		track.obwHz <= WIDEBAND_MAX_OBW_HZ &&
		!track.flags.truncated &&
		!track.flags.edge &&
		!track.flags.iqImage &&
		!track.flags.spur &&
		usableTrust(track.tuningTrust)
	)
}

function bindingKey(binding: RecordingBinding): string {
	return JSON.stringify(
		Object.entries(binding).sort(([a], [b]) => (a < b ? -1 : 1)),
	)
}

export class WidebandAnalogRecorder {
	private readonly log: Logger
	private readonly sessions = new Map<string, Session>()
	/** observationId → session id. */
	private readonly byObservation = new Map<string, string>()
	/**
	 * Exact bindings (one per file: same channel id, distinct generation), each live until its
	 * own operation settles, so a finishing file keeps its binding while its continuation runs.
	 */
	private readonly bindings = new Set<string>()
	private readonly settling = new Set<Promise<unknown>>()
	/** Operations not settled yet per source (a finishing file still holds an analog slot). */
	private readonly unsettled = new Map<string, number>()
	private readonly refused = new Set<string>()
	private readonly recentEnds: {
		sourceId: string
		stream: number
		epoch: number
		hz: number
		end: number
	}[] = []
	private readonly schedule: (run: () => void) => void
	private stopped = false
	private warnedAt = Number.NEGATIVE_INFINITY

	constructor(private readonly deps: WidebandAnalogDeps) {
		this.log = createComponentLogger(deps.logger, "WidebandAnalogRecorder")
		this.schedule = deps.schedule ?? (run => void setImmediate(run))
	}

	/**
	 * Analog slots this recorder holds on `sourceId`: its unsettled operations (a finishing file
	 * still counts against the store's per-source limit) plus sessions about to open one.
	 */
	activeOn(sourceId: string): number {
		let n = this.unsettled.get(sourceId) ?? 0
		for (const s of this.sessions.values())
			if (s.sourceId === sourceId && !s.done && s.file === null) n++
		return n
	}

	owns(observationId: string): boolean {
		return this.byObservation.has(observationId)
	}

	/** The analog operations' liveness check for a binding this recorder issued. */
	bindingLive(binding: RecordingBinding): boolean {
		const parsed = RecordingBindingSchema.safeParse(binding)
		if (!parsed.success || parsed.data.channelId === null) return false
		return this.bindings.has(bindingKey(parsed.data))
	}

	/** A non-closing snapshot of a live observation. */
	track(input: WidebandTrackInput): void {
		if (this.stopped) return
		try {
			this.onTrack(input)
		} catch (err: unknown) {
			this.warn(err)
		}
	}

	/**
	 * The observation's track closed. `cut` null is a natural end (the hang applies). A retune
	 * (`epoch-changed`, a sweep hop) keeps the hang but never past the new epoch's start; any other
	 * cut (stream change, job end) ends the file at the track's last sample.
	 */
	closed(
		observationId: string,
		track: TrackSnapshot,
		cut: AnalogCut | null,
	): void {
		const id = this.byObservation.get(observationId)
		if (id === undefined) return
		this.byObservation.delete(observationId)
		const s = this.sessions.get(id)
		if (!s || s.done) return
		s.observations.delete(observationId)
		s.lastActive = Math.max(s.lastActive, track.lastSample)
		const span = s.activity.get(observationId)
		if (span) {
			span.last = Math.max(span.last, track.lastSample)
			span.open = false
		}
		if (!cleanTrack(track)) {
			// Any contributing track turning edge, spur or unverified discards the recording.
			s.observations.add(observationId)
			this.refuse(s)
			return
		}
		if (cut !== null) s.endCut ??= cut
		s.seg.close(
			observationId,
			track.lastSample,
			cut === null || cut === "epoch-changed",
		)
		this.wake(s)
	}

	/** Shutdown: finish open files (kept as cut), then wait for every operation to settle. */
	async stop(): Promise<void> {
		this.stopped = true
		for (const s of [...this.sessions.values()]) this.endSession(s, "shutdown")
		await this.idle()
	}

	/** Resolves once every operation begun so far (and any continuation it admits) settled. */
	async idle(): Promise<void> {
		while (this.settling.size > 0) await Promise.all([...this.settling])
	}

	// === internals ===

	private onTrack(input: WidebandTrackInput): void {
		const { track, observationId } = input
		// Encrypted, opted out or unclean: never recorded, and a file it contributes to is discarded.
		const barred = input.encrypted || !input.recordAllowed || !cleanTrack(track)
		const joinedId = this.byObservation.get(observationId)
		if (joinedId !== undefined) {
			const s = this.sessions.get(joinedId)
			if (!s) return
			s.lastActive = Math.max(s.lastActive, track.lastSample)
			this.noteActivity(s, observationId, track)
			if (barred) this.refuse(s)
			return
		}
		if (
			input.channelOwned ||
			this.refused.has(observationId) ||
			!cleanTrack(track)
		)
			return
		const engine = this.deps.engine(input.sourceId)
		if (!engine || engine.format !== "U8_IQ") return
		const epoch = engine.currentEpoch()
		if (
			epoch.stream !== track.stream ||
			epoch.epoch !== track.epoch ||
			!usableTrust(epoch.tuningTrust)
		)
			return
		// A continuation of a channel already recording joins whatever its classification.
		for (const s of this.sessions.values()) {
			if (
				s.done ||
				s.sourceId !== input.sourceId ||
				s.engine !== engine ||
				s.stream !== track.stream ||
				s.epoch !== track.epoch ||
				Math.abs(s.targetHz - track.centreHz) > WIDEBAND_JOIN_TOLERANCE_HZ
			)
				continue
			if (input.encrypted || !input.recordAllowed) {
				// Its audio would land in this file (or its hang): discard the recording.
				s.observations.add(observationId)
				this.refuse(s)
				return
			}
			const events = s.seg.open(observationId, track.startSample)
			s.observations.add(observationId)
			s.lastActive = Math.max(s.lastActive, track.lastSample)
			this.noteActivity(s, observationId, track)
			this.byObservation.set(observationId, s.id)
			this.applyEvents(s, events)
			this.wake(s)
			return
		}
		if (
			input.encrypted ||
			!input.recordAllowed ||
			!input.analogFm ||
			input.discoveryId === null
		)
			return
		const settings = this.deps.settings()
		if (
			this.activeOn(input.sourceId) >=
			widebandRecordingCap(epoch.sampleRateHz, settings.cpuBudgetCores)
		)
			return
		this.startSession(input, input.discoveryId, engine, epoch, settings)
	}

	private startSession(
		input: WidebandTrackInput,
		discoveryId: string,
		engine: WidebandEngineView,
		epoch: ReturnType<WidebandEngineView["currentEpoch"]>,
		settings: { preRollMs: number; hangMs: number },
	): void {
		const { track } = input
		const trust = epoch.tuningTrust
		if (!usableTrust(trust)) return
		const fs = epoch.sampleRateHz
		const perMs = fs / 1000
		const chain = new WidebandNfmChain({
			inputRateHz: fs,
			offsetHz: track.centreHz - epoch.centreHz,
		})
		const seg = new TransmissionSegmenter({
			preRollSamples: Math.round(Math.max(0, settings.preRollMs) * perMs),
			hangSamples: Math.round(Math.max(0, settings.hangMs) * perMs),
			holdbackSamples: Math.round(WIDEBAND_HOLDBACK_MS * perMs),
			maxSegmentSamples: Math.round(WIDEBAND_MAX_FILE_MS * perMs),
		})
		const floor = Math.max(
			epoch.startSample ?? 0,
			this.recentEnd(input.sourceId, track),
		)
		const s: Session = {
			id: ulid(this.deps.now()).toLowerCase(),
			sourceId: input.sourceId,
			engine,
			stream: epoch.stream,
			epoch: epoch.epoch,
			fs,
			captureCentreHz: epoch.centreHz,
			targetHz: track.centreHz,
			tuningTrust: trust,
			owner: input.observationId,
			discoveryId,
			observations: new Set([input.observationId]),
			activity: new Map([
				[
					input.observationId,
					{ start: track.startSample, last: track.lastSample, open: true },
				],
			]),
			seg,
			chain,
			ctcss: new CtcssBank(),
			onset: track.startSample,
			lastActive: track.lastSample,
			groupDelay: chain.groupDelaySeconds(fs) * 48_000,
			next: 0,
			limit: Number.POSITIVE_INFINITY,
			endCut: null,
			file: null,
			waiting: [],
			ops: 0,
			pendingStart: null,
			generation: 0,
			untap: () => undefined,
			scheduled: false,
			done: false,
		}
		this.sessions.set(s.id, s)
		this.byObservation.set(input.observationId, s.id)
		const events = seg.open(input.observationId, track.startSample, floor)
		this.applyEvents(s, events)
		if (!s.file) {
			this.dispose(s)
			return
		}
		s.next = s.file.startSample
		s.untap = engine.tap(() => this.wake(s))
		this.wake(s)
	}

	private recentEnd(sourceId: string, track: TrackSnapshot): number {
		let end = Number.NEGATIVE_INFINITY
		for (const r of this.recentEnds)
			if (
				r.sourceId === sourceId &&
				r.stream === track.stream &&
				r.epoch === track.epoch &&
				Math.abs(r.hz - track.centreHz) <= WIDEBAND_JOIN_TOLERANCE_HZ
			)
				end = Math.max(end, r.end)
		return end
	}

	private applyEvents(s: Session, events: readonly SegmentEvent[]): void {
		for (const ev of events) {
			if (ev.kind === "end") {
				if (s.file && s.file.endSample === null) {
					s.file.endSample = ev.sample
					s.file.cut = this.cutOf(s, ev.cut ?? "completed")
				}
				continue
			}
			if (s.file) s.pendingStart = ev.sample
			else this.openFile(s, ev.sample)
		}
	}

	private cutOf(s: Session, cut: SegmentEndCut): AnalogCut {
		if (cut === "completed" || cut === "duration-limit") return cut
		return s.endCut ?? "track-ended"
	}

	/**
	 * A new file from `startSample`. It begins its analog operation at once, or, while this
	 * session's previous operation has not settled (it still holds an analog slot), once that one
	 * settles: a continuation never needs a third slot. Audio queues meanwhile (bounded).
	 */
	private openFile(s: Session, startSample: number): void {
		s.generation++
		const file: FileState = {
			generation: s.generation,
			handle: null,
			gaps: [],
			gapRun: 0,
			gapFrom: 0,
			gate: new VoiceActivityGate(),
			startSample,
			endSample: null,
			cut: "completed",
			ready: false,
			failed: false,
			queue: new FrameQueue(),
			frames: 0,
			writing: false,
			finishing: false,
		}
		s.file = file
		if (s.ops === 0) {
			this.beginOp(s, file)
			return
		}
		if (s.waiting.length >= MAX_WAITING_FILES) {
			// The store is not settling files: give up rather than hold more audio.
			this.refuse(s)
			return
		}
		s.waiting.push(file)
	}

	private beginOp(s: Session, file: FileState): void {
		if (file.failed || file.handle !== null) return
		if (this.stopped) {
			// Shutdown while it waited for a slot: the store is closing, nothing to begin.
			file.failed = true
			return
		}
		const binding: RecordingBinding = Object.freeze({
			sourceId: s.sourceId,
			engineInstanceId: recordingEngineInstanceId(s.engine),
			stream: s.stream,
			epoch: s.epoch,
			channelId: `wideband-${s.id}`,
			channelGeneration: file.generation,
			inputFormat: "cf32" as const,
			inputSampleRateHz: 48_000,
			groupDelayInputSamples: Math.max(0, s.groupDelay),
			targetHz: s.targetHz,
			captureCentreHz: s.captureCentreHz,
			tuningTrust: s.tuningTrust,
		})
		const key = bindingKey(binding)
		this.bindings.add(key)
		let handle: AnalogHandle
		try {
			handle = this.deps.beginAnalog({
				discoveryId: s.discoveryId,
				observationId: s.owner,
				binding,
			})
		} catch (err: unknown) {
			this.bindings.delete(key)
			this.warn(err)
			file.failed = true
			if (s.file === file) this.refuse(s)
			return
		}
		file.handle = handle
		for (const gap of file.gaps.splice(0)) handle.addGap(gap)
		s.ops++
		this.unsettled.set(s.sourceId, (this.unsettled.get(s.sourceId) ?? 0) + 1)
		const settled = handle.settled
			.then(receipt => this.onSettled(s, receipt))
			.catch(() => undefined)
			.finally(() => {
				this.bindings.delete(key)
				const left = (this.unsettled.get(s.sourceId) ?? 1) - 1
				if (left > 0) this.unsettled.set(s.sourceId, left)
				else this.unsettled.delete(s.sourceId)
				this.settling.delete(settled)
				s.ops--
				// One at a time: the next waiting file begins when this session holds no slot.
				while (s.ops === 0 && s.waiting.length > 0)
					this.beginOp(s, s.waiting.shift()!)
			})
		this.settling.add(settled)
		handle.ready.then(
			() => {
				file.ready = true
				if (file.finishing) this.completeFinish(s, file)
				else this.wake(s)
			},
			() => {
				// Storage cap, disk-low or a lost association: this transmission is not recorded.
				file.failed = true
				if (s.file === file) this.refuse(s)
			},
		)
	}

	private noteActivity(
		s: Session,
		observationId: string,
		track: TrackSnapshot,
	): void {
		const span = s.activity.get(observationId)
		if (span) {
			span.last = Math.max(span.last, track.lastSample)
			return
		}
		s.activity.set(observationId, {
			start: track.startSample,
			last: track.lastSample,
			open: true,
		})
		if (s.activity.size <= MAX_ACTIVITY) return
		for (const [id, a] of s.activity)
			if (!a.open) {
				s.activity.delete(id)
				return
			}
	}

	private onSettled(s: Session, receipt: AnalogReceipt): void {
		if (receipt.outcome !== "finalized" || this.deps.recordTone === undefined)
			return
		const hz = s.ctcss.result()
		if (hz === null) return
		try {
			this.deps.recordTone(s.owner, hz, this.deps.now())
		} catch (err: unknown) {
			this.warn(err)
		}
	}

	/** Refused admission: drop the session and do not try this observation again. */
	private refuse(s: Session): void {
		for (const id of s.observations) {
			this.refused.add(id)
			if (this.refused.size > 1024) {
				const oldest = this.refused.values().next()
				if (oldest.done !== true) this.refused.delete(oldest.value)
			}
		}
		this.cancelSession(s, "cancelled")
	}

	private wake(s: Session): void {
		if (s.scheduled || s.done) return
		s.scheduled = true
		this.schedule(() => {
			s.scheduled = false
			try {
				this.drain(s)
			} catch (err: unknown) {
				this.warn(err)
				this.cancelSession(s, "cancelled")
			}
		})
	}

	private drain(s: Session): void {
		if (s.done) return
		const engine = this.deps.engine(s.sourceId)
		if (engine !== s.engine) {
			this.endSession(s, "stream-changed")
			return
		}
		const epoch = engine.currentEpoch()
		if (epoch.stream !== s.stream) {
			this.endSession(s, "stream-changed")
			return
		}
		if (epoch.epoch !== s.epoch && s.limit === Number.POSITIVE_INFINITY) {
			// A retune: nothing at or past the new epoch's start is this channel. The file ends
			// at the earlier of its own end target and that start; no later file follows. A
			// sweep that hops after the hang has a complete file.
			s.limit = epoch.startSample ?? s.next
			const target = s.seg.endTarget
			const end = Math.min(target ?? s.limit, s.limit)
			const cut: AnalogCut =
				target !== null && target <= s.limit
					? "completed"
					: (s.endCut ?? "epoch-changed")
			s.seg.abort()
			s.pendingStart = null
			if (s.file && s.file.endSample === null) {
				s.file.endSample = end
				s.file.cut = cut
			}
		}
		const edge = Math.min(engine.liveEdge(), s.limit)
		this.applyEvents(s, s.seg.advance(edge))
		const file = s.file
		if (!file) {
			this.dispose(s)
			return
		}
		const target = Math.min(edge, file.endSample ?? Number.POSITIVE_INFINITY)
		let more = false
		if (s.next < target) {
			const to = Math.min(
				target,
				s.next + Math.max(1, Math.round((WIDEBAND_SLICE_MS * s.fs) / 1000)),
			)
			const r = engine.readRing(s.next, to)
			if (r === null) {
				// Nothing readable (fell out of the ring or a ring gap up to `to`).
				this.gapTo(s, file, to)
			} else {
				if (r.startSample > s.next) this.gapTo(s, file, r.startSample)
				if (!s.done && s.file === file) {
					for (let o = 0; o < r.bytes.length; o += MAX_SLICE_SAMPLES * 2) {
						const pcm = s.chain.process(
							r.bytes.subarray(
								o,
								Math.min(r.bytes.length, o + MAX_SLICE_SAMPLES * 2),
							),
						)
						this.enqueue(s, file, { pcm, tone: s.chain.toneAudio().slice() })
					}
					s.next = r.startSample + r.bytes.length / 2
					file.gapRun = 0
				}
			}
			more = s.next < target
		}
		if (s.done || s.file !== file) return
		this.flush(s, file, s.seg.writableUntil(edge))
		if (file.endSample !== null && s.next >= file.endSample && !file.finishing)
			this.finishFile(s, file)
		if (more) this.wake(s)
	}

	/** Input [s.next, to) is missing: a short gap becomes silence, a long one ends the file. */
	private gapTo(s: Session, file: FileState, to: number): void {
		const missing = to - s.next
		if (missing <= 0) return
		if (file.frames === 0) {
			// Nothing produced yet: the pre-roll simply starts later (the ring did not reach).
			file.startSample = to
			s.next = to
			return
		}
		const gap: AnalogGap = {
			cause: "input-gap",
			inputSampleIndex: s.next,
			droppedInputSamples: missing,
			outputFrameIndex: file.frames,
		}
		if (file.handle) file.handle.addGap(gap)
		else if (file.gaps.length < MAX_PENDING_GAPS) file.gaps.push(gap)
		if (file.gapRun === 0) file.gapFrom = s.next
		file.gapRun += missing
		if (file.gapRun > (WIDEBAND_MAX_SILENCE_GAP_MS * s.fs) / 1000) {
			// Frames already queued past `end` (silence of this run) are trimmed at the finish.
			const end = file.gapFrom
			s.next = to
			file.endSample = Math.min(file.endSample ?? end, end)
			file.cut = "source-lost"
			s.seg.abort()
			s.pendingStart = null
			return
		}
		const silence = new Int16Array(
			Math.round((missing * ANALOG_AUDIO_RATE_HZ) / s.fs),
		)
		this.enqueue(s, file, { pcm: silence, tone: silence })
		s.next = to
	}

	private framesAt(s: Session, file: FileState, sample: number): number {
		return Math.max(
			0,
			Math.round(((sample - file.startSample) * ANALOG_AUDIO_RATE_HZ) / s.fs),
		)
	}

	private enqueue(s: Session, file: FileState, f: Frames): void {
		if (f.pcm.length === 0) return
		if (file.queue.length + f.pcm.length > WIDEBAND_MAX_QUEUED_FRAMES) {
			// The writer is not keeping up (or never became ready): this file is lost.
			this.refuse(s)
			return
		}
		file.queue.push(f)
		file.frames += f.pcm.length
	}

	/** CTCSS input: only frames inside the observed activity (no pre-roll, no hang noise). */
	private toneFrames(
		s: Session,
		file: FileState,
		first: number,
		tone: Int16Array,
	): void {
		const perFrame = s.fs / ANALOG_AUDIO_RATE_HZ
		for (let i = 0; i < tone.length; i++) {
			const sample = file.startSample + (first + i) * perFrame
			if (sample >= s.onset && sample <= s.lastActive)
				s.ctcss.pushSample(tone[i]! / 32_768)
		}
	}

	/**
	 * Voice gate input: the written frames inside a joined track's span, trimmed by
	 * WIDEBAND_GATE_EDGE_TRIM_MS at both ends (an open track runs to now). Pre-roll, hang and the
	 * noise between joined transmissions stay out: squelch-open noise is not a carrier's audio.
	 */
	private gateFrames(
		s: Session,
		file: FileState,
		first: number,
		pcm: Int16Array,
	): void {
		const perFrame = s.fs / ANALOG_AUDIO_RATE_HZ
		const from = file.startSample + first * perFrame
		for (const [id, a] of s.activity)
			if (!a.open && a.last < from) s.activity.delete(id)
		if (file.gate.voiced || pcm.length === 0) return
		const trim = (WIDEBAND_GATE_EDGE_TRIM_MS * s.fs) / 1000
		const mask = new Uint8Array(pcm.length)
		for (const a of s.activity.values()) {
			const lo = Math.max(0, Math.ceil((a.start + trim - from) / perFrame))
			const hi = a.open
				? pcm.length
				: Math.min(
						pcm.length,
						Math.floor((a.last - trim - from) / perFrame) + 1,
					)
			if (hi > lo) mask.fill(1, lo, hi)
		}
		let i = 0
		while (i < pcm.length) {
			if (mask[i] === 0) {
				i++
				continue
			}
			let j = i
			while (j < pcm.length && mask[j] === 1) j++
			file.gate.push(pcm.subarray(i, j))
			i = j
		}
	}

	/** Pushes queued frames older than `until` (a sample index), one bounded push at a time. */
	private flush(s: Session, file: FileState, until: number): void {
		if (!file.ready || file.writing || file.failed) return
		const written = file.frames - file.queue.length
		const allowed = Math.min(
			file.frames,
			this.framesAt(s, file, until),
			file.endSample === null
				? Number.POSITIVE_INFINITY
				: this.framesAt(s, file, file.endSample),
		)
		const budget = Math.min(PUSH_FRAMES, allowed - written)
		if (budget <= 0) return
		const handle = file.handle
		if (handle === null) return
		const chunk = file.queue.take(budget)
		this.toneFrames(s, file, written, chunk.tone)
		this.gateFrames(s, file, written, chunk.pcm)
		file.writing = true
		handle.push(chunk.pcm).then(
			() => {
				file.writing = false
				if (s.file === file && !s.done) this.wake(s)
				else if (file.finishing) this.completeFinish(s, file)
			},
			() => {
				file.writing = false
				file.failed = true
				if (s.file === file) this.refuse(s)
				else handle.cancel("cancelled")
			},
		)
	}

	/** The file reached its end sample: write what belongs to it, then finish the operation. */
	private finishFile(s: Session, file: FileState): void {
		file.finishing = true
		const endedAt = file.endSample ?? s.next
		// Frames past the end belong to the next file (roll-over or a new transmission) or go.
		const excess = Math.max(0, file.frames - this.framesAt(s, file, endedAt))
		const carry = file.queue.takeTail(excess)
		file.frames -= carry.reduce((n, f) => n + f.pcm.length, 0)
		const next = s.pendingStart
		s.pendingStart = null
		s.file = null
		if (next !== null && !this.stopped) {
			this.openFile(s, next)
			const cont = s.file as FileState | null
			if (cont && next >= endedAt && next <= s.next) {
				// The carried frames are samples [endedAt, s.next): keep those from `next` on.
				let skip = Math.round(((next - endedAt) * ANALOG_AUDIO_RATE_HZ) / s.fs)
				for (const part of carry) {
					if (skip >= part.pcm.length) {
						skip -= part.pcm.length
						continue
					}
					this.enqueue(s, cont, {
						pcm: part.pcm.subarray(skip),
						tone: part.tone.subarray(skip),
					})
					skip = 0
				}
			} else if (cont) s.next = Math.max(s.next, next)
		}
		this.completeFinish(s, file)
		if (s.file) this.wake(s)
		else this.dispose(s)
	}

	/** Writes the rest of a finishing file's queue, then finishes its operation. */
	private completeFinish(s: Session, file: FileState): void {
		if (file.failed) {
			file.handle?.cancel("cancelled")
			return
		}
		// Not admitted yet: the readiness handler resumes the finish (or a failure cancels).
		if (!file.ready || file.handle === null) return
		if (file.writing) return
		if (file.queue.length > 0) {
			this.flush(s, file, Number.POSITIVE_INFINITY)
			return
		}
		if (!file.gate.voiced) {
			// A carrier with no voice-like audio (a spur, an idle or CTCSS-only carrier): no WAV.
			file.failed = true
			file.handle.cancel("cancelled")
			// A silent carrier reaching the file limit does not continue, nor start again.
			if (file.cut === "duration-limit" && !s.done) this.refuse(s)
			return
		}
		void file.handle.finish(file.cut).catch(() => undefined)
	}

	/** Ends every open file now (kept, cut), e.g. stream loss or shutdown. */
	private endSession(s: Session, cut: AnalogCut): void {
		const file = s.file
		s.pendingStart = null
		if (file && !file.finishing) {
			file.endSample = Math.min(file.endSample ?? s.next, s.next)
			file.cut = cut
			if (file.frames === 0) {
				file.failed = true
				s.file = null
				file.handle?.cancel(cut)
			} else this.finishFile(s, file)
		}
		this.dispose(s)
	}

	private cancelSession(s: Session, cut: AnalogCut): void {
		const file = s.file
		s.file = null
		s.pendingStart = null
		s.seg.abort()
		if (file) {
			file.failed = true
			file.handle?.cancel(cut)
		}
		this.dispose(s)
	}

	private dispose(s: Session): void {
		if (s.done) return
		s.done = true
		s.untap()
		this.sessions.delete(s.id)
		for (const id of s.observations)
			if (this.byObservation.get(id) === s.id) this.byObservation.delete(id)
		const end = s.seg.previousEnd
		if (Number.isFinite(end)) {
			this.recentEnds.push({
				sourceId: s.sourceId,
				stream: s.stream,
				epoch: s.epoch,
				hz: s.targetHz,
				end,
			})
			if (this.recentEnds.length > RECENT_ENDS) this.recentEnds.shift()
		}
	}

	/** At most one warning a minute; never the error's untrusted text beyond safe fields. */
	private warn(err: unknown): void {
		const now = this.deps.now()
		if (now - this.warnedAt < 60_000) return
		this.warnedAt = now
		this.log.warn(safeErrorFields(err), "Wideband analog recording failed")
	}
}
