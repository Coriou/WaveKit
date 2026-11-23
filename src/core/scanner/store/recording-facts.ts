/**
 * Facts sidecar of a kept scanner analog recording: why the file ended, the recording
 * admission's measured numbers (speech-content.ts, the same numbers the noise quarantine keeps
 * for a discarded file), the owner it was kept for and the frequency and times it covers.
 * Before it these facts lived only in the recorder's "Analog file kept" log line.
 *
 * Where: `<scanner storage>/.analog-operations/<operationId>/facts.json`, the operation folder
 * beside the file's `intent.json` and `receipt.json` (the same folder the catalogue reads the
 * receipt from, recording-cut.ts). Not in the WAV's own folder: every walker of
 * `recordings/` (the listing, the legacy retention pool, the delete sweep, the alias scans)
 * would count a foreign file there as a recording or as residue. The operation folder is the
 * file's metadata unit: the store's one removal path (AnalogOperations.cleanupOwned) removes it
 * with the WAV, for retention, eviction, discovery deletion and recovery alike, so a sidecar is
 * never orphaned and never listed. Only a finalized (kept) file gets one: a noise cancel moves
 * its audio to the noise quarantine with that quarantine's own sidecar, any other cancel
 * deletes it, so neither leaves a facts file behind.
 *
 * Written after the keep decision (tmp + fsync + rename), best effort: a failed or skipped
 * write leaves the recording served as before, without facts. A reader treats a missing,
 * oversized or malformed sidecar, or one of another operation, as no facts (null).
 *
 * Size bound (arithmetic): the JSON's longest values are the ids (operation 36, discovery and
 * observation at most 128 each: 292 B), three ISO times (24 B each: 72 B), at most 14 finite
 * numbers (at most 24 B each as JSON: 336 B) and the closed codes (keptBy 32, cut 32, reason and
 * strength 64 each, branch 9: 201 B), plus about 520 B of member names and punctuation: about
 * 1 421 B. The tone member adds at most 48 B: `,"tone":{"kind":"ctcss","hz":` and `}` take
 * 30 B and the bounded hz at most 18 (a double in 67..254.1 prints in at most 18 characters,
 * e.g. 254.09999999999997); the DCS form `,"tone":{"kind":"dcs","code":"754"}` takes 35 B.
 * About 1 469 B in all.
 * RECORDING_FACTS_MAX_BYTES (2 048 B) holds that with room, and a writer refuses anything
 * larger.
 *
 * Tone: what the recorder's own CTCSS bank measured over the file's activity (no new
 * detection). `{kind:"ctcss",hz}` when it heard a tone; null when it measured at least
 * TONE_MEASURED_MIN_MS of the file's activity and heard none; the member is absent when it
 * measured less (the bank needs 750 ms before it answers at all, so a null there would not be a
 * confirmed "no tone"). The recorder measures no DCS: the `dcs` form is in the shape but never
 * produced now. A tone that does not validate is dropped (the member absent), never the whole
 * sidecar, like the admission block. The store's operation folder budget (MAX_OPERATION_METADATA_BYTES, 16 KiB)
 * covers intent + receipt + sidecar: the sidecar is skipped when the three would exceed it.
 */
import { z } from "zod"
import type { RecordingFacts, RecordingTone } from "@wavekit/api-types"
import { CTCSS_HZ } from "../../audio-tones/ctcss.js"
import { NoiseQuarantineFactsSchema } from "./noise-quarantine.js"
import { MAX_OPERATION_METADATA_BYTES } from "./recording-operation.js"

export const RECORDING_FACTS_FILE = "facts.json"
export const RECORDING_FACTS_TEMP = "facts.tmp"
/** See the module comment for the arithmetic. */
export const RECORDING_FACTS_MAX_BYTES = 2048

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDENTITY = /^[A-Za-z0-9_-]{1,128}$/
const CODE = /^[a-z][a-z-]{0,31}$/
const iso = z.string().datetime()
const finite = z.number().finite()

/**
 * Activity the recorder's CTCSS bank must have measured before its "no tone" counts: the bank's
 * own minimum (two 500 ms blocks hopped by 250 ms: 750 ms, ctcss.ts MIN_SAMPLES) plus 250 ms for
 * the frames the recorder does not feed it (a roll-over file's carried head) — 1 000 ms.
 */
export const TONE_MEASURED_MIN_MS = 1000

/** Lowest and highest standard CTCSS tones (67.0 and 254.1 Hz): the bounds of `hz`. */
const CTCSS_MIN_HZ = CTCSS_HZ[0]
const CTCSS_MAX_HZ = CTCSS_HZ[CTCSS_HZ.length - 1]!

export const RecordingToneSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("ctcss"),
			hz: finite.min(CTCSS_MIN_HZ).max(CTCSS_MAX_HZ),
		})
		.strict(),
	/** A DCS code as three octal digits ("023"); reserved, the recorder measures none. */
	z
		.object({ kind: z.literal("dcs"), code: z.string().regex(/^[0-7]{3}$/) })
		.strict(),
])

/**
 * The tone fact of a file whose CTCSS bank answered `toneHz` over `measuredMs` of its activity,
 * as AnalogFinishFacts members: the CTCSS tone when it heard one, null when it measured at least
 * TONE_MEASURED_MIN_MS (exactly at it counts) and heard none, no member below that or on a
 * non-finite span.
 */
