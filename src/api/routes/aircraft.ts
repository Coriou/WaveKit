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

import { z } from "zod"
import type {
	FastifyInstance,
	FastifyPluginOptions,
	FastifyRequest,
} from "fastify"
import type { DeniedAdmission } from "../../access/types.js"
import type { AircraftTracker } from "../../core/aircraft-tracker.js"
import type {
	AircraftInfoSettings,
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
	/** The enrichment settings (GET/PUT /api/aircraft/info); absent: no such route. */
	info?: {
		settings(): AircraftInfoSettings
		setOnline(on: boolean): AircraftInfoSettings
	}
	/** Protected mode: the extra admission PUT /api/aircraft/info needs. */
	authorizeMutation?: (request: FastifyRequest) => DeniedAdmission | undefined
}

const infoUpdateBody = z.object({ online: z.boolean() }).strict()

const infoSettingsSchema = {
	type: "object",
	required: ["enabled", "online", "onlineFrom", "persistent", "localDb"],
	properties: {
		enabled: { type: "boolean" },
		online: { type: "boolean" },
		onlineFrom: { type: "string", enum: ["config", "ui"] },
		persistent: { type: "boolean" },
		localDb: {
			type: "object",
			required: ["enabled", "aircraft", "updatedAt"],
			properties: {
				enabled: { type: "boolean" },
				aircraft: { type: ["integer", "null"] },
				updatedAt: { type: ["string", "null"] },
			},
		},
	},
} as const

// ============================================================================
// Schema Definitions
// ============================================================================

const airportSchema = {
	type: "object",
	properties: {
		icao: { type: "string" },
		iata: { type: "string" },
		name: { type: "string" },
		city: { type: "string" },
		country: { type: "string" },
		countryIso: { type: "string" },
		lat: { type: "number" },
		lon: { type: "number" },
	},
} as const

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
				countryIso: { type: "string" },
				year: { type: "number" },
				flags: {
					type: "object",
					properties: {
						military: { type: "boolean" },
						interesting: { type: "boolean" },
						pia: { type: "boolean" },
						ladd: { type: "boolean" },
					},
				},
				airline: {
					type: "object",
					description: "Airline flying the current callsign",
					properties: {
						name: { type: "string" },
						icao: { type: "string" },
						iata: { type: "string" },
						callsign: { type: "string" },
						country: { type: "string" },
						countryIso: { type: "string" },
						source: { type: "string" },
					},
				},
				route: {
					type: "object",
					description:
						"Planned route of the current callsign (crowd-sourced, may be wrong)",
					properties: {
						callsign: { type: "string" },
						origin: airportSchema,
						destination: airportSchema,
						source: { type: "string" },
					},
				},
				photo: {
					type: "object",
					description: "Airframe photo; show the photographer and link back",
					properties: {
						thumbnailUrl: { type: "string" },
						largeUrl: { type: "string" },
						photographer: { type: "string" },
						link: { type: "string" },
						source: { type: "string" },
					},
				},
				imageUrl: { type: "string" },
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

	// GET/PUT /api/aircraft/info - Enrichment settings (online lookups switch)
	const info = options.info
	if (info) {
		fastify.get<{ Reply: AircraftInfoSettings }>(
			"/api/aircraft/info",
			{
				schema: {
					description:
						"Aircraft enrichment settings: online lookups and the local database",
					tags: ["aircraft"],
					response: { 200: infoSettingsSchema },
				},
			},
			async (_request, reply) => {
				reply.header("Cache-Control", "no-store")
				return info.settings()
			},
		)
		fastify.put<{ Body: unknown; Reply: unknown }>(
			"/api/aircraft/info",
			{
				bodyLimit: 1024,
				schema: {
					description:
						"Turn online aircraft lookups on or off (kept across restarts)",
					tags: ["aircraft"],
					response: { 200: infoSettingsSchema },
				},
			},
			async (request, reply) => {
				const denied = options.authorizeMutation?.(request)
				if (denied) {
					for (const [name, value] of Object.entries(denied.headers))
						reply.header(name, value)
					return reply.status(denied.status).send({ code: denied.code })
				}
				const body = infoUpdateBody.safeParse(request.body)
				if (!body.success)
					return reply.status(400).send({
						error: "Bad Request",
						message: "Expected { online: boolean }",
					})
				reply.header("Cache-Control", "no-store")
				return info.setOnline(body.data.online)
			},
		)
	}

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
