/**
 * Decoder Routes - Decoder management endpoints
 *
 * Requirements:
 * - 9.6: GET /api/decoders returns all decoder statuses
 * - 9.7: POST /api/decoders/:id/start starts the specified decoder
 * - 9.8: POST /api/decoders/:id/stop stops the specified decoder
 * - 9.9: PATCH /api/decoders/:id updates the decoder configuration
 * - 17.1: Decoder capabilities declaration (input type, exclusive requirement, preferred sample rates, output format)
 * - 20.1: Report health as "running" when producing output
 * - 20.2: Report health as "idle" when no output for configured timeout
 * - 20.3: Report health as "faulted" when crashed and exceeded restart limits
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import { z } from "zod"
import type { DecoderManager } from "../../decoders/manager.js"
import type { DecoderRegistry } from "../../decoders/registry.js"
import type {
	DecoderCaps as ApiDecoderCaps,
	DecoderInfo as ApiDecoderInfo,
	DecoderRatePreviewItem,
	DecoderStatus as ApiDecoderStatus,
} from "@wavekit/api-types"
import type { DecoderStatus as InternalDecoderStatus } from "../../decoders/types.js"
import {
	decoderRateAssessmentSchema,
	decoderRateRequirementsSchema,
} from "./decoder-rate-schemas.js"
import {
	decoderHealthValues,
	decoderStatusSchema,
} from "./decoder-status-schemas.js"
import {
	toApiDecoderCaps,
	toApiDecoderInfo,
	toApiDecoderStatus,
} from "../serializers/decoder-status.js"

/**
 * Decoder capabilities schema for response (Requirement 17.1)
 */
const decoderCapsSchema = {
	type: "object",
	properties: {
		input: { type: "string", enum: ["audio_pcm", "iq", "external"] },
		wantsExclusiveSource: { type: "boolean" },
		preferredSampleRates: { type: "array", items: { type: "number" } },
		rateRequirements: decoderRateRequirementsSchema,
		output: { type: "string", enum: ["jsonl", "nmea", "beast", "text"] },
		integrationPattern: {
			type: "string",
			enum: ["pure_consumer", "network_producer", "external_sdr"],
		},
	},
	required: ["input", "output", "integrationPattern"],
} as const

/**
 * Extended decoder info schema including capabilities
 */
const decoderInfoSchema = {
	type: "object",
	properties: {
		...decoderStatusSchema.properties,
		caps: decoderCapsSchema,
	},
	required: [...decoderStatusSchema.required],
} as const

/**
 * Error response schema
 */
const errorResponseSchema = {
	type: "object",
	properties: {
		error: { type: "string" },
		code: { type: "string" },
		message: { type: "string" },
	},
	required: ["error", "code", "message"],
} as const

/**
 * Success response schema for start/stop/restart
 */
const decoderActionResponseSchema = {
	type: "object",
	properties: {
		message: { type: "string" },
		decoder: decoderStatusSchema,
	},
	required: ["message", "decoder"],
} as const

/**
 * Optional POST /start body (band defaults spec §1.1). `pin` defaults to
 * true: an operator start is never band-suspended.
 */
const StartBodySchema = z
	.object({ pin: z.boolean().optional() })
	.strict()
	.nullish()

/**
 * Decoder config update schema for PATCH request
 */
const decoderConfigUpdateSchema = {
	type: "object",
	properties: {
		enabled: { type: "boolean" },
		options: { type: "object", additionalProperties: true },
	},
	additionalProperties: false,
} as const

/**
 * Options for the decoder routes plugin
 */
export interface DecoderRoutesOptions {
	decoderManager: DecoderManager
	decoderRegistry?: DecoderRegistry | undefined
}

/**
 * Response types
 */
export interface DecoderActionResponse {
	message: string
	decoder: ApiDecoderStatus
}

export interface ErrorResponse {
	error: string
	code: string
	message: string
}

export interface DecoderConfigUpdate {
	enabled?: boolean
	options?: Record<string, unknown>
}

/**
 * Extended decoder info including capabilities (shared with `decoder:status`).
 */
export type DecoderInfo = ApiDecoderInfo

/**
 * Decoder routes plugin for Fastify.
 * Registers /api/decoders endpoints for decoder management.
 */
