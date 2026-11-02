/**
 * Default-on analog voice recorder fed from the scanner's own wideband IQ ring. It needs no
 * channelizer and no channel tier. A clean narrow track starts one session per channel, which
 * reads the engine ring from `hold.preRollMs` before the onset, demodulates NFM
 * (`WidebandNfmChain`) and writes 8 kHz WAV files through the evidence store's analog
 * operations (`recordings/analog/<discoveryId>/`, storage cap, disk-low and retention apply).
 * `TransmissionSegmenter` decides the files: one per transmission, a gap shorter than
 * `hold.hangMs` never splits. Work runs in bounded slices off the engine's tap callback.
 *
 * A session does not wait for the classifier: a clean, non-burst track in a range a band plan
 * lists for analog FM (or no band plan covers) starts a shadow session as soon as it appears.
 * Its audio stays in memory (no store operation, nothing on disk) until the observation is
 * classed analog-fm (any snapshot, the closing one included) and the file's audio sounds like
 * voice (`VoiceActivityGate`); then the store operation begins and the buffered audio is
 * written. A session closed without that class, or classed as something else first, is
 * discarded. A file whose audio never sounds like voice (a spur, an idle or CTCSS-only carrier)
 * is never written, and a session not voiced after WIDEBAND_QUALIFY_MS of in-track audio ends.
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
 * The voice gate and the CTCSS bank hear audio this late too (the spans are final by then).
 */
export const WIDEBAND_HOLDBACK_MS = 1_000
/** WAV and analog-operation bound: 960 000 frames = 120 s at 8 kHz (MAX_WAV_DURATION_SECONDS). */
export const WIDEBAND_MAX_FILE_MS = 120_000
/**
 * Audio one session holds in memory, over all its files not written yet: a shadow waiting for
 * its class, a file waiting for its slot or for the writer. 60 s (the default hold.maxHoldMs)
 * · 8000 frames/s = 480 000 frames · 2 B = 960 KB per session; at most
 * MAX_ACTIVE_ANALOG_PER_SOURCE (2) sessions per source: 1.92 MB. Past it the session is dropped
 * (no file): a transmission still unclassed after a minute is not kept, and a store that does
 * not take audio for a minute loses it.
 */
export const WIDEBAND_MAX_BUFFERED_MS = 60_000
export const WIDEBAND_MAX_BUFFERED_FRAMES =
	(WIDEBAND_MAX_BUFFERED_MS / 1000) * ANALOG_AUDIO_RATE_HZ
/**
 * In-track audio a session may hear without its voice gate passing: 8 s = 64 000 frames. Past
 * it the session ends and its observations are refused (a steady or idle carrier holds no slot
 * and no CPU for longer). A voice qualifies on one 500 ms window, usually in the first second.
 */
export const WIDEBAND_QUALIFY_MS = 8_000
export const WIDEBAND_QUALIFY_FRAMES =
	(WIDEBAND_QUALIFY_MS / 1000) * ANALOG_AUDIO_RATE_HZ
/**
 * A session not qualified after this much in-track audio (2 s = 16 000 frames, four gate
 * windows) may be evicted for a new candidate when every slot is held; a younger one is not,
 * so a voice that has not been heard for a full window yet is never displaced.
 */
export const WIDEBAND_EVICT_MIN_HEARD_FRAMES = 2 * ANALOG_AUDIO_RATE_HZ
/**
 * A file whose first readable sample is more than this (one 50 ms engine block) after its
 * planned start (onset − preRoll) lost its pre-roll or onset (the ring did not reach back):
 * it is kept as cut (`source-lost`) instead of complete.
 */
export const WIDEBAND_HEAD_CUT_TOLERANCE_MS = 50
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
/**
 * Activity intervals kept per session (open tracks and closed ones not yet judged). Past it the
 * oldest closed span goes; when every one is open the new span is not kept (an older open span
 * covers it up to now). At most 64 entries of 3 numbers per session.
 */
export const WIDEBAND_MAX_ACTIVITY = 64
/** Gaps held for a file not admitted yet (the analog operation keeps 64 too). */
export const WIDEBAND_MAX_PENDING_GAPS = 64
/**
 * Files of one session waiting for a slot: a roll-over or a new transmission while the previous
 * file still settles, and one more behind it. Their audio counts in WIDEBAND_MAX_BUFFERED_FRAMES.
 */
