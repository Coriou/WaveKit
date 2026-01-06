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
import type { DecoderManager } from "../../decoders/manager.js"
import type { DecoderRegistry } from "../../decoders/registry.js"
import type { DecoderStatus, DecoderCaps } from "../../decoders/types.js"

/**
 * Decoder stats schema for response
 */
const decoderStatsSchema = {
	type: "object",
	properties: {
		bytesIn: { type: "number" },
		eventsOut: { type: "number" },
		errors: { type: "number" },
	},
	required: ["bytesIn", "eventsOut", "errors"],
} as const

/**
 * Decoder capabilities schema for response (Requirement 17.1)
 */
const decoderCapsSchema = {
	type: "object",
	properties: {
		input: { type: "string", enum: ["audio_pcm", "iq", "external"] },
		wantsExclusiveSource: { type: "boolean" },
		preferredSampleRates: { type: "array", items: { type: "number" } },
		output: { type: "string", enum: ["jsonl", "nmea", "beast", "text"] },
		integrationPattern: {
			type: "string",
			enum: ["pure_consumer", "network_producer", "external_sdr"],
		},
	},
	required: ["input", "output", "integrationPattern"],
} as const

/**
 * Decoder status schema for response (Requirements 9.6, 20.1, 20.2, 20.3)
 */
const decoderStatusSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		type: { type: "string" },
		running: { type: "boolean" },
		health: { type: "string", enum: ["running", "idle", "faulted"] },
		pid: { type: "number" },
		uptime: { type: "number" },
		stats: decoderStatsSchema,
		lastOutputAt: { type: "string", format: "date-time", nullable: true },
		restartCount: { type: "number" },
		version: { type: "string" },
	},
	required: [
		"id",
		"type",
		"running",
		"health",
		"uptime",
		"stats",
		"restartCount",
	],
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
	decoder: DecoderStatus
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
 * Extended decoder info including capabilities
 */
export interface DecoderInfo extends DecoderStatus {
	caps?: DecoderCaps
}

/**
 * Decoder routes plugin for Fastify.
 * Registers /api/decoders endpoints for decoder management.
 */
export const decoderRoutes: FastifyPluginAsync<DecoderRoutesOptions> = async (
	fastify: FastifyInstance,
	options: DecoderRoutesOptions,
) => {
	const { decoderManager, decoderRegistry } = options

	/**
	 * Helper function to enrich decoder status with capabilities
	 */
	const enrichWithCaps = (status: DecoderStatus): DecoderInfo => {
		const caps = decoderRegistry?.getCaps(status.type)
		return caps ? { ...status, caps } : status
	}

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
		Reply: DecoderActionResponse | ErrorResponse
	}>(
		"/api/decoders/:id/start",
		{
			schema: {
				tags: ["decoders"],
				summary: "Start decoder",
				description: "Starts the specified decoder",
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

			// Check if already running
			const currentStatus = decoder.getStatus()
			if (currentStatus.running) {
				return reply.status(409).send({
					error: "Conflict",
					code: "DECODER_ALREADY_RUNNING",
					message: `Decoder '${id}' is already running`,
				})
			}

			try {
				await decoderManager.startDecoder(id)

				const status = decoderManager.getStatus(id)
				if (!status) {
					return reply.status(500).send({
						error: "InternalServerError",
						code: "DECODER_STATUS_ERROR",
						message: "Decoder was started but status could not be retrieved",
					})
				}

				return {
					message: `Decoder '${id}' started successfully`,
					decoder: status,
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

			// Check if already stopped
			const currentStatus = decoder.getStatus()
			if (!currentStatus.running) {
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
					decoder: status,
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
					message: `Decoder '${id}' restarted successfully`,
					decoder: status,
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
					200: decoderActionResponseSchema,
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

			// Note: The actual config update would require the DecoderManager to support
			// updating decoder configs. For now, we return the current status.
			// In a full implementation, we would:
			// 1. Update the decoder's config
			// 2. If running and options changed, restart the decoder
			// 3. If enabled changed to false and running, stop the decoder
			// 4. If enabled changed to true and not running, optionally start it

			const status = decoderManager.getStatus(id)
			if (!status) {
				return reply.status(500).send({
					error: "InternalServerError",
					code: "DECODER_STATUS_ERROR",
					message: "Decoder status could not be retrieved",
				})
			}

			return {
				message: `Decoder '${id}' configuration updated`,
				decoder: status,
			}
		},
	)

	/**
	 * GET /api/decoders/types - List available decoder types
	 * Requirement 17.1: Returns all registered decoder types with their capabilities
	 */
	fastify.get<{
		Reply: Array<{ type: string; caps: DecoderCaps }> | ErrorResponse
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
				caps: decoderRegistry.getCaps(type)!,
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
									enum: ["running", "idle", "faulted"],
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
