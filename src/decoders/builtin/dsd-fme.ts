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
import type { DecoderConfig, DecoderOutput } from "../types.js"
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
	 * Returns the dsd-fme command (Requirement 6.1).
	 */
	protected getCommand(): string {
		return "dsd-fme"
	}

	/**
	 * Returns command line arguments for dsd-fme (Requirement 6.1).
	 */
	protected getArgs(): string[] {
		const args: string[] = []

		// Input from stdin
		args.push("-i", "-")

		// Set decoder mode
		switch (this.options.mode) {
			case "dmr":
				args.push("-fd")
				break
			case "p25":
				args.push("-fp")
				break
			case "ysf":
				args.push("-fy")
				break
			case "dstar":
				args.push("-fs")
				break
			case "nxdn":
				args.push("-fn")
				break
			case "provoice":
				args.push("-fv")
				break
			case "auto":
			default:
				// Auto mode - no specific flag needed
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
					args.push("-u", `${this.options.udpHost}:${this.options.udpPort}`)
				}
				break
			case "null":
			default:
				args.push("-o", "/dev/null")
				break
		}

		// Add any extra arguments
		if (this.options.extraArgs) {
			args.push(...this.options.extraArgs)
		}

		return args
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
