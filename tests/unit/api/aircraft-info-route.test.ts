/**
 * GET/PUT /api/aircraft/info: the aircraft enrichment settings (online lookups switch).
 */

import Fastify from "fastify"
import { describe, expect, it } from "vitest"
import type { AircraftInfoSettings } from "@wavekit/api-types"
import { aircraftRoutes } from "../../../src/api/routes/aircraft.js"
import { AircraftTracker } from "../../../src/core/aircraft-tracker.js"
import type { DeniedAdmission } from "../../../src/access/types.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "error" })

function fakeInfo() {
	let online = true
	let from: AircraftInfoSettings["onlineFrom"] = "config"
	const settings = (): AircraftInfoSettings => ({
		enabled: true,
		online,
		onlineFrom: from,
		persistent: true,
		localDb: { enabled: true, aircraft: 12, updatedAt: null },
	})
	return {
		settings,
		setOnline(on: boolean) {
			online = on
			from = "ui"
			return settings()
		},
	}
}

async function appWith(deny?: DeniedAdmission) {
	const app = Fastify()
	const tracker = new AircraftTracker({ cleanupInterval: 60_000 }, logger)
	await app.register(aircraftRoutes, {
		tracker,
		info: fakeInfo(),
		...(deny ? { authorizeMutation: () => deny } : {}),
	})
	return {
		app,
		close: async () => {
			tracker.stop()
			await app.close()
		},
	}
}

describe("aircraft info route", () => {
	it("reports and flips online lookups", async () => {
		const { app, close } = await appWith()
		const get = await app.inject({ method: "GET", url: "/api/aircraft/info" })
		expect(get.statusCode).toBe(200)
		expect(get.json()).toEqual({
			enabled: true,
			online: true,
			onlineFrom: "config",
			persistent: true,
			localDb: { enabled: true, aircraft: 12, updatedAt: null },
		})
		const put = await app.inject({
			method: "PUT",
			url: "/api/aircraft/info",
			payload: { online: false },
		})
		expect(put.statusCode).toBe(200)
		expect(put.json()).toMatchObject({ online: false, onlineFrom: "ui" })
		const bad = await app.inject({
			method: "PUT",
			url: "/api/aircraft/info",
			payload: { online: "no", extra: 1 },
		})
		expect(bad.statusCode).toBe(400)
		await close()
	})

	it("refuses the change without the mutation admission", async () => {
		const { app, close } = await appWith({
			kind: "deny",
			status: 401,
			code: "SESSION_REQUIRED",
			headers: {},
		} as unknown as DeniedAdmission)
		const put = await app.inject({
			method: "PUT",
			url: "/api/aircraft/info",
			payload: { online: false },
		})
		expect(put.statusCode).toBe(401)
		const get = await app.inject({ method: "GET", url: "/api/aircraft/info" })
		expect(get.json()).toMatchObject({ online: true })
		await close()
	})
})
