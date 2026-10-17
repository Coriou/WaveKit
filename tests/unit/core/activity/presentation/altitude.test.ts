import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { presentAircraft } from "../../../../../src/core/activity/presentation/aircraft.js"
import { presentAprs } from "../../../../../src/core/activity/presentation/aprs.js"
import {
	MAX_ALT_M,
	MIN_ALT_M,
	altitudeFromFeet,
	altitudeMetres,
	readPosition,
} from "../../../../../src/core/activity/presentation/budget.js"
import { presentShip } from "../../../../../src/core/activity/presentation/ship.js"

const HOSTILE: readonly unknown[] = [
	"ground",
	"35000",
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	1e9,
	-1e9,
	null,
	true,
	{},
]

describe("altitude helper (req 4.5)", () => {
	it("rounds metres and keeps the -500..50 000 bounds inclusive", () => {
		expect(altitudeMetres(-500)).toBe(-500)
		expect(altitudeMetres(50_000)).toBe(50_000)
		expect(altitudeMetres(50_000.4)).toBe(50_000)
		expect(altitudeMetres(-500.5)).toBe(-500)
		expect(altitudeMetres(12.5)).toBe(13)
	})

	it("omits one metre past each bound", () => {
		expect(altitudeMetres(-501)).toBeUndefined()
		expect(altitudeMetres(50_001)).toBeUndefined()
		expect(altitudeMetres(50_000.5)).toBeUndefined()
		expect(altitudeMetres(-500.6)).toBeUndefined()
	})

	it("normalises -0 to 0", () => {
		expect(Object.is(altitudeMetres(-0.4), 0)).toBe(true)
		expect(Object.is(altitudeFromFeet(-1), 0)).toBe(true)
	})

	it("converts feet with 0.3048 and rounds", () => {
		expect(altitudeFromFeet(35_000)).toBe(10_668)
		expect(altitudeFromFeet(1)).toBe(0)
		expect(altitudeFromFeet(164_041)).toBe(50_000)
		expect(altitudeFromFeet(164_044)).toBeUndefined()
		expect(altitudeFromFeet(-1_640)).toBe(-500)
		expect(altitudeFromFeet(-1_645)).toBeUndefined()
	})

	it("omits non-numbers and non-finite values", () => {
		for (const value of HOSTILE) {
			expect(altitudeMetres(value)).toBeUndefined()
			expect(altitudeFromFeet(value)).toBeUndefined()
		}
	})

	it("readPosition keeps lat/lon when altM is invalid", () => {
		expect(readPosition({ lat: 51, lon: 4 }, 1e9)).toEqual({ lat: 51, lon: 4 })
		expect(readPosition({ lat: 51, lon: 4 }, 120)).toEqual({
			lat: 51,
			lon: 4,
			altM: 120,
		})
		expect(readPosition({ lat: 0, lon: 0 }, 120)).toBeUndefined()
	})
})

describe("aircraft altM (req 4.1)", () => {
	it("uses the first numeric of altitude and alt_baro", () => {
		expect(
			presentAircraft({ icao: "abc123", lat: 51, lon: 4, altitude: 35_000 })
				?.position,
		).toEqual({ lat: 51, lon: 4, altM: 10_668 })
		expect(
			presentAircraft({
				icao: "abc123",
				lat: 51,
				lon: 4,
				altitude: "ground",
				alt_baro: 1_000,
			})?.position,
		).toEqual({ lat: 51, lon: 4, altM: 305 })
		expect(
			presentAircraft({ hex: "abc123", lat: 51, lon: 4, alt_baro: 100 })
				?.position,
		).toEqual({ lat: 51, lon: 4, altM: 30 })
	})

	it("omits altM for ground, strings and hostile numbers, keeps the rest", () => {
		for (const altitude of HOSTILE) {
			const data = {
				icao: "abc123",
				callsign: "BAW1",
				lat: 51,
				lon: 4,
				altitude,
			}
			let view: ReturnType<typeof presentAircraft>
			expect(() => (view = presentAircraft(data))).not.toThrow()
			if (view === undefined) throw new Error("no presentation")
			expect(view.position).toEqual({ lat: 51, lon: 4 })
			expect(view.entityKey).toBe("icao:ABC123")
			expect(view.title).toBe("BAW1")
		}
	})

	it("an altitude without a position adds nothing", () => {
		expect(
			presentAircraft({ icao: "abc123", altitude: 35_000 })?.position,
		).toBeUndefined()
	})
})

