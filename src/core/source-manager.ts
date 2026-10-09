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
import type { SourceActivity } from "@wavekit/api-types"
import type { Logger } from "../utils/logger.js"
import { SourceConnectionError, WaveKitError } from "../utils/errors.js"
import type { SourceConfig, SourceCaps } from "../config.js"
import { detectAudioFormat } from "../utils/audio-analyzer.js"
import { convertFloat32ToS16LE } from "../utils/converters.js"
import {
	RateTruthTracker,
	bytesPerSampleFor,
	type RateMismatch,
} from "./rate-truth.js"
import {
	SignalLevelTracker,
	iqComponentFormatFor,
	type SignalFlat,
} from "./signal-level.js"

// Bound startup/reconnect waits without treating quiet connected sources as failures.
export const SOURCE_CONNECT_TIMEOUT_MS = 5000
// Default stall watchdog for continuous-stream rtl_tcp IQ sessions (0 = off).
export const SOURCE_STALL_TIMEOUT_MS = 15_000
// TCP keepalive is defence in depth for a dead peer (Node 21+ on Linux probes
// every 1 s, 10 probes). It cannot detect a live rtlmux whose upstream dongle /
// rtl_tcp is gone: that socket stays healthy but silent, hence the watchdog.
export const SOURCE_KEEPALIVE_DELAY_MS = 5000

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
	type?: SourceConfig["type"]
	url?: string
	connected: boolean
	activity: SourceActivity
	bytesReceived: number
	dataRate: number // KB/s
	lastError?: string | undefined
	reconnectAttempts: number
	caps: SourceCaps
	/** Present only while the measured rate disagrees with caps (rate-truth check). */
	rateMismatch?: RateMismatch | undefined
	/** Present only while the IQ level has stayed implausibly low (signal-flat check). */
	signalFlat?: SignalFlat | undefined
	/** Latest measured IQ level (dBFS); IQ network sources with data only. */
	signalLevelDbfs?: number | undefined
}

export interface SourceManagerOptions {
	/** Signal-flat threshold in dBFS (default SIGNAL_FLAT_THRESHOLD_DBFS). */
	signalFlatThresholdDbfs?: number | undefined
	/** Signal-flat hold time in ms (default SIGNAL_FLAT_HOLD_MS). */
	signalFlatHoldMs?: number | undefined
}

/**
 * RTL-TCP header information captured from the source stream (if available).
 */
export interface RtlTcpHeaderInfo {
	magic: string
	tunerType: number
	gainCount: number
}

function formatSourceUrl(config: SourceConfig): string {
	if (config.type === "recording") {
		return config.filePath ?? ""
	}
	if (config.host && config.port) {
		return `${config.host}:${config.port}`
	}
	return ""
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
	"caps-changed": (sourceId: string, caps: SourceCaps) => void // For dynamic sample rate
	/** The rate-truth mismatch flag was raised or cleared (see getStatus().rateMismatch). */
	"rate-truth-changed": (sourceId: string) => void
	/** The signal-flat flag was raised or cleared (see getStatus().signalFlat). */
	"signal-flat-changed": (sourceId: string) => void
	/**
	 * First payload bytes of a session (after rtl_tcp header stripping), once
	 * per connection. Through rtlmux this means the upstream dongle is back.
	 */
	"payload-started": (sourceId: string) => void
}

// Exponential backoff constants
const BASE_DELAY_MS = 2000
const MAX_DELAY_MS = 30000
const METRICS_INTERVAL_MS = 5000
const RTL_TCP_HEADER_SIZE = 12
const SAMPLE_TIMEOUT_MS = 10000

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

function parseRtlTcpHeader(buffer: Buffer): RtlTcpHeaderInfo | null {
	if (buffer.length < RTL_TCP_HEADER_SIZE) {
		return null
	}
	try {
		const magic = buffer.toString("ascii", 0, 4)
		const tunerType = buffer.readUInt32BE(4)
		const gainCount = buffer.readUInt32BE(8)
		return { magic, tunerType, gainCount }
	} catch {
		return null
	}
}

interface SourceState {
	config: SourceConfig
	socket: net.Socket | null
	stream: PassThrough
	connected: boolean
	lastSampleAt: number | null
	expectedSince: number
	recordingEnded: boolean
	bytesReceived: number
	sessionBytesReceived: number
	bytesReceivedSinceLastMetric: number
	lastMetricTime: number
	dataRate: number
	/** Measured versus declared rate; network sources only. */
	rateTruth: RateTruthTracker
	/** Subsampled IQ level; IQ network sources only. */
	signalLevel: SignalLevelTracker
	/** The socket was paused for backpressure during the current metrics interval. */
	pausedSinceLastMetric: boolean
	/** Metrics intervals completed in this session (the first one is partial). */
	metricTicksSinceConnect: number
	lastError?: string | undefined
	reconnectAttempts: number
	reconnectTimer: ReturnType<typeof setTimeout> | null

