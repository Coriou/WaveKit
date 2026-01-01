/**
 * AIS-catcher Decoder - Maritime AIS signal decoder
 *
 * Requirements:
 * - 25.1: WHEN started, THE AISCatcher_Decoder SHALL spawn AIS-catcher with the configured device and output options
 * - 25.2: WHEN AIS-catcher decodes a message, THE AISCatcher_Decoder SHALL parse it into structured ShipData events
 * - 25.3: THE AISCatcher_Decoder SHALL support output formats: NMEA, JSON
 * - 25.4: THE AISCatcher_Decoder SHALL support multiple input sources (RTL-TCP, SpyServer, SoapySDR)
 */

import {
	NetworkProducerDecoder,
	type NetworkProducerConfig,
} from "../network-producer-decoder.js"
import type { DecoderCaps, DecoderConfig, DecoderOutput } from "../types.js"
import type { Logger } from "../../utils/logger.js"

/** Supported output formats for AIS-catcher (Requirement 25.3) */
export type AisCatcherOutputFormat = "nmea" | "json"

/** Supported input source types for AIS-catcher (Requirement 25.4) */
export type AisCatcherInputSource = "rtlsdr" | "rtltcp" | "spyserver" | "soapy"

/**
 * Configuration options for the AIS-catcher decoder.
 */
export interface AisCatcherOptions {
	/** RTL-SDR device index */
	device?: string | undefined
	/** RTL-SDR device serial number */
	deviceSerial?: string | undefined
	/** RTL-TCP host to connect to (alternative to local device) */
	rtlTcpHost?: string | undefined
	/** RTL-TCP port to connect to */
	rtlTcpPort?: number | undefined
	/** SpyServer host to connect to */
	spyServerHost?: string | undefined
	/** SpyServer port to connect to */
	spyServerPort?: number | undefined
	/** Gain setting for the RTL-SDR */
	gain?: number | undefined
	/** PPM correction for the RTL-SDR */
	ppm?: number | undefined
	/** Output format: nmea or json (Requirement 25.3) */
	outputFormat: AisCatcherOutputFormat
	/** UDP port for output */
	outputPort?: number | undefined
	/** Additional command line arguments */
	extraArgs?: string[] | undefined
}

/**
 * Structured ship data from AIS decoding (Requirement 25.2).
 */
export interface ShipData {
	/** Maritime Mobile Service Identity (9 digits) */
	mmsi: string
	/** Vessel name */
	name?: string | undefined
	/** Radio callsign */
	callsign?: string | undefined
	/** IMO number */
	imo?: number | undefined
	/** Ship type code */
	shipType?: number | undefined
	/** Latitude */
	lat?: number | undefined
	/** Longitude */
	lon?: number | undefined
	/** Course over ground in degrees */
	cog?: number | undefined
	/** Speed over ground in knots */
	sog?: number | undefined
	/** True heading in degrees */
	heading?: number | undefined
	/** Navigation status code */
	navStatus?: number | undefined
	/** Destination port */
	destination?: string | undefined
	/** Estimated time of arrival */
	eta?: Date | undefined
	/** Ship draught in meters */
	draught?: number | undefined
	/** Timestamp of last message */
	lastSeen: Date
	/** AIS message type (1-27) */
	messageType: number
}

/** Default UDP port for AIS-catcher output */
const DEFAULT_OUTPUT_PORT = 10110

/**
 * NMEA AIS sentence patterns
 * !AIVDM - received from other vessels
 * !AIVDO - own vessel data
 */
const NMEA_AIS_PATTERN =
	/^!AIV(DM|DO),(\d),(\d),(\d*),([AB]),([^,*]+),(\d)\*([A-F0-9]{2})$/

/**
 * AIS-catcher Decoder - Decodes maritime AIS transponder signals.
 *
 * Uses the Network Producer pattern - AIS-catcher runs as a standalone process
 * and exposes its output via UDP. This decoder receives that output and parses
 * it into structured ShipData events.
 *
 * Supports two output formats:
 * - NMEA: Standard NMEA 0183 AIS sentences (!AIVDM/!AIVDO)
 * - JSON: JSON Lines format, easy to parse
 */
export class AisCatcherDecoder extends NetworkProducerDecoder {
	private readonly options: AisCatcherOptions
	private lineBuffer: string = ""

