/**
 * TrialMemory.analogFmTrials: the read the recorder's no-voice channel rule takes
 * (recording-verdict.ts VoicePrior.analogTrials): the analog FM replay trials of one discovery,
 * how often they ran and how often they heard (a `heard` counts as decoded).
 */
import { describe, expect, it } from "vitest"
import { TrialMemory } from "../../../../src/core/scanner/trial-memory.js"

describe("TrialMemory.analogFmTrials", () => {
	it("counts the analog-fm analog-demod trial only; heard counts as decoded; null when none ran", () => {
		const m = new TrialMemory({ now: () => 1_000 })
		expect(m.analogFmTrials("d1")).toBeNull()
		for (let k = 0; k < 12; k++)
			m.record("d1", "analog-fm", "analog-demod", "no-sync")
		m.record("d1", "dmr", "dsd-fme", "no-sync")
		m.record("d1", "analog-am", "analog-demod", "heard")
		expect(m.analogFmTrials("d1")).toEqual({ attempts: 12, decoded: 0 })
		m.record("d1", "analog-fm", "analog-demod", "heard")
		expect(m.analogFmTrials("d1")).toEqual({ attempts: 13, decoded: 1 })
		// Outcomes that are no attempt change nothing.
		m.record("d1", "analog-fm", "analog-demod", "cancelled")
		expect(m.analogFmTrials("d1")).toEqual({ attempts: 13, decoded: 1 })
		expect(m.analogFmTrials("d2")).toBeNull()
	})
})
