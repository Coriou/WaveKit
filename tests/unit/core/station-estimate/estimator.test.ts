import type {
	AircraftState,
	AprsStation,
	MeshNode,
	VesselState,
} from "@wavekit/api-types"
import { describe, expect, it } from "vitest"
import {
	collectContributors,
	computeEstimate,
	isAprsDirect,
	roundEstimateLon,
	sphericalGeometricMedian,
	type WeightedPosition,
} from "../../../../src/core/station-estimate/estimator.js"

const NOW = Date.parse("2026-10-16T12:00:00Z")
const iso = (ms: number): string => new Date(ms).toISOString()

function aircraft(
	lat: number,
	lon: number,
	lastUpdated = NOW,
	seenPos?: number,
): AircraftState {
	const a = {
		icao: "abcdef",
		position: { lat, lon },
		lastUpdated,
		...(seenPos !== undefined ? { seenPos } : {}),
	}
	return a as unknown as AircraftState
}
function vessel(lat: number, lon: number, at = NOW): VesselState {
	return {
		mmsi: "123456789",
		position: { lat, lon, at: iso(at) },
	} as unknown as VesselState
}
function aprs(
	lat: number,
	lon: number,
	opts: { kind?: string; path?: string[]; at?: number } = {},
): AprsStation {
	return {
		key: "callsign:N0CALL",
		kind: opts.kind ?? "station",
		position: { lat, lon, at: iso(opts.at ?? NOW) },
		path: opts.path ?? [],
	} as unknown as AprsStation
}
function mesh(
	lat: number,
	lon: number,
	opts: { hopsAway?: number | null; viaMqtt?: boolean; at?: number } = {},
): MeshNode {
	return {
		nodeId: "!00000001",
		position: { lat, lon, altitudeM: null, at: iso(opts.at ?? NOW) },
		hopsAway: opts.hopsAway === undefined ? 0 : opts.hopsAway,
		viaMqtt: opts.viaMqtt ?? false,
	} as unknown as MeshNode
}
const pts = (list: [number, number][], weight = 1): WeightedPosition[] =>
	list.map(([lat, lon]) => ({ lat, lon, weight }))

describe("isAprsDirect", () => {
	it("is direct with an empty path or unused aliases, relayed with a * element", () => {
		expect(isAprsDirect([])).toBe(true)
		expect(isAprsDirect(["WIDE1-1", "WIDE2-2"])).toBe(true)
		expect(isAprsDirect(["W1AW*", "WIDE2-2"])).toBe(false)
		expect(isAprsDirect(["VE3RPT", "WIDE2*"])).toBe(false)
	})
})

