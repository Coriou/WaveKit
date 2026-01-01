/**
 * Readsb ADS-B Decoder - Aircraft transponder signal decoder
 *
 * Requirements:
 * - 22.1: WHEN started, THE Readsb_Decoder SHALL spawn readsb with the configured device and output options
 * - 22.2: WHEN readsb outputs aircraft data, THE Readsb_Decoder SHALL parse it into structured AircraftData events
 * - 22.3: THE Readsb_Decoder SHALL support output formats: SBS (BaseStation), Beast binary, JSON
 * - 22.4: WHEN configured, THE Readsb_Decoder SHALL expose its network ports for external feeders
 */

import {
	NetworkProducerDecoder,
	type NetworkProducerConfig,
} from "../network-producer-decoder.js"
import type { DecoderCaps, DecoderConfig, DecoderOutput } from "../types.js"
import type { Logger } from "../../utils/logger.js"

/** Supported output formats for readsb (Requirement 22.3) */
export type ReadsbOutputFormat = "sbs" | "beast" | "json"

/**
 * Configuration options for the Readsb decoder.
 */
export interface ReadsbOptions {
	/** RTL-SDR device index or serial */
	device?: string | undefined
	/** RTL-SDR device serial number */
	deviceSerial?: string | undefined
	/** Gain setting for the RTL-SDR */
	gain?: number | undefined
	/** PPM correction for the RTL-SDR */
	ppm?: number | undefined
	/** Output format: sbs, beast, or json (Requirement 22.3) */
	outputFormat: ReadsbOutputFormat
	/** Output port (default: 30003 for SBS, 30005 for Beast, 30047 for JSON) */
	outputPort?: number | undefined
	/** Enable MLAT support */
	enableMlat?: boolean | undefined
	/** Receiver latitude for MLAT */
	lat?: number | undefined
	/** Receiver longitude for MLAT */
	lon?: number | undefined
	/** Additional command line arguments */
	extraArgs?: string[] | undefined
}

/**
 * Structured aircraft data from ADS-B decoding (Requirement 22.2).
 */
export interface AircraftData {
	/** 24-bit ICAO address (hex string) */
	icao: string
	/** Aircraft callsign/flight number */
	callsign?: string | undefined
	/** Altitude in feet */
	altitude?: number | undefined
	/** Ground speed in knots */
	groundSpeed?: number | undefined
	/** Track/heading in degrees */
	track?: number | undefined
	/** Latitude */
	lat?: number | undefined
	/** Longitude */
	lon?: number | undefined
	/** Vertical rate in ft/min */
	verticalRate?: number | undefined
	/** Squawk code */
	squawk?: string | undefined
	/** Whether aircraft is on ground */
	onGround?: boolean | undefined
	/** Timestamp of last message */
	lastSeen: Date
	/** Number of messages received */
	messageCount: number
}

/** Default ports for each output format */
const DEFAULT_PORTS: Record<ReadsbOutputFormat, number> = {
	sbs: 30003,
	beast: 30005,
	json: 30047,
}

/**
 * SBS (BaseStation) message types
 * MSG,1 = ES Identification and Category
 * MSG,2 = ES Surface Position
 * MSG,3 = ES Airborne Position
 * MSG,4 = ES Airborne Velocity
 * MSG,5 = Surveillance Alt
 * MSG,6 = Surveillance ID
 * MSG,7 = Air To Air
 * MSG,8 = All Call Reply
 */
const SBS_MSG_PATTERN =
	/^MSG,(\d+),\d+,\d+,([A-F0-9]{6}),\d+,(\d{4}\/\d{2}\/\d{2}),(\d{2}:\d{2}:\d{2}\.\d{3}),(\d{4}\/\d{2}\/\d{2}),(\d{2}:\d{2}:\d{2}\.\d{3}),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*)$/

/**
 * Readsb ADS-B Decoder - Decodes aircraft transponder signals.
 *
 * Uses the Network Producer pattern - readsb runs as a standalone process
 * and exposes its output via TCP ports. This decoder connects to those
 * ports and parses the output into structured AircraftData events.
 *
 * Supports three output formats:
 * - SBS (BaseStation): CSV format, human-readable
 * - Beast: Binary format, efficient for feeders
 * - JSON: JSON Lines format, easy to parse
 */
export class ReadsbDecoder extends NetworkProducerDecoder {
	private readonly options: ReadsbOptions
	private lineBuffer: string = ""

	constructor(config: DecoderConfig, logger: Logger) {
		// Build the network producer config from decoder config
		const options = parseReadsbOptions(config.options)
		const outputPort = options.outputPort ?? DEFAULT_PORTS[options.outputFormat]

		const networkConfig: NetworkProducerConfig = {
			...config,
			outputHost: config.outputHost ?? "127.0.0.1",
			outputPort,
			outputProtocol: "tcp",
		}

		super(networkConfig, logger)
		this.options = options
	}

	/**
	 * Returns the readsb command (Requirement 22.1).
	 */
	protected getCommand(): string {
		return "readsb"
	}

