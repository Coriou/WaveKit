/**
 * Scanner truth scorecard: the label format and its loader. A truth directory holds one
 * `<name>.truth.json` per capture (labels are kept apart from the captures, which stay
 * read-only); each names its CU8 capture, the capture's tuning, the labelled transmissions
 * (truth intervals) and the decodes the live system recorded with their offsets.
 *
 * Times are ms from the capture's first sample. Labels come from an offline decode, a person
 * listening, or a repeater list (`source`); only `confirmed` intervals are scored unless the
 * caller asks for every interval. Everything read here is validated (Zod): a malformed file
 * fails the run with its path and the first issue, it never scores as empty.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { z } from "zod"

export const TRUTH_LABELS = [
	"analog-voice",
	"dmr",
	"pocsag",
	"carrier",
	"noise",
	"unknown",
] as const
export type TruthLabel = (typeof TRUTH_LABELS)[number]

export const TRUTH_SOURCES = [
	"decoded-offline",
	/** A decode the live system recorded with the capture (its activity log). */
	"decoded-live",
	"ear",
	"repeater-list",
	/** Synthetic scenes: the generator's own truth. */
	"synthetic",
] as const

/**
 * Labels the recorder must never keep as voice: every label but analog voice and unknown. An
 * `unknown` interval is not scored either way.
 */
export const NON_VOICE_LABELS: readonly TruthLabel[] = [
	"dmr",
	"pocsag",
	"carrier",
	"noise",
]
/** Non-voice labels that are digital (data or digital voice): the honesty failure that matters. */
export const DIGITAL_LABELS: readonly TruthLabel[] = ["dmr", "pocsag"]

const hz = z.number().finite().positive()
const ms = z.number().finite()

export const TruthIntervalSchema = z
	.object({
		/** Carrier frequency (Hz). */
		frequencyHz: hz,
		startMs: ms,
		endMs: ms,
		label: z.enum(TRUTH_LABELS),
		source: z.enum(TRUTH_SOURCES),
		/** A person confirmed it (an offline decode with a clean CRC counts as confirmed). */
		confirmed: z.boolean(),
		/** Occupied bandwidth (Hz), when known: widens the channel a recording may match. */
		bandwidthHz: hz.optional(),
		note: z.string().max(200).optional(),
	})
	.strict()
	.refine(i => i.endMs > i.startMs, "an interval ends after it starts")
export type TruthInterval = z.infer<typeof TruthIntervalSchema>

/** How a recorded decode reaches the scanner (its production path). */
export const DECODE_PATHS = [
	/** An always-on decoder (multimon-ng, dsd-fme) placed on the channel: ambient evidence. */
	"ambient",
	/** A live identify probe on the observation. */
	"probe",
	/** An identify replay of the scanner's own IQ capture: needs a capture that holds it. */
	"replay",
] as const
export type DecodePath = (typeof DECODE_PATHS)[number]

export const TruthDecodeSchema = z
	.object({
		/** When the decode reached the scanner (ms from the capture start). */
		atMs: ms,
		frequencyHz: hz,
		protocol: z.enum(["dmr", "pocsag"]),
		via: z.enum(DECODE_PATHS),
		/** DMR colour code or POCSAG capcode, as text. */
		identity: z.string().min(1).max(32).optional(),
	})
	.strict()
export type TruthDecode = z.infer<typeof TruthDecodeSchema>

export const TruthFileSchema = z
	.object({
		version: z.literal(1),
		/** The CU8 capture: absolute, or relative to this file. */
		capture: z.string().min(1).max(1024),
		centreHz: hz,
		rateHz: hz,
		/** When the capture started (ISO 8601): orders a session and spaces its runs. */
		startedAt: z.string().datetime().optional(),
		/** The capture's length (ms); intervals past it are clipped. */
		durationMs: ms.positive(),
		/**
		 * Every transmission in the capture is labelled: a kept recording that matches no interval
		 * counts as false voice. False (the default): it is listed as unmatched only.
		 */
		complete: z.boolean().default(false),
		intervals: z.array(TruthIntervalSchema).max(10_000),
		decodes: z.array(TruthDecodeSchema).max(10_000).default([]),
	})
	.strict()
export type TruthFile = z.infer<typeof TruthFileSchema>

/** A loaded truth file: its name (file name without `.truth.json`) and the capture's path. */
export interface TruthCapture {
	name: string
	path: string
	capturePath: string
	truth: TruthFile
}

export const TRUTH_SUFFIX = ".truth.json"

/** Parses one truth file; throws with the path and the first issue. */
export function parseTruthFile(path: string, text: string): TruthFile {
	let json: unknown
	try {
		json = JSON.parse(text)
	} catch {
		throw new Error(`${path}: not JSON`)
	}
	const parsed = TruthFileSchema.safeParse(json)
	if (!parsed.success) {
		const issue = parsed.error.issues[0]
		throw new Error(
			`${path}: ${issue ? `${issue.path.join(".")} ${issue.message}` : "invalid"}`,
		)
	}
	return parsed.data
}

/** Every `*.truth.json` of `dir` (sorted by name), with its capture resolved and present. */
export function loadTruthDir(dir: string): TruthCapture[] {
	const out: TruthCapture[] = []
	for (const f of readdirSync(dir).sort()) {
		if (!f.endsWith(TRUTH_SUFFIX)) continue
		const path = join(dir, f)
		const truth = parseTruthFile(path, readFileSync(path, "utf8"))
		const capturePath = isAbsolute(truth.capture)
			? truth.capture
			: resolve(dirname(path), truth.capture)
		if (!existsSync(capturePath)) throw new Error(`${path}: capture not found`)
		out.push({
			name: f.slice(0, -TRUTH_SUFFIX.length),
			path,
			capturePath,
			truth,
		})
	}
	return out
}

/** One metric's limit: the scorecard fails when the value is above `max`. */
const LimitSchema = z
	.object({ max: z.number().finite().nonnegative() })
	.strict()

/**
 * The checked-in limits (scanner-quality/truth-thresholds.json). Every metric named must exist
 * in the scorecard's totals; a metric left out is not gated.
 */
export const ThresholdsSchema = z
	.object({
		version: z.literal(1),
		limits: z.record(z.string(), LimitSchema),
		/** Why a limit is above 0 (the known limits it allows), per metric. */
		notes: z.record(z.string(), z.string().max(500)).optional(),
	})
	.strict()
export type Thresholds = z.infer<typeof ThresholdsSchema>

export function parseThresholds(path: string, text: string): Thresholds {
	let json: unknown
	try {
		json = JSON.parse(text)
	} catch {
		throw new Error(`${path}: not JSON`)
	}
	const parsed = ThresholdsSchema.safeParse(json)
	if (!parsed.success) {
		const issue = parsed.error.issues[0]
		throw new Error(
			`${path}: ${issue ? `${issue.path.join(".")} ${issue.message}` : "invalid"}`,
		)
	}
	return parsed.data
}
