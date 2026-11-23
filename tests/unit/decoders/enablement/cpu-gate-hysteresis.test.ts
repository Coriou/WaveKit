import { describe, expect, it } from "vitest"
import {
	CPU_RELEASE_SAMPLES,
	cpuReleasePercent,
	OWN_OVER_SUSTAIN_MS,
	OWN_OVER_SUSTAIN_SAMPLES,
	EFFICIENCY_SAMPLE_MS,
	EFFICIENCY_CLEAR_MS,
	TUNED_RETRY_MS,
	cpuHoldKey,
	placementKey,
} from "../../../../src/decoders/enablement/contract.js"
import {
	CAPACITY,
	gateHarness,
	OWN_CALM,
	OWN_OVER,
} from "./rx-starvation-harness.js"

/**
 * rx-starvation hysteresis: own CPU over the guard share is `cpu` evidence only
 * once sustained for OWN_OVER_SUSTAIN_MS (5 samples), and a placement suspended
 * for `cpu` is readmitted only after one clear window under the release
 * threshold (guard − 10 points).
 */
/** Own cores at `percent` % of CAPACITY. */
const ownAt = (percent: number) => (percent / 100) * CAPACITY

describe("constants", () => {
	it("10 s of sustain is 5 samples; the release window is 30 samples under 80 % at a 90 % guard", () => {
		expect(OWN_OVER_SUSTAIN_MS).toBe(10_000)
		expect(OWN_OVER_SUSTAIN_SAMPLES).toBe(
			OWN_OVER_SUSTAIN_MS / EFFICIENCY_SAMPLE_MS,
		)
		expect(OWN_OVER_SUSTAIN_SAMPLES).toBe(5)
		expect(CPU_RELEASE_SAMPLES).toBe(EFFICIENCY_CLEAR_MS / EFFICIENCY_SAMPLE_MS)
		expect(cpuReleasePercent(90)).toBe(80)
		// Never below half the guard.
		expect(cpuReleasePercent(12)).toBe(6)
	})
})

describe("sustained own-over evidence", () => {
	it("probation: 4 own-over samples give no cpu verdict; the 5th does", () => {
		const h = gateHarness()
		h.start("a")
		for (let i = 0; i < OWN_OVER_SUSTAIN_SAMPLES - 1; i++)
			expect(h.step(10, OWN_OVER)).toEqual([])
		expect(h.step(10, OWN_OVER)).toEqual([{ key: "a", detail: "cpu" }])
	})
	it("own at its quota (1.498 of 1.5 cores, the live trip) for 4 samples at a time is no evidence; held 5 samples it is", () => {
		const h = gateHarness()
		h.start("a")
		// 1.498 / 1.5 × 100 = 99.87 % > 90 %: own-over, but 4 samples (8 s) only.
		for (let round = 0; round < 2; round++) {
			for (let i = 0; i < 4; i++) expect(h.step(10, 1.498, 1.5)).toEqual([])
			// 1.2 / 1.5 = 80 %: under the guard, the run ends.
			expect(h.step(10, 1.2, 1.5)).toEqual([])
		}
		for (let i = 0; i < 4; i++) expect(h.step(10, 1.498, 1.5)).toEqual([])
		expect(h.step(10, 1.498, 1.5)).toEqual([{ key: "a", detail: "cpu" }])
	})
	it("a gap past 4000 ms breaks the run; a gap of exactly 4000 ms does not", () => {
		const broken = gateHarness()
		broken.start("a")
		for (let i = 0; i < 3; i++) expect(broken.step(10, OWN_OVER)).toEqual([])
		broken.advance(2_001)
		// 4001 ms after the previous: a new run of 1, then 2.
		expect(broken.step(10, OWN_OVER)).toEqual([])
		expect(broken.step(10, OWN_OVER)).toEqual([])
		for (let i = 0; i < 2; i++) expect(broken.step(10, OWN_OVER)).toEqual([])
		expect(broken.step(10, OWN_OVER)).toEqual([{ key: "a", detail: "cpu" }])
		const kept = gateHarness()
		kept.start("a")
		for (let i = 0; i < 3; i++) expect(kept.step(10, OWN_OVER)).toEqual([])
		kept.advance(2_000)
		expect(kept.step(10, OWN_OVER)).toEqual([])
		expect(kept.step(10, OWN_OVER)).toEqual([{ key: "a", detail: "cpu" }])
	})
	it("a calm or unknown sample breaks the run", () => {
		for (const breaker of [OWN_CALM, null]) {
			const h = gateHarness()
			h.start("a")
			for (let i = 0; i < 4; i++) expect(h.step(10, OWN_OVER)).toEqual([])
			expect(h.step(10, breaker)).toEqual([])
			for (let i = 0; i < 4; i++) expect(h.step(10, OWN_OVER)).toEqual([])
			expect(h.step(10, OWN_OVER)).toEqual([{ key: "a", detail: "cpu" }])
		}
	})
	it("admission: 4 own-over samples admit; the 5th refuses with cpu", () => {
		const h = gateHarness()
		h.start("u1", { cost: 0.3 })
		for (let i = 0; i < 16; i++) h.step(10, OWN_CALM)
		for (let i = 0; i < 4; i++) {
			h.step(10, OWN_OVER)
			expect(h.gate.admit(h.wanted(`n${i}`), h.running, h.mono)).toEqual({
				admit: true,
			})
		}
		h.step(10, OWN_OVER)
		expect(h.gate.admit(h.wanted("n"), h.running, h.mono)).toMatchObject({
			admit: false,
			detail: "cpu",
		})
	})
	it("scapegoat: a tuned probationer sheds an untuned one only on the 5th own-over sample", () => {
		const h = gateHarness()
		h.start("u1")
		for (let i = 0; i < 16; i++) h.step(10, OWN_CALM)
		expect(h.start("tuned", { tuned: true }).admit).toBe(true)
		for (let i = 0; i < 4; i++) expect(h.step(10, OWN_OVER)).toEqual([])
		expect(h.step(10, OWN_OVER)).toEqual([{ key: "u1", detail: "cpu" }])
	})
})

