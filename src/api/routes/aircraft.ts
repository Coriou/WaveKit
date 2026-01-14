/**
 * Aircraft API Routes - Real-time aircraft tracking endpoints
 *
 * These endpoints expose the AircraftTracker state via REST API.
 * This is an ADS-B-specific addon that does NOT affect other decoders.
 *
 * Endpoints:
 * - GET /api/aircraft         - List all tracked aircraft
 * - GET /api/aircraft/stats   - Get tracker statistics
 * - GET /api/aircraft/:icao   - Get specific aircraft by ICAO
 *
 * @module src/api/routes/aircraft
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify"
import type { AircraftTracker } from "../../core/aircraft-tracker.js"
import type {
	AircraftState,
	AircraftTrackerStats,
	AircraftListResponse,
	AircraftNotFoundResponse,
} from "@wavekit/api-types"

// ============================================================================
// Route Options
// ============================================================================

export interface AircraftRoutesOptions extends FastifyPluginOptions {
	/** Aircraft tracker instance */
	tracker: AircraftTracker
}

// ============================================================================
// Schema Definitions
// ============================================================================

const aircraftStateSchema = {
	type: "object",
	properties: {
		icao: { type: "string", description: "24-bit ICAO address (hex)" },
		callsign: { type: "string", description: "Flight callsign" },
		squawk: { type: "string", description: "Transponder squawk code" },
		messageType: { type: "string", description: "ADS-B message source type" },
		position: {
			type: "object",
			properties: {
				lat: { type: "number" },
				lon: { type: "number" },
				nic: { type: "number" },
				rc: { type: "number" },
				nacP: { type: "number" },
				seenPos: { type: "number" },
			},
		},
		velocity: {
			type: "object",
			properties: {
				gs: { type: "number", description: "Ground speed (knots)" },
				tas: { type: "number", description: "True airspeed (knots)" },
				ias: { type: "number", description: "Indicated airspeed (knots)" },
				mach: { type: "number" },
				track: { type: "number", description: "Track over ground (degrees)" },
				trackRate: { type: "number" },
				magHeading: { type: "number" },
				trueHeading: { type: "number" },
				roll: { type: "number" },
			},
		},
		altitude: {
			type: "object",
			properties: {
				baro: {
					type: ["number", "null"],
					description: "Barometric altitude (ft)",
				},
				geom: { type: "number", description: "Geometric altitude (ft)" },
				baroRate: { type: "number", description: "Vertical rate (ft/min)" },
				geomRate: { type: "number" },
				onGround: { type: "boolean" },
			},
		},
		navigation: {
			type: "object",
			properties: {
				qnh: { type: "number" },
				altitudeMcp: { type: "number" },
				altitudeFms: { type: "number" },
				heading: { type: "number" },
				modes: { type: "array", items: { type: "string" } },
			},
		},
		identification: {
			type: "object",
			properties: {
				registration: { type: "string" },
				typeCode: { type: "string" },
				typeDescription: { type: "string" },
				manufacturer: { type: "string" },
				operator: { type: "string" },
				operatorCode: { type: "string" },
				country: { type: "string" },
				source: { type: "string" },
			},
		},
		signalQuality: {
			type: "object",
			properties: {
				rssi: { type: "number" },
				sil: { type: "number" },
				silType: { type: "string" },
				nacV: { type: "number" },
				gva: { type: "number" },
				sda: { type: "number" },
				adsbVersion: { type: "number" },
			},
		},
		category: { type: "string", description: "Emitter category (A0-D7)" },
		emergency: { type: "string", description: "Emergency status" },
		trackHistory: {
			type: "array",
			items: {
				type: "object",
				properties: {
					lat: { type: "number" },
					lon: { type: "number" },
					altitude: { type: ["number", "null"] },
					timestamp: { type: "number" },
				},
			},
		},
		seen: { type: "number", description: "Seconds since last message" },
		seenPos: { type: "number", description: "Seconds since last position" },
		messages: { type: "number", description: "Total messages received" },
		firstSeen: {
			type: "number",
			description: "First seen timestamp (Unix ms)",
		},
		lastUpdated: {
			type: "number",
			description: "Last update timestamp (Unix ms)",
		},
	},
	required: ["icao", "seen", "messages", "firstSeen", "lastUpdated"],
} as const

const statsSchema = {
	type: "object",
	properties: {
		aircraftCount: { type: "number" },
		withPosition: { type: "number" },
		withCallsign: { type: "number" },
		enrichedCount: { type: "number" },
		messagesProcessed: { type: "number" },
		messagesPerSecond: { type: "number" },
		enrichmentCache: {
			type: "object",
			properties: {
				hits: { type: "number" },
				misses: { type: "number" },
				size: { type: "number" },
			},
		},
	},
	required: [
		"aircraftCount",
		"withPosition",
		"withCallsign",
		"enrichedCount",
		"messagesProcessed",
		"messagesPerSecond",
		"enrichmentCache",
	],
} as const

const listResponseSchema = {
	type: "object",
	properties: {
		aircraft: { type: "array", items: aircraftStateSchema },
		stats: statsSchema,
		timestamp: { type: "number" },
	},
	required: ["aircraft", "stats", "timestamp"],
} as const

const notFoundSchema = {
	type: "object",
	properties: {
		error: { type: "string" },
		icao: { type: "string" },
	},
	required: ["error", "icao"],
} as const

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * Aircraft routes plugin for Fastify.
 * Registers /api/aircraft endpoints for real-time aircraft tracking.
 */
export async function aircraftRoutes(
	fastify: FastifyInstance,
	options: AircraftRoutesOptions,
): Promise<void> {
	const { tracker } = options

	// GET /api/aircraft - List all tracked aircraft
	fastify.get<{
		Reply: AircraftListResponse
	}>(
		"/api/aircraft",
		{
			schema: {
				description: "List all currently tracked aircraft",
				tags: ["aircraft"],
				response: {
					200: listResponseSchema,
				},
			},
		},
		async (_request, _reply) => {
			return {
				aircraft: tracker.getAll(),
				stats: tracker.getStats(),
				timestamp: Date.now(),
			}
		},
	)

	// GET /api/aircraft/stats - Get tracker statistics only
	fastify.get<{
		Reply: AircraftTrackerStats
	}>(
		"/api/aircraft/stats",
		{
			schema: {
				description: "Get aircraft tracker statistics",
				tags: ["aircraft"],
				response: {
					200: statsSchema,
				},
			},
		},
		async (_request, _reply) => {
			return tracker.getStats()
		},
	)

	// GET /api/aircraft/:icao - Get specific aircraft by ICAO
	fastify.get<{
		Params: { icao: string }
		Reply: AircraftState | AircraftNotFoundResponse
	}>(
		"/api/aircraft/:icao",
		{
			schema: {
				description: "Get a specific aircraft by its ICAO address",
				tags: ["aircraft"],
				params: {
					type: "object",
					properties: {
						icao: {
							type: "string",
							description: "24-bit ICAO address (hex, e.g., A12345)",
							pattern: "^[A-Fa-f0-9]{6}$",
						},
					},
					required: ["icao"],
				},
				response: {
					200: aircraftStateSchema,
					404: notFoundSchema,
				},
			},
		},
		async (request, reply) => {
			const aircraft = tracker.get(request.params.icao)
			if (!aircraft) {
				reply.status(404)
				return {
					error: "Aircraft not found",
					icao: request.params.icao.toUpperCase(),
				}
			}
			return aircraft
		},
	)

	fastify.log.info("Aircraft routes registered: /api/aircraft")
}

export default aircraftRoutes
