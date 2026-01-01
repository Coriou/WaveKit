/**
 * Health Routes - Health check and system status endpoints
 *
 * Requirements:
 * - 9.1: GET /health returns system health status
 * - 9.2: GET /api/status returns full system status including sources, decoders, and audio output
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import type { SourceManager, SourceStatus } from "../../core/source-manager.js"
import type { DecoderManager } from "../../decoders/manager.js"
import type { DecoderStatus } from "../../decoders/types.js"
import type { AudioOutput } from "../../core/audio-output.js"

// Application start time for uptime calculation
const startTime = Date.now()

// Application version (could be loaded from package.json in production)
const APP_VERSION = "1.0.0"

/**
 * Health response schema
 */
const healthResponseSchema = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["ok"] },
		timestamp: { type: "string", format: "date-time" },
	},
	required: ["status", "timestamp"],
} as const

/**
 * Audio status schema
 */
const audioStatusSchema = {
	type: "object",
	properties: {
		outputPort: { type: "number" },
		clientsConnected: { type: "number" },
		format: { type: "string" },
		sampleRate: { type: "number" },
	},
	required: ["outputPort", "clientsConnected"],
} as const

/**
 * Source status schema
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
	},
	required: [
		"id",
		"connected",
		"bytesReceived",
		"dataRate",
		"reconnectAttempts",
	],
} as const

/**
 * Decoder stats schema
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
 * Decoder status schema
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
	required: ["id", "type", "running", "uptime", "stats", "restartCount"],
} as const

/**
 * System status response schema
 */
const systemStatusResponseSchema = {
	type: "object",
	properties: {
		uptime: { type: "number", description: "System uptime in seconds" },
		version: { type: "string", description: "Application version" },
		sources: {
			type: "array",
			items: sourceStatusSchema,
		},
		decoders: {
			type: "array",
			items: decoderStatusSchema,
		},
		audio: audioStatusSchema,
	},
	required: ["uptime", "version", "sources", "decoders", "audio"],
} as const

/**
 * System status response interface
 */
export interface SystemStatusResponse {
	uptime: number
	version: string
	sources: SourceStatus[]
	decoders: DecoderStatus[]
	audio: {
		outputPort: number
		clientsConnected: number
		format?: string
		sampleRate?: number
	}
}

/**
 * Health response interface
 */
export interface HealthResponse {
	status: "ok"
	timestamp: string
}

/**
 * Audio config interface
 */
export interface AudioConfig {
	format: string
	sampleRate: number
}

/**
 * Options for the health routes plugin
 */
export interface HealthRoutesOptions {
	sourceManager: SourceManager
	decoderManager: DecoderManager
	audioOutput: AudioOutput
	audioConfig?: AudioConfig | undefined
}

/**
 * Health routes plugin for Fastify.
 * Registers /health and /api/status endpoints.
 */
export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (
	fastify: FastifyInstance,
	options: HealthRoutesOptions,
) => {
	const { sourceManager, decoderManager, audioOutput, audioConfig } = options

	/**
	 * GET /health - Basic health check
	 * Requirement 9.1: Returns system health status
	 */
	fastify.get<{ Reply: HealthResponse }>(
		"/health",
		{
			schema: {
				tags: ["health"],
				summary: "Health check",
				description: "Returns basic health status of the API server",
				response: {
					200: healthResponseSchema,
				},
			},
		},
		async () => {
			return {
				status: "ok" as const,
				timestamp: new Date().toISOString(),
			}
		},
	)

	/**
	 * GET /api/status - Full system status
	 * Requirement 9.2: Returns full system status including sources, decoders, and audio output
	 */
	fastify.get<{ Reply: SystemStatusResponse }>(
		"/api/status",
		{
			schema: {
				tags: ["health"],
				summary: "System status",
				description:
					"Returns full system status including sources, decoders, and audio output",
				response: {
					200: systemStatusResponseSchema,
				},
			},
		},
		async () => {
			// Calculate uptime in seconds
			const uptime = Math.floor((Date.now() - startTime) / 1000)

			// Get all source statuses
			const sources = sourceManager.getAllStatus()

			// Get all decoder statuses
			const decoders = decoderManager.getAllStatus()

			// Get audio output status
			const audio: SystemStatusResponse["audio"] = {
				outputPort: audioOutput.getPort(),
				clientsConnected: audioOutput.getConnectedClients(),
			}

			// Add format and sampleRate if audioConfig is provided
			if (audioConfig) {
				audio.format = audioConfig.format
				audio.sampleRate = audioConfig.sampleRate
			}

			return {
				uptime,
				version: APP_VERSION,
				sources,
				decoders,
				audio,
			}
		},
	)
}

export default healthRoutes