	constructor(config: DecoderConfig, logger: Logger) {
		// Build the network producer config from decoder config
		const options = parseAisCatcherOptions(config.options)
		const outputPort = options.outputPort ?? DEFAULT_OUTPUT_PORT

		const networkConfig: NetworkProducerConfig = {
			...config,
			outputHost: config.outputHost ?? "127.0.0.1",
			outputPort,
			outputProtocol: "udp", // AIS-catcher typically uses UDP for output
		}

		super(networkConfig, logger)
		this.options = options
	}

	/**
	 * Returns the AIS-catcher command (Requirement 25.1).
	 */
	protected getCommand(): string {
		return "AIS-catcher"
	}

	/**
	 * Returns command line arguments for AIS-catcher (Requirement 25.1).
	 */
	protected getArgs(): string[] {
		const args: string[] = []

		// Input source configuration (Requirement 25.4)
		if (this.options.rtlTcpHost) {
			// RTL-TCP input
			args.push(
				"-r",
				`${this.options.rtlTcpHost}:${this.options.rtlTcpPort ?? 1234}`,
			)
		} else if (this.options.spyServerHost) {
			// SpyServer input
			args.push(
				"-y",
				`${this.options.spyServerHost}:${this.options.spyServerPort ?? 5555}`,
			)
		} else if (this.options.deviceSerial) {
			// Local RTL-SDR by serial
			args.push("-d", this.options.deviceSerial)
		} else if (this.options.device) {
			// Local RTL-SDR by index
			args.push("-d", this.options.device)
		}

		// Gain setting
		if (this.options.gain !== undefined) {
			args.push("-gr", `tuner=${this.options.gain}`)
		}

		// PPM correction
		if (this.options.ppm !== undefined) {
			args.push("-p", this.options.ppm.toString())
		}

		// Output format and port configuration (Requirement 25.3)
		const outputPort = this.options.outputPort ?? DEFAULT_OUTPUT_PORT

		if (this.options.outputFormat === "json") {
			// JSON output via UDP
			args.push("-u", `127.0.0.1:${outputPort}`, "JSON")
		} else {
			// NMEA output via UDP (default)
			args.push("-u", `127.0.0.1:${outputPort}`)
		}

		// Additional arguments
		if (this.options.extraArgs) {
			args.push(...this.options.extraArgs)
		}

		return args
	}

	/**
	 * Returns the decoder's capabilities (Requirement 17.1).
	 * AIS-catcher is an external SDR decoder that produces NMEA or JSON output.
	 */
	protected getCaps(): DecoderCaps {
		const outputFormat = this.options.outputFormat === "json" ? "jsonl" : "nmea"

		return {
			input: "external",
			wantsExclusiveSource: true,
			output: outputFormat,
			integrationPattern: "network_producer",
		}
	}

	/**
	 * Parses network data into DecoderOutput objects (Requirement 25.2).
	 * Handles NMEA and JSON formats.
	 *
	 * @param data - Buffer of data received from the network
	 * @returns Array of DecoderOutput objects with ShipData
	 */
	protected parseNetworkData(data: Buffer): DecoderOutput[] {
		if (this.options.outputFormat === "json") {
			return this.parseJsonData(data)
		} else {
			return this.parseNmeaData(data)
		}
	}

	/**
	 * Parses NMEA AIS sentence data.
	 * NMEA sentences are line-based with checksum validation.
	 */
	private parseNmeaData(data: Buffer): DecoderOutput[] {
		const outputs: DecoderOutput[] = []

		// Add new data to line buffer
		this.lineBuffer += data.toString()

		// Process complete lines
		const lines = this.lineBuffer.split("\n")
		// Keep the last incomplete line in the buffer
		this.lineBuffer = lines.pop() ?? ""

		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed) continue

			const ship = parseNmeaSentence(trimmed)
			if (ship) {
				outputs.push({
					timestamp: new Date(),
					decoder: this.id,
					type: "ship",
					data: ship,
				})
			}
		}

		return outputs
	}

	/**
	 * Parses JSON Lines format data.
	 * Each line is a complete JSON object.
	 */
	private parseJsonData(data: Buffer): DecoderOutput[] {
		const outputs: DecoderOutput[] = []

		// Add new data to line buffer
		this.lineBuffer += data.toString()

		// Process complete lines
		const lines = this.lineBuffer.split("\n")
		// Keep the last incomplete line in the buffer
		this.lineBuffer = lines.pop() ?? ""

		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed) continue

			try {
				const json = JSON.parse(trimmed) as Record<string, unknown>
				const ship = parseJsonShip(json)
				if (ship) {
					outputs.push({
						timestamp: new Date(),
						decoder: this.id,
						type: "ship",
						data: ship,
					})
				}
			} catch {
				// Skip invalid JSON lines
				this.logger.debug({ line: trimmed }, "Failed to parse JSON line")
			}
		}

		return outputs
	}
}

