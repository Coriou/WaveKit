import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { haversineM } from "../../../../src/core/coverage/geo.js"
import {
	computeEstimate,
	sphericalGeometricMedian,
	type WeightedPosition,
} from "../../../../src/core/station-estimate/estimator.js"

const DEG = Math.PI / 180

/** Point at angular distance `distDeg` and bearing `bearingDeg` from (lat, lon). */
function destination(
	lat: number,
	lon: number,
	bearingDeg: number,
	distDeg: number,
): { lat: number; lon: number } {
	const p1 = lat * DEG
	const l1 = lon * DEG
	const b = bearingDeg * DEG
	const d = distDeg * DEG
	const p2 = Math.asin(
		Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b),
	)
	const l2 =
		l1 +
		Math.atan2(
			Math.sin(b) * Math.sin(d) * Math.cos(p1),
			Math.cos(d) - Math.sin(p1) * Math.sin(p2),
		)
	return { lat: p2 / DEG, lon: wrapLon(l2 / DEG) }
}
function wrapLon(lon: number): number {
	const w = ((((lon + 180) % 360) + 360) % 360) - 180
	return w === 0 ? 0 : w
}
function lonDiff(a: number, b: number): number {
	return Math.abs(wrapLon(a - b))
}
const angleDeg = (
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
): number => haversineM(a.lat, a.lon, b.lat, b.lon) / 6_371_000 / DEG

const weightArb = fc.constantFrom(1, 2, 4)
const centreArb = fc.record({
	lat: fc.double({ min: -89, max: 89, noNaN: true }),
	lon: fc.double({ min: -180, max: 179.999, noNaN: true }),
})
const offsetArb = fc.record({
	bearing: fc.double({ min: 0, max: 360, noNaN: true }),
	frac: fc.double({ min: 0, max: 1, noNaN: true }),
	weight: weightArb,
})

function capSet(
	centre: { lat: number; lon: number },
	radiusDeg: number,
	offsets: { bearing: number; frac: number; weight: number }[],
): WeightedPosition[] {
	return offsets.map(o => ({
		...destination(centre.lat, centre.lon, o.bearing, o.frac * radiusDeg),
		weight: o.weight,
	}))
}

describe("station estimate properties", () => {
	// Feature: web-gaps-4, Property 3: Estimate equivariance
	// Validates: Requirements 2.4, 2.5
	it("rotating every longitude by delta rotates the unrounded estimate by delta", () => {
		fc.assert(
			fc.property(
				fc.record({
					lat: fc.double({ min: -70, max: 70, noNaN: true }),
					lon: fc.double({ min: -180, max: 179.999, noNaN: true }),
				}),
				fc.double({ min: 0.5, max: 15, noNaN: true }),
				fc.array(offsetArb, { minLength: 10, maxLength: 60 }),
				fc.double({ min: -720, max: 720, noNaN: true }),
				(centre, radius, offsets, delta) => {
					const set = capSet(centre, radius, offsets)
					const rotated = set.map(p => ({ ...p, lon: wrapLon(p.lon + delta) }))
					const a = sphericalGeometricMedian(set)
					const b = sphericalGeometricMedian(rotated)
					expect(a).not.toBeNull()
					expect(b).not.toBeNull()
					expect(Math.abs(a!.lat - b!.lat)).toBeLessThan(1e-6)
					expect(lonDiff(a!.lon + delta, b!.lon)).toBeLessThan(1e-6)
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: web-gaps-4, Property 4: Estimate bounds
	// Validates: Requirements 2.3, 2.4, 2.5
	it("the estimate lies inside the contributors' spherical cap and rounds within 0.025 deg", () => {
		fc.assert(
			fc.property(
				centreArb,
				fc.double({ min: 0.01, max: 30, noNaN: true }),
				fc.array(offsetArb, { minLength: 10, maxLength: 60 }),
				(centre, radius, offsets) => {
					const set = capSet(centre, radius, offsets)
					const r = computeEstimate(set)
					expect(r.available).toBe(true)
					if (!r.available) return
					const raw = { lat: r.rawLat, lon: r.rawLon }
					expect(angleDeg(centre, raw)).toBeLessThanOrEqual(radius + 1e-6)
					expect(Math.abs(r.lat - r.rawLat)).toBeLessThanOrEqual(0.025 + 1e-9)
					expect(lonDiff(r.lon, r.rawLon)).toBeLessThanOrEqual(0.025 + 1e-9)
					expect(r.lon).toBeGreaterThanOrEqual(-180)
					expect(r.lon).toBeLessThan(180)
					expect(r.uncertaintyKm % 5).toBe(0)
					expect(r.uncertaintyKm).toBeGreaterThanOrEqual(10)
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: web-gaps-4, Property 4: Estimate bounds
	// Validates: Requirements 2.3, 2.4, 2.5
	it("a point-symmetric set resolves to its centre", () => {
		fc.assert(
			fc.property(
				centreArb,
				fc.array(
					fc.record({
						bearing: fc.double({ min: 0, max: 180, noNaN: true }),
						dist: fc.double({ min: 0.01, max: 20, noNaN: true }),
						weight: weightArb,
					}),
					{ minLength: 5, maxLength: 30 },
				),
				(centre, pairs) => {
					const set: WeightedPosition[] = []
					for (const p of pairs) {
						set.push({
							...destination(centre.lat, centre.lon, p.bearing, p.dist),
							weight: p.weight,
						})
						set.push({
							...destination(centre.lat, centre.lon, p.bearing + 180, p.dist),
							weight: p.weight,
						})
					}
					const m = sphericalGeometricMedian(set)
					expect(m).not.toBeNull()
					expect(angleDeg(centre, m!)).toBeLessThan(1e-6)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: web-gaps-4, Property 4: Estimate bounds
	// Validates: Requirements 2.3, 2.4, 2.5
	it("below the thresholds the estimate is unavailable", () => {
		fc.assert(
			fc.property(
				centreArb,
				fc.array(offsetArb, { minLength: 0, maxLength: 9 }),
				(centre, offsets) => {
					const set = capSet(centre, 5, offsets)
					const direct = set.filter(p => p.weight !== 1).length
					const r = computeEstimate(set)
					if (direct < 3) {
						expect(r).toEqual({ available: false, reason: "too-few-positions" })
					} else {
						expect(r.available).toBe(true)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})
