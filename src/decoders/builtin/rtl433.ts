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
	iqDecimationRates,
	readChannelHz,
	type IqDecimationConfig,
} from "../iq-decimate-decoder.js"
import type {
	DecoderCaps,
	DecoderConfig,
	DecoderOutput,
	DecoderRateRequirements,
} from "../types.js"
import type { Logger } from "../../utils/logger.js"
import {
	readExtraArgsOption,
	readNumericArrayOption,
	readNumericOption,
} from "../option-values.js"
import {
	RTL433_INPUT_SAMPLE_RATE_MAX_HZ,
	RTL433_INPUT_SAMPLE_RATE_MIN_HZ,
	RTL433_PROTOCOLS_MAX,
	RTL433_PROTOCOL_ID_MAX,
	RTL433_TARGET_SAMPLE_RATE_MAX_HZ,
	RTL433_TARGET_SAMPLE_RATE_MIN_HZ,
} from "../options/rtl433.js"

/** Output format options for rtl_433 */
export type Rtl433OutputFormat = "json" | "csv"

/**
 * Configuration options for the RTL_433 decoder.
 */
export interface Rtl433Options {
	/** Enable analyze mode for unknown signals */
	analyze?: boolean | undefined
	/** List of protocol IDs to enable (empty = rtl_433 default-enabled protocols) */
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
	/** RF centre of the IQ on stdin (capture or channel centre), injected by the manager */
	inputCenterFreq?: number | undefined
	/**
	 * `"cf32"`: stdin is complex float32 IQ already centred and at `inputSampleRate` (a replayed
	 * scanner capture); rtl_433 reads it directly with no decimation stage. Anything else: CU8.
	 */
	inputIqFormat?: "cf32" | "cu8" | undefined
}

/**
 * Bounds of the stdin centre passed as `-f`: 1 kHz to 6 GHz covers every
 * SDR front end WaveKit reads (an RTL-SDR tops out near 1.8 GHz).
 */
export const RTL433_CENTRE_MIN_HZ = 1_000
export const RTL433_CENTRE_MAX_HZ = 6_000_000_000

const centreOption = (v: unknown): number | undefined =>
	typeof v === "number" &&
	Number.isFinite(v) &&
	v >= RTL433_CENTRE_MIN_HZ &&
	v <= RTL433_CENTRE_MAX_HZ
		? v
		: undefined

/** Default target sample rate for rtl_433 (1 MHz provides good protocol coverage) */
const DEFAULT_TARGET_SAMPLE_RATE = 1_000_000

/** Default IQ input sample rate */
const DEFAULT_INPUT_SAMPLE_RATE = 2_048_000

/**
 * The rtl_433 channel rate the planner aims for (3.16): a valid configured
 * `targetSampleRate`, else 1 MHz. C/T meter channel coverage can raise it to
 * the protocol minimum of 1.2 Msps (100 kbps × 12 samples/bit).
 */
export function rtl433TargetRateHz(options: Record<string, unknown>): number {
	const raw = options["targetSampleRate"]
	return typeof raw === "number" &&
		Number.isFinite(raw) &&
		raw >= RTL433_TARGET_SAMPLE_RATE_MIN_HZ &&
		raw <= RTL433_TARGET_SAMPLE_RATE_MAX_HZ
		? raw
		: DEFAULT_TARGET_SAMPLE_RATE
}

/** `-Y` values that set rtl_433's pulse detection level. */
const DETECTION_LEVEL_SETTINGS = /^(?:level=|minlevel=|autolevel$)/

/**
 * True when `extraArgs` already sets rtl_433's detection level
 * (`-Y level=`, `-Y minlevel=` or `-Y autolevel`, also as `-Y<value>`);
 * the decoder then leaves the level to the operator. Pure.
 */
