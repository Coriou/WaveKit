/**
 * WG3: Coverage per bearing through the real ApiServer: the
 * CoverageManager passed in the dependencies serves GET /api/coverage; without one the
 * route is not mounted.
 */

import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AircraftState, CoverageResponse } from "@wavekit/api-types"
import {
	ApiServer,
	type ApiServerDependencies,
} from "../../../src/api/server.js"
import { CoverageManager } from "../../../src/core/coverage/coverage-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const NOW = Date.parse("2026-10-16T12:00:00.000Z")

function dependencies(
	coverage: CoverageManager | undefined,
): ApiServerDependencies {
	return {
		sourceManager: Object.assign(new EventEmitter(), {
			getStatus: vi.fn(),
			getAllStatus: vi.fn().mockReturnValue([]),
			getSourceAssignments: vi.fn().mockReturnValue([]),
			isSourceAvailable: vi.fn().mockReturnValue(true),
		}),
		fanoutManager: Object.assign(new EventEmitter(), {
			getTelemetrySnapshot: vi.fn().mockReturnValue({
				timestamp: new Date().toISOString(),
				branches: [],
				backpressureActiveCount: 0,
				droppedBytesTotal: 0,
				droppedChunksTotal: 0,
			}),
		}),
		decoderManager: Object.assign(new EventEmitter(), {
			getAllStatus: vi.fn().mockReturnValue([]),
			getAllHealth: vi.fn().mockReturnValue(new Map()),
		}),
		audioOutput: new EventEmitter(),
		logger,
		...(coverage ? { coverage } : {}),
	} as unknown as ApiServerDependencies
}

describe("coverage through the API server", () => {
	let server: ApiServer | undefined

	afterEach(async () => {
		await server?.stop()
		server = undefined
	})

	async function open(coverage: CoverageManager | undefined) {
		server = new ApiServer(dependencies(coverage), {
			host: "127.0.0.1",
			port: 0,
		})
		await server.start()
		return server.getApp()
	}

	it("answers 200 available:false without a station location", async () => {
		const app = await open(new CoverageManager({ station: null }))
		const res = await app.inject({ method: "GET", url: "/api/coverage" })
		expect(res.statusCode).toBe(200)
		const body = res.json<CoverageResponse>()
		expect(body.available).toBe(false)
		expect(body.reason).toBe("no-station-location")
		expect(body.protocols).toEqual([])
	})

	it("serves the sectors the manager accepted from the aircraft tracker", async () => {
		const air = new EventEmitter()
		const coverage = new CoverageManager({
			station: { lat: 0, lon: 0 },
			aircraft: air,
			now: () => NOW,
		})
		coverage.start()
		air.emit("aircraft:new", {
			icao: "ABC123",
			position: { lat: 0.5, lon: 0 },
			lastUpdated: NOW,
		} as AircraftState)
		const app = await open(coverage)
		const res = await app.inject({
			method: "GET",
			url: "/api/coverage?protocol=adsb",
		})
		expect(res.statusCode).toBe(200)
		const body = res.json<CoverageResponse>()
		expect(body.available).toBe(true)
		expect(body.station).toEqual({ lat: 0, lon: 0 })
		expect(body.protocols.map(p => [p.protocol, p.accepted])).toEqual([
			["adsb", 1],
		])
		coverage.stop()
	})

	it("does not mount the route without a coverage manager", async () => {
		const app = await open(undefined)
		const res = await app.inject({ method: "GET", url: "/api/coverage" })
		expect(res.statusCode).toBe(404)
	})
})
