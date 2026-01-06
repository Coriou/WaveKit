/**
 * Multimon-ng Decoder - Pager and data protocol decoder
 *
 * Requirements:
 * - 7.1: WHEN started, THE Multimon_Decoder SHALL spawn multimon-ng with the configured modes
 * - 7.2: WHEN multimon-ng decodes a message, THE Multimon_Decoder SHALL parse it into structured message events
 * - 7.3: THE Multimon_Decoder SHALL support modes: POCSAG512, POCSAG1200, POCSAG2400, FLEX, EAS, AFSK1200, FSK9600, DTMF
 * - 7.4: WHEN audio filters are configured, THE Multimon_Decoder SHALL apply highpass, lowpass, and gain settings
 */

import { BaseDecoder } from "../base-decoder.js"
import type { DecoderCaps, DecoderConfig, DecoderOutput } from "../types.js"
import type { Logger } from "../../utils/logger.js"

/** Supported Multimon-ng decoder modes (Requirement 7.3) */
export type MultimonMode =
	| "POCSAG512"
	| "POCSAG1200"
	| "POCSAG2400"
	| "FLEX"
	| "EAS"
	| "AFSK1200"
	| "FSK9600"
	| "DTMF"

/**
 * Audio filter configuration options (Requirement 7.4).
 */
export interface MultimonFilterOptions {
	/** Highpass filter cutoff frequency in Hz */
	highpass?: number | undefined
	/** Lowpass filter cutoff frequency in Hz */
	lowpass?: number | undefined
	/** Audio gain in dB */
	gain?: number | undefined
}

/**
 * Configuration options for the Multimon-ng decoder.
 */
export interface MultimonOptions {
	/** Decoder modes to enable */
	modes: MultimonMode[]
	/** Verbosity level (0-3) */
	verbosity?: number | undefined
	/** Character set for message decoding */
	charset?: string | undefined
	/** Audio filter settings */
	filters?: MultimonFilterOptions | undefined
}

/** All supported Multimon-ng modes */
export const MULTIMON_MODES: readonly MultimonMode[] = [
	"POCSAG512",
	"POCSAG1200",
	"POCSAG2400",
	"FLEX",
	"EAS",
	"AFSK1200",
	"FSK9600",
	"DTMF",
] as const

// Output parsing regex patterns
// POCSAG format: "POCSAG512: Address: 1234567  Function: 0  Alpha:   Message text here"
// or "POCSAG1200: Address: 1234567  Function: 2  Numeric:   123-456-7890"
const POCSAG_PATTERN =
	/POCSAG(\d+):\s*Address:\s*(\d+)\s+Function:\s*(\d+)\s+(?:(Alpha|Numeric|Tone Only):\s*(.*))?/i

// FLEX format: "FLEX: 1600/2/A 12.345 [1234567] ALN Message text here"
// or "FLEX|1600/2/A|12.345|1234567|ALN|Message text"
// Note: We use two separate patterns to avoid confusing | in message content with delimiters
const FLEX_SPACE_PATTERN =
	/FLEX:\s*(\d+\/\d+\/[A-Z])\s+(\d+\.\d+)\s+\[?(\d+)\]?\s+([A-Z]+)\s*(.*)?/i
const FLEX_PIPE_PATTERN =
	/FLEX\|(\d+\/\d+\/[A-Z])\|(\d+\.\d+)\|(\d+)\|([A-Z]+)\|(.*)?/i

