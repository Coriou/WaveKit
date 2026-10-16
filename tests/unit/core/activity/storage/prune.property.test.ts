import { rm } from "node:fs/promises"
import { join } from "node:path"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import { ACTIVITY_RECORD_VERSION } from "../../../../../src/core/activity/storage/contract.js"
import {
	activityAgeSlackMs,
	activityLowWater,
	commitActivityBatch,
	openActivityDatabase,
	pruneActivityPrefix,
	readActivityState,
} from "../../../../../src/core/activity/storage/database.js"
import { resolveActivityLimits } from "../../../../../src/core/activity/storage/limits.js"
import { openSqliteFile } from "../../../../../src/core/activity/storage/probe.js"
import type { SqliteDatabase } from "../../../../../src/core/activity/storage/sqlite.js"
import { createActivitySession } from "../../../../../src/core/activity/storage/writer-session.js"
import {
	buildActivityRow,
	truncateUtf8,
} from "../../../../../src/core/activity/storage/row.js"
import { createActivityQueryService } from "../../../../../src/core/activity/query/service.js"
import { envelope, logger, openStore, roots, tempDir } from "./helpers.js"

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

const NOW = 1_700_000_000_000

describe("activity retention", () => {
	it("moves the prune watermark only forward", async () => {
		// Feature: event-foundation-batch1, Property 1: prune watermark moves only forward
		// Validates: Requirements retention
		// The prefix prune (oldest-first, and age under both policies) never opens a hole;
		// fair-share hole invariants are in retention-holes.property.test.ts.
		const maxAgeMs = 200_000
		const db = await openSqliteFile(":memory:")
		try {
			openActivityDatabase(db)
			fc.assert(
				fc.property(
					fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
					fc.integer({ min: 1, max: 6 }),
					(ancient, pruneBatchRows) => {
						resetStoredActivity(db)
						const rows = ancient.map((isAncient, index) => {
							const receivedAtMs = isAncient
								? NOW - maxAgeMs - activityAgeSlackMs(maxAgeMs) - 5_000
								: NOW - 1_000
							const stamp = new Date(receivedAtMs).toISOString()
							const eventId = `e-${index}`
							return buildActivityRow({
								version: ACTIVITY_RECORD_VERSION,
								eventId,
								commitSeq: "0",
								producedAt: stamp,
								receivedAt: stamp,
								kind: "decoder-reception",
								payload: envelope({
									eventId,
									title: `tok${index}`,
									receivedAt: stamp,
								}),
							})
						})
						const committed = commitActivityBatch(db, rows)
						expect(committed.ok).toBe(true)
						const before = readActivityState(db, ":memory:")
						const limits = {
							maxRows: 1_000_000,
							maxDbBytes: Number.MAX_SAFE_INTEGER,
							maxAgeMs,
							pruneBatchRows,
							incrementalVacuumPages: 0,
						}
						const first = pruneActivityPrefix(db, limits, NOW)
						const expected = leadingAncient(ancient, pruneBatchRows)
						expect(
							BigInt(first.watermark) >= BigInt(before.identity.pruneWatermark),
						).toBe(true)
						expect(first.deleted).toBe(expected)
						if (expected === 0) {
							expect(first.changed).toBe(false)
							expect(first.watermark).toBe(before.identity.pruneWatermark)
							expect(first.generation).toBe(before.identity.pruneGeneration)
						} else {
							expect(first.changed).toBe(true)
							expect(first.watermark).toBe(String(expected))
							expect(first.generation).toBe(before.identity.pruneGeneration + 1)
						}
						const remaining = ancient.length - expected
						expect(
							db.prepare("SELECT COUNT(*) AS n FROM activity").get()?.["n"],
						).toBe(remaining)
						expect(
							db.prepare("SELECT COUNT(*) AS n FROM activity_fts").get()?.["n"],
						).toBe(remaining)
						const second = pruneActivityPrefix(db, limits, NOW)
						expect(BigInt(second.watermark) >= BigInt(first.watermark)).toBe(
							true,
						)
						if (second.changed)
							expect(second.generation).toBe(first.generation + 1)
						else expect(second.generation).toBe(first.generation)
					},
				),
				{ numRuns: 100 },
			)
		} finally {
			db.close()
		}
	}, 10_000)

	it("deletes only the row surplus above the low-water mark", async () => {
		// Feature: event-foundation-batch1, Property 4: row prune stops at the low-water mark
		// Validates: Requirements retention hysteresis
		const db = await openSqliteFile(":memory:")
		try {
			openActivityDatabase(db)
			fc.assert(
				fc.property(
					fc.integer({ min: 1, max: 24 }),
					fc.integer({ min: 20, max: 80 }),
					fc.integer({ min: 1, max: 10 }),
					(count, maxRows, pruneBatchRows) => {
						resetStoredActivity(db)
						const stamp = new Date(NOW).toISOString()
						const rows = Array.from({ length: count }, (_, index) => {
							const eventId = `r-${index}`
							return buildActivityRow({
								version: ACTIVITY_RECORD_VERSION,
								eventId,
								commitSeq: "0",
								producedAt: stamp,
								receivedAt: stamp,
								kind: "decoder-reception",
								payload: envelope({ eventId, receivedAt: stamp }),
							})
						})
						expect(commitActivityBatch(db, rows).ok).toBe(true)
						const limits = {
							maxRows,
							maxDbBytes: Number.MAX_SAFE_INTEGER,
							maxAgeMs: 86_400_000,
							pruneBatchRows,
							incrementalVacuumPages: 0,
						}
						const pruned = pruneActivityPrefix(db, limits, NOW)
						const budget =
							count > maxRows ? count - activityLowWater(maxRows) : 0
						expect(pruned.deleted).toBe(Math.min(pruneBatchRows, budget))
						const again = pruneActivityPrefix(db, limits, NOW)
						expect(BigInt(again.watermark) >= BigInt(pruned.watermark)).toBe(
							true,
						)
					},
				),
				{ numRuns: 100 },
			)
		} finally {
			db.close()
		}
	}, 10_000)

	it("does not delete a full batch when the store is one row over the cap", async () => {
		const dbPath = join(await tempDir(), "one-over.db")
		const db = await openSqliteFile(dbPath)
		try {
			openActivityDatabase(db)
			const stamp = new Date(NOW).toISOString()
			const count = 101
			const maxRows = 100
			const rows = Array.from({ length: count }, (_, index) => {
				const eventId = `n-${index}`
				return buildActivityRow({
					version: ACTIVITY_RECORD_VERSION,
					eventId,
					commitSeq: "0",
					producedAt: stamp,
					receivedAt: stamp,
					kind: "decoder-reception",
					payload: envelope({ eventId, receivedAt: stamp }),
				})
			})
			expect(commitActivityBatch(db, rows).ok).toBe(true)
			const limits = {
				maxRows,
				maxDbBytes: Number.MAX_SAFE_INTEGER,
				maxAgeMs: 86_400_000,
				pruneBatchRows: 500,
				incrementalVacuumPages: 0,
			}
			const pruned = pruneActivityPrefix(db, limits, NOW)
			expect(pruned.deleted).toBe(count - activityLowWater(maxRows))
			expect(pruned.deleted).toBeLessThan(500)
			const again = pruneActivityPrefix(db, limits, NOW)
			expect(again.changed).toBe(false)
			expect(again.deleted).toBe(0)
		} finally {
			db.close()
		}
	})

	it("holds age pruning until the slack cushion and then deletes down to maxAge", async () => {
		const maxAgeMs = 100_000
		const slack = activityAgeSlackMs(maxAgeMs)
		expect(slack).toBe(60_000)
		const dbPath = join(await tempDir(), "age.db")
		const db = await openSqliteFile(dbPath)
		try {
			openActivityDatabase(db)
			const withinSlack = NOW - maxAgeMs - 10_000
			const fresh = NOW - 1_000
			expect(
				commitActivityBatch(db, [
					rowAt("within-slack", withinSlack),
					rowAt("fresh", fresh),
				]).ok,
			).toBe(true)
			const limits = {
				maxRows: 1_000_000,
				maxDbBytes: Number.MAX_SAFE_INTEGER,
				maxAgeMs,
				pruneBatchRows: 500,
				incrementalVacuumPages: 0,
			}
			expect(pruneActivityPrefix(db, limits, NOW).deleted).toBe(0)
			const ancient = NOW - maxAgeMs - slack - 1_000
			expect(commitActivityBatch(db, [rowAt("ancient", ancient)]).ok).toBe(true)
			// Triggered by the ancient row, but it sits behind a fresher seq, so
			// the prefix deletes only the row already past maxAge and stops.
			const triggered = pruneActivityPrefix(db, limits, NOW)
			expect(triggered.deleted).toBe(1)
			const stuck = db
				.prepare("SELECT event_id FROM activity ORDER BY seq")
				.all()
			expect(stuck).toEqual([{ event_id: "fresh" }, { event_id: "ancient" }])
			expect(pruneActivityPrefix(db, limits, NOW).deleted).toBe(0)
		} finally {
			db.close()
		}
		const ordered = join(await tempDir(), "age-prefix.db")
		const prefixDb = await openSqliteFile(ordered)
		try {
			openActivityDatabase(prefixDb)
			const ancient = NOW - maxAgeMs - slack - 1_000
			const pastMaxAge = NOW - maxAgeMs - 10_000
			const fresh = NOW - 1_000
			expect(
				commitActivityBatch(prefixDb, [
					rowAt("ancient", ancient),
					rowAt("past-max-age", pastMaxAge),
					rowAt("fresh", fresh),
				]).ok,
			).toBe(true)
			const pruned = pruneActivityPrefix(
				prefixDb,
				{
					maxRows: 1_000_000,
					maxDbBytes: Number.MAX_SAFE_INTEGER,
					maxAgeMs,
					pruneBatchRows: 500,
					incrementalVacuumPages: 0,
				},
				NOW,
			)
			expect(pruned.deleted).toBe(2)
			const left = prefixDb
				.prepare("SELECT event_id FROM activity ORDER BY seq")
				.all()
			expect(left).toEqual([{ event_id: "fresh" }])
			expect(
				pruneActivityPrefix(
					prefixDb,
					{
						maxRows: 1_000_000,
						maxDbBytes: Number.MAX_SAFE_INTEGER,
						maxAgeMs,
						pruneBatchRows: 500,
						incrementalVacuumPages: 0,
					},
					NOW,
				).deleted,
			).toBe(0)
		} finally {
			prefixDb.close()
		}
	})

	it("keeps page 2 valid while inflow stays inside the age slack", async () => {
		let clock = NOW
		const store = await openStore({
			now: () => clock,
			limits: {
				retentionPolicy: "oldest-first",
				batchWindowMs: 0,
				maxAgeMs: 1_000,
				globalBurst: 10_000,
				decoderBurst: 10_000,
				globalRatePerSec: 10_000,
				decoderRatePerSec: 10_000,
			},
		})
		const service = createActivityQueryService({
			store,
			logger,
			execution: "inline",
			now: () => clock,
			limits: { snapshotTtlMs: 60_000 },
		})
		try {
			for (let index = 0; index < 6; index++) {
				clock += 100
				const stamp = new Date(clock).toISOString()
				expect(
					store.admit(
						envelope({
							eventId: `e${index}`,
							receivedAt: stamp,
							producedAt: stamp,
						}),
					).admitted,
				).toBe(true)
			}
			const first = await service.search({ query: {}, order: "asc", limit: 2 })
			expect(first.items).toHaveLength(2)
			expect(first.nextPageToken).toEqual(expect.any(String))
			for (let index = 6; index < 10; index++) {
				clock += 100
				const stamp = new Date(clock).toISOString()
				expect(
					store.admit(
						envelope({
							eventId: `e${index}`,
							receivedAt: stamp,
							producedAt: stamp,
						}),
					).admitted,
				).toBe(true)
			}
			const second = await service.search({
				query: {},
				order: "asc",
				limit: 2,
				...(first.nextPageToken ? { pageToken: first.nextPageToken } : {}),
			})
			expect(second.items.length).toBeGreaterThan(0)
			expect(store.identity().pruneWatermark).toBe("0")
			expect(store.identity().pruneGeneration).toBe(0)
		} finally {
			await service.close()
			await store.close()
		}
	})

	it("prunes the row cap in one burst per 5% of inflow", async () => {
		const maxRows = 1_000
		const pruneBatchRows = 10
		const lowWater = activityLowWater(maxRows)
		const surplus = maxRows + 1 - lowWater
		const db = await openSqliteFile(":memory:")
		const session = createActivitySession(
			db,
			":memory:",
			resolveActivityLimits({
				retentionPolicy: "oldest-first",
				maxRows,
				maxAgeMs: 365 * 24 * 60 * 60 * 1000,
				pruneBatchRows,
				pruneBurstBatches: 20,
				pruneBurstMs: 60_000,
				incrementalVacuumPages: 0,
			}),
		)
		try {
			const fill = session.write(
				Array.from({ length: maxRows }, (_, index) => rowAt(`r-${index}`, NOW)),
				NOW,
			)
			expect(fill.ok).toBe(true)
			if (!fill.ok) return
			expect(fill.prune.deleted).toBe(0)
			expect(fill.snapshot.rows).toBe(maxRows)
			const before = fill.snapshot.identity.pruneGeneration
			const crossing = session.write([rowAt("cross", NOW)], NOW)
			expect(crossing.ok).toBe(true)
			if (!crossing.ok) return
			expect(crossing.prune.deleted).toBe(surplus)
			expect(crossing.prune.deleted).toBeGreaterThan(pruneBatchRows)
			expect(crossing.prune.generation).toBe(
				before + Math.ceil(surplus / pruneBatchRows),
			)
			expect(crossing.snapshot.rows).toBe(lowWater)
			const held = crossing.snapshot.identity.pruneWatermark
			const quiet = maxRows - lowWater
			for (let index = 0; index < quiet; index++) {
				const wrote = session.write([rowAt(`q-${index}`, NOW)], NOW)
				expect(wrote.ok).toBe(true)
				if (!wrote.ok) return
				expect(wrote.prune.deleted).toBe(0)
				expect(wrote.prune.watermark).toBe(held)
			}
			expect(session.snapshot().rows).toBe(maxRows)
			const again = session.write([rowAt("cross-2", NOW)], NOW)
			expect(again.ok).toBe(true)
			if (!again.ok) return
			expect(again.prune.deleted).toBe(surplus)
			expect(again.prune.changed).toBe(true)
			expect(again.snapshot.rows).toBe(lowWater)
			expect(BigInt(again.prune.watermark) > BigInt(held)).toBe(true)
		} finally {
			session.close()
		}
	})

	it("stops a prune burst when the time budget is spent and continues later", async () => {
		const maxRows = 1_000
		const pruneBatchRows = 10
		const lowWater = activityLowWater(maxRows)
		let clock = 0
		const raw = await openSqliteFile(":memory:")
		const db: SqliteDatabase = {
			exec(sql) {
				raw.exec(sql)
				if (sql === "COMMIT") clock += 300
			},
			prepare(sql) {
				return raw.prepare(sql)
			},
			close() {
				raw.close()
			},
		}
		const session = createActivitySession(
			db,
			":memory:",
			resolveActivityLimits({
				retentionPolicy: "oldest-first",
				maxRows,
				maxAgeMs: 365 * 24 * 60 * 60 * 1000,
				pruneBatchRows,
				pruneBurstBatches: 20,
				pruneBurstMs: 300,
				incrementalVacuumPages: 0,
			}),
			0,
			0,
			() => clock,
		)
		try {
			const fill = session.write(
				Array.from({ length: maxRows }, (_, index) => rowAt(`t-${index}`, NOW)),
				NOW,
			)
			expect(fill.ok).toBe(true)
			if (!fill.ok) return
			expect(fill.prune.deleted).toBe(0)
			const before = fill.snapshot.identity.pruneGeneration
			const crossing = session.write([rowAt("cross", NOW)], NOW)
			expect(crossing.ok).toBe(true)
			if (!crossing.ok) return
			expect(crossing.prune.deleted).toBe(pruneBatchRows)
			expect(crossing.prune.generation).toBe(before + 1)
			expect(crossing.snapshot.rows).toBe(maxRows + 1 - pruneBatchRows)
			expect(crossing.snapshot.rows).toBeLessThan(maxRows)
			expect(crossing.snapshot.rows).toBeGreaterThan(lowWater)
			const next = session.write([rowAt("next", NOW)], NOW)
			expect(next.ok).toBe(true)
			if (!next.ok) return
			expect(next.prune.deleted).toBe(pruneBatchRows)
			expect(next.snapshot.rows).toBeLessThan(maxRows)
			expect(next.snapshot.rows).toBeGreaterThan(lowWater)
		} finally {
			session.close()
		}
	})

	it("keeps pruning under the row cap across writes when the burst is two batches", async () => {
		const maxRows = 1_000
		const pruneBatchRows = 10
		const lowWater = activityLowWater(maxRows)
		const db = await openSqliteFile(":memory:")
		const session = createActivitySession(
			db,
			":memory:",
			resolveActivityLimits({
				retentionPolicy: "oldest-first",
				maxRows,
				maxAgeMs: 365 * 24 * 60 * 60 * 1000,
				pruneBatchRows,
				pruneBurstBatches: 2,
				pruneBurstMs: 60_000,
				incrementalVacuumPages: 0,
			}),
		)
		try {
			const fill = session.write(
				Array.from({ length: maxRows }, (_, index) => rowAt(`h-${index}`, NOW)),
				NOW,
			)
			expect(fill.ok).toBe(true)
			if (!fill.ok) return
			expect(fill.prune.deleted).toBe(0)
			const crossing = session.write([rowAt("cross", NOW)], NOW)
			expect(crossing.ok).toBe(true)
			if (!crossing.ok) return
			expect(crossing.prune.deleted).toBe(pruneBatchRows * 2)
			expect(crossing.snapshot.rows).toBeLessThan(maxRows)
			expect(crossing.snapshot.rows).toBeGreaterThan(lowWater)
			let wrote = crossing
			let reachedLowWater = false
			for (let step = 0; step < 30 && wrote.prune.deleted > 0; step++) {
				expect(wrote.snapshot.rows).toBeLessThan(maxRows)
				expect(wrote.snapshot.rows).toBeGreaterThanOrEqual(lowWater)
				if (wrote.snapshot.rows === lowWater) reachedLowWater = true
				const next = session.write([rowAt(`h-next-${step}`, NOW)], NOW)
				expect(next.ok).toBe(true)
				if (!next.ok) return
				wrote = next
			}
			expect(reachedLowWater).toBe(true)
			expect(wrote.prune.deleted).toBe(0)
			expect(wrote.snapshot.rows).toBeGreaterThan(lowWater)
			expect(wrote.snapshot.rows).toBeLessThanOrEqual(maxRows)
		} finally {
			session.close()
		}
	})

	it("prunes the byte cap in one burst down to the live-byte low-water mark", async () => {
		const maxDbBytes = 16 * 1024 * 1024
		const lowWater = activityLowWater(maxDbBytes)
		const db = await openSqliteFile(":memory:")
		const session = createActivitySession(
			db,
			":memory:",
			resolveActivityLimits({
				retentionPolicy: "oldest-first",
				maxRows: 100_000,
				maxDbBytes,
				maxAgeMs: 365 * 24 * 60 * 60 * 1000,
				pruneBatchRows: 4,
				pruneBurstBatches: 40,
				pruneBurstMs: 60_000,
				incrementalVacuumPages: 0,
			}),
		)
		try {
			let sawPrune = false
			let quiet = 0
			let second = false
			for (let index = 0; index < 320; index++) {
				const wrote = session.write([fatRow(`b-${index}`, 80_000)], NOW)
				expect(wrote.ok).toBe(true)
				if (!wrote.ok) return
				if (wrote.prune.deleted === 0) {
					if (sawPrune) quiet += 1
					continue
				}
				expect(wrote.snapshot.dbBytes).toBeLessThanOrEqual(lowWater)
				const pages = pragmaValue(db, "page_count")
				const freelist = pragmaValue(db, "freelist_count")
				const pageSize = pragmaValue(db, "page_size")
				expect(wrote.snapshot.dbBytes).toBe((pages - freelist) * pageSize)
				expect(freelist).toBeGreaterThan(0)
				if (sawPrune) {
					expect(quiet).toBeGreaterThan(0)
					second = true
					break
				}
				sawPrune = true
				quiet = 0
			}
			expect(sawPrune).toBe(true)
			expect(second).toBe(true)
		} finally {
			session.close()
		}
	})

	it("truncates indexed text on UTF-8 boundaries", () => {
		// Feature: event-foundation-batch1, Property 2: UTF-8 truncation stays valid
		// Validates: Requirements storage indexed text
		fc.assert(
			fc.property(
				fc.oneof(
					fc.string({ maxLength: 80 }),
					fc.string({ unit: "grapheme", maxLength: 40 }),
				),
				fc.integer({ min: 0, max: 64 }),
				(value, maxBytes) => {
					const cut = truncateUtf8(value, maxBytes)
					expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(maxBytes)
					expect(Buffer.from(cut, "utf8").toString("utf8")).toBe(cut)
					// A prefix of whole code points: nothing becomes U+FFFD, and a
					// cut that lands on a boundary keeps everything before it.
					expect(value.startsWith(cut)).toBe(true)
					const next = [...value.slice(cut.length)][0]
					if (next !== undefined)
						expect(Buffer.byteLength(cut + next, "utf8")).toBeGreaterThan(
							maxBytes,
						)
				},
			),
			{ numRuns: 100 },
		)
	})
})

