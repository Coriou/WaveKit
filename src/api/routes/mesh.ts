/**
 * Meshtastic node API routes — current mesh state (WG2 req 6.1).
 *
 * - GET /api/mesh/nodes
 * - GET /api/mesh/stats
 * - GET /api/mesh/nodes/:nodeId
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify"
import type {
	MeshNode,
	MeshNodeListResponse,
	MeshNodeNotFoundResponse,
	MeshTrackerStats,
} from "@wavekit/api-types"
import { canonicalNodeId, type MeshTracker } from "../../core/mesh-tracker.js"
import { validationFieldsSchema } from "../validation-errors.js"

export interface MeshRoutesOptions extends FastifyPluginOptions {
	tracker: MeshTracker
}

const nullableString = { type: ["string", "null"] } as const
const nullableNumber = { type: ["number", "null"] } as const
const nullableInteger = { type: ["integer", "null"] } as const
const nullableBoolean = { type: ["boolean", "null"] } as const

const positionSchema = {
	anyOf: [
		{
			type: "object",
			properties: {
				lat: { type: "number" },
				lon: { type: "number" },
				altitudeM: nullableNumber,
				at: { type: "string" },
				fixAt: nullableString,
			},
			required: ["lat", "lon", "altitudeM", "at"],
		},
		{ type: "null" },
	],
} as const

const telemetrySchema = {
	anyOf: [
		{
			type: "object",
			properties: {
				batteryPct: nullableNumber,
				powered: nullableBoolean,
				voltageV: nullableNumber,
				channelUtilizationPct: nullableNumber,
				airUtilTxPct: nullableNumber,
				uptimeS: nullableNumber,
				at: { type: "string" },
			},
			required: [
				"batteryPct",
				"powered",
				"voltageV",
				"channelUtilizationPct",
				"airUtilTxPct",
				"uptimeS",
				"at",
			],
		},
		{ type: "null" },
	],
} as const

const neighboursSchema = {
	type: "array",
	items: {
		type: "object",
		properties: {
			nodeId: { type: "string" },
			snrDb: nullableNumber,
			at: { type: "string" },
		},
		required: ["nodeId", "snrDb", "at"],
	},
} as const

const nodeSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		nodeId: { type: "string" },
		key: { type: "string" },
		nodeNum: { type: "integer" },
		longName: nullableString,
		shortName: nullableString,
		hwModel: nullableInteger,
		role: nullableInteger,
		isLicensed: nullableBoolean,
		position: positionSchema,
		snrDb: nullableNumber,
		rssiDbm: nullableNumber,
		hopsAway: nullableInteger,
		viaMqtt: { type: "boolean" },
		packetCount: { type: "integer" },
		duplicateCopies: { type: "integer" },
		portnums: {
			type: "object",
			additionalProperties: { type: "integer" },
		},
		lastPortnum: { type: "integer" },
		decoderId: { type: "string" },
		firstSeen: { type: "string" },
		lastSeen: { type: "string" },
		lastNodeInfoAt: nullableString,
		telemetry: telemetrySchema,
		neighbours: neighboursSchema,
	},
	required: [
		"nodeId",
		"key",
		"nodeNum",
		"longName",
		"shortName",
		"hwModel",
		"role",
		"isLicensed",
		"position",
		"snrDb",
		"rssiDbm",
		"hopsAway",
		"viaMqtt",
		"packetCount",
		"duplicateCopies",
		"portnums",
		"lastPortnum",
		"decoderId",
		"firstSeen",
		"lastSeen",
		"lastNodeInfoAt",
	],
} as const

const statsSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		nodeCount: { type: "integer" },
		withPosition: { type: "integer" },
		withName: { type: "integer" },
		packetsProcessed: { type: "integer" },
		duplicatesDropped: { type: "integer" },
		invalidPackets: { type: "integer" },
		decodeErrors: { type: "integer" },
		packetsPerSecond: { type: "number" },
		lastPacketAt: nullableString,
		latestNodeId: nullableString,
		expiredTotal: { type: "integer" },
		telemetryPackets: { type: "integer" },
		neighbourReports: { type: "integer" },
		timestamp: { type: "string" },
	},
	required: [
		"nodeCount",
		"withPosition",
		"withName",
		"packetsProcessed",
		"duplicatesDropped",
		"invalidPackets",
		"decodeErrors",
		"packetsPerSecond",
		"lastPacketAt",
		"latestNodeId",
		"expiredTotal",
		"timestamp",
	],
} as const

const listResponseSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		nodes: { type: "array", items: nodeSchema },
		stats: statsSchema,
		timestamp: { type: "string" },
	},
	required: ["nodes", "stats", "timestamp"],
} as const

const notFoundSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		error: { type: "string" },
		code: { type: "string", const: "MESH_NODE_NOT_FOUND" },
		nodeId: { type: "string" },
	},
	required: ["error", "code", "nodeId"],
} as const

const validationErrorSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		error: { type: "string" },
		code: { type: "string", const: "VALIDATION_ERROR" },
		message: { type: "string" },
		fields: validationFieldsSchema,
	},
	required: ["error", "code"],
} as const

/**
 * Mesh routes plugin. `stats` is its own path, not under `:nodeId`.
 */
export async function meshRoutes(
	app: FastifyInstance,
	options: MeshRoutesOptions,
): Promise<void> {
	const { tracker } = options

	app.get<{ Reply: MeshNodeListResponse }>(
		"/api/mesh/nodes",
		{
			schema: {
				description: "List tracked Meshtastic nodes, most recently heard first",
				tags: ["mesh"],
				response: { 200: listResponseSchema },
			},
		},
		async () => {
			const stats = tracker.getStats()
			return {
				nodes: tracker.getAll(),
				stats,
				timestamp: new Date().toISOString(),
			}
		},
	)

	app.get<{ Reply: MeshTrackerStats }>(
		"/api/mesh/stats",
		{
			schema: {
				description: "Mesh tracker statistics",
				tags: ["mesh"],
				response: { 200: statsSchema },
			},
		},
		async () => tracker.getStats(),
	)

	app.get<{
		Params: { nodeId: string }
		Reply:
			| MeshNode
			| MeshNodeNotFoundResponse
			| { error: string; code: "VALIDATION_ERROR" }
	}>(
		"/api/mesh/nodes/:nodeId",
		{
			schema: {
				description: "One node by id (! and 8 hex digits, case-insensitive)",
				tags: ["mesh"],
				params: {
					type: "object",
					properties: {
						nodeId: { type: "string" },
					},
					required: ["nodeId"],
				},
				response: {
					200: nodeSchema,
					400: validationErrorSchema,
					404: notFoundSchema,
				},
			},
		},
		async (request, reply) => {
			const nodeId = canonicalNodeId(request.params.nodeId)
			if (!nodeId) {
				reply.status(400)
				return {
					error: "Node id must be ! and 8 hex digits",
					code: "VALIDATION_ERROR" as const,
					message:
						"Invalid path parameter: nodeId: ! followed by 8 hex digits (case-insensitive)",
					fields: [
						{
							field: "nodeId",
							expected: "! followed by 8 hex digits (case-insensitive)",
						},
					],
				}
			}
			const node = tracker.get(nodeId)
			if (!node) {
				reply.status(404)
				return {
					error: "Mesh node not found",
					code: "MESH_NODE_NOT_FOUND" as const,
					nodeId,
				}
			}
			return node
		},
	)

	app.log.info("Mesh routes registered: /api/mesh")
}

export default meshRoutes
