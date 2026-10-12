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
import { openSqliteFile } from "../../../../../src/core/activity/storage/probe.js"
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
		const dir = await tempDir()
		let caseId = 0
		const maxAgeMs = 200_000
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
				fc.integer({ min: 1, max: 6 }),
				async (ancient, pruneBatchRows) => {
					const dbPath = join(dir, `${caseId++}.db`)
					const db = await openSqliteFile(dbPath)
					openActivityDatabase(db)
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
					const before = readActivityState(db, dbPath)
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
					expect(BigInt(second.watermark) >= BigInt(first.watermark)).toBe(true)
					if (second.changed)
						expect(second.generation).toBe(first.generation + 1)
					else expect(second.generation).toBe(first.generation)
					db.close()
				},
			),
			{ numRuns: 100 },
		)
	}, 10_000)

	it("deletes only the row surplus above the low-water mark", async () => {
		// Feature: event-foundation-batch1, Property 4: row prune stops at the low-water mark
		// Validates: Requirements retention hysteresis
		const dir = await tempDir()
		let caseId = 0
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 24 }),
				fc.integer({ min: 20, max: 80 }),
				fc.integer({ min: 1, max: 10 }),
				async (count, maxRows, pruneBatchRows) => {
					const dbPath = join(dir, `rows-${caseId++}.db`)
					const db = await openSqliteFile(dbPath)
					openActivityDatabase(db)
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
					db.close()
				},
			),
			{ numRuns: 100 },
		)
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
			expect(commitActivityBatch(db, [rowAt("ancient", ancient)]).ok).toBe(
				true,
			)
			// Triggered by the ancient row, but it sits behind a fresher seq, so
			// the prefix deletes only the row already past maxAge and stops.
			const triggered = pruneActivityPrefix(db, limits, NOW)
			expect(triggered.deleted).toBe(1)
			const stuck = db
				.prepare("SELECT event_id FROM activity ORDER BY seq")
				.all()
			expect(stuck).toEqual([
				{ event_id: "fresh" },
				{ event_id: "ancient" },
			])
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

	it("truncates indexed text on UTF-8 boundaries", () => {
		// Feature: event-foundation-batch1, Property 2: UTF-8 truncation stays valid
		// Validates: Requirements storage indexed text
		fc.assert(
			fc.property(
				fc.string({ maxLength: 80 }),
				fc.integer({ min: 0, max: 64 }),
				(value, maxBytes) => {
					const cut = truncateUtf8(value, maxBytes)
					expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(maxBytes)
					expect(Buffer.from(cut, "utf8").toString("utf8")).toBe(cut)
				},
			),
			{ numRuns: 100 },
		)
	})
})

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
