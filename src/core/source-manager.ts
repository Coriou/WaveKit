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
 * - 10.2: Keep API responsive when source unavailable
 * - 10.3: Report degraded status in health check
 * - 15.1: Establish independent TCP connections to multiple sources
 * - 15.2: Assign decoders to specific sources by source ID
 * - 15.3: Prevent multiple decoders from sharing exclusive sources
 * - 15.4: Return capabilities (kind, sampleRate, format, exclusive) for each source
 * - 15.5: Support source kinds: audio_pcm, iq, recording
 * - 16.1: Validate and store source capabilities
 * - 16.2: Verify capability compatibility before attachment
 * - 16.3: Return compatibility error if decoder input type doesn't match source kind
 */

import { EventEmitter } from "node:events"
import * as net from "node:net"
import * as fs from "node:fs"
import type { Readable } from "node:stream"
import { PassThrough } from "node:stream"
import type { Logger } from "../utils/logger.js"
import { SourceConnectionError } from "../utils/errors.js"
import type { SourceConfig, SourceCaps } from "../config.js"

// Re-export types from config for convenience
export type { SourceConfig, SourceCaps } from "../config.js"

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Source kind - the type of data the source provides (Requirement 15.5)
 */
export type SourceKind = "audio_pcm" | "iq" | "recording"

/**
 * Decoder capabilities - used for compatibility checking (Requirements 16.2, 16.3)
 */
export type DecoderInputType = "audio_pcm" | "iq" | "external"

export interface DecoderCaps {
	/** Type of input the decoder expects */
	input: DecoderInputType
	/** Whether the decoder wants exclusive access to the source */
	wantsExclusiveSource?: boolean
	/** Preferred sample rates for the decoder */
	preferredSampleRates?: number[]
}

export interface SourceStatus {
	id: string
	connected: boolean
	bytesReceived: number
	dataRate: number // KB/s
	lastError?: string | undefined
	reconnectAttempts: number
	caps: SourceCaps
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
	ended: (sourceId: string) => void // For recording sources
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
	// Recording source specific state
	recordingState?: RecordingState | undefined
}

/**
 * State for recording sources (Requirement 21)
 */
interface RecordingState {
	fileDescriptor: number | null
	playbackTimer: ReturnType<typeof setTimeout> | null
	position: number
	fileSize: number
	chunkSize: number
	isPlaying: boolean
}

/**
 * Tracks decoder-source assignments (Requirement 15.2)
 */
interface DecoderAssignment {
	decoderId: string
	sourceId: string
	assignedAt: Date
}

/**
 * Error thrown when source-decoder compatibility check fails (Requirement 16.3)
 */
export class SourceCompatibilityError extends Error {
	constructor(
		public readonly sourceId: string,
		public readonly decoderId: string,
		public readonly reason: string,
	) {
		super(
			`Source ${sourceId} is not compatible with decoder ${decoderId}: ${reason}`,
		)
		this.name = "SourceCompatibilityError"
	}
}

/**
 * Error thrown when trying to assign multiple decoders to an exclusive source (Requirement 15.3)
 */
export class ExclusiveSourceError extends Error {
	constructor(
		public readonly sourceId: string,
		public readonly existingDecoderId: string,
		public readonly newDecoderId: string,
	) {
		super(
			`Source ${sourceId} is exclusive and already assigned to decoder ${existingDecoderId}. Cannot assign to ${newDecoderId}.`,
		)
		this.name = "ExclusiveSourceError"
	}
}

export class SourceManager extends EventEmitter {
	private sources: Map<string, SourceState> = new Map()
	private decoderAssignments: Map<string, DecoderAssignment> = new Map()
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