describe("release after a cpu suspension", () => {
	/** A tuned placement suspended for cpu now (30 000 ms loss backoff). */
	const suspended = () => {
		const h = gateHarness()
		expect(h.start("p", { tuned: true }).admit).toBe(true)
		h.running.splice(0)
		h.gate.noteSuspended("p", "cpu", h.mono, true)
		return h
	}
	const admitP = (h: ReturnType<typeof gateHarness>) =>
		h.gate.admit(h.wanted("p", { tuned: true }), h.running, h.mono)

	it("is not readmitted at once, nor on calm samples after its retry backoff ran out", () => {
		const h = suspended()
		expect(admitP(h)).toMatchObject({ admit: false, detail: "cpu" })
		// Past the 30 000 ms tuned backoff: only the hold refuses now.
		h.advance(TUNED_RETRY_MS + 1_000)
		for (let i = 0; i < 3; i++) {
			h.step(10, OWN_CALM)
			expect(admitP(h)).toMatchObject({ admit: false, detail: "cpu" })
		}
		// Control: a drops suspension with the same timing is admitted there.
		const c = gateHarness()
		expect(c.start("p", { tuned: true }).admit).toBe(true)
		c.running.splice(0)
		c.gate.noteSuspended("p", "drops", c.mono, true)
		c.advance(TUNED_RETRY_MS + 1_000)
		for (let i = 0; i < 3; i++) c.step(10, OWN_CALM)
		expect(
			c.gate.admit(c.wanted("p", { tuned: true }), c.running, c.mono),
		).toEqual({
			admit: true,
		})
	})
	it("29 samples below the release threshold hold it; the 30th releases it", () => {
		const h = suspended()
		for (let i = 0; i < CPU_RELEASE_SAMPLES - 1; i++) {
			h.step(10, ownAt(79.9))
			expect(admitP(h)).toMatchObject({ admit: false, detail: "cpu" })
		}
		h.step(10, ownAt(79.9))
		expect(admitP(h)).toEqual({ admit: true })
	})
	it("own exactly at the release threshold (80 %) or above it (85 %) never releases", () => {
		for (const percent of [80, 85]) {
			const h = suspended()
			for (let i = 0; i < 3 * CPU_RELEASE_SAMPLES; i++) {
				h.step(10, ownAt(percent))
				expect(admitP(h)).toMatchObject({ admit: false, detail: "cpu" })
			}
		}
	})
	it("a sample at or above the threshold, unknown, or after a gap restarts the release window", () => {
		for (const breaker of ["at", "unknown", "gap"] as const) {
			const h = suspended()
			for (let i = 0; i < 20; i++) h.step(10, ownAt(50))
			if (breaker === "gap") {
				h.advance(2_001)
				h.step(10, ownAt(50))
			} else h.step(10, breaker === "at" ? ownAt(80) : null)
			// After a gap the first sample (under the threshold) opens the new run.
			const opened = breaker === "gap" ? 1 : 0
			for (let i = 0; i < CPU_RELEASE_SAMPLES - 1 - opened; i++) {
				h.step(10, ownAt(50))
				expect(admitP(h)).toMatchObject({ admit: false, detail: "cpu" })
			}
			h.step(10, ownAt(50))
			expect(admitP(h)).toEqual({ admit: true })
		}
	})
	it("a stale release run does not release", () => {
		const h = suspended()
		for (let i = 0; i < CPU_RELEASE_SAMPLES; i++) h.step(10, ownAt(50))
		h.advance(6_001)
		expect(admitP(h).admit).toBe(false)
	})
	it("host busy does not excuse a held placement, and an untuned one waits for both its backoff and the release", () => {
		const h = gateHarness()
		expect(h.start("u").admit).toBe(true)
		h.running.splice(0)
		h.gate.noteSuspended("u", "cpu", h.mono)
		// 300 s of own CPU between release and guard (85 %), host busy: still held.
		for (let i = 0; i < 160; i++) h.step(100, ownAt(85))
		expect(h.gate.admit(h.wanted("u"), h.running, h.mono)).toMatchObject({
			admit: false,
			detail: "cpu",
		})
	})
	it("a tuned newcomer held for cpu may still swap untuned placements out", () => {
		const h = gateHarness()
		h.start("u1", { cost: 0.3 })
		for (let i = 0; i < 16; i++) h.step(10, OWN_CALM)
		h.gate.noteSuspended("p", "cpu", h.mono, true)
		for (let i = 0; i < 16; i++) h.step(10, ownAt(85))
		expect(admitP(h)).toEqual({ admit: true, displace: ["u1"] })
	})
	it("forget keeps the hold; an operator start (releaseCpuHold) ends it", () => {
		const h = suspended()
		h.step(10, ownAt(85))
		h.gate.forget("p")
		expect(admitP(h)).toMatchObject({ admit: false, detail: "cpu" })
		h.gate.releaseCpuHold?.("p")
		expect(admitP(h)).toEqual({ admit: true })
	})
	it("an operator start ends an untuned decoder's hold too (its retry delay still applies)", () => {
		const h = gateHarness()
		expect(h.start("u").admit).toBe(true)
		h.running.splice(0)
		h.gate.noteSuspended("u", "cpu", h.mono)
		// Past the 300 000 ms untuned backoff, own CPU at 85 %: held only.
		for (let i = 0; i < 160; i++) h.step(10, ownAt(85))
		expect(h.gate.admit(h.wanted("u"), h.running, h.mono)).toMatchObject({
			admit: false,
			detail: "cpu",
		})
		// That held refusal took a fresh 300 000 ms retry: without the
		// operator start the decoder is still held once it runs out.
		const control = gateHarness()
		expect(control.start("u").admit).toBe(true)
		control.running.splice(0)
		control.gate.noteSuspended("u", "cpu", control.mono)
		h.gate.releaseCpuHold?.("u")
		for (const g of [h, control]) {
			for (let i = 0; i < 160; i++) g.step(10, ownAt(85))
			// Re-asked once its retry delay ran out (refusals re-arm it).
			g.gate.admit(g.wanted("u"), g.running, g.mono)
			for (let i = 0; i < 160; i++) g.step(10, ownAt(85))
		}
		expect(h.gate.admit(h.wanted("u"), h.running, h.mono)).toEqual({
			admit: true,
		})
		expect(
			control.gate.admit(control.wanted("u"), control.running, control.mono),
		).toMatchObject({ admit: false, detail: "cpu" })
	})
	it("a suspension for another detail alone holds nothing", () => {
		const h = gateHarness()
		expect(h.start("p", { tuned: true }).admit).toBe(true)
		h.running.splice(0)
		h.gate.noteSuspended("p", "drops", h.mono, true)
		for (let i = 0; i < 31; i++) h.step(10, ownAt(85))
		expect(admitP(h).admit).toBe(true)
	})
	it("a later suspension for another detail does not end a cpu hold", () => {
		const h = gateHarness()
		expect(h.start("p", { tuned: true }).admit).toBe(true)
		h.running.splice(0)
		h.gate.noteSuspended("p", "cpu", h.mono, true)
		h.gate.noteSuspended("p", "drops", h.mono, true)
		for (let i = 0; i < 31; i++) h.step(10, ownAt(85))
		expect(admitP(h)).toMatchObject({ admit: false, detail: "cpu" })
	})
})

