/**
 * ACARS Decoder - Aircraft Communications Addressing and Reporting System decoder
 *
 * Requirements:
 * - 23.1: WHEN started, THE Acarsdec_Decoder SHALL spawn acarsdec with the configured frequencies and device
 * - 23.2: WHEN acarsdec decodes a message, THE Acarsdec_Decoder SHALL parse it into structured ACARSMessage events
 * - 23.3: THE Acarsdec_Decoder SHALL support multiple simultaneous frequencies
 * - 23.4: THE Acarsdec_Decoder SHALL normalize output to JSON format
 */

import {
	ExternalSdrDecoder,
	type ExternalSdrConfig,
} from "../external-sdr-decoder.js"
import { PassiveRtlProxy } from "../passive-rtl-proxy.js"
import type { DecoderCaps, DecoderConfig, DecoderOutput } from "../types.js"
import type { Logger } from "../../utils/logger.js"

/**
 * Configuration options for the ACARS decoder.
 */
export interface AcarsdecOptions {
	/** RTL-SDR device serial number (local device mode) */
	deviceSerial?: string | undefined
	/** RTL-TCP host for network mode (e.g., "192.168.1.69") */
	rtlTcpHost?: string | undefined
	/** RTL-TCP port for network mode (default: 1235) */
	rtlTcpPort?: number | undefined
	/** Frequencies to monitor in Hz (Requirement 23.3) */
	frequencies: number[]
	/** Gain setting for the RTL-SDR */
	gain?: number | undefined
	/** PPM correction for the RTL-SDR */
	ppm?: number | undefined
	/** Output format: json or native (Requirement 23.4) */
	outputFormat?: "json" | "native" | undefined
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
 * Uses the External SDR pattern - acarsdec manages its own RTL-SDR device
 * and outputs decoded messages to stdout. This decoder spawns acarsdec
 * with the configured device and frequencies, then parses the JSON output
 * into structured ACARSMessage events.
 *
 * Supports multiple simultaneous frequencies (Requirement 23.3) by passing
 * them as command line arguments to acarsdec.
 */
export class AcarsdecDecoder extends ExternalSdrDecoder {
	private readonly options: AcarsdecOptions
	private proxy: PassiveRtlProxy | null = null
	private proxyPort: number | null = null


	constructor(config: DecoderConfig, logger: Logger) {
		// Build the external SDR config from decoder config
		const options = parseAcarsdecOptions(config)

		const externalConfig: ExternalSdrConfig = {
			id: config.id,
			type: config.type,
			enabled: config.enabled,
			sourceId: config.sourceId,
			options: config.options,
			// Use "rtltcp" as placeholder when in network mode (not actually used for device access)
			deviceSerial:
				options.deviceSerial ?? (options.rtlTcpHost ? "rtltcp" : "0"),
			frequencies: options.frequencies,
		}

		// Add optional fields only if defined
		if (options.gain !== undefined) {
			externalConfig.gain = options.gain
		}
		if (options.ppm !== undefined) {
			externalConfig.ppm = options.ppm
		}

		super(externalConfig, logger)
		this.options = options
	}

	/**
	 * Overrides start to initialize the passive proxy first.
	 */
	override async start(): Promise<void> {
		if (this.options.rtlTcpHost) {
			try {
				const port = this.options.rtlTcpPort ?? 1235
				this.logger.info({ host: this.options.rtlTcpHost, port }, "Starting Passive RTL Proxy for acarsdec")
				
				this.proxy = new PassiveRtlProxy(this.options.rtlTcpHost, port, this.logger)
				this.proxyPort = await this.proxy.listen()
				
				// HACK: Modify the config options in place so getArgs() picks up the proxy port
				// This is safe because this instance is ephemeral/dedicated to this run mostly?
				// Actually typically instances are long lived. We should probably use a separate member.
				// But getArgs() reads this.options.
				// We'll trust that getArgs() handles the specific "proxy mode" if we set a flag or just reuse the logic.
                // Better: Just override getArgs to check for this.proxy.
			} catch (err) {
				this.logger.error({ err }, "Failed to start passive proxy")
				throw err
			}
		}

		return super.start()
	}

	/**
	 * Overrides stop to close the proxy.
	 */
	override async stop(): Promise<void> {
		await super.stop()
		if (this.proxy) {
			this.proxy.close()
			this.proxy = null
			this.proxyPort = null
		}
	}

	/**
	 * Returns the acarsdec command (Requirement 23.1).
	 */
	protected getCommand(): string {
		return "sh"
	}

