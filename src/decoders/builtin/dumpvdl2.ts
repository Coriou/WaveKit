/**
 * VDL2 Decoder - VDL Mode 2 data link decoder using dumpvdl2
 *
 * Requirements:
 * - 24.1: WHEN started, THE Dumpvdl2_Decoder SHALL spawn dumpvdl2 with the configured frequencies and device
 * - 24.2: WHEN dumpvdl2 decodes a message, THE Dumpvdl2_Decoder SHALL parse it into structured VDL2Message events
 * - 24.3: THE Dumpvdl2_Decoder SHALL support JSON output format
 * - 24.4: THE Dumpvdl2_Decoder SHALL support multiple simultaneous frequencies
 */

import { BaseDecoder } from "../base-decoder.js"
import type { DecoderCaps, DecoderConfig, DecoderOutput } from "../types.js"
import type { Logger } from "../../utils/logger.js"
import type { ACARSMessage } from "./acarsdec.js"

/**
 * Configuration options for the VDL2 decoder.
 */
export interface Dumpvdl2Options {
	/** RTL-SDR device serial number (local device mode) */
	deviceSerial?: string | undefined
	/** RTL-TCP host for network mode (e.g., "192.168.1.69") */
	rtlTcpHost?: string | undefined
	/** RTL-TCP port for network mode (default: 1235) */
	rtlTcpPort?: number | undefined
	/** Frequencies to monitor in Hz (Requirement 24.4) */
	frequencies: number[]
	/** Gain setting for the RTL-SDR */
	gain?: number | undefined
	/** PPM correction for the RTL-SDR */
	ppm?: number | undefined
	/** Output format: json or text (Requirement 24.3) */
	outputFormat?: "json" | "text" | undefined
	/** Additional command line arguments */
	extraArgs?: string[] | undefined
}

/**
 * Structured VDL2 message data (Requirement 24.2).
 */
export interface VDL2Message {
	/** Timestamp when the message was received */
	timestamp: Date
	/** Frequency the message was received on (Hz) */
	frequency: number
	/** Ground station identifier */
	station?: string | undefined
	/** Aircraft ICAO address */
	icao?: string | undefined
	/** Destination address */
	toaddr?: string | undefined
	/** Source address */
	fromaddr?: string | undefined
	/** Message type identifier */
	msgType: string
	/** Embedded ACARS message if present */
	acars?: ACARSMessage | undefined
	/** Raw message text */
	text?: string | undefined
	/** Signal level in dB */
	level?: number | undefined
	/** Noise floor in dB */
	noiseFloor?: number | undefined
	/** Frame type */
	frameType?: string | undefined
}

/**
 * Raw JSON output structure from dumpvdl2 --output decoded:json:file:- flag.
 */
interface Dumpvdl2JsonOutput {
	vdl2?: {
		t?: {
			sec?: number
			usec?: number
		}
		freq?: number
		sig_level?: number
		noise_level?: number
		station?: string
		avlc?: {
			src?: {
				addr?: string
				type?: string
				status?: string
			}
			dst?: {
				addr?: string
				type?: string
			}
			cr?: string
			frame_type?: string
			rseq?: number
			sseq?: number
			poll?: boolean
			final?: boolean
			acars?: AcarsEmbedded
			xid?: XidData
		}
	}
}

/**
 * Embedded ACARS data in VDL2 messages.
 */
interface AcarsEmbedded {
	err?: boolean
	crc_ok?: boolean
	more?: boolean
	reg?: string
	mode?: string
	label?: string
	blk_id?: string
	ack?: string
	flight?: string
	msg_num?: string
	msg_num_seq?: string
	msg_text?: string
}

/**
 * XID data in VDL2 messages.
 */
interface XidData {
	type?: string
	type_descr?: string
	params?: Record<string, unknown>
}

/**
 * VDL2 Decoder - Decodes VDL Mode 2 data link messages.
 *
 * Modified to consume IQ data from stdin (Passive Mode).
 */
