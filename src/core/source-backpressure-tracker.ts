/**
 * Source Backpressure Tracker - Tracks upstream IQ sample drops
 *
 * Monitors backpressure at the source level (e.g., rtlmux bytesDropped)
 * to detect when the remote SDR host is losing samples before they
 * reach WaveKit.
 *
 * Data sources:
 * 1. SdrHostPoller (if available) - uses rtlmux clientDetails
 * 2. Direct rtlmux stats fetch (fallback) - for plain rtl_tcp/rtlmux setups
 *
 * Features:
 * - Calculates drop rate over sliding window
 * - Matches WaveKit connection by local address
 * - Graceful degradation when stats unavailable
 */

import { createComponentLogger, type Logger } from "../utils/logger.js"
import type { SourceBackpressure } from "@wavekit/api-types"
import type { SdrHostPoller } from "./sdr-host-poller.js"
import type { SourceManager } from "./source-manager.js"

// ============================================================================
// Constants
// ============================================================================

const DROP_WINDOW_MS = 5000
const MAX_HISTORY_SIZE = 100

// ============================================================================
// Types
// ============================================================================

interface DropRecord {
	timestamp: number
	bytesDropped: number
	totalSent: number
}

interface SourceState {
	history: DropRecord[]
	lastBytesDropped: number
	lastTotalSent: number
}

export interface SourceBackpressureTrackerOptions {
	/** Window size for drop rate calculation in ms (default: 5000) */
	dropWindowMs?: number

	/** Custom fetch function for testing */
	fetchFn?: typeof fetch
}

// ============================================================================
// SourceBackpressureTracker
// ============================================================================

export class SourceBackpressureTracker {
	private readonly log: Logger
	private readonly dropWindowMs: number
	private readonly fetchFn: typeof fetch

	private readonly sdrHostPoller: SdrHostPoller | null
	private readonly sourceManager: SourceManager

	private readonly sourceStates: Map<string, SourceState> = new Map()

	constructor(
		logger: Logger,
		sourceManager: SourceManager,
		sdrHostPoller: SdrHostPoller | null,
		options: SourceBackpressureTrackerOptions = {},
	) {
		this.log = createComponentLogger(logger, "SourceBackpressureTracker")
		this.sourceManager = sourceManager
		this.sdrHostPoller = sdrHostPoller
		this.dropWindowMs = options.dropWindowMs ?? DROP_WINDOW_MS
		this.fetchFn = options.fetchFn ?? fetch

		// Initialize state for known sources
		for (const status of sourceManager.getAllStatus()) {
			this.sourceStates.set(status.id, {
				history: [],
				lastBytesDropped: 0,
				lastTotalSent: 0,
			})
		}
	}

	// ============================================================================
	// Public API
	// ============================================================================

	/**
	 * Gets backpressure metrics for a specific source.
	 */
	getBackpressure(sourceId: string): SourceBackpressure {
		// First try to get data from SdrHostPoller
		if (this.sdrHostPoller) {
			const sdrHostStatus = this.sdrHostPoller.getStatus(sourceId)
			if (sdrHostStatus?.available && sdrHostStatus.rtlmux) {
				return this.calculateFromSdrHostStatus(sourceId, sdrHostStatus.rtlmux)
			}
		}

		// No data available
		return this.createUnavailableBackpressure(sourceId)
	}

	/**
	 * Gets backpressure metrics for all sources.
	 */
	getAllBackpressure(): SourceBackpressure[] {
		const allSources = this.sourceManager.getAllStatus()
		return allSources.map(source => this.getBackpressure(source.id))
	}

	/**
	 * Manually update backpressure from an external source (e.g., WebSocket event).
	 */
	updateFromRtlmuxStats(
		sourceId: string,
		stats: { bytesDropped: number; totalSent: number },
	): void {
		this.recordDrops(sourceId, stats.bytesDropped, stats.totalSent)
	}

	// ============================================================================
	// Calculation Logic
	// ============================================================================