	metricsTimer: ReturnType<typeof setInterval> | null
	stallTimer: ReturnType<typeof setInterval> | null
	stopping: boolean
	// Format detection
	activeFormat: SourceCaps["format"] | "UNKNOWN"
	detectionBuffer: Buffer | null
	conversionRemainder: Buffer
	iqRemainder: Buffer
	// RTL-TCP header capture (IQ sources)
	rtlTcpHeader: Buffer | null
	rtlTcpHeaderInfo: RtlTcpHeaderInfo | null
	rtlTcpHeaderBuffer: Buffer | null
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
	wantsExclusiveSource: boolean
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
	private readonly options: SourceManagerOptions

	constructor(logger: Logger, options: SourceManagerOptions = {}) {
		super()
		this.logger = logger.child({ component: "SourceManager" })
		this.options = options
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
			lastSampleAt: null,
			expectedSince: Date.now(),
			recordingEnded: false,
			bytesReceived: 0,
			sessionBytesReceived: 0,
			bytesReceivedSinceLastMetric: 0,
			rateTruth: new RateTruthTracker(),
			signalLevel: this.createSignalLevelTracker(config),
			pausedSinceLastMetric: false,
			metricTicksSinceConnect: 0,
			lastMetricTime: Date.now(),
			dataRate: 0,
			reconnectAttempts: 0,
			reconnectTimer: null,
			metricsTimer: null,
			stallTimer: null,
			stopping: false,
			activeFormat: config.caps.format,
			detectionBuffer: config.caps.format === "auto" ? Buffer.alloc(0) : null,
			conversionRemainder: Buffer.alloc(0),
			iqRemainder: Buffer.alloc(0),
			rtlTcpHeader: null,
			rtlTcpHeaderInfo: null,
			rtlTcpHeaderBuffer:
				config.type === "rtl_tcp" && config.caps.format === "U8_IQ"
					? Buffer.alloc(0)
					: null,
		}