describe("collectContributors", () => {
	it("weights each fleet per the contract", () => {
		const r = collectContributors(
			{
				aircraft: [aircraft(1, 1)],
				vessels: [vessel(1, 1)],
				aprs: [aprs(1, 1), aprs(1, 1, { path: ["W1AW*"] })],
				mesh: [
					mesh(1, 1),
					mesh(1, 1, { hopsAway: 2 }),
					mesh(1, 1, { hopsAway: null }),
				],
			},
			NOW,
		)
		expect(r.points.map(p => [p.fleet, p.weight])).toEqual([
			["aircraft", 1],
			["vessels", 1],
			["aprs", 2],
			["aprs", 1],
			["mesh", 4],
			["mesh", 1],
			["mesh", 1],
		])
		expect(r.basis).toEqual({ aircraft: 1, vessels: 1, aprs: 2, mesh: 3 })
		expect(r.direct).toBe(2)
	})

	it("skips APRS objects and items and MQTT mesh nodes", () => {
		const r = collectContributors(
			{
				aprs: [aprs(1, 1, { kind: "object" }), aprs(1, 1, { kind: "item" })],
				mesh: [mesh(1, 1, { viaMqtt: true })],
			},
			NOW,
		)
		expect(r.points).toEqual([])
		expect(r.basis).toEqual({ aircraft: 0, vessels: 0, aprs: 0, mesh: 0 })
	})

	it("ignores non-finite and out-of-range positions and missing times", () => {
		const bad: [number, number][] = [
			[Number.NaN, 0],
			[0, Number.NaN],
			[Number.POSITIVE_INFINITY, 0],
			[0, Number.NEGATIVE_INFINITY],
			[90.0001, 0],
			[-91, 0],
			[0, 180.5],
			[0, -181],
		]
		const r = collectContributors(
			{
				vessels: bad.map(([a, b]) => vessel(a, b)),
				aircraft: [
					aircraft(1, 1, Number.NaN),
					{
						...aircraft(1, 1),
						position: undefined,
					} as unknown as AircraftState,
				],
				aprs: [
					{
						...aprs(1, 1),
						position: { lat: 1, lon: 1, at: "garbage" },
					} as unknown as AprsStation,
					{ ...aprs(1, 1), position: null } as unknown as AprsStation,
				],
			},
			NOW,
		)
		expect(r.points).toEqual([])
		const edge = collectContributors(
			{ vessels: [vessel(90, 180), vessel(-90, -180)] },
			NOW,
		)
		expect(edge.points).toHaveLength(2)
	})

	it("ignores positions older than 4 h by their own time (aircraft: lastUpdated - seenPos)", () => {
		const fourH = 4 * 3600_000
		const r = collectContributors(
			{
				aircraft: [
					aircraft(1, 1, NOW, fourH / 1000 + 1),
					aircraft(1, 1, NOW, fourH / 1000),
					aircraft(1, 1, NOW - fourH - 1),
				],
				vessels: [vessel(1, 1, NOW - fourH - 1), vessel(1, 1, NOW - fourH)],
				aprs: [aprs(1, 1, { at: NOW - fourH - 1 })],
				mesh: [mesh(1, 1, { at: NOW - fourH - 1 })],
			},
			NOW,
		)
		expect(r.points.map(p => p.fleet)).toEqual(["aircraft", "vessels"])
		expect(r.points[0]!.at).toBe(NOW - fourH)
	})

	it("keeps all 8000 contributors at the bound and drops the oldest at 8001", () => {
		const make = (n: number): VesselState[] =>
			Array.from({ length: n }, (_, i) => vessel(10, 10, NOW - i * 1000))
		const at8000 = collectContributors({ vessels: make(8000) }, NOW)
		expect(at8000.points).toHaveLength(8000)
		expect(at8000.basis.vessels).toBe(8000)
		const list = make(8001).reverse()
		const at8001 = collectContributors(
			{ vessels: list, aprs: [aprs(1, 1, { at: NOW - 9_000_000 })] },
			NOW,
		)
		expect(at8001.points).toHaveLength(8000)
		const times = at8001.points.map(p => p.at)
		expect(Math.min(...times)).toBe(NOW - 7999 * 1000)
		expect(at8001.basis).toEqual({
			aircraft: 0,
			vessels: 8000,
			aprs: 0,
			mesh: 0,
		})
		expect(at8001.direct).toBe(0)
	})
})

describe("computeEstimate thresholds", () => {
	it("needs 10 entities", () => {
		const nine = pts(Array.from({ length: 9 }, () => [48, 2]))
		expect(computeEstimate(nine)).toEqual({
			available: false,
			reason: "too-few-positions",
		})
		const ten = pts(Array.from({ length: 10 }, () => [48, 2]))
		expect(computeEstimate(ten).available).toBe(true)
	})

	it("or 3 direct entities (weight 4 or 2)", () => {
		const two = [
			...pts([[48, 2]], 4),
			...pts([[48.1, 2]], 2),
			...pts([[48, 2.1]], 1),
		]
		expect(computeEstimate(two).available).toBe(false)
		const three = [
			...pts([[48, 2]], 4),
			...pts(
				[
					[48.1, 2],
					[48, 2.1],
				],
				2,
			),
		]
		const r = computeEstimate(three)
		expect(r.available).toBe(true)
		expect(computeEstimate([])).toEqual({
			available: false,
			reason: "too-few-positions",
		})
	})
})