function resetStoredActivity(db: SqliteDatabase): void {
	const seqs = db.prepare("SELECT seq FROM activity").all()
	const dropFts = db.prepare("DELETE FROM activity_fts WHERE rowid = ?")
	for (const row of seqs) {
		const seq = row["seq"]
		if (typeof seq === "number" || typeof seq === "bigint") dropFts.run(seq)
	}
	if (seqs.length > 0) db.exec("DELETE FROM activity")
	db.exec(
		"UPDATE store_meta SET value = '0' WHERE key IN ('pruneWatermark', 'pruneGeneration')",
	)
	const sequence = db
		.prepare("SELECT 1 AS n FROM sqlite_master WHERE name = 'sqlite_sequence'")
		.get()
	if (sequence) db.exec("DELETE FROM sqlite_sequence WHERE name = 'activity'")
}

function pragmaValue(db: SqliteDatabase, name: string): number {
	const row = db.prepare(`PRAGMA ${name}`).get()
	const value = row?.[name]
	if (typeof value === "number") return value
	if (typeof value === "bigint") return Number(value)
	throw new Error(`missing pragma ${name}`)
}

function fatRow(eventId: string, blobChars = 3_000) {
	const stamp = new Date(NOW).toISOString()
	return buildActivityRow({
		version: ACTIVITY_RECORD_VERSION,
		eventId,
		commitSeq: "0",
		producedAt: stamp,
		receivedAt: stamp,
		kind: "decoder-reception",
		payload: envelope({
			eventId,
			title: eventId,
			receivedAt: stamp,
			decodedData: { blob: "x".repeat(blobChars) },
		}),
	})
}

function leadingAncient(ancient: readonly boolean[], batch: number): number {
	if (!ancient.some(Boolean)) return 0
	let count = 0
	for (const isAncient of ancient) {
		if (count >= batch) break
		if (!isAncient) break
		count += 1
	}
	return count
}

function rowAt(eventId: string, receivedAtMs: number) {
	const stamp = new Date(receivedAtMs).toISOString()
	return buildActivityRow({
		version: ACTIVITY_RECORD_VERSION,
		eventId,
		commitSeq: "0",
		producedAt: stamp,
		receivedAt: stamp,
		kind: "decoder-reception",
		payload: envelope({ eventId, title: eventId, receivedAt: stamp }),
	})
}
