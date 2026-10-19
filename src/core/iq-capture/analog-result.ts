/**
 * Untrusted analog-trial result (WG12 req 4.5, 5.4). The replay queue and
 * `replayEvidenceCalls` both judge through this schema, so a malformed
 * `heard` or `decoded` cannot be stored or recorded as a positive outcome.
 * Any `error`, or a positive outcome the classifier would not produce,
 * becomes `cancelled` (or `unsupported` for the contract's unavailable
 * errors). The attached result is omitted so nothing positive leaks.
 */
import {
	DCS_BIT_RATE_BPS,
	DCS_MIN_AUDIO_SECONDS,
	DCS_MIN_WORDS,
	DCS_STANDARD_CODES,
} from "@wavekit/api-types"
import { z } from "zod"
import { isCtcssToneHz } from "../audio-tones/ctcss.js"
import { classifyAnalogTrial, isVoice } from "../scanner/analog-trial.js"
import type { IqReplayTrialOutcome } from "../scanner/iq-capture-contract.js"
import {
	ANALOG_TRIAL_MAX_FRAMES,
	type AnalogTrialMode,
	type AnalogTrialOutcome,
	type AnalogTrialResult,
	type AnalogTrialStats,
	type AnalogTrialTones,
} from "../scanner/scanner-redesign-contract.js"

const DCS_CODES: ReadonlySet<string> = new Set(DCS_STANDARD_CODES)
const finiteNumber = z.number().finite()
/** One DCS word is 23 bits. Three words is the WG6 confirmation. */
const DCS_WORD_BITS = 23
/**
 * CTCSS needs `DCS_MIN_AUDIO_SECONDS`. DCS needs that and enough audio to
 * have held `DCS_MIN_WORDS` words at `DCS_BIT_RATE_BPS`. The word time is
 * shorter than 0.75 s, so both gates are 0.75 s today.
 */
const MIN_DCS_AUDIO_SECONDS = Math.max(
	DCS_MIN_AUDIO_SECONDS,
	(DCS_WORD_BITS * DCS_MIN_WORDS) / DCS_BIT_RATE_BPS,
)

const analogFrameSchema = z
	.object({
		carrierDb: finiteNumber,
		hfNoiseDb: finiteNumber,
		audioDb: finiteNumber,
		syllabic: finiteNumber,
		cluster: finiteNumber,
	})
	.strict()

const analogStatsSchema = z
	.object({
		mode: z.enum(["nfm", "am"]),
		frames: z.array(analogFrameSchema).max(ANALOG_TRIAL_MAX_FRAMES),
		gapSamples: z.number().int().nonnegative(),
		floorDb: finiteNumber,
	})
	.strict()

const analogTonesSchema = z
	.object({
		ctcssHz: finiteNumber.refine(hz => isCtcssToneHz(hz)).nullable(),
		dcs: z
			.object({
				code: z.string().refine(code => DCS_CODES.has(code)),
				polarity: z.enum(["normal", "inverted"]),
			})
			.strict()
			.nullable(),
		audioSeconds: finiteNumber.nonnegative(),
	})
	.strict()

/** Strict shape of one analog trial result. Getters that throw fail the parse. */
export const analogResultSchema = z
	.object({
		outcome: z.enum([
			"decoded",
			"heard",
			"data-like",
			"carrier-only",
			"no-sync",
		]),
		mode: z.enum(["nfm", "am"]),
		voice: z.boolean(),
		tones: analogTonesSchema,
		stats: analogStatsSchema.nullable(),
		error: z
			.enum(["capture-gone", "analyze-failed", "cancelled", "unavailable"])
			.optional(),
	})
	.strict()

type ParsedAnalog = z.infer<typeof analogResultSchema>

const CANCELLED_ANALOG = {
	outcome: "cancelled" as const,
	analog: null,
}

export interface JudgedAnalog {
	outcome: IqReplayTrialOutcome
	/** Present only when the outcome may be recorded. Never a rejected positive. */
	analog: AnalogTrialResult | null
}

