import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
	altitudeText,
	clockText,
	convertMeasure,
	dateText,
	DEFAULT_DISPLAY,
	DisplayStore,
	DISPLAY_STORAGE_KEY,
	distanceText,
	flightLevelText,
	hourText,
	parseDisplayPrefs,
	sameDay,
	speedText,
	temperatureText,
	type DisplayPrefs,
} from "../../src/features/display.ts"
import { ringDistances, scaleBar } from "../../src/features/map/geo.ts"
import { fieldText } from "../../src/features/activity/rows.ts"
import type { KeyValueStorage } from "../../src/shell/theme.ts"

class FakeStorage implements KeyValueStorage {
	data = new Map<string, string>()
	getItem(k: string) {
		return this.data.get(k) ?? null
	}
	setItem(k: string, v: string) {
		this.data.set(k, v)
	}
}

const metric: DisplayPrefs = { units: "metric", timeFormat: "local-24h" }
const nautical: DisplayPrefs = { units: "nautical", timeFormat: "local-24h" }
const imperial: DisplayPrefs = { units: "imperial", timeFormat: "local-12h" }
const utc: DisplayPrefs = { units: "nautical", timeFormat: "utc" }

describe("time", () => {
	const t = Date.UTC(2026, 9, 17, 14, 5, 9)
	it("prints the chosen clock", () => {
		expect(clockText(t, {}, utc)).toBe("14:05Z")
		expect(clockText(t, { seconds: true }, utc)).toBe("14:05:09Z")
		expect(clockText("not a date", {}, utc)).toBe("")
		const local = new Date(t)
		const h = local.getHours()
		expect(clockText(t, {}, nautical)).toBe(
			`${String(h).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`,
		)
		expect(clockText(t, {}, imperial)).toMatch(/^\d{1,2}:\d\d (am|pm)$/)
	})

	it("12 h reads midnight and noon as 12", () => {
		const midnight = new Date(2026, 9, 17, 0, 30).getTime()
		const noon = new Date(2026, 9, 17, 12, 30).getTime()
		expect(clockText(midnight, {}, imperial)).toBe("12:30 am")
		expect(clockText(noon, {}, imperial)).toBe("12:30 pm")
		expect(hourText(0, imperial)).toBe("12 am")
		expect(hourText(13, imperial)).toBe("1 pm")
		expect(hourText(9, utc)).toBe("09:00Z")
		expect(hourText(9, nautical)).toBe("09:00")
	})

	it("days follow the UTC calendar in UTC", () => {
		const late = Date.UTC(2026, 9, 17, 23, 30)
		const early = Date.UTC(2026, 9, 18, 0, 30)
		expect(sameDay(late, early, utc)).toBe(false)
		expect(dateText(late, undefined, utc)).toBe("17 Oct")
		expect(dateText(early, undefined, utc)).toBe("18 Oct")
	})
})

describe("units", () => {
	it("speeds, distances, altitudes and temperatures", () => {
		expect(speedText(452, {}, nautical)).toBe("452 kn")
		expect(speedText(10, {}, metric)).toBe("19 km/h")
		expect(speedText(10, {}, imperial)).toBe("12 mph")
		expect(speedText(5.25, { digits: 1 }, nautical)).toBe("5.3 kn")
		expect(distanceText(12.4, metric)).toBe("12 km")
		expect(distanceText(8.44, metric)).toBe("8.4 km")
		expect(distanceText(0.4, metric)).toBe("400 m")
		expect(distanceText(18.52, nautical)).toBe("10 nm")
		expect(distanceText(1.609344, imperial)).toBe("1.0 mi")
		expect(altitudeText(36_000, nautical)).toBe("36 000 ft")
		expect(altitudeText(36_000, metric)).toBe("10 970 m")
		expect(flightLevelText(36_000, nautical)).toBe("FL360")
		expect(flightLevelText(3_420, imperial)).toBe("3 400 ft")
		expect(flightLevelText(36_000, metric)).toBe("FL360")
		expect(flightLevelText(3_420, metric)).toBe("1 050 m")
		expect(temperatureText(18.4, metric)).toBe("18.4 °C")
		expect(temperatureText(20, imperial)).toBe("68.0 °F")
	})

	it("decoded measurements follow the setting", () => {
		expect(convertMeasure(452, "kn", nautical)).toBeNull()
		expect(convertMeasure(452, "kn", metric)).toEqual({
			value: 837.1,
			unit: "km/h",
		})
		expect(convertMeasure(100, "km/h", nautical)).toEqual({
			value: 54,
			unit: "kn",
		})
		expect(convertMeasure(68, "°F", metric)).toEqual({ value: 20, unit: "°C" })
		expect(convertMeasure(36_000, "ft", metric)).toEqual({
			value: 10_973,
			unit: "m",
		})
		expect(convertMeasure(12, "m", imperial)).toBeNull()
		expect(convertMeasure(3, "%", metric)).toBeNull()
	})

	it("fieldText prints a decoded speed in the current units", () => {
		// default store: nautical
		expect(
			fieldText({ key: "speed", label: "Speed", value: 100, unit: "km/h" }),
		).toBe("54 kn")
	})

	it("a round trip through another unit comes back within rounding", () => {
		fc.assert(
			fc.property(
				fc.double({ min: 0, max: 2000, noNaN: true }),
				fc.constantFrom<DisplayPrefs>(metric, imperial),
				(kn, p) => {
					const there = convertMeasure(kn, "kn", p)
					if (!there) return false
					const back = convertMeasure(there.value, there.unit, nautical)
					const v = back ? back.value : there.value
					return Math.abs(v - kn) <= 0.2
				},
			),
			{ numRuns: 200 },
		)
	})

	it("the map scale bar and rings use round numbers of the unit", () => {
		const nm = scaleBar(0.5, 110, nautical)
		expect(nm.text).toMatch(/^\d+(\.\d)? nm$/)
		expect(nm.px).toBeLessThanOrEqual(110)
		expect(scaleBar(0.001, 110, metric).text).toBe("100 m")
		expect(ringDistances(nautical)[0]).toEqual({ km: 3 * 1.852, text: "3 nm" })
		expect(ringDistances(metric).map(r => r.text)).toContain("25 km")
	})
})

describe("DisplayStore", () => {
	it("core decides while it has preferences; the device's choice otherwise", () => {
		const st = new FakeStorage()
		const store = new DisplayStore(st)
		expect(store.getState()).toEqual(DEFAULT_DISPLAY)
		let n = 0
		store.subscribe(() => n++)
		store.setLocal({ timeFormat: "utc" })
		expect(store.getState().timeFormat).toBe("utc")
		expect(JSON.parse(st.getItem(DISPLAY_STORAGE_KEY) ?? "{}")).toEqual({
			units: "nautical",
			timeFormat: "utc",
		})
		store.setCore({ units: "metric", timeFormat: "local-12h" })
		expect(store.synced).toBe(true)
		expect(store.getState()).toEqual({
			units: "metric",
			timeFormat: "local-12h",
		})
		store.setCore(null)
		expect(store.getState().timeFormat).toBe("utc")
		expect(n).toBe(3)
		expect(new DisplayStore(st).getState().timeFormat).toBe("utc")
	})

	it("parses stored prefs field by field", () => {
		expect(parseDisplayPrefs("{oops")).toEqual(DEFAULT_DISPLAY)
		expect(
			parseDisplayPrefs(JSON.stringify({ units: "metric", timeFormat: 3 })),
		).toEqual({ units: "metric", timeFormat: "local-24h" })
	})
})
