/**
 * Resource Monitor Types
 *
 * Shared types for container resource monitoring, SDR host status,
 * and source backpressure tracking.
 */

// ============================================================================
// Container Resources (from cgroups v2/v1)
// ============================================================================

/**
 * Container resource metrics read from Linux cgroups pseudo-filesystem.
 * Works for both cgroups v1 and v2.
 */
export interface ContainerResources {
	/** Whether cgroups data is available */
	available: boolean

	/** CPU usage as percentage (0-100+, can exceed 100 on multi-core) */
	cpuUsagePercent: number | null

	/** Percentage of time CPU was throttled due to limits */
	cpuThrottledPercent: number | null

	/** Current memory usage in bytes */
	memoryUsageBytes: number | null

	/** Memory limit in bytes (null if unlimited) */
	memoryLimitBytes: number | null

	/** Memory usage as percentage of limit */
	memoryUsagePercent: number | null

	/** Number of times OOM killer was invoked */
	oomKillCount: number | null

	/** Detected cgroup version */
	cgroupVersion: "v1" | "v2" | "unknown"
}

// ============================================================================
// SDR Host Status (from wavekit-sdr-host /api/status)
// ============================================================================

/**
 * rtl_tcp process state from SDR host.
 */
export interface SdrHostRtlTcpStatus {
	running: boolean
	pid: number | null
	restartCount: number
	lastRestartAt: string | null
	config: {
		sampleRate: number
		frequency: number
		gain: number
		agc: boolean
	} | null
}

/**
 * rtlmux process state and stats from SDR host.
 */
export interface SdrHostRtlmuxStatus {
	running: boolean
	pid: number | null
	restartCount: number
	lastRestartAt: string | null
	clients: number
	bytesPerSec: number
	totalBytesSent: number
	clientDetails: Array<{
		id: number
		address: string
		bytesDropped: number
	}>
}

/**
 * Dongle information from SDR host.
 */
export interface SdrHostDongleInfo {
	found: boolean
	vendor: string | null
	product: string | null
	serial: string | null
}

/**
 * Complete SDR host status from wavekit-sdr-host /api/status endpoint.
 */
export interface SdrHostStatus {
	/** Whether the SDR host API is reachable */
	available: boolean

	/** Associated source ID in WaveKit config */
	sourceId: string

	/** API endpoint URL */
	apiUrl: string

	/** SDR host uptime in seconds */
	uptime: number | null

	/** rtl_tcp process status */
	rtlTcp: SdrHostRtlTcpStatus | null

	/** rtlmux process status and stats */
	rtlmux: SdrHostRtlmuxStatus | null

	/** Dongle detection info */
	dongle: SdrHostDongleInfo | null

	/** Warnings from preflight checks */
	warnings: string[]

	/** Errors from preflight checks or process failures */
	errors: string[]

	/** ISO timestamp of last successful fetch */
	lastFetchedAt: string | null

	/** Error message if last fetch failed */
	fetchError: string | null
}

// ============================================================================
// Source Backpressure (upstream drops at rtlmux level)
// ============================================================================

/**
 * Upstream backpressure metrics for a source.
 * Tracks IQ sample drops at the rtlmux level before data reaches WaveKit.
 */
export interface SourceBackpressure {
	/** Source ID this tracking applies to */
	sourceId: string

	/** Whether backpressure data is available (requires rtlmux stats) */
	available: boolean

	/** Total bytes dropped upstream (at rtlmux for this client) */
	bytesDroppedUpstream: number

	/** Total bytes sent by rtlmux to this client */
	totalBytesSent: number

	/** Calculated drop rate in bytes/sec over sliding window */
	dropRate: number

	/** Drop percentage (bytesDropped / totalSent * 100) */
	dropPercent: number

	/** ISO timestamp of last check */
	lastCheckedAt: string
}

// ============================================================================
// Resource Snapshot (aggregated view)
// ============================================================================

/**
 * Complete resource monitoring snapshot aggregating all sources.
 */
export interface ResourceSnapshot {
	/** ISO timestamp of snapshot */
	timestamp: string

	/** Container resource metrics */
	container: ContainerResources

	/** SDR host statuses (one per configured source with sdrHost config) */
	sdrHosts: SdrHostStatus[]

	/** Source backpressure metrics (one per source) */
	sourceBackpressure: SourceBackpressure[]
}

// ============================================================================
// WebSocket Events
// ============================================================================

/**
 * Resource-related WebSocket event types.
 */
export type ResourceEventType =
	| "resources:snapshot"
	| "resources:container"
	| "resources:sdr-host"
	| "resources:backpressure"
	| "resources:alert"

/**
 * Resource alert for significant issues (high drop rate, OOM, etc.)
 */
export interface ResourceAlert {
	type:
		| "upstream-drops"
		| "container-memory"
		| "container-cpu"
		| "sdr-host-error"
	severity: "warning" | "critical"
	sourceId?: string
	message: string
	timestamp: string
}
