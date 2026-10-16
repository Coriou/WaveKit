import { z } from "zod"
import { COVERAGE_PROTOCOLS } from "@wavekit/api-types"
import type { FastifyInstance } from "fastify"
import type { CoverageResponse } from "@wavekit/api-types"
import type { CoverageManager } from "../../core/coverage/coverage-manager.js"

export interface CoverageRoutesOptions {
	coverage: Pick<CoverageManager, "query">
}

const QuerySchema = z.object({
	protocol: z.enum(COVERAGE_PROTOCOLS as [string, ...string[]]).optional(),
})

const protocolEnum = { type: "string", enum: [...COVERAGE_PROTOCOLS] } as const
const stationSchema = {
	anyOf: [
		{
			type: "object",
			properties: { lat: { type: "number" }, lon: { type: "number" } },
			required: ["lat", "lon"],
		},
		{ type: "null" },
	],
} as const

const responseSchema = {
	type: "object",
	properties: {
		available: { type: "boolean" },
		reason: { type: "string", enum: ["no-station-location"] },
		station: stationSchema,
		windowHours: { type: "number" },
		bearingStepDeg: { type: "number" },
		protocols: {
			type: "array",
			items: {
				type: "object",
				properties: {
					protocol: protocolEnum,
					sectors: {
						type: "array",
						items: {
							type: "object",
							properties: {
								bearingDeg: { type: "number" },
								maxRangeM: { type: "number" },
								lat: { type: "number" },
								lon: { type: "number" },
								at: { type: "string" },
							},
							required: ["bearingDeg", "maxRangeM", "lat", "lon", "at"],
						},
					},
					maxRangeM: { type: ["number", "null"] },
					accepted: { type: "number" },
				},
				required: ["protocol", "sectors", "maxRangeM", "accepted"],
			},
		},
		rejected: {
			type: "object",
			properties: {
				"invalid-position": { type: "number" },
				"too-far": { type: "number" },
				stale: { type: "number" },
				"no-station": { type: "number" },
			},
			required: ["invalid-position", "too-far", "stale", "no-station"],
		},
		timestamp: { type: "string" },
	},
	required: [
		"available",
		"station",
		"windowHours",
		"bearingStepDeg",
		"protocols",
		"rejected",
		"timestamp",
	],
} as const

const errorSchema = {
	type: "object",
	properties: {
		error: { type: "string" },
		code: { type: "string", const: "VALIDATION_ERROR" },
	},
	required: ["error", "code"],
} as const

export async function coverageRoutes(
	app: FastifyInstance,
	options: CoverageRoutesOptions,
): Promise<void> {
	const { coverage } = options
	app.get<{
		Reply: CoverageResponse | { error: string; code: "VALIDATION_ERROR" }
	}>(
		"/api/coverage",
		{
			schema: {
				description:
					"Maximum received range per 1-degree bearing over the last 24 hours",
				tags: ["coverage"],
				response: { 200: responseSchema, 400: errorSchema },
			},
		},
		async (request, reply) => {
			const parsed = QuerySchema.safeParse(request.query)
			if (!parsed.success) {
				reply.status(400)
				return {
					error: `protocol must be one of: ${COVERAGE_PROTOCOLS.join(", ")}`,
					code: "VALIDATION_ERROR" as const,
				}
			}
			reply.header("Cache-Control", "no-store")
			return coverage.query(
				parsed.data.protocol as (typeof COVERAGE_PROTOCOLS)[number] | undefined,
			)
		},
	)
}
