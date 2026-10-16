import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { CoverageManager } from "../../../../src/core/coverage/coverage-manager.js"
import { CoverageTracker } from "../../../../src/core/coverage/coverage-tracker.js"
import { haversineM } from "../../../../src/core/coverage/geo.js"
import { STATION_COVERAGE_RESET_M } from "../../../../src/core/station/contract.js"
import type { AircraftState } from "@wavekit/api-types"

const NOW = Date.parse("2026-10-16T12:00:00.000Z")
const A = { lat: 50, lon: 5 }

function seeded(station: { lat: number; lon: number } | null = A) {
	const t = new CoverageTracker(station)
	if (station) t.observe("adsb", station.lat + 0.5, station.lon, NOW, NOW)
	return t
}
const accepted = (t: CoverageTracker) =>
	t.query(NOW).protocols.find(p => p.protocol === "adsb")?.accepted ?? 0

/** A point `m` metres due north of `p` (spherical, matching haversine's radius). */
function north(p: { lat: number; lon: number }, m: number) {
	let lo = 0
	let hi = 1
	while (haversineM(p.lat, p.lon, p.lat + hi, p.lon) < m) hi *= 2
	for (let i = 0; i < 80; i++) {
		const mid = (lo + hi) / 2
		if (haversineM(p.lat, p.lon, p.lat + mid, p.lon) < m) lo = mid
		else hi = mid
	}
	return { lat: p.lat + hi, lon: p.lon }
}

describe("CoverageTracker.setStation", () => {
	it("keeps cells for a small move and uses the new station", () => {
		const t = seeded()
		const next = north(A, 500)
		expect(t.setStation(next)).toEqual({ cleared: false })
		expect(accepted(t)).toBe(1)
		expect(t.query(NOW).station).toEqual(next)
	})

	it("is not cleared at exactly 1000 m and is cleared just over", () => {
		const exact = north(A, STATION_COVERAGE_RESET_M)
		const d = haversineM(A.lat, A.lon, exact.lat, exact.lon)
		const t = seeded()
		const edge = d > STATION_COVERAGE_RESET_M ? north(A, 999.9) : exact
		expect(t.setStation(edge).cleared).toBe(false)
		const over = seeded()
		expect(over.setStation(north(A, 1000.5)).cleared).toBe(true)
		expect(accepted(over)).toBe(0)
	})

	it("clears when the station is removed and when it is first set", () => {
		const t = seeded()
		expect(t.setStation(null)).toEqual({ cleared: true })
		expect(t.query(NOW).available).toBe(false)
		expect(t.observe("adsb", 1, 1, NOW, NOW)).toBe(false)
		expect(t.setStation(A)).toEqual({ cleared: true })
		expect(accepted(t)).toBe(0)
		expect(t.setStation(null)).toEqual({ cleared: true })
		expect(t.setStation(null)).toEqual({ cleared: false })
	})

	it("computes ranges from the new station", () => {
		const t = seeded()
		const far = { lat: 51, lon: 5 }
		t.setStation(far)
		t.observe("adsb", 51.2, 5, NOW, NOW)
		const range = t.query(NOW).protocols[0]?.maxRangeM ?? 0
		expect(range).toBeCloseTo(haversineM(51, 5, 51.2, 5), 0)
	})

	// Feature: web-gaps-4, Property 12: Coverage reset
	// Validates: Requirements 6.10
	it("Property 12: cleared iff set/unset flips or the move exceeds 1000 m", () => {
		const point = fc.record({
			lat: fc.double({ min: -80, max: 80, noNaN: true }),
			lon: fc.double({ min: -179, max: 179, noNaN: true }),
		})
		const maybe = fc.option(point, { nil: null })
		fc.assert(
			fc.property(
				maybe,
				fc.oneof(
					maybe,
					fc
						.tuple(point, fc.double({ min: 0, max: 3000, noNaN: true }))
						.map(([p, m]) => north(p, m)),
				),
				fc.boolean(),
				(old, next, near) => {
					const target =
						near && old !== null && next !== null ? north(old, 400) : next
					const t = seeded(old)
					const before = accepted(t)
					const expected =
						(old === null) !== (target === null) ||
						(old !== null &&
							target !== null &&
							haversineM(old.lat, old.lon, target.lat, target.lon) >
								STATION_COVERAGE_RESET_M)
					const result = t.setStation(target)
					expect(result.cleared).toBe(expected)
					if (expected) expect(accepted(t)).toBe(0)
					else expect(accepted(t)).toBe(before)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("CoverageManager.setStation", () => {
	it("delegates and resets per-entity dedupe on clear", () => {
		const m = new CoverageManager({ station: A, now: () => NOW })
		const state = {
			icao: "ABC123",
			position: { lat: 50.5, lon: 5 },
			lastUpdated: NOW,
		} as AircraftState
		m.observeAircraft(state)
		expect(m.setStation(north(A, 100))).toEqual({ cleared: false })
		expect(m.query("adsb").protocols[0]?.accepted).toBe(1)
		expect(m.setStation(null)).toEqual({ cleared: true })
		expect(m.setStation(A)).toEqual({ cleared: true })
		// same position object is observed again after the maps were reset
		m.observeAircraft(state)
		expect(m.query("adsb").protocols[0]?.accepted).toBe(1)
	})
})