		// Validate config has required fields based on type
		if (config.type === "recording") {
			if (!config.filePath) {
				throw new Error(`Recording source ${config.id} requires filePath`)
			}
		} else {
			if (!config.host || !config.port) {
				throw new Error(`Network source ${config.id} requires host and port`)
			}
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

		// Handle recording sources (Requirement 21)
		if (config.type === "recording") {
			try {
				await this.startRecordingSource(config.id)
			} catch (err) {
				// Clean up on failure
				this.cleanupState(state)
				this.sources.delete(config.id)
				throw err
			}
		} else {
			// Attempt initial connection for network sources
			try {
				await this.attemptConnection(config.id)
			} catch (err) {
				// Clean up on initial connection failure
				this.cleanupState(state)
				this.sources.delete(config.id)
				throw err
			}
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
		// Clean up recording source resources
		if (state.recordingState) {
			this.cleanupRecordingState(state.recordingState)
			state.recordingState = undefined
		}
	}

	/**
	 * Cleans up recording source state.
	 */
	private cleanupRecordingState(recordingState: RecordingState): void {
		if (recordingState.playbackTimer) {
			clearTimeout(recordingState.playbackTimer)
			recordingState.playbackTimer = null
		}
		if (recordingState.fileDescriptor !== null) {
			try {
				fs.closeSync(recordingState.fileDescriptor)
			} catch {
				// Ignore close errors
			}
			recordingState.fileDescriptor = null
		}
		recordingState.isPlaying = false
	}

	/**
	 * Starts a recording source for file-based IQ/audio replay.
	 * Requirements: 21.1, 21.2, 21.3, 21.4
	 *
	 * @param id - Source ID
	 */
	private async startRecordingSource(id: string): Promise<void> {
		const state = this.sources.get(id)
		if (!state || state.stopping) {
			return
		}

		const { config } = state

		if (!config.filePath) {
			throw new Error(`Recording source ${id} requires filePath`)
		}

		// Check if file exists
		if (!fs.existsSync(config.filePath)) {
			throw new Error(`Recording file not found: ${config.filePath}`)
		}

		// Get file stats
		const stats = fs.statSync(config.filePath)
		const fileSize = stats.size

		if (fileSize === 0) {
			throw new Error(`Recording file is empty: ${config.filePath}`)
		}

		// Open file for reading
		const fd = fs.openSync(config.filePath, "r")

		// Calculate chunk size based on sample rate and format
		// We want to emit data at approximately the real-time rate adjusted by playbackSpeed
		// Default to 4096 bytes per chunk (good balance for most formats)
		const chunkSize = this.calculateChunkSize(config.caps)

		// Initialize recording state
		state.recordingState = {
			fileDescriptor: fd,
			playbackTimer: null,
			position: 0,
			fileSize,
			chunkSize,
			isPlaying: true,
		}

		// Mark as connected
		state.connected = true

		this.logger.info(
			{
				sourceId: id,
				filePath: config.filePath,
				fileSize,
				loop: config.loop,
				playbackSpeed: config.playbackSpeed,
			},
			"Recording source started",
		)

		// Emit connected event
		this.emit("connected", id)

		// Start playback
		this.scheduleNextChunk(id)
	}

	/**
	 * Calculates the chunk size for recording playback based on format.
	 * Requirements: 21.3
	 */
	private calculateChunkSize(caps: SourceCaps): number {
		// Calculate bytes per sample based on format
		let bytesPerSample: number
		switch (caps.format) {
			case "S16LE":
			case "S16_IQ":
				bytesPerSample = 2
				break
			case "FLOAT32LE":
				bytesPerSample = 4
				break
			case "U8_IQ":
				bytesPerSample = 1
				break
			default:
				bytesPerSample = 2
		}

		// For IQ formats, we have I and Q components
		const isIQ = caps.format === "U8_IQ" || caps.format === "S16_IQ"
		const componentsPerSample = isIQ ? 2 : (caps.channels ?? 1)

		// Calculate bytes per second at the sample rate
		const bytesPerSecond =
			caps.sampleRate * bytesPerSample * componentsPerSample

		// Target ~50ms chunks for smooth playback
		const targetChunkDurationMs = 50
		const chunkSize = Math.floor(
			(bytesPerSecond * targetChunkDurationMs) / 1000,
		)

		// Ensure chunk size is aligned to sample boundaries
		const sampleSize = bytesPerSample * componentsPerSample
		const alignedChunkSize = Math.floor(chunkSize / sampleSize) * sampleSize

		// Minimum 1024 bytes, maximum 65536 bytes
		return Math.max(1024, Math.min(65536, alignedChunkSize))
	}

	/**
	 * Calculates the interval between chunks based on playback speed.
	 * Requirements: 21.4
	 */
	private calculateChunkInterval(
		chunkSize: number,
		caps: SourceCaps,
		playbackSpeed: number,
	): number {
		// Calculate bytes per sample based on format
		let bytesPerSample: number
		switch (caps.format) {
			case "S16LE":
			case "S16_IQ":
				bytesPerSample = 2
				break
			case "FLOAT32LE":
				bytesPerSample = 4
				break
			case "U8_IQ":
				bytesPerSample = 1
				break
			default:
				bytesPerSample = 2
		}

		// For IQ formats, we have I and Q components
		const isIQ = caps.format === "U8_IQ" || caps.format === "S16_IQ"
		const componentsPerSample = isIQ ? 2 : (caps.channels ?? 1)

		// Calculate bytes per second at the sample rate
		const bytesPerSecond =
			caps.sampleRate * bytesPerSample * componentsPerSample

		// Calculate how long this chunk represents in real time
		const chunkDurationMs = (chunkSize / bytesPerSecond) * 1000

		// Adjust for playback speed
		const adjustedInterval = chunkDurationMs / playbackSpeed

		// Minimum 1ms interval
		return Math.max(1, adjustedInterval)
	}

	/**
	 * Schedules the next chunk to be read and emitted.
	 */
	private scheduleNextChunk(id: string): void {
		const state = this.sources.get(id)
		if (!state || state.stopping || !state.recordingState) {
			return
		}

		const { config } = state
		const recordingState = state.recordingState

		if (!recordingState.isPlaying || recordingState.fileDescriptor === null) {
			return
		}

		const interval = this.calculateChunkInterval(
			recordingState.chunkSize,
			config.caps,
			config.playbackSpeed ?? 1.0,
		)

		recordingState.playbackTimer = setTimeout(() => {
			this.readAndEmitChunk(id)
		}, interval)
	}

	/**
	 * Reads a chunk from the recording file and emits it.
	 */
	private readAndEmitChunk(id: string): void {
		const state = this.sources.get(id)
		if (!state || state.stopping || !state.recordingState) {
			return
		}

		const recordingState = state.recordingState

		if (!recordingState.isPlaying || recordingState.fileDescriptor === null) {
			return
		}

		// Calculate how many bytes to read
		const remainingBytes = recordingState.fileSize - recordingState.position
		const bytesToRead = Math.min(recordingState.chunkSize, remainingBytes)

		if (bytesToRead <= 0) {
			// End of file reached
			this.handleRecordingEnd(id)
			return
		}

		// Read chunk from file
		const buffer = Buffer.alloc(bytesToRead)
		try {
			const bytesRead = fs.readSync(
				recordingState.fileDescriptor,
				buffer,
				0,
				bytesToRead,
				recordingState.position,
			)

			if (bytesRead === 0) {
				// End of file
				this.handleRecordingEnd(id)
				return
			}

			// Update position
			recordingState.position += bytesRead

			// Update stats
			state.bytesReceived += bytesRead
			state.bytesReceivedSinceLastMetric += bytesRead

			// Write to stream
			if (!state.stream.destroyed) {
				state.stream.write(buffer.subarray(0, bytesRead))
			}

			// Emit data event
			this.emit("data", id, buffer.subarray(0, bytesRead))

			// Schedule next chunk
			this.scheduleNextChunk(id)
		} catch (err) {
			this.logger.error({ sourceId: id, err }, "Error reading recording file")
			state.lastError =
				err instanceof Error ? err.message : "Unknown read error"
			this.handleRecordingEnd(id)
		}
	}

	/**
	 * Handles the end of a recording file.
	 * Requirements: 21.2
	 */
	private handleRecordingEnd(id: string): void {
		const state = this.sources.get(id)
		if (!state || !state.recordingState) {
			return
		}

		const { config } = state
		const recordingState = state.recordingState

		if (config.loop) {
			// Loop: reset position and continue
			recordingState.position = 0

			this.logger.debug({ sourceId: id }, "Recording source looping")

			// Schedule next chunk
			this.scheduleNextChunk(id)
		} else {
			// No loop: emit ended event and stop
			recordingState.isPlaying = false
			state.connected = false

			this.logger.info({ sourceId: id }, "Recording source ended")

			// Emit ended event (Requirement 21.2)
			this.emit("ended", id)
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

		// Recording sources don't use TCP connections
		if (config.type === "recording") {
			return Promise.resolve()
		}

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
					reject(new SourceConnectionError(config.host!, config.port!, err))
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
			socket.connect(config.port!, config.host!)
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

		// Clear timers and recording state
		this.cleanupState(state)

		// Close socket for network sources
		if (state.socket) {
			state.socket.destroy()
			state.socket = null
		}

		// End the stream
		if (!state.stream.destroyed) {
			state.stream.end()
		}

		// Remove any decoder assignments for this source
		for (const [decoderId, assignment] of this.decoderAssignments) {
			if (assignment.sourceId === id) {
				this.decoderAssignments.delete(decoderId)
			}
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
	 * Gets the status of a specific source (Requirements 1.7, 15.4).
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
			caps: state.config.caps,
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
	 * Checks if the SourceManager is in degraded mode (Requirement 10.3).
	 * Degraded mode means at least one source is disconnected but not all.
	 *
	 * @returns true if in degraded mode, false otherwise
	 */
	isDegraded(): boolean {
		const allStatus = this.getAllStatus()
		if (allStatus.length === 0) {
			return false // No sources configured is not degraded
		}

		const connectedCount = allStatus.filter(s => s.connected).length
		const totalCount = allStatus.length

		// Degraded if some but not all sources are disconnected
		return connectedCount > 0 && connectedCount < totalCount
	}

	/**
	 * Checks if all sources are unavailable (Requirement 10.2).
	 *
	 * @returns true if all sources are disconnected, false otherwise
	 */
	isAllSourcesUnavailable(): boolean {
		const allStatus = this.getAllStatus()
		if (allStatus.length === 0) {
			return false // No sources configured
		}

		return allStatus.every(s => !s.connected)
	}

	/**
	 * Gets detailed information about the degraded state (Requirement 10.3).
	 * Useful for health check reporting.
	 *
	 * @returns Object with degraded state details
	 */
	getDegradedInfo(): {
		isDegraded: boolean
		isAllUnavailable: boolean
		connectedSources: string[]
		disconnectedSources: string[]
		totalSources: number
	} {
		const allStatus = this.getAllStatus()
		const connectedSources = allStatus.filter(s => s.connected).map(s => s.id)
		const disconnectedSources = allStatus
			.filter(s => !s.connected)
			.map(s => s.id)

		return {
			isDegraded: this.isDegraded(),
			isAllUnavailable: this.isAllSourcesUnavailable(),
			connectedSources,
			disconnectedSources,
			totalSources: allStatus.length,
		}
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
	 * Gets the capabilities of a source (Requirement 15.4).
	 *
	 * @param id - Source ID
	 * @returns Source capabilities or undefined if not found
	 */
	getCaps(id: string): SourceCaps | undefined {
		const state = this.sources.get(id)
		return state?.config.caps
	}

	/**
	 * Checks if a source is compatible with a decoder's capabilities (Requirements 16.2, 16.3).
	 *
	 * Compatibility rules:
	 * - audio_pcm decoder input matches audio_pcm source kind
	 * - iq decoder input matches iq source kind
	 * - external decoder input is always compatible (decoder manages its own source)
	 *
	 * @param sourceId - Source ID to check
	 * @param decoderCaps - Decoder capabilities to check against
	 * @returns true if compatible, false otherwise
	 */
	isCompatible(sourceId: string, decoderCaps: DecoderCaps): boolean {
		const sourceCaps = this.getCaps(sourceId)
		if (!sourceCaps) return false

		// External decoders manage their own sources, always compatible
		if (decoderCaps.input === "external") {
			return true
		}

		// Check input type matches source kind
		return decoderCaps.input === sourceCaps.kind
	}

	/**
	 * Gets all sources that are compatible with a decoder's capabilities.
	 *
	 * @param decoderCaps - Decoder capabilities to match against
	 * @returns Array of compatible source statuses
	 */
	getAvailableSources(decoderCaps: DecoderCaps): SourceStatus[] {
		const available: SourceStatus[] = []

		for (const [id] of this.sources) {
			if (this.isCompatible(id, decoderCaps)) {
				const status = this.getStatus(id)
				if (status) {
					available.push(status)
				}
			}
		}

		return available
	}

	/**
	 * Assigns a decoder to a source (Requirement 15.2).
	 *
	 * @param decoderId - Decoder ID to assign
	 * @param sourceId - Source ID to assign to
	 * @param decoderCaps - Decoder capabilities for compatibility checking
	 * @throws SourceCompatibilityError if source and decoder are not compatible
	 * @throws ExclusiveSourceError if source is exclusive and already assigned
	 */
	assignDecoder(
		decoderId: string,
		sourceId: string,
		decoderCaps: DecoderCaps,
	): void {
		const state = this.sources.get(sourceId)
		if (!state) {
			throw new Error(`Source ${sourceId} not found`)
		}

		// Check compatibility (Requirement 16.2, 16.3)
		if (!this.isCompatible(sourceId, decoderCaps)) {
			throw new SourceCompatibilityError(
				sourceId,
				decoderId,
				`Decoder input type '${decoderCaps.input}' does not match source kind '${state.config.caps.kind}'`,
			)
		}

		// Check exclusive source constraint (Requirement 15.3)
		if (state.config.caps.exclusive) {
			const existingAssignment = this.getSourceAssignments(sourceId)
			if (existingAssignment.length > 0 && existingAssignment[0]) {
				const existing = existingAssignment[0]
				if (existing.decoderId !== decoderId) {
					throw new ExclusiveSourceError(
						sourceId,
						existing.decoderId,
						decoderId,
					)
				}
			}
		}

		// Check if decoder wants exclusive access
		if (decoderCaps.wantsExclusiveSource) {
			const existingAssignment = this.getSourceAssignments(sourceId)
			if (existingAssignment.length > 0 && existingAssignment[0]) {
				const existing = existingAssignment[0]
				if (existing.decoderId !== decoderId) {
					throw new ExclusiveSourceError(
						sourceId,
						existing.decoderId,
						decoderId,
					)
				}
			}
		}

		// Remove any existing assignment for this decoder
		this.decoderAssignments.delete(decoderId)

		// Create new assignment
		this.decoderAssignments.set(decoderId, {
			decoderId,
			sourceId,
			assignedAt: new Date(),
		})

		this.logger.info({ decoderId, sourceId }, "Decoder assigned to source")
	}

	/**
	 * Unassigns a decoder from its source.
	 *
	 * @param decoderId - Decoder ID to unassign
	 */
	unassignDecoder(decoderId: string): void {
		const assignment = this.decoderAssignments.get(decoderId)
		if (assignment) {
			this.decoderAssignments.delete(decoderId)
			this.logger.info(
				{ decoderId, sourceId: assignment.sourceId },
				"Decoder unassigned from source",
			)
		}
	}

	/**
	 * Gets the source ID assigned to a decoder (Requirement 15.2).
	 *
	 * @param decoderId - Decoder ID to look up
	 * @returns Source ID or undefined if not assigned
	 */
	getAssignedSource(decoderId: string): string | undefined {
		return this.decoderAssignments.get(decoderId)?.sourceId
	}

	/**
	 * Gets all decoder assignments for a source.
	 *
	 * @param sourceId - Source ID to look up
	 * @returns Array of decoder assignments
	 */
	getSourceAssignments(sourceId: string): DecoderAssignment[] {
		const assignments: DecoderAssignment[] = []
		for (const assignment of this.decoderAssignments.values()) {
			if (assignment.sourceId === sourceId) {
				assignments.push(assignment)
			}
		}
		return assignments
	}

	/**
	 * Gets all decoder assignments.
	 *
	 * @returns Map of decoder ID to assignment
	 */
	getAllAssignments(): Map<string, DecoderAssignment> {
		return new Map(this.decoderAssignments)
	}

	/**
	 * Checks if a source is available for a new decoder assignment.
	 * A source is available if:
	 * - It exists
	 * - It's not exclusive, OR
	 * - It's exclusive but has no current assignments
	 *
	 * @param sourceId - Source ID to check
	 * @returns true if available, false otherwise
	 */
	isSourceAvailable(sourceId: string): boolean {
		const state = this.sources.get(sourceId)
		if (!state) return false

		if (!state.config.caps.exclusive) {
			return true
		}

		return this.getSourceAssignments(sourceId).length === 0
	}

	/**
	 * Disconnects all sources and cleans up resources.
	 */
	async disconnectAll(): Promise<void> {
		const ids = Array.from(this.sources.keys())
		await Promise.all(ids.map(id => this.disconnect(id)))
	}
}
