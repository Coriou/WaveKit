/**
 * Audio Demod Decoder - Abstract base class for decoders that consume IQ and demodulate to audio
 *
 * This decoder type receives U8 IQ data from an rtl_tcp/rtlmux source and uses csdr
 * to perform FM demodulation before passing the audio to the actual decoder process.
 *
 * This pattern solves the problem of SDR++ audio filtering corrupting digital signals
 * by giving each decoder optimally demodulated audio with the correct bandwidth and
 * no unwanted de-emphasis.
 *
 * The csdr pipeline: IQ → FM demod → decimation → S16LE audio → decoder stdin
 *
 * Subclasses only need to implement:
 * - getDemodConfig(): Return preferred demodulation settings
 * - getDecoderCommand(): Return the decoder executable
 * - getDecoderArgs(): Return decoder-specific arguments
 * - parseOutput(): Parse decoder output into DecoderOutput
 *
 * Debug Recording:
 * Set `options.debugRecordPath` to a directory path to save demodulated audio for debugging.
 * The decoder will use `tee` to save the audio to WAV files at different pipeline stages.
 */

import { z } from "zod"
import { shellCommand } from "./process-tools.js"
import { boundCsdrPipeline } from "./csdr-buffers.js"
import {
	channelDecimationStage,
	channelFilterPlan,
	deemphasisStage,
	shiftStage,
	validateChannelOffset,
} from "./csdr-stages.js"
import { BaseDecoder } from "./base-decoder.js"
import { readChannelHz } from "./iq-decimate-decoder.js"
import { configuredBandRequirements } from "./status-fields.js"
import type {
	DecoderBandDeclaration,
	DecoderCaps,
	DecoderConfig,
	DecoderOutput,
	DecoderRateAdapter,
	DecoderRateRequirements,
	DemodulationConfig,
} from "./types.js"
import type {
	DecoderChannelRequest,
	DecoderChannelRequestResult,
} from "../core/channelizer/types.js"
import type { Logger } from "../utils/logger.js"

/** Debug recording options for capturing audio at pipeline stages */
interface DebugRecordingOptions {
	/** Directory to save debug audio recordings */
	path: string
	/** Which stages to record: 'demod' (after FM demod), 'final' (after all processing), 'both' */
	stages?: "demod" | "final" | "both"
}

/** Decoder option `offsetHz`: channel offset from the tuned centre in Hz. */
const OffsetHzSchema = z.number().finite().optional()

/**
 * Default IQ sample rate from rtlmux (2.4 Msps)
 */
const DEFAULT_IQ_SAMPLE_RATE = 2_400_000

/** What the decoder program reads on stdin after the demod pipeline. */
export interface AudioDecoderStdin {
	/** e.g. "s16le" (raw S16LE mono) or "wav-s16le" (sox WAV wrapper) */
	format: string
	rateHz: number
}

/**
 * Integer decimation the audio pipeline really performs. The factor is
 * clamped to 1: below half the demod rate round() would give 0, an invalid
 * `csdr firdecimate 0` and a sox rate of Infinity (a crash loop).
 */
export function audioDemodRates(config: DemodulationConfig): {
	inputSampleRate: number
	targetDemodRate: number
	decimation: number
	actualDemodRate: number
} {
	const targetDemodRate = config.demodSampleRate ?? config.sampleRate
	const inputSampleRate = config.inputSampleRate || DEFAULT_IQ_SAMPLE_RATE
	const decimation = Math.max(1, Math.round(inputSampleRate / targetDemodRate))
	return {
		inputSampleRate,
		targetDemodRate,
		decimation,
		actualDemodRate: inputSampleRate / decimation,
	}
}

/** Adapter facts for a candidate source rate `fs`; pure. */
export function audioDemodRateAdapter(
	config: DemodulationConfig,
	stdin: AudioDecoderStdin,
	fs: number,
): DecoderRateAdapter {
	return {
		adaptation: "integer-decimation",
		frontendRateHz: audioDemodRates({ ...config, inputSampleRate: fs })
			.actualDemodRate,
		decoderInputKind: "audio_pcm",
		decoderInputRateHz: stdin.rateHz,
		decoderInputFormat: stdin.format,
	}
}

