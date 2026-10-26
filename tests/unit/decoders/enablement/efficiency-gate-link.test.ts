import { expect, it, vi } from "vitest"
import type { Logger } from "../../../../src/utils/logger.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type { DropReader } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type {
	LateDropWindow,
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"

export const placement = (key = "p", sourceId = "s"): WantedPlacement => ({
	key,
	decoderId: key,
	sourceId,
	reach: "raw",
	costCores: 0.1,
	sampleRateHz: 2048000,
	channelHz: null,
	origin: "band",
	primary: true,
})
export function setup() {
	let mono = 0
	let attribution: unknown = "none"
	let windows: readonly LateDropWindow[] = []
	const warn = vi.fn()
	const drops: DropReader = {
		monoNow: () => mono,
		coverageCompleteAtMono: (_id, since, amount) =>
			mono >= since + amount ? since + amount : null,
		sources: () => ["s"],
		dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
		droppedSinceMono: () => false,
		droppedWithinMs: () => false,
		latestAttribution: () =>
			attribution as ReturnType<NonNullable<DropReader["latestAttribution"]>>,
		lateWindows: () => windows,
	}
	const gate = createEfficiencyGate(
		{ budgetCores: 10, cpuGuardPercent: 90 },
		{ drops, log: { warn } as unknown as Logger },
	)
	return {
		gate,
		drops,
		warn,
		time: (value: number) => {
			mono = value
		},
		attribution: (value: unknown) => {
			attribution = value
		},
		windows: (value: readonly LateDropWindow[]) => {
			windows = value
		},
		running: (p = placement()): RunningPlacement => ({
			...p,
			admittedAtMs: 0,
			mode: "auto",
			startMode: "auto",
		}),
	}
}
export const window = (
	startMono: number,
	condemning = true,
	linkOrUnknownDrops = false,
): LateDropWindow => ({
	startMono,
	endMono: startMono + 10000,
	condemning,
	linkOrUnknownDrops,
})

it("link admission waits without recording a retry and unknown evidence keeps waiting", () => {
	const s = setup()
	for (const value of ["link", null, "unknown", "bad"]) {
		s.attribution(value)
		expect(s.gate.admit(placement(), [], 0)).toMatchObject({
			admit: false,
			detail: "unknown",
		})
	}
	s.attribution("none")
	expect(s.gate.admit(placement(), [], 1)).toEqual({ admit: true })
})
it("supplied malformed attribution readers fail closed", () => {
	for (const value of [
		null,
		1,
		() => {
			throw new TypeError("private")
		},
	]) {
		const s = setup()
		s.drops.latestAttribution = value as DropReader["latestAttribution"] & {}
		expect(s.gate.admit(placement(), [], 0).admit).toBe(false)
	}
})
it("nothing sheddable warns at the minute bound and one past it", () => {
	const s = setup()
	const running = [s.running()]
	s.gate.probation(running, 0)
	s.time(30000)
	s.gate.probation(running, 0)
	s.windows([window(30000), window(40000)])
	for (const [time, count] of [
		[50000, 1],
		[109999, 1],
		[110000, 2],
		[110001, 2],
	]) {
		s.time(time!)
		if (time! > 50000) s.windows([window(80000), window(90000)])
		expect(s.gate.probation(running, 0)).toEqual([])
		expect(s.warn).toHaveBeenCalledTimes(count!)
	}
	expect(s.gate.view(running, [], 0).sources[0]?.lateDrops?.held).toBe(
		"nothing-sheddable",
	)
})
it("view carries attribution and link-or-unknown held state", () => {
	const s = setup()
	const running = [s.running()]
	s.gate.probation(running, 0)
	s.time(30000)
	s.gate.probation(running, 0)
	s.windows([window(30000, false, true), window(40000, false, true)])
	s.time(50000)
	s.attribution("link")
	expect(s.gate.probation(running, 0)).toEqual([])
	expect(s.gate.view(running, [], 0).sources[0]).toMatchObject({
		attribution: "link",
		lateDrops: { held: "link-or-unknown", condemningWindows: 0 },
	})
})