/**
 * Parses and validates decoder options from config.
 */
function parseAisCatcherOptions(
	options: Record<string, unknown>,
): AisCatcherOptions {
	const outputFormat =
		(options["outputFormat"] as AisCatcherOutputFormat) ?? "nmea"

	return {
		device: options["device"] as string | undefined,
		deviceSerial: options["deviceSerial"] as string | undefined,
		rtlTcpHost: options["rtlTcpHost"] as string | undefined,
		rtlTcpPort: options["rtlTcpPort"] as number | undefined,
		spyServerHost: options["spyServerHost"] as string | undefined,
		spyServerPort: options["spyServerPort"] as number | undefined,
		gain: options["gain"] as number | undefined,
		ppm: options["ppm"] as number | undefined,
		outputFormat:
			outputFormat === "nmea" || outputFormat === "json"
				? outputFormat
				: "nmea",
		outputPort: options["outputPort"] as number | undefined,
		extraArgs: options["extraArgs"] as string[] | undefined,
	}
}

/**
 * Parses an NMEA AIS sentence into ShipData.
 *
 * NMEA AIS sentences contain encoded AIS data that needs to be decoded.
 * This function handles the basic sentence parsing and extracts the MMSI
 * from the decoded payload.
 *
 * @param sentence - NMEA sentence string (e.g., "!AIVDM,1,1,,A,13u@Dp0P00PH=3pN4T0,0*7D")
 * @returns ShipData or null if parsing fails
 */
export function parseNmeaSentence(sentence: string): ShipData | null {
	// Check for AIS sentence prefix
	if (!sentence.startsWith("!AIVDM") && !sentence.startsWith("!AIVDO")) {
		return null
	}

	// Split the sentence into parts
	const parts = sentence.split(",")
	if (parts.length < 7) {
		return null
	}

	// Extract the payload (6th field, 0-indexed as 5)
	const payload = parts[5]
	if (!payload || payload.length < 1) {
		return null
	}

	// Decode the AIS payload to extract MMSI and message type
	const decoded = decodeAisPayload(payload)
	if (!decoded) {
		return null
	}

	return {
		mmsi: decoded.mmsi,
		lat: decoded.lat,
		lon: decoded.lon,
		cog: decoded.cog,
		sog: decoded.sog,
		heading: decoded.heading,
		navStatus: decoded.navStatus,
		lastSeen: new Date(),
		messageType: decoded.messageType,
	}
}

/**
 * Decoded AIS payload data.
 */
export interface DecodedAisPayload {
	messageType: number
	mmsi: string
	lat?: number | undefined
	lon?: number | undefined
	cog?: number | undefined
	sog?: number | undefined
	heading?: number | undefined
	navStatus?: number | undefined
}

/**
 * Decodes an AIS payload from 6-bit ASCII armored format.
 *
 * AIS messages use a 6-bit ASCII encoding where each character represents
 * 6 bits of data. The first 6 bits contain the message type, and bits 8-37
 * contain the 30-bit MMSI.
 *
 * @param payload - The encoded AIS payload string
 * @returns Decoded data or null if decoding fails
 */
