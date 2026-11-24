import { describe, expect, it, vi } from "vitest"
import {
	appendFile,
	mkdtemp,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	journalNamesInOrder,
	journalPartName,
	journalSegmentBytes,
	parseJournalName,
	ScannerPersistence,
} from "../../../../src/core/scanner/store/persistence.js"
import { createLogger } from "../../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const DAY = 86_400_000
const KIB = 1024
const MIB = 1024 * KIB
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const EMPTY_MUTATION = { discoveries: [], observations: [], deleted: [] }
const entry = (at: number): Omit<JournalEntry, "seq"> => ({
	at: new Date(at).toISOString(),
	op: "observation",
	payload: EMPTY_MUTATION,
})
const EMPTY_SNAPSHOT = { discoveries: [], observations: [], corrections: [] }
/** The smallest part (64 KiB floor) and a cap of 8 such parts: 512 KiB. */
const SEGMENT = 64 * KIB
const CAP = 8 * SEGMENT

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "wavekit-journal-cap-"))
	try {
		return await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

async function journalSizes(dir: string): Promise<Map<string, number>> {
	const sizes = new Map<string, number>()
	let names: string[]
	try {
		names = await readdir(join(dir, "journal"))
	} catch {
		return sizes
	}
	for (const name of journalNamesInOrder(names)) {
		// A prune a write queued may delete a part between the listing and its stat.
		const st = await stat(join(dir, "journal", name)).catch(() => null)
		if (st !== null) sizes.set(name, st.size)
	}
	return sizes
}

const total = (sizes: Map<string, number>): number =>
	[...sizes.values()].reduce((s, n) => s + n, 0)

/** `n` appends in one turn (one group-commit batch); resolves with their seqs. */
function burst(
	p: ScannerPersistence,
	at: number,
	n: number,
): Promise<number[]> {
	return Promise.all(Array.from({ length: n }, () => p.append(entry(at))))
}

async function open(
	dir: string,
	clock: { now: number },
	extra: Partial<ConstructorParameters<typeof ScannerPersistence>[0]> = {},
): Promise<{
	p: ScannerPersistence
	loaded: Awaited<ReturnType<ScannerPersistence["load"]>>
}> {
	const p = new ScannerPersistence({
		...extra,
		dir,
		logger,
		now: () => clock.now,
	})
	const loaded = await p.load()
	return { p, loaded }
}

describe("journal part names", () => {
	it("keeps the day's first part on the legacy name and pads later parts", () => {
		expect(journalPartName("20261009", 0)).toBe("observations-20261009.jsonl")
		expect(journalPartName("20261009", 7)).toBe(
			"observations-20261009-0007.jsonl",
		)
		expect(journalPartName("20261009", 12_345)).toBe(
			"observations-20261009-12345.jsonl",
		)
		expect(parseJournalName("observations-20261009.jsonl")).toEqual({
			day: "20261009",
			part: 0,
		})
		expect(parseJournalName("observations-20261009-12345.jsonl")).toEqual({
			day: "20261009",
			part: 12_345,
		})
		expect(parseJournalName("observations-20261009.jsonl.invalid-1")).toBe(null)
		expect(parseJournalName("discoveries.json")).toBe(null)
	})

	it("orders by day then part number, not by string", () => {
		expect(
			journalNamesInOrder([
				"observations-20261010.jsonl",
				"observations-20261009-10000.jsonl",
				"observations-20261009-0002.jsonl",
				"other.txt",
				"observations-20261009.jsonl",
				"observations-20261009-9999.jsonl",
			]),
		).toEqual([
			"observations-20261009.jsonl",
			"observations-20261009-0002.jsonl",
			"observations-20261009-9999.jsonl",
			"observations-20261009-10000.jsonl",
			"observations-20261010.jsonl",
		])
	})

	it("sorts any set of parts by (day, part)", () => {
		// Feature: scanner journal bound, Property 1: part order
		// Validates: Requirements 2
		fc.assert(
			fc.property(
				fc.uniqueArray(
					fc.record({
						day: fc.integer({ min: 0, max: 30 }),
						part: fc.integer({ min: 0, max: 20_000 }),
					}),
					{ selector: r => `${r.day}-${r.part}`, maxLength: 40 },
				),
				items => {
					const stamp = (d: number) =>
						new Date(T0 + d * DAY)
							.toISOString()
							.slice(0, 10)
							.replaceAll("-", "")
					const names = items.map(i => journalPartName(stamp(i.day), i.part))
					const ordered = journalNamesInOrder(names).map(n =>
						parseJournalName(n),
					)
					const expected = [...items]
						.sort((a, b) => a.day - b.day || a.part - b.part)
						.map(i => ({ day: stamp(i.day), part: i.part }))
					expect(ordered).toEqual(expected)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("sizes a part at cap / 8 with a 64 KiB floor", () => {
		// The 64 MiB default: 8 MiB parts; before any cap is known, the same.
		expect(journalSegmentBytes(64 * MIB)).toBe(8 * MIB)
		expect(journalSegmentBytes(null)).toBe(8 * MIB)
		// The 1 MiB minimum cap: 128 KiB.
		expect(journalSegmentBytes(MIB)).toBe(128 * KIB)
		// At the floor (512 KiB / 8 = 64 KiB) and past it.
		expect(journalSegmentBytes(512 * KIB)).toBe(64 * KIB)
		expect(journalSegmentBytes(512 * KIB - 8)).toBe(64 * KIB)
		expect(journalSegmentBytes(0)).toBe(64 * KIB)
	})
})

describe("ScannerPersistence journal size cap within a day", () => {
	it("rolls the current day into parts at the segment size", async () => {
		await withDir(async dir => {
			const clock = { now: T0 }
			const { p } = await open(dir, clock)
			await p.pruneJournal({ maxBytes: CAP, maxAgeDays: 30 })
			// One batch of 100 lines (~10 KiB) per turn: a part ends at most one batch past 64 KiB.
			let batchBytes = 0
			for (let i = 0; i < 30; i++) {
				const before = total(await journalSizes(dir))
				await burst(p, clock.now, 100)
				batchBytes = Math.max(
					batchBytes,
					total(await journalSizes(dir)) - before,
				)
			}
			const sizes = await journalSizes(dir)
			const names = [...sizes.keys()]
			expect(names[0]).toBe("observations-20261009.jsonl")
			expect(names.length).toBeGreaterThan(3)
			for (const [i, name] of names.entries()) {
				expect(parseJournalName(name)).toEqual({ day: "20261009", part: i })
				const size = sizes.get(name) ?? 0
				expect(size).toBeLessThan(SEGMENT + batchBytes)
				expect(batchBytes).toBeLessThan(100 * 128)
				if (i < names.length - 1) expect(size).toBeGreaterThanOrEqual(SEGMENT)
			}
			// Nothing is covered by a snapshot: nothing is deleted, whatever the cap.
			expect(total(sizes)).toBeGreaterThan(CAP / 4)
		})
	})

	it("keeps everything at the bound and drops nothing", async () => {
		await withDir(async dir => {
			const clock = { now: T0 }
			const { p } = await open(dir, clock)
			await burst(p, clock.now, 200)
			await p.writeSnapshot(EMPTY_SNAPSHOT)
			const at = total(await journalSizes(dir))
			expect(await p.pruneJournal({ maxBytes: at, maxAgeDays: 30 })).toEqual({
				deleted: [],
			})
			expect(total(await journalSizes(dir))).toBe(at)
			// One byte under the bound: the covered file goes.
			expect(
				await p.pruneJournal({ maxBytes: at - 1, maxAgeDays: 30 }),
			).toEqual({ deleted: ["observations-20261009.jsonl"] })
		})
	})

	it("trims the oldest covered parts of the current day as it writes, newest kept", async () => {
		await withDir(async dir => {
			const clock = { now: T0 }
			const { p } = await open(dir, clock)
			await p.pruneJournal({ maxBytes: CAP, maxAgeDays: 30 })
			let last = 0
			// A line is under 128 B (`{"seq":N,"at":"<ISO>","op":"observation","payload":{...}}`),
			// so a round of 100 is under 12.8 KB.
			const roundBytes = 100 * 128
			const seen: string[] = []
			// 60 rounds of ~10 KiB, each covered by a snapshot right after: ~600 KiB written, past the
			// 512 KiB cap, all in one UTC day and with no retention pass in between.
			for (let round = 0; round < 60; round++) {
				const seqs = await burst(p, clock.now, 100)
				last = seqs[seqs.length - 1] ?? last
				// Queued behind the prune this round's write may have queued: sizes are stable after it.
				await p.writeSnapshot(EMPTY_SNAPSHOT)
				for (const name of (await journalSizes(dir)).keys())
					if (!seen.includes(name)) seen.push(name)
				// The write's own prune queues behind it: the snapshot after it waited for it, so the
				// journal is within the cap plus the part being written and one round.
				expect(total(await journalSizes(dir))).toBeLessThanOrEqual(
					CAP + SEGMENT + roundBytes,
				)
			}
			const sizes = await journalSizes(dir)
			const remaining = [...sizes.keys()]
			// The oldest parts went, the newest stay, in order, and part 0 is gone.
			expect(remaining).not.toContain("observations-20261009.jsonl")
			expect(remaining).toEqual(seen.slice(seen.length - remaining.length))
			// Every line is covered now: a prune at the cap brings the total under it.
			await p.pruneJournal({ maxBytes: CAP, maxAgeDays: 30 })
			const after = await journalSizes(dir)
			expect(total(after)).toBeLessThanOrEqual(CAP)
			expect(total(after)).toBeGreaterThan(CAP - SEGMENT - roundBytes)
			// A restart replays nothing (all covered) and continues numbering in the last part.
			const reopened = await open(dir, clock)
			expect(reopened.loaded.lastSeq).toBe(last)
			expect(reopened.loaded.entries).toEqual([])
			const lastName = [...after.keys()].at(-1) ?? ""
			const lastPart = parseJournalName(lastName)?.part ?? -1
			await reopened.p.append(entry(clock.now))
			const next = [...(await journalSizes(dir)).keys()].at(-1) ?? ""
			expect(parseJournalName(next)?.part ?? -1).toBeGreaterThanOrEqual(
				lastPart,
			)
		})
	})

	it("never deletes a part holding lines past the durable snapshot", async () => {
		await withDir(async dir => {
			const clock = { now: T0 }
			const { p } = await open(dir, clock)
			await p.pruneJournal({ maxBytes: CAP, maxAgeDays: 30 })
			const seqs: number[] = []
			for (let round = 0; round < 70; round++)
				seqs.push(...(await burst(p, clock.now, 100)))
			// No snapshot: the journal outgrows the cap but every line stays for replay.
			const sizes = await journalSizes(dir)
			expect(total(sizes)).toBeGreaterThan(CAP)
			expect(
				(await p.pruneJournal({ maxBytes: CAP, maxAgeDays: 30 })).deleted,
			).toEqual([])
			// The reader replays across every part in seq order.
			const reopened = await open(dir, clock)
			expect(reopened.loaded.entries.map(e => e.seq)).toEqual(seqs)
			expect(reopened.loaded.droppedLines).toBe(0)
		})
	})

	it("drops old days before any part of the current one", async () => {
		await withDir(async dir => {
			const clock = { now: T0 }
			const { p } = await open(dir, clock)
			// Four days of ~100 KiB each at a 1 MiB cap (128 KiB parts): one or two parts a day.
			const cap = MIB
			await p.pruneJournal({ maxBytes: cap, maxAgeDays: 30 })
			for (let day = 0; day < 4; day++) {
				clock.now = T0 + day * DAY
				for (let r = 0; r < 10; r++) await burst(p, clock.now, 100)
			}
			await p.writeSnapshot(EMPTY_SNAPSHOT)
			const before = await journalSizes(dir)
			const days = new Set(
				[...before.keys()].map(n => parseJournalName(n)?.day),
			)
			expect(days.size).toBe(4)
			// Shrink the cap to just over today's size: older days go first, today stays whole.
			const today = [...before.entries()].filter(
				([n]) => parseJournalName(n)?.day === "20261012",
			)
			const todayBytes = today.reduce((s, [, b]) => s + b, 0)
			const { deleted } = await p.pruneJournal({
				maxBytes: todayBytes,
				maxAgeDays: 30,
			})
			expect(deleted.every(n => parseJournalName(n)?.day !== "20261012")).toBe(
				true,
			)
			expect(deleted).toEqual(journalNamesInOrder(deleted))
			expect([...(await journalSizes(dir)).keys()]).toEqual(
				today.map(([n]) => n),
			)
			// maxAgeDays still applies to parts: 1 day past the last day leaves nothing older.
			clock.now = T0 + 5 * DAY
			await p.append(entry(clock.now))
			await p.writeSnapshot(EMPTY_SNAPSHOT)
			await p.pruneJournal({ maxBytes: 64 * MIB, maxAgeDays: 1 })
			// (The append past the remembered cap already queued a prune that took the old day.)
			expect([...(await journalSizes(dir)).keys()]).toEqual([
				"observations-20261014.jsonl",
			])
		})
	})

	it("loses no uncovered line when appends run while it trims", async () => {
		await withDir(async dir => {
			const clock = { now: T0 }
			const { p } = await open(dir, clock)
			await p.pruneJournal({ maxBytes: CAP, maxAgeDays: 30 })
			const pending: Promise<number>[] = []
			const chores: Promise<unknown>[] = []
			for (let round = 0; round < 80; round++) {
				for (let i = 0; i < 100; i++) pending.push(p.append(entry(clock.now)))
				// Snapshots and prunes interleave with appends that have not been written yet.
				if (round % 3 === 0) chores.push(p.writeSnapshot(EMPTY_SNAPSHOT))
				if (round % 5 === 0)
					chores.push(p.pruneJournal({ maxBytes: CAP, maxAgeDays: 30 }))
				if (round % 7 === 0) await new Promise(r => setImmediate(r))
			}
			const seqs = await Promise.all(pending)
			await Promise.all(chores)
			// The last write may have queued a prune: a chain task after it waits for it.
			await p.writeSettings({})
			expect(new Set(seqs).size).toBe(seqs.length)
			const max = Math.max(...seqs)
			const reopened = await open(dir, clock)
			const { lastSeq, entries } = reopened.loaded
			// Every line the snapshot does not cover is still on disk, in order, none missing.
			expect(entries.map(e => e.seq)).toEqual(
				Array.from({ length: max - lastSeq }, (_, i) => lastSeq + 1 + i),
			)
			expect(reopened.loaded.journalGap).toBeUndefined()
			expect(reopened.loaded.droppedLines).toBe(0)
			// And trimming kept the journal near the cap.
			expect(total(await journalSizes(dir))).toBeLessThanOrEqual(
				CAP + 2 * SEGMENT,
			)
		})
	})

	it("keeps a part a snapshot covers only half of", async () => {
		await withDir(async dir => {
			const clock = { now: T0 }
			const { p } = await open(dir, clock)
			await burst(p, clock.now, 100)
			await p.writeSnapshot(EMPTY_SNAPSHOT)
			// The same part (no cap known yet: 8 MiB parts) gets 100 lines the snapshot misses.
			const seqs = await burst(p, clock.now, 100)
			expect(
				(await p.pruneJournal({ maxBytes: 0, maxAgeDays: 30 })).deleted,
			).toEqual([])
			expect([...(await journalSizes(dir)).keys()]).toEqual([
				"observations-20261009.jsonl",
			])
			const reopened = await open(dir, clock)
			expect(reopened.loaded.entries.map(e => e.seq)).toEqual(seqs)
		})
	})

	it("keeps a part whose only uncovered lines are invalid", async () => {
		await withDir(async dir => {
			const clock = { now: T0 }
			const first = await open(dir, clock)
			await burst(first.p, clock.now, 100)
			await first.p.writeSnapshot(EMPTY_SNAPSHOT)
			// A later part holding one corrupt line past the snapshot (seq 150).
			const later = join(dir, "journal", "observations-20261009-0001.jsonl")
			await writeFile(later, '{"seq":150,"at":"x",CORRUPT\n')
			const { p, loaded } = await open(dir, clock)
			expect(loaded.droppedLines).toBe(1)
			// Part 0 is covered and goes; the corrupt part is not taken for covered.
			expect(
				(await p.pruneJournal({ maxBytes: 0, maxAgeDays: 30 })).deleted,
			).toEqual(["observations-20261009.jsonl"])
			expect([...(await journalSizes(dir)).keys()]).toEqual([
				"observations-20261009-0001.jsonl",
			])
		})
	})

	it("keeps the part number and byte count straight when a new part's first append fails", async () => {
		await withDir(async dir => {
			const clock = { now: T0 }
			let failNewPart = true
			const { p } = await open(dir, clock, {
				appendFile: async (path, data) => {
					if (failNewPart && path.endsWith("-0001.jsonl")) {
						failNewPart = false
						throw Object.assign(new Error("no space"), { code: "ENOSPC" })
					}
					await appendFile(path, data)
				},
			})
			await p.pruneJournal({ maxBytes: CAP, maxAgeDays: 30 })
			while (
				((await journalSizes(dir)).get("observations-20261009.jsonl") ?? 0) <
				SEGMENT
			)
				await burst(p, clock.now, 100)
			// The next batch opens part 1 and fails there: the batch is a hole until a snapshot.
			const failed = await Promise.allSettled([p.append(entry(clock.now))])
			expect(failed[0]?.status).toBe("rejected")
			await p.writeSnapshot(EMPTY_SNAPSHOT)
			const seqs = await burst(p, clock.now, 10)
			const sizes = await journalSizes(dir)
			// Written to part 1 after the failure, not to a skipped part 2.
			expect([...sizes.keys()]).toEqual([
				"observations-20261009.jsonl",
				"observations-20261009-0001.jsonl",
			])
			await p.writeSnapshot(EMPTY_SNAPSHOT)
			// The byte count matches the disk: at the on-disk total nothing goes, one byte under it
			// the oldest covered part does.
			const onDisk = total(sizes)
			expect(
				(await p.pruneJournal({ maxBytes: onDisk, maxAgeDays: 30 })).deleted,
			).toEqual([])
			expect(
				(await p.pruneJournal({ maxBytes: onDisk - 1, maxAgeDays: 30 }))
					.deleted,
			).toEqual(["observations-20261009.jsonl"])
			const reopened = await open(dir, clock)
			expect(reopened.loaded.lastSeq).toBe(seqs.at(-1))
		})
	})
})

describe("ScannerPersistence journal prune guards", () => {
	type PruneCaps = { maxBytes: number; maxAgeDays: number }
	type Pruner = {
		pruneCoveredJournal: (caps: PruneCaps) => Promise<{ deleted: string[] }>
	}

	/** Past the cap with nothing a snapshot covers, then a snapshot: covered parts to delete. */
	async function grownPastCap(
		p: ScannerPersistence,
		dir: string,
	): Promise<void> {
		await p.pruneJournal({ maxBytes: CAP, maxAgeDays: 30 })
		for (let round = 0; round < 70; round++) await burst(p, T0, 100)
		expect(total(await journalSizes(dir))).toBeGreaterThan(CAP)
	}

	it("deletes nothing once ownership is lost, from batches queued before it", async () => {
		await withDir(async dir => {
			const clock = { now: T0 }
			let owned = true
			const { p } = await open(dir, clock, { canPrune: () => owned })
			await grownPastCap(p, dir)
			await p.writeSnapshot(EMPTY_SNAPSHOT)
			const before = await journalSizes(dir)
			// Batches queued while owned, written after the lock is lost: no prune deletes.
			const queued = burst(p, clock.now, 100)
			owned = false
			await queued
			await p.writeSettings({})
			expect(
				(await p.pruneJournal({ maxBytes: CAP, maxAgeDays: 30 })).deleted,
			).toEqual([])
			const after = await journalSizes(dir)
			for (const name of before.keys()) expect(after.has(name)).toBe(true)
		})
	})

	it("deletes nothing when ownership is lost between queueing a prune and its run", async () => {
		await withDir(async dir => {
			const clock = { now: T0 }
			const answers: boolean[] = []
			const { p } = await open(dir, clock, {
				canPrune: () => answers.shift() ?? true,
			})
			await grownPastCap(p, dir)
			await p.writeSnapshot(EMPTY_SNAPSHOT)
			const before = [...(await journalSizes(dir)).keys()]
			// The write's check passes (still owned), the queued prune's own check fails (lost).
			answers.push(true, false)
			await burst(p, clock.now, 100)
			await p.writeSettings({})
			expect(answers).toEqual([])
			const after = [...(await journalSizes(dir)).keys()]
			for (const name of before) expect(after).toContain(name)
			// Control: owned again, the next write's prune deletes covered parts.
			await burst(p, clock.now, 100)
			await p.writeSettings({})
			expect([...(await journalSizes(dir)).keys()]).not.toContain(before[0])
		})
	})

	it("queues no prune per write after one found nothing or failed, until a snapshot covers more", async () => {
		await withDir(async dir => {
			const clock = { now: T0 }
			const { p } = await open(dir, clock)
			// Past the cap and nothing covered: the first prune past the cap found nothing to delete.
			await grownPastCap(p, dir)
			const spy = vi.spyOn(p as unknown as Pruner, "pruneCoveredJournal")
			for (let round = 0; round < 10; round++) await burst(p, clock.now, 100)
			await p.writeSettings({})
			expect(spy).toHaveBeenCalledTimes(0)
			// A snapshot covers more: the next write prunes once, and that prune fails.
			await p.writeSnapshot(EMPTY_SNAPSHOT)
			spy.mockRejectedValueOnce(
				Object.assign(new Error("I/O error"), { code: "EIO" }),
			)
			for (let round = 0; round < 10; round++) await burst(p, clock.now, 100)
			await p.writeSettings({})
			expect(spy).toHaveBeenCalledTimes(1)
			// Only the next snapshot lets a write retry it, and that one deletes.
			await p.writeSnapshot(EMPTY_SNAPSHOT)
			await burst(p, clock.now, 100)
			await p.writeSettings({})
			expect(spy).toHaveBeenCalledTimes(2)
			expect(total(await journalSizes(dir))).toBeLessThanOrEqual(
				CAP + SEGMENT + 100 * 128,
			)
		})
	})
})