export const MAX_WAITING_FILES = 2
/** Observations remembered as refused, and as retried once, per manager. */
const MAX_REMEMBERED = 1024
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

/**
 * Estimated cores of one recording session at `inputRateHz` (the chain cost above, CPU ms per
 * second / 1000): 0.0592 at 1.024 Msps, 0.0716 at 2.4 Msps. Reserved in the scanner's CPU
 * budget for as long as the session demodulates, shadow or not.
 */
export function widebandSessionCores(inputRateHz: number): number {
	const rate = inputRateHz > 0 ? inputRateHz : 0
	return (
		(WIDEBAND_CPU_FIXED_MS + (WIDEBAND_CPU_MS_PER_MSPS * rate) / 1e6) / 1000
	)
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
	/**
	 * Reserves `cores` in the scanner's shared CPU budget (probes, live audio): a release, or
	 * null when the budget is full (the session does not start; the next snapshot retries).
	 */
	reserveCores?(cores: number): (() => void) | null
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
	/** The observation is classed analog-fm in this snapshot. */
	readonly analogFm: boolean
	/** Classed as something definitely not analog FM (digital, burst, AM, wideband). */
	readonly nonAnalog?: boolean
	/** A band plan range at the track lists analog FM, or none covers it: a shadow may start. */
	readonly shadowAllowed?: boolean
	readonly encrypted: boolean
	/** No covering job, or a covering job with record.analog. */
	readonly recordAllowed: boolean
	/** The channel-tier recorder owns this observation: stand down. */
	readonly channelOwned: boolean
}

/** What the closing snapshot says about the observation (its class may arrive only there). */
export interface WidebandCloseInfo {
	readonly analogFm: boolean
	readonly nonAnalog?: boolean
	readonly discoveryId: string | null
}

/** Demodulated audio and its tone-band twin, frame for frame; `tone` null: not for CTCSS. */
interface Frames {
	readonly pcm: Int16Array
	readonly tone: Int16Array | null
}

/** Audio not written yet, oldest first (views of the demodulated arrays, no copies). */
class PcmQueue {
	private readonly parts: Int16Array[] = []
	length = 0
	push(pcm: Int16Array): void {
		if (pcm.length === 0) return
		this.parts.push(pcm)
		this.length += pcm.length
	}
	/** Removes the oldest `n` frames (a copy only when parts are joined). */
	take(n: number): Int16Array {
		const want = Math.min(n, this.length)
		const head = this.parts[0]
		if (head && head.length >= want) {
			this.length -= want
			if (head.length === want) this.parts.shift()
			else this.parts[0] = head.subarray(want)
			return head.subarray(0, want)
		}
		const out = new Int16Array(want)
		let o = 0
		while (o < want) {
			// Whole head parts only: each take below is the single-part case.
			const part = this.take(Math.min(this.parts[0]!.length, want - o))
			out.set(part, o)
			o += part.length
		}
		return out
	}
	/** Removes the newest `n` frames, oldest first. */
	takeTail(n: number): Int16Array[] {
		const out: Int16Array[] = []
		let excess = Math.min(n, this.length)
		while (excess > 0) {
			const part = this.parts.at(-1)!
			if (part.length <= excess) {
				out.unshift(part)
				this.parts.pop()
				excess -= part.length
				this.length -= part.length
				continue
			}
			const cut = part.length - excess
			out.unshift(part.subarray(cut))
			this.parts[this.parts.length - 1] = part.subarray(0, cut)
			this.length -= excess
			excess = 0
		}
		return out
	}
}

