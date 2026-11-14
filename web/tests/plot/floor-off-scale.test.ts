import { describe, expect, it } from "vitest"
import { OFF_SCALE_MARGIN_DB, floorOffScale } from "../../src/plot/maths.ts"

const scale = { minDb: -60, maxDb: 0 }

describe("floorOffScale", () => {
	it("is below once the floor is past the margin under the scale's bottom", () => {
		expect(floorOffScale(scale, -60)).toBeNull()
		expect(floorOffScale(scale, -60 - OFF_SCALE_MARGIN_DB)).toBeNull()
		expect(floorOffScale(scale, -60 - OFF_SCALE_MARGIN_DB - 0.1)).toBe("below")
		expect(floorOffScale(scale, -95)).toBe("below")
	})

	it("is above once the floor is over the scale's top", () => {
		expect(floorOffScale({ minDb: -120, maxDb: -70 }, -70)).toBeNull()
		expect(floorOffScale({ minDb: -120, maxDb: -70 }, -69.9)).toBe("above")
	})

	it("says nothing for a floor on the scale or unknown", () => {
		expect(floorOffScale(scale, -45)).toBeNull()
		for (const unknown of [null, undefined, Number.NaN, -Infinity, Infinity])
			expect(floorOffScale(scale, unknown)).toBeNull()
	})
})
