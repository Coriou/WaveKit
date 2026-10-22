import { describe, expect, it } from "vitest"
import { runBench } from "../../../scripts/bench/burst-absorber.js"

describe("burst absorber bench", () => {
	it("measures finite costs and conserves ingested bytes", () => {
		const result = runBench({ rate: 2_048_000, seconds: 1 })
		for (const value of Object.values(result)) {
			expect(Number.isFinite(value)).toBe(true)
			expect(value).toBeGreaterThanOrEqual(0)
		}
		expect(result.ringBytes).toBe(2 * 2_048_000 * 2)
		expect(result.ingestedBytes).toBe(2_048_000 * 2)
		expect(result.deliveredBytes + result.overflowBytes).toBe(
			result.ingestedBytes,
		)
	})
})
