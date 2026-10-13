/**
 * GET /api/aprs/stations, /api/aprs/stats and /api/aprs/stations/:key.
 */

import Fastify from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import { aprsRoutes } from "../../../src/api/routes/aprs.js"
import { AprsTracker } from "../../../src/core/aprs-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "error" })

const KEY =
	/^(callsign:[A-Z0-9]{1,6}(-[0-9]{1,2})?|aprs-(object|item):[^:\u0000-\u001f]{1,9})$/

async function appWith(aprs = new AprsTracker({}, logger)) {
	const app = Fastify()
	await app.register(aprsRoutes, { tracker: aprs })
	return { app, aprs }
}

function packet(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		timestamp: new Date("2026-06-15T12:00:00.000Z"),
		source: "N0CALL-9",
		destination: "APRS",
		path: ["WIDE1-1", "WIDE2-1"],
		dataType: "Position",
		lat: 40.5,
		lon: -74.25,
		altitude: 1234,
		course: 90,
		speed: 36,
		symbol: "/>",
		comment: "testing",
		raw: "!full",
		...overrides,
	}
}

describe("aprs routes", () => {
	const open: Array<{ close(): Promise<void> }> = []

	afterEach(async () => {
		await Promise.all(open.splice(0).map(app => app.close()))
	})

	it("round-trips a full station and keeps null fields", async () => {
		const { app, aprs } = await appWith()
		open.push(app)
		const t0 = new Date("2026-06-15T12:00:00.000Z")
		const t1 = new Date("2026-06-15T12:01:00.000Z")
		const t2 = new Date("2026-06-15T12:02:00.000Z")
		const t3 = new Date("2026-06-15T12:03:00.000Z")
		aprs.processAprs("direwolf", packet(), t0)
		aprs.processAprs(
			"direwolf",
			packet({
				dataType: "Status",
				comment: "En route",
				lat: undefined,
				lon: undefined,
				raw: ">En route",
			}),
			t1,
		)
		aprs.processAprs(
			"direwolf",
			packet({
				dataType: "Positionless weather",
				comment: undefined,
				lat: undefined,
				lon: undefined,
				altitude: undefined,
				course: undefined,
				speed: undefined,
				raw: "_wx",
				weather: {
					temperature: 72,
					humidity: 50,
					pressure: 1013.2,
					windSpeed: 5,
					windDirection: 180,
					rainfall: 0.01,
				},
			}),
			t2,
		)
		aprs.processAprs(
			"direwolf",
			packet({
				source: "W1AW",
				dataType: "Message",
				comment: "hello",
				lat: undefined,
				lon: undefined,
				altitude: undefined,
				course: undefined,
				speed: undefined,
				symbol: undefined,
				raw: ":msg",
			}),
			t3,
		)
		aprs.processAprs(
			"direwolf",
			packet({
				source: "K1ABC",
				dataType: "Object",
				objectName: "MEETING",
				objectKind: "object",
				objectKilled: false,
				raw: ";obj",
			}),
			new Date("2026-06-15T12:00:30.000Z"),
		)

		for (const station of aprs.getAll()) {
			expect(station.key).toMatch(KEY)
		}

		const list = await app.inject({ method: "GET", url: "/api/aprs/stations" })
		expect(list.statusCode).toBe(200)
		const listed = list.json()
		expect(listed.stations).toEqual(aprs.getAll())
		expect(listed.stats.stationCount).toBe(3)
		expect(listed.stats.byKind).toEqual({ station: 2, object: 1, item: 0 })
		expect(typeof listed.timestamp).toBe("string")
		expect(listed.stations[0].key).toBe("callsign:W1AW")
		expect(listed.stations[0].name).toBeNull()
		expect(listed.stations[0].position).toBeNull()
		expect(listed.stations[0].comment).toBeNull()
		expect(listed.stations[0].status).toBeNull()
		expect(listed.stations[0].weather).toBeNull()
		expect(listed.stations[0].symbol).toBeNull()
		expect(listed.stations[0].altitudeFt).toBeNull()

		const stats = await app.inject({ method: "GET", url: "/api/aprs/stats" })
		expect(stats.statusCode).toBe(200)
		expect(stats.json()).toMatchObject({
			stationCount: 3,
			withPosition: 2,
			duplicatesDropped: 0,
			invalidPackets: 0,
			expiredTotal: 0,
			latestKey: "callsign:W1AW",
		})

		const key = "callsign:N0CALL-9"
		const one = await app.inject({
			method: "GET",
			url: `/api/aprs/stations/${encodeURIComponent(key)}`,
		})
		expect(one.statusCode).toBe(200)
		expect(one.json()).toEqual(aprs.get(key))
		expect(one.json()).toMatchObject({
			key,
			kind: "station",
			callsign: "N0CALL-9",
			name: null,
			comment: "testing",
			status: "En route",
			symbol: "/>",
			altitudeFt: 1234,
			courseDeg: 90,
			speedKn: 36,
			killed: false,
			path: ["WIDE1-1", "WIDE2-1"],
			weather: {
				temperatureF: 72,
				humidityPct: 50,
				pressureMbar: 1013.2,
				windSpeedMph: 5,
				windDirectionDeg: 180,
				rainLastHourIn: 0.01,
				at: t2.toISOString(),
			},
			position: { lat: 40.5, lon: -74.25, at: t0.toISOString() },
		})

		const objectKey = "aprs-object:MEETING"
		const object = await app.inject({
			method: "GET",
			url: `/api/aprs/stations/${encodeURIComponent(objectKey)}`,
		})
		expect(object.statusCode).toBe(200)
		expect(object.json()).toEqual(aprs.get(objectKey))
		expect(object.json().name).toBe("MEETING")
		expect(object.json().status).toBeNull()

		const missing = await app.inject({
			method: "GET",
			url: "/api/aprs/stations/callsign:W1AW-1",
		})
		expect(missing.statusCode).toBe(404)
		expect(missing.json()).toEqual({
			error: "APRS station not found",
			code: "APRS_STATION_NOT_FOUND",
			key: "callsign:W1AW-1",
		})

		for (const bad of [
			"nope",
			"callsign:",
			"callsign:n0call",
			"callsign:TOOLONG",
			"callsign:N0CALL-",
			"callsign:N0CALL-123",
			"aprs-object:",
			"aprs-object:HAS:COLON",
			"aprs-item:",
			"aprs-object:NAMETOOLONG",
		]) {
			const response = await app.inject({
				method: "GET",
				url: `/api/aprs/stations/${encodeURIComponent(bad)}`,
			})
			expect(response.statusCode).toBe(400)
			expect(response.json()).toEqual({
				error: "APRS station key is outside the allowed grammar",
				code: "VALIDATION_ERROR",
			})
		}
	})
})
