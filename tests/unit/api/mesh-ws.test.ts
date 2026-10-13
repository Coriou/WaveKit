/**
 * Mesh nodes through the real ApiServer (WG2 req 6.1-6.3): the tracker passed in the
 * dependencies serves /api/mesh and its events reach `mesh` WebSocket subscribers only.
 * The 2 s update throttle (req 9.4) is wired with lane X's module; until then updates go out
 * directly.
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
import { meshPacket } from "../../mocks/fixtures/meshtastic/encode.js"

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
})
