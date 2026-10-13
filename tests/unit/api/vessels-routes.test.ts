/**
 * GET /api/vessels, /api/vessels/stats and /api/vessels/:mmsi.
 */

import Fastify from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import { vesselRoutes } from "../../../src/api/routes/vessels.js"
import { VesselTracker } from "../../../src/core/vessel-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "error" })

async function appWith(tracker = new VesselTracker({}, logger)) {
	const app = Fastify()
	await app.register(vesselRoutes, { tracker })
	return { app, tracker }
}

describe("vessel routes", () => {
	const open: Array<{ close(): Promise<void> }> = []

	afterEach(async () => {
		await Promise.all(open.splice(0).map(app => app.close()))
	})

	it("returns 200, 400 and 404 and keeps null fields", async () => {
		const { app, tracker } = await appWith()
		open.push(app)
		tracker.processShip(
			"ais",
			{
				mmsi: "123456789",
				messageType: 1,
				lat: 10,
				lon: 20,
				name: "EVER GIVEN",
			},
			new Date("2026-06-15T12:00:00.000Z"),
		)
		tracker.processShip(
			"ais",
			{ mmsi: "7", messageType: 18 },
			new Date("2026-06-15T12:05:00.000Z"),
		)

		const list = await app.inject({ method: "GET", url: "/api/vessels" })
		expect(list.statusCode).toBe(200)
		const listed = list.json()
		expect(
			listed.vessels.map((vessel: { mmsi: string }) => vessel.mmsi),
		).toEqual(["000000007", "123456789"])
		expect(listed.stats.vesselCount).toBe(2)
		expect(typeof listed.timestamp).toBe("string")
		expect(listed.vessels[0].name).toBeNull()
		expect(listed.vessels[0].position).toBeNull()
		expect(listed.vessels[0].eta).toBeNull()
		expect(listed.vessels[0].lastStaticAt).toBeNull()

		const stats = await app.inject({ method: "GET", url: "/api/vessels/stats" })
		expect(stats.statusCode).toBe(200)
		expect(stats.json()).toMatchObject({
			vesselCount: 2,
			withPosition: 1,
			withName: 1,
			latestMmsi: "000000007",
			expiredTotal: 0,
			byClass: { A: 1, B: 1, "base-station": 0, aton: 0, sar: 0, unknown: 0 },
		})

		const one = await app.inject({
			method: "GET",
			url: "/api/vessels/123456789",
		})
		expect(one.statusCode).toBe(200)
		expect(one.json()).toMatchObject({
			mmsi: "123456789",
			name: "EVER GIVEN",
			position: { lat: 10, lon: 20, at: "2026-06-15T12:00:00.000Z" },
			callsign: null,
			imo: null,
		})

		const padded = await app.inject({ method: "GET", url: "/api/vessels/7" })
		expect(padded.statusCode).toBe(200)
		expect(padded.json().mmsi).toBe("000000007")

		const missing = await app.inject({
			method: "GET",
			url: "/api/vessels/999",
		})
		expect(missing.statusCode).toBe(404)
		expect(missing.json()).toEqual({
			error: "Vessel not found",
			code: "VESSEL_NOT_FOUND",
			mmsi: "000000999",
		})

		for (const bad of ["abc", "1234567890", "12a", "1.5"]) {
			const response = await app.inject({
				method: "GET",
				url: `/api/vessels/${bad}`,
			})
			expect(response.statusCode).toBe(400)
			expect(response.json()).toEqual({
				error: "MMSI must be 1-9 digits",
				code: "VALIDATION_ERROR",
			})
		}
	})
})
