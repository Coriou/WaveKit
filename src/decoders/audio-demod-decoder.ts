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

import { BaseDecoder } from "./base-decoder.js"
import type {
	DecoderCaps,
	DecoderConfig,
	DecoderOutput,
	DemodulationConfig,
} from "./types.js"
import type { Logger } from "../utils/logger.js"

/** Debug recording options for capturing audio at pipeline stages */
interface DebugRecordingOptions {
	/** Directory to save debug audio recordings */
	path: string
	/** Which stages to record: 'demod' (after FM demod), 'final' (after all processing), 'both' */
	stages?: "demod" | "final" | "both"
}

/**
 * Default IQ sample rate from rtlmux (2.4 Msps)
 */
const DEFAULT_IQ_SAMPLE_RATE = 2_400_000

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
		const targetDemodRate = config.demodSampleRate ?? config.sampleRate
		const outputRate = config.sampleRate

		// Calculate decimation factor for the heavy lifting (firdecimate)
		// Input is IQ sample rate, output is demod/intermediate rate
		// IMPORTANT: csdr firdecimate requires integer decimation factor
		const inputSampleRate = config.inputSampleRate || DEFAULT_IQ_SAMPLE_RATE
		const decimation = Math.round(inputSampleRate / targetDemodRate)

		// CRITICAL: Calculate ACTUAL demod rate after integer decimation
		// This may differ from targetDemodRate due to rounding
		// sox must use the ACTUAL rate, not the configured rate
		const actualDemodRate = inputSampleRate / decimation

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

		const transition = config.filterTransition ?? 0.05
		const cutoffArg = config.filterCutoff
			? ` --cutoff ${config.filterCutoff}`
			: ""

		const csdrStages: string[] = [
			"csdr convert -i char -o float", // U8 IQ -> complex float
		]

		// Optional IQ-level AGC - applied BEFORE decimation and FM demod
		// This normalizes the complex envelope without affecting FM frequency content.
		// Critical for weak signal reception when hardware AGC is disabled.
		// Uses 'slow' profile to avoid distorting signal dynamics.
		if (config.enableIqAgc) {
			csdrStages.push("csdr agc -f complex -p slow -r 0.7")
		}

		csdrStages.push(
			`csdr firdecimate ${decimation} ${transition}${cutoffArg}`, // Decimate + filter (complex)
		)

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
			// csdr deemphasis takes sample rate
			csdrStages.push(`csdr deemphasis ${actualDemodRate}`)
		}

		// Final conversion to S16LE (at demodRate)
		csdrStages.push("csdr convert -i float -o s16")

		// Join csdr stages
		let pipelineStr = csdrStages.join(" | ")

		// DEBUG: Record audio right after csdr demodulation (at demodRate)
		// Using simple tee to avoid bash-specific process substitution
		if (shouldRecordDemod && debugDemodFile) {
			// Simple tee to file - no process substitution needed
			pipelineStr += ` | tee "${debugDemodFile}"`
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
			pipelineStr += ` | tee "${debugFinalFile}"`
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
				? `${decoderCommand} ${decoderArgs.join(" ")}`
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