interface FileState {
	readonly generation: number
	/** Null until admitted: classed, voiced, and the session's previous operation settled. */
	handle: AnalogHandle | null
	/** Gaps found before the operation began (replayed on begin). */
	readonly gaps: AnalogGap[]
	/** Input samples missing over consecutive unreadable slices, from `gapFrom`. */
	gapRun: number
	gapFrom: number
	/** Voice/activity check over the judged audio: a file that never qualifies is not written. */
	readonly gate: VoiceActivityGate
	/** This file's CTCSS input (inside the activity only); null once its tone was taken. */
	ctcss: CtcssBank | null
	/** The tone heard over this file (taken when it finished), reported once it is finalized. */
	toneHz: number | null
	/** The start the segmenter planned (onset − preRoll, clamped): the head-cut reference. */
	readonly planned: number
	startSample: number
	endSample: number | null
	cut: AnalogCut
	/** The ring did not reach the planned start: the pre-roll or onset is missing. */
	headCut: boolean
	ready: boolean
	failed: boolean
	readonly queue: PcmQueue
	/** Produced frames the voice gate and the CTCSS bank have not heard yet, oldest first. */
	readonly unjudged: Frames[]
	/** Frames produced for this file (written + queued). */
	frames: number
	/** Frames heard by the gate and the bank (from the file's start). */
	judged: number
	/** In-track frames the voice gate heard in this file. */
	heard: number
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
	/** The owner's discovery; a shadow may start before it exists. */
	discoveryId: string | null
	/** Some snapshot of a joined observation was classed analog-fm. */
	classed: boolean
	/** Some file of this session sounded like voice. */
	qualified: boolean
	/** In-track frames the gate heard over the session's files. */
	heard: number
	readonly observations: Set<string>
	/** Track spans per observation (open: still active), the voice gate's input window. */
	readonly activity: Map<string, { start: number; last: number; open: boolean }>
	readonly seg: TransmissionSegmenter
	readonly chain: WidebandNfmChain
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
	/** Every file of this session whose operation has not settled (or not begun) yet. */
	readonly files: Set<FileState>
	/** Operations of this session not settled yet. */
	ops: number
	/** A start event waiting for the current file to finish (roll-over or a new transmission). */
	pendingStart: number | null
	generation: number
	untap: () => void
	releaseCores: () => void
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

/** Adds `id` to a bounded remembered set (the oldest entry goes past MAX_REMEMBERED). */
function remember(set: Set<string>, id: string): void {
	set.add(id)
	if (set.size > MAX_REMEMBERED) {
		const oldest = set.values().next()
		if (oldest.done !== true) set.delete(oldest.value)
	}
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
	/** Observations whose store admission failed once: the next failure refuses them. */
	private readonly retried = new Set<string>()
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
	 * Slots this recorder holds on `sourceId`: its unsettled operations (a finishing file still
	 * counts against the store's per-source limit) plus every live session holding none (a shadow
	 * or a session not admitted yet still demodulates).
	 */
	activeOn(sourceId: string): number {
		let n = this.unsettled.get(sourceId) ?? 0
		for (const s of this.sessions.values())
			if (s.sourceId === sourceId && !s.done && s.ops === 0) n++
		return n
	}

	owns(observationId: string): boolean {
		return this.byObservation.has(observationId)
	}

	/**
	 * The sweep-hold hook: a session on this source and epoch is classed analog-fm and has been
	 * voiced (a recording is open or about to be written). The scheduler may keep its hold on
	 * the hop while this is true, bounded by its own maxHoldMs.
	 */
	recordingActive(sourceId: string, epoch: number): boolean {
		for (const s of this.sessions.values())
			if (
				!s.done &&
				s.sourceId === sourceId &&
				s.epoch === epoch &&
				s.classed &&
				s.qualified
			)
				return true
		return false
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
	 * cut (stream change, job end) ends the file at the track's last sample. `info` is what the
	 * closing snapshot says: its class may be the first analog-fm one.
	 */
	closed(
		observationId: string,
		track: TrackSnapshot,
		cut: AnalogCut | null,
		info?: WidebandCloseInfo,
	): void {
		const id = this.byObservation.get(observationId)
		if (id === undefined) return
		this.byObservation.delete(observationId)
		const s = this.sessions.get(id)
		if (!s || s.done) return
		s.lastActive = Math.max(s.lastActive, track.lastSample)
		const span = s.activity.get(observationId)
		if (span) {
			span.last = Math.max(span.last, track.lastSample)
			span.open = false
		}
		if (!cleanTrack(track)) {
			// Any contributing track turning edge, spur or unverified discards the recording.
			this.refuse(s, true)
			return
		}
		if (info !== undefined && !this.classify(s, observationId, info)) return
		s.observations.delete(observationId)
		if (s.observations.size === 0 && !s.classed) {
			// No class can arrive any more: a shadow is never written.
			this.discard(s)
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

	/**
	 * Shutdown: finish open files (kept as cut when classed and voiced), let files waiting for a
	 * slot begin and finish, then wait for every operation to settle.
	 */
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

	/**
	 * A snapshot's class for a joined observation: analog-fm classes the session (it stays
	 * classed); a definite other class before that discards a shadow. False: discarded.
	 */
	private classify(
		s: Session,
		observationId: string,
		info: {
			analogFm: boolean
			nonAnalog?: boolean | undefined
			discoveryId: string | null
		},
	): boolean {
		if (observationId === s.owner && info.discoveryId !== null)
			s.discoveryId ??= info.discoveryId
		if (info.analogFm) s.classed = true
		else if (!s.classed && info.nonAnalog === true) {
			this.refuse(s, true)
			return false
		}
		if (s.classed) for (const f of [...s.files]) this.admit(s, f)
		return !s.done
	}

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
			if (barred) this.refuse(s, true)
			else this.classify(s, observationId, input)
			return
		}
		if (input.channelOwned || this.refused.has(observationId)) return
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
			if (barred) {
				// Its audio would land in this file (or its hang): discard the recording, as when a
				// joined track turns encrypted, opted out or unclean.
				s.observations.add(observationId)
				this.refuse(s, true)
				return
			}
			const events = s.seg.open(observationId, track.startSample)
			s.observations.add(observationId)
			s.lastActive = Math.max(s.lastActive, track.lastSample)
			this.noteActivity(s, observationId, track)
			this.byObservation.set(observationId, s.id)
			this.applyEvents(s, events)
			if (this.classify(s, observationId, input)) this.wake(s)
			return
		}
		if (barred) return
		// A shadow needs a clean, narrow (cleanTrack), non-burst track where analog FM may be.
		const shadow =
			input.shadowAllowed === true &&
			input.nonAnalog !== true &&
			!track.flags.burst
		if (!input.analogFm && !shadow) return
		const settings = this.deps.settings()
		const cap = widebandRecordingCap(
			epoch.sampleRateHz,
			settings.cpuBudgetCores,
		)
		if (this.activeOn(input.sourceId) >= cap) this.evict(input.sourceId)
		// Still full: not refused, the next snapshot tries again.
		if (this.activeOn(input.sourceId) >= cap) return
		const reserve = this.deps.reserveCores
		const release = reserve
			? reserve(widebandSessionCores(epoch.sampleRateHz))
			: () => undefined
		// The shared CPU budget is full (probes, live audio): not refused, retried next snapshot.
		if (release === null) return
		this.startSession(input, engine, epoch, settings, release)
	}

	/**
	 * Every slot is held: the oldest session that heard WIDEBAND_EVICT_MIN_HEARD_FRAMES of
	 * in-track audio without sounding like voice gives its slot up (and is refused), so a steady
	 * carrier never keeps a voice out. Such a session never began a store operation.
	 */
	private evict(sourceId: string): void {
		for (const s of this.sessions.values())
			if (
				!s.done &&
				s.sourceId === sourceId &&
				!s.qualified &&
				s.ops === 0 &&
				s.heard >= WIDEBAND_EVICT_MIN_HEARD_FRAMES
			) {
				this.refuse(s, true)
				return
			}
	}

	private startSession(
		input: WidebandTrackInput,
		engine: WidebandEngineView,
		epoch: ReturnType<WidebandEngineView["currentEpoch"]>,
		settings: { preRollMs: number; hangMs: number },
		releaseCores: () => void,
	): void {
		const { track } = input
		const trust = epoch.tuningTrust
		if (!usableTrust(trust)) {
			releaseCores()
			return
		}
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
			discoveryId: input.discoveryId,
			classed: input.analogFm,
			qualified: false,
			heard: 0,
			observations: new Set([input.observationId]),
			activity: new Map([
				[
					input.observationId,
					{ start: track.startSample, last: track.lastSample, open: true },
				],
			]),
			seg,
			chain,
			onset: track.startSample,
			lastActive: track.lastSample,
			groupDelay: chain.groupDelaySeconds(fs) * 48_000,
			next: 0,
			limit: Number.POSITIVE_INFINITY,
			endCut: null,
			file: null,
			waiting: [],
			files: new Set(),
			ops: 0,
			pendingStart: null,
			generation: 0,
			untap: () => undefined,
			releaseCores,
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

	/** A new file from `startSample`, held in memory until it is admitted (`admit`). */
	private openFile(s: Session, startSample: number): void {
		s.generation++
		const file: FileState = {
			generation: s.generation,
			handle: null,
			gaps: [],
			gapRun: 0,
			gapFrom: 0,
			gate: new VoiceActivityGate(),
			ctcss: new CtcssBank(),
			toneHz: null,
			planned: startSample,
			startSample,
			endSample: null,
			cut: "completed",
			headCut: false,
			ready: false,
			failed: false,
			queue: new PcmQueue(),
			unjudged: [],
			frames: 0,
			judged: 0,
			heard: 0,
			writing: false,
			finishing: false,
		}
		s.file = file
		s.files.add(file)
	}

	/**
	 * Begins the file's analog operation once the session is classed analog-fm, its discovery is
	 * known and the file sounded like voice: at once, or, while this session's previous operation
	 * has not settled (it still holds an analog slot), once that one settles. A continuation
	 * never needs a third slot.
	 */
	private admit(s: Session, file: FileState): void {
		if (
			file.failed ||
			file.handle !== null ||
			!s.classed ||
			s.discoveryId === null ||
			!file.gate.voiced ||
			s.waiting.includes(file) ||
			(s.done && !file.finishing)
		)
			return
		if (s.ops === 0) {
			this.beginOp(s, file)
			return
		}
		if (s.waiting.length >= MAX_WAITING_FILES) {
			// The store is not settling files: give up rather than hold more audio.
			file.failed = true
			s.files.delete(file)
			if (s.file === file) this.refuse(s)
			return
		}
		s.waiting.push(file)
	}

	private beginOp(s: Session, file: FileState): void {
		// A file that waited for a slot begins even during stop(): the store stays open until the
		// recorder's shutdown resolved, which waits for it (at most MAX_WAITING_FILES per session).
		if (file.failed || file.handle !== null || s.discoveryId === null) return
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
			s.files.delete(file)
			if (s.file === file) this.refuseOrRetry(s)
			return
		}
		file.handle = handle
		for (const gap of file.gaps.splice(0)) handle.addGap(gap)
		s.ops++
		this.unsettled.set(s.sourceId, (this.unsettled.get(s.sourceId) ?? 0) + 1)
		const settled = handle.settled
			.then(receipt => this.onSettled(s, file, receipt))
			.catch(() => undefined)
			.finally(() => {
				this.bindings.delete(key)
				const left = (this.unsettled.get(s.sourceId) ?? 1) - 1
				if (left > 0) this.unsettled.set(s.sourceId, left)
				else this.unsettled.delete(s.sourceId)
				this.settling.delete(settled)
				s.files.delete(file)
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
				// Storage cap, disk-low or a lost association: this transmission is not recorded
				// (the observation is tried once more from its next snapshot).
				file.failed = true
				if (s.file === file) this.refuseOrRetry(s)
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
		if (s.activity.size <= WIDEBAND_MAX_ACTIVITY) return
		for (const [id, a] of s.activity)
			if (!a.open) {
				s.activity.delete(id)
				return
			}
		// Every span is open: an older open span already covers the new one up to now.
		s.activity.delete(observationId)
	}

	/** Per file: the tone heard over this file's own audio, once it is finalized. */
	private onSettled(s: Session, file: FileState, receipt: AnalogReceipt): void {
		if (receipt.outcome !== "finalized" || this.deps.recordTone === undefined)
			return
		const hz = file.toneHz
		if (hz === null) return
		try {
			this.deps.recordTone(s.owner, hz, this.deps.now())
		} catch (err: unknown) {
			this.warn(err)
		}
	}

	/**
	 * Refused: drop the session and do not try its observations again. `everyFile` (an
	 * observation turned encrypted, opted out, unclean or not analog) also cancels the session's
	 * earlier files still finishing or waiting, a roll-over's first file among them; otherwise only
	 * the current file goes and an earlier complete file is still written.
	 */
	private refuse(s: Session, everyFile = false): void {
		for (const id of s.observations) remember(this.refused, id)
		this.cancelSession(s, "cancelled", everyFile)
	}

	/** A store admission failure: the first one per observation is retried on its next snapshot. */
	private refuseOrRetry(s: Session): void {
		const ids = [...s.observations]
		if (ids.length > 0 && ids.every(id => !this.retried.has(id))) {
			for (const id of ids) remember(this.retried, id)
			this.cancelSession(s, "cancelled")
			return
		}
		this.refuse(s)
	}

	/** A shadow whose class never came: nothing of it is kept, and its observations are done. */
	private discard(s: Session): void {
		this.refuse(s, true)
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
						if (s.done || s.file !== file) return
					}
					s.next = r.startSample + r.bytes.length / 2
					file.gapRun = 0
				}
			}
			more = s.next < target
		}
		if (s.done || s.file !== file) return
		const until = Math.min(
			s.seg.writableUntil(edge),
			file.endSample ?? Number.POSITIVE_INFINITY,
		)
		this.judge(s, file, this.framesAt(s, file, until))
		if (s.done || s.file !== file) return
		this.flush(s, file, until)
		if (file.endSample !== null && s.next >= file.endSample && !file.finishing)
			this.finishFile(s, file)
		if (more) this.wake(s)
	}

	/** Input [s.next, to) is missing: a short gap becomes silence, a long one ends the file. */
	private gapTo(s: Session, file: FileState, to: number): void {
		const missing = to - s.next
		if (missing <= 0) return
		if (file.frames === 0) {
			// Nothing produced yet: the pre-roll simply starts later (the ring did not reach). Past
			// one engine block the file lost audio it should hold: it is kept as cut.
			file.startSample = to
			s.next = to
			if (to - file.planned > (WIDEBAND_HEAD_CUT_TOLERANCE_MS * s.fs) / 1000)
				file.headCut = true
			return
		}
		const gap: AnalogGap = {
			cause: "input-gap",
			inputSampleIndex: s.next,
			droppedInputSamples: missing,
			outputFrameIndex: file.frames,
		}
		if (file.handle) file.handle.addGap(gap)
		else if (file.gaps.length < WIDEBAND_MAX_PENDING_GAPS) file.gaps.push(gap)
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

	/** Frames this session holds in memory, over every file not written yet. */
	private buffered(s: Session): number {
		let n = 0
		for (const f of s.files) n += f.queue.length
		return n
	}

	private enqueue(s: Session, file: FileState, f: Frames): void {
		if (f.pcm.length === 0) return
		if (this.buffered(s) + f.pcm.length > WIDEBAND_MAX_BUFFERED_FRAMES) {
			// Unclassed for a minute, or the writer is not keeping up: this file is lost.
			this.refuse(s)
			return
		}
		file.queue.push(f.pcm)
		file.unjudged.push(f)
		file.frames += f.pcm.length
	}

	/**
	 * The gate and the CTCSS bank hear the produced frames up to `until` (a frame index of the
	 * file), as soon as no late track report can change the spans there. A file that sounds like
	 * voice is admitted; a session that heard WIDEBAND_QUALIFY_FRAMES of in-track audio without
	 * it ends and is refused.
	 */
	private judge(s: Session, file: FileState, until: number): void {
		while (file.judged < until && file.unjudged.length > 0) {
			const head = file.unjudged[0]!
			const n = Math.min(head.pcm.length, until - file.judged)
			if (n === head.pcm.length) file.unjudged.shift()
			else
				file.unjudged[0] = {
					pcm: head.pcm.subarray(n),
					tone: head.tone?.subarray(n) ?? null,
				}
			if (head.tone !== null)
				this.toneFrames(s, file, file.judged, head.tone.subarray(0, n))
			this.gateFrames(s, file, file.judged, head.pcm.subarray(0, n))
			file.judged += n
		}
		if (file.gate.voiced) {
			s.qualified = true
			this.admit(s, file)
		} else if (file.heard >= WIDEBAND_QUALIFY_FRAMES && !file.finishing)
			// Not voice after 8 s in the track: a carrier, not a transmission worth a slot.
			this.refuse(s, !s.qualified)
	}

	/** CTCSS input: only frames inside the observed activity (no pre-roll, no hang noise). */
	private toneFrames(
		s: Session,
		file: FileState,
		first: number,
		tone: Int16Array,
	): void {
		const bank = file.ctcss
		if (bank === null) return
		const perFrame = s.fs / ANALOG_AUDIO_RATE_HZ
		for (let i = 0; i < tone.length; i++) {
			const sample = file.startSample + (first + i) * perFrame
			if (sample >= s.onset && sample <= s.lastActive)
				bank.pushSample(tone[i]! / 32_768)
		}
	}

	/**
	 * Voice gate input: the judged frames inside a joined track's span, trimmed by
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
			file.heard += j - i
			s.heard += j - i
			i = j
		}
	}

	/** Pushes queued, judged frames older than `until` (a sample index), one bounded push at a time. */
	private flush(s: Session, file: FileState, until: number): void {
		if (!file.ready || file.writing || file.failed) return
		const written = file.frames - file.queue.length
		const allowed = Math.min(
			file.judged,
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
		file.writing = true
		handle.push(chunk).then(
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

	/** The file reached its end sample: judge and write what belongs to it, then finish it. */
	private finishFile(s: Session, file: FileState): void {
		file.finishing = true
		const endedAt = file.endSample ?? s.next
		const endFrames = this.framesAt(s, file, endedAt)
		this.judge(s, file, endFrames)
		if (file.failed) {
			if (s.file === file) s.file = null
			if (!s.done) this.dispose(s)
			return
		}
		// Frames past the end belong to the next file (roll-over or a new transmission) or go.
		const excess = Math.max(0, file.frames - endFrames)
		const carry = file.queue.takeTail(excess)
		file.frames -= carry.reduce((n, f) => n + f.length, 0)
		file.unjudged.length = 0
		if (
			file.headCut &&
			(file.cut === "completed" || file.cut === "duration-limit")
		)
			file.cut = "source-lost"
		file.toneHz = file.ctcss?.result() ?? null
		file.ctcss = null
		const next = s.pendingStart
		s.pendingStart = null
		s.file = null
		if (next !== null && !this.stopped) {
			this.openFile(s, next)
			const cont = s.file as FileState | null
			if (cont && next >= endedAt && next <= s.next) {
				// The carried frames are samples [endedAt, s.next): keep those from `next` on (not
				// for the CTCSS bank: their tone twin is gone).
				let skip = Math.round(((next - endedAt) * ANALOG_AUDIO_RATE_HZ) / s.fs)
				for (const part of carry) {
					if (skip >= part.length) {
						skip -= part.length
						continue
					}
					this.enqueue(s, cont, { pcm: part.subarray(skip), tone: null })
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
			s.files.delete(file)
			return
		}
		if (file.handle === null) {
			// Never admitted: every frame was judged, so this is the last chance. A file too short
			// for one gate window is judged on all of it.
			if (file.gate.conclude()) s.qualified = true
			this.admit(s, file)
			if (file.handle === null && !s.waiting.includes(file)) {
				// Not voiced, never classed or no discovery: nothing was written, nothing is kept.
				file.failed = true
				s.files.delete(file)
				if (file.cut === "duration-limit" && !s.done) this.refuse(s)
			}
			// Admitted: the readiness handler resumes the finish (or a failure cancels).
			return
		}
		// Not ready yet: the readiness handler resumes the finish (or a failure cancels).
		if (!file.ready) return
		if (file.writing) return
		if (file.queue.length > 0) {
			this.flush(s, file, Number.POSITIVE_INFINITY)
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
				s.files.delete(file)
				file.handle?.cancel(cut)
			} else this.finishFile(s, file)
		}
		this.dispose(s)
	}

	private cancelSession(s: Session, cut: AnalogCut, everyFile = false): void {
		const file = s.file
		s.file = null
		s.pendingStart = null
		s.seg.abort()
		const files = everyFile ? [...s.files] : file ? [file] : []
		if (everyFile) s.waiting.length = 0
		else if (file) {
			const at = s.waiting.indexOf(file)
			if (at >= 0) s.waiting.splice(at, 1)
		}
		for (const f of files) {
			f.failed = true
			f.handle?.cancel(cut)
			if (f.handle === null) s.files.delete(f)
		}
		// Files never admitted hold nothing in the store: an unadmitted finishing one goes too.
		for (const f of [...s.files])
			if (f.handle === null && !s.waiting.includes(f)) {
				f.failed = true
				s.files.delete(f)
			}
		this.dispose(s)
	}

	private dispose(s: Session): void {
		if (s.done) return
		s.done = true
		s.untap()
		s.releaseCores()
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
