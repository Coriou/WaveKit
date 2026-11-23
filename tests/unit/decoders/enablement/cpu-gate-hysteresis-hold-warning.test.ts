import { describe, expect, it } from "vitest"
import {
	CPU_RELEASE_SAMPLES,
	EFFICIENCY_CLEAR_MS,
	EFFICIENCY_SAMPLE_MS,
} from "../../../../src/decoders/enablement/contract.js"
import {
	CPU_HOLD_WARN_MS,
	CPU_HOLD_WARN_WINDOWS,
} from "../../../../src/decoders/enablement/efficiency-gate.js"
import { CAPACITY, gateHarness } from "./rx-starvation-harness.js"

/**
 * A cpu hold that outlives 10 clear windows while the latest sample cannot
 * release it logs one warning naming the reason; the release policy is
 * unchanged.
 */
const ownAt = (percent: number) => (percent / 100) * CAPACITY
const MSG = "Decoder still held for cpu: an operator start releases it"
/** Samples from the hold to the bound: 600 000 / 2000 = 300. */
const BOUND_STEPS = CPU_HOLD_WARN_MS / EFFICIENCY_SAMPLE_MS

const held = () => {
	const h = gateHarness()
	expect(h.start("p", { tuned: true }).admit).toBe(true)
	h.running.splice(0)
	h.gate.noteSuspended("p", "cpu", h.mono, true)
	return h
}
const warnings = (h: ReturnType<typeof gateHarness>) =>
	h.logs.filter(l => l.level === "warn" && l.msg === MSG)
const admitP = (h: ReturnType<typeof gateHarness>) =>
	h.gate.admit(h.wanted("p", { tuned: true }), h.running, h.mono)

describe("long cpu hold warning", () => {
	it("the bound is 10 clear windows: 10 × 60 000 ms = 10 min", () => {
		expect(CPU_HOLD_WARN_WINDOWS).toBe(10)
		expect(CPU_HOLD_WARN_MS).toBe(10 * EFFICIENCY_CLEAR_MS)
		expect(CPU_HOLD_WARN_MS).toBe(600_000)
		expect(BOUND_STEPS).toBe(300)
	})
	it("above-release-level: silent before the bound, one warning at it, none past it", () => {
		const h = held()
		for (let i = 0; i < BOUND_STEPS - 1; i++) h.step(10, ownAt(85.4))
		expect(warnings(h)).toEqual([])
		h.step(10, ownAt(85.4))
		expect(warnings(h)).toEqual([
			{
				level: "warn",
				msg: MSG,
				obj: {
					decoderId: "p",
					reason: "above-release-level",
					heldMinutes: 10,
					ownPercent: 85,
					releasePercent: 80,
				},
			},
		])
		for (let i = 0; i < 2 * BOUND_STEPS; i++) h.step(10, ownAt(88))
		expect(warnings(h)).toHaveLength(1)
		// The policy is unchanged: still held.
		expect(admitP(h)).toMatchObject({ admit: false, detail: "cpu" })
	})
	it("own exactly at the release level (80 %) warns as above-release-level", () => {
		const h = held()
		for (let i = 0; i < BOUND_STEPS; i++) h.step(10, ownAt(80))
		expect(warnings(h).map(l => l.obj["reason"])).toEqual([
			"above-release-level",
		])
	})
	it("own-cpu-unavailable: one warning at the bound, none past it, no ownPercent", () => {
		const h = held()
		for (let i = 0; i < BOUND_STEPS - 1; i++) h.step(10, null)
		expect(warnings(h)).toEqual([])
		h.step(10, null)
		expect(warnings(h)).toEqual([
			{
				level: "warn",
				msg: MSG,
				obj: {
					decoderId: "p",
					reason: "own-cpu-unavailable",
					heldMinutes: 10,
				},
			},
		])
		for (let i = 0; i < 2 * BOUND_STEPS; i++) h.step(10, null)
		expect(warnings(h)).toHaveLength(1)
	})
	it("a sample under the release level at the bound defers the warning to a sample that cannot release", () => {
		const h = held()
		for (let i = 0; i < BOUND_STEPS - 5; i++) h.step(10, ownAt(85))
		for (let i = 0; i < 10; i++) h.step(10, ownAt(50))
		expect(warnings(h)).toEqual([])
		h.step(10, null)
		expect(warnings(h).map(l => l.obj["reason"])).toEqual([
			"own-cpu-unavailable",
		])
	})
	it("a hold released by a release run does not warn", () => {
		const h = held()
		for (let i = 0; i < CPU_RELEASE_SAMPLES; i++) h.step(10, ownAt(50))
		expect(admitP(h)).toEqual({ admit: true })
		h.running.splice(0)
		for (let i = 0; i < 2 * BOUND_STEPS; i++) h.step(10, ownAt(85))
		expect(warnings(h)).toEqual([])
	})
	it("a hold ended by an operator start does not warn", () => {
		const h = held()
		h.step(10, ownAt(85))
		h.gate.releaseCpuHold?.("p")
		for (let i = 0; i < 2 * BOUND_STEPS; i++) h.step(10, ownAt(85))
		expect(warnings(h)).toEqual([])
	})
	it("a new hold after a warned one may warn again", () => {
		const h = held()
		for (let i = 0; i < BOUND_STEPS; i++) h.step(10, ownAt(85))
		expect(warnings(h)).toHaveLength(1)
		h.gate.noteSuspended("p", "cpu", h.mono, true)
		for (let i = 0; i < BOUND_STEPS - 1; i++) h.step(10, ownAt(85))
		expect(warnings(h)).toHaveLength(1)
		h.step(10, ownAt(85))
		expect(warnings(h)).toHaveLength(2)
	})
})
