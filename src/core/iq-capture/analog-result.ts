/**
 * Untrusted analog-trial result (WG12 req 4.5, 5.4). The replay queue and
 * `replayEvidenceCalls` both judge through this schema, so a malformed
 * `heard` or `decoded` cannot be stored or recorded as a positive outcome.
 * Any `error`, or an outcome the classifier would not produce, becomes
 * `cancelled`. `unavailable` is the one error that becomes `unsupported`.
 * The attached result is omitted so nothing positive leaks.
 */
import { DCS_STANDARD_CODES } from "@wavekit/api-types"
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
 * The runner's value is untrusted. Any `error` becomes `cancelled`, except
 * `unavailable` (no `openAnalyze`, or no runner), which is `unsupported`.
 * `analyze-failed` (timeout, error event, malformed line, audio mismatch,
 * tone-detector throw) and `capture-gone` are `cancelled`. `analog` is null
 * in every rejected case.
 *
 * Every other outcome needs non-null stats, `stats.mode` equal to the result
 * mode, that mode equal to `requestedMode` when the trial named one, and
 * `classifyAnalogTrial` agreeing. Otherwise `cancelled`, so digital trials
 * still run and nothing positive is recorded.
 *
 * `voice` on the attached result is `isVoice(stats)`.
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
		case "unavailable":
			return { outcome: "unsupported", analog: null }
		case "cancelled":
		case "capture-gone":
		case "analyze-failed":
			return CANCELLED_ANALOG
		default:
			return CANCELLED_ANALOG
	}
	if (!outcomeAgrees(parsed, requestedMode)) return CANCELLED_ANALOG
	return { outcome: parsed.outcome, analog: copyAnalog(parsed) }
}

/**
 * A stored outcome has to be the one the classifier would return, in the
 * mode the trial asked for. Null stats agree with nothing.
 */
function outcomeAgrees(
	parsed: ParsedAnalog,
	requestedMode: AnalogTrialMode | undefined,
): boolean {
	const stats = parsed.stats
	if (stats === null) return false
	if (stats.mode !== parsed.mode) return false
	if (requestedMode !== undefined && parsed.mode !== requestedMode) return false
	return classified(stats, parsed.tones) === parsed.outcome
}

/** `voice` is the statistics, not the claim. Null stats are not voice. */
function voiceFromStats(stats: AnalogTrialStats | null): boolean {
	if (stats === null) return false
	return isVoice(stats)
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
