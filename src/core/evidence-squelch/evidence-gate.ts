/**
 * Evidence gate (design, EvidenceGate; requirements 1.2-1.5): stage 2 of the auto squelch.
 * While stage 1 is open, the PCM is decimated to 8 kHz (`PcmDecimator`, as the tone squelch
 * gate) and fed to a `VoiceFrameMeter` and, on NFM, to `ToneEvidence`. The gate latches on a
 * qualified standard tone (NFM, after `TONE_MIN_MS` of audio) or on a voice judgement over the
 * last `VOICE_FRAMES` frames with enough quiet carrier blocks, and holds until `HANG_MS` of PCM
 * (stage 1 open or closed) has passed without carrier evidence of the latched transmission
 * (amendment A14, 2026-10-24).
 *
 * Stream time is counted in PCM samples, so chunking never changes a decision. A sample split
 * across calls is carried in a 4-byte hold. Per sample nothing is allocated; the only
 * allocation is inside `judgeEvidence` (its medians), at most once per 50 ms frame and only
 * while waiting with a full window.
 */
import {
	LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS,
	LIVE_AUDIO_AUTO_SQUELCH_HANG_MS,
	LIVE_AUDIO_AUTO_SQUELCH_QUIET_WINDOW_BLOCKS,
	LIVE_AUDIO_AUTO_SQUELCH_TONE_MIN_MS,
	LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES,
} from "@wavekit/api-types"
import type {
	LiveAudioAutoSquelchDiagnostics,
	LiveAudioAutoSquelchEvidence,
} from "@wavekit/api-types"
import { WaveKitError } from "../../utils/errors.js"
import {
	AUDIO_TONE_RATE_HZ,
	PcmDecimator,
} from "../audio-tones/tone-detector.js"
import { dataLike, isVoice, toneQualified } from "../scanner/analog-trial.js"
import {
	ANALOG_TRIAL_AUDIO_MIN_DB,
	ANALOG_TRIAL_DATA_SCORE,
	ANALOG_TRIAL_MIN_QUIET_FRACTION,
	ANALOG_TRIAL_VOICE_INDEX,
} from "../scanner/scanner-redesign-contract.js"
import type {
	AnalogTrialFrame,
	AnalogTrialStats,
	AnalogTrialTones,
} from "../scanner/scanner-redesign-contract.js"
import {
	EVIDENCE_FADE_OUT_MS,
	EVIDENCE_NOTE_DISCARD,
	EVIDENCE_NOTE_RESET,
	msToSamples,
} from "./contract.js"
import { SteDetector } from "./ste-detector.js"
import type {
	EvidenceGateOptions,
	EvidenceGatePort,
	EvidencePcmFormat,
} from "./contract.js"
import { ToneEvidence } from "./tone-evidence.js"
import type { ToneReading } from "./tone-evidence.js"
import { VoiceFrameMeter } from "./voice-meter.js"

export interface JudgeEvidenceInput {
	modulation: "nfm" | "am"
	/** The last `VOICE_FRAMES` frames; `carrierDb` and `hfNoiseDb` are unused. */
	stats: AnalogTrialStats
	tone: Readonly<ToneReading> | null
	audioMs: number
	quietBlocks: number
	/** Blocks noted in the last `QUIET_WINDOW_BLOCKS`. */
	notedBlocks: number
	framesFinite: boolean
	/**
	 * Syllable runs over the gate's syllable span (A15: the last `EVIDENCE_SYLLABLE_SPAN_FRAMES`
	 * frames). Absent: 0, so the sparse path fails closed.
	 */
	syllableRuns?: number
}

/**
 * Sparse-syllable voice (amendment A15, 2026-10-24): a syllable run is at least this many
 * consecutive 50 ms frames (150 ms, the short end of a syllable nucleus), each a syllable frame:
 * `audioDb` at or above `ANALOG_TRIAL_AUDIO_MIN_DB` at the channel's deviation reference (A13)
 * and sustained energy (`EVIDENCE_SYLLABLE_SUSTAINED` of its ten 5 ms sub-blocks at that level).
 */
export const EVIDENCE_SYLLABLE_RUN_FRAMES = 3
/**
 * A15: sustained sub-blocks a syllable frame needs (5 of 10: at least 25 ms of the 50 ms frame at
 * voice level). A click of a few ms fills one or two sub-blocks, so frames that are loud only
 * because a click fell in each of them never make a run.
 */
export const EVIDENCE_SYLLABLE_SUSTAINED = 5

/** A frame of the gate's window: the analog trial frame plus the A15 sub-block count. */
export type EvidenceFrame = AnalogTrialFrame & { sustained?: number }
/** A15: syllable runs the sparse path needs. */
export const EVIDENCE_SYLLABLE_RUNS = 2
/**
 * A15: frames over which syllable runs are counted (2 s, twice the voice window): two syllables
 * of speech with one-second pauses (counting, short words) never fit in one 1 s window.
 */
export const EVIDENCE_SYLLABLE_SPAN_FRAMES = 40

/**
 * A15 syllable frame: finite `audioDb` at or above -30 dB and at least `EVIDENCE_SYLLABLE_SUSTAINED`
 * sustained sub-blocks. A frame without a `sustained` count (not from the gate's meter) is never
 * one: the sparse path fails closed.
 */
