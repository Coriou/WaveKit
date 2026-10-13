/**
 * GET /api/mesh/nodes, /api/mesh/stats and /api/mesh/nodes/:nodeId.
 */

import Fastify from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import { meshRoutes } from "../../../src/api/routes/mesh.js"
import { MeshTracker } from "../../../src/core/mesh-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"
import {
	encodePosition,
	encodeUser,
	meshPacket,
} from "../../mocks/fixtures/meshtastic/encode.js"

const logger = createLogger({ level: "error" })

async function appWith(tracker = new MeshTracker({}, logger)) {
	const app = Fastify()
	await app.register(meshRoutes, { tracker })
	return { app, tracker }
}

describe("mesh routes", () => {
	const open: Array<{ close(): Promise<void> }> = []

	afterEach(async () => {
		await Promise.all(open.splice(0).map(app => app.close()))
	})

	it("round-trips a full node and returns 400 and 404", async () => {
		const { app, tracker } = await appWith()
		open.push(app)
		const when = new Date("2026-06-15T12:00:00.000Z")
		const later = new Date("2026-06-15T12:05:00.000Z")
		tracker.processPacket(
			"lora",
			meshPacket({
				from: 0xab12cd34,
				to: 0xffffffff,
				id: 1,
				portnum: 3,
				payload: encodePosition({
					latitudeI: 377_749_000,
					longitudeI: -1_224_194_000,
					altitudeM: 0,
				}),
				rxSnr: 6.5,
				rxRssi: -70,
				hopStart: 3,
				hopLimit: 3,
				viaMqtt: true,
			}),
			when,
		)
		tracker.processPacket(
			"lora",
			meshPacket({
				from: 0xab12cd34,
				id: 2,
				portnum: 4,
				payload: encodeUser({
					id: "!ab12cd34",
					longName: "Ada",
					shortName: "AD",
					hwModel: 0,
					isLicensed: false,
					role: 1,
				}),
				rxSnr: 4,
				rxRssi: -80,
				hopStart: 3,
				hopLimit: 1,
			}),
			when,
		)
		tracker.processPacket(
			"lora",
			meshPacket({
				from: 0xab12cd34,
				id: 2,
				portnum: 4,
				rxSnr: 1,
			}),
			new Date(when.getTime() + 1_000),
		)
		tracker.processPacket(
			"lora",
			meshPacket({ from: 7, id: 1, portnum: 1, rxSnr: 0, rxRssi: 0 }),
			later,
		)

		const list = await app.inject({ method: "GET", url: "/api/mesh/nodes" })
		expect(list.statusCode).toBe(200)
		const listed = list.json()
		expect(listed.nodes.map((node: { nodeId: string }) => node.nodeId)).toEqual(
			["!00000007", "!ab12cd34"],
		)
		expect(listed.stats.nodeCount).toBe(2)
		expect(typeof listed.timestamp).toBe("string")
		expect(listed.nodes[0].longName).toBeNull()
		expect(listed.nodes[0].position).toBeNull()
		expect(listed.nodes[0].snrDb).toBeNull()
		expect(listed.nodes[0].rssiDbm).toBeNull()
		expect(listed.nodes[0].lastNodeInfoAt).toBeNull()
		expect(listed.nodes[0].portnums).toEqual({ "1": 1 })

		const stats = await app.inject({ method: "GET", url: "/api/mesh/stats" })
		expect(stats.statusCode).toBe(200)
		expect(stats.json()).toMatchObject({
			nodeCount: 2,
			withPosition: 1,
			withName: 1,
			packetsProcessed: 4,
			duplicatesDropped: 1,
			invalidPackets: 0,
			decodeErrors: 0,
			latestNodeId: "!00000007",
			expiredTotal: 0,
		})

		const one = await app.inject({
			method: "GET",
			url: "/api/mesh/nodes/!AB12CD34",
		})
		expect(one.statusCode).toBe(200)
		expect(one.json()).toEqual(tracker.get("!ab12cd34"))
		expect(one.json()).toMatchObject({
			nodeId: "!ab12cd34",
			key: "node:!ab12cd34",
			nodeNum: 0xab12cd34,
			longName: "Ada",
			shortName: "AD",
			hwModel: 0,
			role: 1,
			isLicensed: false,
			hopsAway: 2,
			viaMqtt: false,
			packetCount: 2,
			duplicateCopies: 1,
			portnums: { "3": 1, "4": 1 },
			position: {
				lat: 37.7749,
				lon: -122.4194,
				altitudeM: 0,
				at: when.toISOString(),
			},
		})

		const encoded = await app.inject({
			method: "GET",
			url: "/api/mesh/nodes/%21ab12cd34",
		})
		expect(encoded.statusCode).toBe(200)
		expect(encoded.json().nodeId).toBe("!ab12cd34")

		const missing = await app.inject({
			method: "GET",
			url: "/api/mesh/nodes/!00000001",
		})
		expect(missing.statusCode).toBe(404)
		expect(missing.json()).toEqual({
			error: "Mesh node not found",
			code: "MESH_NODE_NOT_FOUND",
			nodeId: "!00000001",
		})

		for (const bad of ["abc", "!abc", "!gggggggg", "!ab12cd3", "!ab12cd345"]) {
			const response = await app.inject({
				method: "GET",
				url: `/api/mesh/nodes/${encodeURIComponent(bad)}`,
			})
			expect(response.statusCode).toBe(400)
			expect(response.json()).toEqual({
				error: "Node id must be ! and 8 hex digits",
				code: "VALIDATION_ERROR",
			})
		}
	})
})
