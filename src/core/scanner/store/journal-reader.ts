/**
 * Streaming read of the scanner journal at load (`journal/observations-YYYYMMDD.jsonl`). Each day
 * file is read in 256 KiB chunks and split into lines at the byte level; a line the snapshot
 * already covers (its `{"seq":<n>,` prefix at or below `fromSeq`) is skipped without JSON.parse,
 * so a large day file the snapshot covers costs a byte scan instead of a 4 s parse. Uncovered
 * lines are parsed and validated; replay then stops at the first missing seq (a journal gap: the
 * lines after it were written on a base the store no longer has, the same rule appends follow at
 * run time). Work between event-loop turns is bounded by a deadline (`SliceClock`).
 */
import { open, truncate as truncateFile } from "node:fs/promises"
import { join } from "node:path"
import type { Logger } from "../../../utils/logger.js"
import type { JournalEntry } from "./discovery-store.js"
import type { SliceClock } from "./slices.js"

/** Bytes per read: a 54 MiB day file is about 216 reads. */
export const JOURNAL_READ_CHUNK_BYTES = 256 * 1024
/**
 * A line longer than this is dropped as corrupt without buffering more of it. A written line is
 * smaller: the default journal backlog cap (32 MiB) charges 2 bytes per UTF-16 unit, so a line
 * passes it only below 16 Mi units, at most 3 UTF-8 bytes each: 48 MiB. 64 MiB leaves margin.
 */
export const JOURNAL_MAX_LINE_BYTES = 64 * 1024 * 1024
/**
 * Digits of a seq prefix read without JSON.parse: up to 15 (< 1e15, inside
 * Number.MAX_SAFE_INTEGER, 9.007e15). A longer number falls back to the full parse.
 */
const PREFIX_MAX_DIGITS = 15
/** `{"seq":` as bytes: what `ScannerPersistence.append` writes first on every line. */
const SEQ_PREFIX = Buffer.from('{"seq":', "utf8")
const NEWLINE = 0x0a
const COMMA = 0x2c
const DIGIT_0 = 0x30
const DIGIT_9 = 0x39

/**
 * The seq in a line's `{"seq":<n>,` prefix, or null when the line does not start that way (a
 * foreign writer, a corrupt line, a leading zero, more than 15 digits): the caller then parses
 * the whole line.
 */
export function prefixSeq(line: Buffer): number | null {
	const p = SEQ_PREFIX.length
	if (line.length <= p + 1) return null
	for (let i = 0; i < p; i++) if (line[i] !== SEQ_PREFIX[i]) return null
	if (line[p] === DIGIT_0) return null
	let n = 0
	let i = p
	for (; i < line.length && i - p <= PREFIX_MAX_DIGITS; i++) {
		const c = line[i]
		if (c === undefined || c < DIGIT_0 || c > DIGIT_9) break
		n = n * 10 + (c - DIGIT_0)
	}
	const digits = i - p
	if (digits === 0 || digits > PREFIX_MAX_DIGITS || line[i] !== COMMA)
		return null
	return n
}

export interface JournalFileInfo {
	name: string
	/** Highest seq in the file (covered lines by their prefix), 0 for none. */
	maxSeq: number
	/** Bytes on disk after any torn-tail truncation. */
	bytes: number
}

export interface JournalRead {
	/** Uncovered entries in seq order, contiguous from `fromSeq + 1`, ending before the first gap. */
	entries: JournalEntry[]
	/** Highest seq seen in any file (lines after a gap included), 0 for none. */
	maxSeq: number
	/** Torn tails, invalid lines and differing duplicates. */
	dropped: number
	/** Something was dropped, a gap stopped replay, or a file was unreadable. */
	degraded: boolean
	/** UTF-8 bytes (newline included) of the uncovered valid lines, after the gap too. */
	uncoveredBytes: number
	files: JournalFileInfo[]
	/** The first missing seq and the next seq present after it; null when contiguous. */
	gap: { missing: number; next: number; skipped: number } | null
	/** Some day file holds seqs below an earlier file's (the clock was set back). */
	outOfOrder: boolean
}

export interface JournalReadOptions {
	dir: string
	/** Journal file names in name order (`observations-YYYYMMDD.jsonl`). */
	names: readonly string[]
	/** lastSeq of the snapshot: lines at or below it are covered. */
	fromSeq: number
	/** JSON.parse + schema of one line; null when invalid. */
	parseLine: (line: string) => JournalEntry | null
	slice: SliceClock
	log: Logger
	/** Injectable for tests; `fs/promises.truncate` by default. */
	truncate?: (path: string, bytes: number) => Promise<void>
	chunkBytes?: number
	maxLineBytes?: number
}