describe("computeEstimate geometry", () => {
	it("an antipodal pair is degenerate", () => {
		const set = [
			...pts(Array.from({ length: 5 }, () => [10, 20])),
			...pts(Array.from({ length: 5 }, () => [-10, -160])),
		]
		expect(computeEstimate(set)).toEqual({
			available: false,
			reason: "degenerate",
		})
		expect(
			sphericalGeometricMedian(
				pts([
					[0, 0],
					[0, 180],
				]),
			),
		).toBeNull()
	})

	it("an antimeridian cluster lands on the antimeridian, lon in [-180, 180)", () => {
		const set = pts([
			[10, 179.5],
			[10, -179.5],
			[10.5, 179.8],
			[10.5, -179.8],
			[9.5, 179.9],
			[9.5, -179.9],
			[10, 179],
			[10, -179],
			[10.2, 180],
			[9.8, -180],
		])
		const r = computeEstimate(set)
		if (!r.available) throw new Error("expected available")
		expect(r.lon).toBe(-180)
		expect(r.lat).toBe(10)
		expect(Math.abs(Math.abs(r.rawLon) - 180)).toBeLessThan(0.01)
		expect(r.uncertaintyKm).toBeGreaterThanOrEqual(10)
	})

	it("a pole cluster resolves near the pole", () => {
		const set = pts(Array.from({ length: 12 }, (_, i) => [89.5, i * 30 - 180]))
		const r = computeEstimate(set)
		if (!r.available) throw new Error("expected available")
		expect(r.rawLat).toBeGreaterThan(89.999)
		expect(r.lat).toBe(90)
		expect(r.lon).toBeGreaterThanOrEqual(-180)
		expect(r.lon).toBeLessThan(180)
		// 0.5 deg of latitude is about 55.6 km.
		expect(r.uncertaintyKm).toBe(60)
	})

	it("returns a contributor that coincides with the iterate", () => {
		// Symmetric around (0, 0): the start vector is exactly (1, 0, 0), a contributor.
		const set = pts([
			[0, 0],
			[0, 1],
			[0, -1],
			[1, 0],
			[-1, 0],
		])
		const m = sphericalGeometricMedian(set)
		expect(m).not.toBeNull()
		expect(Math.abs(m!.lat)).toBe(0)
		expect(Math.abs(m!.lon)).toBe(0)
	})

	it("rounds to 0.05 deg without -0 and wraps longitude", () => {
		const set = pts(Array.from({ length: 10 }, () => [-0.01, -0.01]))
		const r = computeEstimate(set)
		if (!r.available) throw new Error("expected available")
		expect(Object.is(r.lat, 0)).toBe(true)
		expect(Object.is(r.lon, 0)).toBe(true)
		expect(r.uncertaintyKm).toBe(10)
		expect(roundEstimateLon(179.99)).toBe(-180)
		expect(roundEstimateLon(-180)).toBe(-180)
		expect(roundEstimateLon(12.3456)).toBe(12.35)
	})

	it("uncertainty is the weighted median distance rounded up to 5 km", () => {
		// 6 points at the centre (weight 1) and 6 at about 111 km: weighted median is 0 km.
		const centre = pts(Array.from({ length: 6 }, () => [0, 0]))
		const far = pts(Array.from({ length: 6 }, (_, i) => [i % 2 ? 1 : -1, 0]))
		const r = computeEstimate([...centre, ...far])
		if (!r.available) throw new Error("expected available")
		expect(r.uncertaintyKm).toBe(10)
		// Weight the far ring heavier: the median moves to about 111.2 km -> 115.
		const ring = pts(
			[
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			],
			4,
		)
		const r2 = computeEstimate(ring)
		if (!r2.available) throw new Error("expected available")
		expect(r2.lat).toBe(0)
		expect(r2.lon).toBe(0)
		expect(r2.uncertaintyKm).toBe(115)
		// Unequal weights: 6 centre points (weight 1) vs the ring (weight 4) -> 115 km, not 10.
		const r3 = computeEstimate([...centre, ...ring])
		if (!r3.available) throw new Error("expected available")
		expect(r3.uncertaintyKm).toBe(115)
	})
})

describe("computeEstimate benchmark", () => {
	it("times 8000 clustered contributors (reported, not asserted)", () => {
		let seed = 42
		const rnd = (): number => {
			seed = (seed * 1103515245 + 12345) % 2147483648
			return seed / 2147483648
		}
		const set: WeightedPosition[] = Array.from({ length: 8000 }, () => ({
			lat: 48 + (rnd() - 0.5) * 6,
			lon: 2 + (rnd() - 0.5) * 8,
			weight: [1, 1, 1, 2, 4][Math.floor(rnd() * 5)]!,
		}))
		computeEstimate(set)
		const runs = 5
		const t0 = performance.now()
		for (let i = 0; i < runs; i++) computeEstimate(set)
		const ms = (performance.now() - t0) / runs
		process.stdout.write(
			`station-estimate benchmark: ${ms.toFixed(2)} ms per 8000-point estimate\n`,
		)
		expect(ms).toBeGreaterThan(0)
	})
})