export function toneFactOf(
	toneHz: number | null,
	measuredMs: number,
): { readonly tone?: RecordingTone | null } {
	if (toneHz !== null) return { tone: { kind: "ctcss", hz: toneHz } }
	return Number.isFinite(measuredMs) && measuredMs >= TONE_MEASURED_MIN_MS
		? { tone: null }
		: {}
}

export const RecordingFactsSchema = z
	.object({
		version: z.literal(1),
		operationId: z.string().regex(UUID),
		/** The discovery whose folder the file was kept in (the session's owner at the keep). */
		discoveryId: z.string().regex(IDENTITY),
		observationId: z.string().regex(IDENTITY),
		/** The centre the recorder demodulated (binding targetHz), whole Hz; null when unknown. */
		frequencyHz: finite.nonnegative().nullable(),
		startedAt: iso.nullable(),
		endedAt: iso.nullable(),
		keptAt: iso,
		durationMs: finite.nonnegative().nullable(),
		finish: z
			.object({
				cut: z.string().regex(CODE),
				keptBy: z.string().regex(CODE).nullable(),
				speechHeard: z.boolean().nullable(),
				cutActive: z.boolean().nullable(),
			})
			.strict(),
		/** The recording admission's measured numbers; null when the recorder gave none. */
		admission: NoiseQuarantineFactsSchema.nullable(),
		/** The tone heard over the file; null: measured, none heard; absent: not measured. */
		tone: RecordingToneSchema.nullable().optional(),
	})
	.strict()

/** The sidecar the schema reads is the API's shape, member for member. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const shapeCheck: Same<
	z.infer<typeof RecordingFactsSchema>,
	RecordingFacts
> = true
void shapeCheck

export interface RecordingFactsInput {
	operationId: string
	discoveryId: string
	observationId: string
	targetHz: number | null
	startedAt: string | undefined
	durationMs: number | null
	keptAt: number
	cut: string
	keptBy: string | undefined
	speechHeard: boolean | null | undefined
	cutActive: boolean | null
	admission: unknown
	/** The recorder's tone fact (toneFactOf); undefined: none, the member is left out. */
	tone?: unknown
}

/**
 * The sidecar's bytes for a kept file, or null when the facts do not validate or exceed
 * RECORDING_FACTS_MAX_BYTES. An admission block that does not validate is dropped (null), never
 * the whole sidecar: the recorder's numbers are a read-only pass-through. So is a tone that does
 * not validate: the member is left out.
 */
export function recordingFactsBytes(input: RecordingFactsInput): Buffer | null {
	const admission = NoiseQuarantineFactsSchema.safeParse(input.admission)
	const tone =
		input.tone === undefined
			? null
			: RecordingToneSchema.nullable().safeParse(input.tone)
	const startMs =
		input.startedAt === undefined ? Number.NaN : Date.parse(input.startedAt)
	const started = Number.isFinite(startMs)
		? new Date(startMs).toISOString()
		: null
	const endedAt =
		started !== null && input.durationMs !== null
			? new Date(startMs + input.durationMs).toISOString()
			: null
	const parsed = RecordingFactsSchema.safeParse({
		version: 1,
		operationId: input.operationId,
		discoveryId: input.discoveryId,
		observationId: input.observationId,
		frequencyHz:
			input.targetHz !== null && Number.isFinite(input.targetHz)
				? Math.round(input.targetHz)
				: null,
		startedAt: started,
		endedAt,
		keptAt: new Date(input.keptAt).toISOString(),
		durationMs: input.durationMs,
		finish: {
			cut: input.cut,
			keptBy: input.keptBy ?? null,
			speechHeard: input.speechHeard ?? null,
			cutActive: input.cutActive,
		},
		admission: admission.success ? admission.data : null,
		...(tone?.success === true ? { tone: tone.data } : {}),
	})
	if (!parsed.success) return null
	return withinFactsBound(Buffer.from(JSON.stringify(parsed.data)))
}

/** `bytes` when at most RECORDING_FACTS_MAX_BYTES (exactly at it is within), else null. */
export function withinFactsBound(bytes: Buffer): Buffer | null {
	return bytes.length > RECORDING_FACTS_MAX_BYTES ? null : bytes
}

/**
 * Whether a sidecar of `factsBytes` may join an operation folder whose intent and receipt take
 * `metadataBytes`: the sidecar within its own bound and the three within
 * MAX_OPERATION_METADATA_BYTES (exactly at either bound is within it).
 */
export function factsFitFolder(
	metadataBytes: number,
	factsBytes: number,
): boolean {
	return (
		factsBytes <= RECORDING_FACTS_MAX_BYTES &&
		metadataBytes + factsBytes <= MAX_OPERATION_METADATA_BYTES
	)
}

/** Parsed sidecar JSON of `operationId`, or null when it is not one (fail closed). */
export function recordingFactsOf(
	json: unknown,
	operationId: string,
): RecordingFacts | null {
	const parsed = RecordingFactsSchema.safeParse(json)
	if (!parsed.success) return null
	if (parsed.data.operationId.toLowerCase() !== operationId.toLowerCase())
		return null
	return parsed.data
}
