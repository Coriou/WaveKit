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
import {
	SYSTEM_STATUS_REASON_CODES,
	sourceActivitySchema,
	sourceRateMismatchSchema,
	sourceSignalFlatSchema,
	sourceEndpointSchema,
	sourceFeedSchema,
} from "@wavekit/api-types"
import type {
	Diagnostics,
	RecorderRefusalStreak,
	SystemStatusLoad,
	SystemStatusReason,
	SystemStatusResponse as SystemStatusDto,
} from "@wavekit/api-types"
import type { SourceManager, SourceStatus } from "../../core/source-manager.js"
import type { DecoderManager } from "../../decoders/manager.js"
import type { DecoderStatus } from "../../decoders/types.js"
import { decoderStatusSchema } from "./decoder-status-schemas.js"
import type { AudioOutput } from "../../core/audio-output.js"
import type { TunerRelay, TunerRelayStatus } from "../../core/tuner-relay.js"
import {
	performHealthCheck,
	checkReadiness,
	sweepHeldDecoders,
	unhealthyReason,
	getUptime,
	type HealthStatus,
	type NotReadyReason,
	type UnhealthyReason,
	type HealthStatusLevel,
	type ComponentHealth,
} from "../../utils/health-check.js"

// Root package.json version, injected at build time (esbuild and vitest define).
export const APP_VERSION: string =
	typeof __WAVEKIT_VERSION__ === "string"
		? __WAVEKIT_VERSION__
		: "0.0.0-unknown"

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
 * Protected mode: this core lost its private access directory and denies every credential until
 * it restarts. A status code, not a 200 "degraded": the compose healthchecks go by it (curl
 * --fail), and the CLI's probe knows only "ok" and "unhealthy".
 */
const ACCESS_AUTHORITY_LOST = "access_authority_lost"

/** OpenAPI: these two need no credential, whatever the document's global bearer says. */
const PUBLIC_OPERATION = { security: [] }

/**
 * GET /health 503 body: the health check is unhealthy, with a fixed reason code
 */
const unhealthyResponseSchema = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["unhealthy"] },
		reason: {
			type: "string",
			enum: ["api_down", "all_decoders_down", ACCESS_AUTHORITY_LOST],
		},
		timestamp: { type: "string", format: "date-time" },
	},
	required: ["status", "reason", "timestamp"],
} as const

/**
 * GET /health/ready 503 body: not ready, with a fixed reason code
 */
const notReadyResponseSchema = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["not_ready"] },
		reason: {
			type: "string",
			enum: ["api_down", "no_source_connected", "no_decoder_running"],
		},
		timestamp: { type: "string", format: "date-time" },
	},
	required: ["status", "reason", "timestamp"],
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
			enum: [
				"ok",
				"missing-source",
				"unsupported-type",
				"unsupported-kind",
				"unsupported-format",
			],
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
		activity: sourceActivitySchema,
		bytesReceived: { type: "number" },
		dataRate: { type: "number" },
		lastError: { type: "string" },
		reconnectAttempts: { type: "number" },
		rateMismatch: sourceRateMismatchSchema,
		signalFlat: sourceSignalFlatSchema,
		signalLevelDbfs: { type: "number" },
		endpoint: sourceEndpointSchema,
		feed: sourceFeedSchema,
	},
	required: [
		"id",
		"connected",
		"bytesReceived",
		"dataRate",
		"reconnectAttempts",
	],
} as const

const nullableNumber = { type: ["number", "null"] } as const

