/**
 * Mesh nodes through the real ApiServer (WG2 req 6.1-6.3): the tracker passed in the
 * dependencies serves /api/mesh and its events reach `mesh` WebSocket subscribers only.
 * `mesh:update` goes through the 2 s per-node throttle (req 9.4).
 */

import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MeshNodeListResponse } from "@wavekit/api-types"
import {
	ApiServer,
	type ApiServerDependencies,
} from "../../../src/api/server.js"
import { MeshTracker } from "../../../src/core/mesh-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"
import {
	encodeUser,
	meshPacket,
} from "../../mocks/fixtures/meshtastic/encode.js"

const logger = createLogger({ level: "fatal" })
const AT = Date.parse("2026-10-13T12:00:00.000Z")

function dependencies(tracker: MeshTracker): ApiServerDependencies {
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
		meshTracker: tracker,
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

const EVENTS = ["mesh:new", "mesh:update", "mesh:lost", "stats:update"] as const

describe("mesh nodes through the API server", () => {
	let tracker: MeshTracker
	let server: ApiServer
	let baseline: number[]

	beforeEach(async () => {
		tracker = new MeshTracker({ maxNodes: 1 }, logger)
		baseline = EVENTS.map(e => tracker.listenerCount(e))
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

	it("serves the routes and sends new, update, lost and stats to mesh subscribers only", async () => {
		expect(EVENTS.map(e => tracker.listenerCount(e))).toEqual(
			baseline.map(n => n + 1),
		)
		const subscriber = connect(server)
		subscriber.send({ type: "subscribe", channels: ["mesh"] })
		const other = connect(server)
		other.send({ type: "subscribe", channels: ["vessels"] })
		expect(subscriber.socket.sent.at(-1)).toMatchObject({
			type: "subscribed",
			data: { channels: ["mesh"] },
		})

		tracker.processPacket(
			"lora",
			meshPacket({ from: 5, id: 1, portnum: 1 }),
			new Date(AT),
		)
		tracker.processPacket(
			"lora",
			meshPacket({ from: 5, id: 2, portnum: 1 }),
			new Date(AT + 1000),
		)
		const list = await server
			.getApp()
			.inject({ method: "GET", url: "/api/mesh/nodes" })
		expect(list.statusCode).toBe(200)
		expect(list.json<MeshNodeListResponse>().nodes.map(n => n.nodeId)).toEqual([
			"!00000005",
		])
		const one = await server
			.getApp()
			.inject({ method: "GET", url: "/api/mesh/nodes/!00000005" })
		expect(one.statusCode).toBe(200)
		const stats = await server
			.getApp()
			.inject({ method: "GET", url: "/api/mesh/stats" })
		expect(stats.statusCode).toBe(200)

		// maxNodes 1: a second node evicts the first.
		tracker.processPacket(
			"lora",
			meshPacket({ from: 6, id: 3, portnum: 1 }),
			new Date(AT + 2000),
		)
		tracker.emit("stats:update", tracker.getStats())

		const mesh = subscriber.socket.sent.filter(m => m.type.startsWith("mesh:"))
		expect(mesh.map(m => [m.type, m.channel])).toEqual([
			["mesh:new", "mesh"],
			["mesh:update", "mesh"],
			["mesh:lost", "mesh"],
			["mesh:new", "mesh"],
			["mesh:stats", "mesh"],
		])
		expect(mesh[0]?.data).toMatchObject({ nodeId: "!00000005" })
		expect(mesh[2]?.data).toMatchObject({
			nodeId: "!00000005",
			node: { nodeId: "!00000005" },
		})
		expect(other.socket.sent.some(m => m.type.startsWith("mesh:"))).toBe(false)
	})

	it("detaches its listeners on stop", async () => {
		await server.stop()
		expect(EVENTS.map(e => tracker.listenerCount(e))).toEqual(baseline)
	})

	it("throttles mesh:update per node: leading, trailing latest, identity change at once, nothing after lost", async () => {
		const subscriber = connect(server)
		subscriber.send({ type: "subscribe", channels: ["mesh"] })
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "Date"],
			now: AT,
		})
		try {
			const packet = (from: number, id: number, extra = {}) =>
				tracker.processPacket(
					"lora",
					meshPacket({ from, id, portnum: 1, ...extra }),
					new Date(Date.now()),
				)
			const sent = () =>
				subscriber.socket.sent
					.filter(m => m.type.startsWith("mesh:"))
					.map(m => {
						const d = m.data as {
							nodeId: string
							packetCount?: number
							longName?: string | null
						}
						return [m.type, d.nodeId, d.packetCount ?? null, d.longName ?? null]
					})
			packet(5, 1) // new
			packet(5, 2) // leading update
			vi.advanceTimersByTime(500)
			packet(5, 3)
			packet(5, 4) // latest pending
			expect(sent()).toEqual([
				["mesh:new", "!00000005", 1, null],
				["mesh:update", "!00000005", 2, null],
			])
			vi.advanceTimersByTime(1500)
			expect(sent().at(-1)).toEqual(["mesh:update", "!00000005", 4, null])
			// A name is an identity change: sent at once inside the window.
			packet(5, 5, {
				portnum: 4,
				payload: encodeUser({ id: "!00000005", longName: "Ada" }),
			})
			expect(sent().at(-1)).toEqual(["mesh:update", "!00000005", 5, "Ada"])
			packet(5, 6) // pending
			const before = sent().length
			// maxNodes 1: node 6 evicts node 5; the pending update is dropped.
			packet(6, 7)
			vi.advanceTimersByTime(5000)
			expect(
				sent()
					.slice(before)
					.map(([type, id]) => [type, id]),
			).toEqual([
				["mesh:lost", "!00000005"],
				["mesh:new", "!00000006"],
			])
		} finally {
			vi.useRealTimers()
		}
	})
})