export function rtl433DetectionLevelConfigured(
	extraArgs: readonly string[] | undefined,
): boolean {
	if (!extraArgs) return false
	return extraArgs.some((arg, i) => {
		if (arg === "-Y")
			return DETECTION_LEVEL_SETTINGS.test(extraArgs[i + 1] ?? "")
		return arg.startsWith("-Y") && DETECTION_LEVEL_SETTINGS.test(arg.slice(2))
	})
}

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
		// A cf32 replay is read at its own rate: nothing decimates it.
		if (this.options.inputIqFormat === "cf32")
			return this.options.inputSampleRate ?? DEFAULT_INPUT_SAMPLE_RATE
		// Same helper as the pipeline and getRateAdapter(): integer decimation.
		return iqDecimationRates(this.boundedIqDecimationConfig()).outputRate
	}

	/**
	 * rtl_433's capture and protocol needs are an evidence gap (no fixtures),
	 * so only the stdin domain is declared and the verdict stays unknown.
	 */
	getRateRequirements(): DecoderRateRequirements {
		return {
			version: 1,
			sourceKind: "iq",
			decoderInput: {
				kind: "iq",
				format: "cu8",
				preferredHz:
					this.options.targetSampleRate ?? DEFAULT_TARGET_SAMPLE_RATE,
			},
		}
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
		// WG7 HW.2: numbers are read by meaning (bounded, finite) before they
		// become -R/-s arguments or part of the csdr shell pipeline.
		const warn = this.optionWarn
		return {
			analyze: options["analyze"] as boolean | undefined,
			protocols: readNumericArrayOption(
				options["protocols"],
				{
					key: "protocols",
					integer: true,
					min: 0,
					max: RTL433_PROTOCOL_ID_MAX,
				},
				RTL433_PROTOCOLS_MAX,
				warn,
			),
			outputFormat:
				(options["outputFormat"] as Rtl433OutputFormat | undefined) ?? "json",
			// An exact 0 stays "absent" (the default rate), as before.
			inputSampleRate: readNumericOption(
				options["inputSampleRate"] === 0
					? undefined
					: options["inputSampleRate"],
				{
					key: "inputSampleRate",
					integer: false,
					min: RTL433_INPUT_SAMPLE_RATE_MIN_HZ,
					max: RTL433_INPUT_SAMPLE_RATE_MAX_HZ,
				},
				warn,
			),
			targetSampleRate: readNumericOption(
				options["targetSampleRate"],
				{
					key: "targetSampleRate",
					integer: false,
					min: RTL433_TARGET_SAMPLE_RATE_MIN_HZ,
					max: RTL433_TARGET_SAMPLE_RATE_MAX_HZ,
				},
				warn,
			),
			extraArgs: readExtraArgsOption(options["extraArgs"], warn),
			// Injected by the manager, never clamped: a wrong centre would make
			// rtl_433's freq wrong, so an out-of-bounds one is left out.
			inputCenterFreq: centreOption(options["inputCenterFreq"]),
			inputIqFormat: options["inputIqFormat"] === "cf32" ? "cf32" : "cu8",
		}
	}

	/**
	 * A cf32 replay (scanner IQ capture) is centred, filtered and at its final rate already:
	 * rtl_433 reads stdin directly. Otherwise the csdr decimation pipeline of the base class.
	 */
	protected override buildPipelineCommand(): string {
		if (this.options.inputIqFormat === "cf32")
			return this.buildDirectDecoderCommand()
		return super.buildPipelineCommand()
	}

	protected override getDecoderInputFormat(): string {
		return this.options.inputIqFormat === "cf32" ? "cf32" : "cu8"
	}

	/** RF centre of stdin: a cf32 replay is centred on its channel; else the injected centre. */
	private stdinCentreHz(): number | undefined {
		if (this.options.inputIqFormat === "cf32") {
			const channelHz = centreOption(readChannelHz(this.config.options))
			if (channelHz !== undefined) return channelHz
		}
		return this.options.inputCenterFreq
	}

	/** Migrated to the opt-in core channelizer (addendum §7 step 3). */
	protected override channelizerSupported(): boolean {
		return true
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

		// Read CU8 (unsigned 8-bit complex IQ) from stdin, or cf32 for a replayed capture
		args.push("-r", this.options.inputIqFormat === "cf32" ? "cf32:-" : "cu8:-")

		// CRITICAL: Tell rtl_433 the sample rate of incoming IQ data
		// This is the DECIMATED rate, not the original source rate
		args.push("-s", String(this.effectiveTargetRate))

		// Set output format to JSON for structured parsing (Requirement 8.2)
		if (this.options.outputFormat === "json") {
			args.push("-F", "json")
		} else if (this.options.outputFormat === "csv") {
			args.push("-F", "csv")
		}

		// rtl_433's fixed default level drops OOK pulses weaker than about
		// -17 dBFS: rtl_433 25.12 decodes a PWM remote at 0.2 of full scale
		// (-14 dBFS) but nothing at 0.1 (-20 dBFS) over 0.01 noise, through the
		// raw capture and the channel alike. A real receiver at a moderate gain
		// shows such bursts at -20 to -40 dBFS, plainly on a waterfall.
		// autolevel sets the level from rtl_433's own noise estimate (the same
		// 0.1 burst decodes 6 of 6 frames). An operator `-Y` level wins.
		if (!rtl433DetectionLevelConfigured(this.options.extraArgs)) {
			args.push("-Y", "autolevel")
		}

		// The stdin centre makes rtl_433's `freq` estimate absolute (MHz), and
		// `-M level` adds it (with rssi/snr/noise) to every event; the scanner
		// uses it to tell signals in one channel apart. In file mode `-f` is
		// metadata only: it changes no demodulation.
		// An operator `-f` in extraArgs wins (two would form a hop list).
		const centreHz = this.stdinCentreHz()
		if (
			centreHz !== undefined &&
			!(this.options.extraArgs ?? []).some(
				a => a === "-f" || a.startsWith("-f"),
			)
		) {
			args.push("-f", String(Math.round(centreHz)))
		}
		args.push("-M", "level")

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
				// Decoder output line: documented diagnostic exception to the no-option-text log rule (Main, WG7 HW R2).
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