it("malformed or throwing late windows never produce a verdict", () => {
	for (const value of [
		null,
		1,
		() => null,
		() => [window(30000), { ...window(40000), condemning: "yes" }],
		() => {
			throw new TypeError("private")
		},
	]) {
		const s = setup()
		const p = placement()
		s.gate.admit(p, [], 0)
		const running = [s.running(p)]
		s.gate.probation(running, 0)
		s.time(30000)
		s.gate.probation(running, 0)
		s.drops.lateWindows = value as NonNullable<DropReader["lateWindows"]>
		s.time(60000)
		expect(s.gate.probation(running, 0)).toEqual([])
	}
})
it("sheds newest admission, clears history and honors cooldown at its bound", () => {
	const s = setup()
	const old = s.running(placement("old"))
	const newer = s.running(placement("new"))
	s.gate.admit(placement("old"), [], 0)
	s.gate.probation([old], 0)
	s.time(30000)
	s.gate.probation([old], 0)
	s.gate.admit(placement("new"), [old], 0)
	s.gate.probation([old, newer], 0)
	s.time(60000)
	s.gate.probation([old, newer], 0)
	s.windows([window(60000), window(70000)])
	s.time(80000)
	expect(s.gate.probation([old, newer], 0)).toEqual([
		{ key: "new", detail: "late-drops" },
	])
	s.gate.noteSuspended("new", "late-drops", 0)
	expect(s.gate.admit(placement("new"), [old], 1)).toMatchObject({
		retryAtMs: 300000,
	})
	s.windows([window(80000), window(90000)])
	for (const at of [109999, 110000, 110001]) {
		s.time(at)
		expect(s.gate.probation([old], 0)).toEqual(
			at === 110000 ? [{ key: "old", detail: "late-drops" }] : [],
		)
	}
})

it("late failures double retry delays up to the cap", () => {
	const s = setup()
	const p = placement()
	let at = 0
	for (const delay of [300000, 600000, 1200000, 1800000, 1800000]) {
		s.time(at)
		expect(s.gate.admit(p, [], at).admit).toBe(true)
		const active = [s.running(p)]
		s.gate.probation(active, at)
		s.time(at + 30000)
		s.gate.probation(active, at)
		s.windows([window(at + 30000), window(at + 40000)])
		s.time(at + 50000)
		expect(s.gate.probation(active, at)).toEqual([
			{ key: p.key, detail: "late-drops" },
		])
		s.gate.noteSuspended(p.key, "late-drops", at + 50000)
		expect(s.gate.admit(p, [], at + 50001)).toMatchObject({
			retryAtMs: at + 50000 + delay,
		})
		s.gate.probation([], at)
		at += 50000 + delay
	}
})
it("probation on another source remains independent of late shedding", () => {
	const s = setup()
	const old = s.running()
	s.gate.admit(placement(), [], 0)
	s.gate.probation([old], 0)
	s.time(30000)
	s.gate.probation([old], 0)
	const newcomer = s.running(placement("new", "other"))
	s.gate.admit(placement("new", "other"), [old], 0)
	s.drops.droppedSinceMono = id => id === "other"
	s.windows([window(30000), window(40000)])
	s.time(50000)
	expect(s.gate.probation([old, newcomer], 0)).toEqual([
		{ key: "new", detail: "drops" },
		{ key: "p", detail: "late-drops" },
	])
})
it("no warning when not held or without a logger", () => {
	const s = setup()
	s.gate.probation([s.running()], 0)
	s.time(30000)
	s.gate.probation([s.running()], 0)
	expect(s.warn).not.toHaveBeenCalled()
	const gate = createEfficiencyGate(
		{ budgetCores: 10, cpuGuardPercent: 90 },
		{ drops: s.drops },
	)
	gate.probation([s.running()], 0)
	s.time(60000)
	gate.probation([s.running()], 0)
	s.windows([window(60000), window(70000)])
	s.time(80000)
	expect(gate.probation([s.running()], 0)).toEqual([])
})

it("excludes windows before late-since and future or overlapping windows", () => {
	for (const windows of [
		[window(29999), window(40000)],
		[window(30000), window(50001)],
		[window(30000), window(39999)],
	]) {
		const s = setup()
		const p = placement()
		s.gate.admit(p, [], 0)
		const active = [s.running(p)]
		s.time(30000)
		s.gate.probation(active, 0)
		s.windows(windows)
		s.time(60000)
		expect(s.gate.probation(active, 0)).toEqual([])
	}
})
it("always and operator placements remain protected with positive probation evidence", () => {
	for (const protection of ["always", "operator"] as const) {
		const s = setup()
		const active = s.running()
		if (protection === "always") active.mode = "always"
		else active.startMode = "operator"
		s.drops.droppedSinceMono = () => true
		expect(s.gate.probation([active], 0)).toEqual([])
	}
})

