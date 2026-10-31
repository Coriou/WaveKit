import { z } from "zod"
import { COVERAGE_PROTOCOLS } from "@wavekit/api-types"
import type { FastifyInstance } from "fastify"
import type { CoverageResponse } from "@wavekit/api-types"
import type { CoverageManager } from "../../core/coverage/coverage-manager.js"
import {
	validationFieldsSchema,
	zodValidationFields,
	validationMessage,
	type ValidationField,
} from "../validation-errors.js"

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
		message: { type: "string" },
		fields: validationFieldsSchema,
	},
	required: ["error", "code"],
} as const

interface CoverageValidationError {
	error: string
	code: "VALIDATION_ERROR"
	message: string
	fields: ValidationField[]
}

export async function coverageRoutes(
	app: FastifyInstance,
	options: CoverageRoutesOptions,
): Promise<void> {
	const { coverage } = options
	app.get<{
		Reply: CoverageResponse | CoverageValidationError
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
				const fields = zodValidationFields(parsed.error, QuerySchema, {
					part: "query",
				})
				return {
					error: `protocol must be one of: ${COVERAGE_PROTOCOLS.join(", ")}`,
					code: "VALIDATION_ERROR" as const,
					message: validationMessage("query", fields),
					fields,
				}
			}
			reply.header("Cache-Control", "no-store")
			return coverage.query(
				parsed.data.protocol as (typeof COVERAGE_PROTOCOLS)[number] | undefined,
			)
		},
	)
}