/**
 * The runner's value is untrusted. Malformed fields, any `error`, or a
 * positive the statistics would not produce become `cancelled`, or
 * `unsupported` for `unavailable` / `analyze-failed`. `analog` is null in
 * every rejected case.
 *
 * `decoded` needs a qualified CTCSS tone or DCS code and at least the WG2/WG6
 * audio minimum (DCS also the three-word time). `heard` needs `voice`, a
 * non-empty frame list, `stats.mode` equal to the trial `mode`, and
 * `classifyAnalogTrial` agreeing. Anything else positive is cancelled.
 *
 * `voice` on the attached result is `isVoice(stats)`. A claim of `voice: true`
 * with null stats, or with stats that are not voice, is stored as false.
 * `requestedMode` is the mode the trial asked for. A positive result in any
 * other mode is `cancelled` with no attached result, so digital trials still
 * run and nothing positive is recorded.
 */
export function judgeAnalogResult(
	raw: unknown,
	requestedMode?: AnalogTrialMode,
): JudgedAnalog {
	let parsed: ParsedAnalog
	try {
		const result = analogResultSchema.safeParse(raw)
		if (!result.success) return CANCELLED_ANALOG
		parsed = result.data
	} catch {
		return CANCELLED_ANALOG
	}
	switch (parsed.error) {
		case undefined:
			break
		case "cancelled":
		case "capture-gone":
			return CANCELLED_ANALOG
		case "unavailable":
		case "analyze-failed":
			return { outcome: "unsupported", analog: null }
		default:
			return CANCELLED_ANALOG
	}
	if (parsed.outcome === "decoded" || parsed.outcome === "heard") {
		if (!positiveAgrees(parsed)) return CANCELLED_ANALOG
		if (requestedMode !== undefined && parsed.mode !== requestedMode)
			return CANCELLED_ANALOG
	}
	return { outcome: parsed.outcome, analog: copyAnalog(parsed) }
}

/**
 * A positive outcome has to be one the classifier would return for these
 * stats and tones, and the statistics' mode has to be the mode the trial
 * asked for.
 */
function positiveAgrees(parsed: ParsedAnalog): boolean {
	if (parsed.stats !== null && parsed.stats.mode !== parsed.mode) return false
	if (parsed.outcome === "decoded") return decodedTone(parsed.tones)
	if (
		!parsed.voice ||
		!voiceFromStats(parsed.stats) ||
		parsed.stats === null ||
		parsed.stats.frames.length === 0
	)
		return false
	return classified(parsed.stats, parsed.tones) === "heard"
}

/** `voice` is the statistics, not the claim. Null stats are not voice. */
function voiceFromStats(stats: AnalogTrialStats | null): boolean {
	if (stats === null) return false
	return isVoice(stats)
}

function decodedTone(tones: AnalogTrialTones): boolean {
	const seconds = tones.audioSeconds
	if (tones.ctcssHz !== null && seconds >= DCS_MIN_AUDIO_SECONDS) return true
	return tones.dcs !== null && seconds >= MIN_DCS_AUDIO_SECONDS
}

function classified(
	stats: AnalogTrialStats,
	tones: AnalogTrialTones,
): AnalogTrialOutcome | null {
	try {
		return classifyAnalogTrial(stats, tones)
	} catch {
		return null
	}
}

function copyAnalog(parsed: ParsedAnalog): AnalogTrialResult {
	const stats = parsed.stats
	return {
		outcome: parsed.outcome,
		mode: parsed.mode,
		voice: voiceFromStats(stats),
		tones: {
			ctcssHz: parsed.tones.ctcssHz,
			dcs: parsed.tones.dcs,
			audioSeconds: parsed.tones.audioSeconds,
		},
		stats: stats
			? {
					mode: stats.mode,
					frames: stats.frames,
					gapSamples: stats.gapSamples,
					floorDb: stats.floorDb,
				}
			: null,
	}
}