	/**
	 * Returns command line arguments for acarsdec (Requirements 23.1, 23.3, 23.4).
	 *
	 * acarsdec command line format:
	 * acarsdec -j -r <device> [-g <gain>] [-p <ppm>] <freq1> [freq2] ...
	 */
	protected getArgs(): string[] {
		// Construct the acarsdec command string
		const parts: string[] = ["acarsdec"]

		// Enable JSON output to stdout (Requirement 23.4)
		// -o 4 = JSON output (one message per line or object)
		parts.push("-o 4")

		// Device configuration (Requirement 23.1)
		if (this.options.rtlTcpHost) {
            // If proxy is active (which it should be for network mode), use it.
            // The proxy listens on 127.0.0.1. We need the port.
            if (this.proxyPort) {
                // acarsdec 3.4+ uses -d driver=rtltcp,rtltcp=IP:PORT for SoapySDR (SoapyRTLTCP driver)
                parts.push(`-d driver=rtltcp,rtltcp=127.0.0.1:${this.proxyPort}`)
                // Set sample rate multiplier to 192 for 2.4 MS/s
                parts.push("-m 192")
            } else {
                // This case should ideally not happen if start() was successful
                this.logger.warn("RTL-TCP host specified but proxy port not available. Falling back to default RTL-TCP port.")
                parts.push(`-d driver=rtltcp,rtltcp=127.0.0.1:${this.options.rtlTcpPort ?? 1235}`)
                parts.push("-m 192")
            }
		} else {
			// Local device mode: -r <device> specifies RTL-SDR device by index or serial
			parts.push(`-r ${this.options.deviceSerial ?? "0"}`)
		}

		// Gain setting
		if (this.options.gain !== undefined) {
			parts.push(`-g ${this.options.gain}`)
		}

		// PPM correction
		if (this.options.ppm !== undefined) {
			parts.push(`-p ${this.options.ppm}`)
		}

		// Additional arguments
		if (this.options.extraArgs) {
			parts.push(...this.options.extraArgs)
		}

		// Frequencies in Hz (Requirement 23.3)
		// acarsdec expects frequencies in MHz, so convert from Hz
		for (const freq of this.options.frequencies) {
			parts.push((freq / 1_000_000).toFixed(3))
		}

		return ["-c", parts.join(" ")]
	}

	/**
	 * Returns the decoder's capabilities (Requirement 17.1).
	 * Acarsdec is an external SDR decoder that produces JSON output.
	 */
	protected getCaps(): DecoderCaps {
		return {
			input: "external",
			wantsExclusiveSource: true,
			output: "jsonl",
			integrationPattern: "external_sdr",
		}
	}

	/**
	 * Parses a line of output into a DecoderOutput object (Requirement 23.2).
	 *
	 * @param line - A line of JSON output from acarsdec
	 * @returns DecoderOutput with ACARSMessage data, or null if parsing fails
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

	// Device serial for local mode (optional when using rtl_tcp)
	const deviceSerial =
		config.deviceSerial ?? (options["deviceSerial"] as string | undefined)

	// RTL-TCP network mode options
	const rtlTcpHost = options["rtlTcpHost"] as string | undefined
	const rtlTcpPort = options["rtlTcpPort"] as number | undefined

	// Frequencies can come from config or options
	let frequencies = config.frequencies ?? (options["frequencies"] as number[])
	if (!frequencies || frequencies.length === 0) {
		// Default ACARS frequencies (in Hz)
		frequencies = [131_550_000, 131_725_000]
	}

	return {
		deviceSerial,
		rtlTcpHost,
		rtlTcpPort,
		frequencies,
		gain: options["gain"] as number | undefined,
		ppm: options["ppm"] as number | undefined,
		outputFormat:
			(options["outputFormat"] as "json" | "native" | undefined) ?? "json",
		extraArgs: options["extraArgs"] as string[] | undefined,
	}
}

/**
 * Parses acarsdec JSON output into an ACARSMessage object (Requirement 23.2).
 *
 * @param json - Parsed JSON object from acarsdec output
 * @returns ACARSMessage object, or null if required fields are missing
 */
export function parseAcarsdecJson(
	json: AcarsdecJsonOutput,
): ACARSMessage | null {
	// Frequency is required - use freq or frequency field
	const frequency = json.freq ?? json.frequency
	if (frequency === undefined) {
		return null
	}

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
		frequency: frequency * 1_000_000, // Convert MHz to Hz for consistency
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
 * Used by the DecoderRegistry.
 */
export function createAcarsdecDecoder(
	config: DecoderConfig,
	logger: Logger,
): AcarsdecDecoder {
	return new AcarsdecDecoder(config, logger)
}

/**
 * Capabilities for the Acarsdec decoder.
 * Used when registering with the DecoderRegistry.
 */
export const ACARSDEC_CAPS: DecoderCaps = {
	input: "external",
	wantsExclusiveSource: true,
	output: "jsonl",
	integrationPattern: "external_sdr",
}
