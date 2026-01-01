/**
 * Source Routes - Source management endpoints
 *
 * Requirements:
 * - 9.3: GET /api/sources returns all configured sources
 * - 9.4: POST /api/sources adds and connects a new source
 * - 9.5: DELETE /api/sources/:id disconnects and removes a source
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import type {
	SourceManager,
	SourceConfig,
	SourceStatus,
} from "../../core/source-manager.js"

/**
 * Source capabilities schema for request validation
 */
const sourceCapsSchema = {
	type: "object",
	properties: {
		kind: { type: "string", enum: ["audio_pcm", "iq", "recording"] },
		sampleRate: { type: "integer", minimum: 1 },
		format: { type: "string", enum: ["S16LE", "FLOAT32LE", "U8_IQ", "S16_IQ"] },
		channels: { type: "integer", minimum: 1 },
		centerFreq: { type: "number", minimum: 0 },
		exclusive: { type: "boolean" },
	},
	required: ["kind", "sampleRate", "format", "exclusive"],
} as const

/**
 * Source config schema for request validation
 */
const sourceConfigSchema = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1 },
		type: { type: "string", enum: ["sdrpp-network", "rtl_tcp", "recording"] },
		host: { type: "string", minLength: 1 },
		port: { type: "integer", minimum: 1, maximum: 65535 },
		filePath: { type: "string" },
		loop: { type: "boolean" },
		playbackSpeed: { type: "number", minimum: 0 },
		caps: sourceCapsSchema,
	},
	required: ["id", "type", "caps"],
} as const

/**
 * Source capabilities schema for response
 */
const sourceCapsResponseSchema = {
	type: "object",
	properties: {
		kind: { type: "string" },
		sampleRate: { type: "number" },
		format: { type: "string" },
		channels: { type: "number" },
		centerFreq: { type: "number" },
		exclusive: { type: "boolean" },
	},
	required: ["kind", "sampleRate", "format", "exclusive"],
} as const

/**
 * Source status schema for response
 */
const sourceStatusSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		connected: { type: "boolean" },
		bytesReceived: { type: "number" },
		dataRate: { type: "number" },
		lastError: { type: "string" },
		reconnectAttempts: { type: "number" },
		caps: sourceCapsResponseSchema,
	},
	required: [
		"id",
		"connected",
		"bytesReceived",
		"dataRate",
		"reconnectAttempts",
		"caps",
	],
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
 * Success response schema for POST
 */
const sourceCreatedResponseSchema = {
	type: "object",
	properties: {
		message: { type: "string" },
		source: sourceStatusSchema,
	},
	required: ["message", "source"],
} as const

/**
 * Success response schema for DELETE
 */
const sourceDeletedResponseSchema = {
	type: "object",
	properties: {
		message: { type: "string" },
		id: { type: "string" },
	},
	required: ["message", "id"],
} as const

/**
 * Options for the source routes plugin
 */
export interface SourceRoutesOptions {
	sourceManager: SourceManager
}

/**
 * Response types
 */
export interface SourceCreatedResponse {
	message: string
	source: SourceStatus
}

export interface SourceDeletedResponse {
	message: string
	id: string
}

export interface ErrorResponse {
	error: string
	code: string
	message: string
}

/**
 * Source routes plugin for Fastify.
 * Registers /api/sources endpoints for source management.
 */
export const sourceRoutes: FastifyPluginAsync<SourceRoutesOptions> = async (
	fastify: FastifyInstance,
	options: SourceRoutesOptions,
) => {
	const { sourceManager } = options

	/**
	 * GET /api/sources - List all sources
	 * Requirement 9.3: Returns all configured sources
	 */
	fastify.get<{ Reply: SourceStatus[] }>(
		"/api/sources",
		{
			schema: {
				tags: ["sources"],
				summary: "List all sources",
				description: "Returns all configured SDR sources with their status",
				response: {
					200: {
						type: "array",
						items: sourceStatusSchema,
					},
				},
			},
		},
		async () => {
			return sourceManager.getAllStatus()
		},
	)

	/**
	 * POST /api/sources - Add a new source
	 * Requirement 9.4: Adds and connects a new source
	 */
	fastify.post<{
		Body: SourceConfig
		Reply: SourceCreatedResponse | ErrorResponse
	}>(
		"/api/sources",
		{
			schema: {
				tags: ["sources"],
				summary: "Add a new source",
				description: "Adds and connects a new SDR source",
				body: sourceConfigSchema,
				response: {
					201: sourceCreatedResponseSchema,
					400: errorResponseSchema,
					409: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const config = request.body

			// Check if source already exists
			const existingStatus = sourceManager.getStatus(config.id)
			if (existingStatus) {
				return reply.status(409).send({
					error: "Conflict",
					code: "SOURCE_EXISTS",
					message: `Source with id '${config.id}' already exists`,
				})
			}

			try {
				// Connect to the source
				await sourceManager.connect(config)

				// Get the status of the newly created source
				const status = sourceManager.getStatus(config.id)
				if (!status) {
					return reply.status(500).send({
						error: "InternalServerError",
						code: "SOURCE_STATUS_ERROR",
						message: "Source was created but status could not be retrieved",
					})
				}

				return reply.status(201).send({
					message: `Source '${config.id}' added successfully`,
					source: status,
				})
			} catch (err) {
				const error = err as Error
				return reply.status(400).send({
					error: "BadRequest",
					code: "SOURCE_CONNECTION_ERROR",
					message: error.message,
				})
			}
		},
	)

	/**
	 * DELETE /api/sources/:id - Remove a source
	 * Requirement 9.5: Disconnects and removes a source
	 */
	fastify.delete<{
		Params: { id: string }
		Reply: SourceDeletedResponse | ErrorResponse
	}>(
		"/api/sources/:id",
		{
			schema: {
				tags: ["sources"],
				summary: "Remove a source",
				description: "Disconnects and removes an SDR source",
				params: {
					type: "object",
					properties: {
						id: { type: "string", minLength: 1 },
					},
					required: ["id"],
				},
				response: {
					200: sourceDeletedResponseSchema,
					404: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const { id } = request.params

			// Check if source exists
			const status = sourceManager.getStatus(id)
			if (!status) {
				return reply.status(404).send({
					error: "NotFound",
					code: "SOURCE_NOT_FOUND",
					message: `Source with id '${id}' not found`,
				})
			}

			// Disconnect and remove the source
			await sourceManager.disconnect(id)

			return {
				message: `Source '${id}' removed successfully`,
				id,
			}
		},
	)
}

export default sourceRoutes