	private calculateFromSdrHostStatus(
		sourceId: string,
		rtlmux: {
			clients: number
			bytesPerSec: number
			totalBytesSent: number
			clientDetails: Array<{
				id: number
				address: string
				bytesDropped: number
			}>
		},
	): SourceBackpressure {
		// Try to find our connection in client details
		const localEndpoint = this.getLocalEndpointForSource(sourceId)
		let bytesDropped = 0
		let totalSent = rtlmux.totalBytesSent

		if (localEndpoint && rtlmux.clientDetails.length > 0) {
			// Find client matching our local address
			const ourClient = rtlmux.clientDetails.find(client =>
				this.addressMatchesEndpoint(client.address, localEndpoint),
			)

			if (ourClient) {
				bytesDropped = ourClient.bytesDropped
			} else {
				// Sum all drops if we can't identify our connection
				bytesDropped = rtlmux.clientDetails.reduce(
					(sum, c) => sum + c.bytesDropped,
					0,
				)
			}
		} else if (rtlmux.clientDetails.length > 0) {
			// No local endpoint info, sum all drops
			bytesDropped = rtlmux.clientDetails.reduce(
				(sum, c) => sum + c.bytesDropped,
				0,
			)
		}

		// Record for rate calculation
		this.recordDrops(sourceId, bytesDropped, totalSent)

		// Calculate metrics
		const dropRate = this.calculateDropRate(sourceId)
		const dropPercent =
			totalSent > 0 ? (bytesDropped / (totalSent + bytesDropped)) * 100 : 0

		return {
			sourceId,
			available: true,
			bytesDroppedUpstream: bytesDropped,
			totalBytesSent: totalSent,
			dropRate,
			dropPercent,
			lastCheckedAt: new Date().toISOString(),
		}
	}

	private recordDrops(
		sourceId: string,
		bytesDropped: number,
		totalSent: number,
	): void {
		let state = this.sourceStates.get(sourceId)
		if (!state) {
			state = {
				history: [],
				lastBytesDropped: 0,
				lastTotalSent: 0,
			}
			this.sourceStates.set(sourceId, state)
		}

		const now = Date.now()

		state.history.push({
			timestamp: now,
			bytesDropped,
			totalSent,
		})

		// Prune old records
		const cutoff = now - this.dropWindowMs * 2
		state.history = state.history.filter(r => r.timestamp >= cutoff)

		// Limit history size
		if (state.history.length > MAX_HISTORY_SIZE) {
			state.history = state.history.slice(-MAX_HISTORY_SIZE)
		}

		state.lastBytesDropped = bytesDropped
		state.lastTotalSent = totalSent
	}

	private calculateDropRate(sourceId: string): number {
		const state = this.sourceStates.get(sourceId)
		if (!state || state.history.length < 2) {
			return 0
		}

		const now = Date.now()
		const windowStart = now - this.dropWindowMs

		// Get records within window
		const windowRecords = state.history.filter(r => r.timestamp >= windowStart)
		if (windowRecords.length < 2) {
			return 0
		}

		const oldest = windowRecords[0]!
		const newest = windowRecords[windowRecords.length - 1]!
		const dropDelta = newest.bytesDropped - oldest.bytesDropped
		const timeDeltaMs = newest.timestamp - oldest.timestamp

		if (timeDeltaMs <= 0) {
			return 0
		}

		// Convert to bytes/second
		return (dropDelta / timeDeltaMs) * 1000
	}

	private getLocalEndpointForSource(
		sourceId: string,
	): { address: string; port: number } | null {
		// Get from source manager if available
		// This method would need to be added to SourceManager
		try {
			const sources = this.sourceManager.getAllStatus()
			const source = sources.find(s => s.id === sourceId)
			if (source && "localAddress" in source && "localPort" in source) {
				return {
					address: (source as { localAddress: string }).localAddress,
					port: (source as { localPort: number }).localPort,
				}
			}
		} catch {
			// Method not available
		}
		return null
	}

	private addressMatchesEndpoint(
		clientAddress: string,
		endpoint: { address: string; port: number },
	): boolean {
		// rtlmux format: "192.168.1.100:50522"
		const [ip, portStr] = clientAddress.split(":")
		const port = Number(portStr)

		return ip === endpoint.address && port === endpoint.port
	}

	private createUnavailableBackpressure(sourceId: string): SourceBackpressure {
		return {
			sourceId,
			available: false,
			bytesDroppedUpstream: 0,
			totalBytesSent: 0,
			dropRate: 0,
			dropPercent: 0,
			lastCheckedAt: new Date().toISOString(),
		}
	}
}