		this.sources.set(config.id, state)
		stream.on("drain", () => {
			if (state.stopping) return
			state.expectedSince = Date.now()
			state.socket?.resume()
			if (state.recordingState) this.scheduleNextChunk(config.id)
		})

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
				// IMPORTANT: Keep the source registered even if the initial connection fails.
				// This allows the built-in reconnection loop to bring the source back when
				// the remote (e.g. pi-iq) reboots or becomes temporarily unavailable.
				// We only tear down the source for non-connection failures.
				if (!(err instanceof SourceConnectionError)) {
					this.cleanupState(state)
					this.sources.delete(config.id)
				}
				throw err
			}
		}

		return stream
	}

	private forwardData(id: string, state: SourceState, chunk: Buffer): boolean {
		// TCP boundaries are arbitrary. Fanout may shed complete chunks, so each
		// CU8 chunk must contain whole I/Q pairs before reaching its branches.
		if (
			state.config.caps.kind === "iq" &&
			state.config.caps.format === "U8_IQ"
		) {
			const input = state.iqRemainder.length
				? Buffer.concat([state.iqRemainder, chunk])
				: chunk
			const length = input.length - (input.length % 2)
			state.iqRemainder = Buffer.from(input.subarray(length))
			chunk = input.subarray(0, length)
			if (!chunk.length) return true
		}

		if (state.config.type !== "recording") state.signalLevel.feed(chunk)

		const firstPayload = chunk.length > 0 && state.lastSampleAt === null
		if (chunk.length > 0) state.lastSampleAt = Date.now()
		let canWrite = true
		if (!state.stream.destroyed) {
			canWrite = state.stream.write(chunk)
			if (!canWrite) {
				state.socket?.pause()
				state.pausedSinceLastMetric = true
			}
		}
		this.emit("data", id, chunk)
		if (firstPayload) this.emit("payload-started", id)
		return canWrite
	}

	private convertAudioChunk(state: SourceState, chunk: Buffer): Buffer {
		const input = state.conversionRemainder.length
			? Buffer.concat([state.conversionRemainder, chunk])
			: chunk
		const alignedLength = input.length - (input.length % 4)
		state.conversionRemainder = Buffer.from(input.subarray(alignedLength))
		return convertFloat32ToS16LE(input.subarray(0, alignedLength))
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
		this.stopStallWatchdog(state)
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
		state.expectedSince = Date.now()

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
			recordingState.playbackTimer = null
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

			// Stop reading until downstream drains instead of buffering the entire file.
			const canWrite = this.forwardData(
				id,
				state,
				buffer.subarray(0, bytesRead),
			)
			if (
				recordingState.position >= recordingState.fileSize &&
				!state.config.loop
			) {
				this.handleRecordingEnd(id)
			} else if (canWrite) {
				this.scheduleNextChunk(id)
			}
		} catch (err) {
			this.logger.error({ sourceId: id, err }, "Error reading recording file")
			state.lastError =
				err instanceof Error ? err.message : "Unknown read error"
			this.handleRecordingEnd(id, false)
		}
	}

	/**
	 * Handles the end of a recording file.
	 * Requirements: 21.2
	 */
	private handleRecordingEnd(id: string, allowLoop = true): void {
		const state = this.sources.get(id)
		if (!state || !state.recordingState) {
			return
		}

		const { config } = state
		const recordingState = state.recordingState

		if (config.loop && allowLoop) {
			// Loop: reset position and continue
			recordingState.position = 0
			state.iqRemainder = Buffer.alloc(0)

			this.logger.debug({ sourceId: id }, "Recording source looping")

			// Schedule next chunk
			this.scheduleNextChunk(id)
		} else {
			// Retain status/assignments, but release the file and timers at EOF.
			this.cleanupState(state)
			state.connected = false
			state.recordingEnded = true
			state.dataRate = 0
			state.stream.end()

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
			state.sessionBytesReceived = 0
			state.conversionRemainder = Buffer.alloc(0)
			state.iqRemainder = Buffer.alloc(0)
			state.rtlTcpHeader = null
			state.rtlTcpHeaderInfo = null
			state.rtlTcpHeaderBuffer =
				config.type === "rtl_tcp" && config.caps.format === "U8_IQ"
					? Buffer.alloc(0)
					: null

			// Track if this is the initial connection attempt
			const isInitialAttempt = state.reconnectAttempts === 0

			let settled = false
			const safeResolve = () => {
				if (settled) return
				settled = true
				resolve()
			}
			const safeReject = (err: Error) => {
				if (settled) return
				settled = true
				reject(err)
			}

			const cleanup = () => {
				this.stopStallWatchdog(state)
				socket.removeAllListeners()
			}

			const onConnect = () => {
				socket.setTimeout(0)
				socket.setKeepAlive(true, SOURCE_KEEPALIVE_DELAY_MS)
				state.connected = true
				state.lastSampleAt = null
				state.expectedSince = Date.now()
				state.dataRate = 0
				state.bytesReceivedSinceLastMetric = 0
				state.lastMetricTime = Date.now()
				state.metricTicksSinceConnect = 0
				state.pausedSinceLastMetric = false
				this.resetRateTruth(id, state)
				this.resetSignalLevel(id, state)
				state.reconnectAttempts = 0
				state.lastError = undefined

				this.logger.info(
					{ sourceId: id, host: config.host, port: config.port },
					"Connected to source",
				)

				this.startStallWatchdog(state, socket, onError)

				// Emit connected event (Requirement 1.3)
				this.emit("connected", id)
				safeResolve()
			}

			const onData = (chunk: Buffer) => {
				if (state.sessionBytesReceived === 0) {
					this.logger.info(
						{ sourceId: id, firstChunkSize: chunk.length },
						"First data chunk received from source",
					)
				}
				state.bytesReceived += chunk.length
				state.sessionBytesReceived += chunk.length
				state.bytesReceivedSinceLastMetric += chunk.length

				// Handle Auto-Detection
				if (state.activeFormat === "auto" || state.activeFormat === "UNKNOWN") {
					// Append to detection buffer
					state.detectionBuffer = Buffer.concat([
						state.detectionBuffer || Buffer.alloc(0),
						chunk,
					])

					// If we have enough data (e.g. 10ms of 48kHz float = ~2KB, let's wait for 4KB) or it's been a few packets
					if (
						state.detectionBuffer.length >= 4096 ||
						state.bytesReceived > 8192
					) {
						const detected = detectAudioFormat(
							state.detectionBuffer,
							this.logger,
						)

						if (detected !== "UNKNOWN") {
							this.logger.info(
								{ sourceId: id, detected },
								`Auto-detected source format`,
							)
							state.activeFormat = detected

							// Flush the buffer based on detected format
							let dataToProcess = state.detectionBuffer

							// If float, convert to S16LE
							if (
								state.activeFormat === "FLOAT32LE" &&
								config.caps.kind === "audio_pcm"
							) {
								dataToProcess = this.convertAudioChunk(state, dataToProcess)
							}

							this.forwardData(id, state, dataToProcess)

							state.detectionBuffer = null
						} else {
							// Still unknown, maybe silence? Keep buffering up to a limit
							if (state.detectionBuffer.length > 1024 * 1024) {
								// 1MB limit
								this.logger.warn(
									{ sourceId: id },
									"Could not detect format after 1MB, defaulting to S16LE",
								)
								state.activeFormat = "S16LE"
								// Flush as S16LE
								this.forwardData(id, state, state.detectionBuffer)
								state.detectionBuffer = null
							}
						}
					}
					return
				}

				let dataToProcess = chunk

				// Strip RTL-TCP header (12 bytes) for U8_IQ format
				// This is required because decoders expecting raw IQ (like dumpvdl2 --iq-file)
				// generally don't expect the protocol header.
				if (config.type === "rtl_tcp" && config.caps.format === "U8_IQ") {
					const totalReceived = state.sessionBytesReceived
					const previousReceived = totalReceived - chunk.length

					if (previousReceived < RTL_TCP_HEADER_SIZE) {
						// We are processing part of the header
						const headerRemaining = RTL_TCP_HEADER_SIZE - previousReceived
						const headerSlice = chunk.subarray(
							0,
							Math.min(headerRemaining, chunk.length),
						)

						if (headerSlice.length > 0 && state.rtlTcpHeaderBuffer) {
							state.rtlTcpHeaderBuffer = Buffer.concat([
								state.rtlTcpHeaderBuffer,
								headerSlice,
							])

							if (state.rtlTcpHeaderBuffer.length >= RTL_TCP_HEADER_SIZE) {
								const header = state.rtlTcpHeaderBuffer.subarray(
									0,
									RTL_TCP_HEADER_SIZE,
								)
								state.rtlTcpHeader = header
								state.rtlTcpHeaderInfo = parseRtlTcpHeader(header)
								state.rtlTcpHeaderBuffer = null
								this.logger.debug(
									{ sourceId: id, header: state.rtlTcpHeaderInfo },
									"Captured RTL-TCP header from source",
								)
							}
						}

						if (chunk.length <= headerRemaining) {
							// Entire chunk is header, skip it
							return
						}

						// Slice off the header part
						this.logger.debug(
							{ sourceId: id },
							"Stripping RTL-TCP header from stream",
						)
						dataToProcess = chunk.subarray(headerRemaining)
					}
				}

				// Apply conversion if needed
				if (
					state.activeFormat === "FLOAT32LE" &&
					config.caps.kind === "audio_pcm"
				) {
					// We assume config.caps.format was either FLOAT32LE set explicitly, or auto-resolved to it.
					// Note: if config says auto, state.activeFormat is now FLOAT32LE.
					dataToProcess = this.convertAudioChunk(state, dataToProcess)
				}

				this.forwardData(id, state, dataToProcess)
			}

			// disconnect() removes the state before this socket's close/error land,
			// and reconnect() or a recreate can register a new state under the same
			// id in between. A superseded socket must never touch the new state or
			// emit lifecycle events for it (a late "disconnected" detaches the new
			// stream from its fanout and silently starves every decoder). A plain
			// removal (no successor) keeps its trailing "disconnected" as before.
			const isSuperseded = () => {
				const current = this.sources.get(id)
				return current !== undefined && current !== state
			}

			const onError = (err: Error) => {
				if (!isSuperseded()) this.handleConnectionError(id, err)

				// For the initial attempt, surface the failure to the caller (API/startup)
				// while still keeping the source registered for background retries.
				if (isInitialAttempt && !state.connected) {
					safeReject(new SourceConnectionError(config.host!, config.port!, err))
				}

				// Ensure we transition to 'close' so reconnection scheduling is consistent.
				// (Do not remove listeners here; onClose will clean up.)
				try {
					socket.destroy()
				} catch {
					// Ignore destroy errors
				}
			}

			const onClose = () => {
				cleanup()

				const wasConnected = state.connected
				state.connected = false
				state.dataRate = 0
				state.bytesReceivedSinceLastMetric = 0
				state.socket = null

				if (wasConnected && !isSuperseded()) {
					this.logger.info({ sourceId: id }, "Disconnected from source")

					// Emit disconnected event (Requirement 1.4)
					this.emit(
						"disconnected",
						id,
						state.lastError ? new Error(state.lastError) : undefined,
					)
				}

				// Always schedule reconnection when a source socket closes, unless we're
				// explicitly stopping/removing the source.
				if (!state.stopping && !isSuperseded()) {
					this.scheduleReconnect(id)
				}

				// Ensure reconnect-attempt promises do not leak.
				// Initial attempts should reject so callers can return a 400, but background
				// reconnect attempts should resolve.
				if (!wasConnected && isInitialAttempt) {
					const reason = state.lastError
						? new Error(state.lastError)
						: new Error("Socket closed before establishing a connection")
					safeReject(
						new SourceConnectionError(config.host!, config.port!, reason),
					)
				} else {
					safeResolve()
				}
			}

			socket.on("connect", onConnect)
			socket.on("data", onData)
			socket.on("error", onError)
			socket.on("close", onClose)
			socket.setTimeout(SOURCE_CONNECT_TIMEOUT_MS)
			socket.on("timeout", () => {
				if (state.connected || state.stopping) return
				onError(
					Object.assign(
						new Error(
							`Source connection timed out after ${SOURCE_CONNECT_TIMEOUT_MS}ms`,
						),
						{ code: "ETIMEDOUT" },
					),
				)
			})

			// Attempt connection
			socket.connect(config.port!, config.host!)
		})
	}

	/**
	 * Stall watchdog for continuous-stream sessions: rtl_tcp IQ sources stream
	 * without pause while healthy, so once a session has delivered payload, a
	 * gap longer than `stallTimeoutMs` (default 15 s, 0 = off) means a dead or
	 * half-open peer (e.g. a rebooted host that never sent FIN). The socket is
	 * then failed into the normal reconnect/backoff path.
	 *
	 * Covered: rtl_tcp sources with U8_IQ caps, the only format whose 12-byte
	 * protocol header is stripped, so header bytes can never arm the watchdog.
	 * Not covered: recordings, SDR++ network and audio sources (may idle), other
	 * rtl_tcp formats, a session that has not delivered payload yet (kept
	 * connected and reported stale, as e64e16b intends), and time spent paused
	 * by local backpressure.
	 */
	private startStallWatchdog(
		state: SourceState,
		socket: net.Socket,
		fail: (err: Error) => void,
	): void {
		this.stopStallWatchdog(state)
		const { config } = state
		if (
			config.type !== "rtl_tcp" ||
			config.caps.kind !== "iq" ||
			config.caps.format !== "U8_IQ"
		)
			return
		let timeoutMs = config.stallTimeoutMs ?? SOURCE_STALL_TIMEOUT_MS
		if (!Number.isFinite(timeoutMs)) {
			this.logger.warn(
				{ sourceId: config.id, stallTimeoutMs: config.stallTimeoutMs },
				"Invalid stallTimeoutMs; using the default stall watchdog timeout",
			)
			timeoutMs = SOURCE_STALL_TIMEOUT_MS
		}
		if (timeoutMs <= 0) return

		const checkEveryMs = Math.max(50, Math.min(1000, Math.floor(timeoutMs / 4)))
		state.stallTimer = setInterval(() => {
			if (state.socket !== socket || !state.connected || state.stopping) {
				this.stopStallWatchdog(state)
				return
			}
			// Not armed until this session delivered payload; paused is local.
			if (state.lastSampleAt === null) return
			if (state.stream.writableNeedDrain || socket.isPaused()) return
			const idleMs =
				Date.now() - Math.max(state.lastSampleAt, state.expectedSince)
			if (idleMs < timeoutMs) return

			this.stopStallWatchdog(state)
			this.logger.warn(
				{ sourceId: config.id, idleMs, timeoutMs },
				"Source stream stalled; dropping connection to reconnect",
			)
			fail(
				new WaveKitError(
					`No data from source for ${idleMs}ms (stall watchdog ${timeoutMs}ms); reconnecting`,
					"SOURCE_STALLED",
				),
			)
		}, checkEveryMs)
	}

	private stopStallWatchdog(state: SourceState): void {
		if (!state.stallTimer) return
		clearInterval(state.stallTimer)
		state.stallTimer = null
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
			errorCode === "ECONNRESET" ||
			errorCode === "SOURCE_STALLED"

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
		if (state.reconnectTimer) return

		state.reconnectAttempts++
		const baseDelay = calculateBackoffDelay(state.reconnectAttempts)
		// Add small jitter to avoid thundering herd when multiple sources restart.
		// Equal-jitter: base/2 + rand*(base/2)
		const delay = Math.round(baseDelay / 2 + Math.random() * (baseDelay / 2))

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

		this.checkRateTruth(
			id,
			state,
			state.bytesReceivedSinceLastMetric,
			now - state.lastMetricTime,
			now,
		)
		this.checkSignalLevel(id, state, now - state.lastMetricTime, now)
		state.bytesReceivedSinceLastMetric = 0
		state.lastMetricTime = now

		this.emit("metrics", id, {
			bytesReceived: state.bytesReceived,
			dataRate: state.dataRate,
		})
	}

	/**
	 * Feeds one metrics interval to the rate-truth check. Network sources
	 * only (recordings are paced by playback speed). Intervals that cannot be
	 * trusted (first after connect, backpressure pause) are skipped.
	 */
	private checkRateTruth(
		id: string,
		state: SourceState,
		bytes: number,
		elapsedMs: number,
		now: number,
	): void {
		if (state.config.type === "recording") return
		if (!state.connected) {
			this.resetRateTruth(id, state)
			return
		}
		const caps = state.config.caps
		const bytesPerSample = bytesPerSampleFor(caps)
		const stable =
			state.metricTicksSinceConnect > 0 &&
			!state.pausedSinceLastMetric &&
			!state.socket?.isPaused()
		state.metricTicksSinceConnect++
		state.pausedSinceLastMetric = false
		if (bytesPerSample === undefined) return

		const transition = state.rateTruth.observe({
			atMs: now,
			elapsedMs,
			bytes,
			declaredSampleRateHz: caps.sampleRate,
			bytesPerSample,
			stable,
		})
		if (transition === "flagged") {
			this.logger.warn(
				{ sourceId: id, ...state.rateTruth.mismatch },
				"Source delivers a different sample rate than its caps declare; caps left unchanged (check external tuner clients)",
			)
		} else if (transition === "cleared") {
			this.logger.info(
				{ sourceId: id, declaredSampleRateHz: caps.sampleRate },
				"Source rate matches its caps again",
			)
		}
		if (transition) this.emit("rate-truth-changed", id)
	}

	private resetRateTruth(id: string, state: SourceState): void {
		if (state.rateTruth.reset()) this.emit("rate-truth-changed", id)
	}

	private createSignalLevelTracker(config: SourceConfig): SignalLevelTracker {
		const tracker = new SignalLevelTracker({
			thresholdDbfs: this.options.signalFlatThresholdDbfs,
			holdMs: this.options.signalFlatHoldMs,
		})
		// Recordings are not live gain settings; like rate truth, not checked.
		if (config.type !== "recording")
			tracker.setFormat(iqComponentFormatFor(config.caps))
		return tracker
	}

	/**
	 * Closes one metrics interval of the signal-flat check. IQ network sources
	 * only (formats it cannot interpret are never measured); an interval
	 * without data (waiting/stale) never raises the flag.
	 */
	private checkSignalLevel(
		id: string,
		state: SourceState,
		elapsedMs: number,
		now: number,
	): void {
		if (state.config.type === "recording") return
		if (!state.connected) {
			this.resetSignalLevel(id, state)
			return
		}
		const transition = state.signalLevel.observe({ atMs: now, elapsedMs })
		if (transition === "flagged") {
			this.logger.warn(
				{ sourceId: id, ...state.signalLevel.flat },
				"Source IQ level is flat (near-zero gain?); decoders will hear nothing (check external tuner clients)",
			)
		} else if (transition === "cleared") {
			this.logger.info(
				{ sourceId: id, levelDbfs: state.signalLevel.levelDbfs },
				"Source IQ level recovered",
			)
		}
		if (transition) this.emit("signal-flat-changed", id)
	}

	private resetSignalLevel(id: string, state: SourceState): void {
		if (state.signalLevel.reset()) this.emit("signal-flat-changed", id)
	}

	/** A rate, format or kind change restarts the signal-flat check. */
	private onCapsChangedForSignalLevel(
		id: string,
		state: SourceState,
		oldCaps: SourceCaps,
	): void {
		const caps = state.config.caps
		if (
			oldCaps.sampleRate === caps.sampleRate &&
			oldCaps.format === caps.format &&
			oldCaps.kind === caps.kind
		)
			return
		const format =
			state.config.type === "recording" ? undefined : iqComponentFormatFor(caps)
		const cleared = state.signalLevel.setFormat(format)
		if (cleared || state.signalLevel.reset())
			this.emit("signal-flat-changed", id)
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
			state.stream.destroy()
		}

		// Remove any decoder assignments for this source
		for (const [decoderId, assignment] of this.decoderAssignments) {
			if (assignment.sourceId === id) {
				this.decoderAssignments.delete(decoderId)
			}
		}

		this.sources.delete(id)

		this.logger.info({ sourceId: id }, "Source disconnected and cleaned up")
		this.emit("removed", id)
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
			type: state.config.type,
			url: formatSourceUrl(state.config),
			connected: state.connected,
			activity: this.getActivity(state),
			bytesReceived: state.bytesReceived,
			dataRate: state.dataRate,
			lastError: state.lastError,
			reconnectAttempts: state.reconnectAttempts,
			caps: state.config.caps,
			...(state.rateTruth.mismatch
				? { rateMismatch: state.rateTruth.mismatch }
				: {}),
			...(state.signalLevel.flat ? { signalFlat: state.signalLevel.flat } : {}),
			...(state.signalLevel.levelDbfs !== undefined
				? { signalLevelDbfs: state.signalLevel.levelDbfs }
				: {}),
		}
	}

	private getActivity(state: SourceState): SourceActivity {
		const now = Date.now()
		const sampleAgeMs =
			state.lastSampleAt === null ? null : Math.max(0, now - state.lastSampleAt)
		let activity: SourceActivity["state"]
		if (state.recordingEnded) activity = "ended"
		else if (!state.connected) activity = "disconnected"
		else if (state.stream.writableNeedDrain || state.socket?.isPaused())
			activity = "paused"
		else if (sampleAgeMs !== null && sampleAgeMs < SAMPLE_TIMEOUT_MS)
			activity = "streaming"
		else if (
			now - Math.max(state.lastSampleAt ?? 0, state.expectedSince) >=
			SAMPLE_TIMEOUT_MS
		)
			activity = "stale"
		else activity = "waiting"
		return {
			state: activity,
			lastSampleAt:
				state.lastSampleAt === null
					? null
					: new Date(state.lastSampleAt).toISOString(),
			sampleAgeMs,
			timeoutMs: SAMPLE_TIMEOUT_MS,
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
	 * Updates the capabilities of a source dynamically (e.g., dynamic sample rate changes).
	 * Emits 'caps-changed' so consumers can react.
	 *
	 * Note: This is intended for runtime-safe updates like sampleRate/centerFreq.
	 * Changing format/kind may require additional pipeline reconfiguration.
	 *
	 * @param id - Source ID to update
	 * @param updates - Partial caps to merge with existing
	 * @returns Updated capabilities, or undefined if source not found
	 */
	updateSourceCaps(
		id: string,
		updates: Partial<SourceCaps>,
	): SourceCaps | undefined {
		const state = this.sources.get(id)
		if (!state) {
			this.logger.warn({ sourceId: id }, "Cannot update caps: source not found")
			return undefined
		}

		const oldCaps = state.config.caps
		const nextCaps: SourceCaps = {
			...oldCaps,
			...updates,
		}

		// Tuner clients commonly resend their current settings on connection.
		if (
			Object.entries(nextCaps).every(
				([key, value]) => Reflect.get(oldCaps, key) === value,
			)
		)
			return oldCaps

		state.config.caps = nextCaps
		if (oldCaps.format !== nextCaps.format || oldCaps.kind !== nextCaps.kind)
			state.iqRemainder = Buffer.alloc(0)

		if (
			updates.format &&
			updates.format !== state.activeFormat &&
			updates.format !== "auto"
		) {
			state.activeFormat = updates.format
			state.detectionBuffer = null
		}

		if (updates.format === "auto") {
			state.activeFormat = "auto"
			state.detectionBuffer = Buffer.alloc(0)
		}

		if (oldCaps.sampleRate !== nextCaps.sampleRate) {
			this.logger.info(
				{
					sourceId: id,
					oldSampleRate: oldCaps.sampleRate,
					newSampleRate: nextCaps.sampleRate,
				},
				"Source caps updated dynamically",
			)
		}

		this.onCapsChangedForSignalLevel(id, state, oldCaps)
		this.emit("caps-changed", id, nextCaps)
		return nextCaps
	}

	/**
	 * Sets the tuning metadata (sampleRate + centerFreq) exactly, dropping
	 * centerFreq when undefined. Used to reconcile caps with the tuner state core
	 * can actually back (e.g. a reset to the configured baseline after reconnect).
	 * Emits 'caps-changed' only when either value changes.
	 */
	setTuningCaps(
		id: string,
		tuning: { sampleRate: number; centerFreq?: number | undefined },
	): SourceCaps | undefined {
		const state = this.sources.get(id)
		if (!state) {
			this.logger.warn({ sourceId: id }, "Cannot set tuning: source not found")
			return undefined
		}

		const oldCaps = state.config.caps
		if (
			oldCaps.sampleRate === tuning.sampleRate &&
			oldCaps.centerFreq === tuning.centerFreq
		)
			return oldCaps

		const { centerFreq: _previousCenter, ...rest } = oldCaps
		const nextCaps: SourceCaps = { ...rest, sampleRate: tuning.sampleRate }
		if (tuning.centerFreq !== undefined) nextCaps.centerFreq = tuning.centerFreq
		state.config.caps = nextCaps

		this.logger.info(
			{
				sourceId: id,
				oldSampleRate: oldCaps.sampleRate,
				newSampleRate: nextCaps.sampleRate,
				oldCenterFreq: oldCaps.centerFreq,
				newCenterFreq: nextCaps.centerFreq,
			},
			"Source tuning metadata reconciled",
		)
		this.onCapsChangedForSignalLevel(id, state, oldCaps)
		this.emit("caps-changed", id, nextCaps)
		return nextCaps
	}

	/**
	 * Checks if a source supports RTL-TCP tuner control.
	 * Only rtl_tcp type sources can receive tuner commands.
	 *
	 * @param id - Source ID
	 * @returns true if source is rtl_tcp, false otherwise
	 */
	isRtlTcpSource(id: string): boolean {
		const state = this.sources.get(id)
		if (!state || !state.config.type) return false
		return state.config.type === "rtl_tcp"
	}

	/**
	 * Gets the captured RTL-TCP header for a source, if available.
	 *
	 * @param id - Source ID
	 * @returns RTL-TCP header buffer or undefined if not available
	 */
	getRtlTcpHeader(id: string): Buffer | undefined {
		const state = this.sources.get(id)
		return state?.rtlTcpHeader ?? undefined
	}

	/**
	 * Gets parsed RTL-TCP header info for a source, if available.
	 *
	 * @param id - Source ID
	 * @returns Parsed RTL-TCP header info or undefined if not available
	 */
	getRtlTcpInfo(id: string): RtlTcpHeaderInfo | undefined {
		const state = this.sources.get(id)
		return state?.rtlTcpHeaderInfo ?? undefined
	}

	/**
	 * Sends control data upstream to a network source (e.g., RTL-TCP commands).
	 *
	 * @param id - Source ID
	 * @param payload - Raw control bytes to send
	 * @returns true if write buffer accepted the data
	 */
	writeToSource(id: string, payload: Buffer): boolean {
		const state = this.sources.get(id)
		if (!state) {
			throw new Error(`Source ${id} not found`)
		}
		if (state.config.type === "recording") {
			throw new Error(`Source ${id} does not accept control commands`)
		}
		if (!state.socket || !state.connected) {
			throw new Error(`Source ${id} is not connected`)
		}
		if (!state.socket.writable) {
			throw new Error(`Source ${id} socket is not writable`)
		}

		return state.socket.write(payload)
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

		// Enforce exclusivity for both incoming and existing assignments (Requirement 15.3).
		const conflictingAssignment = this.getSourceAssignments(sourceId).find(
			assignment =>
				assignment.decoderId !== decoderId &&
				(state.config.caps.exclusive ||
					decoderCaps.wantsExclusiveSource ||
					assignment.wantsExclusiveSource),
		)
		if (conflictingAssignment) {
			throw new ExclusiveSourceError(
				sourceId,
				conflictingAssignment.decoderId,
				decoderId,
			)
		}

		// Remove any existing assignment for this decoder
		this.decoderAssignments.delete(decoderId)

		// Create new assignment
		this.decoderAssignments.set(decoderId, {
			wantsExclusiveSource: decoderCaps.wantsExclusiveSource ?? false,
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
	 * - Neither the source nor an assigned decoder requires exclusive access, OR
	 * - It has no current assignments
	 *
	 * @param sourceId - Source ID to check
	 * @returns true if available, false otherwise
	 */
	isSourceAvailable(sourceId: string): boolean {
		const state = this.sources.get(sourceId)
		if (!state) return false

		const assignments = this.getSourceAssignments(sourceId)
		return (
			assignments.length === 0 ||
			(!state.config.caps.exclusive &&
				!assignments.some(assignment => assignment.wantsExclusiveSource))
		)
	}

	/**
	 * Disconnects all sources and cleans up resources.
	 */
	async disconnectAll(): Promise<void> {
		const ids = Array.from(this.sources.keys())
		await Promise.all(ids.map(id => this.disconnect(id)))
	}
}