	/**
	 * Returns command line arguments for readsb (Requirement 22.1).
	 */
	protected getArgs(): string[] {
		const args: string[] = []

		// Device configuration
		if (this.options.deviceSerial) {
			args.push("--device-type", "rtlsdr")
			args.push("--device", this.options.deviceSerial)
		} else if (this.options.device) {
			args.push("--device-type", "rtlsdr")
			args.push("--device", this.options.device)
		}

		// Gain setting
		if (this.options.gain !== undefined) {
			args.push("--gain", this.options.gain.toString())
		}

		// PPM correction
		if (this.options.ppm !== undefined) {
			args.push("--ppm", this.options.ppm.toString())
		}

		// Output format and port configuration (Requirement 22.3, 22.4)
		const outputPort =
			this.options.outputPort ?? DEFAULT_PORTS[this.options.outputFormat]

		switch (this.options.outputFormat) {
			case "sbs":
				args.push("--net-sbs-port", outputPort.toString())
				break
			case "beast":
				args.push("--net-bo-port", outputPort.toString())
				break
			case "json":
				args.push("--net-json-port", outputPort.toString())
				break
		}

		// Enable network output
		args.push("--net")

		// MLAT configuration
		if (this.options.enableMlat) {
			if (this.options.lat !== undefined && this.options.lon !== undefined) {
				args.push("--lat", this.options.lat.toString())
				args.push("--lon", this.options.lon.toString())
			}
		}

		// Additional arguments
		if (this.options.extraArgs) {
			args.push(...this.options.extraArgs)
		}

		return args
	}

	/**
	 * Returns the decoder's capabilities (Requirement 17.1).
	 * Readsb is an external SDR decoder that produces output in various formats.
	 */
	protected getCaps(): DecoderCaps {
		// Output format depends on configuration
		const outputFormat =
			this.options.outputFormat === "json"
				? "jsonl"
				: this.options.outputFormat === "beast"
					? "beast"
					: "text"

		return {
			input: "external",
			wantsExclusiveSource: true,
			output: outputFormat,
			integrationPattern: "network_producer",
		}
	}

	/**
	 * Parses network data into DecoderOutput objects (Requirement 22.2).
	 * Handles SBS, Beast, and JSON formats.
	 *
	 * @param data - Buffer of data received from the network
	 * @returns Array of DecoderOutput objects with AircraftData
	 */
	protected parseNetworkData(data: Buffer): DecoderOutput[] {
		switch (this.options.outputFormat) {
			case "sbs":
				return this.parseSbsData(data)
			case "beast":
				return this.parseBeastData(data)
			case "json":
				return this.parseJsonData(data)
			default:
				return []
		}
	}

	/**
	 * Parses SBS (BaseStation) format data.
	 * SBS format is CSV with fields separated by commas.
	 */
	private parseSbsData(data: Buffer): DecoderOutput[] {
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

			const aircraft = parseSbsLine(trimmed)
			if (aircraft) {
				outputs.push({
					timestamp: new Date(),
					decoder: this.id,
					type: "aircraft",
					data: aircraft,
				})
			}
		}

