/**
 * Aircraft through the real ApiServer: `aircraft:update` reaches subscribers at most once per
 * aircraft per second with the trail as `trackAppend`, and the broadcaster serialises nothing for
 * a channel with no subscriber.
 */

import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	ApiServer,
	type ApiServerDependencies,
} from "../../../src/api/server.js"
import { WebSocketEventBroadcaster } from "../../../src/api/websocket/events.js"
import { AircraftTracker } from "../../../src/core/aircraft-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })

function dependencies(tracker: AircraftTracker): ApiServerDependencies {
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
		aircraftTracker: tracker,
	} as unknown as ApiServerDependencies
}

interface Sent {
	type: string
	channel?: string
	data: Record<string, unknown>
}

/** A socket through handleConnection, so subscribe takes the real path. */
function connect(broadcaster: WebSocketEventBroadcaster) {
	const socket = Object.assign(new EventEmitter(), {
		readyState: 1,
		bufferedAmount: 0,
		sent: [] as Sent[],
		send(d: string) {
			this.sent.push(JSON.parse(d) as Sent)
		},
		close: vi.fn(),
		ping: vi.fn(),
		terminate: vi.fn(),
	})
	;(
		broadcaster as unknown as {
			handleConnection(s: unknown): void
		}
	).handleConnection(socket)
	const send = (msg: unknown) => socket.emit("message", JSON.stringify(msg))
	return { socket, send }
}

describe("aircraft through the API server", () => {
	let tracker: AircraftTracker
	let server: ApiServer

	beforeEach(async () => {
		vi.useFakeTimers({
			now: Date.parse("2026-11-01T00:00:00.000Z"),
			toFake: ["Date", "setTimeout", "clearTimeout"],
		})
		tracker = new AircraftTracker({}, logger)
		server = new ApiServer(dependencies(tracker), {
			host: "127.0.0.1",
			port: 0,
		})
		await server.start()
	})

	afterEach(async () => {
		await server.stop()
		tracker.stop()
		vi.useRealTimers()
	})

	it("throttles updates to 1 Hz per aircraft and sends the trail as deltas", () => {
		const client = connect(server.getWebSocketBroadcaster())
		client.send({ type: "subscribe", channels: ["aircraft"] })
		for (let i = 0; i < 20; i++) {
			tracker.processUpdate({
				hex: "A00001",
				lat: 50 + i * 0.01,
				lon: 4,
				alt_baro: 30_000,
			})
			vi.advanceTimersByTime(100)
		}
		vi.advanceTimersByTime(1000)
		const aircraft = client.socket.sent.filter(m => m.channel === "aircraft")
		expect(aircraft[0]).toMatchObject({ type: "aircraft:new" })
		expect(aircraft[0]?.data["trackHistory"]).toHaveLength(1)
		const updates = aircraft.filter(m => m.type === "aircraft:update")
		// 19 tracker updates over 2 s (plus the trailing flush) → 3 messages, not 19
		expect(updates.length).toBe(3)
		for (const u of updates) {
			expect(u.data["trackHistory"]).toBeUndefined()
			expect(Array.isArray(u.data["trackAppend"])).toBe(true)
		}
		const points = updates.reduce(
			(n, u) => n + (u.data["trackAppend"] as unknown[]).length,
			1,
		)
		expect(points).toBe(tracker.get("A00001")?.trackHistory?.length)
	})

	it("detaches from the tracker on stop", async () => {
		await server.stop()
		expect(tracker.listenerCount("aircraft:update")).toBe(0)
		expect(tracker.listenerCount("aircraft:new")).toBe(0)
		expect(tracker.listenerCount("aircraft:lost")).toBe(0)
	})
})

describe("broadcast with no subscriber", () => {
	it("serialises nothing, and once for any number of subscribers", () => {
		const broadcaster = new WebSocketEventBroadcaster(logger)
		const toJSON = vi.fn(() => ({ icao: "A00001" }))
		const message = {
			type: "aircraft:update" as const,
			data: { toJSON },
		}
		const other = connect(broadcaster)
		other.send({ type: "subscribe", channels: ["vessels"] })
		broadcaster.broadcast("aircraft", message)
		expect(toJSON).not.toHaveBeenCalled()

		const a = connect(broadcaster)
		a.send({ type: "subscribe", channels: ["aircraft"] })
		const b = connect(broadcaster)
		b.send({ type: "subscribe", channels: ["aircraft"] })
		broadcaster.broadcast("aircraft", message)
		expect(toJSON).toHaveBeenCalledTimes(1)
		expect(a.socket.sent.at(-1)).toMatchObject({
			type: "aircraft:update",
			channel: "aircraft",
			data: { icao: "A00001" },
		})
		expect(b.socket.sent.at(-1)).toEqual(a.socket.sent.at(-1))
		broadcaster.closeAll()
	})
})
