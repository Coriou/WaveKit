import { describe, expect, it } from "vitest"
import {
	EARTH_RADIUS_M,
	haversineM,
	initialBearingDeg,
} from "../../../../src/core/coverage/geo.js"

describe("haversineM", () => {
	it("uses the mean Earth radius", () => {
		expect(EARTH_RADIUS_M).toBe(6_371_000)
	})

	it("measures one degree of latitude as about 111 195 m", () => {
		expect(haversineM(0, 0, 1, 0)).toBeCloseTo(111_194.93, 1)
		expect(haversineM(45, 10, 46, 10)).toBeCloseTo(111_194.93, 1)
	})

	it("is zero for the same point and symmetric", () => {
		expect(haversineM(51.5, -0.12, 51.5, -0.12)).toBe(0)
		expect(haversineM(48.85, 2.35, 51.5, -0.12)).toBeCloseTo(
			haversineM(51.5, -0.12, 48.85, 2.35),
			6,
		)
	})

	it("matches a known city pair (Paris to London about 343.5 km)", () => {
		expect(haversineM(48.8566, 2.3522, 51.5074, -0.1278) / 1000).toBeCloseTo(
			343.5,
			0,
		)
	})

	it("keeps antimeridian crossings short", () => {
		const d = haversineM(0, 179.9, 0, -179.9)
		expect(d).toBeCloseTo(0.2 * 111_194.93, 0)
	})

	it("handles pole-adjacent points", () => {
		expect(haversineM(89.9, 0, 89.9, 180)).toBeCloseTo(0.2 * 111_194.93, 0)
	})
})

describe("initialBearingDeg", () => {
	it("returns cardinal bearings", () => {
		expect(initialBearingDeg(0, 0, 1, 0)).toBe(0)
		expect(initialBearingDeg(0, 0, 0, 1)).toBeCloseTo(90, 9)
		expect(initialBearingDeg(0, 0, -1, 0)).toBeCloseTo(180, 9)
		expect(initialBearingDeg(0, 0, 0, -1)).toBeCloseTo(270, 9)
	})

	it("normalises to [0, 360) and never returns -0", () => {
		const b = initialBearingDeg(10, 10, 11, 10)
		expect(Object.is(b, -0)).toBe(false)
		expect(b).toBe(0)
		const west = initialBearingDeg(10, 10, 10.0001, 9.999999)
		expect(west).toBeGreaterThan(359)
		expect(west).toBeLessThan(360)
	})

	it("crosses the antimeridian eastward", () => {
		expect(initialBearingDeg(0, 179.9, 0, -179.9)).toBeCloseTo(90, 6)
		expect(initialBearingDeg(0, -179.9, 0, 179.9)).toBeCloseTo(270, 6)
	})

	it("points due south from near the north pole", () => {
		expect(initialBearingDeg(89.9, 0, 89.8, 0)).toBeCloseTo(180, 6)
	})
})