		return outputs
	}

	/**
	 * Parses Beast binary format data.
	 * Beast format uses escape sequences and message type bytes.
	 */
	private parseBeastData(data: Buffer): DecoderOutput[] {
		const outputs: DecoderOutput[] = []

		// Beast format parsing
		// Format: <escape> <type> <timestamp 6 bytes> <signal 1 byte> <message>
		// Escape byte is 0x1a, doubled escapes (0x1a 0x1a) represent literal 0x1a

		let offset = 0
		while (offset < data.length) {
			// Look for escape byte
			if (data[offset] !== 0x1a) {
				offset++
				continue
			}

			// Check if we have enough data for the header
			if (offset + 2 >= data.length) break

			const msgType = data[offset + 1]

			// Determine message length based on type
			let msgLen: number
			switch (msgType) {
				case 0x31: // Mode-AC (2 bytes)
					msgLen = 2
					break
				case 0x32: // Mode-S short (7 bytes)
					msgLen = 7
					break
				case 0x33: // Mode-S long (14 bytes)
					msgLen = 14
					break
				default:
					// Unknown message type, skip
					offset++
					continue
			}

			// Check if we have the full message (escape + type + timestamp + signal + message)
			const totalLen = 2 + 6 + 1 + msgLen
			if (offset + totalLen > data.length) break

			// Extract the message
			const timestamp = data.subarray(offset + 2, offset + 8)
			const signal = data[offset + 8] ?? 0
			const message = data.subarray(offset + 9, offset + 9 + msgLen)

			// Parse the Mode-S message to extract ICAO
			const aircraft = parseBeastMessage(msgType, timestamp, signal, message)
			if (aircraft) {
				outputs.push({
					timestamp: new Date(),
					decoder: this.id,
					type: "aircraft",
					data: aircraft,
				})
			}

			offset += totalLen
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
				const aircraft = parseJsonAircraft(json)
				if (aircraft) {
					outputs.push({
						timestamp: new Date(),
						decoder: this.id,
						type: "aircraft",
						data: aircraft,
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
function parseReadsbOptions(options: Record<string, unknown>): ReadsbOptions {
	const outputFormat = (options["outputFormat"] as ReadsbOutputFormat) ?? "sbs"

	return {
		device: options["device"] as string | undefined,
		deviceSerial: options["deviceSerial"] as string | undefined,
		gain: options["gain"] as number | undefined,
		ppm: options["ppm"] as number | undefined,
		outputFormat:
			outputFormat === "sbs" ||
			outputFormat === "beast" ||
			outputFormat === "json"
				? outputFormat
				: "sbs",
		outputPort: options["outputPort"] as number | undefined,
		enableMlat: options["enableMlat"] as boolean | undefined,
		lat: options["lat"] as number | undefined,
		lon: options["lon"] as number | undefined,
		extraArgs: options["extraArgs"] as string[] | undefined,
	}
}

/**
 * Parses an SBS (BaseStation) format line into AircraftData.
 *
 * SBS format fields:
 * MSG,type,sessionId,aircraftId,icao,flightId,dateGen,timeGen,dateLog,timeLog,
 * callsign,altitude,groundSpeed,track,lat,lon,verticalRate,squawk,alert,emergency,spi,onGround
 */
export function parseSbsLine(line: string): AircraftData | null {
	const match = SBS_MSG_PATTERN.exec(line)
	if (!match) return null

	const icao = match[2]
	if (!icao) return null

	// Parse optional fields
	const callsign = match[7]?.trim() || undefined
	const altitude = match[8] ? parseInt(match[8], 10) : undefined
	const groundSpeed = match[9] ? parseFloat(match[9]) : undefined
	const track = match[10] ? parseFloat(match[10]) : undefined
	const lat = match[11] ? parseFloat(match[11]) : undefined
	const lon = match[12] ? parseFloat(match[12]) : undefined
	const verticalRate = match[13] ? parseInt(match[13], 10) : undefined
	const squawk = match[14]?.trim() || undefined
	const onGround = match[18] === "-1"

	return {
		icao,
		callsign,
		altitude: isNaN(altitude ?? NaN) ? undefined : altitude,
		groundSpeed: isNaN(groundSpeed ?? NaN) ? undefined : groundSpeed,
		track: isNaN(track ?? NaN) ? undefined : track,
		lat: isNaN(lat ?? NaN) ? undefined : lat,
		lon: isNaN(lon ?? NaN) ? undefined : lon,
		verticalRate: isNaN(verticalRate ?? NaN) ? undefined : verticalRate,
		squawk,
		onGround,
		lastSeen: new Date(),
		messageCount: 1,
	}
}

/**
 * Parses a Beast binary message into AircraftData.
 */
export function parseBeastMessage(
	msgType: number,
	_timestamp: Buffer,
	_signal: number,
	message: Buffer,
): AircraftData | null {
	// Only parse Mode-S messages (types 0x32 and 0x33)
	if (msgType !== 0x32 && msgType !== 0x33) {
		return null
	}

	// Extract ICAO address from the message
	// For Mode-S, ICAO is in the first 3 bytes of the message (after DF/CA byte)
	if (message.length < 4) return null

	// The ICAO address is in bytes 1-3 (after the DF byte)
	const icao = message.subarray(1, 4).toString("hex").toUpperCase()

	return {
		icao,
		lastSeen: new Date(),
		messageCount: 1,
	}
}

/**
 * Parses a JSON object into AircraftData.
 * Handles readsb JSON output format.
 */
export function parseJsonAircraft(
	json: Record<string, unknown>,
): AircraftData | null {
	// readsb JSON format uses 'hex' for ICAO address
	const icao = (json["hex"] as string) ?? (json["icao"] as string)
	if (!icao) return null

	return {
		icao: icao.toUpperCase(),
		callsign: (json["flight"] as string)?.trim() || undefined,
		altitude: json["alt_baro"] as number | undefined,
		groundSpeed: json["gs"] as number | undefined,
		track: json["track"] as number | undefined,
		lat: json["lat"] as number | undefined,
		lon: json["lon"] as number | undefined,
		verticalRate: json["baro_rate"] as number | undefined,
		squawk: json["squawk"] as string | undefined,
		onGround: json["ground"] as boolean | undefined,
		lastSeen: new Date(),
		messageCount: (json["messages"] as number) ?? 1,
	}
}

/**
 * Factory function for creating Readsb decoder instances.
 * Used by the DecoderRegistry.
 */
export function createReadsbDecoder(
	config: DecoderConfig,
	logger: Logger,
): ReadsbDecoder {
	return new ReadsbDecoder(config, logger)
}

/**
 * Capabilities for the Readsb decoder.
 * Used when registering with the DecoderRegistry.
 */
export const READSB_CAPS: DecoderCaps = {
	input: "external",
	wantsExclusiveSource: true,
	output: "jsonl", // Default, actual depends on outputFormat option
	integrationPattern: "network_producer",
}
