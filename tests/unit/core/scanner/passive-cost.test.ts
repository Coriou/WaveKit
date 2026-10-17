import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	PASSIVE_PROBATION_MS,
	passiveCostDecision,
	passiveProbationDue,
} from "../../../../src/core/scanner/passive-cost.js"
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

describe("passiveProbationDue (WG11 SC, Main decision M2)", () => {
	const due = { disabled: true, engineOpen: false }
	it("is 15 minutes, three recheck periods", () => {
		expect(PASSIVE_PROBATION_MS).toBe(3 * PASSIVE_COST_RECHECK_MS)
		expect(PASSIVE_PROBATION_MS).toBe(900_000)
	})

	it("is due at the bound and not one millisecond below", () => {
		expect(
			passiveProbationDue({ ...due, sinceDisabledMs: PASSIVE_PROBATION_MS }),
		).toBe(true)
		expect(
			passiveProbationDue({
				...due,
				sinceDisabledMs: PASSIVE_PROBATION_MS - 1,
			}),
		).toBe(false)
	})

	it("is never due for an enabled source, an open engine or an unknown or non-finite time", () => {
		const t = PASSIVE_PROBATION_MS * 2
		expect(
			passiveProbationDue({ ...due, disabled: false, sinceDisabledMs: t }),
		).toBe(false)
		expect(
			passiveProbationDue({ ...due, engineOpen: true, sinceDisabledMs: t }),
		).toBe(false)
		expect(passiveProbationDue({ ...due, sinceDisabledMs: null })).toBe(false)
		expect(
			passiveProbationDue({
				...due,
				sinceDisabledMs: Number.POSITIVE_INFINITY,
			}),
		).toBe(false)
		expect(passiveProbationDue({ ...due, sinceDisabledMs: Number.NaN })).toBe(
			false,
		)
	})

	// Feature: web-gaps-11, Property 5: Passive guard decides by the limit
	// Validates: Requirements 2.2, 2.3
	it("is due exactly for a disabled source with no open engine past the probation", () => {
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.boolean(),
				fc.option(fc.double({ min: -1e7, max: 1e7 }), { nil: null }),
				(disabled, engineOpen, sinceDisabledMs) => {
					const got = passiveProbationDue({
						disabled,
						engineOpen,
						sinceDisabledMs,
					})
					const want =
						disabled &&
						!engineOpen &&
						sinceDisabledMs !== null &&
						Number.isFinite(sinceDisabledMs) &&
						sinceDisabledMs >= 900_000
					expect(got).toBe(want)
				},
			),
			{ numRuns: 200 },
		)
	})
})