describe("APRS altM (req 4.2)", () => {
	it("reads altitude in feet on position packets only", () => {
		expect(
			presentAprs({
				source: "N0CALL",
				dataType: "Position",
				lat: 51,
				lon: 4,
				altitude: 1_000,
			})?.position,
		).toEqual({ lat: 51, lon: 4, altM: 305 })
		expect(
			presentAprs({
				source: "N0CALL",
				dataType: "Status",
				lat: 51,
				lon: 4,
				altitude: 1_000,
			})?.position,
		).toBeUndefined()
	})

	it("keeps a balloon at 40 km and drops one past 50 km", () => {
		expect(
			presentAprs({
				source: "N0CALL-11",
				dataType: "Position",
				lat: 51,
				lon: 4,
				altitude: 131_234,
			})?.position?.altM,
		).toBe(40_000)
		const view = presentAprs({
			source: "N0CALL-11",
			dataType: "Position",
			lat: 51,
			lon: 4,
			altitude: 164_100,
		})
		expect(view?.position).toEqual({ lat: 51, lon: 4 })
	})

	it("hostile altitude never throws and keeps the position", () => {
		for (const altitude of HOSTILE) {
			const view = presentAprs({
				source: "N0CALL",
				dataType: "Position",
				lat: 51,
				lon: 4,
				altitude,
			})
			expect(view?.position).toEqual({ lat: 51, lon: 4 })
			expect(view?.entityKey).toBe("callsign:N0CALL")
		}
	})
})

describe("AIS altM (req 4.3)", () => {
	it("reads altitudeM of a type 9 SAR report", () => {
		expect(
			presentShip({
				mmsi: 111232511,
				messageType: 9,
				lat: 51,
				lon: 4,
				altitudeM: 1_524.4,
			})?.position,
		).toEqual({ lat: 51, lon: 4, altM: 1_524 })
	})

	it("hostile altitudeM never throws and keeps the position", () => {
		for (const altitudeM of HOSTILE) {
			const view = presentShip({ mmsi: 111232511, lat: 51, lon: 4, altitudeM })
			expect(view?.position).toEqual({ lat: 51, lon: 4 })
			expect(view?.entityKey).toBe("mmsi:111232511")
		}
	})
})

const anyAltitude = fc.oneof(
	fc.double(),
	fc.integer({ min: -2_000_000, max: 2_000_000 }),
	fc.double({ min: -2_000, max: 200_000, noNaN: true }),
	fc.constantFrom("ground", "1000", "", "NaN"),
	fc.constant(undefined),
)

function expected(value: unknown, scale: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined
	const rounded = Math.round(value * scale)
	if (rounded < MIN_ALT_M || rounded > MAX_ALT_M) return undefined
	return rounded + 0
}

describe("altitude property", () => {
	// Feature: web-gaps-5, Property 4: Altitude
	// Validates: Requirements 4.1, 4.2, 4.3, 4.5
	it("altM is absent or the rounded in-range conversion", () => {
		const lat = fc.double({ min: -89, max: 89, noNaN: true })
		const lon = fc.double({ min: 1, max: 179, noNaN: true })
		fc.assert(
			fc.property(lat, lon, anyAltitude, anyAltitude, (la, lo, a, b) => {
				const aircraft = presentAircraft({
					icao: "abc123",
					lat: la,
					lon: lo,
					altitude: a,
					alt_baro: b,
				})
				const firstFt =
					typeof a === "number" && Number.isFinite(a)
						? a
						: typeof b === "number" && Number.isFinite(b)
							? b
							: undefined
				const aprs = presentAprs({
					source: "N0CALL",
					dataType: "Position",
					lat: la,
					lon: lo,
					altitude: a,
				})
				const ship = presentShip({
					mmsi: 111232511,
					lat: la,
					lon: lo,
					altitudeM: a,
				})
				const cases: Array<[number | undefined, number | undefined]> = [
					[aprs?.position?.altM, expected(a, 0.3048)],
					[ship?.position?.altM, expected(a, 1)],
				]
				cases.push([aircraft?.position?.altM, expected(firstFt, 0.3048)])
				for (const [actual, want] of cases) {
					expect(actual).toBe(want)
					if (actual !== undefined) {
						expect(Number.isInteger(actual)).toBe(true)
						expect(actual).toBeGreaterThanOrEqual(MIN_ALT_M)
						expect(actual).toBeLessThanOrEqual(MAX_ALT_M)
					}
				}
				expect(aircraft?.position?.lat).toBe(la)
				expect(aprs?.position?.lat).toBe(la)
				expect(ship?.position?.lon).toBe(lo)
			}),
			{ numRuns: 300 },
		)
	})
})
