import { describe, expect, it, vi } from "vitest"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import { PASSIVE_PROBATION_MS } from "../../../../src/core/scanner/passive-cost.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { SpectrumEngine } from "../../../../src/core/spectrum/spectrum-engine.js"
import { makeObs } from "../../../mocks/scanner/observations.js"
import {
	PASSIVE_COST_RECHECK_MS,
	PASSIVE_COST_WINDOW_MS,
} from "../../../../src/core/scanner/passive-cost-contract.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"
import { meteredCheck } from "./passive-elu-fixture.js"

type Harness = ReturnType<typeof serviceHarness>
const WAIT = { timeout: 5_000, interval: 5 }
const internalsOf = (h: Harness) =>
	h.service as unknown as {
		checkPassiveCost(now: number): Promise<void>
	}

async function started(
	patch?: NonNullable<Parameters<typeof serviceHarness>[0]>["patch"],
) {
	const h = serviceHarness(patch ? { patch } : {})
	await h.service.start()
	const engine = h.service.spectrum.engine("rtl")!
	const openedAt = h.service.spectrum.openedAt("rtl")!
	const reason = () => h.service.status().engines[0]?.passive.disabledReason
	return { h, engine, openedAt, reason }
}

describe("passive cost guard wiring (WG11 req 2)", () => {
	it("disables above the configured limit, not above the 0.25 default", async () => {
		const a = await started(s => {
			s.passive.maxEngineUtilization = 0.5
		})
		a.engine.utilization = () => 0.4
		await meteredCheck(a.h.service)(a.openedAt + PASSIVE_COST_WINDOW_MS)
		expect(a.reason()).toBeUndefined()
		await a.h.service.stop()
		const b = await started()
		b.engine.utilization = () => 0.4
		await meteredCheck(b.h.service)(b.openedAt + PASSIVE_COST_WINDOW_MS)
		expect(b.reason()).toMatch(/engine-cpu 40 %/)
		await b.h.service.stop()
	})

	it("a shared engine: saturation disables, then a quiet engine without passive clears it (DQ 8.4 rows 3, 8)", async () => {
		const { h, engine, openedAt, reason } = await started()
		const check = meteredCheck(h.service)
		// another consumer (a display) keeps the engine running once passive lets go of it
		await h.service.spectrum.acquire("rtl", "ws:wg11-sc")
		const t1 = openedAt + PASSIVE_COST_WINDOW_MS
		engine.utilization = () => 0.97
		await check(t1)
		expect(reason()).toMatch(/engine-cpu 97 %/)
		await vi.waitFor(
			() => expect(h.service.getJob("passive-rtl")).toBeUndefined(),
			WAIT,
		)
		// the first tick without passive opens the baseline window (DQ 8.2)
		await check(t1 + 1_000)
		// the window runs at 0.22: one millisecond short of complete, nothing is judged
		engine.utilization = () => 0.22
		await check(t1 + 1_000 + PASSIVE_COST_WINDOW_MS - 1)
		expect(reason()).toMatch(/engine-cpu/)
		// a complete window inside the hysteresis band (0.2 < 0.22 <= limit): stays disabled
		engine.utilization = () => 0.22
		await check(t1 + 1_000 + PASSIVE_COST_WINDOW_MS)
		expect(reason()).toMatch(/engine-cpu/)
		// the next complete window at or below 0.8 x 0.25 clears
		engine.utilization = () => 0.2
		await check(t1 + 1_000 + 2 * PASSIVE_COST_WINDOW_MS)
		expect(reason()).toBeUndefined()
		await vi.waitFor(
			() => expect(h.service.getJob("passive-rtl")).toBeDefined(),
			WAIT,
		)
		await h.service.stop()
	})

	it("an enabled source is re-judged too and disabled when the engine got costly", async () => {
		const { h, engine, openedAt, reason } = await started()
		const check = meteredCheck(h.service)
		const t1 = openedAt + PASSIVE_COST_WINDOW_MS
		engine.utilization = () => 0.1
		await check(t1)
		engine.utilization = () => 0.9
		await check(t1 + PASSIVE_COST_RECHECK_MS - 1)
		expect(reason()).toBeUndefined()
		await check(t1 + PASSIVE_COST_RECHECK_MS)
		expect(reason()).toMatch(/engine-cpu 90 %/)
		await h.service.stop()
	})
})

