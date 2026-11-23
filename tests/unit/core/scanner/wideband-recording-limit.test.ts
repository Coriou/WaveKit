/**
 * The per-source analog recording limit: the configured budget's cap (widebandRecordingCap), the
 * measured CPU's limit (widebandRecordingLimit, from the efficiency gate's reading), the floor of
 * 2 and the ceiling of 6, and the store's reservation arithmetic that ceiling relies on. Every
 * bound is tested at and past it; the CPU reading is injected (no wall clock).
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	WIDEBAND_CPU_SHARE,
	widebandRecordingCap,
	widebandRecordingLimit,
	widebandSessionCores,
	type RecordingCpuReading,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	ANALOG_RESERVATION_BYTES,
	EVICTION_TARGET_MIN_HEADROOM,
	MAX_ACTIVE_ANALOG_OPERATIONS,
	MAX_ACTIVE_ANALOG_PER_SOURCE,
	MIN_ACTIVE_ANALOG_PER_SOURCE,
	OPERATION_HEADROOM,
} from "../../../../src/core/scanner/store/analog-operations.js"
import {
	CENTRE,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"

const calm = (
	ownCores: number,
	capacityCores = 8,
	guardPercent = 90,
): RecordingCpuReading => ({
	label: "calm",
	ownCores,
	capacityCores,
	guardPercent,
})

describe("the store's ceiling and its reservation arithmetic", () => {
	it("ceiling 6 = 8 operations − the floor of 2; every operation in flight fits the inventory and byte headroom", () => {
		expect(MIN_ACTIVE_ANALOG_PER_SOURCE).toBe(2)
		expect(MAX_ACTIVE_ANALOG_PER_SOURCE).toBe(
			MAX_ACTIVE_ANALOG_OPERATIONS - MIN_ACTIVE_ANALOG_PER_SOURCE,
		)
		expect(MAX_ACTIVE_ANALOG_PER_SOURCE).toBe(6)
		// A second source at its floor fits beside the first at its ceiling: 6 + 2 = 8.
		expect(MAX_ACTIVE_ANALOG_PER_SOURCE + MIN_ACTIVE_ANALOG_PER_SOURCE).toBe(
			MAX_ACTIVE_ANALOG_OPERATIONS,
		)
		// Inventory: retention keeps room for every operation in flight at once.
		expect(OPERATION_HEADROOM).toBe(MAX_ACTIVE_ANALOG_OPERATIONS)
		expect(MAX_ACTIVE_ANALOG_PER_SOURCE).toBeLessThanOrEqual(OPERATION_HEADROOM)
		// Bytes: a retention pass leaves 8 reservations free, the ceiling's 6 among them.
		expect(ANALOG_RESERVATION_BYTES).toBe(1_920_044 + 16_384)
		expect(EVICTION_TARGET_MIN_HEADROOM).toBe(
			MAX_ACTIVE_ANALOG_OPERATIONS * ANALOG_RESERVATION_BYTES,
		)
		expect(
			MAX_ACTIVE_ANALOG_PER_SOURCE * ANALOG_RESERVATION_BYTES,
		).toBeLessThanOrEqual(EVICTION_TARGET_MIN_HEADROOM)
	})
})

describe("widebandRecordingCap (the configured budget's slots)", () => {
	it("floor(0.5 · budget · 1000 / (50 + 9 · Msps)), at least 2, at most 6", () => {
		expect(WIDEBAND_CPU_SHARE).toBe(0.5)
		// Default 1-core budget: floor(500 / 71.6) = 6 at 2.4 Msps; floor(500 / 59.216) = 8 → 6.
		expect(widebandRecordingCap(2_400_000, 1)).toBe(6)
		expect(widebandRecordingCap(1_024_000, 1)).toBe(6)
		// 0.5 core at 2.4 Msps: floor(250 / 71.6) = 3.
		expect(widebandRecordingCap(2_400_000, 0.5)).toBe(3)
		// The floor: floor(50 / 59.216) = 0 → 2.
		expect(widebandRecordingCap(1_024_000, 0.1)).toBe(2)
	})

	it("at and past each bound", () => {
		// Ceiling at 2.4 Msps: 6 slots need 6 · 71.6 / 500 = 0.8592 cores.
		expect(widebandRecordingCap(2_400_000, 0.8592)).toBe(6)
		expect(widebandRecordingCap(2_400_000, 0.8591)).toBe(5)
		// Past the ceiling: 7 · 59.216 / 500 = 0.829 cores would give 7 at 1.024 Msps → 6.
		expect(widebandRecordingCap(1_024_000, 0.83)).toBe(6)
		expect(widebandRecordingCap(1_024_000, 64)).toBe(6)
		// Floor: 3 slots need 3 · 59.216 / 500 = 0.3553 cores (1.024 Msps: 50 + 9.216 ms); under
		// it 2, and never under 2.
		expect(widebandRecordingCap(1_024_000, 0.3553)).toBe(3)
		expect(widebandRecordingCap(1_024_000, 0.3552)).toBe(2)
		expect(widebandRecordingCap(1_024_000, 0)).toBe(2)
	})

	it("a malformed rate or budget is the floor", () => {
		for (const [rate, budget] of [
			[0, 1],
			[-1, 1],
			[Number.NaN, 1],
			[Number.POSITIVE_INFINITY, 1],
			[1_024_000, Number.NaN],
			[1_024_000, Number.POSITIVE_INFINITY],
		] as const)
			expect(widebandRecordingCap(rate, budget)).toBe(2)
	})

	it("a finite rate or budget so large the arithmetic overflows is the floor, not NaN", () => {
		// The property's counterexample (printed rounded as rate 1.997e307, budget 3.595e305, which
		// still compute to 6): just past it, 9 · rate and 500 · budget both overflow to Infinity,
		// and Infinity / Infinity is NaN.
		expect(9 * 1.998e307).toBe(Number.POSITIVE_INFINITY)
		expect(0.5 * 3.596e305 * 1000).toBe(Number.POSITIVE_INFINITY)
		expect(widebandRecordingCap(1.998e307, 3.596e305)).toBe(2)
		// At the printed values nothing overflows: the formula's ceiling.
		expect(widebandRecordingCap(1.997e307, 3.595e305)).toBe(6)
		expect(widebandRecordingCap(Number.MAX_VALUE, Number.MAX_VALUE)).toBe(2)
		// Only the budget overflows (Infinity / finite): the floor too.
		expect(widebandRecordingCap(1_024_000, Number.MAX_VALUE)).toBe(2)
		// Only the rate overflows: finite / Infinity = 0 → the floor.
		expect(widebandRecordingCap(Number.MAX_VALUE, 1)).toBe(2)
		// Just under the overflow the budget still gives the ceiling.
		expect(widebandRecordingCap(1_024_000, 1e300)).toBe(6)
	})
})

describe("widebandRecordingLimit (the measured CPU's limit)", () => {
	const per24 = widebandSessionCores(2_400_000)

	it("calm: active + floor(spare under the guard / cores per recording), up to the cap", () => {
		// 8 cores at 90 %: 7.2 under the guard, 1.2 own, spare 6 → the cap (6).
		expect(widebandRecordingLimit(2_400_000, 1, calm(1.2), 3)).toEqual({
			limit: 6,
			cap: 6,
			shrunk: null,
		})
		// 2 cores at 90 %: 1.8 under the guard; own 1.75 → spare 0.05 < 0.0716: no more than active.
		expect(widebandRecordingLimit(2_400_000, 1, calm(1.75, 2), 3)).toEqual({
			limit: 3,
			cap: 6,
			shrunk: "pressure",
		})
	})

	it("at and past the spare bound: exactly k recordings' cores of spare allow k more", () => {
		// Guard 100 % of 1 core: spare = 1 − own. Two more need 2 · per24 = 0.1432 cores of spare
		// (the 1e-12 relative margin only absorbs the float rounding of 1 − own).
		const at = (spare: number) =>
			widebandRecordingLimit(2_400_000, 1, calm(1 - spare, 1, 100), 2).limit
		expect(per24).toBeCloseTo(0.0716, 12)
		expect(at(2 * per24 * (1 + 1e-12))).toBe(4)
		// A hair less spare: one more only.
		expect(at(2 * per24 * (1 - 1e-9))).toBe(3)
		// Under one recording's cores: none more than running.
		expect(at(per24 * (1 - 1e-9))).toBe(2)
	})

	it("pressure labels shrink to the floor of 2, never below", () => {
		for (const label of ["own-over", "host-busy", "host-busy-unattributed"])
			expect(
				widebandRecordingLimit(2_400_000, 1, { ...calm(0.1), label }, 5),
			).toEqual({ limit: 2, cap: 6, shrunk: "pressure" })
		// Calm with no spare at all and nothing running: still 2.
		expect(widebandRecordingLimit(2_400_000, 1, calm(8, 8, 50), 0).limit).toBe(
			2,
		)
	})

	it("no reading, an unknown label or a malformed one is the floor (the safe answer)", () => {
		const bad: (RecordingCpuReading | null | undefined)[] = [
			null,
			undefined,
			{ ...calm(0.1), label: "unknown" },
			{ ...calm(0.1), label: "something-else" },
			{ ...calm(0.1), ownCores: null },
			{ ...calm(0.1), ownCores: -0.1 },
			{ ...calm(0.1), ownCores: Number.NaN },
			{ ...calm(0.1), capacityCores: null },
			{ ...calm(0.1), capacityCores: 0 },
			{ ...calm(0.1), capacityCores: Number.POSITIVE_INFINITY },
			{ ...calm(0.1), guardPercent: 0 },
			{ ...calm(0.1), guardPercent: 101 },
			{ ...calm(0.1), guardPercent: Number.NaN },
		]
		for (const cpu of bad)
			expect(widebandRecordingLimit(2_400_000, 1, cpu, 4)).toEqual({
				limit: 2,
				cap: 6,
				shrunk: "unknown",
			})
	})

	it("the property's counterexample and other overflows are the floor, never NaN", () => {
		expect(widebandRecordingLimit(1.998e307, 3.596e305, calm(0.1), 2)).toEqual({
			limit: 2,
			cap: 2,
			shrunk: null,
		})
		// A finite capacity whose product with the guard overflows: no evidence, the floor.
		expect(
			widebandRecordingLimit(2_400_000, 1, calm(0.1, Number.MAX_VALUE, 90), 2),
		).toEqual({ limit: 2, cap: 6, shrunk: "unknown" })
		// A huge finite active count with spare: running + room stays finite, the cap.
		expect(
			widebandRecordingLimit(2_400_000, 1, calm(0.1), Number.MAX_VALUE).limit,
		).toBe(6)
	})

	it("a budget whose cap is the floor stays at it, whatever the reading", () => {
		expect(widebandRecordingLimit(1_024_000, 0.1, calm(0), 0)).toEqual({
			limit: 2,
			cap: 2,
			shrunk: null,
		})
	})

	it("property: the limit is always within [2, cap] and never above 6", () => {
		// Feature: simultaneous traffic, Property 1: the recording limit stays in its bounds
		// Validates: Requirements 19.b
		const num = fc.oneof(
			fc.double({ noNaN: false }),
			fc.constant(null),
			fc.integer({ min: -4, max: 64 }),
		)
		fc.assert(
			fc.property(
				fc.oneof(fc.double(), fc.integer({ min: 1, max: 3_200_000 })),
				fc.oneof(fc.double(), fc.double({ min: 0.1, max: 64 })),
				fc.option(
					fc.record({
						label: fc.oneof(
							fc.constantFrom(
								"calm",
								"own-over",
								"host-busy",
								"host-busy-unattributed",
								"unknown",
							),
							fc.string(),
						),
						ownCores: num,
						capacityCores: num,
						guardPercent: fc.oneof(
							fc.double(),
							fc.integer({ min: -5, max: 120 }),
						),
					}),
				),
				fc.oneof(fc.integer({ min: -3, max: 12 }), fc.double()),
				(rate, budget, cpu, active) => {
					const cap = widebandRecordingCap(rate, budget)
					expect(Number.isInteger(cap)).toBe(true)
					const r = widebandRecordingLimit(
						rate,
						budget,
						cpu as RecordingCpuReading | null,
						active,
					)
					expect(r.cap).toBeGreaterThanOrEqual(2)
					expect(r.cap).toBeLessThanOrEqual(6)
					expect(r.limit).toBeGreaterThanOrEqual(2)
					expect(r.limit).toBeLessThanOrEqual(r.cap)
					expect(Number.isInteger(r.limit)).toBe(true)
					if (cpu === null || cpu.label !== "calm") expect(r.limit).toBe(2)
				},
			),
			{
				numRuns: 200,
				// The counterexample that once gave NaN, run first on every seed.
				examples: [
					[1.998e307, 3.596e305, null, 0],
					[
						1.998e307,
						3.596e305,
						{
							label: "calm",
							ownCores: 0,
							capacityCores: 8,
							guardPercent: 90,
						},
						0,
					],
				],
			},
		)
	})
})

describe("the recorder's admission at the limit", () => {
	const tracks = (h: ReturnType<typeof harness>, n: number, from = 0) => {
		for (let i = from; i < from + n; i++)
			h.rec.track(
				input(
					`c${i}`,
					snapshot(`c${i}`, 0, 10, { centreHz: CENTRE + 20_000 * i }),
				),
			)
	}

	it("no reading: the floor of 2, a third is refused:slots", () => {
		const h = harness()
		tracks(h, 3)
		expect(h.rec.activeOn("rtl")).toBe(2)
		expect(h.rec.diagnostics().counts["refused:slots"]).toBe(1)
		expect(h.rec.diagnostics().counts["refused:cpu"]).toBeUndefined()
	})

	it("calm: the cap of 6 at the default budget; a seventh is refused:slots", () => {
		const h = harness({ recordingCpu: () => calm(0.5) })
		tracks(h, 6)
		expect(h.rec.activeOn("rtl")).toBe(6)
		expect(h.rec.diagnostics().counts["refused:slots"]).toBeUndefined()
		tracks(h, 1, 6)
		expect(h.rec.activeOn("rtl")).toBe(6)
		expect(h.rec.diagnostics().counts["refused:slots"]).toBe(1)
	})

	it("pressure: back to 2 for new recordings, running ones kept, refused:cpu; calm again admits", () => {
		let cpu: RecordingCpuReading = calm(0.5)
		const h = harness({ recordingCpu: () => cpu })
		tracks(h, 4)
		expect(h.rec.activeOn("rtl")).toBe(4)
		cpu = { ...calm(0.5), label: "host-busy" }
		tracks(h, 1, 4)
		// Nothing running is stopped; the new one waits (retried on its next snapshot).
		expect(h.rec.activeOn("rtl")).toBe(4)
		expect(["c0", "c1", "c2", "c3"].every(id => h.rec.owns(id))).toBe(true)
		expect(h.rec.owns("c4")).toBe(false)
		expect(h.rec.diagnostics().counts["refused:cpu"]).toBe(1)
		expect(h.rec.diagnostics().counts["refused:slots"]).toBeUndefined()
		cpu = calm(0.5)
		tracks(h, 1, 4)
		expect(h.rec.owns("c4")).toBe(true)
		expect(h.rec.activeOn("rtl")).toBe(5)
	})

	it("a throwing reader counts as none (the floor)", () => {
		const h = harness({
			recordingCpu: () => {
				throw new Error("unreadable")
			},
		})
		tracks(h, 3)
		expect(h.rec.activeOn("rtl")).toBe(2)
		expect(h.rec.limitOn("rtl", 1_024_000).shrunk).toBe("unknown")
	})
})