export const decoderRoutes: FastifyPluginAsync<DecoderRoutesOptions> = async (
	fastify: FastifyInstance,
	options: DecoderRoutesOptions,
) => {
	const { decoderManager, decoderRegistry } = options

	const enrichWithCaps = (status: InternalDecoderStatus): DecoderInfo =>
		toApiDecoderInfo(status, decoderRegistry)

	/**
	 * GET /api/decoders - List all decoders
	 * Requirement 9.6: Returns all decoder statuses
	 * Requirements 20.1, 20.2, 20.3: Includes health status
	 */
	fastify.get<{ Reply: DecoderInfo[] }>(
		"/api/decoders",
		{
			schema: {
				tags: ["decoders"],
				summary: "List all decoders",
				description:
					"Returns all configured decoders with their status, health, and capabilities",
				response: {
					200: {
						type: "array",
						items: decoderInfoSchema,
					},
				},
			},
		},
		async () => {
			const statuses = decoderManager.getAllStatus()
			return statuses.map(enrichWithCaps)
		},
	)

	/**
	 * GET /api/decoders/rate-preview - Rate plans if a source ran at a rate.
	 * Pure: no tuner write, no caps change (rate model B3).
	 */
	fastify.get<{
		Querystring: { sourceId: string; sampleRateHz: number }
		Reply: DecoderRatePreviewItem[] | ErrorResponse
	}>(
		"/api/decoders/rate-preview",
		{
			schema: {
				tags: ["decoders"],
				summary: "Preview decoder rate plans",
				description:
					"Returns each decoder's rate assessment for the source as if it ran at sampleRateHz, without changing anything",
				querystring: {
					type: "object",
					properties: {
						sourceId: { type: "string", minLength: 1 },
						sampleRateHz: { type: "integer", exclusiveMinimum: 0 },
					},
					required: ["sourceId", "sampleRateHz"],
					additionalProperties: false,
				},
				response: {
					200: {
						type: "array",
						items: {
							type: "object",
							properties: {
								decoderId: { type: "string" },
								assessment: decoderRateAssessmentSchema,
							},
							required: ["decoderId", "assessment"],
						},
					},
					400: errorResponseSchema,
					404: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const { sourceId, sampleRateHz } = request.query
			const preview = decoderManager.previewRates(sourceId, sampleRateHz)
			if (preview.ok) return preview.items
			if (preview.reason === "source-not-found")
				return reply.status(404).send({
					error: "NotFound",
					code: "SOURCE_NOT_FOUND",
					message: `Source with id '${sourceId}' not found`,
				})
			return reply.status(400).send({
				error: "BadRequest",
				code: "VALIDATION_ERROR",
				message: `Sample rate ${sampleRateHz} Hz is not supported by RTL-SDR (expected 225001-300000 or 900001-3200000)`,
			})
		},
	)

	/**
	 * GET /api/decoders/:id - Get decoder status
	 * Requirement 9.6: Returns decoder status by ID
	 * Requirements 20.1, 20.2, 20.3: Includes health status
	 */
	fastify.get<{
		Params: { id: string }
		Reply: DecoderInfo | ErrorResponse
	}>(
		"/api/decoders/:id",
		{
			schema: {
				tags: ["decoders"],
				summary: "Get decoder status",
				description:
					"Returns the status, health, and capabilities of a specific decoder",
				params: {
					type: "object",
					properties: {
						id: { type: "string", minLength: 1 },
					},
					required: ["id"],
				},
				response: {
					200: decoderInfoSchema,
					404: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const { id } = request.params

			const status = decoderManager.getStatus(id)
			if (!status) {
				return reply.status(404).send({
					error: "NotFound",
					code: "DECODER_NOT_FOUND",
					message: `Decoder with id '${id}' not found`,
				})
			}

			return enrichWithCaps(status)
		},
	)

	/**
	 * POST /api/decoders/:id/start - Start decoder
	 * Requirement 9.7: Starts the specified decoder
	 */
	fastify.post<{
		Params: { id: string }
		Body: unknown
		Reply: DecoderActionResponse | ErrorResponse
	}>(
		"/api/decoders/:id/start",
		{
			schema: {
				tags: ["decoders"],
				summary: "Start decoder",
				description:
					"Starts the specified decoder. Optional body { pin?: boolean } (default true): a pinned (operator) decoder is never band-suspended; on a running decoder a body changes the start mode.",
				params: {
					type: "object",
					properties: {
						id: { type: "string", minLength: 1 },
					},
					required: ["id"],
				},
				response: {
					200: decoderActionResponseSchema,
					400: errorResponseSchema,
					404: errorResponseSchema,
					409: errorResponseSchema,
					500: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const { id } = request.params

			// Check if decoder exists
			const decoder = decoderManager.getDecoder(id)
			if (!decoder) {
				return reply.status(404).send({
					error: "NotFound",
					code: "DECODER_NOT_FOUND",
					message: `Decoder with id '${id}' not found`,
				})
			}

			const body = StartBodySchema.safeParse(request.body)
			if (!body.success) {
				return reply.status(400).send({
					error: "BadRequest",
					code: "INVALID_START_REQUEST",
					message: body.error.issues
						.map(issue => `${issue.path.join(".") || "body"}: ${issue.message}`)
						.join("; "),
				})
			}
			const startMode = (body.data?.pin ?? true) ? "operator" : "auto"

			// A bare start on a running decoder is a conflict; a body is an
			// explicit start-mode change (pin / return to auto).
			const currentStatus = decoder.getStatus()
			if (currentStatus.running) {
				if (body.data === undefined || body.data === null) {
					return reply.status(409).send({
						error: "Conflict",
						code: "DECODER_ALREADY_RUNNING",
						message: `Decoder '${id}' is already running`,
					})
				}
				decoderManager.setStartMode(id, startMode)
				const status = decoderManager.getStatus(id)
				if (!status) {
					return reply.status(500).send({
						error: "InternalServerError",
						code: "DECODER_STATUS_ERROR",
						message:
							"Decoder start mode was set but status could not be retrieved",
					})
				}
				return {
					message: `Decoder '${id}' is running; start mode set to '${startMode}'`,
					decoder: toApiDecoderStatus(status),
				}
			}

			try {
				await decoderManager.startDecoder(id, { startMode })

				const status = decoderManager.getStatus(id)
				if (!status) {
					return reply.status(500).send({
						error: "InternalServerError",
						code: "DECODER_STATUS_ERROR",
						message: "Decoder was started but status could not be retrieved",
					})
				}

				return {
					message: status.suspended
						? `Decoder '${id}' start recorded; suspended until the source rate and band are usable`
						: `Decoder '${id}' started successfully`,
					decoder: toApiDecoderStatus(status),
				}
			} catch (err) {
				const error = err as Error
				return reply.status(500).send({
					error: "InternalServerError",
					code: "DECODER_START_ERROR",
					message: error.message,
				})
			}
		},
	)

	/**
	 * POST /api/decoders/:id/stop - Stop decoder
	 * Requirement 9.8: Stops the specified decoder
	 */
	fastify.post<{
		Params: { id: string }
		Reply: DecoderActionResponse | ErrorResponse
	}>(
		"/api/decoders/:id/stop",
		{
			schema: {
				tags: ["decoders"],
				summary: "Stop decoder",
				description: "Stops the specified decoder",
				params: {
					type: "object",
					properties: {
						id: { type: "string", minLength: 1 },
					},
					required: ["id"],
				},
				response: {
					200: decoderActionResponseSchema,
					404: errorResponseSchema,
					409: errorResponseSchema,
					500: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const { id } = request.params

			// Check if decoder exists
			const decoder = decoderManager.getDecoder(id)
			if (!decoder) {
				return reply.status(404).send({
					error: "NotFound",
					code: "DECODER_NOT_FOUND",
					message: `Decoder with id '${id}' not found`,
				})
			}

			// Check if already stopped; a suspended decoder (or one waiting in
			// restart backoff) is not running but can still be stopped.
			const currentStatus = decoder.getStatus()
			if (
				!currentStatus.running &&
				!decoderManager.getStatus(id)?.desiredRunning
			) {
				return reply.status(409).send({
					error: "Conflict",
					code: "DECODER_NOT_RUNNING",
					message: `Decoder '${id}' is not running`,
				})
			}

			try {
				await decoderManager.stopDecoder(id)

				const status = decoderManager.getStatus(id)
				if (!status) {
					return reply.status(500).send({
						error: "InternalServerError",
						code: "DECODER_STATUS_ERROR",
						message: "Decoder was stopped but status could not be retrieved",
					})
				}

				return {
					message: `Decoder '${id}' stopped successfully`,
					decoder: toApiDecoderStatus(status),
				}
			} catch (err) {
				const error = err as Error
				return reply.status(500).send({
					error: "InternalServerError",
					code: "DECODER_STOP_ERROR",
					message: error.message,
				})
			}
		},
	)

	/**
	 * POST /api/decoders/:id/restart - Restart decoder
	 * Requirement 9.8: Restarts the specified decoder
	 */
	fastify.post<{
		Params: { id: string }
		Reply: DecoderActionResponse | ErrorResponse
	}>(
		"/api/decoders/:id/restart",
		{
			schema: {
				tags: ["decoders"],
				summary: "Restart decoder",
				description: "Restarts the specified decoder",
				params: {
					type: "object",
					properties: {
						id: { type: "string", minLength: 1 },
					},
					required: ["id"],
				},
				response: {
					200: decoderActionResponseSchema,
					404: errorResponseSchema,
					500: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const { id } = request.params

			// Check if decoder exists
			const decoder = decoderManager.getDecoder(id)
			if (!decoder) {
				return reply.status(404).send({
					error: "NotFound",
					code: "DECODER_NOT_FOUND",
					message: `Decoder with id '${id}' not found`,
				})
			}

			try {
				await decoderManager.restartDecoder(id)

				const status = decoderManager.getStatus(id)
				if (!status) {
					return reply.status(500).send({
						error: "InternalServerError",
						code: "DECODER_STATUS_ERROR",
						message: "Decoder was restarted but status could not be retrieved",
					})
				}

				return {
					message: status.suspended
						? `Decoder '${id}' restart recorded; suspended until the source rate is usable`
						: `Decoder '${id}' restarted successfully`,
					decoder: toApiDecoderStatus(status),
				}
			} catch (err) {
				const error = err as Error
				return reply.status(500).send({
					error: "InternalServerError",
					code: "DECODER_RESTART_ERROR",
					message: error.message,
				})
			}
		},
	)

	/**
	 * PATCH /api/decoders/:id - Update decoder configuration
	 * Requirement 9.9: Updates the decoder configuration
	 */
	fastify.patch<{
		Params: { id: string }
		Body: DecoderConfigUpdate
		Reply: DecoderActionResponse | ErrorResponse
	}>(
		"/api/decoders/:id",
		{
			schema: {
				tags: ["decoders"],
				summary: "Update decoder configuration",
				description: "Updates the configuration of a specific decoder",
				params: {
					type: "object",
					properties: {
						id: { type: "string", minLength: 1 },
					},
					required: ["id"],
				},
				body: decoderConfigUpdateSchema,
				response: {
					501: errorResponseSchema,
					404: errorResponseSchema,
					400: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const { id } = request.params
			const updates = request.body

			// Check if decoder exists
			const decoder = decoderManager.getDecoder(id)
			if (!decoder) {
				return reply.status(404).send({
					error: "NotFound",
					code: "DECODER_NOT_FOUND",
					message: `Decoder with id '${id}' not found`,
				})
			}

			// Validate that at least one field is being updated
			if (updates.enabled === undefined && updates.options === undefined) {
				return reply.status(400).send({
					error: "BadRequest",
					code: "NO_UPDATE_FIELDS",
					message: "At least one field (enabled or options) must be provided",
				})
			}

			return reply.status(501).send({
				error: "NotImplemented",
				code: "DECODER_CONFIG_UPDATE_UNSUPPORTED",
				message:
					"Runtime decoder configuration updates are not implemented. Edit the YAML configuration and restart WaveKit; use the start/stop endpoints for lifecycle control.",
			})
		},
	)

	/**
	 * GET /api/decoders/types - List available decoder types
	 * Requirement 17.1: Returns all registered decoder types with their capabilities
	 */
	fastify.get<{
		Reply: Array<{ type: string; caps: ApiDecoderCaps }> | ErrorResponse
	}>(
		"/api/decoders/types",
		{
			schema: {
				tags: ["decoders"],
				summary: "List available decoder types",
				description:
					"Returns all registered decoder types with their capabilities and integration patterns",
				response: {
					200: {
						type: "array",
						items: {
							type: "object",
							properties: {
								type: { type: "string" },
								caps: decoderCapsSchema,
							},
							required: ["type", "caps"],
						},
					},
					501: errorResponseSchema,
				},
			},
		},
		async (_request, reply) => {
			if (!decoderRegistry) {
				return reply.status(501).send({
					error: "NotImplemented",
					code: "REGISTRY_NOT_AVAILABLE",
					message: "Decoder registry is not available",
				})
			}

			const types = decoderRegistry.getRegisteredTypes()
			return types.map(type => ({
				type,
				caps: toApiDecoderCaps(decoderRegistry.getCaps(type)!),
			}))
		},
	)

	/**
	 * GET /api/decoders/health - Get health status of all decoders
	 * Requirements 20.1, 20.2, 20.3: Returns health status for all decoders
	 */
	fastify.get<{
		Reply: Array<{ id: string; health: string }>
	}>(
		"/api/decoders/health",
		{
			schema: {
				tags: ["decoders"],
				summary: "Get health status of all decoders",
				description:
					"Returns the health status (running, idle, faulted) for all configured decoders",
				response: {
					200: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "string" },
								health: {
									type: "string",
									enum: decoderHealthValues,
								},
							},
							required: ["id", "health"],
						},
					},
				},
			},
		},
		async () => {
			const healthMap = decoderManager.getAllHealth()
			return Array.from(healthMap.entries()).map(([id, health]) => ({
				id,
				health,
			}))
		},
	)
}

export default decoderRoutes
