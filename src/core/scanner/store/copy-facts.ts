/**
 * Copy mark of a kept scanner analog recording (copy detection, channel/copy-detector.ts): the
 * file is a copy (a ghost: the same audio heard again on another frequency, with evidence of its
 * own) of the root it names. It changes (the detector re-points or removes it), so it is not in
 * the operation folder: it lives in its own directory beside the store's folders,
 * `<scanner.storage.dir>/copies/<operationId>.json`, outside `.analog-operations/` (whose
 * recovery scan admits a fixed list of names, so an older core that finds an extra name there
 * quarantines the operation; an older core never looks in `copies/`). Not a copy: no file.
 *
 * Owned by AnalogOperations: written under the store lock (writeCopy), tmp (`<operationId>.tmp`)
 * + fsync + rename + directory fsync; removed when the store removes the operation (cleanupOwned);
 * at recovery the directory is read once into an in-memory index, and marks of operations the
 * store does not list, malformed or oversized marks and stale temps are removed. Readers (the
 * catalogue) ask the index (AnalogOperations.copyOf), never the file.
 *
 * Size bound (arithmetic): `{"version":1,"operationId":"<36>","of":{"key":"<≤ 133: scan: +
 * alias ≤ 128>","operationId":"<36>"},"score":{"r":<≤ 6>,"z":<≤ 8>,"neff":<≤ 4>,"lagFrames":<≤ 2>},
 * "evidence":["intermod","off-raster"],"at":"<24>"}`: values 36 + 133 + 36 + 20 + 23 + 24 = 272 B,
 * member names and punctuation about 140 B: about 412 B. COPY_FACTS_MAX_BYTES = 512 holds it; a
 * writer refuses anything larger and a reader reads anything larger as no copy.
 */
import { z } from "zod"
import { MAX_RECOVERY_OPERATIONS } from "./recording-operation.js"

/** The marks' directory, directly under the scanner storage root. */
export const COPY_MARKS_DIR = "copies"
/** See the module comment for the arithmetic. */
export const COPY_FACTS_MAX_BYTES = 512
/**
 * Names the recovery listing of `copies/` reads at most: one mark and one temp per operation the
 * store can list (MAX_RECOVERY_OPERATIONS = 4 096) = 8 192, plus 64 for foreign names. Past it the
 * listing fails closed: no mark is loaded (every file shown as no copy) and nothing is removed.
 */
export const COPY_MARKS_LIST_MAX = 2 * MAX_RECOVERY_OPERATIONS + 64

const MARK_NAME =
	/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(json|tmp)$/i

/** A `copies/` entry name: a mark or temp of an operation id, or null (a foreign name, left alone). */
export function copyMarkIdOf(
	name: string,
): { readonly operationId: string; readonly temp: boolean } | null {
	const m = MARK_NAME.exec(name)
	if (m?.[1] === undefined) return null
	return { operationId: m[1].toLowerCase(), temp: m[2] === "tmp" }
}

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
