import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import {
	activityAgeSlackMs,
	activityLowWater,
	commitActivityBatch,
	openActivityDatabase,
	pruneActivityFair,
	readActivityLiveBytes,
	readActivityState,
} from "../../../../../src/core/activity/storage/database.js"
import {
	indivisibleShare,
	planFairStep,
} from "../../../../../src/core/activity/storage/fair-share.js"
import type { ActivityRetentionPolicy } from "../../../../../src/core/activity/storage/contract.js"
import { openSqliteFile } from "../../../../../src/core/activity/storage/probe.js"
import type { SqliteDatabase } from "../../../../../src/core/activity/storage/sqlite.js"
import { createActivitySession } from "../../../../../src/core/activity/storage/writer-session.js"
import type { ActivitySession } from "../../../../../src/core/activity/storage/writer-session.js"
import { envelope, openStore, roots, stores } from "./helpers.js"
import {
	NOW,
	faultyDb,
	groupedScan,
	readMeta,
	seqs,
	shareRow,
	sharesOf,
	smallLimits,
} from "./retention-helpers.js"

afterEach(async () => {
	await Promise.all(
		stores.splice(0).map(store => store.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

function writeOk(
	session: ActivitySession,
	rows: Parameters<ActivitySession["write"]>[0],
) {
	const wrote = session.write(rows, NOW)
	if (!wrote.ok) throw new Error(wrote.message)
	return wrote
}

function busy(prefix: string, count: number, blob = 40) {
	return Array.from({ length: count }, (_, index) =>
		shareRow(`${prefix}-${index}`, "readsb", NOW, blob),
	)
}

function eventIds(db: SqliteDatabase): string[] {
	return db
		.prepare("SELECT event_id FROM activity ORDER BY seq")
		.all()
		.map(row => String(row["event_id"]))
}

describe("fair-share retention examples", () => {
	it("keeps every quiet row while a busy share fills the row cap", async () => {
		const db = await openSqliteFile(":memory:")
		const maxRows = 100
		const session = createActivitySession(
			db,
			":memory:",
			smallLimits({ maxRows, pruneBatchRows: 20 }),
		)
		try {
			const quiet = Array.from({ length: 5 }, (_, index) =>
				shareRow(`page-${index}`, "pocsag"),
			)
			writeOk(session, [...quiet, shareRow("gap-0", null)])
			for (let batch = 0; batch < 10; batch++)
				writeOk(session, busy(`b${batch}`, 30))
			const ids = eventIds(db)
			expect(ids.length).toBeLessThanOrEqual(maxRows)
			for (const page of quiet) expect(ids).toContain(page.eventId)
			expect(ids).toContain("gap-0")
			const meta = readMeta(db)
			expect(meta.pruneWatermark).toBe(0n)
			expect(meta.holeGeneration).toBeGreaterThan(0)
			expect(meta.holeWatermark > 0n).toBe(true)
			const retention = session.snapshot().retention
			expect(retention).toMatchObject({
				policy: "fair-share",
				effective: "fair-share",
				sharesTruncated: false,
				prefixFallbackSteps: 0,
			})
			expect(retention.shares.map(share => share.key)).toEqual([
				"decoder:readsb",
				"decoder:pocsag",
				"kind:ingestion-gap",
			])
			expect(sharesOf(retention.shares)).toEqual(groupedScan(db))
		} finally {
			session.close()
		}
	})

	it("keeps every quiet row while a busy share fills the byte cap", async () => {
		const db = await openSqliteFile(":memory:")
		const maxDbBytes = 400_000
		const session = createActivitySession(
			db,
			":memory:",
			smallLimits({ maxDbBytes, pruneBatchRows: 20 }),
		)
		try {
			const quiet = Array.from({ length: 4 }, (_, index) =>
				shareRow(`page-${index}`, "pocsag"),
			)
			writeOk(session, quiet)
			let pruned = false
			for (let batch = 0; batch < 12; batch++) {
				const wrote = writeOk(session, busy(`b${batch}`, 20, 3_000))
				expect(wrote.snapshot.dbBytes).toBeLessThanOrEqual(maxDbBytes)
				if (wrote.prune.deleted > 0) {
					pruned = true
					expect(wrote.snapshot.dbBytes).toBeLessThanOrEqual(
						activityLowWater(maxDbBytes),
					)
				}
			}
			expect(pruned).toBe(true)
			const ids = eventIds(db)
			for (const page of quiet) expect(ids).toContain(page.eventId)
			expect(sharesOf(session.snapshot().retention.shares)).toEqual(
				groupedScan(db),
			)
		} finally {
			session.close()
		}
	})

	it("age-prunes the same rows under both policies", async () => {
		const maxAgeMs = 100_000
		const ancient = NOW - maxAgeMs - activityAgeSlackMs(maxAgeMs) - 1_000
		const results = new Map<ActivityRetentionPolicy, unknown>()
		for (const policy of ["fair-share", "oldest-first"] as const) {
			const db = await openSqliteFile(":memory:")
			const session = createActivitySession(
				db,
				":memory:",
				smallLimits({ maxAgeMs, retentionPolicy: policy, pruneBatchRows: 3 }),
			)
			try {
				const decoders = ["readsb", "aprs", null, "pocsag"]
				const rows = Array.from({ length: 24 }, (_, index) =>
					shareRow(
						`a-${index}`,
						decoders[index % decoders.length] ?? null,
						index < 10 || index === 15 ? ancient : NOW,
					),
				)
				const wrote = writeOk(session, rows)
				expect(wrote.prune.deleted).toBe(10)
				results.set(policy, {
					ids: eventIds(db),
					prune: wrote.prune,
					meta: readMeta(db),
				})
			} finally {
				session.close()
			}
		}
		expect(results.get("fair-share")).toEqual(results.get("oldest-first"))
	})

	it("leaves the counters untouched when a prune transaction fails", async () => {
		const raw = await openSqliteFile(":memory:")
		let armed = false
		const db = faultyDb(
			raw,
			sql => sql.startsWith("DELETE FROM activity WHERE seq"),
			() => armed,
		)
		const session = createActivitySession(
			db,
			":memory:",
			smallLimits({ maxRows: 40, pruneBatchRows: 10 }),
		)
		try {
			writeOk(session, [shareRow("page", "pocsag"), ...busy("fill", 40)])
			const before = groupedScan(raw)
			const meta = readMeta(raw)
			armed = true
			const failed = writeOk(session, busy("over", 5))
			armed = false
			expect(failed.note).toMatch(/injected failure/)
			expect(failed.prune.deleted).toBe(0)
			expect(readMeta(raw)).toEqual(meta)
			const scan = groupedScan(raw)
			expect(scan.get("decoder:readsb")?.rows).toBe(
				(before.get("decoder:readsb")?.rows ?? 0) + 5,
			)
			expect(sharesOf(failed.snapshot.retention.shares)).toEqual(scan)
			const next = writeOk(session, busy("next", 1))
			expect(next.note).toBeUndefined()
			expect(next.prune.deleted).toBeGreaterThan(0)
			expect(sharesOf(next.snapshot.retention.shares)).toEqual(groupedScan(raw))
		} finally {
			session.close()
		}
	})

	it("runs oldest-first with one note when the seed scan fails", async () => {
		const raw = await openSqliteFile(":memory:")
		let armed = true
		const db = faultyDb(
			raw,
			sql => sql.includes("GROUP BY decoder_id"),
			() => armed,
		)
		const session = createActivitySession(
			db,
			":memory:",
			smallLimits({ maxRows: 30, pruneBatchRows: 50 }),
		)
		armed = false
		try {
			expect(session.snapshot().retention).toEqual({
				policy: "fair-share",
				effective: "oldest-first",
				shares: [],
				sharesTruncated: false,
				prefixFallbackSteps: 0,
			})
			const first = writeOk(session, [
				shareRow("page", "pocsag"),
				...busy("a", 10),
			])
			expect(first.note).toMatch(/seed failed/)
			const second = writeOk(session, busy("b", 30))
			expect(second.note).toBeUndefined()
			// Oldest-first: the page is the oldest row and goes first.
			expect(eventIds(raw)).not.toContain("page")
			expect(readMeta(raw).holeGeneration).toBe(0)
			expect(second.snapshot.retention.effective).toBe("oldest-first")
		} finally {
			session.close()
		}
	})

	it("reseeds when the counters drift from COUNT(*)", async () => {
		const db = await openSqliteFile(":memory:")
		const session = createActivitySession(
			db,
			":memory:",
			smallLimits({ maxRows: 40, pruneBatchRows: 10 }),
		)
		try {
			writeOk(session, [shareRow("page", "pocsag"), ...busy("a", 10)])
			// Rows the session never saw: its counters are now behind COUNT(*).
			expect(
				commitActivityBatch(
					db,
					Array.from({ length: 30 }, (_, index) =>
						shareRow(`hidden-${index}`, "aprs"),
					),
				).ok,
			).toBe(true)
			const wrote = writeOk(session, busy("b", 5))
			expect(wrote.prune.deleted).toBeGreaterThan(0)
			expect(wrote.snapshot.rows).toBeLessThanOrEqual(activityLowWater(40))
			expect(eventIds(db)).toContain("page")
			expect(sharesOf(wrote.snapshot.retention.shares)).toEqual(groupedScan(db))
		} finally {
			session.close()
		}
	})

	it("binds the byte cap through the prefix fallback when no share is above the level", async () => {
		const db = await openSqliteFile(":memory:")
		openActivityDatabase(db)
		const decoders = ["readsb", "aprs", null]
		expect(
			commitActivityBatch(
				db,
				Array.from({ length: 60 }, (_, index) =>
					shareRow(`f-${index}`, decoders[index % 3] ?? null, NOW, 2_000),
				),
			).ok,
		).toBe(true)
		// Record bytes no longer explain the live pages (as with fragmentation).
		db.exec("UPDATE activity SET record_bytes = 0")
		const maxDbBytes = 200_000
		const session = createActivitySession(
			db,
			":memory:",
			smallLimits({ maxDbBytes, pruneBatchRows: 5 }),
		)
		try {
			const wrote = writeOk(session, [shareRow("tick", "readsb")])
			expect(wrote.note).toBeUndefined()
			expect(wrote.prune.deleted).toBeGreaterThan(0)
			expect(wrote.snapshot.dbBytes).toBeLessThanOrEqual(
				activityLowWater(maxDbBytes),
			)
			expect(wrote.snapshot.retention.prefixFallbackSteps).toBeGreaterThan(0)
			expect(sharesOf(wrote.snapshot.retention.shares)).toEqual(groupedScan(db))
		} finally {
			session.close()
		}
	})

	it("fails the step without wrapping when the hole generation is exhausted", async () => {
		const db = await openSqliteFile(":memory:")
		const session = createActivitySession(
			db,
			":memory:",
			smallLimits({ maxRows: 30, pruneBatchRows: 10 }),
		)
		try {
			writeOk(session, [shareRow("page", "pocsag"), ...busy("a", 29)])
			db.exec(
				`UPDATE store_meta SET value = '${Number.MAX_SAFE_INTEGER}' WHERE key = 'holeGeneration'`,
			)
			const before = seqs(db)
			const wrote = writeOk(session, busy("b", 5))
			expect(wrote.note).toMatch(/hole generation is exhausted/)
			expect(wrote.prune.deleted).toBe(0)
			expect(seqs(db).length).toBe(before.length + 5)
			expect(readMeta(db).holeGeneration).toBe(Number.MAX_SAFE_INTEGER)
			expect(sharesOf(wrote.snapshot.retention.shares)).toEqual(groupedScan(db))
		} finally {
			session.close()
		}
	})

	it("refreshes a share's oldest received time after it loses rows", async () => {
		const db = await openSqliteFile(":memory:")
		const session = createActivitySession(
			db,
			":memory:",
			smallLimits({ maxRows: 20, pruneBatchRows: 50 }),
		)
		try {
			writeOk(session, [
				shareRow("page", "pocsag", NOW - 50_000),
				...Array.from({ length: 20 }, (_, index) =>
					shareRow(`r-${index}`, "readsb", NOW - 40_000 + index * 1_000),
				),
			])
			const busyShare = session
				.snapshot()
				.retention.shares.find(share => share.key === "decoder:readsb")
			const firstLeft = db
				.prepare(
					"SELECT received_at_ms FROM activity WHERE decoder_id = 'readsb' ORDER BY seq LIMIT 1",
				)
				.get()?.["received_at_ms"]
			expect(busyShare?.oldestReceivedAt).toBe(
				new Date(Number(firstLeft)).toISOString(),
			)
			expect(busyShare?.oldestReceivedAt).not.toBe(
				new Date(NOW - 40_000).toISOString(),
			)
			expect(
				session
					.snapshot()
					.retention.shares.find(share => share.key === "decoder:pocsag")
					?.oldestReceivedAt,
			).toBe(new Date(NOW - 50_000).toISOString())
		} finally {
			session.close()
		}
	})

	it("lists at most 64 shares, rows descending then key ascending, in store stats", async () => {
		const store = await openStore({
			limits: {
				globalBurst: 10_000,
				decoderBurst: 10_000,
				globalRatePerSec: 10_000,
				decoderRatePerSec: 10_000,
			},
		})
		for (let decoder = 0; decoder < 70; decoder++) {
			const copies = decoder === 7 ? 3 : decoder === 3 ? 2 : 1
			for (let copy = 0; copy < copies; copy++)
				expect(
					store.admit(
						envelope({
							decoderId: `d${String(decoder).padStart(2, "0")}`,
							entityKey: null,
						}),
					).admitted,
				).toBe(true)
		}
		await waitFor(() => (store.stats().rows ?? 0) >= 73)
		const retention = store.stats().retention
		expect(retention?.policy).toBe("fair-share")
		expect(retention?.effective).toBe("fair-share")
		expect(retention?.sharesTruncated).toBe(true)
		expect(retention?.shares).toHaveLength(64)
		expect(
			retention?.shares.slice(0, 3).map(share => [share.key, share.rows]),
		).toEqual([
			["decoder:d07", 3],
			["decoder:d03", 2],
			["decoder:d00", 1],
		])
		expect(retention?.shares[63]?.key).toBe("decoder:d63")
		expect(retention?.shares[0]?.oldestReceivedAt).toBe(
			"2026-10-12T00:00:00.000Z",
		)
	})
})

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !check(); attempt++)
		await new Promise(resolve => setTimeout(resolve, 10))
	expect(check()).toBe(true)
}

// Review round 1 (WG3 F): one regression per finding.
describe("fair-share retention regressions", () => {
	it("deletes by actual record bytes and keeps the byte floor (finding 1)", async () => {
		const db = await openSqliteFile(":memory:")
		try {
			openActivityDatabase(db)
			const rows = [
				shareRow("big", "busy", NOW, 20_000),
				...Array.from({ length: 9 }, (_, index) =>
					shareRow(`small${index}`, "busy", NOW, 10),
				),
				shareRow("quiet", "quiet", NOW, 10),
			]
			expect(commitActivityBatch(db, rows).ok).toBe(true)
			const usage = groupedScan(db)
			const plan = planFairStep({
				shares: [...usage].map(([key, value]) => ({ key, ...value })),
				rowTarget: null,
				byteExcess: rows[0]?.recordBytes ?? 0,
				budget: 500,
			})
			const busyAllocation = plan.allocations.find(
				a => a.key === "decoder:busy",
			)
			expect(busyAllocation?.byteFloor).toBe(plan.byteLevel)
			const step = pruneActivityFair(
				db,
				{ incrementalVacuumPages: 0 },
				plan.allocations.map(a => ({
					decoderId: a.key.slice("decoder:".length),
					kind: "",
					rows: a.rows,
					minRows: a.minRows,
					byteFloor: a.byteFloor,
					shareBytes: usage.get(a.key)?.bytes ?? 0,
				})),
				{ rowCount: rows.length, dbBytes: 0 },
			)
			expect(step.deleted).toBe(1)
			expect(eventIds(db)).not.toContain("big")
			expect(groupedScan(db).get("decoder:busy")?.bytes).toBeGreaterThanOrEqual(
				plan.byteLevel ?? 0,
			)
		} finally {
			db.close()
		}
	})

	it("subtracts committed deletes when incremental_vacuum fails after COMMIT (finding 2)", async () => {
		const raw = await openSqliteFile(":memory:")
		let armed = false
		const db: SqliteDatabase = {
			prepare: sql => raw.prepare(sql),
			close: () => {
				raw.close()
			},
			exec: sql => {
				if (armed && sql.startsWith("PRAGMA incremental_vacuum"))
					throw new Error("injected vacuum failure")
				raw.exec(sql)
			},
		}
		const session = createActivitySession(
			db,
			":memory:",
			smallLimits({
				maxRows: 20,
				incrementalVacuumPages: 1,
				pruneBatchRows: 10,
			}),
		)
		try {
			writeOk(session, [
				shareRow("quiet", "quiet"),
				...Array.from({ length: 19 }, (_, index) =>
					shareRow(`b${index}`, "busy"),
				),
			])
			armed = true
			const wrote = writeOk(session, [shareRow("over", "busy")])
			armed = false
			expect(wrote.prune.deleted).toBeGreaterThan(0)
			expect(wrote.note).toMatch(/incremental vacuum failed/)
			expect(eventIds(raw)).toContain("quiet")
			expect(sharesOf(session.snapshot().retention.shares)).toEqual(
				groupedScan(raw),
			)
		} finally {
			armed = false
			session.close()
		}
	})

	it("checks drift before the one-share shortcut (finding 3)", async () => {
		const db = await openSqliteFile(":memory:")
		const session = createActivitySession(
			db,
			":memory:",
			smallLimits({ maxRows: 20, pruneBatchRows: 10 }),
		)
		try {
			writeOk(session, [shareRow("quiet", "quiet")])
			expect(
				commitActivityBatch(
					db,
					Array.from({ length: 20 }, (_, index) =>
						shareRow(`busy${index}`, "busy"),
					),
				).ok,
			).toBe(true)
			const wrote = writeOk(session, [])
			expect(wrote.prune.deleted).toBeGreaterThan(0)
			expect(eventIds(db)).toContain("quiet")
			expect(sharesOf(session.snapshot().retention.shares)).toEqual(
				groupedScan(db),
			)
		} finally {
			session.close()
		}
	})

	it("re-plans in the same burst after a zero-delete step reseeds (finding 4)", async () => {
		const db = await openSqliteFile(":memory:")
		const maxRows = 20
		const session = createActivitySession(
			db,
			":memory:",
			smallLimits({ maxRows, pruneBatchRows: 10 }),
		)
		try {
			writeOk(session, [
				shareRow("quiet", "quiet"),
				...Array.from({ length: 19 }, (_, index) =>
					shareRow(`busy${index}`, "busy"),
				),
			])
			db.exec(
				"UPDATE activity SET decoder_id = 'renamed' WHERE decoder_id = 'busy'",
			)
			const wrote = writeOk(session, [shareRow("tick", "quiet")])
			expect(wrote.snapshot.rows).toBeLessThanOrEqual(activityLowWater(maxRows))
			expect(eventIds(db)).toContain("quiet")
			expect(sharesOf(session.snapshot().retention.shares)).toEqual(
				groupedScan(db),
			)
		} finally {
			session.close()
		}
	})

	it("credits the row that committed, not a skipped row with the same id (finding 5)", async () => {
		const db = await openSqliteFile(":memory:")
		const session = createActivitySession(db, ":memory:", smallLimits())
		try {
			const skipped = {
				...shareRow("same", "skipped"),
				recordJson: "x".repeat(150 * 1024),
			}
			const wrote = writeOk(session, [skipped, shareRow("same", "committed")])
			expect(wrote.commit.committed).toBe(1)
			expect(wrote.commit.writeFailed).toBe(1)
			expect(sharesOf(wrote.snapshot.retention.shares)).toEqual(groupedScan(db))
			expect(wrote.snapshot.retention.shares.map(share => share.key)).toEqual([
				"decoder:committed",
			])
		} finally {
			session.close()
		}
	})
})

// Review round 2 (WG3 F).
describe("fair-share retention regressions, round 2", () => {
	it("never takes a share below its byte floor, not even for one row", async () => {
		const db = await openSqliteFile(":memory:")
		try {
			openActivityDatabase(db)
			const rows = [
				shareRow("big", "busy", NOW, 20_000),
				...Array.from({ length: 9 }, (_, index) =>
					shareRow(`small${index}`, "busy", NOW, 10),
				),
				shareRow("quiet", "quiet", NOW, 10),
			]
			expect(commitActivityBatch(db, rows).ok).toBe(true)
			const usage = groupedScan(db)
			const plan = planFairStep({
				shares: [...usage].map(([key, value]) => ({ key, ...value })),
				rowTarget: null,
				byteExcess: 1_000,
				budget: 500,
			})
			const step = pruneActivityFair(
				db,
				{ incrementalVacuumPages: 0 },
				plan.allocations.map(a => ({
					decoderId: a.key.slice("decoder:".length),
					kind: "",
					rows: a.rows,
					minRows: a.minRows,
					byteFloor: a.byteFloor,
					shareBytes: usage.get(a.key)?.bytes ?? 0,
				})),
				{ rowCount: rows.length, dbBytes: 0 },
			)
			// The oldest busy row alone would cross the floor: nothing is deleted.
			expect(step.deleted).toBe(0)
			expect(step.changed).toBe(false)
			expect(groupedScan(db).get("decoder:busy")?.bytes).toBeGreaterThanOrEqual(
				plan.byteLevel ?? 0,
			)
		} finally {
			db.close()
		}
	})

	it("binds the byte cap through a counted prefix fallback when every candidate is indivisible", async () => {
		const db = await openSqliteFile(":memory:")
		openActivityDatabase(db)
		expect(
			commitActivityBatch(db, [
				shareRow("quiet", "quiet", NOW, 10),
				shareRow("big", "busy", NOW, 60_000),
				shareRow("small", "busy", NOW, 10),
			]).ok,
		).toBe(true)
		const live = readActivityLiveBytes(db).dbBytes
		const maxDbBytes = live - 1
		const session = createActivitySession(
			db,
			":memory:",
			smallLimits({ maxDbBytes, pruneBatchRows: 50 }),
		)
		try {
			const wrote = writeOk(session, [])
			expect(wrote.note).toBeUndefined()
			expect(wrote.prune.deleted).toBeGreaterThan(0)
			expect(wrote.snapshot.dbBytes).toBeLessThanOrEqual(
				activityLowWater(maxDbBytes),
			)
			expect(wrote.snapshot.retention.prefixFallbackSteps).toBeGreaterThan(0)
			expect(sharesOf(wrote.snapshot.retention.shares)).toEqual(groupedScan(db))
		} finally {
			session.close()
		}
	})

	it("keeps committedMax when a fair prune deletes the newest row", async () => {
		const db = await openSqliteFile(":memory:")
		try {
			openActivityDatabase(db)
			expect(
				commitActivityBatch(db, [
					shareRow("quiet", "quiet", NOW, 10),
					shareRow("big", "busy", NOW, 60_000),
				]).ok,
			).toBe(true)
			expect(readActivityState(db, ":memory:").identity.committedMax).toBe("2")
			const step = pruneActivityFair(
				db,
				{ incrementalVacuumPages: 0 },
				[{ decoderId: "busy", kind: "", rows: 1 }],
				{ rowCount: 2, dbBytes: 0 },
			)
			expect(step.deleted).toBe(1)
			expect(eventIds(db)).toEqual(["quiet"])
			const identity = readActivityState(db, ":memory:").identity
			expect(identity.pruneWatermark).toBe("0")
			expect(identity.holeWatermark).toBe("2")
			// max(MAX(seq) = 1, pruneWatermark, holeWatermark = 2).
			expect(identity.committedMax).toBe("2")
		} finally {
			db.close()
		}
	})
})

// Review round 3 (WG3 F).
describe("fair-share retention regressions, round 3", () => {
	it("tries over-level shares the budget left out before an indivisible step", async () => {
		const db = await openSqliteFile(":memory:")
		openActivityDatabase(db)
		const rows = [
			shareRow("a-big", "a", NOW, 60_000),
			...Array.from({ length: 39 }, (_, index) =>
				shareRow(`a-small${index}`, "a", NOW, 10),
			),
			shareRow("b-small", "b", NOW, 10),
			shareRow("b-big", "b", NOW, 100_000),
		]
		expect(commitActivityBatch(db, rows).ok).toBe(true)
		const usage = groupedScan(db)
		const live = readActivityLiveBytes(db).dbBytes
		// A byte cap whose level sits 5000 B under share a: a's oldest row cannot go.
		const level = (usage.get("decoder:a")?.bytes ?? 0) - 5_000
		let excess = 0
		for (const share of usage.values())
			excess += Math.max(0, share.bytes - level)
		const maxDbBytes = Math.ceil((live - excess) / 0.95)
		expect(live).toBeGreaterThan(maxDbBytes)
		const session = createActivitySession(
			db,
			":memory:",
			smallLimits({ maxDbBytes, pruneBatchRows: 1, pruneBurstBatches: 1 }),
		)
		try {
			const wrote = writeOk(session, [])
			expect(wrote.note).toBeUndefined()
			expect(wrote.prune.deleted).toBe(1)
			// b's small oldest row goes; a's big row is kept and nothing is counted.
			expect(eventIds(db)).toContain("a-big")
			expect(eventIds(db)).not.toContain("b-small")
			expect(wrote.snapshot.retention.prefixFallbackSteps).toBe(0)
			expect(sharesOf(wrote.snapshot.retention.shares)).toEqual(groupedScan(db))
		} finally {
			session.close()
		}
	})

	it("picks the indivisible victim across all over-level shares", () => {
		const shares = [
			{ key: "a", rows: 100, bytes: 20_000 },
			{ key: "b", rows: 1, bytes: 30_000 },
		]
		const plan = planFairStep({
			shares,
			rowTarget: null,
			byteExcess: 12_000,
			budget: 1,
		})
		expect(plan.allocations.map(a => a.key)).not.toContain("b")
		expect(plan.overLevel.map(o => o.key)).toEqual(["b", "a"])
		expect(indivisibleShare(plan, shares)).toBe("b")
	})
})

const COUNT_SQL = "SELECT COUNT(*) AS n FROM activity"

/** Wraps a database and counts how often the full row count is prepared. */
function countingDb(db: SqliteDatabase): {
	db: SqliteDatabase
	counts: { n: number }
} {
	const counts = { n: 0 }
	return {
		counts,
		db: {
			exec: sql => {
				db.exec(sql)
			},
			prepare(sql: string) {
				if (sql === COUNT_SQL) counts.n += 1
				return db.prepare(sql)
			},
			close: () => {
				db.close()
			},
		},
	}
}

// WG3 req 1.13, 1.15 (R1 6): one share costs the same row counts per write as oldest-first.
describe("single-share fair-share cost", () => {
	it("runs COUNT(*) as often per write as oldest-first", async () => {
		const perWrite = async (policy: ActivityRetentionPolicy) => {
			const raw = await openSqliteFile(":memory:")
			const { db, counts } = countingDb(raw)
			const session = createActivitySession(
				db,
				":memory:",
				smallLimits({
					maxRows: 100,
					pruneBatchRows: 20,
					retentionPolicy: policy,
				}),
			)
			try {
				const seen: number[] = []
				for (let batch = 0; batch < 8; batch++) {
					counts.n = 0
					writeOk(session, busy(`${policy}-${batch}`, 30))
					seen.push(counts.n)
				}
				return { seen, rows: eventIds(raw).length }
			} finally {
				session.close()
			}
		}
		const fair = await perWrite("fair-share")
		const oldest = await perWrite("oldest-first")
		expect(fair.rows).toBe(oldest.rows)
		expect(fair.seen).toEqual(oldest.seen)
	})
})
