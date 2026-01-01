/**
 * Health Check Utility Module
 *
 * Requirements:
 * - 4.1: Verify that the WaveKit API is responding on port 9000
 * - 4.2: Verify that all configured decoders are running
 * - 4.3: Verify that SDR++ server is running (in full mode)
 * - 4.4: Return exit code 0 when all checks pass and exit code 1 when any check fails
 * - 4.5: Expose a /health endpoint that returns JSON status of all components
 * - 4.6: Complete within 10 seconds to avoid timeout issues
 * - 10.4: Distinguish between healthy, degraded, and unhealthy states
 */

import type { DecoderManager } from "../decoders/manager.js"
import type { SourceManager } from "../core/source-manager.js"
import type { DecoderHealth } from "../decoders/types.js"

// ============================================================================
// Types and Interfaces (from design.md)
// ============================================================================

/**
 * Overall health status of the system
 */
export type HealthStatusLevel = "healthy" | "degraded" | "unhealthy"

/**
 * Component health status
 */
export type ComponentStatus = "up" | "down" | "degraded"

/**
 * Health status for a single component
 */
export interface ComponentHealth {
	status: ComponentStatus
	message?: string | undefined
	lastCheck: string
	metrics?: Record<string, number> | undefined
}

/**
 * Full health status response
 */
export interface HealthStatus {
	status: HealthStatusLevel
	timestamp: string
	uptime: number
	components: {
		api: ComponentHealth
		sdrpp?: ComponentHealth | undefined
		decoders: Record<string, ComponentHealth>
		source: ComponentHealth
	}
}

/**
 * Options for health check functions
 */
export interface HealthCheckOptions {
	/** Timeout in milliseconds for individual checks (default: 5000) */
	timeout?: number | undefined
	/** Whether SDR++ server is expected to be running */
	sdrppEnabled?: boolean | undefined
}

// ============================================================================
// Application start time for uptime calculation
// ============================================================================

const startTime = Date.now()

/**
 * Gets the application uptime in seconds
 */
export function getUptime(): number {
	return Math.floor((Date.now() - startTime) / 1000)
}

// ============================================================================
// Health Check Functions
// ============================================================================

/**
 * Checks the health of the API server.
 * The API is considered healthy if this function can be called (server is running).
 *
 * Requirements: 4.1
 *
 * @returns ComponentHealth for the API
 */
export function checkApiHealth(): ComponentHealth {
	// If this function is being called, the API is responding
	return {
		status: "up",
		message: "API server is responding",
		lastCheck: new Date().toISOString(),
	}
}

/**
 * Checks the health of a single decoder.
 *
 * Requirements: 4.2
 *
 * @param decoderId - The decoder ID
 * @param health - The decoder's health state from DecoderManager
 * @param isRunning - Whether the decoder process is running
 * @returns ComponentHealth for the decoder
 */
export function checkDecoderHealth(
	decoderId: string,
	health: DecoderHealth,
	isRunning: boolean,
): ComponentHealth {
	if (!isRunning) {
		return {
			status: "down",
			message: `Decoder ${decoderId} is not running`,
			lastCheck: new Date().toISOString(),
		}
	}

	switch (health) {
		case "running":
			return {
				status: "up",
				message: `Decoder ${decoderId} is running and producing output`,
				lastCheck: new Date().toISOString(),
			}
		case "degraded":
			return {
				status: "degraded",
				message: `Decoder ${decoderId} is running but not producing output`,
				lastCheck: new Date().toISOString(),
			}
		case "faulted":
			return {
				status: "down",
				message: `Decoder ${decoderId} has faulted (crash loop)`,
				lastCheck: new Date().toISOString(),
			}
		default:
			return {
				status: "down",
				message: `Decoder ${decoderId} has unknown health state`,
				lastCheck: new Date().toISOString(),
			}
	}
}

/**
 * Checks the health of all configured decoders.
 *
 * Requirements: 4.2
 *
 * @param decoderManager - The DecoderManager instance
 * @returns Record of decoder ID to ComponentHealth
 */
export function checkAllDecodersHealth(
	decoderManager: DecoderManager,
): Record<string, ComponentHealth> {
	const decoderHealthMap: Record<string, ComponentHealth> = {}
	const allHealth = decoderManager.getAllHealth()
	const allStatus = decoderManager.getAllStatus()

	for (const status of allStatus) {
		const health = allHealth.get(status.id) ?? "running"
		decoderHealthMap[status.id] = checkDecoderHealth(
			status.id,
			health,
			status.running,
		)
	}

	return decoderHealthMap
}

/**
 * Checks the health of SDR sources.
 *
 * Requirements: 4.3 (for SDR++ in full mode)
 *
 * @param sourceManager - The SourceManager instance
 * @returns ComponentHealth for sources
 */