// DTMF format: "DTMF: 1" or "DTMF: *" or "DTMF: #"
const DTMF_PATTERN = /DTMF:\s*([0-9*#A-D]+)/i

// EAS format: "EAS: ZCZC-ORG-EEE-PSSCCC+TTTT-JJJHHMM-LLLLLLLL-"
const EAS_PATTERN = /EAS:\s*(ZCZC-[A-Z]{3}-[A-Z]{3}-.+)/i

// AFSK1200 format: "AFSK1200: fm CALL-1 to CALL-2 via CALL-3 ..."
const AFSK1200_PATTERN =
	/AFSK1200:\s*fm\s+(\S+)\s+to\s+(\S+)(?:\s+via\s+(.+))?/i

// FSK9600 format: Similar to AFSK1200
const FSK9600_PATTERN = /FSK9600:\s*(.+)/i

/**
 * Multimon-ng Decoder - Decodes pager and data protocols.
 *
 * Supports POCSAG, FLEX, EAS, AFSK1200, FSK9600, and DTMF protocols.
 * Parses multimon-ng output into structured message and decode events.
 */
export class MultimonDecoder extends BaseDecoder {
	private readonly options: MultimonOptions

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
		this.options = this.parseOptions(config.options)
	}

	/**
	 * Parses and validates decoder options from config.
	 */
	private parseOptions(options: Record<string, unknown>): MultimonOptions {
		const rawModes = options["modes"] as MultimonMode[] | undefined
		const modes = this.validateModes(rawModes)

		return {
			modes,
			verbosity: options["verbosity"] as number | undefined,
			charset: options["charset"] as string | undefined,
			filters: options["filters"] as MultimonFilterOptions | undefined,
		}
	}

	/**
	 * Validates and filters modes to only include supported ones.
	 */
	private validateModes(rawModes: MultimonMode[] | undefined): MultimonMode[] {
		if (!rawModes || rawModes.length === 0) {
			// Default to all POCSAG modes if none specified
			return ["POCSAG512", "POCSAG1200", "POCSAG2400"]
		}

		const validModes = rawModes.filter(mode => MULTIMON_MODES.includes(mode))

		if (validModes.length !== rawModes.length) {
			const invalidModes = rawModes.filter(
				mode => !MULTIMON_MODES.includes(mode),
			)
			this.logger.warn(
				{ invalidModes, validModes: MULTIMON_MODES },
				"Some modes are invalid and will be ignored",
			)
		}

		return validModes.length > 0
			? validModes
			: ["POCSAG512", "POCSAG1200", "POCSAG2400"]
	}

	/**
	 * Returns the command to execute (Requirement 7.1).
	 * We use /bin/sh to pipe sox output into multimon-ng for resampling.
	 */
	protected getCommand(): string {
		return "/bin/sh"
	}

	/**
	 * Returns command line arguments (Requirement 7.1).
	 * Constructs a shell pipeline: sox ... | multimon-ng ...
	 */
	protected getArgs(): string[] {
		// Construct multimon-ng command line
		const multimonArgs: string[] = ["multimon-ng"]

		// Input from stdin with raw audio format (received from sox)
		multimonArgs.push("-t", "raw")
		multimonArgs.push("-")

		// Add each enabled mode (Requirement 7.3)
		for (const mode of this.options.modes) {
			multimonArgs.push("-a", mode)
		}

		// Set verbosity level
		if (this.options.verbosity !== undefined) {
			for (let i = 0; i < this.options.verbosity; i++) {
				multimonArgs.push("-v")
			}
		}

		// Set character set
		if (this.options.charset) {
			multimonArgs.push("-c", this.options.charset)
		}

		// Apply audio filters (Requirement 7.4) - applied to multimon-ng, though we could move to sox
		if (this.options.filters) {
			if (this.options.filters.highpass !== undefined) {
				multimonArgs.push("--highpass", String(this.options.filters.highpass))
			}
			if (this.options.filters.lowpass !== undefined) {
				multimonArgs.push("--lowpass", String(this.options.filters.lowpass))
			}
			if (this.options.filters.gain !== undefined) {
				multimonArgs.push("--gain", String(this.options.filters.gain))
			}
		}

		// Construct sox command line for resampling
		// Input: stdin, 48kHz (default), S16LE, 1 channel
		// Output: stdout, 22050Hz (multimon native), S16LE, 1 channel
		const soxArgs = [
			"sox",
			"-t",
			"raw",
			"-r",
			"48000", // Incoming sample rate (WaveKit default)
			"-e",
			"signed", // Signed integer
			"-b",
			"16", // 16-bit
			"-c",
			"1", // 1 channel
			"-", // Input from stdin
			"-t",
			"raw",
			"-r",
			"22050", // Target sample rate for multimon-ng
			"-", // Output to stdout
		]

		// Combine into shell pipeline
		// "sox ... - | multimon-ng ..."
		const cmd = `${soxArgs.join(" ")} 2>/dev/null | ${multimonArgs.join(" ")}`

		return ["-c", cmd]
	}

	/**
	 * Returns the decoder's capabilities (Requirement 17.1).
	 * Multimon-ng is a pure consumer that accepts PCM audio and outputs text.
	 */
	protected getCaps(): DecoderCaps {
		return {
			input: "audio_pcm",
			wantsExclusiveSource: false,
			preferredSampleRates: [22050, 48000],
			output: "text",
			integrationPattern: "pure_consumer",
		}
	}

	/**
	 * Parses multimon-ng output lines into DecoderOutput objects (Requirement 7.2).
	 *
	 * Handles:
	 * - POCSAG messages (512, 1200, 2400 baud)
	 * - FLEX messages
	 * - DTMF tones
	 * - EAS alerts
	 * - AFSK1200 packets
	 * - FSK9600 packets
	 */
	protected parseOutput(line: string): DecoderOutput | null {
		// Check for POCSAG messages
		const pocsagMatch = POCSAG_PATTERN.exec(line)
		if (pocsagMatch) {
			return this.parsePocsagOutput(pocsagMatch)
		}

		// Check for FLEX messages (try space-delimited first, then pipe-delimited)
		const flexSpaceMatch = FLEX_SPACE_PATTERN.exec(line)
		if (flexSpaceMatch) {
			return this.parseFlexOutput(flexSpaceMatch)
		}
		const flexPipeMatch = FLEX_PIPE_PATTERN.exec(line)
		if (flexPipeMatch) {
			return this.parseFlexOutput(flexPipeMatch)
		}

		// Check for DTMF tones
		const dtmfMatch = DTMF_PATTERN.exec(line)
		if (dtmfMatch) {
			return this.parseDtmfOutput(dtmfMatch)
		}

		// Check for EAS alerts
		const easMatch = EAS_PATTERN.exec(line)
		if (easMatch) {
			return this.parseEasOutput(easMatch)
		}

		// Check for AFSK1200 packets
		const afsk1200Match = AFSK1200_PATTERN.exec(line)
		if (afsk1200Match) {
			return this.parseAfsk1200Output(afsk1200Match)
		}

		// Check for FSK9600 packets
		const fsk9600Match = FSK9600_PATTERN.exec(line)
		if (fsk9600Match) {
			return this.parseFsk9600Output(fsk9600Match)
		}

		// Line didn't match any known pattern - skip it
		return null
	}

	/**
	 * Parses POCSAG output into a message event.
	 */
	private parsePocsagOutput(match: RegExpExecArray): DecoderOutput {
		const baud = match[1] ?? "1200"
		const address = parseInt(match[2] ?? "0", 10)
		const func = parseInt(match[3] ?? "0", 10)
		const messageType = match[4]?.toLowerCase() ?? "unknown"
		const message = match[5]?.trim() ?? ""

		return {
			timestamp: new Date(),
			decoder: this.id,
			type: "message",
			data: {
				protocol: `POCSAG${baud}`,
				address,
				function: func,
				messageType,
				message,
			},
		}
	}

	/**
	 * Parses FLEX output into a message event.
	 */
	private parseFlexOutput(match: RegExpExecArray): DecoderOutput {
		const mode = match[1] ?? ""
		const frequency = match[2] ?? ""
		const capcode = match[3] ?? ""
		const messageType = match[4] ?? ""
		const message = match[5]?.trim() ?? ""

		return {
			timestamp: new Date(),
			decoder: this.id,
			type: "message",
			data: {
				protocol: "FLEX",
				mode,
				frequency,
				capcode,
				messageType,
				message,
			},
		}
	}

	/**
	 * Parses DTMF output into a decode event.
	 */
	private parseDtmfOutput(match: RegExpExecArray): DecoderOutput {
		const digits = match[1] ?? ""

		return {
			timestamp: new Date(),
			decoder: this.id,
			type: "decode",
			data: {
				protocol: "DTMF",
				digits,
			},
		}
	}

	/**
	 * Parses EAS output into a message event.
	 */
	private parseEasOutput(match: RegExpExecArray): DecoderOutput {
		const rawMessage = match[1] ?? ""

		return {
			timestamp: new Date(),
			decoder: this.id,
			type: "message",
			data: {
				protocol: "EAS",
				rawMessage,
			},
		}
	}

	/**
	 * Parses AFSK1200 output into a decode event.
	 */
	private parseAfsk1200Output(match: RegExpExecArray): DecoderOutput {
		const from = match[1] ?? ""
		const to = match[2] ?? ""
		const via = match[3]?.trim() ?? undefined

		return {
			timestamp: new Date(),
			decoder: this.id,
			type: "decode",
			data: {
				protocol: "AFSK1200",
				from,
				to,
				via,
			},
		}
	}

	/**
	 * Parses FSK9600 output into a decode event.
	 */
	private parseFsk9600Output(match: RegExpExecArray): DecoderOutput {
		const rawData = match[1]?.trim() ?? ""

		return {
			timestamp: new Date(),
			decoder: this.id,
			type: "decode",
			data: {
				protocol: "FSK9600",
				rawData,
			},
		}
	}
}

/**
 * Factory function for creating Multimon-ng decoder instances.
 * Used by the DecoderRegistry.
 */
export function createMultimonDecoder(
	config: DecoderConfig,
	logger: Logger,
): MultimonDecoder {
	return new MultimonDecoder(config, logger)
}

/**
 * Capabilities for the Multimon-ng decoder.
 * Used when registering with the DecoderRegistry.
 */
export const MULTIMON_CAPS: DecoderCaps = {
	input: "audio_pcm",
	wantsExclusiveSource: false,
	preferredSampleRates: [22050, 48000],
	output: "text",
	integrationPattern: "pure_consumer",
}
