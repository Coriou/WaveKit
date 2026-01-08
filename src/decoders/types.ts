/**
 * Decoder Types - Core type definitions for the decoder system
 *
 * Requirements:
 * - 4.4: Parse decoder output into structured DecoderOutput objects
 * - 4.5: Return status for all managed decoders including PID, uptime, and statistics
 * - 4.6: Emit events for decoder output, errors, and exit conditions
 * - 17.1: Decoder capabilities declaration (input type, exclusive requirement, preferred sample rates, output format)
 * - 17.2: Validate decoder capabilities against assigned source
 * - 17.3: Support input types: audio_pcm, iq, external
 * - 17.4: Support output formats: jsonl, nmea, beast, text
 * - 20.1: Report health as "running" when producing output
 * - 20.2: Report health as "degraded" when no output for configured timeout
 * - 20.3: Report health as "faulted" when crashed and exceeded restart limits
 * - 20.4: Emit health events when health changes
 */

import type { EventEmitter } from "node:events"
import type { Readable } from "node:stream"

// ============================================================================
// Decoder Capabilities (Requirements 17.1, 17.2, 17.3, 17.4)
// ============================================================================

/**
 * Input types that a decoder can accept (Requirement 17.3).
 * - audio_pcm: Decoder receives PCM audio data via stdin
 * - iq: Decoder receives IQ data via stdin
 * - external: Decoder manages its own input (e.g., external SDR)
 */
export type DecoderInputType = "audio_pcm" | "iq" | "external"

/**
 * Output formats that a decoder can produce (Requirement 17.4).
 * - jsonl: JSON Lines format (one JSON object per line)
 * - nmea: NMEA sentence format (e.g., AIS)
 * - beast: Beast binary format (e.g., ADS-B)
 * - text: Plain text format
 */
export type DecoderOutputFormat = "jsonl" | "nmea" | "beast" | "text"

/**
 * Integration patterns for decoders.
 * - pure_consumer: Decoder receives audio via stdin, outputs to stdout
 * - network_producer: Decoder runs as a service with network output
 * - external_sdr: Decoder manages its own SDR hardware
 */
export type DecoderIntegrationPattern =
	| "pure_consumer"
	| "network_producer"
	| "external_sdr"

/**
 * Decoder capabilities declaration (Requirement 17.1).
 * Declares what input/output a decoder supports and its integration pattern.
 */
export interface DecoderCaps {
	/** Input type the decoder accepts (Requirement 17.3) */
	input: DecoderInputType
	/** Whether the decoder requires exclusive access to its source */
	wantsExclusiveSource?: boolean | undefined
	/** Preferred sample rates for this decoder */
	preferredSampleRates?: number[] | undefined
	/** Output format produced by the decoder (Requirement 17.4) */
	output: DecoderOutputFormat
	/** Integration pattern for this decoder */
	integrationPattern: DecoderIntegrationPattern
}

// ============================================================================
// Demodulation Configuration (for IQ-to-audio decoders)
// ============================================================================

/**
 * Configuration for FM demodulation settings.
 * Used by decoders that consume IQ data and perform internal FM demodulation
 * using csdr before feeding audio to the actual decoder process.
 */
