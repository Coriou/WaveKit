/**
 * Copy sidecar of a kept scanner analog recording (copy detection, channel/copy-detector.ts):
 * the file is a copy (a ghost: the same audio heard again on another frequency, with evidence of
 * its own) of the root it names. Unlike facts.json (write-once) it changes: the detector re-points
 * or removes it, so it lives in its own file, `copy.json`, in the operation folder
 * (`<storage>/.analog-operations/<operationId>/`), removed with the operation by the store's one
 * removal path (cleanupOwned), never listed and never orphaned. Not a copy: no file.
 *
 * Written under the store lock (AnalogOperations.writeCopy), tmp + fsync + rename; a reader treats
 * a missing, oversized or malformed sidecar, or one of another operation, as not a copy (null).
 *
 * Size bound (arithmetic): `{"version":1,"operationId":"<36>","of":{"key":"<≤ 133: scan: +
 * alias ≤ 128>","operationId":"<36>"},"score":{"r":<≤ 6>,"z":<≤ 8>,"neff":<≤ 4>,"lagFrames":<≤ 2>},
 * "evidence":["intermod","off-raster"],"at":"<24>"}`: values 36 + 133 + 36 + 20 + 23 + 24 = 272 B,
 * member names and punctuation about 140 B: about 412 B. COPY_FACTS_MAX_BYTES = 512 holds it; a
 * writer refuses anything larger.
 */
import { z } from "zod"

export const COPY_FACTS_FILE = "copy.json"
export const COPY_FACTS_TEMP = "copy.tmp"
/** See the module comment for the arithmetic. */
export const COPY_FACTS_MAX_BYTES = 512

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A scanner analog recording's keep key: `scan:<discovery>~analog-<uuid>.wav`. */
const SCAN_KEY = /^scan:d_[0-9A-Za-z]{1,62}~analog-[0-9a-f-]{36}\.wav$/i
const iso = z
	.string()
	.max(32)
	.refine(v => Number.isFinite(Date.parse(v)))

export const CopyEvidenceSchema = z.enum(["intermod", "off-raster"])

export const CopyFactsSchema = z
	.object({
		version: z.literal(1),
		operationId: z.string().regex(UUID),
		of: z
			.object({
				key: z.string().max(140).regex(SCAN_KEY),
				operationId: z.string().regex(UUID),
			})
			.strict(),
		score: z
			.object({
				r: z.number().finite().min(-1).max(1),
				z: z.number().finite().min(-1_000).max(1_000),
				neff: z.number().finite().nonnegative().max(10_000),
				lagFrames: z.number().int().min(-16).max(16),
			})
			.strict(),
		evidence: z.array(CopyEvidenceSchema).min(1).max(2),
		at: iso,
	})
	.strict()

export type CopyFacts = z.infer<typeof CopyFactsSchema>

/** What the detector hands the store (copy-detector.ts CopyRecord). */
export interface CopyFactsInput {
	readonly of: { readonly key: string; readonly operationId: string }
	readonly score: {
		readonly r: number
		readonly z: number
		readonly neff: number
		readonly lagFrames: number
	}
	readonly evidence: readonly string[]
}

/** The sidecar bytes, or null when the input does not validate or exceeds the bound. */
export function copyFactsBytes(
	operationId: string,
	input: CopyFactsInput,
	at: number,
): Buffer | null {
	const parsed = CopyFactsSchema.safeParse({
		version: 1,
		operationId,
		of: { key: input.of.key, operationId: input.of.operationId },
		score: { ...input.score },
		evidence: [...new Set(input.evidence)],
		at: new Date(at).toISOString(),
	})
	if (!parsed.success) return null
	if (parsed.data.of.operationId.toLowerCase() === operationId.toLowerCase())
		return null
	const bytes = Buffer.from(JSON.stringify(parsed.data))
	return bytes.length > COPY_FACTS_MAX_BYTES ? null : bytes
}

/** Parsed sidecar JSON of `operationId`, or null when it is not one (fail closed). */
export function copyFactsOf(
	json: unknown,
	operationId: string,
): CopyFacts | null {
	const parsed = CopyFactsSchema.safeParse(json)
	if (!parsed.success) return null
	if (parsed.data.operationId.toLowerCase() !== operationId.toLowerCase())
		return null
	if (parsed.data.of.operationId.toLowerCase() === operationId.toLowerCase())
		return null
	return parsed.data
}
