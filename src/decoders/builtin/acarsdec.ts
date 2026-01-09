/**
 * ACARS Decoder - Aircraft Communications Addressing and Reporting System decoder
 *
 * Requirements:
 * - 23.1: WHEN started, THE Acarsdec_Decoder SHALL spawn acarsdec
 * - 23.2: WHEN acarsdec decodes a message, THE Acarsdec_Decoder SHALL parse it into structured ACARSMessage events
 * - 23.4: THE Acarsdec_Decoder SHALL normalize output to JSON format
 *
 * Updated implementation (2026-01-09):
 * Uses AudioDemodDecoder to consume shared IQ data and perform internal AM demodulation
 * using csdr, feeding raw audio to f00b4r0/acarsdec fork via stdin.
 */

import { AudioDemodDecoder } from "../audio-demod-decoder.js"
import type { DecoderCaps, DecoderConfig, DecoderOutput, DemodulationConfig } from "../types.js"
import type { Logger } from "../../utils/logger.js"

/**
 * Configuration options for the ACARS decoder.
 */
export interface AcarsdecOptions {
	/** Frequencies to monitor in Hz (metadata only in this mode) */
	frequencies?: number[]
	/** Gain setting (metadata only) */
	gain?: number | undefined
	/** Input sample rate from source */
	inputSampleRate?: number | undefined
	/** Additional command line arguments */
	extraArgs?: string[] | undefined
}

/**
 * Structured ACARS message data (Requirement 23.2).
 */
export interface ACARSMessage {
	/** Timestamp when the message was received */
	timestamp: Date
	/** Frequency the message was received on (Hz) */
	frequency: number
	/** Channel number */
	channel: number
	/** Signal level in dB */
	level: number
	/** Number of bit errors */
	error: number
	/** ACARS mode character */
	mode: string
	/** Message label (2 characters) */
	label: string
	/** Block ID */
	blockId?: string | undefined
	/** Acknowledgement character */
	ack?: string | undefined
	/** Aircraft registration/tail number */
	tail?: string | undefined
	/** Flight number */
	flight?: string | undefined
	/** Message number */
	msgno?: string | undefined
	/** Message text content */
	text?: string | undefined
}

/**
 * Raw JSON output structure from acarsdec -j flag.
 */
interface AcarsdecJsonOutput {
	timestamp?: number | string
	freq?: number
	channel?: number
	level?: number
	error?: number
	mode?: string
	label?: string
	block_id?: string
	ack?: string | boolean
	tail?: string
	flight?: string
	msgno?: string
	text?: string
	// Alternative field names used by some versions
	frequency?: number
	reg?: string
	message?: string
}

/**
 * ACARS Decoder - Decodes ACARS aircraft data link messages.
 * 
 * Uses the AudioDemodDecoder base class to consume shared IQ data.
 * Performs AM demodulation using csdr and feeds raw S16LE audio to
 * f00b4r0/acarsdec fork via stdin.
 */
