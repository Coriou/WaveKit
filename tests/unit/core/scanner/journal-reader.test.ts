/**
 * The streaming journal reader: covered lines skipped by their seq prefix without a parse, torn
 * tails cut back by bytes, lines and multi-byte characters split across reads, the gap stop,
 * day files out of order, duplicate seqs, and deadline slicing that never changes the result.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	prefixSeq,
	readJournalFiles,
} from "../../../../src/core/scanner/store/journal-reader.js"
import type { JournalReadOptions } from "../../../../src/core/scanner/store/journal-reader.js"
import type { SliceClock } from "../../../../src/core/scanner/store/slices.js"
import { deadlineSliceClock } from "../../../../src/core/scanner/store/slices.js"
import { createLogger } from "../../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const DAY1 = "observations-20261017.jsonl"
const DAY2 = "observations-20261018.jsonl"
const dirs: string[] = []

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})

async function tmp(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "wavekit-journal-reader-"))
	dirs.push(dir)
	return dir
}

/** A journal line as `ScannerPersistence.append` writes it (`tag` makes it non-ASCII or long). */
function line(seq: number, tag = ""): string {
	return `${JSON.stringify({
		seq,
		at: "2026-10-17T12:00:00.000Z",
		op: "delete",
		payload: { discoveries: [], observations: [], deleted: [`d-${seq}${tag}`] },
	})}\n`
}

function parseLine(text: string): JournalEntry | null {
	try {
		const value = JSON.parse(text) as unknown
		if (
			value !== null &&
			typeof value === "object" &&
			"seq" in value &&
			typeof value.seq === "number" &&
			Number.isInteger(value.seq) &&
			value.seq > 0 &&
			"op" in value
		)
			return value as JournalEntry
		return null
	} catch {
		return null
	}
}

/** Never due: one synchronous run. */
const never: SliceClock = {
	due: () => false,
	yield: () => Promise.resolve(),
}

/** Always due, counting yields: a turn after every line and every entry. */
function everyItem(): SliceClock & { yields: number } {
	const clock = {
		yields: 0,
		due: () => true,
		yield: () => {
			clock.yields++
			return Promise.resolve()
		},
	}
	return clock
}

function options(
	dir: string,
	names: string[],
	over: Partial<JournalReadOptions> = {},
): JournalReadOptions {
	return {
		dir,
		names,
		fromSeq: 0,
		parseLine,
		slice: never,
		log: logger,
		...over,
	}
}

describe("prefixSeq", () => {
	const b = (s: string) => Buffer.from(s, "utf8")
	it("reads the seq ScannerPersistence writes first, and refuses anything else", () => {
		expect(prefixSeq(b(line(1).trimEnd()))).toBe(1)
		expect(prefixSeq(b('{"seq":123456,"at":"x"}'))).toBe(123_456)
		// 15 digits read; 16 fall back to the full parse (past 1e15, near MAX_SAFE_INTEGER).
		expect(prefixSeq(b('{"seq":999999999999999,'))).toBe(999_999_999_999_999)
		expect(prefixSeq(b('{"seq":1000000000000000,'))).toBeNull()
		for (const bad of [
			'{"seq":01,',
			'{"seq":,',
			'{"seq":12}',
			'{"seq":12',
			'{"seq": 12,',
			'{"at":"x","seq":12,',
			'{"seq":-1,',
			'{"seq":1.5,',
			"not json",
			"",
		])
			expect(prefixSeq(b(bad))).toBeNull()
	})
})

