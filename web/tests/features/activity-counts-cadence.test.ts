// The live chip-count refresh (POST /api/activity/facets while rows stream): 4 s while the read is
// cheap, stretched by a slow read, backed off by failures, never past a minute.
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
	LIVE_COUNTS_MAX_MS,
	LIVE_COUNTS_MS,
	liveCountsDelayMs,
} from "../../src/features/activity/controller.ts"

describe("live chip-count cadence", () => {
	it("stays at 4 s while the counts read is fast", () => {
		expect(liveCountsDelayMs(0, 0)).toBe(LIVE_COUNTS_MS)
		expect(liveCountsDelayMs(10, 0)).toBe(4_000)
		// 80 ms x 50 = 4 s: the stretch takes over just past here.
		expect(liveCountsDelayMs(80, 0)).toBe(4_000)
		expect(liveCountsDelayMs(81, 0)).toBe(4_050)
	})

	it("stretches to 50x a slow read and stops at a minute", () => {
		expect(liveCountsDelayMs(250, 0)).toBe(12_500)
		expect(liveCountsDelayMs(1_200, 0)).toBe(60_000)
		expect(liveCountsDelayMs(1_201, 0)).toBe(LIVE_COUNTS_MAX_MS)
	})

	it("doubles per failure in a row up to the minute ceiling", () => {
		expect([0, 1, 2, 3, 4, 5, 50].map(n => liveCountsDelayMs(0, n))).toEqual([
			4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
		])
	})

	it("is always between 4 s and 60 s and never shorter for a slower read", () => {
		// Feature: longevity, Property 3: live counts delay bounds and monotonicity
		// Validates: Requirements B.4
		fc.assert(
			fc.property(
				fc.double({ min: -10, max: 1e6, noNaN: true }),
				fc.double({ min: 0, max: 1e6, noNaN: true }),
				fc.integer({ min: 0, max: 100 }),
				(readMs, extraMs, failures) => {
					const delay = liveCountsDelayMs(readMs, failures)
					expect(delay).toBeGreaterThanOrEqual(LIVE_COUNTS_MS)
					expect(delay).toBeLessThanOrEqual(LIVE_COUNTS_MAX_MS)
					expect(
						liveCountsDelayMs(readMs + extraMs, failures),
					).toBeGreaterThanOrEqual(delay)
					expect(
						liveCountsDelayMs(readMs, failures + 1),
					).toBeGreaterThanOrEqual(delay)
				},
			),
			{ numRuns: 100 },
		)
	})
})