export function checkSourceHealth(
	sourceManager: SourceManager,
): ComponentHealth {
	const allStatus = sourceManager.getAllStatus()

	if (allStatus.length === 0) {
		return {
			status: "down",
			message: "No sources configured",
			lastCheck: new Date().toISOString(),
		}
	}

	const connectedSources = allStatus.filter(s => s.connected)
	const totalSources = allStatus.length

	if (connectedSources.length === 0) {
		// All sources disconnected
		const errors = allStatus
			.filter(s => s.lastError)
			.map(s => `${s.id}: ${s.lastError}`)
			.join("; ")

		return {
			status: "down",
			message: errors || "All sources disconnected",
			lastCheck: new Date().toISOString(),
			metrics: {
				connected: 0,
				total: totalSources,
			},
		}
	}

	if (connectedSources.length < totalSources) {
		// Some sources disconnected
		const disconnected = allStatus
			.filter(s => !s.connected)
			.map(s => s.id)
			.join(", ")

		return {
			status: "degraded",
			message: `Some sources disconnected: ${disconnected}`,
			lastCheck: new Date().toISOString(),
			metrics: {
				connected: connectedSources.length,
				total: totalSources,
			},
		}
	}

	// All sources connected
	return {
		status: "up",
		message: `All ${totalSources} source(s) connected`,
		lastCheck: new Date().toISOString(),
		metrics: {
			connected: connectedSources.length,
			total: totalSources,
		},
	}
}

/**
 * Determines the overall health status based on component health.
 *
 * Requirements: 10.4
 *
 * Rules:
 * - "unhealthy" if API is down or all decoders are down
 * - "degraded" if some decoders are degraded/down or sources are degraded
 * - "healthy" if all components are up
 *
 * @param components - The component health statuses
 * @returns The overall health status level
 */
export function determineOverallHealth(components: {
	api: ComponentHealth
	sdrpp?: ComponentHealth | undefined
	decoders: Record<string, ComponentHealth>
	source: ComponentHealth
}): HealthStatusLevel {
	// API down = unhealthy
	if (components.api.status === "down") {
		return "unhealthy"
	}

	// SDR++ down in full mode = degraded (not unhealthy, API still works)
	const sdrppDown = components.sdrpp?.status === "down"

	// Check decoder health
	const decoderStatuses = Object.values(components.decoders)
	const allDecodersDown =
		decoderStatuses.length > 0 &&
		decoderStatuses.every(d => d.status === "down")
	const someDecodersDegraded = decoderStatuses.some(
		d => d.status === "degraded" || d.status === "down",
	)

	// All decoders down = unhealthy (if there are decoders configured)
	if (allDecodersDown) {
		return "unhealthy"
	}

	// Source down = degraded (API still works, but no data)
	const sourceDown = components.source.status === "down"
	const sourceDegraded = components.source.status === "degraded"

	// Any degraded component = degraded overall
	if (sdrppDown || someDecodersDegraded || sourceDown || sourceDegraded) {
		return "degraded"
	}

	return "healthy"
}

/**
 * Performs a full health check of all system components.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.5, 10.4
 *
 * @param decoderManager - The DecoderManager instance
 * @param sourceManager - The SourceManager instance
 * @param options - Health check options
 * @returns Full HealthStatus object
 */
export function performHealthCheck(
	decoderManager: DecoderManager,
	sourceManager: SourceManager,
	options?: HealthCheckOptions,
): HealthStatus {
	const components: HealthStatus["components"] = {
		api: checkApiHealth(),
		decoders: checkAllDecodersHealth(decoderManager),
		source: checkSourceHealth(sourceManager),
	}

	// Add SDR++ health if enabled
	if (options?.sdrppEnabled) {
		// SDR++ health is determined by whether we have a connected source
		// In full mode, SDR++ is the source, so source health reflects SDR++ health
		const sourceStatus = sourceManager.getAllStatus()
		const sdrppSource = sourceStatus.find(
			s => s.id === "sdrpp" || s.caps.kind === "iq",
		)

		if (sdrppSource) {
			components.sdrpp = {
				status: sdrppSource.connected ? "up" : "down",
				message: sdrppSource.connected
					? "SDR++ server is connected"
					: (sdrppSource.lastError ?? "SDR++ server is not connected"),
				lastCheck: new Date().toISOString(),
			}
		} else {
			components.sdrpp = {
				status: "down",
				message: "SDR++ source not configured",
				lastCheck: new Date().toISOString(),
			}
		}
	}

	const status = determineOverallHealth(components)

	return {
		status,
		timestamp: new Date().toISOString(),
		uptime: getUptime(),
		components,
	}
}

/**
 * Checks if the system is ready to accept traffic.
 * Ready means the API is up and at least one decoder is running.
 *
 * Requirements: 4.5 (readiness probe)
 *
 * @param decoderManager - The DecoderManager instance
 * @param sourceManager - The SourceManager instance
 * @returns true if ready, false otherwise
 */
export function isReady(
	decoderManager: DecoderManager,
	sourceManager: SourceManager,
): boolean {
	// API must be responding (if we're here, it is)
	const apiHealth = checkApiHealth()
	if (apiHealth.status === "down") {
		return false
	}

	// At least one source should be connected (or no sources configured is OK)
	const sourceHealth = checkSourceHealth(sourceManager)
	const allStatus = sourceManager.getAllStatus()
	if (allStatus.length > 0 && sourceHealth.status === "down") {
		return false
	}

	// At least one decoder should be running (or no decoders configured is OK)
	const decoderStatuses = decoderManager.getAllStatus()
	if (decoderStatuses.length > 0) {
		const hasRunningDecoder = decoderStatuses.some(d => d.running)
		if (!hasRunningDecoder) {
			return false
		}
	}

	return true
}

/**
 * Checks if the system is alive (liveness probe).
 * Alive means the process is running and can respond.
 *
 * @returns true (if this function runs, the process is alive)
 */
export function isAlive(): boolean {
	return true
}
