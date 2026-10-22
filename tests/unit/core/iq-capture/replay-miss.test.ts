import { describe, expect, it } from "vitest"
import { replayMissEligible } from "../../../../src/core/iq-capture/replay-miss.js"

describe("replayMissEligible (review m3, MAJOR f)", () => {
	it("needs a gap-free capture at least as long as the hold", () => {
		const c = (durationMs: number, gapSamples = 0) => ({
			durationMs,
			gapSamples,
		})
		expect(replayMissEligible(c(1800), 1800)).toBe(true)
		expect(replayMissEligible(c(4000), 1800)).toBe(true)
		expect(replayMissEligible(c(1799), 1800)).toBe(false)
		expect(replayMissEligible(c(100), 1800)).toBe(false)
		expect(replayMissEligible(c(4000, 1), 1800)).toBe(false)
		expect(replayMissEligible(null, 1800)).toBe(false)
		expect(replayMissEligible(undefined, 1800)).toBe(false)
		expect(replayMissEligible(c(4000), undefined)).toBe(false)
		expect(replayMissEligible(c(4000), 0)).toBe(false)
		expect(replayMissEligible(c(4000), Number.NaN)).toBe(false)
	})
})
