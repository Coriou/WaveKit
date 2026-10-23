/**
 * Evidence gate (design, EvidenceGate; requirements 1.2-1.5): stage 2 of the auto squelch.
 * While stage 1 is open, the PCM is decimated to 8 kHz (`PcmDecimator`, as the tone squelch
 * gate) and fed to a `VoiceFrameMeter` and, on NFM, to `ToneEvidence`. The gate latches on a
 * qualified standard tone (NFM, after `TONE_MIN_MS` of audio) or on a voice judgement over the
 * last `VOICE_FRAMES` frames with enough quiet carrier blocks, and holds through
 * `HANG_MS` of stage-1-closed PCM.
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
import type { LiveAudioAutoSquelchEvidence } from "@wavekit/api-types"
import { WaveKitError } from "../../utils/errors.js"
import {
	AUDIO_TONE_RATE_HZ,
	PcmDecimator,
} from "../audio-tones/tone-detector.js"
import { dataLike, isVoice, toneQualified } from "../scanner/analog-trial.js"
import { ANALOG_TRIAL_MIN_QUIET_FRACTION } from "../scanner/scanner-redesign-contract.js"
import type {
	AnalogTrialFrame,
	AnalogTrialStats,
	AnalogTrialTones,
} from "../scanner/scanner-redesign-contract.js"
import {
	EVIDENCE_NOTE_DISCARD,
	EVIDENCE_NOTE_RESET,
	msToSamples,
} from "./contract.js"
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
 * → "voice", else null. AM never takes step 1.
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
	return isVoice(input.stats) ? "voice" : null
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

/** Tone identity for renewal: CTCSS table index, or 1 000 + packed DCS reading. */
function toneKey(tone: Readonly<ToneReading>): number {
	return tone.kind === "ctcss" ? tone.index : 1_000 + tone.packed
}

export class EvidenceGate implements EvidenceGatePort {
	private readonly rate: number
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
	private readonly frames: AnalogTrialFrame[] = []
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
	private closedSamples = 0
	private guardBytesLeft = 0
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
		this.modulation = options.modulation === "am" ? "am" : "nfm"
		this.meter = new VoiceFrameMeter({ gain: options.gain })
		this.tone = this.modulation === "nfm" ? new ToneEvidence() : null
		this.guardSamples = msToSamples(
			LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS,
			rate,
		)
		this.hangSamples = msToSamples(LIVE_AUDIO_AUTO_SQUELCH_HANG_MS, rate)
		this.toneMinSamples = msToSamples(LIVE_AUDIO_AUTO_SQUELCH_TONE_MIN_MS, rate)
		for (let i = 0; i < LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES; i++)
			this.frames.push({
				carrierDb: 0,
				hfNoiseDb: 0,
				audioDb: 0,
				syllabic: 0,
				cluster: 0,
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
			// Reopen within the hang: latch kept, closed counter and tone stage reset.
			this.closing = false
			this.closedSamples = 0
			this.audioSamples = 0
			this.tone?.reset()
			this.decimator.arm(this.rate)
			this.nonFiniteGroup = false
		}
		this.closing = false
		this.latchAt = -1
		const width = format === "s16le" ? 2 : 4
		let offset = from
		if (this.holdLen > 0) {
			const need = width - this.holdLen
			if (to - from < need) {
				pcm.copy(this.hold, this.holdLen, from, to)
				this.holdLen += to - from
				return -1
			}
			pcm.copy(this.hold, this.holdLen, from, from + need)
			this.takeSample(
				format === "s16le"
					? this.hold.readInt16LE(0) / 32_768
					: this.hold.readFloatLE(0),
				from + need,
			)
			this.holdLen = 0
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
		}
		return this.latchAt
	}

	closed(byteCount: number, format: EvidencePcmFormat): number {
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
		// The bytes are not inspected: a straddling sample reads zeros for its skipped bytes.
		this.hold.fill(0)
		this.holdLen = total % width
		if (this.internal !== "open") return 0
		if (!this.closing) {
			this.closing = true
			this.closedSamples = 0
			// A sample whose first bytes arrived while open is the first closed sample.
			this.guardBytesLeft = Math.max(0, this.guardSamples * width - heldBefore)
		}
		const guard = bytes < this.guardBytesLeft ? bytes : this.guardBytesLeft
		this.guardBytesLeft -= guard
		this.closedSamples += completed
		if (this.closedSamples >= this.hangSamples) this.reset()
		return guard
	}

	/** Voice meter, frame window and quiet ring back to empty (allocation-free). */
	private resetVoiceWindow(): void {
		this.meter.reset()
		this.frameHead = 0
		this.frameLen = 0
		this.frameFinite.fill(0)
		this.quiet.fill(0)
		this.quietHead = 0
		this.quietLen = 0
		this.quietCount = 0
	}

	reset(): void {
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
		this.closedSamples = 0
		this.guardBytesLeft = 0
	}

	/** One input sample; `after` is the byte offset just past it. */
	private takeSample(sample: number, after: number): void {
		this.audioSamples += 1
		if (!Number.isFinite(sample)) this.nonFiniteGroup = true
		if (!this.decimator.take(sample)) return
		const value = this.decimator.output
		const nonFinite = this.nonFiniteGroup
		this.nonFiniteGroup = false
		const tone = this.tone
		if (tone !== null) {
			tone.push(value)
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
		const verdict = judgeEvidence({
			modulation: this.modulation,
			stats: this.stats,
			tone: tone?.current() ?? null,
			audioMs: (this.audioSamples * 1_000) / this.rate,
			quietBlocks: this.quietCount,
			notedBlocks: this.quietLen,
			framesFinite: finite,
		})
		if (verdict !== null) this.latch(verdict, -1, after)
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
			// Renewal: a different standard tone while latched.
			this.latchedEvidence = kind
			this.latchedToneKey = key
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
		if (this.latchAt < 0) this.latchAt = after
	}

	private recordFrame(): void {
		const source = this.meter.frame
		const target = this.frames[this.frameHead]
		if (target === undefined) return
		target.audioDb = source.audioDb
		target.syllabic = source.syllabic
		target.cluster = source.cluster
		this.frameFinite[this.frameHead] = source.finite ? 1 : 0
		this.frameHead = (this.frameHead + 1) % this.frames.length
		if (this.frameLen < this.frames.length) this.frameLen += 1
	}
}
