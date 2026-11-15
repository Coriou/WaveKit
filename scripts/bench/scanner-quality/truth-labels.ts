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
		/** An analog voice's CTCSS tone (Hz), when known: identify's analog trial hears it. */
		ctcssHz: hz.optional(),
		/** The identity a decode of it names (POCSAG capcode, DMR colour code), when known. */
		identity: z
			.string()
			.regex(/^\d{1,10}$/)
			.optional(),
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

/** One metric's limit: the scorecard fails when the value is above `max` or below `min`. */
const LimitSchema = z
	.object({
		max: z.number().finite().nonnegative().optional(),
		min: z.number().finite().nonnegative().optional(),
	})
	.strict()
	.refine(
		l => l.max !== undefined || l.min !== undefined,
		"a limit needs max or min",
	)
const LimitsSchema = z.record(z.string(), LimitSchema)

/** The kinds of case the limits apply to, each on its own totals. */
export const LIMIT_KINDS = ["synthetic", "capture"] as const

export const ExceptionSchema = z
	.object({
		/** A short kebab-case name, unique in the file. */
		name: z
			.string()
			.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
			.max(64),
		kind: z.enum(LIMIT_KINDS),
		/** The case it occurs in (a synthetic scene's name); absent: any case of its kind. */
		case: z.string().min(1).max(64).optional(),
		metric: z.enum(["falseVoice", "missedVoice"]),
		/** For falseVoice only: the kept file's label. */
		label: z.enum(TRUTH_LABELS).optional(),
		/**
		 * The row's channel (Hz, within half a 12.5 kHz channel): a kept file's frequency, a missed
		 * transmission's. Synthetic exceptions name it; a capture's would put a real frequency in
		 * this public file, so capture exceptions match by kind and label only.
		 */
		frequencyHz: z.number().finite().positive().optional(),
		/** A scene time (ms) inside the row: a kept file's span, a missed transmission's. */
		atMs: z.number().finite().optional(),
		count: z.number().int().positive().max(100),
		/** Why the scanner keeps (or misses) it, and what would fix it. */
		reason: z.string().min(1).max(600),
	})
	.strict()
	.refine(e => e.label === undefined || e.metric === "falseVoice", {
		message: "label narrows a falseVoice exception only",
		path: ["label"],
	})
	.refine(
		e =>
			e.kind !== "synthetic" ||
			(e.frequencyHz !== undefined && e.atMs !== undefined),
		{
			message: "a synthetic exception names its channel and a time in its row",
			path: ["frequencyHz"],
		},
	)
export type TruthException = z.infer<typeof ExceptionSchema>

/**
 * The checked-in limits (scanner-quality/truth-thresholds.json), per kind of case: `synthetic`
 * gates the built-in scenes' totals, `capture` the labelled captures' (a run without captures
 * has capture totals of 0). Every metric named must exist in the scorecard's totals; a metric
 * left out is not gated.
 */
export const ThresholdsSchema = z
	.object({
		version: z.literal(1),
		limits: z
			.object({
				synthetic: LimitsSchema.optional(),
				capture: LimitsSchema.optional(),
			})
			.strict(),
		/** Why a limit is what it is, per kind and metric (free text). */
		notes: z.record(z.string(), z.string().max(600)).optional(),
		/**
		 * Named, documented exceptions: kept files (falseVoice) or missed voice transmissions
		 * (missedVoice) a known limit of the scanner accounts for, not counted against the limits.
		 * Each absorbs exactly `count` of them in its kind (and case, when named); one that finds
		 * fewer fails the scorecard (stale: the limit was fixed upstream, remove the exception).
		 */
		exceptions: z.array(ExceptionSchema).max(100).optional(),
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
	const names = new Set<string>()
	for (const e of parsed.data.exceptions ?? []) {
		if (names.has(e.name)) throw new Error(`${path}: exception ${e.name} twice`)
		names.add(e.name)
	}
	return parsed.data
}
