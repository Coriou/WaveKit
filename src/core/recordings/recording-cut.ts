/**
 * Why a scanner analog recording's file ended, and which observation it belongs to, read from
 * its operation receipt (`<scanner storage>/.analog-operations/<operation id>/receipt.json`, the
 * store's marker for a finalized file). Read-only and fail closed: a receipt that is missing,
 * oversized, not JSON, of another operation or not finalized reads as unknown (null).
 */
import { constants as fsConstants } from "node:fs"
import * as path from "node:path"
import { z } from "zod"
import type { RecordingCut, RecordingSpeech } from "@wavekit/api-types"
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
	cutActive: z.unknown(),
	keptBy: z.unknown(),
	speechHeard: z.unknown(),
	startedAt: z.unknown(),
})

/** A finish reason code as the store writes it (analog-operations.ts `keptBy`). */
const KEPT_BY = /^[a-z][a-z-]{0,31}$/

/** What the inventory keeps of a recording's receipt. */
export interface RecordingReceiptFacts {
	cut: RecordingCut | null
	observationId: string | null
	/** The receipt's `speechHeard` as a word; `unchecked` when it is absent, null or malformed. */
	speech?: RecordingSpeech
	/** The receipt's `keptBy` code; null when absent or malformed. */
	keptBy?: string | null
	/** The receipt's `startedAt` (ISO, UTC, milliseconds); null when absent or malformed. */
	startedAt?: string | null
}

/** A receipt's `speechHeard` as a RecordingSpeech: anything but a boolean is `unchecked`. */
export function recordingSpeechOf(speechHeard: unknown): RecordingSpeech {
	return speechHeard === true
		? "heard"
		: speechHeard === false
			? "not-heard"
			: "unchecked"
}

/** An ISO time as its canonical UTC form, or null when it is not one. */
function isoOf(value: unknown): string | null {
	if (typeof value !== "string" || value.length > 40) return null
	const ms = Date.parse(value)
	if (
		!Number.isFinite(ms) ||
		!/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(value)
	)
		return null
	return new Date(ms).toISOString()
}

/**
 * A receipt's cut reason (the store's AnalogCut) as the inventory's RecordingCut. Only reasons
 * that mean the same thing map; the rest (a natural end, a cancel, a stream or engine restart)
 * and anything unknown are null, never guessed. `cutActive` is the receipt's optional
 * `cutActive` (the recorder's answer whether a joined track was still on the air at the cut):
 * an `epoch-changed` cut whose receipt says false clipped only the file's silent hang, so it is
 * not "the scanner moved on" and reads null (a completed file to the label). Any other value,
 * the field missing included, keeps `scanner-moved`: receipts written before the field existed
 * carry none, and for them the cut is all that is known (as before the field).
 */
export function recordingCutOf(
	reason: unknown,
	cutActive?: unknown,
): RecordingCut | null {
	switch (reason) {
		case "epoch-changed":
			return cutActive === false ? null : "scanner-moved"
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
	const keptBy = parsed.data.keptBy
	return {
		cut: recordingCutOf(parsed.data.cutReason, parsed.data.cutActive),
		observationId: parsed.data.observationId,
		speech: recordingSpeechOf(parsed.data.speechHeard),
		keptBy: typeof keptBy === "string" && KEPT_BY.test(keptBy) ? keptBy : null,
		startedAt: isoOf(parsed.data.startedAt),
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
 * Part numbers of an observation's listed files: only files chained by roll-overs are parts. The
 * files are ordered by start: the leading `YYYYMMDD_HHMMSS_` stamp of the file's name (`name`,
 * else the file part of its id), then modification time and id; when any file of the group has
 * no parseable stamp (the store's `analog-<operation uuid>.wav` names carry none) the whole group
 * falls back to finish order (modification time, then id), so stamped and unstamped files are
 * never interleaved by two different clocks. In that order a chain is a run of consecutive files
 * in which every file but the last ended `duration-rollover` (its transmission went on in the
 * next file); a file that ended any other way (a natural end, a cut, unknown) closes its chain,
 * and the next file starts a new one. Each file of a chain of n ≥ 2 files is part i of n
 * (1-based in that order); a chain of one file (a transmission no roll-over split, such as each
 * of a relay's separate overs while it holds its carrier in one observation) gets none
 * (null, null). The last listed file of a group may still be rolling (its next part not listed
 * yet): its chain counts the parts listed so far.
 */
export function recordingParts<
	T extends {
		mtimeMs: number
		id: string
		name?: string
		cut: RecordingCut | null
	},
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
	let from = 0
	sorted.forEach((f, i) => {
		if (f.cut === "duration-rollover" && i < sorted.length - 1) return
		// sorted[from..i] is one chain: closed by a file that did not roll (or the last file).
		const chain = sorted.slice(from, i + 1)
		const parts = chain.length > 1 ? chain.length : null
		chain.forEach((c, k) =>
			out.set(c, { part: parts === null ? null : k + 1, parts }),
		)
		from = i + 1
	})
	return out
}
