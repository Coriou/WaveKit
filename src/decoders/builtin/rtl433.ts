/**
 * RTL_433 Decoder - ISM band signal decoder
 *
 * Requirements:
 * - 8.1: WHEN started, THE RTL433_Decoder SHALL spawn rtl_433 with the configured options
 * - 8.2: WHEN rtl_433 decodes a signal, THE RTL433_Decoder SHALL parse it into structured signal events
 * - 8.3: THE RTL433_Decoder SHALL support protocol filtering and analyze mode
 *
 * This decoder extends IqDecimateDecoder to automatically decimate high sample rate
 * IQ data (e.g., 2.048 Msps) down to rtl_433's preferred rate (250 kHz or 1 MHz).
 */

import {
	IqDecimateDecoder,
	type IqDecimationConfig,
} from "../iq-decimate-decoder.js"
import type { DecoderCaps, DecoderConfig, DecoderOutput } from "../types.js"
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
	/** IQ input sample rate in Hz from the source (e.g., 2048000) */
	inputSampleRate?: number | undefined
	/**
	 * Target sample rate for rtl_433 processing in Hz.
	 * rtl_433 works best at 250000 (250 kHz) or 1000000 (1 MHz).
	 * Default: 1000000 (1 MHz) for wider protocol coverage.
	 */
	targetSampleRate?: number | undefined
	/** Additional command line arguments */
	extraArgs?: string[] | undefined
}

/** Default target sample rate for rtl_433 (1 MHz provides good protocol coverage) */
const DEFAULT_TARGET_SAMPLE_RATE = 1_000_000

/** Default IQ input sample rate */
const DEFAULT_INPUT_SAMPLE_RATE = 2_048_000

/**
 * RTL_433 Decoder - Decodes ISM band signals.
 *
 * Supports weather sensors, tire pressure monitors, and other ISM band devices.
 * Uses JSON output format for structured parsing of decoded signals.
 *
 * Automatically decimates high sample rate IQ data to rtl_433's preferred rate
 * using csdr, reducing CPU usage and improving decoding performance.
 */
export class Rtl433Decoder extends IqDecimateDecoder {
	private options: Rtl433Options
	private effectiveTargetRate: number

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
		this.options = this.parseOptions(config.options)
		this.effectiveTargetRate = this.calculateEffectiveTargetRate()
	}

	/**
	 * Calculates the effective target sample rate after integer decimation.
	 */
	private calculateEffectiveTargetRate(): number {
		const inputRate = this.options.inputSampleRate ?? DEFAULT_INPUT_SAMPLE_RATE
		const targetRate =
			this.options.targetSampleRate ?? DEFAULT_TARGET_SAMPLE_RATE

		// Decimation must be integer, so actual output rate may differ
		const decimation = Math.round(inputRate / targetRate)
		return decimation > 0 ? inputRate / decimation : inputRate
	}

	/**
	 * Re-parses options when updated dynamically (e.g., sample rate change).
	 * Called by BaseDecoder.updateOptions().
	 */
	protected override onOptionsUpdated(): void {
		this.options = this.parseOptions(this.config.options)
		this.effectiveTargetRate = this.calculateEffectiveTargetRate()
		this.logger.debug(
			{
				inputSampleRate: this.options.inputSampleRate,
				effectiveTargetRate: this.effectiveTargetRate,
			},
			"RTL_433 options re-parsed after update",
		)
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
			inputSampleRate: options["inputSampleRate"] as number | undefined,
			targetSampleRate: options["targetSampleRate"] as number | undefined,
			extraArgs: options["extraArgs"] as string[] | undefined,
		}
	}

	/**
	 * Returns the IQ decimation configuration.
	 * rtl_433 works best at 250 kHz - 1 MHz sample rates.
	 */
	protected getIqDecimationConfig(): IqDecimationConfig {
		return {
			inputSampleRate:
				this.options.inputSampleRate ?? DEFAULT_INPUT_SAMPLE_RATE,
			targetSampleRate:
				this.options.targetSampleRate ?? DEFAULT_TARGET_SAMPLE_RATE,
			filterTransition: 0.05,
		}
	}

	/**
	 * Returns the rtl_433 command (Requirement 8.1).
	 */
	protected getDecoderCommand(): string {
		return "rtl_433"
	}

	/**
	 * Returns command line arguments for rtl_433 (Requirement 8.1, 8.3).
	 *
	 * rtl_433 file input format:
	 * - Use 'cu8:-' to read unsigned 8-bit complex IQ from stdin
	 * - Format must be specified with colon prefix (e.g., 'cu8:', 'cs16:', 'cf32:')
	 * - The '-' after the colon means read from stdin
	 */
	protected getDecoderArgs(): string[] {
		const args: string[] = []

		// Read CU8 (unsigned 8-bit complex IQ) from stdin
		args.push("-r", "cu8:-")

		// CRITICAL: Tell rtl_433 the sample rate of incoming IQ data
		// This is the DECIMATED rate, not the original source rate
		args.push("-s", String(this.effectiveTargetRate))

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

		// Add any extra arguments
		if (this.options.extraArgs) {
			args.push(...this.options.extraArgs)
		}

		return args
	}

	/**
	 * Returns the decoder's capabilities (Requirement 17.1).
	 * RTL_433 is a pure consumer that accepts IQ data and outputs JSON.
	 */
	protected override getCaps(): DecoderCaps {
		return {
			input: "iq",
			wantsExclusiveSource: false,
			preferredSampleRates: [250000, 1000000],
			output: "jsonl",
			integrationPattern: "pure_consumer",
		}
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

/**
 * Capabilities for the RTL_433 decoder.
 * Used when registering with the DecoderRegistry.
 */
export const RTL433_CAPS: DecoderCaps = {
	input: "iq",
	wantsExclusiveSource: false,
	preferredSampleRates: [250000, 1000000],
	output: "jsonl",
	integrationPattern: "pure_consumer",
}
