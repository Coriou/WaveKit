/**
 * Analog replay trial decision (scanner redesign requirement 5.4). Pure: the
 * outcome is a function of the statistics and the tone result, using the
 * thresholds pinned in `scanner-redesign-contract.ts`.
 *
 * Inputs are untrusted. A tone counts only when it is a known CTCSS frequency
 * or a standard DCS code and the audio has lasted the WG2/WG6 minimum. A
 * non-finite statistic fails that frame closed: the outcome is `no-sync`,
 * never `heard` or `decoded`.
 */
import {
	DCS_MIN_AUDIO_SECONDS,
	DCS_STANDARD_CODES,
	type AnalogTransmissionDcs,
} from "@wavekit/api-types"
import { isCtcssToneHz } from "../audio-tones/ctcss.js"
import {
	ANALOG_TRIAL_AM_CARRIER_DB,
	ANALOG_TRIAL_AUDIO_MIN_DB,
	ANALOG_TRIAL_DATA_SCORE,
	ANALOG_TRIAL_MIN_QUIET_FRACTION,
	ANALOG_TRIAL_QUIETING_DB,
	ANALOG_TRIAL_VOICE_INDEX,
	type AnalogTrialFrame,
	type AnalogTrialOutcome,
	type AnalogTrialStats,
	type AnalogTrialTones,
} from "./scanner-redesign-contract.js"

const DCS_CODES: ReadonlySet<string> = new Set(DCS_STANDARD_CODES)

/**
 * Voice-like modulation: median syllabic index and median audio power both
 * meet the contract. Empty statistics, or any non-finite value in either
 * series, are not voice.
 */
export function isVoice(stats: AnalogTrialStats): boolean {
	const frames = framesOf(stats)
	if (frames === null || frames.length === 0) return false
	const syllabic = median(frames.map(frame => frame?.syllabic))
	const audio = median(frames.map(frame => frame?.audioDb))
	return (
		syllabic !== null &&
		audio !== null &&
		syllabic >= ANALOG_TRIAL_VOICE_INDEX &&
		audio >= ANALOG_TRIAL_AUDIO_MIN_DB
	)
}

/**
 * Consecutive syllabic frames one analog trial must hold for the recorder's no-voice channel rule
 * to count it as heard whatever its own outcome (recording-verdict.ts noVoiceChannel): 3, i.e. an
 * unbroken 150 ms of speech-like envelope (ANALOG_TRIAL_FRAME_MS = 50) in at most 80 frames (4 s),
 * as a syllable produces. A run, not a count: open-squelch noise scatters single frames over the
 * index, and one such trial would end the rule for the channel for good (the heard count never
 * decays). No audio-level condition: the weak, distant repeater this protects is low-audio.
 */
export const ANALOG_TRIAL_SYLLABIC_RUN_FRAMES = 3

/**
 * The trial's longest run of consecutive frames whose syllabic index meets
 * ANALOG_TRIAL_VOICE_INDEX (at most ANALOG_TRIAL_MAX_FRAMES). Missing statistics count nothing; a
 * missing, non-number or non-finite frame breaks the run.
 */
export function syllabicRun(
	stats: AnalogTrialStats | null | undefined,
): number {
	const frames = framesOf(stats)
	if (frames === null) return 0
	let run = 0
	let longest = 0
	for (const frame of frames) {
		const s = (frame as { syllabic?: unknown } | null | undefined)?.syllabic
		if (
			typeof s === "number" &&
			Number.isFinite(s) &&
			s >= ANALOG_TRIAL_VOICE_INDEX
		) {
			run += 1
			if (run > longest) longest = run
		} else run = 0
	}
	return longest
}

/** The trial held ANALOG_TRIAL_SYLLABIC_RUN_FRAMES consecutive syllabic frames or more (syllabicRun). */
export function syllabicHeard(
	stats: AnalogTrialStats | null | undefined,
): boolean {
	return syllabicRun(stats) >= ANALOG_TRIAL_SYLLABIC_RUN_FRAMES
}

/**
 * Decision order: a qualified CTCSS tone or DCS code, then a discrete discriminator, then FM quieting (AM:
 * carrier above the capture floor) with voice, otherwise a bare carrier. No frames, a malformed tone, or a
 * non-finite statistic is `no-sync`.
 */
export function classifyAnalogTrial(
	stats: AnalogTrialStats,
	tones: AnalogTrialTones,
): AnalogTrialOutcome {
	const frames = framesOf(stats)
	if (frames === null) return "no-sync"
	if (frames.some(frame => !frameFinite(frame))) return "no-sync"
	if (stats.mode !== "nfm" && stats.mode !== "am") return "no-sync"
	if (toneQualified(tones)) return "decoded"
	if (frames.length === 0) return "no-sync"
	if (dataLike(stats)) return "data-like"
	if (!quietEnough(stats, frames)) return "no-sync"
	if (isVoice(stats)) return "heard"
	return "carrier-only"
}