export interface DemodulationConfig {
	/** FM bandwidth in Hz (e.g., 12500 for NFM, 15000 for wider signals) */
	bandwidth: number
	/** Target audio sample rate in Hz (e.g., 48000, 22050) */
	sampleRate: number
	/** IQ input sample rate in Hz from the source (e.g., 2400000) */
	inputSampleRate: number
	/** Whether to apply de-emphasis (false for digital voice, true for analog FM) */
	deEmphasis: boolean
	/** De-emphasis time constant in µs (50 for EU, 75 for US) - only used if deEmphasis is true */
	deEmphasisTau?: number | undefined
	/** Gain to apply after demodulation (e.g. 1.0, 50.0). Important for normalizing levels after high sample rate demod. */
	fmGain?: number | undefined
	/**
	 * Intermediate sample rate for demodulation in Hz (e.g. 24000).
	 * If set, the pipeline will decimate to this rate first (setting the filter width),
	 * perform FM demodulation, and then resample to the target sampleRate.
	 * This allows for tighter filtering (e.g. 12kHz bw) while outputting higher rate audio.
	 */
	demodSampleRate?: number | undefined
	/** Optional custom transition bandwidth for FIR filter (default: 0.05) */
	filterTransition?: number
	/** Optional custom cutoff for FIR filter (0.0-0.5, default: 0.5) */
	filterCutoff?: number
	/** Optional audio lowpass filter cutoff in Hz (e.g. 3000) */
	audioLowPass?: number
	/** Skip DC block filter (useful for FSK/POCSAG signals) */
	skipDcBlock?: boolean
}

// ============================================================================
// Decoder Health (Requirements 20.1, 20.2, 20.3, 20.4)
// ============================================================================

/**
 * Health states for a decoder (Requirements 20.1, 20.2, 20.3).
 * - running: Decoder is running and producing output normally
 * - idle: Decoder is running but has not produced output for the configured timeout
 *         (this is normal when no signals are present on the frequency)
 * - faulted: Decoder has crashed and exceeded restart limits
 *
 * Note: "degraded" is kept as an alias for backwards compatibility but "idle" is preferred.
 */
export type DecoderHealth = "running" | "idle" | "faulted"

// ============================================================================
// Decoder Configuration
// ============================================================================

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
	/** Which source to attach to (for non-external decoders) */
	sourceId?: string | undefined
	/** Decoder-specific options passed to the underlying process */
	options: Record<string, unknown>
	// For external SDR decoders
	/** Device serial number for external SDR decoders */
	deviceSerial?: string | undefined
	/** Frequencies to monitor (Hz) for external SDR decoders */
	frequencies?: number[] | undefined
	// For network producer decoders
	/** Host to connect to for network producer output */
	outputHost?: string | undefined
	/** Port to connect to for network producer output */
	outputPort?: number | undefined
	/** Protocol for network producer output */
	outputProtocol?: "tcp" | "udp" | undefined
	// Version pinning
	/** Minimum required version for this decoder */
	minVersion?: string | undefined
	/** Maximum allowed version for this decoder */
	maxVersion?: string | undefined
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
	| "aircraft" // ADS-B
	| "acars" // ACARS messages
	| "vdl2" // VDL2 messages
	| "ship" // AIS
	| "aprs" // APRS packets

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
 * Status information for a decoder (Requirements 4.5, 20.1, 20.2, 20.3).
 */
export interface DecoderStatus {
	/** Unique identifier for this decoder */
	id: string
	/** Type of decoder */
	type: string
	/** Whether the decoder process is currently running */
	running: boolean
	/** Health state of the decoder (Requirement 20.1, 20.2, 20.3) */
	health: DecoderHealth
	/** Process ID if running */
	pid?: number | undefined
	/** Uptime in seconds since the decoder was started */
	uptime: number
	/** Decoder statistics */
	stats: DecoderStats
	/** Timestamp of last output received */
	lastOutputAt?: Date | undefined
	/** Number of times the decoder has been restarted */
	restartCount: number
	/** Detected version of the decoder binary */
	version?: string | undefined
}

/**
 * Event signatures for decoder events (Requirements 4.6, 20.4).
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
	/** Emitted when the decoder health changes (Requirement 20.4) */
	health: (health: DecoderHealth) => void
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
	/** Capabilities of this decoder (Requirement 17.1) */
	readonly caps: DecoderCaps

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
	 * @returns DecoderStatus with running state, PID, uptime, health, and statistics
	 */
	getStatus(): DecoderStatus

	/**
	 * Gets the current health state of the decoder (Requirements 20.1, 20.2, 20.3).
	 * @returns Current health state
	 */
	getHealth(): DecoderHealth
}
