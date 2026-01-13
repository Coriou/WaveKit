/**
 * Resource Aggregator - Unified resource monitoring interface
 *
 * Aggregates data from:
 * - ContainerMonitor (CPU, memory from cgroups)
 * - SdrHostPoller (remote SDR host status)
 * - SourceBackpressureTracker (upstream IQ drops)
 *
 * Provides:
 * - Unified snapshot API
 * - WebSocket event broadcasting
 * - Alert generation for critical issues
 */

import { EventEmitter } from "node:events"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import type {
	ResourceSnapshot,
	ContainerResources,
	SdrHostStatus,
	SourceBackpressure,
	ResourceAlert,
} from "@wavekit/api-types"
import type { ContainerMonitor } from "./container-monitor.js"
import type { SdrHostPoller } from "./sdr-host-poller.js"
import type { SourceBackpressureTracker } from "./source-backpressure-tracker.js"

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_BROADCAST_INTERVAL_MS = 2000
const HIGH_DROP_RATE_THRESHOLD = 10000 // 10 KB/s
const HIGH_MEMORY_THRESHOLD = 90 // 90%
const HIGH_CPU_THRESHOLD = 90 // 90%

// ============================================================================
// Types
// ============================================================================

export interface ResourceAggregatorEvents {
	snapshot: (snapshot: ResourceSnapshot) => void
	alert: (alert: ResourceAlert) => void
}

export interface ResourceAggregatorOptions {
	/** Broadcast interval in milliseconds (default: 2000) */
	broadcastIntervalMs?: number

	/** Enable automatic broadcasting (default: true) */
	autoBroadcast?: boolean
}

// ============================================================================
// ResourceAggregator
// ============================================================================

export class ResourceAggregator extends EventEmitter {
	private readonly log: Logger
	private readonly broadcastIntervalMs: number
	private readonly autoBroadcast: boolean

	private broadcastTimer: ReturnType<typeof setInterval> | null = null
	private isRunning: boolean = false

	private readonly containerMonitor: ContainerMonitor | null
	private readonly sdrHostPoller: SdrHostPoller | null
	private readonly backpressureTracker: SourceBackpressureTracker | null

	// Track previous values for delta alerts
	private lastSnapshot: ResourceSnapshot | null = null

	constructor(
		logger: Logger,
		options: ResourceAggregatorOptions = {},
		components: {
			containerMonitor?: ContainerMonitor | null
			sdrHostPoller?: SdrHostPoller | null
			backpressureTracker?: SourceBackpressureTracker | null
		} = {},
	) {
		super()
		this.log = createComponentLogger(logger, "ResourceAggregator")
		this.broadcastIntervalMs =
			options.broadcastIntervalMs ?? DEFAULT_BROADCAST_INTERVAL_MS
		this.autoBroadcast = options.autoBroadcast ?? true

		this.containerMonitor = components.containerMonitor ?? null
		this.sdrHostPoller = components.sdrHostPoller ?? null
		this.backpressureTracker = components.backpressureTracker ?? null
	}

	// ============================================================================
	// Public API
	// ============================================================================

	/**
	 * Starts resource aggregation and broadcasting.
	 */
	start(): void {
		if (this.isRunning) {
			this.log.warn("ResourceAggregator already started")
			return
		}

		this.isRunning = true
		this.log.info(
			{
				hasContainerMonitor: !!this.containerMonitor,
				hasSdrHostPoller: !!this.sdrHostPoller,
				hasBackpressureTracker: !!this.backpressureTracker,
			},
			"Starting resource aggregation",
		)

		// Wire up component events
		this.wireComponentEvents()

		// Start broadcast timer if enabled
		if (this.autoBroadcast) {
			this.startBroadcasting()
		}
	}

	/**
	 * Stops resource aggregation and broadcasting.
	 */
	stop(): void {
		if (!this.isRunning) {
			return
		}

		this.isRunning = false
		this.stopBroadcasting()
		this.log.info("Stopped resource aggregation")
	}

	/**
	 * Gets a complete resource snapshot.
	 */
	getSnapshot(): ResourceSnapshot {
		const timestamp = new Date().toISOString()

		const container = this.getContainerResources()
		const sdrHosts = this.getSdrHostStatuses()
		const sourceBackpressure = this.getSourceBackpressure()

		const snapshot: ResourceSnapshot = {
			timestamp,
			container,
			sdrHosts,
			sourceBackpressure,
		}

		// Check for alerts
		this.checkForAlerts(snapshot)

		this.lastSnapshot = snapshot
		return snapshot
	}

	/**
	 * Gets container resources only.
	 */
	getContainerResources(): ContainerResources {
		if (!this.containerMonitor) {
			return {
				available: false,
				cpuUsagePercent: null,
				cpuThrottledPercent: null,
				memoryUsageBytes: null,
				memoryLimitBytes: null,
				memoryUsagePercent: null,
				oomKillCount: null,
				cgroupVersion: "unknown",
			}
		}

		return this.containerMonitor.getSnapshot()
	}

