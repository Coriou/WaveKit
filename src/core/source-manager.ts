/**
 * Source Manager - TCP connections to SDR sources with auto-reconnect
 *
 * Requirements:
 * - 1.1: Establish TCP connection to specified host and port
 * - 1.2: Retry with exponential backoff (2s, 4s, 8s, max 30s)
 * - 1.3: Emit 'connected' event with source ID
 * - 1.4: Emit 'disconnected' event and begin reconnection attempts
 * - 1.5: Emit data rate metrics every 5 seconds
 * - 1.6: Handle connection errors gracefully (ECONNREFUSED, ETIMEDOUT, ECONNRESET)
 * - 1.7: Return status information including connection state, bytes received, and data rate
 */

import { EventEmitter } from "node:events"
import * as net from "node:net"
import type { Readable } from "node:stream"
import { PassThrough } from "node:stream"
import type { Logger } from "../utils/logger.js"
import { SourceConnectionError } from "../utils/errors.js"

export interface SourceConfig {
	id: string
	type: "sdrpp-network" | "rtl_tcp"
	host: string
	port: number
	format: "S16LE" | "FLOAT32LE"
	sampleRate: number
}

export interface SourceStatus {
	id: string
	connected: boolean
	bytesReceived: number
	dataRate: number // KB/s
	lastError?: string | undefined
	reconnectAttempts: number
}

export interface SourceManagerEvents {
	connected: (sourceId: string) => void
	disconnected: (sourceId: string, error?: Error) => void
	error: (sourceId: string, error: Error) => void
	data: (sourceId: string, chunk: Buffer) => void
	metrics: (
		sourceId: string,
		metrics: { bytesReceived: number; dataRate: number },
	) => void
}

// Exponential backoff constants
const BASE_DELAY_MS = 2000
const MAX_DELAY_MS = 30000
const METRICS_INTERVAL_MS = 5000

/**
 * Calculates exponential backoff delay for reconnection attempts.
 * Formula: min(2^attempts * baseDelay, maxDelay)
 *
 * @param attempts - Number of consecutive failed attempts
 * @returns Delay in milliseconds before next attempt
 */
export function calculateBackoffDelay(attempts: number): number {
	const delay = Math.pow(2, attempts) * BASE_DELAY_MS
	return Math.min(delay, MAX_DELAY_MS)
}

interface SourceState {
	config: SourceConfig
	socket: net.Socket | null
	stream: PassThrough
	connected: boolean
	bytesReceived: number
	bytesReceivedSinceLastMetric: number
	lastMetricTime: number
	dataRate: number
	lastError?: string | undefined
	reconnectAttempts: number
	reconnectTimer: ReturnType<typeof setTimeout> | null
	metricsTimer: ReturnType<typeof setInterval> | null
	stopping: boolean
}

export class SourceManager extends EventEmitter {
	private sources: Map<string, SourceState> = new Map()
	private logger: Logger

	constructor(logger: Logger) {
		super()
		this.logger = logger.child({ component: "SourceManager" })
	}

	/**
	 * Connects to an SDR source over TCP.
	 * Returns a Readable stream that emits audio data.
	 *
	 * @param config - Source configuration
	 * @returns Readable stream for the source data
	 */
	async connect(config: SourceConfig): Promise<Readable> {
		if (this.sources.has(config.id)) {
			throw new Error(`Source ${config.id} already exists`)
		}

		const stream = new PassThrough({
			highWaterMark: 256 * 1024, // 256KB buffer
		})

		const state: SourceState = {
			config,
			socket: null,
			stream,
			connected: false,
			bytesReceived: 0,
			bytesReceivedSinceLastMetric: 0,
			lastMetricTime: Date.now(),
			dataRate: 0,
			reconnectAttempts: 0,
			reconnectTimer: null,
			metricsTimer: null,
			stopping: false,
		}

		this.sources.set(config.id, state)

		// Start metrics emission interval (Requirement 1.5)
		state.metricsTimer = setInterval(() => {
			this.emitMetrics(config.id)
		}, METRICS_INTERVAL_MS)

		// Attempt initial connection
		try {
			await this.attemptConnection(config.id)
		} catch (err) {
			// Clean up on initial connection failure
			this.cleanupState(state)
			this.sources.delete(config.id)
			throw err
		}

		return stream
	}

