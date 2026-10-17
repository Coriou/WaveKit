import { describe, expect, it } from "vitest"

import {
	locate,
	locationValue,
	type GeoLike,
} from "../../src/features/settings/geolocate.ts"
import { parseLocation } from "../../src/features/settings/rows.ts"

const geo = (answer: { lat: number; lon: number } | { code: number }) => {
	const seen: (PositionOptions | undefined)[] = []
	const g: GeoLike = {
		getCurrentPosition(ok, fail, options) {
			seen.push(options)
			if ("code" in answer) fail(answer)
			else ok({ coords: { latitude: answer.lat, longitude: answer.lon } })
		},
	}
	return { g, seen }
}

// Feature: web app Settings › Station › Location, "Use my location"
describe("Use my location", () => {
	it("rounds the browser's position to a value Location parses back", async () => {
		const { g, seen } = geo({ lat: 48.7271234, lon: -3.9854321 })
		const got = await locate(g, true)
		expect(got).toEqual({ value: "48.7271, -3.9854" })
		if ("value" in got) expect(parseLocation(got.value)).toEqual(got)
		expect(seen[0]).toMatchObject({ enableHighAccuracy: false })
		expect(locationValue(10, 20.00004)).toBe("10, 20")
	})

	it("explains insecure pages, refusals and timeouts without asking", async () => {
		const { g, seen } = geo({ lat: 1, lon: 2 })
		expect(await locate(g, false)).toEqual({
			error: expect.stringContaining("HTTPS") as string,
		})
		expect(seen).toHaveLength(0)
		expect(await locate(geo({ code: 1 }).g, true)).toEqual({
			error: expect.stringContaining("blocked") as string,
		})
		expect(await locate(geo({ code: 3 }).g, true)).toEqual({
			error: expect.stringContaining("too long") as string,
		})
		expect(await locate(undefined, true)).toEqual({
			error: expect.stringContaining("cannot") as string,
		})
	})
})
