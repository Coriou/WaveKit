// WG15 DQ requirement 8: guard properties (design Properties 17 and 18).
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	PASSIVE_PROBATION_MS,
	passiveCostDecision,
	passiveGuardDecision,
} from "../../../../src/core/scanner/passive-cost.js"
import type {
	PassiveGuardInput,
	PassiveHolders,
} from "../../../../src/core/scanner/passive-cost.js"
import {
	PASSIVE_BASELINE_MAX_AGE_MS,
	PASSIVE_COST_CLEAR_RATIO,
	PASSIVE_COST_WINDOW_MS,
	PASSIVE_SATURATION,
} from "../../../../src/core/scanner/passive-cost-contract.js"
import { PassiveGuard } from "../../../../src/core/scanner/passive-guard.js"

const reading = fc.oneof(
	fc.double({ min: 0, max: 1, noNaN: true }),
	fc.constantFrom(null, Number.NaN, Number.POSITIVE_INFINITY, 0.95, 0.25, 0.2),
)
const inputArb: fc.Arbitrary<PassiveGuardInput> = fc.record({
	enabled: fc.boolean(),
	holders: fc.constantFrom<PassiveHolders>("sole", "shared", "off", "closed"),
	measurement: reading,
	baseline: reading,
	limit: fc.double({ min: 0.05, max: 1, noNaN: true }),
	judgementDue: fc.boolean(),
	baselineWindowAllowed: fc.boolean(),
	trialDue: fc.boolean(),
	probationDue: fc.boolean(),
})

const finite = (x: number | null): x is number =>
	x !== null && Number.isFinite(x)

/** The 8.4 table written out independently, first matching row. */
function table(i: PassiveGuardInput): string {
	if (!i.enabled && i.holders === "closed")
		return i.probationDue ? "clear" : "keep"
	if (!finite(i.measurement)) return "keep"
	const u = i.measurement
	if (i.enabled) {
		if (i.holders === "off" || i.holders === "closed") return "keep"
		if (i.holders === "sole")
			return i.judgementDue && u > i.limit ? "disable" : "keep"
		if (u >= PASSIVE_SATURATION) return "disable"
		if (finite(i.baseline))
			return i.judgementDue && Math.max(0, u - i.baseline) > i.limit
				? "disable"
				: "keep"
		if (u <= i.limit) return "keep"
		return i.baselineWindowAllowed ? "baseline" : "keep"
	}
	if (u <= i.limit * PASSIVE_COST_CLEAR_RATIO) return "clear"
	if (i.trialDue && finite(i.baseline)) return "trial"
	return "keep"
}

describe("passive guard properties", () => {
	it("follows the precedence table", () => {
		// Feature: detection-quality, Property 17: Guard precedence
		// Validates: Requirements 8.4, 8.9
		fc.assert(
			fc.property(inputArb, i => {
				const r = passiveGuardDecision(i)
				expect(r.decision).toBe(table(i))
				if (
					i.enabled &&
					i.holders === "shared" &&
					finite(i.measurement) &&
					i.measurement >= PASSIVE_SATURATION
				)
					expect(r.decision).toBe("disable")
				if (i.measurement === null && i.holders !== "closed")
					expect(r.decision).toBe("keep")
				if (
					i.enabled &&
					i.holders === "sole" &&
					finite(i.measurement) &&
					i.judgementDue
				)
					expect(r.decision).toBe(
						passiveCostDecision({
							utilization: i.measurement,
							limit: i.limit,
							disabled: false,
							sinceOpenMs: PASSIVE_COST_WINDOW_MS,
							sinceLastCheckMs: null,
						}),
					)
			}),
			{ numRuns: 1000 },
		)
	})

	it("bounds the time passive is off for baselines and the trials of a disabled source", () => {
		// Feature: detection-quality, Property 18: Guard duty bounds
		// Validates: Requirements 8.5, 8.6, 8.7, 8.8
		const step = fc.record({
			ms: fc.constantFrom(1000),
			on: fc.double({ min: 0, max: 0.99, noNaN: true }),
			off: fc.double({ min: 0, max: 0.6, noNaN: true }),
			display: fc.boolean(),
			bump: fc.integer({ min: 0, max: 99 }).map(x => x === 0),
		})
		fc.assert(
			fc.property(
				fc.array(step, { minLength: 1, maxLength: 40 }),
				fc.integer({ min: 300, max: 5400 }),
				(pattern, seconds) => {
					const guard = new PassiveGuard()
					const engine = {}
					let t = 0
					let active = 0
					let passive = true
					let generation = 1
					const offMs: number[] = []
					const trials: number[] = []
					let measuringSince: number | null = null
					for (let i = 0; i < seconds; i++) {
						const p = pattern[i % pattern.length]!
						const rate = passive ? Math.max(p.on, p.off) : p.off
						active += rate * 1000
						t += 1000
						if (p.bump && i % 97 === 0) generation += 1
						const a = guard.tick(
							"s",
							{
								engine,
								openedAt: 0,
								consumers: {
									jobs: passive ? ["job:passive-s"] : [],
									displays: ["ws:a"],
								},
								sample: { idle: t - active, active, generation },
								tracked: true,
							},
							t,
							0.25,
						)
						if (a.kind === "measure") {
							passive = false
							measuringSince = t
						} else if (a.kind === "disable") passive = false
						else if (a.kind === "restore") {
							if (measuringSince !== null) offMs.push(t - measuringSince)
							measuringSince = null
							if (a.why === "trial") trials.push(t)
							passive = true
						}
					}
					// 8.8: one baseline window is at most two windows plus a tick; at most one per 30 min
					for (const ms of offMs)
						expect(ms).toBeLessThanOrEqual(2 * PASSIVE_COST_WINDOW_MS + 1000)
					expect(offMs.length).toBeLessThanOrEqual(
						Math.ceil((seconds * 1000) / PASSIVE_BASELINE_MAX_AGE_MS) + 1,
					)
					for (let i = 1; i < trials.length; i++)
						expect(trials[i]! - trials[i - 1]!).toBeGreaterThanOrEqual(
							PASSIVE_PROBATION_MS,
						)
				},
			),
			{ numRuns: 100 },
		)
	})
})