	/**
	 * Cleans up timers and resources for a source state.
	 */
	private cleanupState(state: SourceState): void {
		if (state.reconnectTimer) {
			clearTimeout(state.reconnectTimer)
			state.reconnectTimer = null
		}
		if (state.metricsTimer) {
			clearInterval(state.metricsTimer)
			state.metricsTimer = null
		}
	}

	/**
	 * Attempts to establish a TCP connection to the source.
	 * On failure, schedules a reconnection with exponential backoff.
	 */
	private attemptConnection(id: string): Promise<void> {
		const state = this.sources.get(id)
		if (!state || state.stopping) {
			return Promise.resolve()
		}

		const { config } = state

		return new Promise<void>((resolve, reject) => {
			const socket = new net.Socket()
			state.socket = socket

			// Track if this is the initial connection attempt
			const isInitialAttempt = state.reconnectAttempts === 0

			const cleanup = () => {
				socket.removeAllListeners()
			}

			const onConnect = () => {
				state.connected = true
				state.reconnectAttempts = 0
				state.lastError = undefined

				this.logger.info(
					{ sourceId: id, host: config.host, port: config.port },
					"Connected to source",
				)

				// Emit connected event (Requirement 1.3)
				this.emit("connected", id)
				resolve()
			}

			const onData = (chunk: Buffer) => {
				state.bytesReceived += chunk.length
				state.bytesReceivedSinceLastMetric += chunk.length

				// Forward data to the PassThrough stream
				if (!state.stream.destroyed) {
					state.stream.write(chunk)
				}

				// Emit data event
				this.emit("data", id, chunk)
			}

			const onError = (err: Error) => {
				cleanup()
				this.handleConnectionError(id, err)

				// Only reject on initial connection attempt
				if (isInitialAttempt && !state.connected) {
					reject(new SourceConnectionError(config.host, config.port, err))
				}
			}

			const onClose = () => {
				const wasConnected = state.connected
				state.connected = false
				state.socket = null

				if (wasConnected) {
					this.logger.info({ sourceId: id }, "Disconnected from source")

					// Emit disconnected event (Requirement 1.4)
					this.emit(
						"disconnected",
						id,
						state.lastError ? new Error(state.lastError) : undefined,
					)
				}

				// Schedule reconnection if not stopping and was previously connected
				// or if this is a reconnection attempt (not initial)
				if (!state.stopping && (wasConnected || !isInitialAttempt)) {
					this.scheduleReconnect(id)
				}
			}

			socket.on("connect", onConnect)
			socket.on("data", onData)
			socket.on("error", onError)
			socket.on("close", onClose)

			// Attempt connection
			socket.connect(config.port, config.host)
		})
	}

	/**
	 * Handles connection errors gracefully (Requirement 1.6).
	 * Logs the error and prepares for reconnection.
	 */
	private handleConnectionError(id: string, err: Error): void {
		const state = this.sources.get(id)
		if (!state) return

		const errorCode = (err as NodeJS.ErrnoException).code

		// Handle known connection errors gracefully (Requirement 1.6)
		const isKnownError =
			errorCode === "ECONNREFUSED" ||
			errorCode === "ETIMEDOUT" ||
			errorCode === "ECONNRESET"

		state.lastError = err.message

		if (isKnownError) {
			this.logger.warn(
				{ sourceId: id, errorCode, message: err.message },
				"Connection error (will retry)",
			)
		} else {
			this.logger.error({ sourceId: id, err }, "Unexpected connection error")
		}

		// Only emit error event if there are listeners (Requirement 1.6)
		if (this.listenerCount("error") > 0) {
			this.emit("error", id, err)
		}
	}

