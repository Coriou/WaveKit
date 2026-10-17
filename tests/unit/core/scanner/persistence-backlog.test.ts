/**
 * Bounded scanner persistence backlog (core heap OOM, 2026-10-17): a wide sweep saturated the
 * event loop, the serial disk chain fell behind, and every 10 s tick queued another full-store
 * snapshot text (~25 MB) plus one chain step per journal line until the 2 GB heap ran out. These
 * tests stall the chain and count what stays queued, independent of wall-clock time.
 */
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	SCANNER_JOURNAL_BACKLOG_CODE,
	ScannerPersistence,
} from "../../../../src/core/scanner/store/persistence.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import { createLogger } from "../../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const T0 = Date.UTC(2026, 9, 17, 13, 18, 0)
const entry = (): Omit<JournalEntry, "seq"> => ({
	at: new Date(T0).toISOString(),
	op: "observation",
	payload: { discoveries: [], observations: [], deleted: [] },
})
const snapshot = (hz: number) => ({
	discoveries: [],
	observations: [],
	corrections: [{ sourceId: "src-1", hz }],
})

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "wavekit-backlog-"))
	try {
		return await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

/** An appendFile whose first call blocks until `release()`: the chain stalls behind it. */
function stalledAppend() {
	let release!: () => void
	const gate = new Promise<void>(resolve => {
		release = resolve
	})
	let calls = 0
	const fn = async (path: string, data: string): Promise<void> => {
		calls += 1
		if (calls === 1) await gate
		await appendFile(path, data)
	}
	return { fn, release, calls: () => calls }
}

/** Resolves once `calls()` reached `n`: the chain is inside that write. */
async function until(calls: () => number, n: number): Promise<void> {
	while (calls() < n) await new Promise<void>(resolve => setImmediate(resolve))
}

async function readSnapshotFile(dir: string) {
	return JSON.parse(await readFile(join(dir, "discoveries.json"), "utf8")) as {
		lastSeq: number
		corrections: { sourceId: string; hz: number }[]
	}
}

describe("ScannerPersistence bounded backlog", () => {
	it("keeps at most one queued snapshot text however far a stalled chain falls behind", async () => {
		await withDir(async dir => {
			const stall = stalledAppend()
			const p = new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
				appendFile: stall.fn,
			})
			await p.load()
			const first = p.append(entry())
			const writes: Promise<void>[] = []
			for (let i = 0; i < 100; i++) {
				writes.push(p.writeSnapshot(snapshot(i)))
				expect(p.backlog().snapshots).toBe(1)
			}
			stall.release()
			await first
			// The oldest caller settles only once the newest snapshot is durable.
			await writes[0]
			expect((await readSnapshotFile(dir)).corrections).toEqual([
				{ sourceId: "src-1", hz: 99 },
			])
			await Promise.all(writes)
			expect(p.backlog()).toEqual({
				snapshots: 0,
				snapshotBytes: 0,
				journalLines: 0,
				journalBytes: 0,
				refusedLines: 0,
			})
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(loaded.lastSeq).toBe(1)
			expect(loaded.corrections).toEqual([{ sourceId: "src-1", hz: 99 }])
		})
	})

	it("group-commits the journal lines queued behind a stalled write into one append", async () => {
		await withDir(async dir => {
			const stall = stalledAppend()
			const p = new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
				appendFile: stall.fn,
			})
			await p.load()
			const appends = [p.append(entry())]
			await until(stall.calls, 1)
			for (let i = 0; i < 1000; i++) appends.push(p.append(entry()))
			expect(p.backlog().journalLines).toBe(1000)
			stall.release()
			expect(await Promise.all(appends)).toEqual(
				Array.from({ length: 1001 }, (_, i) => i + 1),
			)
			expect(stall.calls()).toBe(2)
			expect(p.backlog().journalLines).toBe(0)
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(loaded.entries.map(e => e.seq)).toEqual(
				Array.from({ length: 1001 }, (_, i) => i + 1),
			)
		})
	})

	it("refuses appends past the backlog cap and keeps refusing until a snapshot covers the hole", async () => {
		await withDir(async dir => {
			const stall = stalledAppend()
			const cap = 4_000
			const p = new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
				appendFile: stall.fn,
				maxJournalBacklogBytes: cap,
			})
			await p.load()
			const first = p.append(entry())
			await until(stall.calls, 1)
			const appends: Promise<number>[] = []
			for (let i = 0; i < 200; i++) {
				appends.push(p.append(entry()))
				expect(p.backlog().journalBytes).toBeLessThanOrEqual(cap)
			}
			stall.release()
			const outcomes = await Promise.allSettled([first, ...appends])
			const seqs: number[] = []
			let refused = 0
			for (const outcome of outcomes) {
				if (outcome.status === "fulfilled") seqs.push(outcome.value)
				else {
					refused += 1
					expect(outcome.reason).toBeInstanceOf(WaveKitError)
					expect((outcome.reason as WaveKitError).code).toBe(
						SCANNER_JOURNAL_BACKLOG_CODE,
					)
				}
			}
			expect(refused).toBeGreaterThan(150)
			// Only the lines before the first refusal were written: no line past the hole.
			expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1))
			expect(p.backlog()).toMatchObject({
				journalBytes: 0,
				refusedLines: refused,
			})
			// Drained, but the hole is still uncovered: refused until a snapshot covers it.
			await expect(p.append(entry())).rejects.toMatchObject({
				code: SCANNER_JOURNAL_BACKLOG_CODE,
			})
			const covered = p.writeSnapshot(snapshot(7))
			const after = p.append(entry())
			await covered
			expect(await after).toBe(203)
			expect(p.backlog().refusedLines).toBe(0)
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(loaded.lastSeq).toBe(202)
			expect(loaded.entries.map(e => e.seq)).toEqual([203])
		})
	})

	it("never writes a line queued behind a superseded covering snapshot", async () => {
		await withDir(async dir => {
			const stall = stalledAppend()
			const p = new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
				appendFile: stall.fn,
				maxJournalBacklogBytes: 1,
			})
			await p.load()
			// A reserved (recording) append skips the byte cap; the next plain one is refused.
			const first = p.append(entry(), { reserved: true })
			await until(stall.calls, 1)
			await expect(p.append(entry())).rejects.toMatchObject({
				code: SCANNER_JOURNAL_BACKLOG_CODE,
			})
			const s1 = p.writeSnapshot(snapshot(1))
			const behind = p.append(entry(), { reserved: true }) // after s1, before s2
			const s2 = p.writeSnapshot(snapshot(2)) // supersedes s1
			const tail = p.append(entry(), { reserved: true })
			const behindOutcome = behind.then(
				() => "written",
				(err: unknown) => err,
			)
			stall.release()
			expect(await first).toBe(1)
			await Promise.all([s1, s2])
			expect(await behindOutcome).toMatchObject({
				code: SCANNER_JOURNAL_BACKLOG_CODE,
			})
			expect(await tail).toBe(4)
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(loaded.lastSeq).toBe(3)
			expect(loaded.corrections).toEqual([{ sourceId: "src-1", hz: 2 }])
			expect(loaded.entries.map(e => e.seq)).toEqual([4])
		})
	})

	it("an I/O-failed batch is a hole: no batch queued behind it is written until a snapshot covers it", async () => {
		await withDir(async dir => {
			let release!: () => void
			const gate = new Promise<void>(resolve => {
				release = resolve
			})
			let calls = 0
			const p = new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
				appendFile: async (path, data) => {
					calls += 1
					if (calls === 1) await gate
					if (calls === 2) {
						await appendFile(path, data.slice(0, Math.floor(data.length / 2)))
						throw Object.assign(new Error("ENOSPC: no space left on device"), {
							code: "ENOSPC",
						})
					}
					await appendFile(path, data)
				},
			})
			await p.load()
			const first = p.append(entry())
			await until(() => calls, 1)
			const failing = [p.append(entry()), p.append(entry()), p.append(entry())]
			const jobs = p.writeJobs([]) // other chain work closes the batch
			const behind = p.append(entry()) // seq 5: its own batch, queued behind the failing one
			const settled = Promise.allSettled([...failing, behind])
			release()
			expect(await first).toBe(1)
			await jobs
			const outcomes = await settled
			for (const outcome of outcomes.slice(0, 3)) {
				expect(outcome.status).toBe("rejected")
				if (outcome.status === "rejected")
					expect(outcome.reason).toMatchObject({
						code: "SCANNER_PERSIST_FAILED",
					})
			}
			expect(outcomes[3]).toMatchObject({
				status: "rejected",
				reason: { code: SCANNER_JOURNAL_BACKLOG_CODE },
			})
			// Still uncovered: refused until a snapshot covers seqs 2..6.
			await expect(p.append(entry())).rejects.toMatchObject({
				code: SCANNER_JOURNAL_BACKLOG_CODE,
			})
			await p.writeSnapshot(snapshot(3))
			expect(await p.append(entry())).toBe(7)
			const text = await readFile(
				join(dir, "journal", "observations-20261017.jsonl"),
				"utf8",
			)
			expect(
				text
					.split("\n")
					.filter(l => l !== "")
					.map(l => (JSON.parse(l) as { seq: number }).seq),
			).toEqual([1, 7])
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(loaded.lastSeq).toBe(6)
			expect(loaded.entries.map(e => e.seq)).toEqual([7])
			expect(loaded.droppedLines).toBe(0)
		})
	})

	it("charges each queued line 2 bytes per UTF-16 unit plus the per-append overhead against the cap", async () => {
		await withDir(async dir => {
			const stall = stalledAppend()
			const line = `${JSON.stringify({ seq: 2, at: entry().at, op: "observation", payload: entry().payload })}\n`
			const charge = line.length * 2 + 512
			const cap = charge * 10
			const p = new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
				appendFile: stall.fn,
				maxJournalBacklogBytes: cap,
			})
			await p.load()
			const first = p.append(entry())
			await until(stall.calls, 1)
			const queued = Array.from({ length: 20 }, () => p.append(entry()))
			const settled = Promise.allSettled(queued)
			// The in-flight seq 1 stays charged until written; seqs 2..9 share `line`'s length, so
			// 9 charges fit in 10 and seq 10 (one unit longer) does not: the rest is refused.
			expect(p.backlog().journalLines).toBe(8)
			expect(p.backlog().journalBytes).toBe(9 * charge)
			stall.release()
			await first
			const outcomes = await settled
			expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(8)
		})
	})

	it("bounds the queued snapshots to one and replays every accepted entry, for any interleaving", async () => {
		// Feature: core-heap-leak, Property 1: persistence backlog stays bounded and loses nothing accepted
		// Validates: scanner persistence keeps at most one queued snapshot text while stalled
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.oneof(
						fc.constant<"append">("append"),
						fc.constant<"snapshot">("snapshot"),
						fc.constant<"release">("release"),
					),
					{ minLength: 1, maxLength: 60 },
				),
				fc.integer({ min: 200, max: 2_000 }),
				async (ops, cap) => {
					await withDir(async dir => {
						let release: (() => void) | null = null
						const stalled = (): Promise<void> =>
							new Promise<void>(resolve => {
								release = resolve
							})
						let stallNext = true
						const p = new ScannerPersistence({
							dir,
							logger,
							now: () => T0,
							maxJournalBacklogBytes: cap,
							appendFile: async (path, data) => {
								if (stallNext) {
									stallNext = false
									await stalled()
								}
								await appendFile(path, data)
							},
						})
						await p.load()
						const pending: Promise<unknown>[] = []
						const accepted: number[] = []
						let lastSnapshotHz: number | null = null
						let appended = 0
						for (const op of ops) {
							if (op === "append") {
								pending.push(
									p.append(entry()).then(
										seq => accepted.push(seq),
										() => undefined,
									),
								)
								appended += 1
							} else if (op === "snapshot") {
								lastSnapshotHz = appended
								pending.push(p.writeSnapshot(snapshot(appended)))
							} else {
								const r = release as (() => void) | null
								r?.()
								stallNext = true
							}
							expect(p.backlog().snapshots).toBeLessThanOrEqual(1)
						}
						stallNext = false
						const r = release as (() => void) | null
						r?.()
						await Promise.all(pending)
						const loaded = await new ScannerPersistence({
							dir,
							logger,
							now: () => T0,
						}).load()
						const replayed = loaded.entries.map(e => e.seq)
						// Replay never steps over a hole: contiguous from the snapshot on.
						expect(replayed).toEqual(
							replayed.map((_, i) => loaded.lastSeq + 1 + i),
						)
						// Every acknowledged append survives: covered by the snapshot or replayed.
						for (const seq of accepted)
							expect(seq <= loaded.lastSeq || replayed.includes(seq)).toBe(true)
						expect(appended).toBeGreaterThanOrEqual(accepted.length)
						if (lastSnapshotHz !== null)
							expect(loaded.corrections).toEqual([
								{ sourceId: "src-1", hz: lastSnapshotHz },
							])
					})
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)
})