/**
 * A discrete discriminator: the median cluster score meets `ANALOG_TRIAL_DATA_SCORE`.
 * Missing frames or any non-finite cluster score is not data-like.
 */
export function dataLike(stats: AnalogTrialStats): boolean {
	const frames = framesOf(stats)
	if (frames === null || frames.length === 0) return false
	const cluster = median(frames.map(frame => frame?.cluster))
	return cluster !== null && cluster >= ANALOG_TRIAL_DATA_SCORE
}

/**
 * At least `ANALOG_TRIAL_MIN_QUIET_FRACTION` of the frames. The fraction is 1/2,
 * so an exact half passes (1 of 2, 50 of 100) and 49 of 100 does not.
 */
function quietEnough(
	stats: AnalogTrialStats,
	frames: readonly AnalogTrialFrame[],
): boolean {
	let quiet = 0
	for (const frame of frames) if (frameQuieted(stats, frame)) quiet += 1
	return quiet >= frames.length * ANALOG_TRIAL_MIN_QUIET_FRACTION
}

/**
 * `db_over` reports −160 for zero power. A frame at or below this floor is
 * silence (or an underflowed product), not quieting and not a carrier.
 */
const ANALOG_SILENCE_DB = -159.9

function frameQuieted(
	stats: AnalogTrialStats,
	frame: AnalogTrialFrame,
): boolean {
	if (
		frame.carrierDb <= ANALOG_SILENCE_DB ||
		frame.hfNoiseDb <= ANALOG_SILENCE_DB
	)
		return false
	if (stats.mode === "am") {
		if (!Number.isFinite(stats.floorDb) || !Number.isFinite(frame.carrierDb))
			return false
		return frame.carrierDb >= stats.floorDb + ANALOG_TRIAL_AM_CARRIER_DB
	}
	if (!Number.isFinite(frame.hfNoiseDb)) return false
	return -frame.hfNoiseDb >= ANALOG_TRIAL_QUIETING_DB
}

function framesOf(
	stats: AnalogTrialStats | null | undefined,
): readonly AnalogTrialFrame[] | null {
	if (stats === null || stats === undefined || typeof stats !== "object")
		return null
	const frames = (stats as { frames?: unknown }).frames
	if (!Array.isArray(frames)) return null
	return frames as readonly AnalogTrialFrame[]
}

function frameFinite(frame: AnalogTrialFrame | null | undefined): boolean {
	if (frame === null || frame === undefined || typeof frame !== "object")
		return false
	return (
		Number.isFinite(frame.carrierDb) &&
		Number.isFinite(frame.hfNoiseDb) &&
		Number.isFinite(frame.audioDb) &&
		Number.isFinite(frame.syllabic) &&
		Number.isFinite(frame.cluster)
	)
}

/**
 * CTCSS and DCS both need `DCS_MIN_AUDIO_SECONDS` (0.75 s, the WG2 CTCSS
 * minimum and the WG6 DCS minimum). The tone must be one of the 50 standard
 * frequencies, or the code one of `DCS_STANDARD_CODES` with a polarity.
 */
export function toneQualified(
	tones: AnalogTrialTones | null | undefined,
): boolean {
	if (tones === null || tones === undefined || typeof tones !== "object")
		return false
	const seconds = (tones as { audioSeconds?: unknown }).audioSeconds
	if (
		typeof seconds !== "number" ||
		!Number.isFinite(seconds) ||
		seconds < DCS_MIN_AUDIO_SECONDS
	)
		return false
	const hz = (tones as { ctcssHz?: unknown }).ctcssHz
	if (typeof hz === "number" && Number.isFinite(hz) && isCtcssToneHz(hz))
		return true
	return dcsQualified((tones as { dcs?: unknown }).dcs)
}

function dcsQualified(dcs: unknown): dcs is AnalogTransmissionDcs {
	if (dcs === null || dcs === undefined || typeof dcs !== "object") return false
	const rec = dcs as { code?: unknown; polarity?: unknown }
	if (typeof rec.code !== "string" || !DCS_CODES.has(rec.code)) return false
	return rec.polarity === "normal" || rec.polarity === "inverted"
}

/**
 * Middle value after sorting. An even count averages the two central values.
 * Any non-finite member fails the median closed (`null`), so a `NaN` cannot
 * sort into a passing voice or data score.
 */
function median(values: readonly unknown[]): number | null {
	const nums: number[] = []
	for (const value of values) {
		if (typeof value !== "number" || !Number.isFinite(value)) return null
		nums.push(value)
	}
	if (nums.length === 0) return null
	nums.sort((a, b) => a - b)
	const mid = nums.length >> 1
	if (nums.length % 2 === 1) return nums[mid] ?? null
	const left = nums[mid - 1]
	const right = nums[mid]
	if (left === undefined || right === undefined) return null
	const mean = (left + right) / 2
	return Number.isFinite(mean) ? mean : null
}
