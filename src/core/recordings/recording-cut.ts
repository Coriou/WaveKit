/**
 * Why a scanner analog recording's file ended, and which observation it belongs to, read from
 * its operation receipt (`<scanner storage>/.analog-operations/<operation id>/receipt.json`, the
 * store's marker for a finalized file). Read-only and fail closed: a receipt that is missing,
 * oversized, not JSON, of another operation or not finalized reads as unknown (null).
 */
import { constants as fsConstants } from "node:fs"
import * as path from "node:path"
import { z } from "zod"
import type { RecordingCut } from "@wavekit/api-types"
import type { RecordingFsPort } from "./inventory.js"
import { startedAtLocalFromName } from "./names.js"

/**
 * Bytes read of a receipt: the store bounds an operation's metadata to 16 KiB
 * (MAX_OPERATION_METADATA_BYTES); one byte more tells an oversized file, which reads as unknown.
 */
export const RECORDING_RECEIPT_MAX_BYTES = 16 * 1024

/** `analog-<operation uuid>.wav`, the store's analog file name (recordingArtifact). */
const ANALOG_FILE =
	/^analog-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.wav$/i
const OBSERVATION_ID = /^[A-Za-z0-9_-]{1,128}$/

const RECEIPT_FLAGS =
	(fsConstants.O_RDONLY ?? 0) |
	(fsConstants.O_NOFOLLOW ?? 0) |
	(fsConstants.O_NONBLOCK ?? 0)

/**
 * The receipt fields read here, loosely (other fields are the store's business; it validates the
 * whole receipt strictly when it writes it). `cutReason` stays unknown: the mapping decides.
 */
const ReceiptFieldsSchema = z.object({
	version: z.literal(1),
	operationId: z.string(),
	observationId: z.string().regex(OBSERVATION_ID).nullable(),
	outcome: z.literal("finalized"),
	cutReason: z.unknown(),
})

/** What the inventory keeps of a recording's receipt. */
export interface RecordingReceiptFacts {
	cut: RecordingCut | null
	observationId: string | null
}

/**
 * A receipt's cut reason (the store's AnalogCut) as the inventory's RecordingCut. Only reasons
 * that mean the same thing map; the rest (a natural end, a cancel, a stream or engine restart)
 * and anything unknown are null, never guessed.
 */
export function recordingCutOf(reason: unknown): RecordingCut | null {
	switch (reason) {
		case "epoch-changed":
			return "scanner-moved"
		case "duration-limit":
			return "duration-rollover"
		case "source-lost":
			return "source-lost"
		case "shutdown":
			return "shutdown"
		default:
			return null
	}
}

/** The receipt facts of parsed receipt JSON for `operationId`, or null when it is not one. */
export function receiptFactsOf(
	json: unknown,
	operationId: string,
): RecordingReceiptFacts | null {
	const parsed = ReceiptFieldsSchema.safeParse(json)
	if (!parsed.success) return null
	if (parsed.data.operationId.toLowerCase() !== operationId.toLowerCase())
		return null
	return {
		cut: recordingCutOf(parsed.data.cutReason),
		observationId: parsed.data.observationId,
	}
}

/**
 * Reads the receipt of the analog file `name` under the scanner recordings root `recordingsDir`
 * (`<storage>/recordings`). Null for a name that is not an analog file, and for any read or
 * parse failure.
 */
export async function readRecordingReceipt(
	fs: RecordingFsPort,
	recordingsDir: string,
	name: string,
): Promise<RecordingReceiptFacts | null> {
	const match = ANALOG_FILE.exec(name)
	const operationId = match?.[1]
	if (operationId === undefined) return null
	const file = path.join(
		path.dirname(recordingsDir),
		".analog-operations",
		operationId,
		"receipt.json",
	)
	let handle: Awaited<ReturnType<RecordingFsPort["open"]>>
	try {
		handle = await fs.open(file, RECEIPT_FLAGS)
	} catch {
		return null
	}
	try {
		const buffer = new Uint8Array(RECORDING_RECEIPT_MAX_BYTES + 1)
		let length = 0
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(
				buffer,
				length,
				buffer.length - length,
				length,
			)
			if (bytesRead <= 0) break
			length += bytesRead
		}
		if (length > RECORDING_RECEIPT_MAX_BYTES) return null
		const text = new TextDecoder("utf-8", { fatal: true }).decode(
			buffer.subarray(0, length),
		)
		return receiptFactsOf(JSON.parse(text) as unknown, operationId)
	} catch {
		return null
	} finally {
		await handle.close().catch(() => undefined)
	}
}

/**
 * The file name of an inventory id (`scan:<discovery>~<file>`: the part after the last `~` or
 * `/`), or the id itself when it has neither.
 */
function fileNameOf(id: string): string {
	return id.slice(Math.max(id.lastIndexOf("~"), id.lastIndexOf("/")) + 1)
}

/**
 * Part numbers of an observation's listed files: each entry's 1-based place in start order and
 * the count. The start is the leading `YYYYMMDD_HHMMSS_` stamp of the file's name (`name`, else
 * the file part of its id), ordered then by modification time and id; when any file of the group
 * has no parseable stamp (the store's `analog-<operation uuid>.wav` names carry none) the whole
 * group falls back to finish order (modification time, then id), so stamped and unstamped files
 * are never interleaved by two different clocks. A single file gets none (null, null).
 */
export function recordingParts<
	T extends { mtimeMs: number; id: string; name?: string },
>(files: readonly T[]): Map<T, { part: number | null; parts: number | null }> {
	const out = new Map<T, { part: number | null; parts: number | null }>()
	const starts = new Map<T, string | null>(
		files.map(f => [f, startedAtLocalFromName(f.name ?? fileNameOf(f.id))]),
	)
	// The name stamp is local wall time to the second (no offset): parts recorded across a DST
	// fall-back hour can misorder by it (a part started in the repeated hour may sort before one
	// started earlier, in its first pass); parts started in the same second tie and fall back to
	// the mtime and id order below.
	const byStart = files.every(f => starts.get(f) !== null)
	const sorted = [...files].sort((a, b) => {
		if (byStart) {
			const sa = starts.get(a) ?? ""
			const sb = starts.get(b) ?? ""
			if (sa !== sb) return sa < sb ? -1 : 1
		}
		return a.mtimeMs !== b.mtimeMs
			? a.mtimeMs - b.mtimeMs
			: a.id < b.id
				? -1
				: 1
	})
	const parts = sorted.length > 1 ? sorted.length : null
	sorted.forEach((f, i) =>
		out.set(f, { part: parts === null ? null : i + 1, parts }),
	)
	return out
}
