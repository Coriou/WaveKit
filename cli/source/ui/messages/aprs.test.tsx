import { describe, expect, it } from "vitest"
import { formatMessage } from "./index.js"

describe("APRS message formatting", () => {
	// WG2 R1 #15: APRS course/speed and Mic-E speeds are knots (APRS 1.0.1).
	it("labels APRS speed in knots and weather wind in mph", () => {
		const formatted = formatMessage(
			{
				type: "aprs",
				timestamp: "2026-10-13T12:00:00.000Z",
				data: {
					source: "N0CALL-9",
					destination: "APRS",
					path: [],
					dataType: "Mic-E",
					lat: 49.05,
					lon: -72.02,
					speed: 36,
					weather: { windSpeed: 12 },
				},
			} as never,
			"direwolf",
		)
		const text = formatted.segments.map(s => s.text)
		expect(text).toContain("36 kn")
		expect(text.some(t => t.includes("mph") && !t.startsWith("wind"))).toBe(
			false,
		)
	})
})
