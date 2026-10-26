import { describe, expect, it } from "vitest"
import { bandplansFor } from "../../../../src/core/scanner/bandplan/index.js"
import { slotRasterOf } from "../../../../src/core/scanner/scanner-service.js"
import type { ScanRange } from "../../../../src/core/scanner/types.js"

// An analog-am range with several rasters sizes its channel slots by the finest.

const range = (over: Partial<ScanRange>): ScanRange => ({
	startHz: 118_000_000,
	endHz: 137_000_000,
	...over,
})

describe("slotRasterOf (amendment 10)", () => {
	it("the built-in airband range uses its 8.33 kHz raster", () => {
		const airband = bandplansFor("EU")
			.flatMap(b => b.ranges)
			.find(
				r =>
					(r.protocols ?? []).includes("analog-am") &&
					r.startHz === 118_000_000,
			)
		expect(airband).toBeDefined()
		expect(slotRasterOf(airband!)?.spacingHz).toBeCloseTo(25_000 / 3, 6)
	})

	it("the finest positive raster wins only for analog-am; others keep their first", () => {
		const rasters = [
			{ spacingHz: 25_000, firstChannelHz: 118_000_000 },
			{ spacingHz: 25_000 / 3, firstChannelHz: 118_000_000 },
		]
		expect(
			slotRasterOf(range({ rasters, protocols: ["analog-am"] }))?.spacingHz,
		).toBeCloseTo(25_000 / 3, 6)
		expect(
			slotRasterOf(range({ rasters, protocols: ["analog-fm"] }))?.spacingHz,
		).toBe(25_000)
		expect(slotRasterOf(range({ rasters }))?.spacingHz).toBe(25_000)
		// A single raster, or none, is unchanged.
		expect(
			slotRasterOf(range({ rasters: [rasters[0]!], protocols: ["analog-am"] }))
				?.spacingHz,
		).toBe(25_000)
		expect(slotRasterOf(range({ protocols: ["analog-am"] }))).toBeUndefined()
	})

	it("every 25 kHz airband channel lies on the 8.33 kHz grid (exact thirds)", () => {
		for (let k = 0; k < 760; k++) {
			const hz = 118_000_000 + k * 25_000
			const n = (hz - 118_000_000) / (25_000 / 3)
			expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-6)
		}
	})
})
