/**
 * SDR Host Poller - Polls wavekit-sdr-host API endpoints for status
 *
 * Periodically fetches status from configured SDR host endpoints,
 * tracking rtl_tcp/rtlmux process state, dongle info, and client stats.
 *
 * Features:
 * - Exponential backoff on failure (2s -> 4s -> 8s -> max 30s)
 * - Request timeout to avoid blocking
 * - Maintains last-known-good state with staleness tracking
 * - Graceful degradation when endpoint unavailable
 */

import { EventEmitter } from "node:events"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import type { SdrHostStatus } from "@wavekit/api-types"

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_POLL_INTERVAL_MS = 3000
const DEFAULT_TIMEOUT_MS = 2000
const BASE_BACKOFF_MS = 2000
const MAX_BACKOFF_MS = 30000

// ============================================================================
// Types
// ============================================================================

export interface SdrHostConfig {
	sourceId: string
	apiUrl: string
	rtlmuxStatsUrl?: string
}

export interface SdrHostPollerEvents {
	status: (status: SdrHostStatus) => void
	error: (sourceId: string, error: Error) => void
	recovered: (sourceId: string) => void
}

export interface SdrHostPollerOptions {
	/** Poll interval in milliseconds (default: 3000) */
	pollIntervalMs?: number

	/** HTTP request timeout in milliseconds (default: 2000) */
	timeoutMs?: number

	/** Custom fetch function for testing */
	fetchFn?: typeof fetch
}

interface PollerState {
	config: SdrHostConfig
	lastStatus: SdrHostStatus | null
	consecutiveFailures: number
	nextPollAt: number
	timer: ReturnType<typeof setTimeout> | null
}

// ============================================================================
// SdrHostPoller
// ============================================================================

export class SdrHostPoller extends EventEmitter {
	private readonly log: Logger
	private readonly pollIntervalMs: number
	private readonly timeoutMs: number
	private readonly fetchFn: typeof fetch

	private readonly pollers: Map<string, PollerState> = new Map()
	private isRunning: boolean = false

	constructor(
		logger: Logger,
		hosts: SdrHostConfig[],
		options: SdrHostPollerOptions = {},
	) {
		super()
		this.log = createComponentLogger(logger, "SdrHostPoller")
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
		this.fetchFn = options.fetchFn ?? fetch

		// Initialize poller state for each host
		for (const config of hosts) {
			this.pollers.set(config.sourceId, {
				config,
				lastStatus: null,
				consecutiveFailures: 0,
				nextPollAt: 0,
				timer: null,
			})
		}
	}

	// ============================================================================
	// Public API
	// ============================================================================

	/**
	 * Starts polling all configured SDR hosts.
	 */
	start(): void {
		if (this.isRunning) {
			this.log.warn("SdrHostPoller already started")
			return
		}

		this.isRunning = true
		this.log.info({ hostCount: this.pollers.size }, "Starting SDR host polling")

		// Start polling each host
		for (const [sourceId, state] of this.pollers) {
			this.scheduleNextPoll(sourceId, 0) // Poll immediately
		}
	}

	/**
	 * Stops polling all SDR hosts.
	 */
	stop(): void {
		if (!this.isRunning) {
			return
		}

		this.isRunning = false

		// Clear all timers
		for (const state of this.pollers.values()) {
			if (state.timer) {
				clearTimeout(state.timer)
				state.timer = null
			}
		}

		this.log.info("Stopped SDR host polling")
	}

	/**
	 * Gets the latest status for a specific source.
	 */
	getStatus(sourceId: string): SdrHostStatus | undefined {
		const state = this.pollers.get(sourceId)
		if (!state) {
			return undefined
		}

		// Return cached status or create unavailable status
		return state.lastStatus ?? this.createUnavailableStatus(state.config, null)
	}

	/**
	 * Gets all SDR host statuses.
	 */
	getAllStatuses(): SdrHostStatus[] {
		return Array.from(this.pollers.values()).map(
			state =>
				state.lastStatus ?? this.createUnavailableStatus(state.config, null),
		)
	}

	/**
	 * Adds a new SDR host to poll.
	 */
	addHost(config: SdrHostConfig): void {
		if (this.pollers.has(config.sourceId)) {
			this.log.warn({ sourceId: config.sourceId }, "Host already exists")
			return
		}

		const state: PollerState = {
			config,
			lastStatus: null,
			consecutiveFailures: 0,
			nextPollAt: 0,
			timer: null,
		}

		this.pollers.set(config.sourceId, state)

		if (this.isRunning) {
			this.scheduleNextPoll(config.sourceId, 0)
		}
	}

	/**
	 * Removes an SDR host from polling.
	 */
	removeHost(sourceId: string): void {
		const state = this.pollers.get(sourceId)
		if (!state) {
			return
		}

		if (state.timer) {
			clearTimeout(state.timer)
		}

		this.pollers.delete(sourceId)
	}

	// ============================================================================
	// Polling Logic
	// ============================================================================

	private scheduleNextPoll(sourceId: string, delayMs: number): void {
		const state = this.pollers.get(sourceId)
		if (!state || !this.isRunning) {
			return
		}

		if (state.timer) {
			clearTimeout(state.timer)
		}

		state.nextPollAt = Date.now() + delayMs
		state.timer = setTimeout(() => {
			void this.pollHost(sourceId)
		}, delayMs)
	}

