/**
 * DSD-FME Decoder - Digital voice signal decoder
 *
 * Requirements:
 * - 6.1: WHEN started, THE DSD_Decoder SHALL spawn dsd-fme with the configured mode and options
 * - 6.2: WHEN dsd-fme outputs sync information, THE DSD_Decoder SHALL parse it into structured sync events
 * - 6.3: WHEN dsd-fme decodes a call, THE DSD_Decoder SHALL emit call events with talkgroup, source, and duration
 * - 6.4: WHEN dsd-fme encounters errors, THE DSD_Decoder SHALL emit error events with the error message
 * - 6.5: THE DSD_Decoder SHALL support modes: auto, dmr, p25, ysf, dstar, nxdn, provoice
 *
 * This decoder now uses AudioDemodDecoder to consume IQ data and perform internal FM
 * demodulation using csdr, eliminating dependency on SDR++ audio output and providing
 * optimal demodulation settings for digital voice.
 */

import { AudioDemodDecoder } from "../audio-demod-decoder.js"
import type {
	DecoderCaps,
	DecoderConfig,
	DecoderOutput,
	DemodulationConfig,
} from "../types.js"
import type { Logger } from "../../utils/logger.js"

/** Supported DSD-FME decoder modes (Requirement 6.5) */
export type DsdFmeMode =
	| "auto"
	| "dmr"
	| "p25"
	| "ysf"
	| "dstar"
	| "nxdn"
	| "provoice"

/** Audio output destination options */
export type DsdFmeOutputType = "null" | "wav" | "udp"

/**
 * Configuration options for the DSD-FME decoder.
 */
export interface DsdFmeOptions {
	/** Decoder mode - which digital voice protocol to decode */
	mode: DsdFmeMode
	/** Audio output destination */
	output: DsdFmeOutputType
	/** Directory for WAV file output (when output is 'wav') */
	wavDir?: string | undefined
	/** UDP host for audio output (when output is 'udp') */
	udpHost?: string | undefined
	/** UDP port for audio output (when output is 'udp') */
	udpPort?: number | undefined
	/** Additional command line arguments */
	extraArgs?: string[] | undefined
	/** IQ sample rate from source (default: 2400000) */
	inputSampleRate?: number | undefined
	/** FM Gain to apply (default: ~70.0 for digital voice) */
	fmGain?: number | undefined
}

/** All supported DSD-FME modes */
export const DSD_FME_MODES: readonly DsdFmeMode[] = [
	"auto",
	"dmr",
	"p25",
	"ysf",
	"dstar",
	"nxdn",
	"provoice",
] as const

// Output parsing regex patterns
const SYNC_PATTERN =
	/Sync:\s*(DMR|P25|YSF|DSTAR|NXDN|ProVoice)(?:\s+Slot\s*(\d+))?/i
const CALL_PATTERN = /TG:\s*(\d+)\s+SRC:\s*(\d+)/i
const ERROR_PATTERN = /(FEC ERR|CRC ERR|SYNC LOST)/i

/**
 * DSD-FME Decoder - Decodes digital voice signals.
 *
 * Supports DMR, P25, YSF, D-Star, NXDN, and ProVoice protocols.
 * Parses dsd-fme output into structured sync, call, and error events.
 *
 * Now extends AudioDemodDecoder to consume IQ data directly and perform
 * optimal FM demodulation (12.5kHz NFM without de-emphasis) before
 * feeding audio to dsd-fme.
 */
