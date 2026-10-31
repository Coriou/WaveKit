/** Core spectrum API: engines, active profiles and limits, and the occupancy history. */
import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import type { SpectrumService } from "../../core/spectrum/spectrum-service.js"
import { errorResponseSchema, looseObjectSchema } from "./scanner-schemas.js"

export type SpectrumRouteService = Pick<
	SpectrumService,
	"status" | "occupancyQuery"
>

export interface SpectrumRoutesOptions {
	spectrum: SpectrumRouteService
}

const DEFAULT_SINCE_MS = 24 * 3_600_000
const MAX_SINCE_MS = 168 * 3_600_000
const MAX_SPAN_HZ = 2_000_000_000

const occupancyQuerySchema = {
	type: "object",
	properties: {
		sourceId: { type: "string", minLength: 1 },
		startHz: { type: "number", minimum: 0 },
		endHz: { type: "number", minimum: 0 },
		sinceMs: { type: "integer", minimum: 1, maximum: MAX_SINCE_MS },
	},
	required: ["sourceId", "startHz", "endHz"],
	additionalProperties: false,
} as const

export const spectrumRoutes: FastifyPluginAsync<SpectrumRoutesOptions> = async (
	fastify: FastifyInstance,
	options: SpectrumRoutesOptions,
) => {
	const { spectrum } = options
	const tags = ["spectrum"]

	fastify.get(
		"/api/spectrum",
		{
			schema: {
				tags,
				summary:
					"Default profile, active profiles, limits and the engine per source",
				response: { 200: looseObjectSchema },
			},
		},
		async () => spectrum.status(),
	)

	fastify.get<{
		Querystring: {
			sourceId: string
			startHz: number
			endHz: number
			sinceMs?: number
		}
	}>(
		"/api/spectrum/occupancy",
		{
			schema: {
				tags,
				summary: "Hourly duty per frequency bucket (last 7 days)",
				querystring: occupancyQuerySchema,
				response: { 400: errorResponseSchema, 404: errorResponseSchema },
			},
		},
		async (request, reply) => {
			const { sourceId, startHz, endHz, sinceMs } = request.query
			if (!(endHz > startHz) || endHz - startHz > MAX_SPAN_HZ) {
				return reply.code(400).send({
					error: "BadRequest",
					code: "SPECTRUM_RANGE_INVALID",
					message: "endHz must exceed startHz by at most 2 GHz",
					fields: [
						{
							field: "endHz",
							expected:
								"integer Hz greater than startHz, at most 2000000000 Hz above it",
						},
					],
				})
			}
			const result = spectrum.occupancyQuery(
				sourceId,
				{ startHz, endHz },
				sinceMs ?? DEFAULT_SINCE_MS,
			)
			if (!result) {
				return reply.code(404).send({
					error: "NotFound",
					code: "SPECTRUM_SOURCE_NOT_FOUND",
					message: `No spectrum history for source ${sourceId}`,
				})
			}
			return result
		},
	)
}
