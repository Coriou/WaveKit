// Feature: web-gaps-3, Property 1: Fair floor
// Validates: Requirements 1.5, 1.6
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	planFairStep,
	waterLevel,
} from "../../../../../src/core/activity/storage/fair-share.js"
import {
	commitActivityBatch,
	openActivityDatabase,
	pruneActivityFair,
} from "../../../../../src/core/activity/storage/database.js"
import { openSqliteFile } from "../../../../../src/core/activity/storage/probe.js"
import { groupedScan, shareRow } from "./retention-helpers.js"

const usagesArb = fc.array(fc.integer({ min: 0, max: 5000 }), {
	minLength: 1,
	maxLength: 8,
})
const sharesOf = (u: readonly number[]) =>
	u.map((rows, i) => ({ key: `s${String(i)}`, rows, bytes: rows * 100 }))

describe("Property 1: Fair floor", () => {
	it("allocates only to shares above the level, within excess and budget", () => {
		fc.assert(
			fc.property(
				usagesArb,
				fc.integer({ min: 0, max: 20000 }),
				fc.integer({ min: 1, max: 600 }),
				(u, target, budget) => {
					const plan = planFairStep({
						shares: sharesOf(u),
						rowTarget: target,
						byteExcess: null,
						budget,
					})
					const level = waterLevel(u, target)
					expect(plan.rowLevel).toBe(level)
					let sum = 0
					for (const a of plan.allocations) {
						const used = u[Number(a.key.slice(1))] ?? 0
						expect(level).not.toBeNull()
						expect(used).toBeGreaterThan(level ?? 0)
						expect(a.rows).toBeGreaterThanOrEqual(1)
						expect(a.rows).toBeLessThanOrEqual(used - (level ?? 0))
						sum += a.rows
					}
					expect(sum).toBeLessThanOrEqual(budget)
					const keys = plan.allocations.map(a => a.key)
					expect(keys).toEqual([...keys].sort())
					if (level !== null) expect(plan.allocations.length).toBeGreaterThan(0)
				},
			),
			{ numRuns: 200 },
		)
	})

	it("byte-cap plans never touch shares at or under the byte level", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						rows: fc.integer({ min: 0, max: 500 }),
						avg: fc.integer({ min: 1, max: 3000 }),
					}),
					{ minLength: 1, maxLength: 8 },
				),
				fc.integer({ min: 0, max: 2_000_000 }),
				fc.integer({ min: 1, max: 300 }),
				(raw, e, budget) => {
					const shares = raw.map((r, i) => ({
						key: `s${String(i)}`,
						rows: r.rows,
						bytes: r.rows * r.avg,
					}))
					const plan = planFairStep({
						shares,
						rowTarget: null,
						byteExcess: e,
						budget,
					})
					let sum = 0
					for (const a of plan.allocations) {
						const s = shares[Number(a.key.slice(1))]
						expect(s).toBeDefined()
						expect(s?.bytes ?? 0).toBeGreaterThan(
							plan.byteLevel ?? Number.POSITIVE_INFINITY,
						)
						expect(a.rows).toBeLessThanOrEqual(s?.rows ?? 0)
						sum += a.rows
					}
					expect(sum).toBeLessThanOrEqual(budget)
				},
			),
			{ numRuns: 200 },
		)
	})

	it("repeated steps converge to the target while keeping every fair floor", () => {
		fc.assert(
			fc.property(
				usagesArb,
				fc.integer({ min: 0, max: 20000 }),
				fc.integer({ min: 1, max: 600 }),
				(u0, target, budget) => {
					const level = waterLevel(u0, target)
					const u = [...u0]
					for (let step = 0; step < 100_000; step++) {
						const plan = planFairStep({
							shares: sharesOf(u),
							rowTarget: target,
							byteExcess: null,
							budget,
						})
						if (plan.allocations.length === 0) break
						for (const a of plan.allocations) {
							const i = Number(a.key.slice(1))
							u[i] = (u[i] ?? 0) - a.rows
						}
					}
					const total = u.reduce((a, b) => a + b, 0)
					expect(total).toBeLessThanOrEqual(Math.max(target, 0) || 0)
					if (level === null) expect(u).toEqual(u0)
					else
						u0.forEach((orig, i) =>
							expect(u[i]).toBeGreaterThanOrEqual(Math.min(orig, level)),
						)
				},
			),
			{ numRuns: 150 },
		)
	})

	it("keeps each share's byte floor over real row sizes when the writer applies a byte plan", async () => {
		// Feature: web-gaps-3, Property 1: Fair floor
		// Validates: Requirements 1.5, 1.6
		const db = await openSqliteFile(":memory:")
		try {
			openActivityDatabase(db)
			await fc.assert(
				fc.asyncProperty(
					fc.array(
						fc.array(fc.integer({ min: 0, max: 6_000 }), {
							minLength: 1,
							maxLength: 10,
						}),
						{ minLength: 2, maxLength: 4 },
					),
					fc.integer({ min: 1, max: 40_000 }),
					fc.integer({ min: 1, max: 30 }),
					fc.boolean(),
					async (blobs, byteExcess, budget, rowCap) => {
						db.exec("DELETE FROM activity_fts")
						db.exec("DELETE FROM activity")
						const rows = blobs.flatMap((sizes, share) =>
							sizes.map((blob, index) =>
								shareRow(`p-${share}-${index}`, `s${share}`, 0, blob),
							),
						)
						expect(commitActivityBatch(db, rows).ok).toBe(true)
						const before = groupedScan(db)
						const usages = [...before].map(([key, v]) => ({ key, ...v }))
						const totalRows = rows.length
						const rowTarget = rowCap ? Math.floor(totalRows / 2) : null
						const plan = planFairStep({
							shares: usages,
							rowTarget,
							byteExcess,
							budget,
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
								shareBytes: before.get(a.key)?.bytes ?? 0,
							})),
							{ rowCount: totalRows, dbBytes: 0 },
						)
						const after = groupedScan(db)
						const deletedBy = new Map<string, number>()
						for (const row of step.deletedRows) {
							const key = `decoder:${row.decoderId ?? ""}`
							deletedBy.set(key, (deletedBy.get(key) ?? 0) + 1)
						}
						for (const [key, was] of before) {
							const now = after.get(key) ?? { rows: 0, bytes: 0 }
							const allocation = plan.allocations.find(a => a.key === key)
							const deleted = deletedBy.get(key) ?? 0
							expect(deleted).toBeLessThanOrEqual(allocation?.rows ?? 0)
							// With both caps, a share's step excess is the larger of the two.
							if (plan.rowLevel !== null && plan.byteLevel === null)
								expect(now.rows).toBeGreaterThanOrEqual(
									Math.min(was.rows, plan.rowLevel),
								)
							// A row beyond the row cap's need is deleted only if the share keeps
							// at least the byte level; only a step's very first row may cross it.
							const minRows = allocation?.minRows ?? 0
							if (
								plan.byteLevel !== null &&
								deleted > minRows &&
								(minRows > 0 || deleted > 1)
							)
								expect(now.bytes).toBeGreaterThanOrEqual(plan.byteLevel)
							if (
								plan.byteLevel !== null &&
								plan.rowLevel === null &&
								deleted > 0
							)
								expect(was.bytes).toBeGreaterThan(plan.byteLevel)
						}
					},
				),
				{ numRuns: 100 },
			)
		} finally {
			db.close()
		}
	}, 20_000)
})