describe("readJournalFiles", () => {
	it("skips covered lines without parsing them: a valid prefix with a corrupt body is neither parsed nor dropped", async () => {
		const dir = await tmp()
		const corrupt = '{"seq":2,"at":"x","op":"delete","payload":{CORRUPT\n'
		await writeFile(
			join(dir, DAY1),
			line(1) + corrupt + line(3) + line(4) + line(5),
		)
		const parse = vi.fn(parseLine)
		const read = await readJournalFiles(
			options(dir, [DAY1], { fromSeq: 3, parseLine: parse }),
		)
		expect(parse).toHaveBeenCalledTimes(2) // 4 and 5 only
		expect(read.entries.map(e => e.seq)).toEqual([4, 5])
		expect(read.dropped).toBe(0)
		expect(read.degraded).toBe(false)
		expect(read.maxSeq).toBe(5)
		expect(read.uncoveredBytes).toBe(
			Buffer.byteLength(line(4)) + Buffer.byteLength(line(5)),
		)
		expect(read.files).toEqual([
			{
				name: DAY1,
				maxSeq: 5,
				bytes: (await stat(join(dir, DAY1))).size,
			},
		])
	})

	it("fully parses a covered line whose prefix does not read and counts it dropped when invalid", async () => {
		const dir = await tmp()
		await writeFile(join(dir, DAY1), line(1) + "garbage\n" + line(2) + line(3))
		const read = await readJournalFiles(options(dir, [DAY1], { fromSeq: 2 }))
		expect(read.entries.map(e => e.seq)).toEqual([3])
		expect(read.dropped).toBe(1)
		expect(read.degraded).toBe(true)
	})

	it("cuts a torn tail back to the last newline by bytes, with the cut inside a multi-byte character", async () => {
		const dir = await tmp()
		const path = join(dir, DAY1)
		const whole = line(1, "-東京") + line(2, "-π🎙")
		const torn = Buffer.from(line(3, "-東京🎙"), "utf8")
		// Cut inside the 4-byte emoji: the torn bytes are not valid UTF-8 on their own.
		const at = torn.indexOf(Buffer.from("🎙", "utf8")) + 2
		await writeFile(
			path,
			Buffer.concat([Buffer.from(whole, "utf8"), torn.subarray(0, at)]),
		)
		const cut = vi.fn((p: string, bytes: number) =>
			import("node:fs/promises").then(fs => fs.truncate(p, bytes)),
		)
		const read = await readJournalFiles(
			options(dir, [DAY1], { truncate: cut, chunkBytes: 7 }),
		)
		expect(read.entries.map(e => e.seq)).toEqual([1, 2])
		expect(read.dropped).toBe(1)
		expect(read.degraded).toBe(true)
		expect(read.gap).toBeNull() // the torn line was the last: nothing after it
		const kept = Buffer.byteLength(whole)
		expect(cut).toHaveBeenCalledWith(path, kept)
		expect((await stat(path)).size).toBe(kept)
		expect(await readFile(path, "utf8")).toBe(whole)
		expect(read.files[0]?.bytes).toBe(kept)
	})

	it("a line longer than the bound is dropped without being buffered whole", async () => {
		const dir = await tmp()
		const long = line(2, "x".repeat(200))
		await writeFile(join(dir, DAY1), line(1) + long + line(3))
		const read = await readJournalFiles(
			options(dir, [DAY1], { maxLineBytes: 150, chunkBytes: 16 }),
		)
		// Seq 2 dropped as corrupt, so replay stops at the gap it leaves.
		expect(read.dropped).toBe(1)
		expect(read.entries.map(e => e.seq)).toEqual([1])
		expect(read.gap).toEqual({ missing: 2, next: 3, skipped: 1 })
		// At exactly the bound it is read: line(1) without its newline is its length.
		const exact = Buffer.byteLength(line(1)) - 1
		const ok = await readJournalFiles(
			options(dir, [DAY1], { maxLineBytes: exact }),
		)
		expect(ok.entries.map(e => e.seq)).toEqual([1])
		const under = await readJournalFiles(
			options(dir, [DAY1], { maxLineBytes: exact - 1 }),
		)
		expect(under.entries).toEqual([])
	})

	it("stops replay at the first missing seq, degrades, and still reports the highest seq and the uncovered bytes after it", async () => {
		const dir = await tmp()
		await writeFile(join(dir, DAY1), line(1) + line(2) + line(3))
		await writeFile(join(dir, DAY2), line(5) + line(6))
		const read = await readJournalFiles(options(dir, [DAY1, DAY2]))
		expect(read.entries.map(e => e.seq)).toEqual([1, 2, 3])
		expect(read.gap).toEqual({ missing: 4, next: 5, skipped: 2 })
		expect(read.degraded).toBe(true)
		expect(read.dropped).toBe(0)
		expect(read.maxSeq).toBe(6)
		expect(read.uncoveredBytes).toBe(
			[1, 2, 3, 5, 6].reduce((n, s) => n + Buffer.byteLength(line(s)), 0),
		)
		// A gap right after the snapshot replays nothing.
		const none = await readJournalFiles(
			options(dir, [DAY1, DAY2], { fromSeq: 0, names: [DAY2] }),
		)
		expect(none.entries).toEqual([])
		expect(none.gap).toEqual({ missing: 1, next: 5, skipped: 2 })
	})

	it("sorts the uncovered tail when an earlier-named day file holds later seqs (clock set back), without degrading", async () => {
		const dir = await tmp()
		await writeFile(join(dir, DAY1), line(4) + line(5))
		await writeFile(join(dir, DAY2), line(1) + line(2) + line(3))
		const read = await readJournalFiles(options(dir, [DAY1, DAY2]))
		expect(read.outOfOrder).toBe(true)
		expect(read.entries.map(e => e.seq)).toEqual([1, 2, 3, 4, 5])
		expect(read.degraded).toBe(false)
		expect(read.gap).toBeNull()
		expect(read.files.map(f => f.maxSeq)).toEqual([5, 3])
	})

	it("skips an identical duplicate seq quietly and drops a differing one, keeping the first", async () => {
		const dir = await tmp()
		await writeFile(join(dir, DAY1), line(1) + line(2) + line(2) + line(3))
		const same = await readJournalFiles(options(dir, [DAY1]))
		expect(same.entries.map(e => e.seq)).toEqual([1, 2, 3])
		expect(same.dropped).toBe(0)
		expect(same.degraded).toBe(false)
		expect(same.uncoveredBytes).toBe(
			[1, 2, 3].reduce((n, s) => n + Buffer.byteLength(line(s)), 0),
		)
		await writeFile(
			join(dir, DAY1),
			line(1) + line(2) + line(2, "-other") + line(3),
		)
		const differing = await readJournalFiles(options(dir, [DAY1]))
		expect(differing.entries.map(e => e.seq)).toEqual([1, 2, 3])
		expect(differing.entries[1]).toEqual(parseLine(line(2).trimEnd()))
		expect(differing.dropped).toBe(1)
		expect(differing.degraded).toBe(true)
	})

	it("a slice clock due after every item yields once per line and entry, and the result is identical", async () => {
		const dir = await tmp()
		let text = ""
		for (let seq = 1; seq <= 40; seq++) text += line(seq)
		await writeFile(join(dir, DAY1), text)
		const quiet = await readJournalFiles(options(dir, [DAY1], { fromSeq: 10 }))
		const clock = everyItem()
		const sliced = await readJournalFiles(
			options(dir, [DAY1], { fromSeq: 10, slice: clock }),
		)
		expect(sliced).toEqual(quiet)
		expect(clock.yields).toBe(40 + 30) // every line read, then every uncovered entry
	})

	it("deadlineSliceClock is due exactly sliceMs after creation or its last yield", async () => {
		const t = { now: 100 }
		const turns = { n: 0 }
		const clock = deadlineSliceClock({
			sliceMs: 8,
			now: () => t.now,
			yieldTurn: () => {
				turns.n++
				return Promise.resolve()
			},
		})
		t.now = 107.999
		expect(clock.due()).toBe(false)
		t.now = 108
		expect(clock.due()).toBe(true)
		await clock.yield()
		expect(turns.n).toBe(1)
		expect(clock.due()).toBe(false) // restarted at 108
		t.now = 116
		expect(clock.due()).toBe(true)
	})

	it("reads the same entries whatever the chunk size cuts through lines and multi-byte characters", async () => {
		// Feature: scanner-store-persistence, Property 1: chunking never changes the journal read
		// Validates: docs/SCANNER.md storage (journal read at load)
		const dir = await tmp()
		const tags = ["", "-東京", "-π🎙", "-ünïcødé", "-𝄞𝄞"]
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.integer({ min: 0, max: tags.length - 1 }), {
					minLength: 1,
					maxLength: 12,
				}),
				fc.integer({ min: 1, max: 300 }),
				fc.integer({ min: 0, max: 12 }),
				async (tagIdx, chunkBytes, fromSeq) => {
					const text = tagIdx
						.map((tag, i) => line(i + 1, tags[tag] ?? ""))
						.join("")
					await writeFile(join(dir, DAY1), text)
					const whole = await readJournalFiles(
						options(dir, [DAY1], { fromSeq, chunkBytes: 1 << 20 }),
					)
					const chunked = await readJournalFiles(
						options(dir, [DAY1], { fromSeq, chunkBytes }),
					)
					expect(chunked).toEqual(whole)
					expect(whole.entries.map(e => e.seq)).toEqual(
						tagIdx.map((_, i) => i + 1).filter(seq => seq > fromSeq),
					)
					expect(whole.entries).toEqual(
						text
							.split("\n")
							.filter(l => l !== "")
							.map(parseLine)
							.filter(e => e !== null && e.seq > fromSeq),
					)
				},
			),
			{ numRuns: 100 },
		)
	})
})
