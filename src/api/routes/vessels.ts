/**
 * Vessel API routes — current AIS state.
 *
 * - GET /api/vessels
 * - GET /api/vessels/stats
 * - GET /api/vessels/:mmsi
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify"
import type { VesselTracker } from "../../core/vessel-tracker.js"
import type {
	VesselListResponse,
	VesselNotFoundResponse,
	VesselState,
	VesselTrackerStats,
} from "@wavekit/api-types"

export interface VesselRoutesOptions extends FastifyPluginOptions {
	tracker: VesselTracker
}

const nullableString = { type: ["string", "null"] } as const
const nullableNumber = { type: ["number", "null"] } as const

const positionSchema = {
	anyOf: [
		{
			type: "object",
			properties: {
				lat: { type: "number" },
				lon: { type: "number" },
				at: { type: "string" },
			},
			required: ["lat", "lon", "at"],
		},
		{ type: "null" },
	],
} as const

const vesselStateSchema = {
	type: "object",
	properties: {
		mmsi: { type: "string" },
		vesselClass: { type: "string" },
		name: nullableString,
		callsign: nullableString,
		imo: nullableNumber,
		shipType: nullableNumber,
		destination: nullableString,
		eta: nullableString,
		draught: nullableNumber,
		position: positionSchema,
		cog: nullableNumber,
		sog: nullableNumber,
		heading: nullableNumber,
		navStatus: nullableNumber,
		messageTypes: { type: "array", items: { type: "number" } },
		messageCount: { type: "number" },
		decoderId: { type: "string" },
		firstSeen: { type: "string" },
		lastSeen: { type: "string" },
		lastStaticAt: nullableString,
		channel: { type: ["string", "null"] },
		aton: {
			type: ["object", "null"],
			properties: {
				aidType: nullableNumber,
				virtual: { type: ["boolean", "null"] },
				offPosition: { type: ["boolean", "null"] },
			},
		},
		altitudeM: nullableNumber,
	},
	required: [
		"mmsi",
		"vesselClass",
		"name",
		"callsign",
		"imo",
		"shipType",
		"destination",
		"eta",
		"draught",
		"position",
		"cog",
		"sog",
		"heading",
		"navStatus",
		"messageTypes",
		"messageCount",
		"decoderId",
		"firstSeen",
		"lastSeen",
		"lastStaticAt",
	],
} as const

const byClassSchema = {
	type: "object",
	properties: {
		A: { type: "number" },
		B: { type: "number" },
		"base-station": { type: "number" },
		aton: { type: "number" },
		sar: { type: "number" },
		unknown: { type: "number" },
	},
	required: ["A", "B", "base-station", "aton", "sar", "unknown"],
} as const

const statsSchema = {
	type: "object",
	properties: {
		vesselCount: { type: "number" },
		withPosition: { type: "number" },
		withName: { type: "number" },
		byClass: byClassSchema,
		messagesProcessed: { type: "number" },
		messagesPerSecond: { type: "number" },
		lastMessageAt: nullableString,
		latestMmsi: nullableString,
		expiredTotal: { type: "number" },
		timestamp: { type: "string" },
	},
	required: [
		"vesselCount",
		"withPosition",
		"withName",
		"byClass",
		"messagesProcessed",
		"messagesPerSecond",
		"lastMessageAt",
		"latestMmsi",
		"expiredTotal",
		"timestamp",
	],
} as const

const listResponseSchema = {
	type: "object",
	properties: {
		vessels: { type: "array", items: vesselStateSchema },
		stats: statsSchema,
		timestamp: { type: "string" },
	},
	required: ["vessels", "stats", "timestamp"],
} as const

const notFoundSchema = {
	type: "object",
	properties: {
		error: { type: "string" },
		code: { type: "string", const: "VESSEL_NOT_FOUND" },
		mmsi: { type: "string" },
	},
	required: ["error", "code", "mmsi"],
} as const

const validationErrorSchema = {
	type: "object",
	properties: {
		error: { type: "string" },
		code: { type: "string", const: "VALIDATION_ERROR" },
	},
	required: ["error", "code"],
} as const

const MMSI_PARAM = /^\d{1,9}$/

/**
 * Vessel routes plugin. `stats` is registered before `:mmsi`.
 */
export async function vesselRoutes(
	app: FastifyInstance,
	options: VesselRoutesOptions,
): Promise<void> {
	const { tracker } = options

	app.get<{ Reply: VesselListResponse }>(
		"/api/vessels",
		{
			schema: {
				description: "List tracked AIS vessels, most recently heard first",
				tags: ["vessels"],
				response: { 200: listResponseSchema },
			},
		},
		async () => {
			const stats = tracker.getStats()
			return {
				vessels: tracker.getAll(),
				stats,
				timestamp: new Date().toISOString(),
			}
		},
	)

	app.get<{ Reply: VesselTrackerStats }>(
		"/api/vessels/stats",
		{
			schema: {
				description: "Vessel tracker statistics",
				tags: ["vessels"],
				response: { 200: statsSchema },
			},
		},
		async () => tracker.getStats(),
	)

	app.get<{
		Params: { mmsi: string }
		Reply:
			| VesselState
			| VesselNotFoundResponse
			| { error: string; code: "VALIDATION_ERROR" }
	}>(
		"/api/vessels/:mmsi",
		{
			schema: {
				description: "One vessel by MMSI (1–9 digits, zero-padded)",
				tags: ["vessels"],
				params: {
					type: "object",
					properties: {
						mmsi: { type: "string" },
					},
					required: ["mmsi"],
				},
				response: {
					200: vesselStateSchema,
					400: validationErrorSchema,
					404: notFoundSchema,
				},
			},
		},
		async (request, reply) => {
			const raw = request.params.mmsi
			if (!MMSI_PARAM.test(raw)) {
				reply.status(400)
				return {
					error: "MMSI must be 1-9 digits",
					code: "VALIDATION_ERROR" as const,
				}
			}
			const mmsi = raw.padStart(9, "0")
			const vessel = tracker.get(mmsi)
			if (!vessel) {
				reply.status(404)
				return {
					error: "Vessel not found",
					code: "VESSEL_NOT_FOUND" as const,
					mmsi,
				}
			}
			return vessel
		},
	)

	app.log.info("Vessel routes registered: /api/vessels")
}

export default vesselRoutes
