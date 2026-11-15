/**
 * TrialMemory.analogFmTrials: the read the recorder's no-voice channel rule takes
 * (recording-verdict.ts VoicePrior.analogTrials, analogTrialsHeard): the analog FM replay trials of
 * one discovery, how often they ran, how often they heard (a `heard` counts as decoded) and how
 * many failed ones still saw speech-like frames (`syllabic`).
 */
import { describe, expect, it } from "vitest"
import {
	TrialMemory,
	parseTrialMemory,
} from "../../../../src/core/scanner/trial-memory.js"

describe("TrialMemory.analogFmTrials", () => {
	it("counts the analog-fm analog-demod trial only; heard counts as decoded; null when none ran", () => {
		const m = new TrialMemory({ now: () => 1_000 })
		expect(m.analogFmTrials("d1")).toBeNull()
		for (let k = 0; k < 12; k++)
			m.record("d1", "analog-fm", "analog-demod", "no-sync")
		m.record("d1", "dmr", "dsd-fme", "no-sync")
		m.record("d1", "analog-am", "analog-demod", "heard")
		expect(m.analogFmTrials("d1")).toEqual({
			attempts: 12,
			decoded: 0,
			syllabic: 0,
		})
		m.record("d1", "analog-fm", "analog-demod", "heard")
		expect(m.analogFmTrials("d1")).toEqual({
			attempts: 13,
			decoded: 1,
			syllabic: 0,
		})
		// Outcomes that are no attempt change nothing.
		m.record("d1", "analog-fm", "analog-demod", "cancelled")
		expect(m.analogFmTrials("d1")).toEqual({
			attempts: 13,
			decoded: 1,
			syllabic: 0,
		})
		expect(m.analogFmTrials("d2")).toBeNull()
	})

	it("counts a failed trial that saw syllabic frames; a success or a non-attempt with them does not", () => {
		const m = new TrialMemory({ now: () => 1_000 })
		m.record("d1", "analog-fm", "analog-demod", "no-sync", true)
		m.record("d1", "analog-fm", "analog-demod", "carrier-only", true)
		m.record("d1", "analog-fm", "analog-demod", "carrier-only", false)
		m.record("d1", "analog-fm", "analog-demod", "heard", true)
		m.record("d1", "analog-fm", "analog-demod", "cancelled", true)
		expect(m.analogFmTrials("d1")).toEqual({
			attempts: 4,
			decoded: 1,
			syllabic: 2,
		})
		// Kept through a success, and stored only when non-zero.
		expect(m.view("d1")[0]?.syllabicMisses).toBe(2)
		m.record("d2", "analog-fm", "analog-demod", "no-sync")
		expect(m.view("d2")[0]).not.toHaveProperty("syllabicMisses")
	})

	it("persists syllabicMisses; a file claiming more than attempts − decoded drops the trial", () => {
		const m = new TrialMemory({ now: () => 1_000 })
		m.record("d1", "analog-fm", "analog-demod", "no-sync", true)
		const back = parseTrialMemory(JSON.parse(m.serialize()))
		expect(back.get("d1")?.[0]?.syllabicMisses).toBe(1)
		const bad = {
			version: 1,
			discoveries: {
				d1: [
					{
						protocol: "analog-fm",
						decoder: "analog-demod",
						attempts: 2,
						decoded: 1,
						consecutiveFailures: 1,
						lastOutcome: "no-sync",
						lastAt: 1,
						syllabicMisses: 2,
					},
				],
			},
		}
		expect(parseTrialMemory(bad).get("d1")).toBeUndefined()
	})
})