/**
 * A worker whose event loop runs at `profile(tMs)` of a core (piecewise constant per second): the
 * engine reports raw cumulative samples like `performance.eventLoopUtilization()`, and its
 * `utilization()` is the whole-life ratio, as the thread host computes it.
 */
function fakeElu(engine: SpectrumEngine, profile: (tMs: number) => number) {
	const clock = { t: 0, generation: 1 }
	const sample = () => {
		let active = 0
		for (let s = 0; s * 1000 < clock.t; s++)
			active += profile(s * 1000) * Math.min(1000, clock.t - s * 1000)
		return { idle: clock.t - active, active, utilization: 0 }
	}
	engine.eluSample = () => ({ generation: clock.generation, elu: sample() })
	engine.utilization = () => {
		const { idle, active } = sample()
		return active + idle > 0 ? active / (active + idle) : null
	}
	return clock
}

describe("passive cost guard: no ELU sample (review regression, DQ 8.2)", () => {
	it("a sole engine without a sample is not judged on its whole-life average", async () => {
		const { h, engine, openedAt, reason } = await started()
		engine.utilization = () => 0.99
		engine.eluSample = () => null
		await internalsOf(h).checkPassiveCost(openedAt + PASSIVE_COST_WINDOW_MS)
		expect(reason()).toBeUndefined()
		expect(h.service.getJob("passive-rtl")).toBeDefined()
		await h.service.stop()
	})
})

describe("passive cost guard: windowed utilization (WG11 review M1)", () => {
	it("judges a sole engine over the window since the last check, not its whole life", async () => {
		const { h, engine, openedAt, reason } = await started()
		// about three hours in, on a recheck boundary
		const LATE = PASSIVE_COST_WINDOW_MS + 36 * PASSIVE_COST_RECHECK_MS
		const clock = fakeElu(engine, t => (t >= LATE ? 0.9 : 0.1))
		const check = async (t: number) => {
			clock.t = t
			await internalsOf(h).checkPassiveCost(openedAt + t)
		}
		await check(PASSIVE_COST_WINDOW_MS)
		expect(reason()).toBeUndefined()
		let t = PASSIVE_COST_WINDOW_MS
		while (t + PASSIVE_COST_RECHECK_MS <= LATE) {
			t += PASSIVE_COST_RECHECK_MS
			await check(t)
			expect(reason()).toBeUndefined()
		}
		// hours in, a sustained spike over one recheck window disables (whole life stays near 0.1)
		expect(t).toBe(LATE)
		await check(t + PASSIVE_COST_RECHECK_MS)
		expect(reason()).toMatch(/engine-cpu 90 %/)
		await h.service.stop()
	})
})

describe("passive cost guard: worker replacement (WG11 review MAJOR, DQ 8.2)", () => {
	it("discards the window at a new worker generation and never clears on the old worker's counters", async () => {
		const { h, engine, openedAt, reason } = await started()
		await h.service.spectrum.acquire("rtl", "ws:wg11-sc-gen")
		const elu = { idle: 2400, active: 57600, generation: 1 }
		engine.eluSample = () => ({
			generation: elu.generation,
			elu: { idle: elu.idle, active: elu.active, utilization: 0 },
		})
		await internalsOf(h).checkPassiveCost(openedAt + PASSIVE_COST_WINDOW_MS)
		expect(reason()).toMatch(/engine-cpu 96 %/)
		await vi.waitFor(
			() => expect(h.service.getJob("passive-rtl")).toBeUndefined(),
			WAIT,
		)
		const t0 = openedAt + PASSIVE_COST_WINDOW_MS + 1_000
		await internalsOf(h).checkPassiveCost(t0)
		// the same engine reconfigured: a new worker whose life so far is 25 % (above the 20 % clear
		// line); subtracting the old worker's counters would give a small figure and wrongly clear
		elu.idle = 45000
		elu.active = 15000
		elu.generation = 2
		await internalsOf(h).checkPassiveCost(t0 + PASSIVE_COST_WINDOW_MS)
		expect(reason()).toMatch(/engine-cpu/)
		elu.idle = 90000
		elu.active = 30000
		await internalsOf(h).checkPassiveCost(t0 + 2 * PASSIVE_COST_WINDOW_MS)
		expect(reason()).toMatch(/engine-cpu/)
		await h.service.stop()
	})
})