export function isSyllableFrame(frame: EvidenceFrame | undefined): boolean {
	if (frame === undefined || frame === null || typeof frame !== "object")
		return false
	const { audioDb, sustained } = frame
	return (
		typeof audioDb === "number" &&
		Number.isFinite(audioDb) &&
		audioDb >= ANALOG_TRIAL_AUDIO_MIN_DB &&
		typeof sustained === "number" &&
		sustained >= EVIDENCE_SYLLABLE_SUSTAINED
	)
}

/** A15: syllable runs (≥ `EVIDENCE_SYLLABLE_RUN_FRAMES` consecutive syllable frames), in time order. */
export function syllableRuns(frames: readonly EvidenceFrame[]): number {
	let runs = 0
	let length = 0
	for (const frame of frames) {
		if (isSyllableFrame(frame)) {
			length += 1
			if (length === EVIDENCE_SYLLABLE_RUN_FRAMES) runs += 1
		} else length = 0
	}
	return runs
}

/** Median of finite values, or null (any non-finite value fails closed). */
function medianOf(values: readonly number[]): number | null {
	if (values.length === 0 || values.some(v => !Number.isFinite(v))) return null
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1
	return sorted.length % 2 === 1
		? (sorted[mid] ?? null)
		: ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/**
 * Which voice path a window passes (A15): `median` (the scanner's pinned `isVoice`: median
 * syllabic ≥ 0.3 and median audioDb ≥ -30), else `runs` (median syllabic ≥ 0.3 over the window
 * and at least `EVIDENCE_SYLLABLE_RUNS` syllable runs over the syllable span), else null.
 * Data-like and quiet rules are the caller's.
 */
export function voicePath(
	stats: AnalogTrialStats,
	runs: number,
): "median" | "runs" | null {
	if (isVoice(stats)) return "median"
	if (!(Number.isInteger(runs) && runs >= EVIDENCE_SYLLABLE_RUNS)) return null
	const syllabic = medianOf(stats.frames.map(frame => frame.syllabic))
	if (syllabic === null || syllabic < ANALOG_TRIAL_VOICE_INDEX) return null
	return "runs"
}

/** Mutable `AnalogTrialTones` scratch for the tone rule. */
interface ToneScratch {
	ctcssHz: number | null
	dcs: AnalogTrialTones["dcs"]
	audioSeconds: number
}

/**
 * The tone rule (step 1 of `judgeEvidence`): NFM only, at least `TONE_MIN_MS` of audio, a
 * standard CTCSS tone or DCS code, via the analog trial's `toneQualified`. Unknown shapes fail
 * closed (null).
 */
function toneKind(
	modulation: unknown,
	tone: Readonly<ToneReading> | null,
	audioMs: number,
	scratch: ToneScratch,
): "ctcss" | "dcs" | null {
	if (modulation !== "nfm" || tone === null || typeof tone !== "object")
		return null
	if (!(audioMs >= LIVE_AUDIO_AUTO_SQUELCH_TONE_MIN_MS)) return null
	scratch.audioSeconds = audioMs / 1_000
	if (tone.kind === "ctcss") {
		scratch.ctcssHz = tone.hz
		scratch.dcs = null
		return toneQualified(scratch) ? "ctcss" : null
	}
	if (tone.kind === "dcs") {
		scratch.ctcssHz = null
		scratch.dcs = tone.dcs
		return toneQualified(scratch) ? "dcs" : null
	}
	return null
}

/**
 * Pure judge (Property 2). Order: (1) tone (NFM only, audio >= TONE_MIN_MS, standard CTCSS or
 * DCS) → its kind, regardless of `framesFinite` (A10); (2) `!framesFinite` → null; (3) median
 * cluster >= ANALOG_TRIAL_DATA_SCORE → null; (4) quiet enough: `notedBlocks > 0 &&
 * quietBlocks >= ANALOG_TRIAL_MIN_QUIET_FRACTION * notedBlocks` (A11), else null; (5) `isVoice`
 * or (A15) the sparse-syllable path (`voicePath`) → "voice", else null. AM never takes step 1.
 */
export function judgeEvidence(
	input: JudgeEvidenceInput,
): LiveAudioAutoSquelchEvidence | null {
	// Fail closed on malformed input: unknown modulation, non-finite or impossible counts.
	const modulation: unknown = input.modulation
	if (modulation !== "nfm" && modulation !== "am") return null
	const noted = input.notedBlocks
	const quiet = input.quietBlocks
	if (
		!Number.isFinite(input.audioMs) ||
		!Number.isInteger(noted) ||
		!Number.isInteger(quiet) ||
		quiet < 0 ||
		quiet > noted
	)
		return null
	const scratch: ToneScratch = { ctcssHz: null, dcs: null, audioSeconds: 0 }
	const tone = toneKind(modulation, input.tone, input.audioMs, scratch)
	if (tone !== null) return tone
	// A10: frame finiteness gates voice only, checked both by flag and by value.
	if (input.framesFinite !== true || !voiceFramesFinite(input.stats))
		return null
	if (dataLike(input.stats)) return null
	if (!(noted > 0 && quiet >= ANALOG_TRIAL_MIN_QUIET_FRACTION * noted))
		return null
	return voicePath(input.stats, input.syllableRuns ?? 0) !== null
		? "voice"
		: null
}

/** At least one frame, each with finite `audioDb`, `syllabic` and `cluster`. */
function voiceFramesFinite(stats: AnalogTrialStats): boolean {
	if (stats === null || typeof stats !== "object") return false
	const frames: unknown = (stats as { frames?: unknown }).frames
	if (!Array.isArray(frames) || frames.length === 0) return false
	for (const frame of frames as readonly (AnalogTrialFrame | null)[]) {
		if (frame === null || typeof frame !== "object") return false
		if (
			!Number.isFinite(frame.audioDb) ||
			!Number.isFinite(frame.syllabic) ||
			!Number.isFinite(frame.cluster)
		)
			return false
	}
	return true
}

type GateState = "idle" | "waiting" | "open"

/**
 * Window reset on carrier onset (design amendment 2026-10-23, revised): arming. An unquieted run
 * of at least this many 10 ms blocks (5 = 50 ms, one voice frame) arms the reset; the episode
 * also starts armed (stage-1 open or `reset()`), so a lead-in of any length is covered. Fades
 * inside an over of 10-40 ms (1-4 blocks) never arm it.
 */
export const EVIDENCE_ONSET_ARM_UNQUIETED_BLOCKS = 5
/**
 * Disarming: this many consecutive quieted blocks (5 = 50 ms) while armed end the onset. Until
 * then every quieted block that follows an unquieted one resets again, so a quieted flicker of
 * 1-4 blocks inside a noise lead-in cannot consume the reset.
 */
export const EVIDENCE_ONSET_DISARM_QUIETED_BLOCKS = 5

/**
 * Tone continuity (amendment A14, revision 2, 2026-10-24): on a tone latch the hang runs this
 * much longer while stage 1 is open: one CTCSS block, the time the reset tone stage needs to
 * sight a returning tone after a re-open (its first 500 ms block; a DCS word pair takes 342 ms).
 * Only a sighting of the latched tone or code restarts the hang; noise and other codes cannot.
 */
export const EVIDENCE_TONE_HANG_GRACE_MS = 500

/**
 * Tail mute (amendment A16, 2026-10-24): while latched, audio passes only with current carrier
 * evidence. A latched tone or code counts as current for this long after its last sighting: one
 * CTCSS hop (a continuing tone is sighted every 250 ms of audio; DCS word pairs every 171 ms)
 * plus 50 ms of margin. A stage-1 close ends it (the tone must be sighted again).
 */
export const EVIDENCE_TONE_PASS_MS = 300

/** Tone identity for renewal: CTCSS table index, or 1 000 + packed DCS reading. */
function toneKey(tone: Readonly<ToneReading>): number {
	return tone.kind === "ctcss" ? tone.index : 1_000 + tone.packed
}

export class EvidenceGate implements EvidenceGatePort {
	private readonly rate: number
	private readonly deviationHz: number
	/** Window resets on carrier onsets since the episode started (diagnostics only). */
	private windowResets = 0
	/** Voice path of the latch (A15, diagnostics only); null for a tone latch or none. */
	private latchedPath: "median" | "runs" | null = null
	/** A15: syllable-frame flags of the last `EVIDENCE_SYLLABLE_SPAN_FRAMES` frames (a ring). */
	private readonly syllableFlags = new Uint8Array(EVIDENCE_SYLLABLE_SPAN_FRAMES)
	private syllableHead = 0
	private syllableLen = 0
	private readonly modulation: "nfm" | "am"
	private readonly decimator = new PcmDecimator()
	private readonly meter: VoiceFrameMeter
	private readonly tone: ToneEvidence | null
	/** `msToSamples(CLOSE_GUARD_MS, rate)`: 5 000 at 25 kHz. */
	private readonly guardSamples: number
	/** `msToSamples(HANG_MS, rate)`: 37 500 at 25 kHz. */
	private readonly hangSamples: number
	/** `msToSamples(TONE_MIN_MS, rate)`: 18 750 at 25 kHz. */
	private readonly toneMinSamples: number
	/** `msToSamples(TONE_HANG_GRACE_MS, rate)`: 12 500 at 25 kHz. */
	private readonly toneGraceSamples: number
	/** `ToneEvidence.sightingCount` when last checked. */
	private toneSightings = 0
	private readonly frames: EvidenceFrame[] = []
	private readonly frameFinite = new Uint8Array(
		LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES,
	)
	private readonly stats: AnalogTrialStats
	private readonly quiet = new Uint8Array(
		LIVE_AUDIO_AUTO_SQUELCH_QUIET_WINDOW_BLOCKS,
	)
	private readonly toneScratch: ToneScratch = {
		ctcssHz: null,
		dcs: null,
		audioSeconds: 0,
	}
	/** Split-sample hold: f32le needs 4 bytes; at most 3 sit here. */
	private readonly hold = Buffer.alloc(4)
	private holdLen = 0
	private format: EvidencePcmFormat | null = null
	private internal: GateState = "idle"
	private latchedEvidence: LiveAudioAutoSquelchEvidence | null = null
	private latchedToneKey = -1
	private frameHead = 0
	private frameLen = 0
	private quietHead = 0
	private quietLen = 0
	private quietCount = 0
	/** Onset tracking (scalars, no per-block allocation); see the two constants above. */
	private onsetArmed = true
	private prevUnquieted = false
	private unquietedRun = 0
	private quietedRun = 0
	/** Input samples since waiting began (or since a reopen within the hang). */
	private audioSamples = 0
	/** A non-finite input went into the current decimation group. */
	private nonFiniteGroup = false
	private closing = false
	/**
	 * Carrier hang (amendment 2026-10-24, A14): PCM samples, open or closed, since the latched
	 * transmission last showed carrier evidence (PCM after a quieted block, or a sighting of its
	 * latched tone or code). The latch ends when this reaches `hangSamples` (plus
	 * `toneGraceSamples` on a tone latch while stage 1 is open); a stage-1 re-open does not
	 * restart it.
	 */
	private sinceCarrier = 0
	/** The last noted block was quieted and stage 1 has not closed since (A14). */
	private carrierNow = false
	/**
	 * A16: PCM samples that still pass after the last quieted block (the back-chain drain, as
	 * the close guard: `guardSamples`). Cleared by `closed()`, whose own guard takes over.
	 */
	private tailGuardLeft = 0
	/** A16: PCM samples since the latched tone or code was last sighted (or latched). */
	private sinceSighting = Number.MAX_SAFE_INTEGER
	/** `msToSamples(TONE_PASS_MS, rate)`. */
	private readonly tonePassSamples: number
	/** Close-guard bytes left in this closing episode (A2; A16 revision: never restarted). */
	private guardBytesLeft = 0
	/** A16 revision: fade-out samples after the guard (`EVIDENCE_FADE_OUT_MS`). */
	private readonly fadeSamples: number
	/** A16 revision: fade samples left after the tail guard (counts down like the guard). */
	private fadeLeft = 0
	/** A17: STE tone detector (NFM only). */
	private readonly ste: SteDetector | null
	/** A17 revision: input samples taken since construction (monotonic; dates the STE onset). */
	private inputCount = 0
	/** Input-sample index where the current decimation group began. */
	private groupStart = 0
	/** A17 revision: input-sample index of the STE onset (the qualifying block's start). */
	private steOnsetIndex = 0
	/** A16 revision: scratch for a split sample's scaled bytes, and a straddling sample's bytes. */
	private readonly splitScratch = Buffer.alloc(4)
	private readonly straddle = Buffer.alloc(4)
	/** Bytes of the current sample that lie in this `push` (< width for a split sample). */
	private curSampleBytes = 0
	/** A17: an STE tone ended this over: everything muted until stage 1 closes. */
	private steHold = false
	/** A17: one-shot STE tail for the owner (`takeSteBack`). */
	private steBack = 0
	/** A16 sample-accurate pass: the buffer and range of the current `push`. */
	private curPcm: Buffer | null = null
	private curWidth = 2
	private curFrom = 0
	private curFormat: EvidencePcmFormat = "s16le"
	private audibleEndByte = 0
	private wasOpenAtPush = false
	/** Byte offset of the first latch in the current `push`, or -1. */
	private latchAt = -1

	constructor(options: EvidenceGateOptions) {
		const rate = options.rate
		if (
			typeof rate !== "number" ||
			!Number.isFinite(rate) ||
			rate < AUDIO_TONE_RATE_HZ
		)
			throw new WaveKitError(
				"Evidence squelch needs a PCM rate of at least 8000 Hz",
				"EVIDENCE_RATE",
			)
		this.rate = rate
		this.deviationHz = options.deviationHz ?? 5_000
		this.modulation = options.modulation === "am" ? "am" : "nfm"
		this.meter =
			options.deviationHz === undefined
				? new VoiceFrameMeter({ gain: options.gain })
				: new VoiceFrameMeter({
						gain: options.gain,
						deviationHz: options.deviationHz,
					})
		this.tone = this.modulation === "nfm" ? new ToneEvidence() : null
		// A16 revision (2026-10-24): the back-chain lag plus one 10 ms block.
		const lag = options.drainLagSamples
		this.guardSamples =
			msToSamples(LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS, rate) +
			(typeof lag === "number" && Number.isFinite(lag) && lag > 0
				? Math.ceil(lag)
				: 0)
		this.fadeSamples = msToSamples(EVIDENCE_FADE_OUT_MS, rate)
		this.ste = this.modulation === "nfm" ? new SteDetector() : null

		this.hangSamples = msToSamples(LIVE_AUDIO_AUTO_SQUELCH_HANG_MS, rate)
		this.toneMinSamples = msToSamples(LIVE_AUDIO_AUTO_SQUELCH_TONE_MIN_MS, rate)
		this.toneGraceSamples = msToSamples(EVIDENCE_TONE_HANG_GRACE_MS, rate)
		this.tonePassSamples = msToSamples(EVIDENCE_TONE_PASS_MS, rate)
		for (let i = 0; i < LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES; i++)
			this.frames.push({
				carrierDb: 0,
				hfNoiseDb: 0,
				audioDb: 0,
				syllabic: 0,
				cluster: 0,
				sustained: 0,
			})
		this.stats = {
			mode: this.modulation,
			frames: this.frames,
			gapSamples: 0,
			floorDb: 0,
		}
		this.decimator.arm(rate)
	}

	get state(): "waiting" | "open" {
		return this.internal === "open" ? "open" : "waiting"
	}

	/**
	 * A16 tail mute: while latched, whether the next PCM may play. True while the last noted
	 * block was quieted, for the guard (back-chain lag + one 10 ms block) and the 10 ms fade of
	 * PCM after it, and for `EVIDENCE_TONE_PASS_MS` of PCM after a sighting of the latched tone or
	 * code (not across a stage-1 close). False while waiting and after an STE tone (A17).
	 */
	get passing(): boolean {
		return (
			this.internal === "open" &&
			!this.steHold &&
			(this.carrierNow ||
				this.toneRecent() ||
				this.tailGuardLeft > 0 ||
				this.fadeLeft > 0)
		)
	}

	get audibleEnd(): number {
		return this.audibleEndByte
	}

	get pushWasOpen(): boolean {
		return this.wasOpenAtPush
	}

	get muted(): boolean {
		return this.steHold
	}

	/** A17: input-sample index (since construction) of the last STE onset (diagnostic, tests). */
	get steOnset(): number {
		return this.steOnsetIndex
	}

	takeSteBack(): number {
		if (this.steBack === 0) return 0
		this.steBack = 0
		// Exact from the onset sample to the last sample taken, whatever the chunking.
		return Math.max(1, this.inputCount - this.steOnsetIndex)
	}

	/** Guard and fade back to full (current carrier evidence). */
	private refreshGuard(): void {
		this.tailGuardLeft = this.guardSamples
		this.fadeLeft = this.fadeSamples
	}

	private toneRecent(): boolean {
		return this.latchedToneKey >= 0 && this.sinceSighting < this.tonePassSamples
	}

	get evidence(): LiveAudioAutoSquelchEvidence | null {
		return this.internal === "open" ? this.latchedEvidence : null
	}

	noteBlock(carrier: boolean): number {
		const value = carrier === true ? 1 : 0
		// Window reset on carrier onset (design amendment 2026-10-23, revised): while armed, a
		// quieted block right after an unquieted one restarts the voice window (meter, frame
		// window, quiet ring), so the noise stage 1 was open on (power gate or hang) is never
		// judged with the over. Tracked from stage-1 open, also before the first PCM. The tone
		// stage, decimator and audio clock are kept: tones need no window and must not lose time.
		// Analysis reset and playback discard are separate (review 2026-10-23): the window resets
		// on every armed onset, but the held audio is discarded only after an unquieted run of at
		// least ARM blocks (a real noise lead-in), so an early 10-40 ms fade never drops speech.
		let flags = 0
		if (value === 1) {
			if (
				this.onsetArmed &&
				this.prevUnquieted &&
				this.internal === "waiting"
			) {
				this.resetVoiceWindow()
				this.windowResets += 1
				flags =
					this.unquietedRun >= EVIDENCE_ONSET_ARM_UNQUIETED_BLOCKS
						? EVIDENCE_NOTE_RESET | EVIDENCE_NOTE_DISCARD
						: EVIDENCE_NOTE_RESET
			}
			this.unquietedRun = 0
			if (this.onsetArmed) {
				this.quietedRun += 1
				if (this.quietedRun >= EVIDENCE_ONSET_DISARM_QUIETED_BLOCKS)
					this.onsetArmed = false
			}
		} else {
			this.quietedRun = 0
			if (this.unquietedRun < EVIDENCE_ONSET_ARM_UNQUIETED_BLOCKS)
				this.unquietedRun += 1
			if (this.unquietedRun >= EVIDENCE_ONSET_ARM_UNQUIETED_BLOCKS)
				this.onsetArmed = true
		}
		this.prevUnquieted = value === 0
		// A14: only carrier evidence keeps a latch alive; a bare stage-1 re-open does not.
		this.carrierNow = value === 1
		if (value === 1) this.refreshGuard()
		if (this.internal !== "waiting") return flags
		const ring = this.quiet
		if (this.quietLen === ring.length)
			this.quietCount -= ring[this.quietHead] ?? 0
		else this.quietLen += 1
		ring[this.quietHead] = value
		this.quietCount += value
		this.quietHead = (this.quietHead + 1) % ring.length
		return flags
	}

	push(
		pcm: Buffer,
		format: EvidencePcmFormat,
		start: number,
		end: number,
	): number {
		if (format !== "s16le" && format !== "f32le") {
			this.reset()
			this.format = null
			this.holdLen = 0
			return -1
		}
		const from = Math.max(0, Math.min(Math.floor(start) || 0, pcm.length))
		const to = Math.max(from, Math.min(Math.floor(end) || 0, pcm.length))
		if (format !== this.format) {
			this.format = format
			this.holdLen = 0
		}
		if (this.internal === "idle") {
			this.internal = "waiting"
			this.audioSamples = 0
		} else if (this.internal === "open" && this.closing) {
			// Reopen within the hang: latch kept, tone stage reset. The carrier hang keeps counting
			// (A14): a re-open without carrier evidence lets the latch expire. The reset is what
			// dates sightings (A14, revision 2): no CTCSS block or DCS word ever spans a
			// stage-1 close, so a sighting's evidence is at most one block (500 ms) of open audio
			// old when it completes.
			this.closing = false
			this.audioSamples = 0
			this.tone?.reset()
			this.ste?.reset()
			this.decimator.arm(this.rate)
			this.groupStart = this.inputCount
			this.nonFiniteGroup = false
		}
		this.closing = false
		this.latchAt = -1
		const width = format === "s16le" ? 2 : 4
		this.wasOpenAtPush = this.internal === "open"
		this.audibleEndByte = from
		this.curPcm = pcm
		this.curWidth = width
		this.curFrom = from
		this.curFormat = format
		this.curSampleBytes = width
		let offset = from
		if (this.holdLen > 0) {
			const need = width - this.holdLen
			if (to - from < need) {
				pcm.copy(this.hold, this.holdLen, from, to)
				this.holdLen += to - from
				return -1
			}
			pcm.copy(this.hold, this.holdLen, from, from + need)
			this.curSampleBytes = need
			this.takeSample(
				format === "s16le"
					? this.hold.readInt16LE(0) / 32_768
					: this.hold.readFloatLE(0),
				from + need,
			)
			this.holdLen = 0
			this.curSampleBytes = width
			offset = from + need
		}
		const last = to - ((to - offset) % width)
		if (format === "s16le") {
			for (let i = offset; i < last; i += 2)
				this.takeSample(pcm.readInt16LE(i) / 32_768, i + 2)
		} else {
			for (let i = offset; i < last; i += 4)
				this.takeSample(pcm.readFloatLE(i), i + 4)
		}
		if (last < to) {
			pcm.copy(this.hold, 0, last, to)
			this.holdLen = to - last
			// A split sample's first bytes take the decision its sample will get (A3): audible
			// when the gate still passes after the last whole sample.
			if (this.passing && this.audibleEndByte === last) this.audibleEndByte = to
		}
		this.curPcm = null
		return this.latchAt
	}

	closed(
		byteCount: number,
		format: EvidencePcmFormat,
		pcm?: Buffer,
		start?: number,
	): number {
		if (format !== "s16le" && format !== "f32le") {
			this.format = null
			this.holdLen = 0
			return 0
		}
		if (format !== this.format) {
			this.format = format
			this.holdLen = 0
		}
		const width = format === "s16le" ? 2 : 4
		const bytes =
			Number.isFinite(byteCount) && byteCount > 0 ? Math.floor(byteCount) : 0
		const heldBefore = this.holdLen
		const total = heldBefore + bytes
		const completed = Math.floor(total / width)
		// A straddling sample's first bytes, kept for the fade of a split sample (A16 revision);
		// without `pcm` the bytes are not inspected and a straddling sample reads zeros.
		const from = typeof start === "number" ? start : 0
		const straddle = this.straddle
		if (completed === 0) {
			if (pcm !== undefined) pcm.copy(this.hold, heldBefore, from, from + bytes)
			else this.hold.fill(0, heldBefore)
		} else {
			if (pcm !== undefined && heldBefore > 0)
				pcm.copy(this.hold, heldBefore, from, from + width - heldBefore)
			this.hold.copy(straddle, 0, 0, width)
			this.hold.fill(0)
			const rest = total % width
			if (pcm !== undefined && rest > 0)
				pcm.copy(this.hold, 0, from + bytes - rest, from + bytes)
		}
		this.holdLen = total % width
		const wasCarrier = this.carrierNow || this.toneRecent()
		this.carrierNow = false
		this.sinceSighting = Number.MAX_SAFE_INTEGER
		// A17: stage 1 closed after an STE tone: the over is over; a reopen starts fresh.
		if (this.steHold) {
			this.reset()
			return 0
		}
		if (this.internal !== "open") return 0
		if (!this.closing) {
			this.closing = true
			// A16 revision (2026-10-24): the guard on a close is what is left of the carrier guard
			// and its fade, never a fresh one (full only when the close follows carrier evidence).
			// A sample whose first bytes arrived while open is the first closed sample.
			if (wasCarrier) this.refreshGuard()
			this.guardBytesLeft = Math.max(
				0,
				(this.tailGuardLeft + this.fadeLeft) * width - heldBefore,
			)
		}
		const guard = bytes < this.guardBytesLeft ? bytes : this.guardBytesLeft
		this.guardBytesLeft -= guard
		// The counters advance per completed sample; the fade is applied in place (a straddling
		// sample: on its bytes in this call, its earlier bytes being queued already).
		const base = from - heldBefore
		for (let k = 0; k < completed; k++) {
			if (this.tailGuardLeft > 0) this.tailGuardLeft -= 1
			else if (this.fadeLeft > 0) {
				const gain = this.fadeLeft / (this.fadeSamples + 1)
				this.fadeLeft -= 1
				if (pcm === undefined) continue
				if (k === 0 && heldBefore > 0) {
					const value =
						format === "s16le"
							? straddle.readInt16LE(0) / 32_768
							: straddle.readFloatLE(0)
					this.writeSplit(
						pcm,
						from + width - heldBefore,
						width - heldBefore,
						value,
						gain,
					)
				} else scaleSample(pcm, base + k * width, format, gain)
			} else break
		}
		this.sinceCarrier += completed
		if (this.sinceCarrier >= this.hangSamples) this.reset()
		return guard
	}

	/**
	 * Writes the last `bytes` bytes of `value × gain` (current format) so they end at `end` in
	 * `pcm`: the part of a split sample that is still in reach.
	 */
	private writeSplit(
		pcm: Buffer,
		end: number,
		bytes: number,
		value: number,
		gain: number,
	): void {
		const scratch = this.splitScratch
		const width = this.format === "f32le" ? 4 : 2
		if (width === 2)
			scratch.writeInt16LE(
				Math.max(-32_768, Math.min(32_767, Math.round(value * 32_768 * gain))),
				0,
			)
		else scratch.writeFloatLE(value * gain, 0)
		if (end - bytes < 0 || end > pcm.length) return
		scratch.copy(pcm, end - bytes, width - bytes, width)
	}

	/** Voice meter, frame window and quiet ring back to empty (allocation-free). */
	private resetVoiceWindow(): void {
		this.syllableFlags.fill(0)
		this.syllableHead = 0
		this.syllableLen = 0
		this.meter.reset()
		this.frameHead = 0
		this.frameLen = 0
		this.frameFinite.fill(0)
		this.quiet.fill(0)
		this.quietHead = 0
		this.quietLen = 0
		this.quietCount = 0
	}

	/**
	 * The current voice window for the diagnostic status (DIAGNOSTIC AND UNSTABLE). Computed on
	 * demand (it allocates its medians); nothing is recorded per sample for it except the reset
	 * count. The verdict follows `judgeEvidence`'s order on the window as it stands.
	 */
	diagnostics(): LiveAudioAutoSquelchDiagnostics {
		const frames = this.frames.slice(0, this.frameLen)
		const median = (
			pick: (frame: AnalogTrialFrame) => number,
		): number | null => {
			const values = frames.map(pick)
			if (values.length === 0 || values.some(v => !Number.isFinite(v)))
				return null
			values.sort((a, b) => a - b)
			const mid = values.length >> 1
			return values.length % 2 === 1
				? (values[mid] ?? null)
				: ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2
		}
		const audioDb = median(f => f.audioDb)
		const syllabic = median(f => f.syllabic)
		const cluster = median(f => f.cluster)
		let finite = true
		for (let i = 0; i < this.frameLen; i++)
			if (this.frameFinite[i] !== 1) finite = false
		const noted = this.quietLen
		const quiet = this.quietCount
		const runs = this.spanRuns()
		const verdict: LiveAudioAutoSquelchDiagnostics["verdict"] =
			this.internal === "open"
				? "latched"
				: this.frameLen < this.frames.length
					? "window-filling"
					: !finite || audioDb === null || syllabic === null || cluster === null
						? "non-finite"
						: cluster >= ANALOG_TRIAL_DATA_SCORE
							? "data-like"
							: !(noted > 0 && quiet >= ANALOG_TRIAL_MIN_QUIET_FRACTION * noted)
								? "not-quiet"
								: syllabic < ANALOG_TRIAL_VOICE_INDEX
									? "low-syllabic"
									: audioDb >= ANALOG_TRIAL_AUDIO_MIN_DB
										? "voice-median"
										: runs >= EVIDENCE_SYLLABLE_RUNS
											? "voice-runs"
											: "low-audio"
		const round = (v: number | null, step: number): number | null =>
			v === null ? null : Math.round(v / step) * step
		return {
			verdict,
			frames: this.frameLen,
			audioDb: round(audioDb, 0.1),
			syllabic: round(syllabic, 0.001),
			cluster: round(cluster, 0.001),
			syllableRuns: runs,
			quietBlocks: quiet,
			notedBlocks: noted,
			windowResets: this.windowResets,
			...(this.internal === "open"
				? {
						path:
							this.latchedEvidence === "voice"
								? (this.latchedPath ?? "median")
								: ("tone" as const),
					}
				: {}),
			audioMs: Math.round((this.audioSamples * 1_000) / this.rate),
			deviationHz: this.deviationHz,
			...(this.steHold ? { ste: true as const } : {}),
		}
	}

	/** A15: syllable runs over the span ring, oldest first (at most 40 steps, no allocation). */
	private spanRuns(): number {
		const size = this.syllableFlags.length
		const first = (this.syllableHead - this.syllableLen + size) % size
		let runs = 0
		let length = 0
		for (let i = 0; i < this.syllableLen; i++) {
			if (this.syllableFlags[(first + i) % size] === 1) {
				length += 1
				if (length === EVIDENCE_SYLLABLE_RUN_FRAMES) runs += 1
			} else length = 0
		}
		return runs
	}

	reset(): void {
		this.windowResets = 0
		this.latchedPath = null
		this.syllableFlags.fill(0)
		this.syllableHead = 0
		this.syllableLen = 0
		this.onsetArmed = true
		this.prevUnquieted = false
		this.unquietedRun = 0
		this.quietedRun = 0
		this.internal = "idle"
		this.latchedEvidence = null
		this.latchedToneKey = -1
		this.meter.reset()
		this.tone?.reset()
		this.decimator.arm(this.rate)
		this.nonFiniteGroup = false
		this.frameHead = 0
		this.frameLen = 0
		this.frameFinite.fill(0)
		this.quiet.fill(0)
		this.quietHead = 0
		this.quietLen = 0
		this.quietCount = 0
		this.audioSamples = 0
		this.closing = false
		this.sinceCarrier = 0
		this.carrierNow = false
		this.tailGuardLeft = 0
		this.fadeLeft = 0
		this.sinceSighting = Number.MAX_SAFE_INTEGER
		this.steHold = false
		this.ste?.reset()
		this.groupStart = this.inputCount
		this.guardBytesLeft = 0
	}

	/** One input sample; `after` is the byte offset just past it. */
	private takeSample(sample: number, after: number): void {
		if (this.internal === "open" && !this.steHold) {
			// A16: per sample, pass with carrier evidence, then the guard, then the fade to zero.
			if (this.sinceSighting < Number.MAX_SAFE_INTEGER) this.sinceSighting += 1
			let gain = 1
			if (this.carrierNow || this.toneRecent()) this.refreshGuard()
			else if (this.tailGuardLeft > 0) this.tailGuardLeft -= 1
			else if (this.fadeLeft > 0) {
				gain = this.fadeLeft / (this.fadeSamples + 1)
				this.fadeLeft -= 1
			} else gain = 0
			const pcm = this.curPcm
			if (gain < 1 && pcm !== null) {
				const width = this.curWidth
				if (this.curSampleBytes >= width)
					scaleSample(pcm, after - width, this.curFormat, gain)
				else {
					// A16 revision: a split sample; its earlier bytes are already queued, so only the
					// bytes in this push get the scaled value (s16: the low byte keeps its value,
					// at most 255 LSB of error).
					this.writeSplit(pcm, after, this.curSampleBytes, sample, gain)
				}
			}
			if (gain > 0) this.audibleEndByte = after
			if (this.carrierNow) this.sinceCarrier = 0
			else if (
				++this.sinceCarrier >=
				this.hangSamples +
					(this.latchedToneKey >= 0 ? this.toneGraceSamples : 0)
			) {
				// A14: the hang ran out while stage 1 is open on something without carrier
				// evidence (a weak re-open): the latch ends and this audio earns its own evidence.
				this.reset()
				this.internal = "waiting"
			}
		}
		this.audioSamples += 1
		const index = this.inputCount
		this.inputCount += 1
		if (!Number.isFinite(sample)) this.nonFiniteGroup = true
		if (!this.decimator.take(sample)) return
		const value = this.decimator.output
		const groupFirst = this.groupStart
		this.groupStart = index + 1
		const nonFinite = this.nonFiniteGroup
		this.nonFiniteGroup = false
		// A17: an STE tone ends the over: retroactive mute from its onset, the latch ends. While
		// held, a further STE changes nothing; fresh evidence still latches (not terminal).
		if (
			this.ste !== null &&
			this.ste.push(value, groupFirst) &&
			!this.steHold
		) {
			this.onSte()
			return
		}
		const tone = this.tone
		if (tone !== null) {
			tone.push(value)
			const sightings = tone.sightingCount
			if (sightings !== this.toneSightings) {
				this.toneSightings = sightings
				// A14: a sighting of the latched tone or code is carrier evidence of this over.
				if (
					this.internal === "open" &&
					tone.sightingKey === this.latchedToneKey
				) {
					this.sinceCarrier = 0
					this.sinceSighting = 0
				}
			}
			const reading = tone.current()
			if (reading !== null && this.audioSamples >= this.toneMinSamples)
				this.observeTone(reading, after)
		}
		if (this.internal !== "waiting") return
		// The decimator counts a non-finite input as 0; the meter fails that frame closed.
		if (!this.meter.push(nonFinite ? NaN : value)) return
		this.recordFrame()
		if (this.frameLen < this.frames.length) return
		let finite = true
		for (let i = 0; i < this.frameFinite.length; i++)
			if (this.frameFinite[i] !== 1) finite = false
		const runs = this.spanRuns()
		const verdict = judgeEvidence({
			modulation: this.modulation,
			stats: this.stats,
			tone: tone?.current() ?? null,
			audioMs: (this.audioSamples * 1_000) / this.rate,
			quietBlocks: this.quietCount,
			notedBlocks: this.quietLen,
			framesFinite: finite,
			syllableRuns: runs,
		})
		if (verdict === "voice")
			this.latchedPath = voicePath(this.stats, runs) ?? "median"
		if (verdict !== null) this.latch(verdict, -1, after)
	}

	/** A17: an STE block just completed: mute from its onset (at most 50 ms after the tone's). */
	private onSte(): void {
		const wasOpen = this.internal === "open"
		const onset = this.ste?.onsetIndex ?? this.inputCount
		this.reset()
		this.internal = "waiting"
		this.steHold = true
		this.steOnsetIndex = onset
		this.steBack = 1
		this.wasOpenAtPush = this.wasOpenAtPush || wasOpen
	}

	private observeTone(reading: Readonly<ToneReading>, after: number): void {
		const key = toneKey(reading)
		if (this.internal === "open" && key === this.latchedToneKey) return
		const kind = toneKind(
			this.modulation,
			reading,
			(this.audioSamples * 1_000) / this.rate,
			this.toneScratch,
		)
		if (kind === null) return
		if (this.internal === "open") {
			// Renewal: a different standard tone while latched is new evidence (its own label).
			this.latchedEvidence = kind
			this.latchedToneKey = key
			this.sinceCarrier = 0
			this.sinceSighting = 0
			return
		}
		this.latch(kind, key, after)
	}

	private latch(
		evidence: LiveAudioAutoSquelchEvidence,
		key: number,
		after: number,
	): void {
		this.internal = "open"
		this.latchedEvidence = evidence
		this.latchedToneKey = key
		// A17 revision: fresh evidence after a (possibly false) STE ends the hold.
		this.steHold = false
		this.sinceCarrier = 0
		// A16: the latch is evidence at this sample (a voice latch needed quieted blocks).
		this.sinceSighting = 0
		this.refreshGuard()
		if (this.latchAt < 0) this.latchAt = after
	}

	private recordFrame(): void {
		const source = this.meter.frame
		const target = this.frames[this.frameHead]
		if (target === undefined) return
		target.audioDb = source.audioDb
		target.syllabic = source.syllabic
		target.cluster = source.cluster
		target.sustained = source.sustained
		this.frameFinite[this.frameHead] = source.finite ? 1 : 0
		this.syllableFlags[this.syllableHead] =
			source.finite && isSyllableFrame(target) ? 1 : 0
		this.syllableHead = (this.syllableHead + 1) % this.syllableFlags.length
		if (this.syllableLen < this.syllableFlags.length) this.syllableLen += 1
		this.frameHead = (this.frameHead + 1) % this.frames.length
		if (this.frameLen < this.frames.length) this.frameLen += 1
	}
}

/** Scales one whole sample in place (A16 fade and mute). */
function scaleSample(
	pcm: Buffer,
	at: number,
	format: EvidencePcmFormat,
	gain: number,
): void {
	if (format === "s16le") {
		if (at < 0 || at + 2 > pcm.length) return
		pcm.writeInt16LE(Math.round(pcm.readInt16LE(at) * gain), at)
	} else {
		if (at < 0 || at + 4 > pcm.length) return
		pcm.writeFloatLE(pcm.readFloatLE(at) * gain, at)
	}
}