	/**
	 * Schedules a reconnection attempt with exponential backoff (Requirement 1.2).
	 */
	private scheduleReconnect(id: string): void {
		const state = this.sources.get(id)
		if (!state || state.stopping) return

		state.reconnectAttempts++
		const delay = calculateBackoffDelay(state.reconnectAttempts)

		this.logger.info(
			{
				sourceId: id,
				attempt: state.reconnectAttempts,
				delayMs: delay,
			},
			"Scheduling reconnection",
		)

		state.reconnectTimer = setTimeout(() => {
			state.reconnectTimer = null
			this.attemptConnection(id).catch(() => {
				// Error already handled in attemptConnection
			})
		}, delay)
	}

	/**
	 * Emits metrics for a source (Requirement 1.5).
	 * Calculates data rate based on bytes received since last metric.
	 */
	private emitMetrics(id: string): void {
		const state = this.sources.get(id)
		if (!state) return

		const now = Date.now()
		const elapsed = (now - state.lastMetricTime) / 1000 // seconds

		// Calculate data rate in KB/s
		if (elapsed > 0) {
			state.dataRate = state.bytesReceivedSinceLastMetric / 1024 / elapsed
		}

		state.bytesReceivedSinceLastMetric = 0
		state.lastMetricTime = now

		this.emit("metrics", id, {
			bytesReceived: state.bytesReceived,
			dataRate: state.dataRate,
		})
	}

	/**
	 * Disconnects from a source and cleans up resources.
	 *
	 * @param id - Source ID to disconnect
	 */
	async disconnect(id: string): Promise<void> {
		const state = this.sources.get(id)
		if (!state) return

		state.stopping = true

		// Clear timers
		this.cleanupState(state)

		// Close socket
		if (state.socket) {
			state.socket.destroy()
			state.socket = null
		}

		// End the stream
		if (!state.stream.destroyed) {
			state.stream.end()
		}

		this.sources.delete(id)

		this.logger.info({ sourceId: id }, "Source disconnected and cleaned up")
	}

	/**
	 * Reconnects to a source by disconnecting and reconnecting.
	 *
	 * @param id - Source ID to reconnect
	 */
	async reconnect(id: string): Promise<void> {
		const state = this.sources.get(id)
		if (!state) {
			throw new Error(`Source ${id} not found`)
		}

		const config = state.config

		// Disconnect first
		await this.disconnect(id)

		// Reconnect with same config
		await this.connect(config)
	}

	/**
	 * Gets the status of a specific source (Requirement 1.7).
	 *
	 * @param id - Source ID
	 * @returns Source status or undefined if not found
	 */
	getStatus(id: string): SourceStatus | undefined {
		const state = this.sources.get(id)
		if (!state) return undefined

		return {
			id: state.config.id,
			connected: state.connected,
			bytesReceived: state.bytesReceived,
			dataRate: state.dataRate,
			lastError: state.lastError,
			reconnectAttempts: state.reconnectAttempts,
		}
	}

	/**
	 * Gets the status of all sources.
	 *
	 * @returns Array of all source statuses
	 */
	getAllStatus(): SourceStatus[] {
		const statuses: SourceStatus[] = []
		for (const [id] of this.sources) {
			const status = this.getStatus(id)
			if (status) {
				statuses.push(status)
			}
		}
		return statuses
	}

	/**
	 * Gets the readable stream for a source.
	 *
	 * @param id - Source ID
	 * @returns Readable stream or undefined if not found
	 */
	getStream(id: string): Readable | undefined {
		const state = this.sources.get(id)
		return state?.stream
	}

	/**
	 * Disconnects all sources and cleans up resources.
	 */
	async disconnectAll(): Promise<void> {
		const ids = Array.from(this.sources.keys())
		await Promise.all(ids.map(id => this.disconnect(id)))
	}
}