describe("passive cost guard: probation with no display (WG11 review M2)", () => {
	async function disabledHeadless() {
		const s = await started()
		const clock = fakeElu(s.engine, () => 0.9)
		clock.t = PASSIVE_COST_WINDOW_MS
		const disabledAt = s.openedAt + PASSIVE_COST_WINDOW_MS
		await internalsOf(s.h).checkPassiveCost(disabledAt)
		expect(s.reason()).toMatch(/engine-cpu 90 %/)
		// nothing else holds the engine: cancelling the passive job releases it
		await vi.waitFor(
			() => expect(s.h.service.spectrum.engine("rtl")).toBeUndefined(),
			WAIT,
		)
		await internalsOf(s.h).checkPassiveCost(
			disabledAt + PASSIVE_PROBATION_MS - 1,
		)
		expect(s.reason()).toMatch(/engine-cpu/)
		await internalsOf(s.h).checkPassiveCost(disabledAt + PASSIVE_PROBATION_MS)
		expect(s.reason()).toBeUndefined()
		await vi.waitFor(() => {
			expect(s.h.service.getJob("passive-rtl")).toBeDefined()
			expect(s.h.service.spectrum.engine("rtl")).toBeDefined()
		}, WAIT)
		const engine = s.h.service.spectrum.engine("rtl")!
		expect(engine).not.toBe(s.engine)
		const reopenedAt = s.h.service.spectrum.openedAt("rtl")!
		return { ...s, engine, reopenedAt }
	}

	it("re-enables after the probation period and disables again when the reopened engine is costly", async () => {
		const { h, engine, reopenedAt, reason } = await disabledHeadless()
		fakeElu(engine, () => 0.9).t = PASSIVE_COST_WINDOW_MS
		await internalsOf(h).checkPassiveCost(
			reopenedAt + PASSIVE_COST_WINDOW_MS - 1,
		)
		expect(reason()).toBeUndefined()
		await internalsOf(h).checkPassiveCost(reopenedAt + PASSIVE_COST_WINDOW_MS)
		expect(reason()).toMatch(/engine-cpu 90 %/)
		await h.service.stop()
	})

	it("re-enables after the probation period and stays enabled when the reopened engine is cheap", async () => {
		const { h, engine, reopenedAt, reason } = await disabledHeadless()
		fakeElu(engine, () => 0.1).t = PASSIVE_COST_WINDOW_MS
		await internalsOf(h).checkPassiveCost(reopenedAt + PASSIVE_COST_WINDOW_MS)
		expect(reason()).toBeUndefined()
		expect(h.service.getJob("passive-rtl")).toBeDefined()
		await h.service.stop()
	})
})

describe("trackIdentity through the store's identity accessor (WG11 identity accessor)", () => {
	it("resolves a merged survivor without store.get or structuredClone", async () => {
		const h = serviceHarness()
		await h.service.start()
		const internals = h.service as unknown as {
			live: Map<string, LiveObservation>
			store: DiscoveryStore
		}
		const store = internals.store
		const { discoveryId } = store.ingest(
			makeObs({
				id: "o_m",
				sourceId: "rtl",
				centreHz: 446_000_000,
				startedAt: 1,
			}),
		)
		expect(discoveryId).toBeDefined()
		// the live entry still names the merged-away discovery; the observation now maps to the survivor
		vi.spyOn(store, "discoveryIdOf").mockImplementation(o =>
			o === "o_m" ? discoveryId! : undefined,
		)
		internals.live.set("t_m", {
			observationId: "o_m",
			sourceId: "rtl",
			trackId: "t_m",
			epoch: 1,
			jobIds: [],
			discoveryId: "d_merged_away",
			startedAt: 1,
		} as unknown as LiveObservation)
		const get = vi.spyOn(store, "get")
		const clone = vi.spyOn(globalThis, "structuredClone")
		const identity = h.service.trackIdentity("rtl", "t_m")
		expect(identity).toEqual({
			discoveryId,
			protocol: store.identityOf(discoveryId!)!.protocol,
			confidence: store.identityOf(discoveryId!)!.confidence,
		})
		expect(get).not.toHaveBeenCalled()
		expect(clone).not.toHaveBeenCalled()
		clone.mockRestore()
		await h.service.stop()
	})
})