export class AcarsdecDecoder extends AudioDemodDecoder {
	private readonly options: AcarsdecOptions

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
		this.options = parseAcarsdecOptions(config)
	}

	/**
	 * Returns the demodulation configuration for ACARS.
	 * 
	 * Requirements:
	 * - AM Modulation
	 * - 12.5kHz or 25kHz bandwidth
	 * - Sample rate must be multiple of 12kHz for acarsdec
	 */
	protected getDemodConfig(): DemodulationConfig {
		return {
			modulation: "am",           // ACARS uses AM Modulation
			bandwidth: 25000,           // ~25kHz bandwidth
			sampleRate: 12000,          // acarsdec requires 12kHz multiples (using 12000)
			demodSampleRate: 24000,     // Demod at 24ksps (decimation=100 from 2.4Msps)
			inputSampleRate: this.options.inputSampleRate ?? 2_400_000,
			deEmphasis: false,          // No de-emphasis for data
			fmGain: 1.0,                // Default gain
			// skipDcBlock: true - removed to enable DC block (needed to remove carrier from AM envelope)
		}
	}

	/**
	 * Returns the acarsdec command (Requirement 23.1).
	 */
	protected getDecoderCommand(): string {
		return "acarsdec"
	}

	/**
	 * Returns command line arguments for acarsdec.
	 * Using f00b4r0 fork syntax for stdin injection.
	 * 
	 * IMPORTANT: The sndfile parameter syntax is critical for raw audio via stdin:
	 * - Use: '/dev/stdin,subtype=0x02' (comma-separated, no file= prefix)
	 * - subtype=0x02 is hex for SF_FORMAT_PCM_16 (S16LE)
	 * - The comma syntax (not file=) triggers proper RAW format handling in libsndfile
	 */
	protected getDecoderArgs(): string[] {
		const args: string[] = []

		// Enable JSON output to stdout (Requirement 23.4)
		// f00b4r0 fork uses --output json:file:path=-
		args.push("--output", "json:file:path=-")

		// Input from stdin using sndfile raw mode
		// CRITICAL: Use comma syntax '/dev/stdin,subtype=0x02' NOT 'file=/dev/stdin,subtype=2'
		// The comma syntax (without file=) properly triggers SF_FORMAT_RAW in libsndfile
		// subtype=0x02 corresponds to SF_FORMAT_PCM_16 (S16LE)
		args.push("--sndfile", "/dev/stdin,subtype=0x02")

		// Rate multiplier for 12kHz base rate
		// "sample rate is <rateMult> * 12000 S/s"
		args.push("-m", "1")

		// Additional arguments
		if (this.options.extraArgs) {
			args.push(...this.options.extraArgs)
		}

		// Frequencies should NOT be passed as arguments in --sndfile mode
		// The help text shows they are part of the mutually exclusive SDR branch

		return args
	}

	// Note: We don't need to override buildPipelineCommand() anymore.
	// The base AudioDemodDecoder pipeline outputs raw S16LE which acarsdec
	// can now read via the correct '/dev/stdin,subtype=0x02' syntax.

	/**
	 * Returns the decoder's capabilities (Requirement 17.1).
	 */
	protected override getCaps(): DecoderCaps {
		return ACARSDEC_CAPS
	}

	/**
	 * Parses a line of output into a DecoderOutput object (Requirement 23.2).
	 */
	protected parseOutput(line: string): DecoderOutput | null {
		const trimmed = line.trim()
		if (!trimmed) return null

		// Skip non-JSON lines (startup messages, etc.)
		if (!trimmed.startsWith("{")) {
			// this.logger.debug({ line: trimmed }, "Skipping non-JSON line")
			return null
		}

		try {
			const json = JSON.parse(trimmed) as AcarsdecJsonOutput
			const message = parseAcarsdecJson(json)

			if (message) {
				return {
					timestamp: new Date(),
					decoder: this.id,
					type: "acars",
					data: message,
				}
			}
		} catch (err) {
			this.logger.debug({ line: trimmed, err }, "Failed to parse JSON line")
		}

		return null
	}
}

/**
 * Parses and validates decoder options from config.
 */
function parseAcarsdecOptions(config: DecoderConfig): AcarsdecOptions {
	const options = config.options as Record<string, unknown>

	// Frequencies (optional in this mode, but good to preserve)
	let frequencies = config.frequencies ?? (options["frequencies"] as number[])
	if (!frequencies || frequencies.length === 0) {
		frequencies = [131_550_000, 131_725_000]
	}

	return {
		frequencies,
		gain: options["gain"] as number | undefined,
		inputSampleRate: options["inputSampleRate"] as number | undefined,
		extraArgs: options["extraArgs"] as string[] | undefined,
	}
}

/**
 * Parses acarsdec JSON output into an ACARSMessage object (Requirement 23.2).
 */
export function parseAcarsdecJson(
	json: AcarsdecJsonOutput,
): ACARSMessage | null {
	// Frequency is required - use freq or frequency field
	const frequency = json.freq ?? json.frequency ?? 131.550 // Default fallback if missing (stdin mode might output 0 or null?)

	// Parse timestamp - can be Unix timestamp or ISO string
	let timestamp: Date
	if (typeof json.timestamp === "number") {
		timestamp = new Date(json.timestamp * 1000)
	} else if (typeof json.timestamp === "string") {
		timestamp = new Date(json.timestamp)
	} else {
		timestamp = new Date()
	}

	// Parse ack field - can be string or boolean
	let ack: string | undefined
	if (typeof json.ack === "string") {
		ack = json.ack
	} else if (json.ack === true) {
		ack = "!"
	} else if (json.ack === false) {
		ack = undefined
	}

	return {
		timestamp,
		frequency: frequency * 1_000_000, // Convert MHz to Hz
		channel: json.channel ?? 0,
		level: json.level ?? 0,
		error: json.error ?? 0,
		mode: json.mode ?? "",
		label: json.label ?? "",
		blockId: json.block_id,
		ack,
		tail: json.tail ?? json.reg,
		flight: json.flight,
		msgno: json.msgno,
		text: json.text ?? json.message,
	}
}

/**
 * Factory function for creating Acarsdec decoder instances.
 */
export function createAcarsdecDecoder(
	config: DecoderConfig,
	logger: Logger,
): AcarsdecDecoder {
	return new AcarsdecDecoder(config, logger)
}

/**
 * Capabilities for the Acarsdec decoder.
 */
export const ACARSDEC_CAPS: DecoderCaps = {
	input: "iq",
	wantsExclusiveSource: false,
	output: "jsonl",
	integrationPattern: "pure_consumer", // Updated from external_sdr
}
