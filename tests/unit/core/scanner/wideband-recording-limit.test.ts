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
	WIDEBAND_PROBE_ROOM_CORES,
	widebandRecordingCap,
	widebandRecordingLimit,
	widebandRecordingRoomCores,
	widebandSessionCores,
	type RecordingCpuReading,
	type WidebandTrackInput,
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
	FS,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"

const calm = (
	ownCores: number,
	capacityCores = 8,
	guardPercent = 90,
	hostPercent = 0,
): RecordingCpuReading => ({
	label: "calm",
	ownCores,
	capacityCores,
	guardPercent,
	hostPercent,
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
	it("floor(0.25 · budget · 1000 / (50 + 9 · Msps)), at least 2, at most 6", () => {
		expect(WIDEBAND_CPU_SHARE).toBe(0.25)
		// Default 1-core budget: floor(250 / 71.6) = 3 at 2.4 Msps; floor(250 / 59.216) = 4.
		expect(widebandRecordingCap(2_400_000, 1)).toBe(3)
		expect(widebandRecordingCap(1_024_000, 1)).toBe(4)
		// 2 cores at 2.4 Msps: floor(500 / 71.6) = 6; 0.5 core: floor(125 / 71.6) = 1 → 2.
		expect(widebandRecordingCap(2_400_000, 2)).toBe(6)
		expect(widebandRecordingCap(2_400_000, 0.5)).toBe(2)
		// The floor: floor(25 / 59.216) = 0 → 2.
		expect(widebandRecordingCap(1_024_000, 0.1)).toBe(2)
	})

	it("at and past each bound", () => {
		// Ceiling at 2.4 Msps: 6 slots need 6 · 71.6 / 250 = 1.7184 cores.
		expect(widebandRecordingCap(2_400_000, 1.7184)).toBe(6)
		expect(widebandRecordingCap(2_400_000, 1.7183)).toBe(5)
		// Past the ceiling: 7 · 59.216 / 250 = 1.658 cores would give 7 at 1.024 Msps → 6.
		expect(widebandRecordingCap(1_024_000, 1.66)).toBe(6)
		expect(widebandRecordingCap(1_024_000, 64)).toBe(6)
		// Floor: 3 slots need 3 · 59.216 / 250 = 0.7106 cores (1.024 Msps: 50 + 9.216 ms); under
		// it 2, and never under 2.
		expect(widebandRecordingCap(1_024_000, 0.7106)).toBe(3)
		expect(widebandRecordingCap(1_024_000, 0.7105)).toBe(2)
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
	const per24 = widebandRecordingRoomCores(2_400_000)

	it("a recording's room cost is its measured whole cost: 0.10 cores at 1.024 Msps, more than the chain", () => {
		expect(widebandRecordingRoomCores(1_024_000)).toBeCloseTo(0.1, 12)
		expect(widebandRecordingRoomCores(2_400_000)).toBeCloseTo(0.112384, 12)
		expect(widebandRecordingRoomCores(2_400_000)).toBeGreaterThan(
			widebandSessionCores(2_400_000),
		)
	})

	it("spent room under the same reading lowers the limit; negative or malformed spent counts as none", () => {
		// 1 core at 100 %, 2.5 recordings' room: 2 more than running, 1 once one was spent.
		const cpu = calm(1 - 2.5 * per24, 1, 100)
		expect(widebandRecordingLimit(2_400_000, 1, cpu, 2).limit).toBe(4)
		expect(widebandRecordingLimit(2_400_000, 1, cpu, 3, per24).limit).toBe(4)
		expect(widebandRecordingLimit(2_400_000, 1, cpu, 4, 2 * per24).limit).toBe(
			4,
		)
		expect(widebandRecordingLimit(2_400_000, 1, cpu, 2, 2 * per24).limit).toBe(
			2,
		)
		for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY])
			expect(widebandRecordingLimit(2_400_000, 1, cpu, 2, bad).limit).toBe(4)
	})

	it("calm: active + floor(spare under the guard / cores per recording), up to 6, above the budget's slots", () => {
		// 8 cores at 90 %: 7.2 under the guard, 1.2 own, spare 6 → the ceiling (6), above the
		// budget's 3 slots at 2.4 Msps.
		expect(widebandRecordingLimit(2_400_000, 1, calm(1.2), 3)).toEqual({
			limit: 6,
			cap: 3,
			shrunk: null,
		})
		// 2 cores at 90 %: 1.8 under the guard; own 1.75 → spare 0.05 < 0.1124: no more than active.
		expect(widebandRecordingLimit(2_400_000, 1, calm(1.75, 2), 3)).toEqual({
			limit: 3,
			cap: 3,
			shrunk: "pressure",
		})
	})

	it("at and past the spare bound: exactly k recordings' cores of spare allow k more", () => {
		// Guard 100 % of 1 core: spare = 1 − own. Two more need 2 · per24 = 0.2248 cores of spare
		// (the 1e-12 relative margin only absorbs the float rounding of 1 − own).
		const at = (spare: number) =>
			widebandRecordingLimit(2_400_000, 1, calm(1 - spare, 1, 100), 2).limit
		expect(per24).toBeCloseTo(0.112384, 12)
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
			).toEqual({ limit: 2, cap: 3, shrunk: "pressure" })
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
				cap: 3,
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
		).toEqual({ limit: 2, cap: 3, shrunk: "unknown" })
		// A huge finite active count with spare: running + room stays finite, the cap.
		expect(
			widebandRecordingLimit(2_400_000, 1, calm(0.1), Number.MAX_VALUE).limit,
		).toBe(6)
	})

	it("the host's room: min(own spare, (guard − host) / 100 · capacity), at and past the host bound", () => {
		// 8 cores at an 85 % guard, own 0.5: own spare 6.3 cores; the host's spare binds.
		const at = (hostPercent: number) =>
			widebandRecordingLimit(2_400_000, 1, calm(0.5, 8, 85, hostPercent), 2)
		// Host 84 % of an 85 % guard: 8 · 1 / 100 = 0.08 cores, under one recording (0.1124).
		expect(at(84)).toEqual({ limit: 2, cap: 3, shrunk: "pressure" })
		// Exactly two recordings' room left by the host (the 1e-10 relative margin only absorbs
		// the float rounding of 85 − host): two more; a hair less, one more.
		const hostFor = (k: number, margin: number) =>
			85 - (100 * k * per24 * (1 + margin)) / 8
		expect(at(hostFor(2, 1e-10)).limit).toBe(4)
		expect(at(hostFor(2, -1e-8)).limit).toBe(3)
		// At the guard: no room; past it (a calm label the gate would not give): none, the floor.
		expect(at(85).limit).toBe(2)
		expect(at(86).limit).toBe(2)
		// A quiet host: the own spare and the cap bound it.
		expect(at(0)).toEqual({ limit: 6, cap: 3, shrunk: null })
		// The own spare still binds when it is the smaller: 1 core at 100 %, host 0.
		expect(
			widebandRecordingLimit(2_400_000, 1, calm(1 - 1.5 * per24, 1, 100, 0), 2)
				.limit,
		).toBe(3)
	})

	it("calm without a usable host reading gives no room above the floor (unknown)", () => {
		const bad: (number | null | undefined)[] = [
			undefined,
			null,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]
		for (const hostPercent of bad) {
			const reading: RecordingCpuReading = {
				label: "calm",
				ownCores: 0.5,
				capacityCores: 8,
				guardPercent: 85,
				...(hostPercent === undefined ? {} : { hostPercent }),
			}
			expect(widebandRecordingLimit(2_400_000, 1, reading, 4)).toEqual({
				limit: 2,
				cap: 3,
				shrunk: "unknown",
			})
		}
	})

	it("host-busy-unattributed (no own reading) is pressure, not an absent reading", () => {
		const reading: RecordingCpuReading = {
			label: "host-busy-unattributed",
			ownCores: null,
			capacityCores: null,
			guardPercent: 85,
			hostPercent: 99,
		}
		expect(widebandRecordingLimit(2_400_000, 1, reading, 2)).toEqual({
			limit: 2,
			cap: 3,
			shrunk: "pressure",
		})
		// Any pressure label with malformed fields is still pressure.
		for (const label of ["own-over", "host-busy"])
			expect(
				widebandRecordingLimit(
					2_400_000,
					1,
					{ ...reading, label, guardPercent: Number.NaN },
					2,
				).shrunk,
			).toBe("pressure")
	})

	it("a budget whose cap is the floor stays at it, whatever the reading", () => {
		expect(widebandRecordingLimit(1_024_000, 0.1, calm(0), 0)).toEqual({
			limit: 2,
			cap: 2,
			shrunk: null,
		})
	})

	it("property: the limit is always within [2, 6], 2 when the budget's slots are, 2 without a calm reading", () => {
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
						hostPercent: num,
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
					expect(r.limit).toBeLessThanOrEqual(6)
					if (r.cap === 2) expect(r.limit).toBe(2)
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
							hostPercent: 0,
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

	it("calm: 6 at the default budget (above its 4 slots, no shared budget held); a seventh is refused:slots", () => {
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

	it("host-busy-unattributed: a third is refused:cpu, not refused:slots", () => {
		const h = harness({
			recordingCpu: () => ({
				label: "host-busy-unattributed",
				ownCores: null,
				capacityCores: null,
				guardPercent: 85,
				hostPercent: 99,
			}),
		})
		tracks(h, 3)
		expect(h.rec.activeOn("rtl")).toBe(2)
		expect(h.rec.diagnostics().counts["refused:cpu"]).toBe(1)
		expect(h.rec.diagnostics().counts["refused:slots"]).toBeUndefined()
	})

	it("a host busy with other work keeps a calm core at the floor (refused:cpu)", () => {
		// Own 0.5 of 8 cores, host 84 % of an 85 % guard: 0.08 cores of host room.
		const h = harness({ recordingCpu: () => calm(0.5, 8, 85, 84) })
		tracks(h, 3)
		expect(h.rec.activeOn("rtl")).toBe(2)
		expect(h.rec.diagnostics().counts["refused:cpu"]).toBe(1)
	})

	it("above the budget's slots a start keeps a probe's room free in the shared budget, at and past the bound", () => {
		expect(WIDEBAND_PROBE_ROOM_CORES).toBeCloseTo(0.6, 12)
		const cores = widebandSessionCores(FS)
		// A shared budget holding the engine's 0.08 cores; reservations sum against `budget`.
		const shared = (budget: number) => {
			let used = 0.08
			const asked: number[] = []
			return {
				asked,
				reserveCores: (c: number) => {
					asked.push(c)
					if (used + c > budget + 1e-9) return null
					used += c
					return () => {
						used -= c
					}
				},
			}
		}
		// Default 1-core budget at 1.024 Msps: 4 slots (0.237), then a fifth (0.317 + 0.0592 +
		// 0.6 = 0.976 ≤ 1), a sixth would leave less than a probe's room: refused:cpu.
		const one = shared(1)
		const h = harness({
			recordingCpu: () => calm(0.5),
			reserveCores: one.reserveCores,
		})
		tracks(h, 6)
		expect(h.rec.activeOn("rtl")).toBe(5)
		expect(h.rec.diagnostics().counts["refused:cpu"]).toBe(1)
		// Within the slots only its own cores are asked; above them, its cores and a probe's room.
		expect(one.asked.slice(0, 4).every(c => c === cores)).toBe(true)
		expect(one.asked[4]).toBeCloseTo(cores + WIDEBAND_PROBE_ROOM_CORES, 12)
		// At the bound: exactly a sixth plus a probe's room fits; a hair under it does not.
		const exact = 0.08 + 6 * cores + WIDEBAND_PROBE_ROOM_CORES
		const at = harness({
			recordingCpu: () => calm(0.5),
			reserveCores: shared(exact).reserveCores,
		})
		tracks(at, 6)
		expect(at.rec.activeOn("rtl")).toBe(6)
		const past = harness({
			recordingCpu: () => calm(0.5),
			reserveCores: shared(exact - 1e-6).reserveCores,
		})
		tracks(past, 6)
		expect(past.rec.activeOn("rtl")).toBe(5)
		expect(past.rec.diagnostics().counts["refused:cpu"]).toBe(1)
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

describe("the recorder's limit under a shrink, a shared reading and the store's overall limit", () => {
	const SHADOW: Partial<WidebandTrackInput> = {
		analogFm: false,
		shadowAllowed: true,
		discoveryId: null,
	}
	const at = (
		h: ReturnType<typeof harness>,
		id: string,
		i: number,
		sourceId = "rtl",
		extra: Partial<WidebandTrackInput> = {},
	) =>
		h.rec.track(
			input(
				id,
				snapshot(id, 0, 10, { centreHz: CENTRE + 20_000 * i, sourceId }),
				{ sourceId, ...extra },
			),
		)
	const counts = (h: ReturnType<typeof harness>) => h.rec.diagnostics().counts
	// One recording's room at the harness rate (1.024 Msps): 0.10 cores.
	const per = widebandRecordingRoomCores(FS)
	/** 1 core at a 100 % guard with `room` + 0.5 recordings' cores spare. */
	const roomOf = (room: number, sampledAt = 1): RecordingCpuReading => ({
		...calm(1 - (room + 0.5) * per, 1, 100),
		sampledAt,
	})

	it("over the limit after a shrink: nothing evicted, no held file released, the candidate waits refused:cpu", () => {
		let cpu: RecordingCpuReading = calm(0.5)
		const h = harness({ recordingCpu: () => cpu })
		for (let i = 0; i < 5; i++) at(h, `c${i}`, i)
		at(h, "s5", 5, "rtl", SHADOW)
		expect(h.rec.activeOn("rtl")).toBe(6)
		// A held file of c0 (its grace timer pending): releasing it would be seen by its cancel.
		const internals = h.rec as unknown as {
			sessions: Map<string, { owner: string }>
			held: Map<object, { s: unknown; cancel: () => void }>
		}
		const c0 = [...internals.sessions.values()].find(s => s.owner === "c0")
		expect(c0).toBeDefined()
		let cancelled = 0
		internals.held.set(
			{},
			{
				s: c0,
				cancel: () => {
					cancelled++
				},
			},
		)
		cpu = { ...calm(0.5), label: "host-busy" }
		for (let k = 0; k < 3; k++) at(h, "v", 6)
		expect(cancelled).toBe(0)
		expect(internals.held.size).toBe(1)
		for (const id of ["c0", "c1", "c2", "c3", "c4", "s5"])
			expect(h.rec.owns(id)).toBe(true)
		expect(h.rec.owns("v")).toBe(false)
		expect(h.rec.activeOn("rtl")).toBe(6)
		// The same refusal of one observation counts once (RecorderDecisions), retried each time.
		expect(counts(h)["refused:cpu"]).toBe(1)
		expect(counts(h)["refused:slots"]).toBeUndefined()
		internals.held.clear()
	})

	it("over the limit without a reading: the candidate waits refused:slots, nothing evicted", () => {
		let cpu: RecordingCpuReading | null = calm(0.5)
		const h = harness({ recordingCpu: () => cpu })
		for (let i = 0; i < 3; i++) at(h, `c${i}`, i)
		at(h, "s3", 3, "rtl", SHADOW)
		cpu = null
		at(h, "v", 6)
		at(h, "v", 6)
		expect(h.rec.owns("s3")).toBe(true)
		expect(h.rec.owns("v")).toBe(false)
		expect(counts(h)["refused:slots"]).toBe(1)
		expect(counts(h)["refused:cpu"]).toBeUndefined()
	})

	it("exactly at the limit an analog candidate still evicts the shadow (one eviction makes room)", () => {
		const h = harness()
		at(h, "c0", 0)
		at(h, "s1", 1, "rtl", SHADOW)
		at(h, "v", 2)
		expect(h.rec.owns("s1")).toBe(false)
		expect(h.rec.owns("v")).toBe(true)
	})

	it("one reading's room is spent once on one source: at most room starts above the floor", () => {
		// Feature: simultaneous traffic, Property 2: a calm reading's room is spent once
		// Validates: Requirements 19.b
		const h = harness({ recordingCpu: () => roomOf(2) })
		for (let i = 0; i < 7; i++) at(h, `c${i}`, i)
		// 2 at the floor (free) + the room of 2: at room, then past it refused:cpu.
		expect(h.rec.activeOn("rtl")).toBe(4)
		expect(counts(h)["refused:cpu"]).toBe(3)
		expect(h.rec.limitOn("rtl", FS)).toEqual({
			limit: 4,
			cap: 4,
			shrunk: "pressure",
		})
	})

	it("two sources share one reading's room: split, not doubled", () => {
		const h = harness({ recordingCpu: () => roomOf(2) })
		// Interleaved: each source's third start spends one of the room's two, the fourths wait.
		for (let i = 0; i < 4; i++) {
			at(h, `a${i}`, i, "rtl")
			at(h, `b${i}`, i + 4, "b")
		}
		// Each keeps its floor of 2; the room of 2 went once: one to each source.
		expect(h.rec.activeOn("rtl")).toBe(3)
		expect(h.rec.activeOn("b")).toBe(3)
		expect(h.rec.activeOn("rtl") + h.rec.activeOn("b")).toBe(2 + 2 + 2)
		expect(counts(h)["refused:cpu"]).toBe(2)
	})

	it("a new reading resets the spent room; the same values without a sample time are the same reading", () => {
		let cpu: RecordingCpuReading = roomOf(1, 1)
		const h = harness({ recordingCpu: () => cpu })
		for (let i = 0; i < 4; i++) at(h, `c${i}`, i)
		expect(h.rec.activeOn("rtl")).toBe(3)
		// The same sample read again: nothing more.
		cpu = { ...roomOf(1, 1) }
		at(h, "c4", 4)
		expect(h.rec.activeOn("rtl")).toBe(3)
		// A new sample (the earlier starts now in its ownCores) leaves room for one more.
		cpu = roomOf(1, 2)
		at(h, "c4", 4)
		at(h, "c5", 5)
		expect(h.rec.activeOn("rtl")).toBe(4)
		// Without a sample time the values name the reading: equal values are the same one,
		// changed ones a new one.
		const values: RecordingCpuReading = calm(1 - 1.5 * per, 1, 100)
		cpu = values
		at(h, "c5", 5)
		expect(h.rec.activeOn("rtl")).toBe(5)
		cpu = { ...values }
		at(h, "c6", 6)
		expect(h.rec.activeOn("rtl")).toBe(5)
		cpu = { ...values, ownCores: values.ownCores! - 0.001 }
		at(h, "c6", 6)
		expect(h.rec.activeOn("rtl")).toBe(6)
	})

	it("the store's overall limit reached: refused:slots (retried), never a store refusal", () => {
		let held = 8
		const h = harness({
			recordingCpu: () => calm(0.5),
			analogActive: () => held,
		})
		at(h, "c0", 0)
		expect(h.rec.owns("c0")).toBe(false)
		expect(counts(h)["refused:slots"]).toBe(1)
		expect(counts(h)["refused:store"]).toBeUndefined()
		// At and past the limit: 9 is refused too; one under it starts.
		held = 9
		at(h, "c0", 0)
		expect(h.rec.owns("c0")).toBe(false)
		held = 7
		at(h, "c0", 0)
		expect(h.rec.owns("c0")).toBe(true)
		expect(counts(h)["refused:slots"]).toBe(1)
	})

	it("one source at its ceiling of 6 and another at 2: a third voice on the second waits refused:slots", () => {
		const h = harness({ recordingCpu: () => calm(0.5) })
		for (let i = 0; i < 6; i++) at(h, `a${i}`, i, "rtl")
		at(h, "b0", 6, "b")
		at(h, "b1", 7, "b")
		expect(h.rec.activeOn("rtl")).toBe(6)
		expect(h.rec.activeOn("b")).toBe(2)
		// The second source's limit allows more, but all 8 operations would be taken.
		expect(h.rec.limitOn("b", FS).limit).toBe(6)
		at(h, "b2", 8, "b")
		at(h, "b2", 8, "b")
		expect(h.rec.owns("b2")).toBe(false)
		expect(counts(h)["refused:slots"]).toBe(1)
		expect(counts(h)["refused:store"]).toBeUndefined()
		// A shadow is not counted: it holds no operation and may never need one.
		at(h, "s3", 9, "b", SHADOW)
		expect(h.rec.owns("s3")).toBe(true)
		// Classed while every operation is held: it keeps its session and is never refused by
		// the store (its operation waits for one to end: the voiced case below).
		at(h, "s3", 9, "b", { discoveryId: "d_1" })
		expect(h.rec.owns("s3")).toBe(true)
		expect(counts(h)["refused:store"]).toBeUndefined()
		expect(h.ops.some(op => op.denied)).toBe(false)
	})

	it("a shadow classed and voiced while the store is full waits for an operation, then is kept whole (no refused:store)", async () => {
		// Other sources hold every operation the store allows (one at its ceiling of 6, another
		// at its floor of 2): `others`. The fake store denies past the overall limit.
		let others = MAX_ACTIVE_ANALOG_OPERATIONS
		let ref: ReturnType<typeof harness> | null = null
		const mine = () =>
			ref === null
				? 0
				: ref.ops.filter(op => op.outcome === null && !op.denied).length
		let denied = 0
		const h = harness({
			recordingCpu: () => calm(0.5),
			analogActive: () => others + mine(),
			beginWrap: begin => inp => {
				if (others + mine() >= MAX_ACTIVE_ANALOG_OPERATIONS) denied++
				const handle = begin(inp)
				if (others + mine() > MAX_ACTIVE_ANALOG_OPERATIONS) {
					handle.cancel()
					return {
						...handle,
						ready: Promise.reject(new Error("admission-denied")),
					}
				}
				return handle
			},
		})
		ref = h
		const id = "s"
		const onset = h.engine.liveEdge()
		const seconds = 3
		const end = onset + seconds * h.fs
		let fed = 0
		await h.feed(seconds, true, () => {
			fed++
			const edge = h.engine.liveEdge()
			if (edge - onset < 0.1 * h.fs) return
			// A shadow for its first second, then classed analog-fm with its discovery.
			const classed = edge - onset >= 1 * h.fs
			// The store frees one operation 2 s in (another source's file ended).
			if (edge - onset >= 2 * h.fs) others = MAX_ACTIVE_ANALOG_OPERATIONS - 1
			h.rec.track(
				input(
					id,
					snapshot(id, onset, Math.min(edge, end)),
					classed ? {} : SHADOW,
				),
			)
			// Classed and voiced, but the store is full: no operation begun yet.
			if (classed && others === MAX_ACTIVE_ANALOG_OPERATIONS)
				expect(h.ops).toHaveLength(0)
		})
		expect(fed).toBeGreaterThan(0)
		await h.feed(0.6, false)
		h.rec.closed(id, snapshot(id, onset, end), null)
		// Past the hang (2 s), then any grace timer: the file finishes and settles.
		await h.feed(3, false)
		await h.fire()
		await h.rec.idle()
		expect(denied).toBe(0)
		expect(counts(h)["refused:store"]).toBeUndefined()
		expect(h.ops).toHaveLength(1)
		const op = h.ops[0]!
		expect(op.denied).toBe(false)
		expect(op.outcome).toBe("finalized")
		// Whole: the file holds the transmission's audio from its pre-roll, nothing lost while
		// it waited (8000 frames/s over the 3 s air time at least).
		expect(op.frames).toBeGreaterThanOrEqual(seconds * 8000)
	}, 60_000)
})
