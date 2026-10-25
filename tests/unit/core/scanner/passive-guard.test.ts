// WG15 DQ requirement 8: the passive marginal cost guard (8.10 fixtures).
import { describe, expect, it } from "vitest"
import {
	PASSIVE_PROBATION_MS,
	passiveCostDecision,
	passiveGuardDecision,
} from "../../../../src/core/scanner/passive-cost.js"
import type { PassiveGuardInput } from "../../../../src/core/scanner/passive-cost.js"
import {
	PASSIVE_BASELINE_MAX_AGE_MS,
	PASSIVE_COST_RECHECK_MS,
	PASSIVE_COST_WINDOW_MS,
	PASSIVE_SATURATION,
} from "../../../../src/core/scanner/passive-cost-contract.js"
import {
	MEASURING_REASON,
	PassiveGuard,
} from "../../../../src/core/scanner/passive-guard.js"
import type { PassiveGuardView } from "../../../../src/core/scanner/passive-guard.js"

const W = PASSIVE_COST_WINDOW_MS
const base: PassiveGuardInput = {
	enabled: true,
	holders: "shared",
	measurement: 0.3,
	baseline: null,
	limit: 0.25,
	judgementDue: true,
	baselineWindowAllowed: true,
	trialDue: false,
	probationDue: false,
}
const decide = (patch: Partial<PassiveGuardInput>) =>
	passiveGuardDecision({ ...base, ...patch })

describe("passiveGuardDecision precedence (DQ 8.4)", () => {
	it.each<[string, Partial<PassiveGuardInput>, string, number]>([
		["no measurement", { measurement: null }, "keep", 1],
		["non-finite measurement", { measurement: Number.NaN }, "keep", 1],
		["sole over limit", { holders: "sole", measurement: 0.99 }, "disable", 2],
		["sole at the limit", { holders: "sole", measurement: 0.25 }, "keep", 2],
		[
			"sole just past the limit",
			{ holders: "sole", measurement: 0.2501 },
			"disable",
			2,
		],
		["saturated, no baseline", { measurement: 0.97 }, "disable", 3],
		[
			"saturated with a valid baseline",
			{ measurement: 0.96, baseline: 0.94 },
			"disable",
			3,
		],
		[
			"just under saturation, valid baseline",
			{ measurement: 0.9499, baseline: 0.94 },
			"keep",
			4,
		],
		["shared, cheap passive", { measurement: 0.38, baseline: 0.3 }, "keep", 4],
		[
			"shared, marginal at the limit",
			{ measurement: 0.5, baseline: 0.25 },
			"keep",
			4,
		],
		[
			"shared, costly passive",
			{ measurement: 0.62, baseline: 0.3 },
			"disable",
			4,
		],
		["baseline above U", { measurement: 0.5, baseline: 0.8 }, "keep", 4],
		[
			"malformed baseline counts as unavailable",
			{ measurement: 0.4, baseline: Number.NaN },
			"baseline",
			6,
		],
		["no baseline, within the limit", { measurement: 0.25 }, "keep", 5],
		["no baseline, over the limit", { measurement: 0.4 }, "baseline", 6],
		[
			"no baseline, window not allowed",
			{ measurement: 0.4, baselineWindowAllowed: false },
			"keep",
			7,
		],
		[
			"disabled, quiet engine",
			{ enabled: false, holders: "off", measurement: 0.2 },
			"clear",
			8,
		],
		[
			"disabled, inside hysteresis",
			{ enabled: false, holders: "off", measurement: 0.21 },
			"keep",
			10,
		],
		[
			"disabled, trial due with baseline",
			{
				enabled: false,
				holders: "off",
				measurement: 0.3,
				baseline: 0.3,
				trialDue: true,
			},
			"trial",
			9,
		],
		[
			"disabled, trial due without baseline",
			{ enabled: false, holders: "off", measurement: 0.3, trialDue: true },
			"keep",
			10,
		],
		[
			"disabled, engine shut, probation due",
			{
				enabled: false,
				holders: "closed",
				measurement: null,
				probationDue: true,
			},
			"clear",
			11,
		],
		[
			"disabled, engine shut, probation not due",
			{ enabled: false, holders: "closed", measurement: null },
			"keep",
			11,
		],
	])("%s", (_name, patch, decision, row) => {
		const r = decide(patch)
		expect(r.decision).toBe(decision)
		expect(r.row).toBe(row)
	})

	it("row 2 equals the WG11 rule", () => {
		for (const u of [0, 0.1, 0.25, 0.26, 0.99])
			expect(decide({ holders: "sole", measurement: u }).decision).toBe(
				passiveCostDecision({
					utilization: u,
					limit: 0.25,
					disabled: false,
					sinceOpenMs: W,
					sinceLastCheckMs: null,
				}),
			)
		expect(PASSIVE_SATURATION).toBe(0.95)
		expect(PASSIVE_BASELINE_MAX_AGE_MS).toBe(1_800_000)
	})
})

