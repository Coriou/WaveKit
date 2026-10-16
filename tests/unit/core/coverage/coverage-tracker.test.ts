import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	COVERAGE_MAX_POSITION_AGE_MS,
	COVERAGE_MAX_RANGE_M,
	type CoverageProtocol,
} from "@wavekit/api-types"
import { CoverageTracker } from "../../../../src/core/coverage/coverage-tracker.js"
import {
	haversineM,
	initialBearingDeg,
} from "../../../../src/core/coverage/geo.js"

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 9, 16, 12, 0, 0)
const STATION = { lat: 51.5, lon: -0.12 }

describe("CoverageTracker", () => {
	it("rejects everything without a station and reports unavailable", () => {
		const t = new CoverageTracker(null)
		expect(t.observe("adsb", 52, 0, T0, T0)).toBe(false)
		const q = t.query(T0)
		expect(q.available).toBe(false)
		expect(q.reason).toBe("no-station-location")
		expect(q.station).toBeNull()
		expect(q.protocols).toEqual([])
		expect(q.rejected["no-station"]).toBe(1)
		expect(q.windowHours).toBe(24)
		expect(q.bearingStepDeg).toBe(1)
		expect(q.timestamp).toBe(new Date(T0).toISOString())
	})

	it("rejects invalid positions", () => {
		const t = new CoverageTracker({ lat: 0.5, lon: 0.5 })
		expect(t.observe("adsb", 0, 0, T0, T0)).toBe(false)
		expect(t.observe("adsb", Number.NaN, 0.5, T0, T0)).toBe(false)
		expect(t.observe("adsb", 91, 0, T0, T0)).toBe(false)
		expect(t.observe("adsb", 0, 180.5, T0, T0)).toBe(false)
		expect(t.observe("adsb", 0, Number.POSITIVE_INFINITY, T0, T0)).toBe(false)
		const q = t.query(T0)
		expect(q.rejected["invalid-position"]).toBe(5)
		expect(
			q.protocols.every(
				p => p.sectors.length === 0 && p.maxRangeM === null && p.accepted === 0,
			),
		).toBe(true)
	})

	it("rejects positions beyond the maximum range", () => {
		const t = new CoverageTracker(STATION)
		expect(t.observe("adsb", STATION.lat + 5, STATION.lon, T0, T0)).toBe(false)
		expect(t.query(T0).rejected["too-far"]).toBe(1)
		expect(
			haversineM(STATION.lat, STATION.lon, STATION.lat + 4, STATION.lon),
		).toBeLessThan(COVERAGE_MAX_RANGE_M)
		expect(t.observe("adsb", STATION.lat + 4, STATION.lon, T0, T0)).toBe(true)
	})

	it("rejects stale positions and accepts slightly future ones", () => {
		const t = new CoverageTracker(STATION)
		expect(
			t.observe("adsb", 52, 0, T0 - COVERAGE_MAX_POSITION_AGE_MS - 1, T0),
		).toBe(false)
		expect(t.observe("adsb", 52, 0, Number.NaN, T0)).toBe(false)
		expect(
			t.observe("adsb", 52, 0, T0 - COVERAGE_MAX_POSITION_AGE_MS, T0),
		).toBe(true)
		expect(t.observe("adsb", 52, 0, T0 + 5_000, T0)).toBe(true)
		expect(t.query(T0).rejected.stale).toBe(2)
	})

	it("keeps the farthest position per bearing and sorts sectors", () => {
		const t = new CoverageTracker(STATION)
		t.observe("adsb", 52.0, -0.12, T0, T0)
		t.observe("adsb", 52.5, -0.12, T0 + 1, T0 + 1)
		t.observe("adsb", 52.2, -0.12, T0 + 2, T0 + 2)
		t.observe("adsb", 51.5, 1.0, T0 + 3, T0 + 3)
		t.observe("ais", 51.0, -0.12, T0, T0)
		const q = t.query(T0 + 10)
		expect(q.available).toBe(true)
		expect(q.protocols.map(p => p.protocol)).toEqual(["adsb", "ais"])
		const adsb = q.protocols[0]!
		expect(adsb.accepted).toBe(4)
		expect(adsb.sectors.map(s => s.bearingDeg)).toEqual([0, 89])
		expect(adsb.sectors[0]!.lat).toBe(52.5)
		expect(adsb.sectors[0]!.at).toBe(new Date(T0 + 1).toISOString())
		expect(adsb.maxRangeM).toBeCloseTo(haversineM(51.5, -0.12, 52.5, -0.12), 6)
		const onlyAis = t.query(T0 + 10, "ais")
		expect(onlyAis.protocols.map(p => p.protocol)).toEqual(["ais"])
		expect(onlyAis.protocols[0]!.sectors[0]!.bearingDeg).toBe(180)
	})

	it("buckets bearings just west of north in 359 and north in 0", () => {
		const t = new CoverageTracker(STATION)
		t.observe("adsb", 52, STATION.lon - 0.001, T0, T0)
		t.observe("adsb", 52, STATION.lon, T0, T0)
		const s = t.query(T0).protocols[0]!.sectors
		expect(s.map(x => x.bearingDeg)).toEqual([0, 359])
	})

	it("handles a station next to the antimeridian", () => {
		const t = new CoverageTracker({ lat: 0, lon: 179.9 })
		expect(t.observe("ais", 0.001, -179.9, T0, T0)).toBe(true)
		const s = t.query(T0).protocols[1]!.sectors
		expect(s).toHaveLength(1)
		expect(s[0]!.bearingDeg).toBe(89)
		expect(s[0]!.maxRangeM).toBeLessThan(25_000)
	})

	it("stores a range of 0 at the station in bucket 0", () => {
		const t = new CoverageTracker(STATION)
		expect(t.observe("adsb", STATION.lat, STATION.lon, T0, T0)).toBe(true)
		const p = t.query(T0).protocols[0]!
		expect(p.sectors).toEqual([
			{
				bearingDeg: 0,
				maxRangeM: 0,
				lat: STATION.lat,
				lon: STATION.lon,
				at: new Date(T0).toISOString(),
			},
		])
		expect(p.maxRangeM).toBe(0)
	})

	it("evicts slots older than 24 hours", () => {
		const t = new CoverageTracker(STATION)
		t.observe("adsb", 52.5, -0.12, T0, T0)
		expect(t.query(T0 + 23 * HOUR).protocols[0]!.sectors).toHaveLength(1)
		const q = t.query(T0 + 24 * HOUR)
		expect(q.protocols[0]!.sectors).toHaveLength(0)
		expect(q.protocols[0]!.accepted).toBe(0)
		// Reusing the same slot 24 h later clears the old data.
		t.observe("adsb", 52.0, -0.12, T0 + 24 * HOUR, T0 + 24 * HOUR)
		const p = t.query(T0 + 24 * HOUR).protocols[0]!
		expect(p.accepted).toBe(1)
		expect(p.sectors[0]!.lat).toBe(52.0)
	})

	it("drops a position whose hour is older than the slot's stored hour", () => {
		const t = new CoverageTracker(STATION)
		t.observe("adsb", 52.0, -0.12, T0 + 24 * HOUR, T0 + 24 * HOUR)
		// Same slot, 24 h earlier; nowMs claims it is fresh, but the slot holds a newer hour.
		expect(t.observe("adsb", 52.5, -0.12, T0, T0)).toBe(false)
		const q = t.query(T0 + 24 * HOUR)
		expect(q.rejected.stale).toBe(1)
		expect(q.protocols[0]!.sectors[0]!.lat).toBe(52.0)
	})

	it("returns a copy of the rejection counters", () => {
		const t = new CoverageTracker(null)
		const q = t.query(T0)
		q.rejected["no-station"] = 99
		expect(t.query(T0).rejected["no-station"]).toBe(0)
	})

	// Feature: web-gaps-3, Property 10: Coverage maximum
	// Validates: Requirements 7.1, 7.2, 7.3
	it("each sector is the farthest accepted position in its bearing over the window", () => {
		const obs = fc.record({
			protocol: fc.constantFrom<CoverageProtocol>("adsb", "ais"),
			dLat: fc.double({ min: -6, max: 6, noNaN: true }),
			dLon: fc.double({ min: -9, max: 9, noNaN: true }),
			invalid: fc.constantFrom(0, 0, 0, 0, 0, 0, 1, 2, 3),
			advanceMs: fc.integer({ min: 0, max: 3 * HOUR }),
			ageMs: fc.integer({ min: -10_000, max: 90_000 }),
		})
		fc.assert(
			fc.property(
				fc.double({ min: -80, max: 80, noNaN: true }),
				fc.double({ min: -180, max: 180, noNaN: true }),
				fc.array(obs, { maxLength: 200 }),
				fc.integer({ min: 0, max: 30 * HOUR }),
				fc.constantFrom<CoverageProtocol | undefined>(undefined, "adsb", "ais"),
				(sLat, sLon, list, finalAdvance, filter) => {
					const t = new CoverageTracker({ lat: sLat, lon: sLon })
					const accepted: {
						protocol: CoverageProtocol
						lat: number
						lon: number
						at: number
						range: number
					}[] = []
					let now = T0
					for (const o of list) {
						now += o.advanceMs
						let lat = Math.max(-90, Math.min(90, sLat + o.dLat))
						let lon = sLon + o.dLon
						if (lon > 180) lon -= 360
						if (lon < -180) lon += 360
						if (o.invalid === 1) lat = 95
						else if (o.invalid === 2) lon = Number.NaN
						else if (o.invalid === 3) {
							lat = 0
							lon = 0
						}
						const at = now - o.ageMs
						const ok = t.observe(o.protocol, lat, lon, at, now)
						const range = haversineM(sLat, sLon, lat, lon)
						const expected =
							o.invalid === 0 &&
							!(lat === 0 && lon === 0) &&
							o.ageMs <= COVERAGE_MAX_POSITION_AGE_MS &&
							range <= COVERAGE_MAX_RANGE_M
						expect(ok).toBe(expected)
						if (ok) accepted.push({ protocol: o.protocol, lat, lon, at, range })
					}
					const qNow = now + finalAdvance
					const cur = Math.floor(qNow / HOUR)
					const q = t.query(qNow, filter)
					const protos =
						filter === undefined ? (["adsb", "ais"] as const) : [filter]
					expect(q.protocols.map(p => p.protocol)).toEqual(protos)
					for (const summary of q.protocols) {
						const inWindow = accepted.filter(a => {
							const h = Math.floor(a.at / HOUR)
							return a.protocol === summary.protocol && h > cur - 24 && h <= cur
						})
						const best = new Map<number, number>()
						for (const a of inWindow) {
							const b = Math.min(
								359,
								Math.floor(initialBearingDeg(sLat, sLon, a.lat, a.lon)),
							)
							best.set(b, Math.max(best.get(b) ?? -1, a.range))
						}
						expect(summary.accepted).toBe(inWindow.length)
						expect(summary.sectors.map(s => s.bearingDeg)).toEqual(
							[...best.keys()].sort((x, y) => x - y),
						)
						for (const s of summary.sectors) {
							expect(s.maxRangeM).toBe(best.get(s.bearingDeg))
							const source = inWindow.find(
								a =>
									a.lat === s.lat &&
									a.lon === s.lon &&
									new Date(a.at).toISOString() === s.at &&
									a.range === s.maxRangeM,
							)
							expect(source).toBeDefined()
						}
						const max = best.size === 0 ? null : Math.max(...best.values())
						expect(summary.maxRangeM).toBe(max)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})
