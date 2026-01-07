/**
 * DSD-FME Decoder - Digital voice signal decoder
 *
 * Requirements:
 * - 6.1: WHEN started, THE DSD_Decoder SHALL spawn dsd-fme with the configured mode and options
 * - 6.2: WHEN dsd-fme outputs sync information, THE DSD_Decoder SHALL parse it into structured sync events
 * - 6.3: WHEN dsd-fme decodes a call, THE DSD_Decoder SHALL emit call events with talkgroup, source, and duration
 * - 6.4: WHEN dsd-fme encounters errors, THE DSD_Decoder SHALL emit error events with the error message
 * - 6.5: THE DSD_Decoder SHALL support modes: auto, dmr, p25, ysf, dstar, nxdn, provoice
 */

import { BaseDecoder } from "../base-decoder.js"
import type { DecoderCaps, DecoderConfig, DecoderOutput } from "../types.js"
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
 */
export class DsdFmeDecoder extends BaseDecoder {
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
		}
	}

	/**
	 * Returns the shell command (Requirement 6.1).
	 * We use /bin/sh to pipe stdin to dsd-fme, ensuring stdin stays open.
	 */
	protected getCommand(): string {
		return "/bin/sh"
	}

	/**
	 * Returns command line arguments for dsd-fme (Requirement 6.1).
	 * Constructs a shell command that pipes stdin to dsd-fme.
	 */
	protected getArgs(): string[] {
		const dsdArgs: string[] = ["dsd-fme"]

		// Input from stdin
		dsdArgs.push("-i", "/dev/stdin")

		// Set decoder mode with explicit flag
		switch (this.options.mode) {
			case "dmr":
				// DMR TDMA BS and MS Simplex
				dsdArgs.push("-fs")
				break
			case "p25":
				// P25 Phase 1
				dsdArgs.push("-f1")
				break
			case "ysf":
				dsdArgs.push("-fy")
				break
			case "dstar":
				dsdArgs.push("-fd")
				break
			case "nxdn":
				// NXDN96 (12.5 kHz)
				dsdArgs.push("-fn")
				break
			case "provoice":
				dsdArgs.push("-fp")
				break
			case "auto":
			default:
				// Auto-detection mode
				dsdArgs.push("-fa")
				break
		}

		// Set output destination
		switch (this.options.output) {
			case "wav":
				if (this.options.wavDir) {
					dsdArgs.push("-w", this.options.wavDir)
				}
				break
			case "udp":
				if (this.options.udpHost && this.options.udpPort) {
					dsdArgs.push(
						"-o",
						`udp:${this.options.udpHost}:${this.options.udpPort}`,
					)
				}
				break
			case "null":
			default:
				// Disable audio output to avoid PulseAudio issues
				dsdArgs.push("-o", "null")
				break
		}

		// Add any extra arguments
		if (this.options.extraArgs) {
			dsdArgs.push(...this.options.extraArgs)
		}

		// Use cat to pipe stdin to dsd-fme - this keeps stdin open
		// The shell wrapper ensures dsd-fme receives a continuous stream
		const cmd = `cat | ${dsdArgs.join(" ")}`

		return ["-c", cmd]
	}

	/**
	 * Returns the decoder's capabilities (Requirement 17.1).
	 * DSD-FME is a pure consumer that accepts PCM audio and outputs text.
	 */
	protected getCaps(): DecoderCaps {
		return {
			input: "audio_pcm",
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
	protected parseOutput(line: string): DecoderOutput | null {
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
	input: "audio_pcm",
	wantsExclusiveSource: false,
	preferredSampleRates: [48000],
	output: "text",
	integrationPattern: "pure_consumer",
}
