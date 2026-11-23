import { describe, expect, it } from "vitest"
import {
	CAPACITY,
	gateHarness,
	OWN_CALM,
	OWN_OVER,
} from "./rx-starvation-harness.js"

/**
 * rx-starvation S1: the gate's
 * CPU evidence is the core's own CPU over the guard share of its capacity;
 * host CPU only excuses drops.
 */
describe("probation under host CPU (T1-T5)", () => {
	it("10 simulated minutes at host 100 % with own 0.8 of 4 cores: never a cpu suspension, the probationer graduates", () => {
		const h = gateHarness()
		expect(h.start("a").admit).toBe(true)
		for (let i = 0; i < 300; i++) expect(h.step(100, OWN_CALM)).toEqual([])
		// Graduated: the next placement on the source is not held behind it.
		expect(h.start("b")).toEqual({ admit: true })
	})
	// Hysteresis: own-over is evidence on the fifth consecutive sample (OWN_OVER_SUSTAIN_SAMPLES).
	it("T1a: five consecutive own-over samples suspend the newest untuned probationer, cause decoder", () => {
		const h = gateHarness()
		h.start("a")
		expect(h.step(10, OWN_CALM)).toEqual([])
		for (let i = 0; i < 4; i++) expect(h.step(10, OWN_OVER)).toEqual([])
		expect(h.step(10, OWN_OVER)).toEqual([{ key: "a", detail: "cpu" }])
		expect(h.gate.shedAttribution?.("a")?.attribution.cause).toBe("decoder")
		const verdict = h.logs.find(l => l.msg === "Efficiency probation verdict")
		expect(verdict?.obj).toMatchObject({
			key: "a",
			detail: "cpu",
			scapegoat: false,
			probationerKey: "a",
			probationerAdmittedMono: 0,
			ownCores: OWN_OVER,
			capacityCores: CAPACITY,
		})
		expect(
			h.logs.find(l => l.msg === "Efficiency admission")?.obj,
		).toMatchObject({ key: "a", admittedMono: 0 })
	})
	it("one own-over sample alone (a spawn burst) is no evidence", () => {
		const h = gateHarness()
		h.start("a")
		for (let i = 0; i < 20; i++)
			expect(h.step(10, i % 2 === 0 ? OWN_OVER : OWN_CALM)).toEqual([])
	})
	it("own-over samples further apart than two samples are not consecutive", () => {
		const h = gateHarness()
		h.start("a")
		expect(h.step(10, OWN_OVER)).toEqual([])
		h.advance(2_001)
		expect(h.step(10, OWN_OVER)).toEqual([])
	})
	it("bounds: own exactly at the guard share never sheds; just past it does", () => {
		const at = gateHarness()
		at.start("a")
		for (let i = 0; i < 5; i++) expect(at.step(null, 3.6)).toEqual([])
		const past = gateHarness()
		past.start("a")
		for (let i = 0; i < 4; i++) expect(past.step(null, 3.6 + 1e-9)).toEqual([])
		expect(past.step(null, 3.6 + 1e-9)).toEqual([{ key: "a", detail: "cpu" }])
	})
	it("T2: a pinned probationer is never suspended for own CPU", () => {
		const h = gateHarness()
		h.start("a", { pinned: true })
		for (let i = 0; i < 10; i++) expect(h.step(10, OWN_OVER)).toEqual([])
	})
	it("C4/C5: no own reading never sheds, at any host CPU", () => {
		const h = gateHarness()
		h.start("a")
		for (let i = 0; i < 30; i++) expect(h.step(100, null)).toEqual([])
		const noCapacity = gateHarness()
		noCapacity.start("a")
		for (let i = 0; i < 30; i++)
			expect(noCapacity.step(100, OWN_OVER, null)).toEqual([])
	})
	it("1 100 host-busy samples with own calm evict host CPU without failing the probation", () => {
		const h = gateHarness()
		h.start("a")
		// No probation pass: the placement stays ungraduated, so its admission
		// pins history and the 1 024 cap evicts.
		for (let i = 0; i < 1_100; i++) {
			h.advance(2_000)
			h.record(100, OWN_CALM)
		}
		h.advance(2_000)
		h.record(10, OWN_CALM)
		expect(h.gate.probation(h.running, h.mono)).toEqual([])
		expect(h.start("b")).toEqual({ admit: true })
	})
	it("own-over evicted from bounded history still fails the probation", () => {
		const h = gateHarness()
		h.start("a")
		for (let i = 0; i < 1_100; i++) {
			h.advance(2_000)
			h.record(10, OWN_OVER)
		}
		// Only the latest 1 024 own-over times remain; the evicted ones failed it.
		for (let i = 0; i < 40; i++) {
			h.advance(2_000)
			h.record(10, OWN_CALM)
		}
		expect(h.gate.probation(h.running, h.mono)).toEqual([
			{ key: "a", detail: "cpu" },
		])
	})
	it("a process without own CPU logs once that CPU shedding is off", () => {
		const h = gateHarness()
		h.record(10, null, CAPACITY, false)
		h.advance(2_000)
		h.record(10, null, CAPACITY, false)
		expect(
			h.logs.filter(l => l.msg === "own CPU unavailable: CPU shedding off"),
		).toHaveLength(1)
	})
})