export class DsdFmeDecoder extends AudioDemodDecoder {
	private readonly options: DsdFmeOptions

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
		this.options = this.parseOptions(config.options)
		// DSD-FME outputs data to stderr, and we route audio to stdout (which we drain)
		this.parseStdout = false
	}

	/**
	 * Parses and validates decoder options from config.
	 */
	private parseOptions(options: Record<string, unknown>): DsdFmeOptions {
		const mode = (options["mode"] as DsdFmeMode) ?? "auto"
		const output = (options["output"] as DsdFmeOutputType) ?? "null"

		// Validate mode
		if (!DSD_FME_MODES.includes(mode)) {
			this.logger.warn(
				{ mode, validModes: DSD_FME_MODES },
				"Invalid mode, defaulting to auto",
			)
		}

		return {
			mode: DSD_FME_MODES.includes(mode) ? mode : "auto",
			output,
			wavDir: options["wavDir"] as string | undefined,
			udpHost: options["udpHost"] as string | undefined,
			udpPort: options["udpPort"] as number | undefined,
			extraArgs: options["extraArgs"] as string[] | undefined,
			inputSampleRate: options["inputSampleRate"] as number | undefined,
			fmGain: options["fmGain"] as number | undefined,
		}
	}

	/**
	 * Returns the demodulation configuration for DSD-FME.
	 * Uses 12.5kHz NFM bandwidth with no de-emphasis (critical for digital voice).
	 */
	/**
	 * Returns the demodulation configuration for DSD-FME.
	 * Uses 12.5kHz NFM bandwidth (via 24ksps demod rate) with no de-emphasis.
	 */
	protected getDemodConfig(): DemodulationConfig {
		return {
			bandwidth: 12500, // 12.5 kHz NFM - standard for digital voice
			sampleRate: 48000, // 48 kHz output - dsd-fme native rate
			demodSampleRate: 48000, // Demod at 48ksps (firdecimate 50) for proper bandwidth
			inputSampleRate: this.options.inputSampleRate ?? 2_400_000,
			deEmphasis: false, // Critical: no de-emphasis for digital signals
			fmGain: this.options.fmGain,
		}
	}

	/**
	 * Returns the decoder command.
	 * Note: This is only used for getDecoderArgs(), we override buildPipelineCommand()
	 * to handle the sox WAV wrapper needed by dsd-fme.
	 */
	protected getDecoderCommand(): string {
		return "dsd-fme"
	}

	/**
	 * Overrides buildPipelineCommand to add sox WAV wrapper.
	 *
	 * dsd-fme doesn't support raw S16LE stdin - it expects WAV format.
	 * We use sox to wrap the S16LE audio as a WAV stream before piping to dsd-fme.
	 *
	 * Pipeline: IQ -> csdr (demod at demodRate) -> S16LE -> sox (resample to outputRate + WAV wrapper) -> dsd-fme
	 */
	protected override buildPipelineCommand(): string {
		const config = this.getDemodConfig()

		// Determine rates
		const demodRate = config.demodSampleRate ?? config.sampleRate
		const outputRate = config.sampleRate
		const inputSampleRate = config.inputSampleRate || 2_400_000
		// IMPORTANT: csdr firdecimate requires integer decimation factor
		const decimation = Math.round(inputSampleRate / demodRate)

		// Generate debug filename if debug recording is enabled
		const debugFile = this.debugRecording
			? `${this.debugRecording.path}/${this.getDebugFilename("final", "raw")}`
			: null

		// Build csdr pipeline stages (Using jketterl/csdr v0.18+ syntax)
		// CRITICAL: dcblock and limit work on REAL float signals only.
		// They must come AFTER fmdemod (which converts complex -> real audio).
		const csdrStages: string[] = [
			"csdr convert -i char -o float", // U8 IQ -> complex float
			`csdr firdecimate ${decimation}`, // Decimate + filter (complex)
			"csdr fmdemod", // FM demod: complex -> real audio
			"csdr dcblock", // Remove DC offset (real audio)
			`csdr gain ${config.fmGain ?? 10.0}`, // Apply gain (real)
			"csdr limit", // Prevent clipping (real audio)
		]

		// Optional de-emphasis (should be false for digital voice)
		if (config.deEmphasis) {
			csdrStages.push(`csdr deemphasis ${demodRate}`)
		}

		// Convert to S16LE audio
		csdrStages.push("csdr convert -i float -o s16")

		// Join csdr stages
		let pipelineStr = csdrStages.join(" | ")

		// DEBUG: Record raw audio at demod rate before sox processing
		// Using simple tee to file - no bash-specific syntax
		if (debugFile && this.debugRecording) {
			pipelineStr += ` | tee "${debugFile}"`
			this.logger.warn(
				{ file: debugFile, rate: demodRate },
				"DEBUG: Recording raw audio BEFORE sox",
			)
		}

		// Build sox command for WAV wrapper
		const soxCommand = [
			"sox",
			"-t raw",
			`-r ${demodRate}`,
			"-e signed -b 16 -c 1",
			"-",
			"-t wav",
			`-r ${outputRate}`,
			"-",
		].join(" ")

		pipelineStr += ` | ${soxCommand}`

		// Build dsd-fme command
		const dsdFmeArgs = this.getDecoderArgs()
		const dsdFmeCommand = `dsd-fme ${dsdFmeArgs.join(" ")}`

		// Combine into full pipeline
		const pipeline = `${pipelineStr} | ${dsdFmeCommand}`

		this.logger.debug(
			{
				inputSampleRate,
				demodRate,
				outputSampleRate: outputRate,
				decimation,
				pipeline,
				debugRecording: !!this.debugRecording,
			},
			"Built dsd-fme pipeline with WAV wrapper",
		)

		return pipeline
	}

	/**
	 * Generates a timestamped filename for debug recordings.
	 */
	private getDebugFilename(stage: string, ext: string): string {
		const now = new Date()
		const ts = now
			.toISOString()
			.replace(/[:.]/g, "-")
			.replace("T", "_")
			.slice(0, 19)
		return `${ts}_${this.config.id}_${stage}.${ext}`
	}

	/**
	 * Returns decoder-specific command line arguments for dsd-fme.
	 * Note: We use /dev/stdin because dsd-fme reads WAV from stdin (via sox wrapper).
	 */
	protected getDecoderArgs(): string[] {
		const args: string[] = []

		// Input from stdin (receives WAV stream from sox)
		args.push("-i", "/dev/stdin")

		// Set decoder mode with explicit flag
		switch (this.options.mode) {
			case "dmr":
				// DMR TDMA BS and MS Simplex
				args.push("-fs")
				break
			case "p25":
				// P25 Phase 1
				args.push("-f1")
				break
			case "ysf":
				args.push("-fy")
				break
			case "dstar":
				args.push("-fd")
				break
			case "nxdn":
				// NXDN96 (12.5 kHz)
				args.push("-fn")
				break
			case "provoice":
				args.push("-fp")
				break
			case "auto":
			default:
				// Auto-detection mode
				args.push("-fa")
				break
		}

		// Set output destination
		switch (this.options.output) {
			case "wav":
				if (this.options.wavDir) {
					args.push("-w", this.options.wavDir)
				}
				break
			case "udp":
				if (this.options.udpHost && this.options.udpPort) {
					args.push("-o", `udp:${this.options.udpHost}:${this.options.udpPort}`)
				}
				break
			case "null":
			default:
				// Disable audio output to avoid PulseAudio issues
				args.push("-o", "null")
				break
		}

		// Add any extra arguments
		if (this.options.extraArgs) {
			args.push(...this.options.extraArgs)
		}

		return args
	}
	/**
	 * Returns the decoder's capabilities (Requirement 17.1).
	 * DSD-FME now consumes IQ data (via AudioDemodDecoder's csdr pipeline).
	 */
	protected override getCaps(): DecoderCaps {
		return {
			input: "iq",
			wantsExclusiveSource: false,
			preferredSampleRates: [48000],
			output: "text",
			integrationPattern: "pure_consumer",
		}
	}
	/**
	 * Parses dsd-fme output lines into DecoderOutput objects.
	 *
	 * Handles:
	 * - Sync events (Requirement 6.2)
	 * - Call events (Requirement 6.3)
	 * - Error events (Requirement 6.4)
	 */
	protected override parseOutput(line: string): DecoderOutput | null {
		// Check for sync information (Requirement 6.2)
		const syncMatch = SYNC_PATTERN.exec(line)
		if (syncMatch) {
			const mode = syncMatch[1]?.toUpperCase()
			const slot = syncMatch[2] ? parseInt(syncMatch[2], 10) : undefined

			return {
				timestamp: new Date(),
				decoder: this.id,
				type: "sync",
				data: {
					mode,
					slot,
				},
			}
		}

		// Check for call information (Requirement 6.3)
		const callMatch = CALL_PATTERN.exec(line)
		if (callMatch) {
			const talkgroup = parseInt(callMatch[1] ?? "0", 10)
			const source = parseInt(callMatch[2] ?? "0", 10)

			return {
				timestamp: new Date(),
				decoder: this.id,
				type: "call",
				data: {
					talkgroup,
					source,
				},
			}
		}

		// Check for error conditions (Requirement 6.4)
		const errorMatch = ERROR_PATTERN.exec(line)
		if (errorMatch) {
			return {
				timestamp: new Date(),
				decoder: this.id,
				type: "error",
				data: {
					message: errorMatch[1],
				},
			}
		}

		// Line didn't match any known pattern - skip it
		return null
	}
}

/**
 * Factory function for creating DSD-FME decoder instances.
 * Used by the DecoderRegistry.
 */
export function createDsdFmeDecoder(
	config: DecoderConfig,
	logger: Logger,
): DsdFmeDecoder {
	return new DsdFmeDecoder(config, logger)
}

/**
 * Capabilities for the DSD-FME decoder.
 * Used when registering with the DecoderRegistry.
 */
export const DSD_FME_CAPS: DecoderCaps = {
	input: "iq",
	wantsExclusiveSource: false,
	preferredSampleRates: [48000],
	output: "text",
	integrationPattern: "pure_consumer",
}
