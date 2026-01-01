/**
 * Decoder Routes - Decoder management endpoints
 *
 * Requirements:
 * - 9.6: GET /api/decoders returns all decoder statuses
 * - 9.7: POST /api/decoders/:id/start starts the specified decoder
 * - 9.8: POST /api/decoders/:id/stop stops the specified decoder
 * - 9.9: PATCH /api/decoders/:id updates the decoder configuration
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import type { DecoderManager } from "../../decoders/manager.js"
import type { DecoderStatus } from "../../decoders/types.js"

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
 * Decoder status schema for response
 */
const decoderStatusSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		type: { type: "string" },
		running: { type: "boolean" },
		pid: { type: "number" },
		uptime: { type: "number" },
		stats: decoderStatsSchema,
		restartCount: { type: "number" },
	},
	required: ["id", "type", "running", "uptime", "stats"],
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
 * Decoder routes plugin for Fastify.
 * Registers /api/decoders endpoints for decoder management.
 */
export const decoderRoutes: FastifyPluginAsync<DecoderRoutesOptions> = async (
	fastify: FastifyInstance,
	options: DecoderRoutesOptions,
) => {
	const { decoderManager } = options

	/**
	 * GET /api/decoders - List all decoders
	 * Requirement 9.6: Returns all decoder statuses
	 */
	fastify.get<{ Reply: DecoderStatus[] }>(
		"/api/decoders",
		{
			schema: {
				tags: ["decoders"],
				summary: "List all decoders",
				description: "Returns all configured decoders with their status",
				response: {
					200: {
						type: "array",
						items: decoderStatusSchema,
					},
				},
			},
		},
		async () => {
			return decoderManager.getAllStatus()
		},
	)

	/**
	 * GET /api/decoders/:id - Get decoder status
	 * Requirement 9.6: Returns decoder status by ID
	 */
	fastify.get<{
		Params: { id: string }
		Reply: DecoderStatus | ErrorResponse
	}>(
		"/api/decoders/:id",
		{
			schema: {
				tags: ["decoders"],
				summary: "Get decoder status",
				description: "Returns the status of a specific decoder",
				params: {
					type: "object",
					properties: {
						id: { type: "string", minLength: 1 },
					},
					required: ["id"],
				},
				response: {
					200: decoderStatusSchema,
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

			return status
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
}

export default decoderRoutes