describe("tuned probation (T1b, T1c)", () => {
	const setup = () => {
		const h = gateHarness()
		h.start("u1")
		for (let i = 0; i < 16; i++) h.step(10, OWN_CALM)
		h.start("u2", { sourceId: "t" })
		for (let i = 0; i < 16; i++) h.step(10, OWN_CALM)
		expect(h.start("tuned", { tuned: true }).admit).toBe(true)
		return h
	}
	it("T1b: own-over sheds the newest untuned placement on any source, cause decoder, naming the probationer", () => {
		const h = setup()
		for (let i = 0; i < 4; i++) expect(h.step(10, OWN_OVER)).toEqual([])
		expect(h.step(10, OWN_OVER)).toEqual([{ key: "u2", detail: "cpu" }])
		expect(h.gate.shedAttribution?.("u2")?.attribution.cause).toBe("decoder")
		expect(
			h.logs.find(l => l.msg === "Efficiency probation verdict")?.obj,
		).toMatchObject({
			key: "u2",
			scapegoat: true,
			probationerKey: "tuned",
		})
		expect(h.running.some(p => p.key === "tuned")).toBe(true)
	})
	it("T1b changed: host-busy only sheds no scapegoat and resets nothing; the tuned one graduates", () => {
		const h = setup()
		for (let i = 0; i < 16; i++) expect(h.step(100, OWN_CALM)).toEqual([])
		// Graduated after 30 000 ms: the source admits the next probationer.
		expect(h.start("u3").admit).toBe(true)
	})
	it("T1c: own-over with nothing untuned left never sheds the tuned one", () => {
		const h = gateHarness()
		h.start("tuned", { tuned: true })
		for (let i = 0; i < 60; i++) expect(h.step(10, OWN_OVER)).toEqual([])
		expect(h.running.map(p => p.key)).toEqual(["tuned"])
	})
})

