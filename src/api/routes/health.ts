/**
 * Health Routes - Health check and system status endpoints
 *
 * Requirements:
 * - 4.1: GET /health returns quick liveness status (200 OK or 503)
 * - 4.5: GET /health/ready returns readiness probe
 * - 9.1: GET /health returns system health status
 * - 9.2: GET /api/status returns full system status including sources, decoders, and audio output
 * - 10.4: Distinguish between healthy, degraded, and unhealthy states
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import type { SourceManager, SourceStatus } from "../../core/source-manager.js"
import type { DecoderManager } from "../../decoders/manager.js"
import type { DecoderStatus } from "../../decoders/types.js"
import type { AudioOutput } from "../../core/audio-output.js"
import type { TunerRelay, TunerRelayStatus } from "../../core/tuner-relay.js"
import {
	performHealthCheck,
	isReady,
	getUptime,
	type HealthStatus,
	type HealthStatusLevel,
	type ComponentHealth,
} from "../../utils/health-check.js"

// Application version (could be loaded from package.json in production)
const APP_VERSION = "1.0.0"

// ============================================================================
// Schema Definitions
// ============================================================================

/**
 * Liveness health response schema
 */
const livenessResponseSchema = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["ok"] },
		timestamp: { type: "string", format: "date-time" },
	},
	required: ["status", "timestamp"],
} as const

/**
 * Component health schema
 */
const componentHealthSchema = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["up", "down", "degraded"] },
		message: { type: "string" },
		lastCheck: { type: "string", format: "date-time" },
		metrics: {
			type: "object",
			additionalProperties: { type: "number" },
		},
	},
	required: ["status", "lastCheck"],
} as const

/**
 * Full health status response schema
 */
const healthStatusResponseSchema = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["healthy", "degraded", "unhealthy"] },
		timestamp: { type: "string", format: "date-time" },
		uptime: { type: "number" },
		components: {
			type: "object",
			properties: {
				api: componentHealthSchema,
				sdrpp: componentHealthSchema,
				decoders: {
					type: "object",
					additionalProperties: componentHealthSchema,
				},
				source: componentHealthSchema,
			},
			required: ["api", "decoders", "source"],
		},
	},
	required: ["status", "timestamp", "uptime", "components"],
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
 * Tuner relay status schema
 */
const tunerRelayStatusSchema = {
	type: "object",
	properties: {
		enabled: { type: "boolean" },
		listening: { type: "boolean" },
		host: { type: "string" },
		port: { type: "number" },
		sourceId: { type: "string" },
		sourceConnected: { type: "boolean" },
		sourceKind: { type: "string" },
		sourceFormat: { type: "string" },
		compatibility: {
			type: "string",
			enum: ["ok", "missing-source", "unsupported-kind", "unsupported-format"],
		},
		compatibilityMessage: { type: "string" },
		clientsConnected: { type: "number" },
		controlClientId: { type: "string" },
		controlClientRemote: { type: "string" },
		controlPolicy: { type: "string", enum: ["exclusive", "shared"] },
		maxClients: { type: "number" },
		bytesSent: { type: "number" },
		bytesReceived: { type: "number" },
		lastCommand: { type: "string" },
		lastCommandAt: { type: "string", format: "date-time" },
		lastCommandValue: { type: "number" },
		lastFrequency: { type: "number" },
		lastSampleRate: { type: "number" },
		lastGain: { type: "number" },
		lastPpm: { type: "number" },
		commandHistoryLimit: { type: "number" },
		commandStats: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "number" },
					name: { type: "string" },
					count: { type: "number" },
					lastValue: { type: "number" },
					lastSeenAt: { type: "string", format: "date-time" },
				},
				required: ["id", "name", "count", "lastValue", "lastSeenAt"],
			},
		},
		commandHistory: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "number" },
					name: { type: "string" },
					value: { type: "number" },
					at: { type: "string", format: "date-time" },
					clientId: { type: "string" },
					clientRemote: { type: "string" },
				},
				required: ["id", "name", "value", "at"],
			},
		},
		lastError: { type: "string" },
		rtlTcpHeader: {
			type: "object",
			properties: {
				magic: { type: "string" },
				tunerType: { type: "number" },
				gainCount: { type: "number" },
			},
			required: ["magic", "tunerType", "gainCount"],
		},
	},
	required: [
		"enabled",
		"listening",
		"host",
		"port",
		"clientsConnected",
		"controlPolicy",
		"bytesSent",
		"bytesReceived",
	],
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
 * System status response schema (legacy /api/status)
 */
