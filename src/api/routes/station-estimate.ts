import type { FastifyInstance } from "fastify"
import type { StationEstimate } from "@wavekit/api-types"
import type { StationEstimateProvider } from "../../core/station-estimate/contract.js"

export interface StationEstimateRoutesOptions {
	estimate: StationEstimateProvider
}

const nullableNumber = { type: ["number", "null"] } as const
const count = { type: "integer", minimum: 0 } as const

const responseSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		available: { type: "boolean" },
		reason: {
			anyOf: [
				{ type: "string", enum: ["too-few-positions", "degenerate"] },
				{ type: "null" },
			],
		},
		lat: nullableNumber,
		lon: nullableNumber,
		uncertaintyKm: nullableNumber,
		basis: {
			type: "object",
			additionalProperties: false,
			properties: {
				aircraft: count,
				vessels: count,
				aprs: count,
				mesh: count,
			},
			required: ["aircraft", "vessels", "aprs", "mesh"],
		},
		computedAt: { type: "string" },
		cachedUntil: { type: "string" },
		authoritative: { type: "boolean", const: false },
		stationConfigured: { type: "boolean" },
	},
	required: [
		"available",
		"reason",
		"lat",
		"lon",
		"uncertaintyKm",
		"basis",
		"computedAt",
		"cachedUntil",
		"authoritative",
		"stationConfigured",
	],
} as const

const errorSchema = {
	type: "object",
	properties: {
		error: { type: "string" },
		code: { type: "string", const: "STATION_ESTIMATE_FAILED" },
		message: { type: "string" },
	},
	required: ["error", "code", "message"],
} as const

type ErrorBody = {
	error: string
	code: "STATION_ESTIMATE_FAILED"
	message: string
}

/** GET (and HEAD) /api/station/estimate: derived, never authoritative. */
export async function stationEstimateRoutes(
	app: FastifyInstance,
	options: StationEstimateRoutesOptions,
): Promise<void> {
	app.get<{ Reply: StationEstimate | ErrorBody }>(
		"/api/station/estimate",
		{
			schema: {
				description: "Approximate receiver location from heard positions",
				tags: ["station"],
				response: { 200: responseSchema, 500: errorSchema },
			},
		},
		async (_request, reply) => {
			reply.header("Cache-Control", "no-store")
			try {
				return await options.estimate.estimate()
			} catch {
				return reply.code(500).send({
					error: "Internal Server Error",
					code: "STATION_ESTIMATE_FAILED",
					message: "Station estimate failed",
				})
			}
		},
	)
}