/** A fake engine whose worker runs at `rate()` of a core; ticks advance its ELU counters. */
function sim(opts: { displays?: string[] } = {}) {
	const engine = {}
	const state = {
		t: 0,
		active: 0,
		generation: 1,
		passive: true,
		displays: opts.displays ?? ["ws:a"],
		rate: (_passive: boolean) => 0.3,
	}
	const guard = new PassiveGuard()
	const actions: string[] = []
	const view = (): PassiveGuardView => ({
		engine: state.passive || state.displays.length > 0 ? engine : null,
		openedAt: 0,
		consumers: {
			jobs: state.passive ? ["job:passive-s"] : [],
			displays: state.displays,
		},
		sample: {
			idle: state.t - state.active,
			active: state.active,
			generation: state.generation,
		},
		utilization: null,
		tracked: state.passive,
	})
	const tick = (ms = 1000) => {
		state.active += state.rate(state.passive) * ms
		state.t += ms
		const a = guard.tick("s", view(), state.t, 0.25)
		if (a.kind === "disable") {
			state.passive = false
			actions.push(`disable:${a.reason}`)
		} else if (a.kind === "measure") {
			state.passive = false
			actions.push("measure")
		} else if (a.kind === "restore") {
			state.passive = true
			actions.push(`restore:${a.why}`)
		}
		return a
	}
	const run = (ms: number) => {
		for (let i = 0; i < ms / 1000; i++) tick()
	}
	return { guard, state, actions, tick, run }
}