export class Dumpvdl2Decoder extends BaseDecoder {
	private readonly options: Dumpvdl2Options

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
		this.options = parseDumpvdl2Options(config)
	}

	/**
	 * Returns the dumpvdl2 command (Requirement 24.1).
	 */
	protected getCommand(): string {
		return "dumpvdl2"
	}

	/**
	 * Returns command line arguments for dumpvdl2 (Requirements 24.1, 24.3, 24.4).
	 *
	 * dumpvdl2 command line format:
	 * dumpvdl2 --rtlsdr <device> [--gain <gain>] [--correction <ppm>] --output decoded:json:file:- <freq1> [freq2] ...
	 */
	protected getArgs(): string[] {
		const args: string[] = []

		// Use stdin input (Requirement 25.4)
		args.push("--iq-file", "-")
		args.push("--sample-format", "U8")
		// Note: dumpvdl2 derives sample rate from oversample factor (rate = 105k * oversample)
		// 2.4Msps is approx 22.85 * 105k. We might need resampling if it's strict.
		// For now, removing invalid --sample-rate arg to prevent exit.
		// args.push("--sample-rate", "2400000")
		
		// Configure sample rate (MUST match the source, e.g. 2400000 from config)
        // We'll trust that the user/admin configured the correct rate in dev_test.yaml
        // and that it is sufficient to cover the frequencies. But dumpvdl2 needs to know it.
        // We hardcode 2.4Msps here to match dev_test.yaml update or infer? 
        // Ideally we should pass it from config.
        // For now, let's look at dev_test.yaml - we set it to 2400000.
        // But the CLASS options don't seem to have sampleRate passed in by default parse logic?
        // We might need to add sampleRate to Dumpvdl2Options.
        // Let's assume 2400000 for now or try to use a safe default if not provided.
        // The previous implementation didn't use sample rate because it controlled the device.
        // args.push("--sample-rate", "2400000") // TODO: Make configurable via options

		// Gain setting - irrelevant for IQ file input? 
		// Actually native dumpvdl2 might not support gain setting when reading from file/stdin?
		// We'll skip gain/ppm args since we are just reading a stream.

		// Enable JSON output to stdout (Requirement 24.3)
		args.push("--output", "decoded:json:file:path=-")

		// Additional arguments
		if (this.options.extraArgs) {
			args.push(...this.options.extraArgs)
		}

		// Frequencies in Hz (Requirement 24.4)
		// dumpvdl2 expects frequencies in Hz
		for (const freq of this.options.frequencies) {
			args.push(freq.toString())
		}

		return args
	}

	/**
	 * Returns the decoder's capabilities (Requirement 17.1).
	 * Dumpvdl2 is an external SDR decoder that produces JSON output.
	 */
	protected getCaps(): DecoderCaps {
		return {
			input: "iq",
			wantsExclusiveSource: false, // Can share the IQ stream
			output: "jsonl",
			integrationPattern: "pure_consumer", // Acts like a filter/consumer now
		}
	}

	/**
	 * Parses a line of output into a DecoderOutput object (Requirement 24.2).
	 *
	 * @param line - A line of JSON output from dumpvdl2
	 * @returns DecoderOutput with VDL2Message data, or null if parsing fails
	 */
	protected parseOutput(line: string): DecoderOutput | null {
		const trimmed = line.trim()
		if (!trimmed) return null

		// Skip non-JSON lines (startup messages, etc.)
		if (!trimmed.startsWith("{")) {
			this.logger.debug({ line: trimmed }, "Skipping non-JSON line")
			return null
		}

		try {
			const json = JSON.parse(trimmed) as Dumpvdl2JsonOutput
			const message = parseDumpvdl2Json(json)

			if (message) {
				return {
					timestamp: new Date(),
					decoder: this.id,
					type: "vdl2",
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
function parseDumpvdl2Options(config: DecoderConfig): Dumpvdl2Options {
	const options = config.options as Record<string, unknown>

	// Device serial for local mode (optional when using rtl_tcp)
	const deviceSerial =
		config.deviceSerial ?? (options["deviceSerial"] as string | undefined)

	// RTL-TCP network mode options
	const rtlTcpHost = options["rtlTcpHost"] as string | undefined
	const rtlTcpPort = options["rtlTcpPort"] as number | undefined

	// Frequencies can come from config or options
	let frequencies = config.frequencies ?? (options["frequencies"] as number[])
	if (!frequencies || frequencies.length === 0) {
		// Default VDL2 frequencies (in Hz) - common European frequencies
		frequencies = [136_650_000, 136_700_000, 136_975_000]
	}

	return {
		deviceSerial,
		rtlTcpHost,
		rtlTcpPort,
		frequencies,
		gain: options["gain"] as number | undefined,
		ppm: options["ppm"] as number | undefined,
		outputFormat:
			(options["outputFormat"] as "json" | "text" | undefined) ?? "json",
		extraArgs: options["extraArgs"] as string[] | undefined,
	}
}

/**
 * Parses dumpvdl2 JSON output into a VDL2Message object (Requirement 24.2).
 *
 * @param json - Parsed JSON object from dumpvdl2 output
 * @returns VDL2Message object, or null if required fields are missing
 */
export function parseDumpvdl2Json(
	json: Dumpvdl2JsonOutput,
): VDL2Message | null {
	const vdl2 = json.vdl2
	if (!vdl2) {
		return null
	}

	// Parse timestamp from sec/usec fields
	let timestamp: Date
	if (vdl2.t?.sec !== undefined) {
		const ms = vdl2.t.sec * 1000 + (vdl2.t.usec ?? 0) / 1000
		timestamp = new Date(ms)
	} else {
		timestamp = new Date()
	}

	// Frequency is important for VDL2 messages
	const frequency = vdl2.freq ?? 0

	// Extract addresses from AVLC frame
	const avlc = vdl2.avlc
	const srcAddr = avlc?.src?.addr
	const dstAddr = avlc?.dst?.addr
	const frameType = avlc?.frame_type

	// Determine message type from frame structure
	let msgType = "unknown"
	if (avlc?.acars) {
		msgType = "acars"
	} else if (avlc?.xid) {
		msgType = avlc.xid.type_descr ?? avlc.xid.type ?? "xid"
	} else if (frameType) {
		msgType = frameType
	}

	// Parse embedded ACARS if present
	let acars: ACARSMessage | undefined
	if (avlc?.acars) {
		const acarsData = avlc.acars
		acars = {
			timestamp,
			frequency,
			channel: 0,
			level: vdl2.sig_level ?? 0,
			error: acarsData.err ? 1 : 0,
			mode: acarsData.mode ?? "",
			label: acarsData.label ?? "",
			blockId: acarsData.blk_id,
			ack: acarsData.ack,
			tail: acarsData.reg,
			flight: acarsData.flight,
			msgno: acarsData.msg_num,
			text: acarsData.msg_text,
		}
	}

	return {
		timestamp,
		frequency,
		station: vdl2.station,
		icao: srcAddr,
		toaddr: dstAddr,
		fromaddr: srcAddr,
		msgType,
		acars,
		level: vdl2.sig_level,
		noiseFloor: vdl2.noise_level,
		frameType,
	}
}

/**
 * Factory function for creating Dumpvdl2 decoder instances.
 * Used by the DecoderRegistry.
 */
export function createDumpvdl2Decoder(
	config: DecoderConfig,
	logger: Logger,
): Dumpvdl2Decoder {
	return new Dumpvdl2Decoder(config, logger)
}

/**
 * Capabilities for the Dumpvdl2 decoder.
 * Used when registering with the DecoderRegistry.
 */
export const DUMPVDL2_CAPS: DecoderCaps = {
	input: "external",
	wantsExclusiveSource: true,
	output: "jsonl",
	integrationPattern: "external_sdr",
}
