/**
 * Vessels through the real ApiServer (WG1 req 6.1, 6.4): the tracker passed in
 * the dependencies serves GET /api/vessels and its events reach `vessels`
 * WebSocket subscribers, like the aircraft tracker.
 */

import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { VesselListResponse } from "@wavekit/api-types"
import {
	ApiServer,
	type ApiServerDependencies,
} from "../../../src/api/server.js"
import { VesselTracker } from "../../../src/core/vessel-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })

function dependencies(tracker: VesselTracker): ApiServerDependencies {
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
		vesselTracker: tracker,
	} as unknown as ApiServerDependencies
}

/** A socket through handleConnection, so subscribe takes the real path. */
function connect(server: ApiServer) {
	const socket = Object.assign(new EventEmitter(), {
		readyState: 1,
		bufferedAmount: 0,
		sent: [] as { type: string; channel?: string; data: unknown }[],
		send(d: string) {
			this.sent.push(JSON.parse(d) as never)
		},
		close: vi.fn(),
		ping: vi.fn(),
		terminate: vi.fn(),
	})
	;(
		server.getWebSocketBroadcaster() as unknown as {
			handleConnection(s: unknown): void
		}
	).handleConnection(socket)
	const send = (msg: unknown) => socket.emit("message", JSON.stringify(msg))
	return { socket, send }
}

describe("vessels through the API server", () => {
	let tracker: VesselTracker
	let server: ApiServer

	beforeEach(async () => {
		tracker = new VesselTracker({}, logger)
		server = new ApiServer(dependencies(tracker), {
			host: "127.0.0.1",
			port: 0,
		})
		await server.start()
	})

	afterEach(async () => {
		await server.stop()
		tracker.stop()
	})

	it("serves the routes and sends vessel:new and vessel:update to vessels subscribers only", async () => {
		const subscriber = connect(server)
		subscriber.send({ type: "subscribe", channels: ["vessels"] })
		const other = connect(server)
		other.send({ type: "subscribe", channels: ["aircraft"] })
		expect(subscriber.socket.sent.at(-1)).toMatchObject({
			type: "subscribed",
			data: { channels: ["vessels"] },
		})

		tracker.processShip(
			"ais",
			{ mmsi: "123456789", messageType: 1, lat: 10, lon: 20 },
			new Date("2026-06-15T12:00:00.000Z"),
		)
		tracker.processShip(
			"ais",
			{ mmsi: "123456789", messageType: 5, name: "EVER GIVEN" },
			new Date("2026-06-15T12:00:05.000Z"),
		)
		const vessel = subscriber.socket.sent.filter(m =>
			m.type.startsWith("vessel:"),
		)
		expect(vessel.map(m => [m.type, m.channel])).toEqual([
			["vessel:new", "vessels"],
			["vessel:update", "vessels"],
		])
		expect(vessel[0]?.data).toMatchObject({ mmsi: "123456789" })
		expect(other.socket.sent.some(m => m.type.startsWith("vessel:"))).toBe(
			false,
		)

		const list = await server
			.getApp()
			.inject({ method: "GET", url: "/api/vessels" })
		expect(list.statusCode).toBe(200)
		const body = list.json<VesselListResponse>()
		expect(body.vessels.map(v => v.mmsi)).toEqual(["123456789"])
		const one = await server
			.getApp()
			.inject({ method: "GET", url: "/api/vessels/123456789" })
		expect(one.statusCode).toBe(200)
	})
})
