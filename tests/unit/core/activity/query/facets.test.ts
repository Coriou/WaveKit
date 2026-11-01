import { DatabaseSync } from "node:sqlite"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import { ACTIVITY_FACETS_INDEX } from "../../../../../src/core/activity/storage/contract.js"
import { ActivityQueryInvalidError } from "../../../../../src/core/activity/query/errors.js"
import { ActivitySnapshotResetError } from "../../../../../src/core/activity/query/errors.js"
import type { ActivityQueryService } from "../../../../../src/core/activity/storage/contract.js"
import {
	createFixture,
	delay,
	openQueryService,
	type ActivityFixture,
} from "./fixture.js"

describe("activity facets", () => {
	let fixture: ActivityFixture | undefined
	let service: ActivityQueryService | undefined

	afterEach(async () => {
		await service?.close()
		await fixture?.close()
		service = undefined
		fixture = undefined
	})

	it("rejects more than five dimensions, duplicates, and an empty list", async () => {
		fixture = await createFixture()
		service = openQueryService(fixture)
		await expect(
			service.facets({
				query: {},
				dimensions: [
					"category",
					"protocol",
					"decoderId",
					"sourceId",
					"kind",
					"kind",
				],
			}),
		).rejects.toBeInstanceOf(ActivityQueryInvalidError)
		await expect(
			service.facets({ query: {}, dimensions: ["kind", "kind"] }),
		).rejects.toBeInstanceOf(ActivityQueryInvalidError)
		await expect(
			service.facets({ query: {}, dimensions: [] }),
		).rejects.toBeInstanceOf(ActivityQueryInvalidError)
	})

	it("caps values at 32 and sorts ties by value, keeping nulls first", async () => {
		fixture = await createFixture()
		service = openQueryService(fixture, {
			limits: { facetScan: 100, facetValues: 32 },
		})
		for (let index = 0; index < 40; index += 1) {
			const protocol = index === 0 ? null : `p${String(index).padStart(2, "0")}`
			fixture.insert({
				eventId: `e${index}`,
				protocol,
				kind: index % 2 === 0 ? "decoder-reception" : "ingestion-gap",
			})
		}
		const result = await service.facets({
			query: {},
			dimensions: ["protocol", "kind"],
		})
		expect(result.truncated).toBe(false)
		expect(result.scanned).toBe(40)
		const protocols = result.facets["protocol"] ?? []
		expect(protocols).toHaveLength(32)
		expect(protocols[0]).toEqual({ value: null, count: 1 })
		expect(protocols.map(entry => entry.value).slice(1, 3)).toEqual([
			"p01",
			"p02",
		])
		expect(protocols.some(entry => entry.value === "p39")).toBe(false)
		const kinds = result.facets["kind"] ?? []
		expect(kinds[0]?.count).toBeGreaterThanOrEqual(kinds[1]?.count ?? 0)
	})

	it("marks counts as a lower bound when the scan cap is hit", async () => {
		fixture = await createFixture()
		service = openQueryService(fixture, {
			limits: { facetScan: 3, facetValues: 32 },
		})
		fixture.insert({ eventId: "old", kind: "ingestion-gap", protocol: "old" })
		fixture.insert({ eventId: "a", kind: "decoder-reception", protocol: "ais" })
		fixture.insert({ eventId: "b", kind: "decoder-reception", protocol: "ais" })
		fixture.insert({
			eventId: "c",
			kind: "decoder-reception",
			protocol: "acars",
		})
		const result = await service.facets({
			query: {},
			dimensions: ["kind", "protocol"],
		})
		expect(result.truncated).toBe(true)
		expect(result.scanned).toBe(3)
		expect(result.facets["kind"]).toEqual([
			{ value: "decoder-reception", count: 3 },
		])
		const protocols = result.facets["protocol"] ?? []
		expect(protocols).toEqual([
			{ value: "ais", count: 2 },
			{ value: "acars", count: 1 },
		])
		expect(result.snapshot.lowBarrier).toBe("0")
	})

	it("does not mark a scan truncated when the row count equals the cap", async () => {
		fixture = await createFixture()
		service = openQueryService(fixture, {
			limits: { facetScan: 3, facetValues: 32 },
		})
		fixture.insert({ eventId: "a", protocol: "ais" })
		fixture.insert({ eventId: "b", protocol: "ais" })
		fixture.insert({ eventId: "c", protocol: "acars" })
		const result = await service.facets({ query: {}, dimensions: ["protocol"] })
		expect(result.truncated).toBe(false)
		expect(result.scanned).toBe(3)
		expect(result.facets["protocol"]).toEqual([
			{ value: "ais", count: 2 },
			{ value: "acars", count: 1 },
		])
	})

	it("examines only the open snapshot and resets when the lower bound moves", async () => {
		fixture = await createFixture()
		const store = fixture
		store.insert({ eventId: "pruned", protocol: "gone" })
		store.insert({ eventId: "kept", protocol: "ais" })
		store.pruneThrough("1")
		service = openQueryService(store, {
			readerDelayMs: () => 20,
		})
		const visible = service.facets({ query: {}, dimensions: ["protocol"] })
		await delay(5)
		store.setIdentity({ pruneWatermark: "2" })
		await expect(visible).rejects.toBeInstanceOf(ActivitySnapshotResetError)
		store.setIdentity({ pruneWatermark: "1" })
		await service.close()
		service = openQueryService(store)
		const again = await service.facets({ query: {}, dimensions: ["protocol"] })
		expect(again.scanned).toBe(1)
		expect(again.facets["protocol"]).toEqual([{ value: "ais", count: 1 }])
		expect(again.snapshot.lowBarrier).toBe("1")
	})

	it("counts like a row-by-row reference, with and without the covering index", async () => {
		// Feature: longevity, Property 2: facets results match a reference and do not depend on the facets index
		// Validates: Requirements B.1, B.4
		const categories = ["aircraft", "paging", "marine"] as const
		const protocols = ["adsb", "pocsag", null] as const
		const rows = fc.array(
			fc.record({
				category: fc.constantFrom(...categories),
				protocol: fc.constantFrom(...protocols),
				decoderId: fc.constantFrom("d1", "d2", null),
				producedOffset: fc.integer({ min: 0, max: 3_600_000 }),
			}),
			{ minLength: 0, maxLength: 30 },
		)
		await fc.assert(
			fc.asyncProperty(
				rows,
				fc.integer({ min: 1, max: 40 }),
				fc.option(fc.integer({ min: 0, max: 3_600_000 }), { nil: null }),
				async (inserts, scanCap, fromOffset) => {
					const indexed = await createFixture({ memory: true })
					const plain = await createFixture({
						memory: true,
						facetsIndex: false,
					})
					const base = Date.parse("2026-10-01T00:00:00.000Z")
					for (const [index, row] of inserts.entries()) {
						for (const target of [indexed, plain])
							target.insert({
								eventId: `e${index}`,
								category: row.category,
								protocol: row.protocol,
								decoderId: row.decoderId,
								producedAt: new Date(base + row.producedOffset).toISOString(),
							})
					}
					const query =
						fromOffset === null
							? {}
							: {
									producedAt: {
										from: new Date(base + fromOffset).toISOString(),
									},
								}
					const request = {
						query,
						dimensions: ["category", "protocol", "decoderId", "kind"] as const,
					}
					const limits = { limits: { facetScan: scanCap, facetValues: 32 } }
					const withIndex = openQueryService(indexed, limits)
					const withoutIndex = openQueryService(plain, limits)
					try {
						const a = await withIndex.facets({
							...request,
							dimensions: [...request.dimensions],
						})
						const b = await withoutIndex.facets({
							...request,
							dimensions: [...request.dimensions],
						})
						expect(a.facets).toEqual(b.facets)
						expect(a.scanned).toBe(b.scanned)
						expect(a.truncated).toBe(b.truncated)
						// Reference: newest first, filtered, the first scanCap rows, counted in JS.
						const matching = inserts
							.map((row, seq) => ({ ...row, seq }))
							.filter(
								row => fromOffset === null || row.producedOffset >= fromOffset,
							)
							.reverse()
						const scannedRows = matching.slice(0, scanCap)
						expect(a.truncated).toBe(matching.length > scanCap)
						expect(a.scanned).toBe(scannedRows.length)
						const reference = (
							pickValue: (row: (typeof scannedRows)[number]) => string | null,
						) => {
							const counts = new Map<string | null, number>()
							for (const row of scannedRows) {
								const value = pickValue(row)
								counts.set(value, (counts.get(value) ?? 0) + 1)
							}
							return [...counts.entries()]
								.map(([value, count]) => ({ value, count }))
								.sort((l, r) =>
									l.count !== r.count
										? r.count - l.count
										: l.value === r.value
											? 0
											: l.value === null
												? -1
												: r.value === null
													? 1
													: l.value < r.value
														? -1
														: 1,
								)
						}
						expect(a.facets["category"]).toEqual(reference(row => row.category))
						expect(a.facets["protocol"]).toEqual(reference(row => row.protocol))
						expect(a.facets["decoderId"]).toEqual(
							reference(row => row.decoderId),
						)
					} finally {
						await withIndex.close()
						await withoutIndex.close()
						await indexed.close()
						await plain.close()
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	it("reads the covering index once it exists and the row scan before", async () => {
		fixture = await createFixture()
		fixture.insert({ eventId: "a", protocol: "ais" })
		const db = new DatabaseSync(fixture.dbPath)
		try {
			// The facets statement of query/read.ts, with a time scope.
			const sql =
				"EXPLAIN QUERY PLAN WITH scan AS (SELECT seq, category AS category, protocol AS protocol FROM activity WHERE seq > ? AND seq <= ? AND produced_at_ms >= ? ORDER BY seq DESC LIMIT ?) SELECT category, protocol, COUNT(*) AS n, MIN(seq) AS low FROM scan GROUP BY category, protocol"
			const plan = () =>
				db
					.prepare(sql)
					.all(0, 10, 0, 50_001)
					.map(row => String(row["detail"]))
					.join(" ")
			expect(plan()).toContain(`USING COVERING INDEX ${ACTIVITY_FACETS_INDEX}`)
			db.exec(`DROP INDEX ${ACTIVITY_FACETS_INDEX}`)
			expect(plan()).not.toContain(ACTIVITY_FACETS_INDEX)
		} finally {
			db.close()
		}
		service = openQueryService(fixture)
		const result = await service.facets({ query: {}, dimensions: ["protocol"] })
		expect(result.facets["protocol"]).toEqual([{ value: "ais", count: 1 }])
	})
})