/** `SystemStatusReason` */
const statusReasonSchema = {
	type: "object",
	properties: {
		code: { type: "string", enum: SYSTEM_STATUS_REASON_CODES },
		level: { type: "string", enum: ["info", "warn"] },
		message: { type: "string" },
		fix: { type: "string" },
		sources: {
			type: "array",
			items: {
				type: "object",
				properties: {
					sourceId: { type: "string" },
					decoders: { type: "integer" },
				},
				required: ["sourceId", "decoders"],
			},
		},
		streak: {
			type: "object",
			properties: {
				since: { type: "string" },
				durationMs: { type: "number" },
				newestCode: { type: "string" },
				newestAt: { type: "string" },
				refusals: { type: "integer" },
				raisesStatus: { type: "boolean" },
				pending: { type: "boolean" },
				fix: { type: "string" },
			},
			required: [
				"since",
				"durationMs",
				"newestCode",
				"newestAt",
				"refusals",
				"raisesStatus",
				"pending",
				"fix",
			],
		},
	},
	required: ["code", "level", "message", "fix"],
} as const

/** `SystemStatusLoad` */
const statusLoadSchema = {
	type: ["object", "null"],
	properties: {
		at: { type: "string" },
		processCpuCores: nullableNumber,
		containerCpuCores: nullableNumber,
		eventLoopUtilization: nullableNumber,
		eventLoopDelayMaxMs: nullableNumber,
		eventLoopDelayP99Ms: nullableNumber,
		eventLoopDelayMaxMs10m: nullableNumber,
		details: { type: "string", enum: ["/api/diagnostics"] },
	},
	required: [
		"at",
		"processCpuCores",
		"containerCpuCores",
		"eventLoopUtilization",
		"eventLoopDelayMaxMs",
		"eventLoopDelayP99Ms",
		"eventLoopDelayMaxMs10m",
		"details",
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
		reasons: { type: "array", items: statusReasonSchema },
		load: statusLoadSchema,
	},
	required: [
		"status",
		"uptime",
		"version",
		"sources",
		"decoders",
		"audio",
		"health",
		"reasons",
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

/** GET /health 503 body */
export interface UnhealthyResponse {
	status: "unhealthy"
	reason: UnhealthyReason | typeof ACCESS_AUTHORITY_LOST
	timestamp: string
}

/** GET /health/ready 503 body */
export interface NotReadyResponse {
	status: "not_ready"
	reason: NotReadyReason
	timestamp: string
}

/**
 * GET /api/status: the shared DTO (`@wavekit/api-types` SystemStatusResponse), with the core's
 * own row types for the parts it builds from them (they carry `| undefined` optionals the DTO's
 * looser rows leave out).
 */
export interface SystemStatusResponse extends Omit<
	SystemStatusDto,
	"sources" | "decoders" | "audio" | "tunerRelay" | "health"
> {
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
	/** Protected mode only: true once only a restart can bring credentials back. */
	accessAuthorityLost?: (() => boolean) | undefined
	/** The analog recorder's refusal streak (RecorderStreakTracker); absent without a scanner. */
	recorderStreak?: (() => RecorderRefusalStreak | null) | undefined
	/** The shared GET /api/diagnostics sample (DiagnosticsSampler.read); absent: no `load`. */
	diagnostics?: (() => Promise<Diagnostics>) | undefined
	/**
	 * Sources a scanner job may still hold (liveScannerJobSources: a live job, or one that ended
	 * within SWEEP_RELEASE_GRACE_MS); absent without a scanner, and then a sweep hold is never called
	 * leaked.
	 */
	scannerJobSources?: (() => ReadonlySet<string>) | undefined
}

const SWEEP_FIX =
	"GET /api/scanner/jobs?view=compact names the sweep; POST /api/scanner/jobs/:id/pause or /cancel ends the hold"

/** Job states that may hold a source's decoders (every state but pending and the terminal ones). */
const HOLDING_JOB_STATES: ReadonlySet<string> = new Set([
	"starting",
	"running",
	"holding",
	"paused",
])

/** The scanner's terminal job states (job-state.ts TERMINAL). */
const TERMINAL_JOB_STATES: ReadonlySet<string> = new Set([
	"completed",
	"cancelled",
	"failed",
])

/**
 * How long a job that just ended still explains a hold on its source. The runner records the
 * terminal state (and `updatedAt`) first, then awaits its finishing actions: stopping its probes,
 * releasing the lease (TEST_MODE 0 and up to 5 restored tuner fields, each one rtl_tcp frame, then
 * at most RESTORE_CAPS_TIMEOUT_MS = 1 s waiting for the caps to show the restored tuning) and only
 * then the decoder hold. The 1 s caps wait is the only timed step; 30 s leaves 29 s for the probe
 * stops, frame writes on a slow link and the decoders' re-evaluation, so a normal sweep end never
 * reads as leaked, while a hold still there 30 s after its job ended is.
 */
export const SWEEP_RELEASE_GRACE_MS = 30_000

/**
 * The sources a scanner job may still hold, from the compact job rows: a live job (starting,
 * running, holding, paused), or one that ended at most SWEEP_RELEASE_GRACE_MS ago (`updatedAt`,
 * set when it took its terminal state) and may still be releasing. An unreadable `updatedAt` on a
 * terminal row counts as still releasing (never guessed leaked). `updatedAt` can be bumped after
 * the terminal state (a later write to the row), which only extends the grace. A job deleted during
 * its ~1 s teardown leaves no row, so its hold can read as sweep-hold-without-job until the decoders
 * are released.
 */
export function liveScannerJobSources(
	rows: readonly { state: string; sourceId: string; updatedAt?: string }[],
	nowMs: number = Date.now(),
): ReadonlySet<string> {
	const out = new Set<string>()
	for (const r of rows) {
		if (HOLDING_JOB_STATES.has(r.state)) out.add(r.sourceId)
		else if (TERMINAL_JOB_STATES.has(r.state)) {
			const endedMs = r.updatedAt === undefined ? NaN : Date.parse(r.updatedAt)
			if (
				!Number.isFinite(endedMs) ||
				nowMs - endedMs <= SWEEP_RELEASE_GRACE_MS
			)
				out.add(r.sourceId)
		}
	}
	return out
}

const LEAKED_HOLD_FIX =
	"GET /api/scanner/jobs?view=compact shows no live job on the source and none that ended in the last 30 s; restart the core to release the hold"

/**
 * The reasons beside the component verdict: fixed text, counts and config ids only. `jobSources`
 * (sources a live scanner job names) splits a sweep hold into one a job explains and one none
 * does (leaked); without it every hold reads as a sweep's.
 */
export function statusReasons(
	held: readonly { sourceId: string; decoders: number }[],
	streak: RecorderRefusalStreak | null,
	jobSources?: ReadonlySet<string>,
): SystemStatusReason[] {
	const reasons: SystemStatusReason[] = []
	const swept = held.filter(
		h => jobSources === undefined || jobSources.has(h.sourceId),
	)
	const leaked = held.filter(
		h => jobSources !== undefined && !jobSources.has(h.sourceId),
	)
	const total = (rows: typeof held): number =>
		rows.reduce((sum, h) => sum + h.decoders, 0)
	if (swept.length > 0)
		reasons.push({
			code: "sweep-suspends-decoders",
			level: "info",
			message: `A scanner sweep suspends ${total(swept)} decoder(s) on ${swept.length} source(s); they resume when it ends and are not counted down`,
			fix: SWEEP_FIX,
			sources: swept.map(h => ({ ...h })),
		})
	if (leaked.length > 0)
		reasons.push({
			code: "sweep-hold-without-job",
			level: "warn",
			message: `${total(leaked)} decoder(s) on ${leaked.length} source(s) stay suspended for a scanner sweep, but no live scanner job names the source and none ended there in the last ${SWEEP_RELEASE_GRACE_MS / 1000} s`,
			fix: LEAKED_HOLD_FIX,
			sources: leaked.map(h => ({ ...h })),
		})
	if (streak?.raisesStatus === true) {
		const minutes = Math.floor(streak.durationMs / 60_000)
		reasons.push({
			code: "recorder-refusal-streak",
			level: "warn",
			message: `The analog recorder has kept nothing for ${minutes} min, refusing every candidate (newest ${streak.newestCode}); GET /api/scanner/recorder/decisions lists them`,
			fix: streak.fix,
			streak,
		})
	}
	return reasons
}

/** The verdict a `warn` reason raises: `healthy` becomes `degraded`, worse stays. */
export function raisedStatus(
	status: HealthStatusLevel,
	reasons: readonly SystemStatusReason[],
): HealthStatusLevel {
	return status === "healthy" && reasons.some(r => r.level === "warn")
		? "degraded"
		: status
}

/** The figures of one diagnostics sample. */
export function loadOf(sample: Diagnostics): SystemStatusLoad {
	return {
		at: sample.at,
		processCpuCores: sample.process.cpuCores,
		containerCpuCores: sample.containerCpuCores,
		eventLoopUtilization: sample.eventLoopUtilization,
		eventLoopDelayMaxMs: sample.eventLoopDelay?.last?.maxMs ?? null,
		eventLoopDelayP99Ms: sample.eventLoopDelay?.last?.p99Ms ?? null,
		eventLoopDelayMaxMs10m: sample.eventLoopDelay?.maxMs10m ?? null,
		details: "/api/diagnostics",
	}
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
		accessAuthorityLost,
		recorderStreak,
		diagnostics,
		scannerJobSources,
	} = options

	/**
	 * GET /health - Quick liveness check
	 * Requirements: 4.1, 4.2
	 * Returns 200 OK when healthy, 503 Service Unavailable when unhealthy
	 */
	fastify.get<{ Reply: LivenessResponse | UnhealthyResponse }>(
		"/health",
		{
			schema: {
				tags: ["health"],
				summary: "Health check",
				description:
					"Returns quick liveness status. Returns 200 OK when healthy, 503 with the reason when unhealthy.",
				...PUBLIC_OPERATION,
				response: {
					200: livenessResponseSchema,
					503: unhealthyResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const healthStatus = performHealthCheck(decoderManager, sourceManager, {
				sdrppEnabled,
			})

			const timestamp = new Date().toISOString()

			if (accessAuthorityLost?.()) {
				const body: UnhealthyResponse = {
					status: "unhealthy",
					reason: ACCESS_AUTHORITY_LOST,
					timestamp,
				}
				return reply.status(503).send(body)
			}

			// Return 503 if unhealthy (Requirement 4.2)
			if (healthStatus.status === "unhealthy") {
				const body: UnhealthyResponse = {
					status: "unhealthy",
					reason: unhealthyReason(healthStatus),
					timestamp,
				}
				return reply.status(503).send(body)
			}

			const body: LivenessResponse = { status: "ok", timestamp }
			return body
		},
	)

	/**
	 * GET /health/ready - Readiness probe
	 * Requirements: 4.5
	 * Returns 200 when ready to accept traffic, 503 when not ready
	 */
	fastify.get<{ Reply: LivenessResponse | NotReadyResponse }>(
		"/health/ready",
		{
			schema: {
				tags: ["health"],
				summary: "Readiness probe",
				description:
					"Returns 200 when ready to accept traffic, 503 with the reason when not ready.",
				response: {
					200: livenessResponseSchema,
					503: notReadyResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const readiness = checkReadiness(decoderManager, sourceManager)
			const timestamp = new Date().toISOString()

			if (!readiness.ready) {
				const body: NotReadyResponse = {
					status: "not_ready",
					reason: readiness.reason,
					timestamp,
				}
				return reply.status(503).send(body)
			}

			const body: LivenessResponse = { status: "ok", timestamp }
			return body
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
				...PUBLIC_OPERATION,
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

			const reasons = statusReasons(
				sweepHeldDecoders(decoderManager),
				recorderStreak?.() ?? null,
				scannerJobSources?.(),
			)
			const response: SystemStatusResponse = {
				status: raisedStatus(healthStatus.status, reasons),
				uptime: getUptime(),
				version: APP_VERSION,
				sources,
				decoders,
				audio,
				health: healthStatus,
				reasons,
			}

			if (diagnostics) {
				try {
					response.load = loadOf(await diagnostics())
				} catch {
					// A failed sample claims nothing about the load.
					response.load = null
				}
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