/** Reads every journal file; see the module comment. Never throws for bad content; I/O errors propagate. */
export async function readJournalFiles(
	o: JournalReadOptions,
): Promise<JournalRead> {
	const chunkBytes = o.chunkBytes ?? JOURNAL_READ_CHUNK_BYTES
	const maxLineBytes = o.maxLineBytes ?? JOURNAL_MAX_LINE_BYTES
	const cut = o.truncate ?? ((path, bytes) => truncateFile(path, bytes))
	const bySeq = new Map<number, JournalEntry>()
	/** One read buffer for every file: lines are handled (or the carry copied) before the next read. */
	const chunk = Buffer.allocUnsafe(chunkBytes)
	const files: JournalFileInfo[] = []
	let maxSeq = 0
	let dropped = 0
	let degraded = false
	let uncoveredBytes = 0
	let outOfOrder = false
	/** Highest seq of the files read so far (out-of-order detection). */
	let previousMax = 0

	for (const name of o.names) {
		const path = join(o.dir, name)
		let fileMax = 0
		let fileMin = Number.POSITIVE_INFINITY
		let invalid = 0
		const handleLine = (line: Buffer): void => {
			const prefixed = prefixSeq(line)
			if (prefixed !== null && prefixed <= o.fromSeq) {
				fileMax = Math.max(fileMax, prefixed)
				fileMin = Math.min(fileMin, prefixed)
				return
			}
			const parsed = o.parseLine(line.toString("utf8"))
			if (parsed === null || (prefixed !== null && parsed.seq !== prefixed)) {
				invalid++
				return
			}
			fileMax = Math.max(fileMax, parsed.seq)
			fileMin = Math.min(fileMin, parsed.seq)
			if (parsed.seq <= o.fromSeq) return
			const previous = bySeq.get(parsed.seq)
			if (previous === undefined) {
				bySeq.set(parsed.seq, parsed)
				uncoveredBytes += line.length + 1
			} else if (JSON.stringify(previous) !== JSON.stringify(parsed)) {
				// The same seq twice with different content: neither is trusted more; keep the first.
				dropped++
				degraded = true
			}
		}
		const handle = await open(path, "r")
		let size = 0
		/** Byte offset just past the last newline: what a torn tail is cut back to. */
		let lastNewlineEnd = 0
		try {
			/** The start of a line spanning reads, copied out of the reused buffer; joined once at its newline. */
			let carry: Buffer[] = []
			let carryBytes = 0
			let carryOversize = false
			for (;;) {
				const { bytesRead } = await handle.read(chunk, 0, chunkBytes, size)
				if (bytesRead === 0) break
				const data = chunk.subarray(0, bytesRead)
				let start = 0
				for (;;) {
					const nl = data.indexOf(NEWLINE, start)
					if (nl < 0) break
					lastNewlineEnd = size + nl + 1
					const piece = data.subarray(start, nl)
					if (carryOversize || carryBytes + piece.length > maxLineBytes)
						invalid++
					else if (carryBytes + piece.length > 0)
						handleLine(
							carryBytes === 0
								? piece
								: Buffer.concat([...carry, piece], carryBytes + piece.length),
						)
					carry = []
					carryBytes = 0
					carryOversize = false
					start = nl + 1
					if (o.slice.due()) await o.slice.yield()
				}
				if (start < bytesRead) {
					const rest = bytesRead - start
					if (carryOversize || carryBytes + rest > maxLineBytes) {
						carry = []
						carryBytes = 0
						carryOversize = true
					} else {
						carry.push(Buffer.from(data.subarray(start)))
						carryBytes += rest
					}
				}
				size += bytesRead
			}
			if (carryBytes > 0 || carryOversize) {
				dropped++
				degraded = true
				o.log.warn(
					{ file: path, tornBytes: size - lastNewlineEnd },
					"Dropping a torn final journal line",
				)
			}
		} finally {
			await handle.close()
		}
		if (size > lastNewlineEnd) {
			await cut(path, lastNewlineEnd)
			size = lastNewlineEnd
		}
		if (invalid > 0) {
			dropped += invalid
			degraded = true
			o.log.warn(
				{ file: path, lines: invalid },
				"Skipping invalid journal lines",
			)
		}
		if (fileMin < previousMax) outOfOrder = true
		previousMax = Math.max(previousMax, fileMax)
		maxSeq = Math.max(maxSeq, fileMax)
		files.push({ name, maxSeq: fileMax, bytes: size })
	}

	let seqs = [...bySeq.keys()]
	if (outOfOrder) {
		o.log.info(
			{ files: o.names.length },
			"Journal day files are out of seq order (clock set back); sorting the uncovered tail",
		)
		seqs = seqs.sort((a, b) => a - b)
	} else if (!isAscending(seqs)) {
		// Within one file: never written that way, but sorted rather than replayed out of order.
		outOfOrder = true
		seqs = seqs.sort((a, b) => a - b)
	}
	const entries: JournalEntry[] = []
	let gap: JournalRead["gap"] = null
	let expected = o.fromSeq + 1
	for (const seq of seqs) {
		if (seq !== expected) {
			gap = { missing: expected, next: seq, skipped: 0 }
			break
		}
		const found = bySeq.get(seq)
		if (found !== undefined) entries.push(found)
		expected++
		if (o.slice.due()) await o.slice.yield()
	}
	if (gap !== null) {
		gap.skipped = seqs.length - entries.length
		degraded = true
		o.log.warn(
			{
				missing: gap.missing,
				next: gap.next,
				replayed: entries.length,
				skipped: gap.skipped,
			},
			"Scanner journal has a gap; replay stops before it",
		)
	}
	return {
		entries,
		maxSeq,
		dropped,
		degraded,
		uncoveredBytes,
		files,
		gap,
		outOfOrder,
	}
}

function isAscending(seqs: readonly number[]): boolean {
	for (let i = 1; i < seqs.length; i++) {
		const a = seqs[i - 1]
		const b = seqs[i]
		if (a === undefined || b === undefined || b <= a) return false
	}
	return true
}