it("held warnings have independent reason limits and fixed fields", () => {
	const s = setup()
	const active = [s.running()]
	s.gate.probation(active, 0)
	s.time(30000)
	s.gate.probation(active, 0)
	s.time(50000)
	s.windows([window(30000), window(40000)])
	s.gate.probation(active, 0)
	s.windows([window(30000, false, true), window(40000, false, true)])
	s.gate.probation(active, 0)
	expect(s.warn.mock.calls).toEqual([
		[
			{
				sourceId: "s",
				reason: "nothing-sheddable",
				condemningWindows: 2,
				windows: 2,
			},
			"Late drops not shed",
		],
		[
			{
				sourceId: "s",
				reason: "link-or-unknown",
				condemningWindows: 0,
				windows: 2,
			},
			"Late drops not shed",
		],
	])
})

it("supplied attribution without usable coverage never graduates by elapsed time", () => {
	for (const coverage of [undefined, null, 1, () => null]) {
		const s = setup()
		const p = placement()
		s.gate.admit(p, [], 0)
		if (coverage === undefined) delete s.drops.coverageCompleteAtMono
		else
			s.drops.coverageCompleteAtMono = coverage as NonNullable<
				DropReader["coverageCompleteAtMono"]
			>
		const active = [s.running(p)]
		s.time(30001)
		s.gate.probation(active, 0)
		expect(s.gate.view(active, [], 0).sources[0]?.admitted[0]?.probation).toBe(
			true,
		)
	}
})

it.each([
	["negative", () => -1],
	["before admission", () => 999],
	["before complete coverage", () => 30999],
	["future", (mono: number) => mono + 1],
	["NaN", () => NaN],
	["infinite", () => Infinity],
	["non-number", () => "31000"],
	["null", () => null],
	[
		"throwing",
		() => {
			throw new TypeError("unavailable")
		},
	],
])(
	"%s coverage keeps probation, late shedding and admission closed",
	(_name, read) => {
		const s = setup()
		let mono = 1000
		s.time(mono)
		const p = placement()
		expect.soft(s.gate.admit(p, [], 0).admit).toBe(true)
		const active = [s.running(p)]
		s.drops.coverageCompleteAtMono = (() => read(mono)) as NonNullable<
			DropReader["coverageCompleteAtMono"]
		>
		s.gate.probation(active, 0)
		for (mono of [61000, 81000]) {
			s.time(mono)
			s.windows([window(61000), window(71000)])
			expect.soft(s.gate.probation(active, 0)).toEqual([])
			expect.soft(s.gate.view(active, [], 0).sources[0]).toMatchObject({
				admitted: [{ probation: true }],
				lateDrops: { sheddable: 0 },
			})
			expect.soft(s.gate.admit(placement("next"), active, 0).admit).toBe(false)
		}
	},
)

it.each([31000, 61000])(
	"coverage at the inclusive bound %i earns graduation",
	at => {
		const s = setup()
		s.time(1000)
		const p = placement()
		expect(s.gate.admit(p, [], 0).admit).toBe(true)
		const active = [s.running(p)]
		s.gate.probation(active, 0)
		s.drops.coverageCompleteAtMono = () => at
		s.time(61000)
		expect(s.gate.probation(active, 0)).toEqual([])
		expect(s.gate.view(active, [], 0).sources[0]).toMatchObject({
			admitted: [{ probation: false }],
			lateDrops: { sheddable: 1 },
		})
		expect(s.gate.admit(placement("next"), active, 0).admit).toBe(true)
		s.windows([window(61000), window(71000)])
		s.time(81000)
		expect(s.gate.probation(active, 0)).toEqual([
			{ key: p.key, detail: "late-drops" },
		])
	},
)

it.each([69999, 70000, 70001])(
	"late windows expire by elapsed evidence time at %i",
	at => {
		const s = setup()
		const p = placement()
		s.gate.admit(p, [], 0)
		const running = [s.running(p)]
		s.gate.probation(running, 0)
		s.time(30000)
		s.gate.probation(running, 0)
		s.windows([window(30000), window(40000)])
		// Three 10 s windows cover (now - 30000, now]; the first window
		// ends at 40000, so it expires exactly at 70000, and remains expired.
		s.time(at)
		expect(s.gate.probation(running, at)).toEqual(
			at < 70000 ? [{ key: p.key, detail: "late-drops" }] : [],
		)
	},
)
