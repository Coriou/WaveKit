/**
 * Source Routes - Source management endpoints
 *
 * Requirements:
 * - 9.3: GET /api/sources returns all configured sources
 * - 9.4: POST /api/sources adds and connects a new source
 * - 9.5: DELETE /api/sources/:id disconnects and removes a source
 * - 15.2: Assign decoders to specific sources by source ID
 * - 15.4: Return capabilities for each source
 * - 16.2: Verify capability compatibility before attachment
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import type {
	SourceManager,
	SourceConfig,
	SourceStatus,
	DecoderCaps,
} from "../../core/source-manager.js"
import type { FanoutManager } from "../../core/fanout-manager.js"

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
 * Decoder assignment schema for response
 */
const decoderAssignmentSchema = {
	type: "object",
	properties: {
		decoderId: { type: "string" },
		sourceId: { type: "string" },
		assignedAt: { type: "string", format: "date-time" },
	},
	required: ["decoderId", "sourceId", "assignedAt"],
} as const

/**
 * Extended source status schema with assignments
 */
const extendedSourceStatusSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		type: { type: "string" },
		url: { type: "string" },
		connected: { type: "boolean" },
		consumers: { type: "number" },
		bytesReceived: { type: "number" },
		dataRate: { type: "number" },
		lastError: { type: "string" },
		reconnectAttempts: { type: "number" },
		caps: sourceCapsResponseSchema,
		assignments: {
			type: "array",
			items: decoderAssignmentSchema,
		},
		available: { type: "boolean" },
	},
	required: [
		"id",
		"connected",
		"consumers",
		"bytesReceived",
		"dataRate",
		"reconnectAttempts",
		"caps",
		"assignments",
		"available",
	],
} as const

/**
 * Source status schema for response (basic, without assignments)
 */
const sourceStatusSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		type: { type: "string" },
		url: { type: "string" },
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
 * Decoder capabilities schema for assignment request
 */
const decoderCapsSchema = {
	type: "object",
	properties: {
		input: { type: "string", enum: ["audio_pcm", "iq", "external"] },
		wantsExclusiveSource: { type: "boolean" },
		preferredSampleRates: {
			type: "array",
			items: { type: "integer", minimum: 1 },
		},
	},
	required: ["input"],
} as const

/**
 * Assignment request schema
 */
const assignmentRequestSchema = {
	type: "object",
	properties: {
		decoderId: { type: "string", minLength: 1 },
		decoderCaps: decoderCapsSchema,
	},
	required: ["decoderId", "decoderCaps"],
} as const

/**
 * Assignment response schema
 */
const assignmentResponseSchema = {
	type: "object",
	properties: {
		message: { type: "string" },
		assignment: decoderAssignmentSchema,
	},
	required: ["message", "assignment"],
} as const

/**
 * Unassignment response schema
 */
const unassignmentResponseSchema = {
	type: "object",
	properties: {
		message: { type: "string" },
		decoderId: { type: "string" },
	},
	required: ["message", "decoderId"],
} as const

/**
 * Options for the source routes plugin
 */
