/**
 * Decoder Types - Core type definitions for the decoder system
 *
 * Requirements:
 * - 4.4: Parse decoder output into structured DecoderOutput objects
 * - 4.5: Return status for all managed decoders including PID, uptime, and statistics
 * - 4.6: Emit events for decoder output, errors, and exit conditions
 */

import type { EventEmitter } from "node:events"
import type { Readable } from "node:stream"

/**
 * Configuration for a decoder instance.
 */
export interface DecoderConfig {
	/** Unique identifier for this decoder instance */
	id: string
	/** Type of decoder (e.g., 'dsd-fme', 'multimon-ng', 'rtl433') */
	type: string
	/** Whether this decoder should be started automatically */
	enabled: boolean
	/** Decoder-specific options passed to the underlying process */
	options: Record<string, unknown>
}

/**
 * Types of output that a decoder can produce.
 */
export type DecoderOutputType =
	| "sync"
	| "decode"
	| "call"
	| "message"
	| "signal"
	| "error"
	| "stats"

/**
 * Structured output from a decoder (Requirement 4.4).
 * All decoder output is normalized to this format.
 */
export interface DecoderOutput {
	/** Timestamp when the output was produced */
	timestamp: Date
	/** ID of the decoder that produced this output */
	decoder: string
	/** Type of output */
	type: DecoderOutputType
	/** Decoder-specific data payload */
	data: unknown
}

/**
 * Statistics tracked for a decoder instance (Requirement 4.5).
 */
export interface DecoderStats {
	/** Total bytes received by the decoder */
	bytesIn: number
	/** Total events emitted by the decoder */
	eventsOut: number
	/** Total errors encountered */
	errors: number
}

/**
 * Status information for a decoder (Requirement 4.5).
 */
export interface DecoderStatus {
	/** Unique identifier for this decoder */
	id: string
	/** Type of decoder */
	type: string
	/** Whether the decoder process is currently running */
	running: boolean
	/** Process ID if running */
	pid?: number | undefined
	/** Uptime in seconds since the decoder was started */
	uptime: number
	/** Decoder statistics */
	stats: DecoderStats
}

/**
 * Event signatures for decoder events (Requirement 4.6).
 */
export interface DecoderEvents {
	/** Emitted when the decoder produces output */
	output: (output: DecoderOutput) => void
	/** Emitted when an error occurs */
	error: (error: Error) => void
	/** Emitted when the decoder process exits */
	exit: (code: number | null, signal: string | null) => void
	/** Emitted when the decoder has started successfully */
	started: () => void
	/** Emitted when the decoder has stopped */
	stopped: () => void
}

/**
 * Decoder interface - defines the contract for all decoder implementations.
 * Decoders are responsible for spawning external processes, piping audio data,
 * and parsing output into structured DecoderOutput objects.
 */
export interface Decoder extends EventEmitter {
	/** Unique identifier for this decoder instance */
	readonly id: string
	/** Type of decoder (e.g., 'dsd-fme', 'multimon-ng', 'rtl433') */
	readonly type: string

	/**
	 * Starts the decoder process.
	 * @throws DecoderSpawnError if the process fails to start
	 */
	start(): Promise<void>

	/**
	 * Stops the decoder process gracefully.
	 * Sends SIGTERM first, then SIGKILL if needed.
	 */
	stop(): Promise<void>

	/**
	 * Restarts the decoder process.
	 * Equivalent to stop() followed by start().
	 */
	restart(): Promise<void>

	/**
	 * Attaches an input stream to feed audio data to the decoder.
	 * @param stream - Readable stream of audio data
	 */
	attachInput(stream: Readable): void

	/**
	 * Detaches the current input stream.
	 */
	detachInput(): void

	/**
	 * Gets the output stream for decoder events.
	 * @returns Object mode Readable stream of DecoderOutput objects
	 */
	getOutput(): Readable

	/**
	 * Gets the audio output stream if the decoder produces audio.
	 * @returns Readable stream of audio data, or null if not available
	 */
	getAudioOutput(): Readable | null

	/**
	 * Gets the current status of the decoder (Requirement 4.5).
	 * @returns DecoderStatus with running state, PID, uptime, and statistics
	 */
	getStatus(): DecoderStatus
}
