import { describe, expect, it } from "vitest"
import { loopPhase, runBench } from "../../../scripts/bench/burst-absorber.js"

describe("burst absorber bench", () => {
	it("awaits real continuations before disposing a paced backlog", async () => {
		// Ending during catch-up leaves substantially more than three capped steps.
		const { result } = await loopPhase({ rate: 2_048_000, seconds: 0.4 }, false)
		expect(result.ingestedBytes).toBe(1_638_400)
		expect(result.deliveredBytes + result.overflowBytes).toBe(
			result.ingestedBytes,
		)
		expect(result.overflowBytes).toBe(0)
	})

	it("measures finite costs and conserves ingested bytes", () => {
		const result = runBench({ rate: 2_048_000, seconds: 1 })
		for (const value of Object.values(result)) {
			expect(Number.isFinite(value)).toBe(true)
			expect(value).toBeGreaterThanOrEqual(0)
		}
		expect(result.loopP99AddedMs).toBe(0)
		expect(result.holdPeriodMs).toBe(450)
		expect(result.catchupPeriodMs).toBe(450)
		expect(result.holdCoreFraction * 450).toBeCloseTo(
			result.holdCoreFractionAvg * 1000,
		)
		expect(result.releaseCoreFraction * 450).toBeCloseTo(
			result.releaseCoreFractionAvg * 1000,
		)
		expect(result.ringBytes).toBe(2 * 2_048_000 * 2)
		expect(result.ingestedBytes).toBe(2_048_000 * 2)
		expect(result.deliveredBytes + result.overflowBytes).toBe(
			result.ingestedBytes,
		)
	})
})