export interface SourceRoutesOptions {
	sourceManager: SourceManager
	fanoutManager?: FanoutManager
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
 * Decoder assignment info
 */
export interface DecoderAssignment {
	decoderId: string
	sourceId: string
	assignedAt: Date
}

/**
 * Extended source status with assignments
 */
export interface ExtendedSourceStatus extends SourceStatus {
	assignments: DecoderAssignment[]
	/** Number of active fanout consumer branches for this source */
	consumers: number
	available: boolean
}

/**
 * Assignment request body
 */
export interface AssignmentRequest {
	decoderId: string
	decoderCaps: DecoderCaps
}

/**
 * Assignment response
 */
export interface AssignmentResponse {
	message: string
	assignment: DecoderAssignment
}

/**
 * Unassignment response
 */
export interface UnassignmentResponse {
	message: string
	decoderId: string
}

/**
 * Source routes plugin for Fastify.
 * Registers /api/sources endpoints for source management.
 */
export const sourceRoutes: FastifyPluginAsync<SourceRoutesOptions> = async (
	fastify: FastifyInstance,
	options: SourceRoutesOptions,
) => {
	const { sourceManager, fanoutManager } = options

	/**
	 * GET /api/sources - List all sources
	 * Requirement 9.3: Returns all configured sources
	 * Requirement 15.4: Returns capabilities for each source
	 * Includes decoder assignments and availability status
	 */
	fastify.get<{ Reply: ExtendedSourceStatus[] }>(
		"/api/sources",
		{
			schema: {
				tags: ["sources"],
				summary: "List all sources",
				description:
					"Returns all configured SDR sources with their status, capabilities, and decoder assignments",
				response: {
					200: {
						type: "array",
						items: extendedSourceStatusSchema,
					},
				},
			},
		},
		async () => {
			const consumersBySourceId = new Map<string, number>()
			if (fanoutManager) {
				const snapshot = fanoutManager.getTelemetrySnapshot()
				for (const branch of snapshot.branches) {
					if (!branch.sourceId) continue
					consumersBySourceId.set(
						branch.sourceId,
						(consumersBySourceId.get(branch.sourceId) ?? 0) + 1,
					)
				}
			}

			const statuses = sourceManager.getAllStatus()
			return statuses.map(status => {
				const assignments = sourceManager.getSourceAssignments(status.id)
				return {
					...status,
					assignments,
					consumers: consumersBySourceId.get(status.id) ?? assignments.length,
					available: sourceManager.isSourceAvailable(status.id),
				}
			})
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

	/**
	 * GET /api/sources/:id/assignments - Get decoder assignments for a source
	 * Requirement 15.2: Support source-decoder assignment in API
	 */
	fastify.get<{
		Params: { id: string }
		Reply: DecoderAssignment[] | ErrorResponse
	}>(
		"/api/sources/:id/assignments",
		{
			schema: {
				tags: ["sources"],
				summary: "Get decoder assignments for a source",
				description:
					"Returns all decoders currently assigned to the specified source",
				params: {
					type: "object",
					properties: {
						id: { type: "string", minLength: 1 },
					},
					required: ["id"],
				},
				response: {
					200: {
						type: "array",
						items: decoderAssignmentSchema,
					},
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

			return sourceManager.getSourceAssignments(id)
		},
	)

	/**
	 * POST /api/sources/:id/assignments - Assign a decoder to a source
	 * Requirement 15.2: Assign decoders to specific sources by source ID
	 * Requirement 16.2: Verify capability compatibility before attachment
	 */
	fastify.post<{
		Params: { id: string }
		Body: AssignmentRequest
		Reply: AssignmentResponse | ErrorResponse
	}>(
		"/api/sources/:id/assignments",
		{
			schema: {
				tags: ["sources"],
				summary: "Assign a decoder to a source",
				description:
					"Assigns a decoder to the specified source after validating capability compatibility",
				params: {
					type: "object",
					properties: {
						id: { type: "string", minLength: 1 },
					},
					required: ["id"],
				},
				body: assignmentRequestSchema,
				response: {
					201: assignmentResponseSchema,
					400: errorResponseSchema,
					404: errorResponseSchema,
					409: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const { id: sourceId } = request.params
			const { decoderId, decoderCaps } = request.body

			// Check if source exists
			const status = sourceManager.getStatus(sourceId)
			if (!status) {
				return reply.status(404).send({
					error: "NotFound",
					code: "SOURCE_NOT_FOUND",
					message: `Source with id '${sourceId}' not found`,
				})
			}

			try {
				// Attempt to assign the decoder to the source
				sourceManager.assignDecoder(decoderId, sourceId, decoderCaps)

				// Get the assignment details
				const assignments = sourceManager.getSourceAssignments(sourceId)
				const assignment = assignments.find(a => a.decoderId === decoderId)

				if (!assignment) {
					return reply.status(500).send({
						error: "InternalServerError",
						code: "ASSIGNMENT_ERROR",
						message: "Assignment was created but could not be retrieved",
					})
				}

				return reply.status(201).send({
					message: `Decoder '${decoderId}' assigned to source '${sourceId}' successfully`,
					assignment,
				})
			} catch (err) {
				const error = err as Error

				// Check for specific error types
				if (error.name === "SourceCompatibilityError") {
					return reply.status(400).send({
						error: "BadRequest",
						code: "INCOMPATIBLE_SOURCE",
						message: error.message,
					})
				}

				if (error.name === "ExclusiveSourceError") {
					return reply.status(409).send({
						error: "Conflict",
						code: "EXCLUSIVE_SOURCE_CONFLICT",
						message: error.message,
					})
				}

				return reply.status(400).send({
					error: "BadRequest",
					code: "ASSIGNMENT_ERROR",
					message: error.message,
				})
			}
		},
	)

	/**
	 * DELETE /api/sources/:id/assignments/:decoderId - Unassign a decoder from a source
	 * Requirement 15.2: Support source-decoder assignment in API
	 */
	fastify.delete<{
		Params: { id: string; decoderId: string }
		Reply: UnassignmentResponse | ErrorResponse
	}>(
		"/api/sources/:id/assignments/:decoderId",
		{
			schema: {
				tags: ["sources"],
				summary: "Unassign a decoder from a source",
				description:
					"Removes the assignment of a decoder from the specified source",
				params: {
					type: "object",
					properties: {
						id: { type: "string", minLength: 1 },
						decoderId: { type: "string", minLength: 1 },
					},
					required: ["id", "decoderId"],
				},
				response: {
					200: unassignmentResponseSchema,
					404: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const { id: sourceId, decoderId } = request.params

			// Check if source exists
			const status = sourceManager.getStatus(sourceId)
			if (!status) {
				return reply.status(404).send({
					error: "NotFound",
					code: "SOURCE_NOT_FOUND",
					message: `Source with id '${sourceId}' not found`,
				})
			}

			// Check if the decoder is assigned to this source
			const assignedSource = sourceManager.getAssignedSource(decoderId)
			if (assignedSource !== sourceId) {
				return reply.status(404).send({
					error: "NotFound",
					code: "ASSIGNMENT_NOT_FOUND",
					message: `Decoder '${decoderId}' is not assigned to source '${sourceId}'`,
				})
			}

			// Unassign the decoder
			sourceManager.unassignDecoder(decoderId)

			return {
				message: `Decoder '${decoderId}' unassigned from source '${sourceId}' successfully`,
				decoderId,
			}
		},
	)
}

export default sourceRoutes