export function decodeAisPayload(payload: string): DecodedAisPayload | null {
	if (payload.length < 7) {
		return null
	}

	// Convert payload to bit string
	let bits = ""
	for (const char of payload) {
		const code = char.charCodeAt(0)
		// AIS 6-bit ASCII: subtract 48, if > 40 subtract 8 more
		let value = code - 48
		if (value > 40) {
			value -= 8
		}
		if (value < 0 || value > 63) {
			return null
		}
		bits += value.toString(2).padStart(6, "0")
	}

	// Extract message type (bits 0-5)
	const messageType = parseInt(bits.slice(0, 6), 2)
	if (messageType < 1 || messageType > 27) {
		return null
	}

	// Extract MMSI (bits 8-37, 30 bits)
	if (bits.length < 38) {
		return null
	}
	const mmsi = parseInt(bits.slice(8, 38), 2).toString().padStart(9, "0")

	// For position reports (types 1, 2, 3), extract additional fields
	if (messageType >= 1 && messageType <= 3 && bits.length >= 168) {
		const navStatusRaw = parseInt(bits.slice(38, 42), 2)
		const sogRaw = parseInt(bits.slice(50, 60), 2) / 10 // Speed in 1/10 knot
		const lonRaw = parseSignedInt(bits.slice(61, 89), 28) / 600000 // Longitude in 1/10000 min
		const latRaw = parseSignedInt(bits.slice(89, 116), 27) / 600000 // Latitude in 1/10000 min
		const cogRaw = parseInt(bits.slice(116, 128), 2) / 10 // Course in 1/10 degree
		const headingRaw = parseInt(bits.slice(128, 137), 2) // True heading

		const result: DecodedAisPayload = {
			messageType,
			mmsi,
		}

		// Only add fields if they have valid values
		if (navStatusRaw !== 15) result.navStatus = navStatusRaw
		if (sogRaw !== 102.3) result.sog = sogRaw // 1023 = not available
		if (lonRaw !== 181) result.lon = lonRaw // 181 = not available
		if (latRaw !== 91) result.lat = latRaw // 91 = not available
		if (cogRaw !== 360) result.cog = cogRaw // 3600 = not available
		if (headingRaw !== 511) result.heading = headingRaw // 511 = not available

		return result
	}

	return { messageType, mmsi }
}

/**
 * Parses a signed integer from a binary string using two's complement.
 */
function parseSignedInt(bits: string, bitLength: number): number {
	const value = parseInt(bits, 2)
	// Check if the sign bit is set
	if (bits[0] === "1") {
		// Two's complement: subtract 2^bitLength
		return value - Math.pow(2, bitLength)
	}
	return value
}

/**
 * Parses a JSON object into ShipData.
 * Handles AIS-catcher JSON output format.
 *
 * @param json - JSON object from AIS-catcher
 * @returns ShipData or null if parsing fails
 */
export function parseJsonShip(json: Record<string, unknown>): ShipData | null {
	// AIS-catcher JSON format uses 'mmsi' field
	const mmsi = json["mmsi"]
	if (mmsi === undefined || mmsi === null) {
		return null
	}

	// Convert MMSI to string, padded to 9 digits
	const mmsiStr = String(mmsi).padStart(9, "0")

	// Extract message type
	const messageType =
		(json["type"] as number) ?? (json["msgtype"] as number) ?? 0

	return {
		mmsi: mmsiStr,
		name:
			(json["shipname"] as string)?.trim() ||
			(json["name"] as string)?.trim() ||
			undefined,
		callsign: (json["callsign"] as string)?.trim() || undefined,
		imo: json["imo"] as number | undefined,
		shipType: json["shiptype"] as number | undefined,
		lat: json["lat"] as number | undefined,
		lon: json["lon"] as number | undefined,
		cog: json["cog"] as number | undefined,
		sog:
			(json["speed"] as number | undefined) ??
			(json["sog"] as number | undefined),
		heading: json["heading"] as number | undefined,
		navStatus:
			(json["status"] as number | undefined) ??
			(json["navstatus"] as number | undefined),
		destination: (json["destination"] as string)?.trim() || undefined,
		eta: json["eta"] ? parseEta(json["eta"]) : undefined,
		draught: json["draught"] as number | undefined,
		lastSeen: new Date(),
		messageType,
	}
}

/**
 * Parses an ETA value from various formats.
 */
function parseEta(eta: unknown): Date | undefined {
	if (eta instanceof Date) {
		return eta
	}
	if (typeof eta === "string") {
		const parsed = new Date(eta)
		return isNaN(parsed.getTime()) ? undefined : parsed
	}
	if (typeof eta === "number") {
		return new Date(eta)
	}
	return undefined
}

/**
 * Factory function for creating AIS-catcher decoder instances.
 * Used by the DecoderRegistry.
 */
export function createAisCatcherDecoder(
	config: DecoderConfig,
	logger: Logger,
): AisCatcherDecoder {
	return new AisCatcherDecoder(config, logger)
}

/**
 * Capabilities for the AIS-catcher decoder.
 * Used when registering with the DecoderRegistry.
 */
export const AIS_CATCHER_CAPS: DecoderCaps = {
	input: "external",
	wantsExclusiveSource: true,
	output: "nmea", // Default, actual depends on outputFormat option
	integrationPattern: "network_producer",
}
