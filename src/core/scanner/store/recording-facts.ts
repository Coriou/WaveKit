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
 * 1 421 B. RECORDING_FACTS_MAX_BYTES (2 048 B) holds that with room, and a writer refuses
 * anything larger. The store's operation folder budget (MAX_OPERATION_METADATA_BYTES, 16 KiB)
 * covers intent + receipt + sidecar: the sidecar is skipped when the three would exceed it.
 */
import { z } from "zod"
import type { RecordingFacts } from "@wavekit/api-types"
import { NoiseQuarantineFactsSchema } from "./noise-quarantine.js"

export const RECORDING_FACTS_FILE = "facts.json"
export const RECORDING_FACTS_TEMP = "facts.tmp"
/** See the module comment for the arithmetic. */
export const RECORDING_FACTS_MAX_BYTES = 2048

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDENTITY = /^[A-Za-z0-9_-]{1,128}$/
const CODE = /^[a-z][a-z-]{0,31}$/
const iso = z.string().datetime()
const finite = z.number().finite()

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
}

/**
 * The sidecar's bytes for a kept file, or null when the facts do not validate or exceed
 * RECORDING_FACTS_MAX_BYTES. An admission block that does not validate is dropped (null), never
 * the whole sidecar: the recorder's numbers are a read-only pass-through.
 */
export function recordingFactsBytes(input: RecordingFactsInput): Buffer | null {
	const admission = NoiseQuarantineFactsSchema.safeParse(input.admission)
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
	})
	if (!parsed.success) return null
	const bytes = Buffer.from(JSON.stringify(parsed.data))
	return bytes.length > RECORDING_FACTS_MAX_BYTES ? null : bytes
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