/**
 * Addendum §2 request for the cf32 audio tail at the exact demod rate. Pure.
 * An explicit filterTransition keeps the plan formula relative to the output
 * rate (plan A11); otherwise the passband is the one the raw path's matched
 * firdecimate realises (channelFilterPlan), so the two cannot disagree.
 */
export function audioChannelRequest(
	config: DemodulationConfig,
	input: { sampleRateHz: number; centerHz?: number },
): DecoderChannelRequest {
	const outputRateHz = config.demodSampleRate ?? config.sampleRate
	let bandwidthHz: number
	let transitionHz: number
	if (config.filterTransition !== undefined) {
		const t = config.filterTransition
		bandwidthHz = outputRateHz * (1 - t)
		transitionHz = (outputRateHz * t) / 2
	} else {
		const p = channelFilterPlan(outputRateHz, 1, config.bandwidth)
		bandwidthHz = 2 * p.passbandHz
		transitionHz = p.stopbandHz - p.passbandHz
	}
	return {
		centerHz: config.channelHz ?? input.centerHz ?? 0,
		bandwidthHz,
		transitionHz,
		outputRateHz,
		format: "cf32",
	}
}

/** Rate at which every built-in audio demod rate divides exactly. */
const PREFERRED_CAPTURE_RATE = 2_400_000

/**
 * Declaration for the audio family. The only capture minimum is the adapter
 * fact: below the demod rate the decimator is 1, the demodulator runs at the
 * source rate and sox upsamples, so the demod bandwidth is not realised.
 */
export function audioDemodRateRequirements(
	config: DemodulationConfig,
	stdin: AudioDecoderStdin,
): DecoderRateRequirements {
	const demodRate = config.demodSampleRate ?? config.sampleRate
	return {
		version: 1,
		sourceKind: "iq",
		capture: {
			accepted: [{ kind: "range", minHz: demodRate }],
			preferredHz:
				PREFERRED_CAPTURE_RATE % demodRate === 0
					? [PREFERRED_CAPTURE_RATE]
					: [],
			minimum: {
				hz: demodRate,
				basis: "implementation",
				evidence: `audio-demod-decoder.ts audioDemodRates: below the ${demodRate} Hz demod rate the integer decimator is 1, the demodulator runs at the source rate and sox upsamples, so the ${demodRate} Hz demod bandwidth is not realised.`,
			},
		},
		decoderInput: {
			kind: "audio_pcm",
			format: stdin.format,
			preferredHz: stdin.rateHz,
			accepted: [{ kind: "discrete", valuesHz: [stdin.rateHz] }],
		},
	}
}

/**
 * Generates a timestamped filename for debug recordings.
 */
function getDebugFilename(
	decoderId: string,
	stage: string,
	ext: string,
): string {
	const now = new Date()
	const ts = now
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace("T", "_")
		.slice(0, 19)
	return `${ts}_${decoderId}_${stage}.${ext}`
}

/**
 * AudioDemodDecoder - Abstract base class for decoders that need FM-demodulated audio from IQ.
 *
 * This class handles the csdr FM demodulation pipeline, allowing subclasses to focus
 * only on decoder-specific logic. The pipeline converts U8 IQ data to S16LE audio
 * at the decoder's preferred sample rate.
 *
 * Uses the Template Method pattern where subclasses implement:
 * - getDemodConfig(): Return preferred FM demodulation settings
 * - getDecoderCommand(): Return the decoder executable name
 * - getDecoderArgs(): Return decoder-specific command line arguments
 * - parseOutput(line): Parse decoder output into DecoderOutput objects
 *
 * Handles:
 * - Building csdr demodulation pipeline
 * - Sample rate conversion via fractional decimation
 * - Optional de-emphasis for analog signals
 * - Piping demodulated audio to decoder stdin
 * - Optional debug recording of audio at pipeline stages
 */
