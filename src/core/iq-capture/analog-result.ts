/**
 * Untrusted analog-trial result (WG12 req 4.5, 5.4). The replay queue and
 * `replayEvidenceCalls` both judge through this schema, so a malformed
 * `heard` or `decoded` cannot be stored or recorded as a positive outcome.
 * Any `error`, a `decoded` without a qualified tone or DCS, or a `heard`
 * without stats becomes `cancelled` (or `unsupported` for the contract's
 * unavailable errors). The attached result is omitted so nothing positive leaks.
 */
import { DCS_STANDARD_CODES } from "@wavekit/api-types"
import { z } from "zod"
import { isCtcssToneHz } from "../audio-tones/ctcss.js"
import type { IqReplayTrialOutcome } from "../scanner/iq-capture-contract.js"
import {
	ANALOG_TRIAL_MAX_FRAMES,
	type AnalogTrialResult,
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
 * The runner's value is untrusted. Malformed fields (missing tones or stats,
 * non-finite numbers, a throwing getter), any `error`, a `decoded` without a
 * qualified tone or DCS, or a `heard` without stats become `cancelled`, or
 * `unsupported` for `unavailable` / `analyze-failed`. `analog` is null in
 * every rejected case.
 */
export function judgeAnalogResult(raw: unknown): JudgedAnalog {
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
	if (parsed.outcome === "decoded" && !qualifiedTone(parsed))
		return CANCELLED_ANALOG
	if (parsed.outcome === "heard" && parsed.stats === null)
		return CANCELLED_ANALOG
	return { outcome: parsed.outcome, analog: copyAnalog(parsed) }
}

function qualifiedTone(parsed: ParsedAnalog): boolean {
	return parsed.tones.ctcssHz !== null || parsed.tones.dcs !== null
}

function copyAnalog(parsed: ParsedAnalog): AnalogTrialResult {
	const stats = parsed.stats
	return {
		outcome: parsed.outcome,
		mode: parsed.mode,
		voice: parsed.voice,
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
