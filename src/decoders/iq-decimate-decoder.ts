/**
 * IQ Decimate Decoder - Abstract base class for decoders that need decimated IQ data
 *
 * This decoder type receives U8 IQ data at a high sample rate (e.g., 2.048 Msps)
 * and decimates it to the decoder's preferred sample rate using csdr before
 * piping to the decoder process.
 *
 * This pattern solves the problem of high sample rate IQ overwhelming decoders
 * that expect lower rates (e.g., rtl_433 at 250 kHz, ais-catcher at 288 kHz).
 *
 * The csdr pipeline: IQ (U8) → Float32 → Decimate → U8 → decoder stdin
 *
 * Subclasses only need to implement:
 * - getIqDecimationConfig(): Return preferred IQ sample rate
 * - getDecoderCommand(): Return the decoder executable
 * - getDecoderArgs(): Return decoder-specific arguments
 * - parseOutput(): Parse decoder output into DecoderOutput
 *
 * Note: Unlike AudioDemodDecoder, this class does NOT perform FM demodulation.
 * The output is still IQ data (U8 complex), just at a lower sample rate.
 */

import { BaseDecoder } from "./base-decoder.js"
import type { DecoderCaps, DecoderConfig, DecoderOutput } from "./types.js"
import type { Logger } from "../utils/logger.js"

/**
 * Configuration for IQ decimation settings.
 */
export interface IqDecimationConfig {
	/** Preferred output IQ sample rate in Hz (e.g., 250000 for rtl_433) */
	targetSampleRate: number
	/** IQ input sample rate in Hz from the source (e.g., 2048000) */
	inputSampleRate: number
	/** Optional custom transition bandwidth for FIR filter (default: 0.05) */
	filterTransition?: number
	/** Optional custom cutoff for FIR filter (default: 0.5) */
	filterCutoff?: number
}

/**
 * Default IQ sample rate from sources (2.048 Msps)
 */
const DEFAULT_IQ_SAMPLE_RATE = 2_048_000

/**
 * IqDecimateDecoder - Abstract base class for decoders that need decimated IQ data.
 *
 * This class handles the csdr decimation pipeline, allowing subclasses to focus
 * only on decoder-specific logic. The pipeline decimates U8 IQ data to the
 * decoder's preferred sample rate while preserving IQ format.
 *
 * Uses the Template Method pattern where subclasses implement:
 * - getIqDecimationConfig(): Return preferred IQ decimation settings
 * - getDecoderCommand(): Return the decoder executable name
 * - getDecoderArgs(): Return decoder-specific command line arguments
 * - parseOutput(line): Parse decoder output into DecoderOutput objects
 *
 * Handles:
 * - Building csdr decimation pipeline
 * - Sample rate conversion via integer decimation
 * - Piping decimated IQ to decoder stdin
 */
export abstract class IqDecimateDecoder extends BaseDecoder {
	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
	}

	/**
	 * Template method: Returns the IQ decimation configuration.
	 * Subclasses must implement this to specify their preferred IQ sample rate.
	 *
	 * @returns IqDecimationConfig with target sample rate and input rate
	 */
	protected abstract getIqDecimationConfig(): IqDecimationConfig

	/**
	 * Template method: Returns the decoder command to execute.
	 * Subclasses must implement this to return the decoder executable name.
	 *
	 * @returns Decoder executable name (e.g., "rtl_433", "AIS-catcher")
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
	 * Builds the complete shell command with csdr decimation pipeline.
	 * This is the core method that connects IQ → csdr → decoder.
	 *
	 * @returns Array with ["-c", "pipeline command string"]
	 */
	protected override getArgs(): string[] {
		const pipelineCommand = this.buildPipelineCommand()
		return ["-c", pipelineCommand]
	}

	/**
	 * Builds the complete csdr IQ decimation pipeline + decoder command.
	 *
	 * Pipeline stages (using jketterl/csdr v0.18+ syntax):
	 * 1. csdr convert -i char -o float - Convert U8 IQ pairs to Float32 complex
	 * 2. csdr firdecimate N [transition] - Decimate and filter (complex → complex)
	 * 3. csdr convert -i float -o char - Convert back to U8 complex for decoder
	 * 4. decoder command with args
	 *
	 * The decimation reduces sample rate by a factor of N while applying
	 * anti-aliasing filtering to prevent spectral folding.
	 *
	 * @returns Complete shell command string
	 */
	protected buildPipelineCommand(): string {
		const config = this.getIqDecimationConfig()

		const inputSampleRate = config.inputSampleRate || DEFAULT_IQ_SAMPLE_RATE
		const targetSampleRate = config.targetSampleRate

		// Calculate decimation factor
		// IMPORTANT: csdr firdecimate requires integer decimation factor
		let decimation = Math.round(inputSampleRate / targetSampleRate)

		// Ensure at least 1x decimation (pass-through)
		if (decimation < 1) {
			decimation = 1
		}

		// Calculate ACTUAL output sample rate after integer decimation
		const actualOutputRate = inputSampleRate / decimation

		// If decimation is 1, we can skip the pipeline entirely
		if (decimation === 1) {
			this.logger.debug(
				{ inputSampleRate, targetSampleRate, decimation },
				"No decimation needed, bypassing csdr pipeline",
			)
			// Direct decoder command without csdr pipeline
			return this.buildDirectDecoderCommand()
		}

		const transition = config.filterTransition ?? 0.05
		const cutoffArg = config.filterCutoff
			? ` --cutoff ${config.filterCutoff}`
			: ""

		// Build csdr pipeline stages
		const csdrStages: string[] = [
			"csdr convert -i char -o float", // U8 IQ → complex float
			`csdr firdecimate ${decimation} ${transition}${cutoffArg}`, // Decimate + filter
			"csdr convert -i float -o char", // complex float → U8 IQ
		]

		const pipelineStr = csdrStages.join(" | ")

		// Build decoder command with args
		const decoderCommand = this.getDecoderCommand()
		const decoderArgs = this.getDecoderArgs()

		// Modify decoder args to use the actual output sample rate
		// This is decoder-specific - subclasses should configure this
		const decoderFullCommand =
			decoderArgs.length > 0
				? `${decoderCommand} ${decoderArgs.join(" ")}`
				: decoderCommand

		// Combine into full pipeline
		const pipeline = `${pipelineStr} | ${decoderFullCommand}`

		this.logger.debug(
			{
				inputSampleRate,
				targetSampleRate,
				actualOutputRate,
				decimation,
				pipeline,
			},
			"Built csdr IQ decimation pipeline",
		)

		return pipeline
	}

	/**
	 * Builds direct decoder command when no decimation is needed.
	 * Used when input sample rate matches target sample rate.
	 *
	 * @returns Direct decoder command string
	 */
	protected buildDirectDecoderCommand(): string {
		const decoderCommand = this.getDecoderCommand()
		const decoderArgs = this.getDecoderArgs()

		return decoderArgs.length > 0
			? `${decoderCommand} ${decoderArgs.join(" ")}`
			: decoderCommand
	}

	/**
	 * Returns the decoder's capabilities.
	 * IqDecimateDecoders consume IQ data (not audio_pcm).
	 *
	 * Subclasses can override getCaps() if they need different capabilities,
	 * but should generally keep input: "iq" since that's what IqDecimateDecoder handles.
	 *
	 * @returns DecoderCaps with input type "iq"
	 */
	protected override getCaps(): DecoderCaps {
		return {
			input: "iq",
			wantsExclusiveSource: false,
			output: "jsonl",
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
