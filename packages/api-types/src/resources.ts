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
	iqDelivery?: { modes: ("raw" | "channels")[] } | null
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

	/**
	 * WG4: version reported by the SDR host (printable, at most 64 characters); null when the
	 * host omits it or sends anything else. Absent on older cores.
	 */
	version?: string | null
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
	| "resources:link-quality"
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
		| "link-capacity"
	severity: "warning" | "critical"
	sourceId?: string
	message: string
	timestamp: string
}

export type DropAttribution = "none" | "link" | "host" | "consumer" | "unknown"
export interface SourceLinkAbsorber {
	enabled: boolean
	capacityBytes: number
	capacitySeconds: number
	heldBytes: number
	peakHeldBytes10m: number
	/** Longest continuous holding episode in the window (sibling latency proxy, 9.2). */
	peakHeldMs10m: number
	/** Longest congested-to-excluded time of a laggard in the window; null when none was excluded. */
	laggardExcludeMsMax10m: number | null
	absorbedBytesTotal: number
	overflowBytesTotal: number
	overflowChunksTotal: number
	flushedBytesTotal: number
	absorbedBytes10m: number
	overflowBytes10m: number
	flushedBytes10m: number
}
export interface SourceLinkArrivals {
	windowMs: number
	worstStallMs: number | null
	gapP99Ms: number | null
	burstSeconds: number
	catchupBytes10m: number
	chunks10m: number
}
export interface SourceLinkReceiver {
	interfaceKind: "ethernet" | "wireless" | "other" | null
	signalDbm: number | null
	undervoltageNow: boolean | null
	throttled: boolean | null
}
/** Raw distributions over the 10 min window (requirement 2.1, record 2.3). Counts align with edges. */
export interface SourceLinkHistograms {
	windowMs: number
	gapBucketUpperMs: number[]
	gapCounts: number[] // 48 buckets
	chunkSizeBucketUpperBytes: number[]
	chunkSizeCounts: number[] // 16 buckets
	catchupBucketUpperBytes: number[]
	catchupCounts: number[] // 16 buckets, one count per closed catch-up window (burst)
}
/** Event-loop delay per efficiency sample interval (requirement 2.2); process-wide. */
export interface SourceLinkLoopDelay {
	last: { maxMs: number; p99Ms: number } | null
	maxMs10m: number | null
	p99MaxMs10m: number | null
	intervals10m: number
}
export interface SourceLinkQuality {
	sourceId: string
	transport: "loopback" | "network"
	at: string
	absorber: SourceLinkAbsorber
	arrivals: SourceLinkArrivals
	attribution: {
		last: DropAttribution | null
		counts10m: Record<DropAttribution, number>
	}
	upstreamDropBytesPerSecond: number | null
	receiver: SourceLinkReceiver | null
	histograms?: SourceLinkHistograms
	loopDelay?: SourceLinkLoopDelay | null
}
