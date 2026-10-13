/**
 * APRS API routes — current station, object and item state.
 *
 * - GET /api/aprs/stations
 * - GET /api/aprs/stats
 * - GET /api/aprs/stations/:key
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify"
import type { AprsTracker } from "../../core/aprs-tracker.js"
import type {
	AprsStation,
	AprsStationListResponse,
	AprsStationNotFoundResponse,
	AprsTrackerStats,
} from "@wavekit/api-types"

export interface AprsRoutesOptions extends FastifyPluginOptions {
	tracker: AprsTracker
}

const nullableString = { type: ["string", "null"] } as const
const nullableNumber = { type: ["number", "null"] } as const

/**
 * `callsign:<CALL[-SSID]>`, `aprs-object:<name>` or `aprs-item:<name>`.
 * Names are 1–9 characters and may not contain `:` or C0 controls.
 */
const APRS_KEY =
	/^(callsign:[A-Z0-9]{1,6}(-[0-9]{1,2})?|aprs-(object|item):[^:\u0000-\u001f]{1,9})$/

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

const weatherSchema = {
	anyOf: [
		{
			type: "object",
			properties: {
				temperatureF: nullableNumber,
				humidityPct: nullableNumber,
				pressureMbar: nullableNumber,
				windSpeedMph: nullableNumber,
				windDirectionDeg: nullableNumber,
				rainLastHourIn: nullableNumber,
				at: { type: "string" },
			},
			required: [
				"temperatureF",
				"humidityPct",
				"pressureMbar",
				"windSpeedMph",
				"windDirectionDeg",
				"rainLastHourIn",
				"at",
			],
		},
		{ type: "null" },
	],
} as const

const stationSchema = {
	type: "object",
	properties: {
		key: { type: "string" },
		kind: { type: "string" },
		callsign: { type: "string" },
		name: nullableString,
		position: positionSchema,
		altitudeFt: nullableNumber,
		courseDeg: nullableNumber,
		speedKn: nullableNumber,
		symbol: nullableString,
		comment: nullableString,
		status: nullableString,
		weather: weatherSchema,
		path: { type: "array", items: { type: "string" } },
		lastDataType: { type: "string" },
		killed: { type: "boolean" },
		packetCount: { type: "number" },
		digipeatedCopies: { type: "number" },
		decoderId: { type: "string" },
		firstSeen: { type: "string" },
		lastSeen: { type: "string" },
	},
	required: [
		"key",
		"kind",
		"callsign",
		"name",
		"position",
		"altitudeFt",
		"courseDeg",
		"speedKn",
		"symbol",
		"comment",
		"status",
		"weather",
		"path",
		"lastDataType",
		"killed",
		"packetCount",
		"digipeatedCopies",
		"decoderId",
		"firstSeen",
		"lastSeen",
	],
} as const

const byKindSchema = {
	type: "object",
	properties: {
		station: { type: "number" },
		object: { type: "number" },
		item: { type: "number" },
	},
	required: ["station", "object", "item"],
} as const

const statsSchema = {
	type: "object",
	properties: {
		stationCount: { type: "number" },
		withPosition: { type: "number" },
		byKind: byKindSchema,
		packetsProcessed: { type: "number" },
		duplicatesDropped: { type: "number" },
		invalidPackets: { type: "number" },
		packetsPerSecond: { type: "number" },
		lastPacketAt: nullableString,
		latestKey: nullableString,
		expiredTotal: { type: "number" },
		timestamp: { type: "string" },
	},
	required: [
		"stationCount",
		"withPosition",
		"byKind",
		"packetsProcessed",
		"duplicatesDropped",
		"invalidPackets",
		"packetsPerSecond",
		"lastPacketAt",
		"latestKey",
		"expiredTotal",
		"timestamp",
	],
} as const

const listResponseSchema = {
	type: "object",
	properties: {
		stations: { type: "array", items: stationSchema },
		stats: statsSchema,
		timestamp: { type: "string" },
	},
	required: ["stations", "stats", "timestamp"],
} as const

const notFoundSchema = {
	type: "object",
	properties: {
		error: { type: "string" },
		code: { type: "string", const: "APRS_STATION_NOT_FOUND" },
		key: { type: "string" },
	},
	required: ["error", "code", "key"],
} as const

const validationErrorSchema = {
	type: "object",
	properties: {
		error: { type: "string" },
		code: { type: "string", const: "VALIDATION_ERROR" },
	},
	required: ["error", "code"],
} as const

/**
 * APRS routes plugin. `stats` is a separate path from `:key`.
 */
export async function aprsRoutes(
	app: FastifyInstance,
	options: AprsRoutesOptions,
): Promise<void> {
	const { tracker } = options

	app.get<{ Reply: AprsStationListResponse }>(
		"/api/aprs/stations",
		{
			schema: {
				description:
					"List tracked APRS stations, objects and items, most recently heard first",
				tags: ["aprs"],
				response: { 200: listResponseSchema },
			},
		},
		async () => {
			const stats = tracker.getStats()
			return {
				stations: tracker.getAll(),
				stats,
				timestamp: new Date().toISOString(),
			}
		},
	)

	app.get<{ Reply: AprsTrackerStats }>(
		"/api/aprs/stats",
		{
			schema: {
				description: "APRS tracker statistics",
				tags: ["aprs"],
				response: { 200: statsSchema },
			},
		},
		async () => tracker.getStats(),
	)

	app.get<{
		Params: { key: string }
		Reply:
			| AprsStation
			| AprsStationNotFoundResponse
			| { error: string; code: "VALIDATION_ERROR" }
	}>(
		"/api/aprs/stations/:key",
		{
			schema: {
				description:
					"One APRS entity by key (callsign:, aprs-object: or aprs-item:)",
				tags: ["aprs"],
				params: {
					type: "object",
					properties: {
						key: { type: "string" },
					},
					required: ["key"],
				},
				response: {
					200: stationSchema,
					400: validationErrorSchema,
					404: notFoundSchema,
				},
			},
		},
		async (request, reply) => {
			const key = request.params.key
			if (!APRS_KEY.test(key)) {
				reply.status(400)
				return {
					error: "APRS station key is outside the allowed grammar",
					code: "VALIDATION_ERROR" as const,
				}
			}
			const station = tracker.get(key)
			if (!station) {
				reply.status(404)
				return {
					error: "APRS station not found",
					code: "APRS_STATION_NOT_FOUND" as const,
					key,
				}
			}
			return station
		},
	)

	app.log.info("APRS routes registered: /api/aprs")
}

export default aprsRoutes