	/**
	 * Gets all SDR host statuses.
	 */
	getSdrHostStatuses(): SdrHostStatus[] {
		if (!this.sdrHostPoller) {
			return []
		}

		return this.sdrHostPoller.getAllStatuses()
	}

	/**
	 * Gets source backpressure for all sources.
	 */
	getSourceBackpressure(): SourceBackpressure[] {
		if (!this.backpressureTracker) {
			return []
		}

		return this.backpressureTracker.getAllBackpressure()
	}

	/**
	 * Starts periodic broadcasting of snapshots.
	 */
	startBroadcasting(): void {
		if (this.broadcastTimer) {
			return
		}

		this.broadcastTimer = setInterval(() => {
			try {
				const snapshot = this.getSnapshot()
				this.emit("snapshot", snapshot)
			} catch (error) {
				this.log.error({ error }, "Failed to broadcast resource snapshot")
			}
		}, this.broadcastIntervalMs)

		this.log.debug(
			{ intervalMs: this.broadcastIntervalMs },
			"Started resource broadcasting",
		)
	}

	/**
	 * Stops periodic broadcasting.
	 */
	stopBroadcasting(): void {
		if (this.broadcastTimer) {
			clearInterval(this.broadcastTimer)
			this.broadcastTimer = null
		}
	}

	// ============================================================================
	// Component Event Wiring
	// ============================================================================

	private wireComponentEvents(): void {
		// Forward SDR host status changes
		if (this.sdrHostPoller) {
			this.sdrHostPoller.on("status", (status: SdrHostStatus) => {
				// Check for SDR host errors
				if (status.errors.length > 0) {
					this.emit("alert", {
						type: "sdr-host-error",
						severity: "warning",
						sourceId: status.sourceId,
						message: status.errors[0] ?? "SDR host error",
						timestamp: new Date().toISOString(),
					} satisfies ResourceAlert)
				}
			})

			this.sdrHostPoller.on("error", (sourceId: string, error: Error) => {
				this.emit("alert", {
					type: "sdr-host-error",
					severity: "warning",
					sourceId,
					message: `Connection failed: ${error.message}`,
					timestamp: new Date().toISOString(),
				} satisfies ResourceAlert)
			})
		}
	}

	// ============================================================================
	// Alert Generation
	// ============================================================================

	private checkForAlerts(snapshot: ResourceSnapshot): void {
		// Check for high upstream drop rate
		for (const bp of snapshot.sourceBackpressure) {
			if (bp.available && bp.dropRate > HIGH_DROP_RATE_THRESHOLD) {
				this.emit("alert", {
					type: "upstream-drops",
					severity:
						bp.dropRate > HIGH_DROP_RATE_THRESHOLD * 10
							? "critical"
							: "warning",
					sourceId: bp.sourceId,
					message: `High upstream drop rate: ${this.formatBytes(bp.dropRate)}/s`,
					timestamp: snapshot.timestamp,
				} satisfies ResourceAlert)
			}
		}

		// Check for high memory usage
		if (
			snapshot.container.available &&
			snapshot.container.memoryUsagePercent !== null &&
			snapshot.container.memoryUsagePercent > HIGH_MEMORY_THRESHOLD
		) {
			this.emit("alert", {
				type: "container-memory",
				severity:
					snapshot.container.memoryUsagePercent > 95 ? "critical" : "warning",
				message: `High memory usage: ${snapshot.container.memoryUsagePercent.toFixed(1)}%`,
				timestamp: snapshot.timestamp,
			} satisfies ResourceAlert)
		}

		// Check for high CPU usage (sustained)
		if (
			snapshot.container.available &&
			snapshot.container.cpuUsagePercent !== null &&
			snapshot.container.cpuUsagePercent > HIGH_CPU_THRESHOLD
		) {
			this.emit("alert", {
				type: "container-cpu",
				severity:
					snapshot.container.cpuUsagePercent > 100 ? "critical" : "warning",
				message: `High CPU usage: ${snapshot.container.cpuUsagePercent.toFixed(1)}%`,
				timestamp: snapshot.timestamp,
			} satisfies ResourceAlert)
		}

		// Check for OOM kills
		if (
			snapshot.container.available &&
			snapshot.container.oomKillCount !== null &&
			this.lastSnapshot?.container.oomKillCount !== null
		) {
			const newOomKills =
				snapshot.container.oomKillCount -
				(this.lastSnapshot?.container.oomKillCount ?? 0)
			if (newOomKills > 0) {
				this.emit("alert", {
					type: "container-memory",
					severity: "critical",
					message: `OOM killer invoked (${newOomKills} new kills)`,
					timestamp: snapshot.timestamp,
				} satisfies ResourceAlert)
			}
		}
	}

	private formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
		if (bytes < 1024 * 1024 * 1024)
			return `${(bytes / 1024 / 1024).toFixed(1)} MB`
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
	}
}
