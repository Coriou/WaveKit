// Feature: web-gaps-3, Property 1: Fair floor
// Validates: Requirements 1.5, 1.6
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	planFairStep,
	waterLevel,
} from "../../../../../src/core/activity/storage/fair-share.js"

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
})