describe("admission (A1-A3)", () => {
	const withUntuned = (budgetCores = 100) => {
		const h = gateHarness({ budgetCores })
		h.start("u1", { cost: 0.3 })
		for (let i = 0; i < 16; i++) h.step(10, OWN_CALM)
		return h
	}
	it("A1: the latest five fresh own-over samples refuse an untuned newcomer with cpu", () => {
		const h = withUntuned()
		for (let i = 0; i < 5; i++) h.step(10, OWN_OVER)
		expect(h.gate.admit(h.wanted("n"), h.running, h.mono)).toMatchObject({
			admit: false,
			detail: "cpu",
		})
	})
	it("A1: one own-over sample (a spawn burst) admits when the cost model allows", () => {
		const h = withUntuned()
		h.step(10, OWN_CALM)
		h.step(10, OWN_OVER)
		expect(h.gate.admit(h.wanted("n"), h.running, h.mono)).toEqual({
			admit: true,
		})
	})
	it("A1: own-over, calm, own-over is no pair and admits", () => {
		const h = withUntuned()
		h.step(10, OWN_OVER)
		h.step(10, OWN_CALM)
		h.step(10, OWN_OVER)
		expect(h.gate.admit(h.wanted("n"), h.running, h.mono)).toEqual({
			admit: true,
		})
	})
	it("A1: one own-over sample still meets the cost model", () => {
		const h = gateHarness({ budgetCores: 0.2 })
		h.step(10, OWN_OVER)
		expect(
			h.gate.admit(h.wanted("n", { cost: 0.3 }), h.running, h.mono),
		).toMatchObject({ admit: false, detail: "budget" })
	})
	it("A1: a stale own-over sample no longer refuses", () => {
		const h = withUntuned()
		h.step(10, OWN_OVER)
		h.advance(6_001)
		expect(h.gate.admit(h.wanted("n"), h.running, h.mono).admit).toBe(true)
	})
	it("A2 changed: host CPU alone admits on probation", () => {
		const h = withUntuned()
		h.step(100, OWN_CALM)
		expect(h.gate.admit(h.wanted("n"), h.running, h.mono)).toEqual({
			admit: true,
		})
		const noOwn = withUntuned()
		noOwn.step(100, null)
		expect(
			noOwn.gate.admit(noOwn.wanted("n"), noOwn.running, noOwn.mono),
		).toEqual({ admit: true })
	})
	it("A1t: one own-over sample swaps nothing for a tuned newcomer", () => {
		const h = withUntuned()
		h.step(10, OWN_OVER)
		expect(
			h.gate.admit(
				h.wanted("t", { tuned: true, cost: 0.25 }),
				h.running,
				h.mono,
			),
		).toEqual({ admit: true })
	})
	it("A1t: own-over swaps a tuned newcomer in for untuned placements", () => {
		const h = withUntuned()
		for (let i = 0; i < 5; i++) h.step(10, OWN_OVER)
		expect(
			h.gate.admit(
				h.wanted("t", { tuned: true, cost: 0.25 }),
				h.running,
				h.mono,
			),
		).toEqual({ admit: true, displace: ["u1"] })
	})
	it("A2t changed: host-busy swaps nothing; the tuned newcomer is admitted when the budget allows", () => {
		const h = withUntuned()
		h.step(100, OWN_CALM)
		expect(
			h.gate.admit(
				h.wanted("t", { tuned: true, cost: 0.25 }),
				h.running,
				h.mono,
			),
		).toEqual({ admit: true })
	})
	it("A3: the cost model still refuses over the budget", () => {
		const h = gateHarness({ budgetCores: 0.2 })
		h.step(100, OWN_CALM)
		expect(
			h.gate.admit(h.wanted("n", { cost: 0.3 }), h.running, h.mono),
		).toMatchObject({ admit: false, detail: "budget" })
	})
})

describe("cpuState (m4)", () => {
	it("labels the latest fresh sample and goes null when stale", () => {
		const h = gateHarness()
		expect(h.gate.cpuState?.(h.mono)).toBeNull()
		h.step(100, OWN_CALM)
		expect(h.gate.cpuState?.(h.mono)).toEqual({
			label: "host-busy",
			hostPercent: 100,
			ownCores: OWN_CALM,
			capacityCores: CAPACITY,
			guardPercent: 90,
		})
		h.step(10, OWN_OVER)
		expect(h.gate.cpuState?.(h.mono)?.label).toBe("own-over")
		h.step(99, null)
		expect(h.gate.cpuState?.(h.mono)?.label).toBe("host-busy-unattributed")
		expect(h.gate.cpuState?.(h.mono + 6_001)).toBeNull()
	})
})