const systemStatusResponseSchema = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["healthy", "degraded", "unhealthy"] },
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
		tunerRelay: tunerRelayStatusSchema,
		health: healthStatusResponseSchema,
	},
	required: [
		"status",
		"uptime",
		"version",
		"sources",
		"decoders",
		"audio",
		"health",
	],
} as const

// ============================================================================
// Response Interfaces
// ============================================================================

/**
 * Liveness response interface
 */
export interface LivenessResponse {
	status: "ok"
	timestamp: string
}

/**
 * System status response interface (extended with health)
 */
export interface SystemStatusResponse {
	status: HealthStatusLevel
	uptime: number
	version: string
	sources: SourceStatus[]
	decoders: DecoderStatus[]
	audio: {
		outputPort: number
		clientsConnected: number
		format?: string | undefined
		sampleRate?: number | undefined
	}
	tunerRelay?: TunerRelayStatus
	health: HealthStatus
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
	tunerRelay?: TunerRelay | undefined
	/** Whether SDR++ server is expected to be running (full mode) */
	sdrppEnabled?: boolean | undefined
}

/**
 * Health routes plugin for Fastify.
 * Registers /health, /health/ready, /health/live, and /api/status endpoints.
 */
export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (
	fastify: FastifyInstance,
	options: HealthRoutesOptions,
) => {
	const {
		sourceManager,
		decoderManager,
		audioOutput,
		audioConfig,
		tunerRelay,
		sdrppEnabled,
	} = options

	/**
	 * GET /health - Quick liveness check
	 * Requirements: 4.1, 4.2
	 * Returns 200 OK when healthy, 503 Service Unavailable when unhealthy
	 */
	fastify.get<{ Reply: LivenessResponse }>(
		"/health",
		{
			schema: {
				tags: ["health"],
				summary: "Health check",
				description:
					"Returns quick liveness status. Returns 200 OK when healthy, 503 when unhealthy.",
				response: {
					200: livenessResponseSchema,
					503: livenessResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const healthStatus = performHealthCheck(decoderManager, sourceManager, {
				sdrppEnabled,
			})

			const response: LivenessResponse = {
				status: "ok",
				timestamp: new Date().toISOString(),
			}

			// Return 503 if unhealthy (Requirement 4.2)
			if (healthStatus.status === "unhealthy") {
				return reply.status(503).send(response)
			}

			return response
		},
	)

	/**
	 * GET /health/ready - Readiness probe
	 * Requirements: 4.5
	 * Returns 200 when ready to accept traffic, 503 when not ready
	 */
	fastify.get<{ Reply: LivenessResponse }>(
		"/health/ready",
		{
			schema: {
				tags: ["health"],
				summary: "Readiness probe",
				description:
					"Returns 200 when ready to accept traffic, 503 when not ready.",
				response: {
					200: livenessResponseSchema,
					503: livenessResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const ready = isReady(decoderManager, sourceManager)

			const response: LivenessResponse = {
				status: "ok",
				timestamp: new Date().toISOString(),
			}

			if (!ready) {
				return reply.status(503).send(response)
			}

			return response
		},
	)

	/**
	 * GET /health/live - Liveness probe
	 * Returns 200 when process is alive
	 */
	fastify.get<{ Reply: LivenessResponse }>(
		"/health/live",
		{
			schema: {
				tags: ["health"],
				summary: "Liveness probe",
				description: "Returns 200 when process is alive.",
				response: {
					200: livenessResponseSchema,
				},
			},
		},
		async () => {
			// If we can respond, we're alive
			return {
				status: "ok" as const,
				timestamp: new Date().toISOString(),
			}
		},
	)

	/**
	 * GET /api/status - Full system status with health details
	 * Requirements: 4.5, 9.2, 10.4
	 * Returns full HealthStatus JSON with all component states
	 */
	fastify.get<{ Reply: SystemStatusResponse }>(
		"/api/status",
		{
			schema: {
				tags: ["health"],
				summary: "System status",
				description:
					"Returns full system status including sources, decoders, audio output, and detailed health information",
				response: {
					200: systemStatusResponseSchema,
				},
			},
		},
		async () => {
			// Perform full health check
			const healthStatus = performHealthCheck(decoderManager, sourceManager, {
				sdrppEnabled,
			})

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

			const tunerRelayStatus = tunerRelay ? tunerRelay.getStatus() : undefined

			const response: SystemStatusResponse = {
				status: healthStatus.status,
				uptime: getUptime(),
				version: APP_VERSION,
				sources,
				decoders,
				audio,
				health: healthStatus,
			}

			if (tunerRelayStatus) {
				response.tunerRelay = tunerRelayStatus
			}

			return response
		},
	)
}

export default healthRoutes

// Re-export types for convenience
export type { HealthStatus, HealthStatusLevel, ComponentHealth }
