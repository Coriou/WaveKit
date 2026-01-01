/**
 * RTL_433 Decoder - ISM band signal decoder
 *
 * Requirements:
 * - 8.1: WHEN started, THE RTL433_Decoder SHALL spawn rtl_433 with the configured options
 * - 8.2: WHEN rtl_433 decodes a signal, THE RTL433_Decoder SHALL parse it into structured signal events
 * - 8.3: THE RTL433_Decoder SHALL support protocol filtering and analyze mode
 */

import { BaseDecoder } from "../base-decoder.js"
import type { DecoderConfig, DecoderOutput } from "../types.js"
import type { Logger } from "../../utils/logger.js"

/** Output format options for rtl_433 */
export type Rtl433OutputFormat = "json" | "csv"

/**
 * Configuration options for the RTL_433 decoder.
 */
export interface Rtl433Options {
	/** Enable analyze mode for unknown signals */
	analyze?: boolean | undefined
	/** List of protocol IDs to enable (empty = all protocols) */
	protocols?: number[] | undefined
	/** Output format (json recommended for parsing) */
	outputFormat?: Rtl433OutputFormat | undefined
	/** Sample rate in Hz */
	sampleRate?: number | undefined
	/** Additional command line arguments */
	extraArgs?: string[] | undefined
}

/**
 * RTL_433 Decoder - Decodes ISM band signals.
 *
 * Supports weather sensors, tire pressure monitors, and other ISM band devices.
 * Uses JSON output format for structured parsing of decoded signals.
 */
export class Rtl433Decoder extends BaseDecoder {
	private readonly options: Rtl433Options

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
		this.options = this.parseOptions(config.options)
	}

	/**
	 * Parses and validates decoder options from config.
	 */
	private parseOptions(options: Record<string, unknown>): Rtl433Options {
		return {
			analyze: options["analyze"] as boolean | undefined,
			protocols: options["protocols"] as number[] | undefined,
			outputFormat:
				(options["outputFormat"] as Rtl433OutputFormat | undefined) ?? "json",
			sampleRate: options["sampleRate"] as number | undefined,
			extraArgs: options["extraArgs"] as string[] | undefined,
		}
	}

	/**
	 * Returns the rtl_433 command (Requirement 8.1).
	 */
	protected getCommand(): string {
		return "rtl_433"
	}

	/**
	 * Returns command line arguments for rtl_433 (Requirement 8.1, 8.3).
	 */
	protected getArgs(): string[] {
		const args: string[] = []

		// Read from stdin (piped audio data)
		args.push("-r", "-")

		// Set output format to JSON for structured parsing (Requirement 8.2)
		if (this.options.outputFormat === "json") {
			args.push("-F", "json")
		} else if (this.options.outputFormat === "csv") {
			args.push("-F", "csv")
		}

		// Enable analyze mode for unknown signals (Requirement 8.3)
		if (this.options.analyze) {
			args.push("-A")
		}

		// Protocol filtering (Requirement 8.3)
		if (this.options.protocols && this.options.protocols.length > 0) {
			// First disable all protocols, then enable specific ones
			args.push("-G", "0") // Disable all protocols
			for (const protocol of this.options.protocols) {
				args.push("-R", String(protocol))
			}
		}

		// Set sample rate if specified
		if (this.options.sampleRate) {
			args.push("-s", String(this.options.sampleRate))
		}

		// Add any extra arguments
		if (this.options.extraArgs) {
			args.push(...this.options.extraArgs)
		}

		return args
	}

	/**
	 * Parses rtl_433 output lines into DecoderOutput objects (Requirement 8.2).
	 *
	 * rtl_433 with -F json outputs one JSON object per line for each decoded signal.
	 * Each JSON object contains device-specific fields like model, id, temperature, etc.
	 */
	protected parseOutput(line: string): DecoderOutput | null {
		const trimmedLine = line.trim()

		// Skip empty lines
		if (!trimmedLine) {
			return null
		}

		// Try to parse as JSON (Requirement 8.2)
		if (trimmedLine.startsWith("{")) {
			try {
				const parsed: unknown = JSON.parse(trimmedLine)

				return {
					timestamp: new Date(),
					decoder: this.id,
					type: "signal",
					data: parsed,
				}
			} catch {
				// JSON parse failed - log and skip
				this.logger.debug({ line: trimmedLine }, "Failed to parse JSON output")
				return null
			}
		}

		// Non-JSON output (e.g., status messages, errors) - skip
		return null
	}
}

/**
 * Factory function for creating RTL_433 decoder instances.
 * Used by the DecoderRegistry.
 */
export function createRtl433Decoder(
	config: DecoderConfig,
	logger: Logger,
): Rtl433Decoder {
	return new Rtl433Decoder(config, logger)
}