export abstract class AudioDemodDecoder extends BaseDecoder {
	/** Debug recording options if enabled */
	protected debugRecording?: DebugRecordingOptions
	private invalidOffsetLogged = false
	private channelOverridesOffsetLogged = false
	private unknownCentreLogged = false

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
		// Check for debug recording option
		const debugPath = config.options["debugRecordPath"] as string | undefined
		if (debugPath) {
			this.debugRecording = {
				path: debugPath,
				stages:
					(config.options["debugRecordStages"] as "demod" | "final" | "both") ??
					"both",
			}
			this.logger.info(
				{ debugPath, stages: this.debugRecording.stages },
				"Debug audio recording ENABLED - will save audio to files",
			)
		}
	}

	/**
	 * Template method: Returns the demodulation configuration.
	 * Subclasses must implement this to specify their preferred demod settings.
	 *
	 * @returns DemodulationConfig with bandwidth, sample rate, and de-emphasis settings
	 */
	protected abstract getDemodConfig(): DemodulationConfig

	/**
	 * Template method: Returns the decoder command to execute.
	 * Subclasses must implement this to return the decoder executable name.
	 *
	 * @returns Decoder executable name (e.g., "dsd-fme", "multimon-ng")
	 */
	protected abstract getDecoderCommand(): string

	/**
	 * Template method: Returns decoder-specific command line arguments.
	 * Subclasses must implement this to return the arguments for their decoder.
	 *
	 * @returns Array of command line arguments
	 */
	protected abstract getDecoderArgs(): string[]

	/**
	 * What the decoder program reads on stdin: raw S16LE mono at the demod
	 * config's output rate. Subclasses that wrap the audio override this.
	 */
	protected getDecoderStdin(): AudioDecoderStdin {
		return { format: "s16le", rateHz: this.getDemodConfig().sampleRate }
	}

	getRateRequirements(): DecoderRateRequirements {
		return audioDemodRateRequirements(
			this.getDemodConfig(),
			this.getDecoderStdin(),
		)
	}

	/**
	 * The pipeline keeps the capture centre: only configured targets are
	 * declared; the manager adds overrides and built-in defaults.
	 */
	getBandDeclaration(): DecoderBandDeclaration {
		const configured = configuredBandRequirements(this.config)
		return configured ? { configured } : {}
	}

	getRateAdapter(input: { sampleRateHz: number }): DecoderRateAdapter {
		return audioDemodRateAdapter(
			this.getDemodConfig(),
			this.getDecoderStdin(),
			input.sampleRateHz,
		)
	}

	/**
	 * Decoder option `offsetHz` (default 0): a carrier at centre + offsetHz is
	 * shifted to DC before decimation, away from the receiver's DC spike.
	 * A non-numeric value is ignored with a warning.
	 */
	protected getOffsetHz(): number {
		const parsed = OffsetHzSchema.safeParse(this.config.options["offsetHz"])
		if (parsed.success) return parsed.data ?? 0
		if (!this.invalidOffsetLogged) {
			this.invalidOffsetLogged = true
			this.logger.warn(
				{ offsetHz: this.config.options["offsetHz"] },
				"Ignoring invalid offsetHz option (expected a number of Hz)",
			)
		}
		return 0
	}

	/** Migration flag (addendum §7): flipped per decoder by Task 31. */
	protected channelizerSupported(): boolean {
		return false
	}

	/** The manager injects `inputIqFormat: "cf32"` when it feeds channel IQ. */
	protected inputIsChannelIq(): boolean {
		return this.config.options["inputIqFormat"] === "cf32"
	}

	getChannelRequest(input: {
		sampleRateHz: number
		centerHz?: number
	}): DecoderChannelRequestResult | undefined {
		if (!this.channelizerSupported()) return undefined
		const config = this.getDemodConfig()
		const channelHz = this.resolveChannelHz(
			config.channelHz ?? readChannelHz(this.config.options),
			input,
		)
		return audioChannelRequest({ ...config, channelHz }, input)
	}

	/**
	 * Channel centre (delta E7): an explicit channelHz wins; otherwise
	 * offsetHz is absorbed as capture centre + offsetHz, which follows
	 * retunes because every caps change recomputes the request. Undefined
	 * (offset 0) when the capture centre is unknown. `source` names where an
	 * explicit centre came from, for the override warning.
	 */
	protected resolveChannelHz(
		channelHz: number | undefined,
		input: { centerHz?: number },
		source = "channelHz",
	): number | undefined {
		const offsetHz = this.getOffsetHz()
		if (channelHz !== undefined) {
			if (offsetHz !== 0 && !this.channelOverridesOffsetLogged) {
				this.channelOverridesOffsetLogged = true
				this.logger.warn(
					{ channelHz, offsetHz, source },
					"The channel centre overrides offsetHz",
				)
			}
			return channelHz
		}
		if (input.centerHz === undefined) {
			if (!this.unknownCentreLogged) {
				this.unknownCentreLogged = true
				this.logger.info(
					{ offsetHz },
					"No channelHz and no capture centre; requesting offset 0",
				)
			}
			return undefined
		}
		return input.centerHz + offsetHz
	}

	/**
	 * Front of every IQ-to-audio chain: U8 IQ → float, optional shift of
	 * offsetHz to DC, then the decimating channel filter. An explicit
	 * filterTransition keeps the legacy firdecimate; otherwise the filter is
	 * matched to the channel bandwidth (see csdr-stages.ts).
	 *
	 * Channel IQ (cf32) arrives float, centred and at the demod rate, so all
	 * three stages are null: no offset check either, as a shift would move
	 * the centred channel twice (delta E8).
	 */
	protected buildIqFrontStages(
		config: DemodulationConfig,
		inputSampleRate: number,
		decimation: number,
	): {
		convert: string | null
		shift: string | null
		decimate: string | null
	} {
		if (this.inputIsChannelIq()) {
			return { convert: null, shift: null, decimate: null }
		}
		const offsetHz = this.getOffsetHz()
		if (offsetHz !== 0) {
			validateChannelOffset(offsetHz, inputSampleRate, config.bandwidth)
		}
		const cutoffArg = config.filterCutoff
			? ` --cutoff ${config.filterCutoff}`
			: ""
		return {
			convert: "csdr convert -i char -o float",
			shift: shiftStage(offsetHz, inputSampleRate),
			decimate:
				config.filterTransition !== undefined
					? `csdr firdecimate ${decimation} ${config.filterTransition}${cutoffArg}`
					: channelDecimationStage(
							inputSampleRate,
							decimation,
							config.bandwidth,
						),
		}
	}

	/**
	 * Returns the shell command for pipeline execution.
	 * Uses /bin/sh to execute the csdr pipeline string.
	 */
	protected override getCommand(): string {
		return "/bin/sh"
	}

	/**
	 * Builds the complete shell command with csdr demodulation pipeline.
	 * This is the core method that connects IQ → csdr → decoder.
	 *
	 * @returns Array with ["-c", "pipeline command string"]
	 */
	protected override getArgs(): string[] {
		const pipelineCommand = this.buildPipelineCommand()
		return ["-c", pipelineCommand]
	}

	/**
	 * Builds the complete csdr pipeline + decoder command.
	 *
	 * Pipeline stages (using jketterl/csdr v0.18+ syntax):
	 * 1. csdr convert -i char -o float - Convert U8 IQ pairs to Float32 complex
	 * 2. csdr firdecimate N - Decimate and filter (outputs complex)
	 * 3. csdr fmdemod - FM demodulation (quadrature) - outputs real float audio
	 * 4. csdr dcblock - Remove DC offset from demodulated audio
	 * 5. csdr gain X - Apply gain to normalize levels
	 * 6. csdr limit - Clamp values to prevent overflow
	 * 7. (optional) csdr deemphasis N - Apply de-emphasis for analog FM
	 * 8. csdr convert -i float -o s16 - Convert to S16LE PCM audio
	 * 9. (optional) tee for debug recording
	 * 10. decoder command with args
	 *
	 * CRITICAL: dcblock and limit operate on REAL float signals only.
	 * They must come AFTER fmdemod, not before.
	 *
	 * @returns Complete shell command string
	 */
	protected buildPipelineCommand(): string {
		const config = this.getDemodConfig()

		// Determine the rate at which demodulation happens (and thus the filter cutoff)
		// If demodSampleRate is provided, use it. Otherwise use output sampleRate.
		// This split allows tight filtering (low demod rate) with high output rate.
		const outputRate = config.sampleRate

		// Integer decimation (csdr firdecimate) to the ACTUAL demod rate; sox
		// must use that rate, not the configured one. Shared with the rate
		// adapter so the reported plan and the pipeline cannot diverge.
		const { inputSampleRate, targetDemodRate, decimation, actualDemodRate } =
			audioDemodRates(config)

		// Generate debug filenames if debug recording is enabled
		const debugDemodFile = this.debugRecording
			? `${this.debugRecording.path}/${getDebugFilename(this.config.id, "demod", "raw")}`
			: null
		const debugFinalFile = this.debugRecording
			? `${this.debugRecording.path}/${getDebugFilename(this.config.id, "final", "raw")}`
			: null
		const shouldRecordDemod =
			this.debugRecording &&
			(this.debugRecording.stages === "demod" ||
				this.debugRecording.stages === "both")
		const shouldRecordFinal =
			this.debugRecording &&
			(this.debugRecording.stages === "final" ||
				this.debugRecording.stages === "both")

		// Build csdr pipeline stages (Using jketterl/csdr v0.18+ syntax)
		// 1. Convert U8 IQ to Float (complex)
		// 2. (Optional) IQ-level AGC - normalizes complex envelope BEFORE decimation
		// 3. Decimate to demodRate with filtering (complex -> complex)
		// 4. FM Demodulate (complex -> real float audio)
		// 5. (Optional) Audio Lowpass Filter
		// 6. Remove DC offset from audio (real)
		// 7. (Optional) Audio-level AGC
		// 8. Apply gain (real)
		// 9. Limit amplitude to prevent clipping (real)

		const front = this.buildIqFrontStages(config, inputSampleRate, decimation)
		const csdrStages: string[] = []
		if (front.convert) csdrStages.push(front.convert) // U8 IQ -> complex float
		if (front.shift) csdrStages.push(front.shift) // offsetHz -> DC

		// Optional IQ-level AGC - applied BEFORE decimation and FM demod
		// This normalizes the complex envelope without affecting FM frequency content.
		// Critical for weak signal reception when hardware AGC is disabled.
		// Uses 'slow' profile to avoid distorting signal dynamics.
		if (config.enableIqAgc) {
			csdrStages.push("csdr agc -f complex -p slow -r 0.7")
		}

		if (front.decimate) csdrStages.push(front.decimate) // Decimate + filter (complex)

		if (config.modulation === "am") {
			csdrStages.push(
				"csdr amdemod", // AM demod: complex -> real envelope (jketterl/csdr syntax)
				"csdr agc -f float -p fast -r 0.8", // AM needs AGC for envelope normalization
			)
		} else {
			csdrStages.push("csdr fmdemod") // FM demod: complex -> real audio
		}

		// Optional Audio Lowpass Filter (e.g. 3000Hz)
		// Applied after demod but before DC block/Gain to clean noise
		if (config.audioLowPass) {
			// Calculate normalized cutoff (0.0 - 0.5) relative to sample rate
			// 0.5 = Nyquist (Fs/2).
			const normalizedCutoff = config.audioLowPass / actualDemodRate
			csdrStages.push(`csdr lowpass -f float ${normalizedCutoff.toFixed(4)}`)
		}

		// Optional DC block (skip for FSK/POCSAG signals as it distorts them)
		if (!config.skipDcBlock) {
			csdrStages.push("csdr dcblock")
		}

		// Optional software AGC - useful for weak signal decoders when hardware AGC is disabled
		// Uses slow profile to avoid distorting FSK symbols, reference 0.7 for headroom
		if (config.enableAgc) {
			csdrStages.push("csdr agc -f float -p slow -r 0.7")
		}

		csdrStages.push(
			`csdr gain ${config.fmGain ?? 10.0}`, // Apply gain (real)
			"csdr limit", // Prevent clipping (real audio)
		)

		// Optional de-emphasis for analog signals
		if (config.deEmphasis) {
			// Never a fractional/unsupported rate (the NFM FIR only exists at 5 rates)
			csdrStages.push(deemphasisStage("nfm", actualDemodRate).stage)
		}

		// Final conversion to S16LE (at demodRate)
		csdrStages.push("csdr convert -i float -o s16")

		// Join csdr stages
		let pipelineStr = boundCsdrPipeline(csdrStages, this.logger)

		// DEBUG: Record audio right after csdr demodulation (at demodRate)
		// Using simple tee to avoid bash-specific process substitution
		if (shouldRecordDemod && debugDemodFile) {
			// Simple tee to file - no process substitution needed
			pipelineStr += ` | ${shellCommand("tee", [debugDemodFile])}`
			this.logger.info(
				{ file: debugDemodFile, rate: actualDemodRate },
				"Debug recording DEMOD stage audio",
			)
		}

		// If actualDemodRate differs from outputRate, we need to resample
		// Use sox for high-quality resampling
		// CRITICAL: Use actualDemodRate (not configured rate) to match what csdr outputs
		if (actualDemodRate !== outputRate) {
			const soxResample = [
				"sox",
				"-t raw", // Input type
				`-r ${actualDemodRate}`, // Input rate - MUST match csdr output
				"-e signed -b 16 -c 1", // Input format (S16LE Mono)
				"-", // Input from stdin
				"-t raw", // Output type
				`-r ${outputRate}`, // Output rate
				"-", // Output to stdout
			].join(" ")

			pipelineStr += ` | ${soxResample}`
		}

		// DEBUG: Record audio at final stage (at outputRate, right before decoder)
		// Using simple tee to avoid bash-specific process substitution
		if (shouldRecordFinal && debugFinalFile) {
			pipelineStr += ` | ${shellCommand("tee", [debugFinalFile])}`
			this.logger.info(
				{ file: debugFinalFile, rate: outputRate },
				"Debug recording FINAL stage audio",
			)
		}

		// Build decoder command with args
		const decoderCommand = this.getDecoderCommand()
		const decoderArgs = this.getDecoderArgs()
		const decoderFullCommand =
			decoderArgs.length > 0
				? shellCommand(decoderCommand, decoderArgs)
				: decoderCommand

		// Combine into full pipeline
		const pipeline = `${pipelineStr} | ${decoderFullCommand}`

		this.logger.debug(
			{
				inputSampleRate,
				targetDemodRate,
				actualDemodRate,
				outputSampleRate: outputRate,
				decimation,
				bandwidth: config.bandwidth,
				deEmphasis: config.deEmphasis,
				pipeline,
			},
			"Built csdr demodulation pipeline",
		)

		return pipeline
	}

	/**
	 * Returns the decoder's capabilities.
	 * AudioDemodDecoders consume IQ data (not audio_pcm) and perform internal demodulation.
	 *
	 * Subclasses can override getCaps() if they need different capabilities,
	 * but should generally keep input: "iq" since that's what AudioDemodDecoder handles.
	 *
	 * @returns DecoderCaps with input type "iq"
	 */
	protected override getCaps(): DecoderCaps {
		return {
			input: "iq",
			wantsExclusiveSource: false,
			output: "text",
			integrationPattern: "pure_consumer",
		}
	}

	/**
	 * Template method: Parses a line of output into a DecoderOutput object.
	 * Subclasses must implement this to parse their decoder-specific output format.
	 *
	 * @param line - A line of text from stdout or stderr
	 * @returns DecoderOutput object if the line was parsed, null to skip
	 */
	protected abstract override parseOutput(line: string): DecoderOutput | null
}