describe("the hold belongs to the decoder on its source, not to a channel", () => {
	const x = placementKey("dsd-fme", "s", "channel", 446_525_000)
	const y = placementKey("dsd-fme", "s", "channel", 446_550_000)
	const other = placementKey("dsd-fme", "t", "channel", 446_550_000)
	// Tuned placements: a held refusal arms no growing retry, so only the
	// hold decides.
	const shedOnX = () => {
		const h = gateHarness()
		expect(h.start(x, { tuned: true }).admit).toBe(true)
		h.running.splice(0)
		h.gate.noteSuspended(x, "cpu", h.mono, true)
		h.gate.forget(x)
		return h
	}
	const admit = (h: ReturnType<typeof gateHarness>, key: string) =>
		h.gate.admit(h.wanted(key, { tuned: true }), h.running, h.mono)

	it("cpuHoldKey leaves the channel out", () => {
		expect(cpuHoldKey(x)).toBe("dsd-fme@s")
		expect(cpuHoldKey(y)).toBe("dsd-fme@s")
		expect(cpuHoldKey(placementKey("dsd-fme", "s", "raw", null))).toBe(
			"dsd-fme@s",
		)
		expect(cpuHoldKey(other)).toBe("dsd-fme@t")
	})
	it("shed on channel X, the activity plan moves it to Y: Y is held until own CPU releases", () => {
		const h = shedOnX()
		// Own CPU between release and guard for 120 s: never released.
		for (let i = 0; i < 60; i++) {
			h.step(10, ownAt(85))
			expect(admit(h, y)).toMatchObject({ admit: false, detail: "cpu" })
		}
		for (let i = 0; i < CPU_RELEASE_SAMPLES - 1; i++) {
			h.step(10, ownAt(50))
			expect(admit(h, y)).toMatchObject({ admit: false, detail: "cpu" })
		}
		h.step(10, ownAt(50))
		expect(admit(h, y)).toEqual({ admit: true })
	})
	it("a replan that removes X and re-adds it keeps the hold", () => {
		const h = shedOnX()
		for (let i = 0; i < 160; i++) h.step(10, ownAt(85))
		h.gate.forget(x)
		expect(admit(h, x)).toMatchObject({ admit: false, detail: "cpu" })
	})
	it("the decoder on another source, and another decoder, are not held", () => {
		const h = shedOnX()
		h.step(10, ownAt(85))
		expect(admit(h, other)).toEqual({ admit: true })
		expect(admit(h, placementKey("ais", "s", "channel", 446_525_000))).toEqual({
			admit: true,
		})
	})
	it("an operator start releases the decoder's holds on every source", () => {
		const h = shedOnX()
		h.gate.noteSuspended(other, "cpu", h.mono, true)
		h.gate.forget(other)
		h.step(10, ownAt(85))
		expect(admit(h, other)).toMatchObject({ admit: false, detail: "cpu" })
		h.gate.releaseCpuHold?.("dsd-fme")
		expect(admit(h, y)).toEqual({ admit: true })
		expect(admit(h, other)).toEqual({ admit: true })
	})
})
