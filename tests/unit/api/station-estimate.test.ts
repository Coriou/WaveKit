import Fastify from "fastify"
import { describe, expect, it } from "vitest"
import type { StationEstimate } from "@wavekit/api-types"
import { stationEstimateRoutes } from "../../../src/api/routes/station-estimate.js"
import { WaveKitError } from "../../../src/utils/errors.js"

const base = {
	basis: { aircraft: 1, vessels: 2, aprs: 3, mesh: 4 },
	computedAt: "2026-01-01T00:00:00.000Z",
	cachedUntil: "2026-01-01T00:01:00.000Z",
	authoritative: false,
	stationConfigured: false,
} as const
const available: StationEstimate = {
	...base,
	available: true,
	reason: null,
	lat: 51.5,
	lon: -0.1,
	uncertaintyKm: 15,
}
const unavailable: StationEstimate = {
	...base,
	available: false,
	reason: "too-few-positions",
	lat: null,
	lon: null,
	uncertaintyKm: null,
}

async function build(estimate: () => Promise<StationEstimate>) {
	const app = Fastify()
	await app.register(stationEstimateRoutes, { estimate: { estimate } })
	return app
}

describe("GET /api/station/estimate", () => {
	it("returns the available shape with no-store", async () => {
		const app = await build(async () => available)
		const res = await app.inject({
			method: "GET",
			url: "/api/station/estimate",
		})
		expect(res.statusCode).toBe(200)
		expect(res.headers["cache-control"]).toBe("no-store")
		expect(res.json()).toEqual(available)
		await app.close()
	})

	it("returns the unavailable shape with nulls", async () => {
		const app = await build(async () => unavailable)
		const res = await app.inject({
			method: "GET",
			url: "/api/station/estimate",
		})
		expect(res.statusCode).toBe(200)
		expect(res.json()).toEqual(unavailable)
		expect(res.json().authoritative).toBe(false)
		await app.close()
	})

	it("serves HEAD", async () => {
		const app = await build(async () => available)
		const res = await app.inject({
			method: "HEAD",
			url: "/api/station/estimate",
		})
		expect(res.statusCode).toBe(200)
		expect(res.headers["cache-control"]).toBe("no-store")
		await app.close()
	})

	it("maps a failure to 500 STATION_ESTIMATE_FAILED", async () => {
		const app = await build(async () => {
			throw new WaveKitError("boom", "STATION_ESTIMATE_FAILED")
		})
		const res = await app.inject({
			method: "GET",
			url: "/api/station/estimate",
		})
		expect(res.statusCode).toBe(500)
		expect(res.json().code).toBe("STATION_ESTIMATE_FAILED")
		expect(res.headers["cache-control"]).toBe("no-store")
		await app.close()
	})
})
