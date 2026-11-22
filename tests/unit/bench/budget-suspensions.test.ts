import { expect, it } from "vitest"
import {
	suspensionGroups,
	suspensionsOf,
} from "../../../scripts/bench/budget-manifest.js"

const line = (t: number, fields: Record<string, unknown>) =>
	JSON.stringify({ level: 30, time: new Date(t).toISOString(), ...fields })
const S = Date.parse("2026-11-22T12:00:00.000Z")
const E = S + 60_000

it("counts suspensions in the window by reason and efficiency seconds per decoder", () => {
	const log = [
		// Suspended before the window: its seconds count from the window start.
		line(S - 5_000, {
			msg: "Decoder suspension changed",
			decoderId: "dsd-fme",
			reasonCode: "efficiency-budget",
			efficiencyDetail: "cpu",
		}),
		line(S + 10_000, {
			msg: "Decoder suspension changed",
			decoderId: "dsd-fme",
			reasonCode: null,
		}),
		line(S + 20_000, {
			msg: "Decoder suspension changed",
			decoderId: "dsd-fme",
			reasonCode: "efficiency-budget",
			efficiencyDetail: "late-drops",
		}),
		line(S + 21_000, {
			msg: "Decoder suspension changed",
			decoderId: "acarsdec",
			reasonCode: "efficiency-budget",
			efficiencyDetail: "unknown",
		}),
		line(S + 22_000, {
			msg: "Decoder suspension changed",
			decoderId: "acarsdec",
			reasonCode: "frequency-out-of-band",
		}),
		line(S + 30_000, {
			msg: "Efficiency probation verdict",
			detail: "cpu",
			scapegoat: true,
		}),
		line(S + 31_000, { msg: "Late drops shed a decoder" }),
		"not json",
		line(E + 1_000, {
			msg: "Decoder suspension changed",
			decoderId: "readsb",
			reasonCode: "efficiency-budget",
			efficiencyDetail: "cpu",
		}),
	].join("\n")
	const s = suspensionsOf(log, S, E)
	expect(s.entered).toEqual({
		"efficiency-budget:late-drops": 1,
		"efficiency-budget:unknown": 1,
		"frequency-out-of-band": 1,
	})
	// 10 s before its release plus 40 s to the window end.
	expect(s.efficiencySeconds).toEqual({ "dsd-fme": 50, acarsdec: 1 })
	expect(s.verdicts).toEqual({ "cpu:scapegoat": 1 })
	expect(s.lateSheds).toBe(1)
	expect(s.ownCpuUnavailable).toBe(false)
	expect(suspensionGroups(s)).toEqual({ cpu: 0, lateDrops: 1, other: 1 })
})

it("notes an own-CPU-unavailable core", () => {
	const s = suspensionsOf(
		line(S - 1, { msg: "own CPU unavailable: CPU shedding off" }),
		S,
		E,
	)
	expect(s.ownCpuUnavailable).toBe(true)
	expect(s.entered).toEqual({})
})
