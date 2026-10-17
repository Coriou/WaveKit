import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { passiveCostDecision } from "../../../../src/core/scanner/passive-cost.js"
import {
	PASSIVE_COST_CLEAR_RATIO,
	PASSIVE_COST_RECHECK_MS,
	PASSIVE_COST_WINDOW_MS,
	type PassiveCostInput,
} from "../../../../src/core/scanner/passive-cost-contract.js"

const base: PassiveCostInput = {
	utilization: 0.1,
	limit: 0.25,
	disabled: false,
	sinceOpenMs: PASSIVE_COST_WINDOW_MS,
	sinceLastCheckMs: null,
}

describe("passiveCostDecision", () => {
	it("keeps at the limit and disables one past it", () => {
		expect(passiveCostDecision({ ...base, utilization: 0.25 })).toBe("keep")
		expect(passiveCostDecision({ ...base, utilization: 0.25 + 1e-9 })).toBe(
			"disable",
		)
	})

	it("clears at 0.8 x limit and keeps one past it", () => {
		const d = { ...base, disabled: true }
		expect(
			passiveCostDecision({
				...d,
				utilization: 0.25 * PASSIVE_COST_CLEAR_RATIO,
			}),
		).toBe("clear")
		expect(
			passiveCostDecision({
				...d,
				utilization: 0.25 * PASSIVE_COST_CLEAR_RATIO + 1e-9,
			}),
		).toBe("keep")
	})

	it("keeps without a reading", () => {
		expect(passiveCostDecision({ ...base, utilization: null })).toBe("keep")
		expect(
			passiveCostDecision({ ...base, utilization: 0.9, sinceOpenMs: null }),
		).toBe("keep")
	})

	it("keeps when the first check is not due", () => {
		expect(
			passiveCostDecision({
				...base,
				utilization: 0.9,
				sinceOpenMs: PASSIVE_COST_WINDOW_MS - 1,
			}),
		).toBe("keep")
	})

	it("keeps when a recheck is not due and decides when it is", () => {
		const r = { ...base, utilization: 0.9, sinceOpenMs: 10_000_000 }
		expect(
			passiveCostDecision({
				...r,
				sinceLastCheckMs: PASSIVE_COST_RECHECK_MS - 1,
			}),
		).toBe("keep")
		expect(
			passiveCostDecision({ ...r, sinceLastCheckMs: PASSIVE_COST_RECHECK_MS }),
		).toBe("disable")
	})

	it("a replaced engine (new open time, no last check) waits for the first window", () => {
		const r = { ...base, utilization: 0.9, sinceLastCheckMs: null }
		expect(passiveCostDecision({ ...r, sinceOpenMs: 5_000 })).toBe("keep")
		expect(
			passiveCostDecision({ ...r, sinceOpenMs: PASSIVE_COST_WINDOW_MS }),
		).toBe("disable")
	})

	it("keeps on non-finite values", () => {
		expect(passiveCostDecision({ ...base, utilization: Number.NaN })).toBe(
			"keep",
		)
		expect(
			passiveCostDecision({ ...base, utilization: 0.9, limit: Number.NaN }),
		).toBe("keep")
		expect(
			passiveCostDecision({ ...base, utilization: Number.POSITIVE_INFINITY }),
		).toBe("keep")
	})
})

// Feature: web-gaps-11, Property 5: Passive guard decides by the limit
// Validates: Requirements 2.1, 2.2, 2.3
describe("Property 5: Passive guard decides by the limit", () => {
	it("a per-source driver disables above the limit, clears at or below 0.8 x limit, never between", () => {
		const step = fc.record({
			dt: fc.integer({ min: 1_000, max: 400_000 }),
			utilization: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), {
				nil: null,
			}),
			replace: fc.boolean(),
		})
		fc.assert(
			fc.property(
				fc.double({ min: 0.05, max: 0.9, noNaN: true }),
				fc.array(step, { minLength: 1, maxLength: 60 }),
				(limit, steps) => {
					let now = 0
					let openedAt = 0
					let lastCheck: number | null = null
					let disabled = false
					for (const s of steps) {
						now += s.dt
						if (s.replace) {
							openedAt = now
							lastCheck = null
						}
						const sinceOpenMs = now - openedAt
						const sinceLastCheckMs = lastCheck === null ? null : now - lastCheck
						const due =
							lastCheck === null
								? sinceOpenMs >= PASSIVE_COST_WINDOW_MS
								: sinceLastCheckMs !== null &&
									sinceLastCheckMs >= PASSIVE_COST_RECHECK_MS
						const decision = passiveCostDecision({
							utilization: s.utilization,
							limit,
							disabled,
							sinceOpenMs,
							sinceLastCheckMs,
						})
						if (s.utilization === null || !due) {
							expect(decision).toBe("keep")
							continue
						}
						lastCheck = now
						if (!disabled && s.utilization > limit)
							expect(decision).toBe("disable")
						else if (
							disabled &&
							s.utilization <= limit * PASSIVE_COST_CLEAR_RATIO
						)
							expect(decision).toBe("clear")
						else expect(decision).toBe("keep")
						if (decision === "disable") disabled = true
						if (decision === "clear") disabled = false
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})