describe("PassiveGuard state machine (DQ 8.2 to 8.8)", () => {
	it("sole over the limit disables at open + 60 s", () => {
		const s = sim({ displays: [] })
		s.state.rate = () => 0.99
		s.run(W - 1000)
		expect(s.actions).toEqual([])
		s.tick()
		expect(s.actions).toEqual(["disable:engine-cpu 99 % of a core"])
	})

	it("shared, cheap passive: one baseline window, then kept", () => {
		const s = sim()
		s.state.rate = p => (p ? 0.38 : 0.3)
		s.run(W)
		expect(s.actions).toEqual(["measure"])
		expect(s.guard.status("s").measuring).toBe(true)
		s.run(W + 1000)
		expect(s.actions).toEqual(["measure", "restore:baseline"])
		expect(s.guard.baselineOf("s", s.state.t)).toBeCloseTo(0.3, 5)
		s.run(10 * PASSIVE_COST_RECHECK_MS)
		// never disabled; the baseline is re-measured once it is 30 min old (at most one window per 30 min)
		expect(s.actions.some(a => a.startsWith("disable"))).toBe(false)
		expect(s.actions.filter(a => a === "measure")).toHaveLength(2)
	})

	it("shared, costly passive: disabled on the marginal figure, then trials every 15 min", () => {
		const s = sim()
		s.state.rate = p => (p ? 0.62 : 0.3)
		s.run(W)
		s.run(W + 2000)
		expect(s.actions.at(-1)).toBe("restore:baseline")
		s.run(W + 1000)
		expect(s.actions.at(-1)).toBe("disable:passive-cpu 32 % of a core")
		const disabledAt = s.state.t
		s.run(PASSIVE_PROBATION_MS - 2000)
		expect(s.actions.at(-1)).toBe("disable:passive-cpu 32 % of a core")
		s.run(70_000)
		expect(s.actions.slice(-2)).toEqual([
			"restore:trial",
			"disable:passive-cpu 32 % of a core",
		])
		// passive ran at most one window plus two ticks in the trial
		expect(s.state.t - disabledAt).toBeLessThan(PASSIVE_PROBATION_MS + 70_000)
	})

	it("a trial that is now cheap keeps passive", () => {
		const s = sim()
		s.state.rate = p => (p ? 0.62 : 0.3)
		s.run(3 * W + 3000)
		expect(s.actions.at(-1)).toMatch(/^disable:passive-cpu/)
		s.state.rate = p => (p ? 0.4 : 0.3)
		s.run(PASSIVE_PROBATION_MS + 2 * W)
		expect(s.actions.at(-1)).toBe("restore:trial")
		expect(s.state.passive).toBe(true)
	})

	it("a second baseline window is refused within 30 min", () => {
		const s = sim()
		s.state.rate = p => (p ? 0.4 : 0.3)
		s.run(2 * W + 2000)
		expect(s.actions).toEqual(["measure", "restore:baseline"])
		// the display changes: the baseline is unavailable, over the limit, no window allowed yet
		s.state.displays = ["ws:a", "ws:b"]
		s.run(PASSIVE_COST_RECHECK_MS * 3)
		expect(s.actions).toEqual(["measure", "restore:baseline"])
		s.run(PASSIVE_BASELINE_MAX_AGE_MS)
		expect(s.actions.filter(a => a === "measure")).toHaveLength(2)
	})

	it("invalidation: other consumers, an unexplained generation change, or age", () => {
		const s = sim()
		s.state.rate = p => (p ? 0.4 : 0.3)
		s.run(2 * W + 2000)
		expect(s.guard.baselineOf("s", s.state.t)).not.toBeNull()
		s.state.generation = 2
		s.tick()
		expect(s.guard.baselineOf("s", s.state.t)).toBeNull()
		const t = sim()
		t.state.rate = p => (p ? 0.4 : 0.3)
		t.run(2 * W + 2000)
		expect(
			t.guard.baselineOf("s", t.state.t + PASSIVE_BASELINE_MAX_AGE_MS + 1),
		).toBeNull()
		t.state.displays = []
		t.tick()
		expect(t.guard.baselineOf("s", t.state.t)).toBeNull()
	})

	it("saturated with or without a baseline disables", () => {
		const s = sim()
		s.state.rate = () => 0.97
		s.run(W)
		expect(s.actions).toEqual(["disable:engine-cpu 97 % of a core"])
	})

	it("deadlines are met within one tick, not at the 300 s recheck", () => {
		const s = sim()
		s.state.rate = p => (p ? 0.4 : 0.3)
		s.run(W)
		expect(s.actions).toEqual(["measure"])
		const measuredAt = s.state.t
		// the window opens at the first tick without passive and ends 60 s later
		while (s.actions.length < 2) s.tick()
		expect(s.state.t - measuredAt).toBeLessThanOrEqual(W + 2000)
		expect(s.state.t - measuredAt).toBeLessThan(PASSIVE_COST_RECHECK_MS)
		expect(MEASURING_REASON).toBe("measuring baseline")
	})

	it("an engine that closes during a baseline window abandons it and restores passive", () => {
		const s = sim({ displays: ["ws:a"] })
		s.state.rate = p => (p ? 0.4 : 0.3)
		s.run(W)
		expect(s.actions).toEqual(["measure"])
		s.state.displays = []
		s.tick()
		expect(s.actions).toEqual(["measure", "restore:abandon"])
	})
})
