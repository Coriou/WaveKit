/**
 * Decoder band override routes (band defaults spec §5.2):
 * GET|PUT|DELETE /api/decoders/:id/band. The API layer is persisted by the
 * manager's BandOverrideStore and outranks `decoders[].band` field-wise.
 * PATCH /api/decoders/:id stays 501.
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import type { DecoderBandSettings } from "@wavekit/api-types"
import type { DecoderManager } from "../../decoders/manager.js"
import { DecoderBandOverrideSchema } from "../../config.js"
import { normalizeBandOverride } from "../../decoders/band-defaults.js"
import {
	bandRegionCodes,
	decoderBandAssessmentSchema,
	decoderBandRangeSchema,
	decoderBandRegionSchema,
} from "./decoder-rate-schemas.js"

export interface DecoderBandRoutesOptions {
	decoderManager: DecoderManager
}

interface ErrorResponse {
	error: string
	code: string
	message: string
}

const errorResponseSchema = {
	type: "object",
	properties: {
		error: { type: "string" },
		code: { type: "string" },
		message: { type: "string" },
	},
	required: ["error", "code", "message"],
} as const

const bandOverrideProperties = {
	rangesHz: { type: "array", items: decoderBandRangeSchema },
	targetsHz: {
		type: "array",
		items: { type: "number", exclusiveMinimum: 0 },
	},
	region: { type: "string", enum: bandRegionCodes },
	bandSuspension: { type: "boolean" },
} as const

const nullableBandOverrideSchema = {
	type: "object",
	nullable: true,
	properties: bandOverrideProperties,
} as const

/** DecoderBandSettings; Fastify drops any property not listed here. */
export const decoderBandSettingsSchema = {
	type: "object",
	properties: {
		decoderId: { type: "string" },
		override: nullableBandOverrideSchema,
		configOverride: nullableBandOverrideSchema,
		region: decoderBandRegionSchema,
		persisted: { type: "boolean" },
		bandAssessment: decoderBandAssessmentSchema,
	},
	required: [
		"decoderId",
		"override",
		"configOverride",
		"region",
		"persisted",
		"bandAssessment",
	],
} as const

const paramsSchema = {
	type: "object",
	properties: { id: { type: "string", minLength: 1 } },
	required: ["id"],
} as const

const responses = {
	200: decoderBandSettingsSchema,
	404: errorResponseSchema,
	409: errorResponseSchema,
	500: errorResponseSchema,
} as const

type Lookup =
	| { ok: true }
	| { ok: false; status: 404 | 409; body: ErrorResponse }

function lookup(manager: DecoderManager, id: string): Lookup {
	const decoder = manager.getDecoder(id)
	if (!decoder)
		return {
			ok: false,
			status: 404,
			body: {
				error: "NotFound",
				code: "DECODER_NOT_FOUND",
				message: `Decoder with id '${id}' not found`,
			},
		}
	if (decoder.caps.input === "external")
		return {
			ok: false,
			status: 409,
			body: {
				error: "Conflict",
				code: "DECODER_BAND_NOT_APPLICABLE",
				message: `Decoder '${id}' owns its own device; the band check does not apply`,
			},
		}
	return { ok: true }
}

const notFoundAfterWrite = (id: string): ErrorResponse => ({
	error: "NotFound",
	code: "DECODER_NOT_FOUND",
	message: `Decoder with id '${id}' was removed`,
})

export const decoderBandRoutes: FastifyPluginAsync<
	DecoderBandRoutesOptions
> = async (fastify: FastifyInstance, options: DecoderBandRoutesOptions) => {
	const { decoderManager } = options

	fastify.get<{
		Params: { id: string }
		Reply: DecoderBandSettings | ErrorResponse
	}>(
		"/api/decoders/:id/band",
		{
			schema: {
				tags: ["decoders"],
				summary: "Get decoder band settings",
				description:
					"API and config band overrides, the effective region and the current band assessment",
				params: paramsSchema,
				response: responses,
			},
		},
		async (request, reply) => {
			const { id } = request.params
			const found = lookup(decoderManager, id)
			if (!found.ok) return reply.status(found.status).send(found.body)
			const settings = decoderManager.getBandSettings(id)
			if (!settings) return reply.status(404).send(notFoundAfterWrite(id))
			return settings
		},
	)

	fastify.put<{
		Params: { id: string }
		Body: unknown
		Reply: DecoderBandSettings | ErrorResponse
	}>(
		"/api/decoders/:id/band",
		{
			schema: {
				tags: ["decoders"],
				summary: "Set decoder band override",
				description:
					"Replaces the persisted API band layer: { rangesHz?, targetsHz?, region?, bandSuspension? } (at least one key). Changes band admission only, never the process arguments.",
				params: paramsSchema,
				response: { ...responses, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			const { id } = request.params
			const found = lookup(decoderManager, id)
			if (!found.ok) return reply.status(found.status).send(found.body)
			const parsed = DecoderBandOverrideSchema.safeParse(request.body)
			if (!parsed.success)
				return reply.status(400).send({
					error: "BadRequest",
					code: "INVALID_BAND_OVERRIDE",
					message: parsed.error.issues
						.map(issue => `${issue.path.join(".") || "body"}: ${issue.message}`)
						.join("; "),
				})
			const settings = await decoderManager.setBandOverride(
				id,
				normalizeBandOverride(parsed.data),
			)
			if (!settings) return reply.status(404).send(notFoundAfterWrite(id))
			return settings
		},
	)

	fastify.delete<{
		Params: { id: string }
		Reply: DecoderBandSettings | ErrorResponse
	}>(
		"/api/decoders/:id/band",
		{
			schema: {
				tags: ["decoders"],
				summary: "Remove decoder band override",
				description:
					"Removes the API band layer (idempotent); the config layer and defaults apply again",
				params: paramsSchema,
				response: responses,
			},
		},
		async (request, reply) => {
			const { id } = request.params
			const found = lookup(decoderManager, id)
			if (!found.ok) return reply.status(found.status).send(found.body)
			const settings = await decoderManager.deleteBandOverride(id)
			if (!settings) return reply.status(404).send(notFoundAfterWrite(id))
			return settings
		},
	)
}

export default decoderBandRoutes
