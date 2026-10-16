import Fastify from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import { coverageRoutes } from "../../../src/api/routes/coverage.js"
import type { CoverageResponse } from "@wavekit/api-types"

const full: CoverageResponse = {
	available: true,
	station: { lat: 1, lon: 2 },
	windowHours: 24,
	bearingStepDeg: 1,
	protocols: [
		{
			protocol: "adsb",
			sectors: [
				{
					bearingDeg: 10,
					maxRangeM: 1234.5,
					lat: 1.1,
					lon: 2.1,
					at: "2026-10-16T12:00:00.000Z",
				},
			],
			maxRangeM: 1234.5,
			accepted: 3,
		},
		{ protocol: "ais", sectors: [], maxRangeM: null, accepted: 0 },
	],
	rejected: { "invalid-position": 1, "too-far": 2, stale: 3, "no-station": 0 },
	timestamp: "2026-10-16T12:00:00.000Z",
}

describe("coverage routes", () => {
	const open: Array<{ close(): Promise<void> }> = []
	afterEach(async () => {
		await Promise.all(open.splice(0).map(a => a.close()))
	})

	async function appWith(query: (p?: "adsb" | "ais") => CoverageResponse) {
		const app = Fastify()
		const fn = vi.fn(query)
		await app.register(coverageRoutes, { coverage: { query: fn } })
		open.push(app)
		return { app, fn }
	}

	it("returns the full shape", async () => {
		const { app, fn } = await appWith(() => full)
		const res = await app.inject({ method: "GET", url: "/api/coverage" })
		expect(res.statusCode).toBe(200)
		expect(res.json()).toEqual(full)
		expect(fn).toHaveBeenCalledWith(undefined)
	})

	it("passes the protocol filter", async () => {
		const { app, fn } = await appWith(() => full)
		const res = await app.inject({
			method: "GET",
			url: "/api/coverage?protocol=ais",
		})
		expect(res.statusCode).toBe(200)
		expect(fn).toHaveBeenCalledWith("ais")
	})

	it("rejects an unknown protocol with VALIDATION_ERROR", async () => {
		const { app, fn } = await appWith(() => full)
		const res = await app.inject({
			method: "GET",
			url: "/api/coverage?protocol=foo",
		})
		expect(res.statusCode).toBe(400)
		expect(res.json().code).toBe("VALIDATION_ERROR")
		expect(fn).not.toHaveBeenCalled()
	})

	it("serialises the unavailable shape", async () => {
		const empty: CoverageResponse = {
			available: false,
			reason: "no-station-location",
			station: null,
			windowHours: 24,
			bearingStepDeg: 1,
			protocols: [],
			rejected: {
				"invalid-position": 0,
				"too-far": 0,
				stale: 0,
				"no-station": 4,
			},
			timestamp: "2026-10-16T12:00:00.000Z",
		}
		const { app } = await appWith(() => empty)
		const res = await app.inject({ method: "GET", url: "/api/coverage" })
		expect(res.json()).toEqual(empty)
	})
})