	private async pollHost(sourceId: string): Promise<void> {
		const state = this.pollers.get(sourceId)
		if (!state || !this.isRunning) {
			return
		}

		try {
			const status = await this.fetchStatus(state.config)

			// Track recovery
			if (state.consecutiveFailures > 0) {
				this.log.info({ sourceId }, "SDR host connection recovered")
				this.emit("recovered", sourceId)
			}

			state.lastStatus = status
			state.consecutiveFailures = 0

			this.emit("status", status)

			// Schedule next poll at normal interval
			this.scheduleNextPoll(sourceId, this.pollIntervalMs)
		} catch (error) {
			state.consecutiveFailures++

			const backoffDelay = Math.min(
				BASE_BACKOFF_MS * Math.pow(2, state.consecutiveFailures - 1),
				MAX_BACKOFF_MS,
			)

			this.log.debug(
				{
					sourceId,
					failures: state.consecutiveFailures,
					backoffMs: backoffDelay,
				},
				"SDR host poll failed, backing off",
			)

			// Update status to show fetch error
			state.lastStatus = this.createUnavailableStatus(
				state.config,
				error instanceof Error ? error.message : String(error),
			)

			this.emit("error", sourceId, error as Error)

			// Schedule retry with backoff
			this.scheduleNextPoll(sourceId, backoffDelay)
		}
	}

	private async fetchStatus(config: SdrHostConfig): Promise<SdrHostStatus> {
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)

		try {
			const response = await this.fetchFn(`${config.apiUrl}/api/status`, {
				signal: controller.signal,
				headers: {
					Accept: "application/json",
				},
			})

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`)
			}

			const data = (await response.json()) as {
				uptime?: number
				rtlTcp?: {
					running: boolean
					pid?: number
					restartCount?: number
					lastRestartAt?: string
					config?: {
						sampleRate?: number
						frequency?: number
						gain?: number
						agc?: boolean
					}
				}
				rtlmux?: {
					running: boolean
					pid?: number
					restartCount?: number
					lastRestartAt?: string
					// Actual rtlmux stats.json format:
					// { server: { dataIn, dataOut }, clients: [ { client: { host, port }, dataIn, dataOut, dropped: { size, count }, connected } ] }
					stats?: {
						server?: { dataIn?: number; dataOut?: number }
						clients?: Array<{
							client?: { host?: string; port?: number }
							dataIn?: number
							dataOut?: number
							dropped?: { size?: number; count?: number }
							connected?: number
						}>
					}
				}
				dongle?: {
					found: boolean
					vendor?: string
					product?: string
					serial?: string
				}
				warnings?: string[]
				errors?: string[]
			}

			// Extract rtlmux info with proper stats handling
			const rtlmuxStats = data.rtlmux?.stats
			const clientCount = Array.isArray(rtlmuxStats?.clients)
				? rtlmuxStats.clients.length
				: 0
			const totalBytesSent = rtlmuxStats?.server?.dataOut ?? 0
			const clientDetails = Array.isArray(rtlmuxStats?.clients)
				? rtlmuxStats.clients.map((c, i) => ({
						id: i,
						address: c.client?.host ?? "unknown",
						bytesDropped: c.dropped?.size ?? 0,
					}))
				: []

			return {
				available: true,
				sourceId: config.sourceId,
				apiUrl: config.apiUrl,
				uptime: data.uptime ?? null,
				rtlTcp: data.rtlTcp
					? {
							running: data.rtlTcp.running,
							pid: data.rtlTcp.pid ?? null,
							restartCount: data.rtlTcp.restartCount ?? 0,
							lastRestartAt: data.rtlTcp.lastRestartAt ?? null,
							config: data.rtlTcp.config
								? {
										sampleRate: data.rtlTcp.config.sampleRate ?? 0,
										frequency: data.rtlTcp.config.frequency ?? 0,
										gain: data.rtlTcp.config.gain ?? 0,
										agc: data.rtlTcp.config.agc ?? false,
									}
								: null,
						}
					: null,
				rtlmux: data.rtlmux
					? {
							running: data.rtlmux.running,
							pid: data.rtlmux.pid ?? null,
							restartCount: data.rtlmux.restartCount ?? 0,
							lastRestartAt: data.rtlmux.lastRestartAt ?? null,
							clients: clientCount,
							bytesPerSec: 0, // Not directly available from stats.json
							totalBytesSent,
							clientDetails,
						}
					: null,
				dongle: data.dongle
					? {
							found: data.dongle.found,
							vendor: data.dongle.vendor ?? null,
							product: data.dongle.product ?? null,
							serial: data.dongle.serial ?? null,
						}
					: null,
				warnings: data.warnings ?? [],
				errors: data.errors ?? [],
				lastFetchedAt: new Date().toISOString(),
				fetchError: null,
			}
		} finally {
			clearTimeout(timeoutId)
		}
	}

	private createUnavailableStatus(
		config: SdrHostConfig,
		error: string | null,
	): SdrHostStatus {
		return {
			available: false,
			sourceId: config.sourceId,
			apiUrl: config.apiUrl,
			uptime: null,
			rtlTcp: null,
			rtlmux: null,
			dongle: null,
			warnings: [],
			errors: [],
			lastFetchedAt: null,
			fetchError: error,
		}
	}
}
