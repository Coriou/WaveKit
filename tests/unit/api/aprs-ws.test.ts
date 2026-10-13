/**
 * APRS stations through the real ApiServer (WG2 req 4.1-4.3, 9.4): the tracker passed in the
 * dependencies serves /api/aprs and its events reach `aprs` WebSocket subscribers only;
 * `aprs:update` goes through the 2 s per-entity throttle.
 */

import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AprsStationListResponse } from "@wavekit/api-types"
import {
	ApiServer,
	type ApiServerDependencies,
} from "../../../src/api/server.js"
import { AprsTracker } from "../../../src/core/aprs-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const AT = Date.parse("2026-10-13T12:00:00.000Z")

function dependencies(tracker: AprsTracker): ApiServerDependencies {
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
		aprsTracker: tracker,
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

const EVENTS = ["aprs:new", "aprs:update", "aprs:lost", "stats:update"] as const

let seq = 0
function packet(source: string, extra: Record<string, unknown> = {}) {
	seq += 1
	return {
		timestamp: new Date(AT),
		source,
		destination: "APRS",
		path: ["WIDE1-1"],
		dataType: "Position",
		lat: 40.5,
		lon: -74.25,
		symbol: "/>",
		comment: "alpha",
		raw: `!${source}-${seq}`,
		...extra,
	}
}

describe("APRS stations through the API server", () => {
	let tracker: AprsTracker
	let server: ApiServer
	let baseline: number[]

	beforeEach(async () => {
		tracker = new AprsTracker({ maxStations: 1 }, logger)
		baseline = EVENTS.map(e => tracker.listenerCount(e))
		server = new ApiServer(dependencies(tracker), {
			host: "127.0.0.1",
			port: 0,
		})
		await server.start()
	})

	afterEach(async () => {
		vi.useRealTimers()
		await server.stop()
		tracker.stop()
	})

	it("serves the routes and sends new, update, lost and stats to aprs subscribers only", async () => {
		expect(EVENTS.map(e => tracker.listenerCount(e))).toEqual(
			baseline.map(n => n + 1),
		)
		const subscriber = connect(server)
		subscriber.send({ type: "subscribe", channels: ["aprs"] })
		const other = connect(server)
		other.send({ type: "subscribe", channels: ["mesh"] })
		expect(subscriber.socket.sent.at(-1)).toMatchObject({
			type: "subscribed",
			data: { channels: ["aprs"] },
		})
		tracker.processAprs("direwolf", packet("N0CALL"), new Date(AT))
		tracker.processAprs(
			"direwolf",
			packet("N0CALL", { lat: 40.6 }),
			new Date(AT + 1000),
		)
		const list = await server
			.getApp()
			.inject({ method: "GET", url: "/api/aprs/stations" })
		expect(list.statusCode).toBe(200)
		expect(
			list.json<AprsStationListResponse>().stations.map(s => s.key),
		).toEqual(["callsign:N0CALL"])
		const one = await server.getApp().inject({
			method: "GET",
			url: "/api/aprs/stations/callsign:N0CALL",
		})
		expect(one.statusCode).toBe(200)
		const stats = await server
			.getApp()
			.inject({ method: "GET", url: "/api/aprs/stats" })
		expect(stats.statusCode).toBe(200)
		// maxStations 1: a second station evicts the first.
		tracker.processAprs("direwolf", packet("N1CALL"), new Date(AT + 2000))
		tracker.emit("stats:update", tracker.getStats())
		const aprs = subscriber.socket.sent.filter(m => m.type.startsWith("aprs:"))
		expect(aprs.map(m => [m.type, m.channel])).toEqual([
			["aprs:new", "aprs"],
			["aprs:update", "aprs"],
			["aprs:lost", "aprs"],
			["aprs:new", "aprs"],
			["aprs:stats", "aprs"],
		])
		expect(aprs[2]?.data).toMatchObject({
			station: { key: "callsign:N0CALL" },
		})
		expect(other.socket.sent.some(m => m.type.startsWith("aprs:"))).toBe(false)
	})

	it("throttles aprs:update per entity: leading, trailing latest, identity change at once, nothing after lost", () => {
		const subscriber = connect(server)
		subscriber.send({ type: "subscribe", channels: ["aprs"] })
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "Date"],
			now: AT,
		})
		const report = (source: string, extra: Record<string, unknown> = {}) =>
			tracker.processAprs(
				"direwolf",
				packet(source, extra),
				new Date(Date.now()),
			)
		const sent = () =>
			subscriber.socket.sent
				.filter(m => m.type.startsWith("aprs:"))
				.map(m => {
					const d = m.data as {
						key?: string
						packetCount?: number
						comment?: string | null
						station?: { key: string }
					}
					return [
						m.type,
						d.key ?? d.station?.key,
						d.packetCount ?? null,
						d.comment ?? null,
					]
				})
		report("N0CALL") // new
		report("N0CALL", { lat: 40.6 }) // leading update
		vi.advanceTimersByTime(500)
		report("N0CALL", { lat: 40.7 })
		report("N0CALL", { lat: 40.8 }) // latest pending
		expect(sent().map(([type]) => type)).toEqual(["aprs:new", "aprs:update"])
		vi.advanceTimersByTime(1500)
		expect(sent()).toHaveLength(3)
		expect(sent().at(-1)?.slice(0, 3)).toEqual([
			"aprs:update",
			"callsign:N0CALL",
			4,
		])
		// A comment is an identity change: sent at once inside the window.
		report("N0CALL", { comment: "beta" })
		expect(sent().at(-1)?.[3]).toBe("beta")
		report("N0CALL", { lat: 40.9, comment: "beta" }) // pending
		const before = sent().length
		report("N1CALL") // evicts N0CALL; its pending update is dropped
		vi.advanceTimersByTime(5000)
		expect(
			sent()
				.slice(before)
				.map(([type, key]) => [type, key]),
		).toEqual([
			["aprs:lost", "callsign:N0CALL"],
			["aprs:new", "callsign:N1CALL"],
		])
	})

	it("detaches its listeners on stop", async () => {
		await server.stop()
		expect(EVENTS.map(e => tracker.listenerCount(e))).toEqual(baseline)
	})
})
