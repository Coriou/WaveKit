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
import type { RawAircraftMessage } from "@wavekit/api-types"

/** Supported output formats for readsb (Requirement 22.3) */
export type ReadsbOutputFormat = "sbs" | "beast" | "json"

/**
 * Configuration options for the Readsb decoder.
 */
export interface ReadsbOptions {
	/** RTL-SDR device index or serial (local device mode) */
	device?: string | undefined
	/** RTL-SDR device serial number (local device mode) */
	deviceSerial?: string | undefined
	/** RTL-TCP host for network mode (e.g., "192.168.1.69") */
	rtlTcpHost?: string | undefined
	/** RTL-TCP port for network mode (default: 1235) */
	rtlTcpPort?: number | undefined
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
	 *
	 * IMPORTANT: readsb requires 2.0 Msps sample rate for ADS-B decoding.
	 * When using ifile mode (stdin), the data must already be at 2.0 Msps.
	 * If rtlTcpHost is configured, we use network mode where readsb controls the sample rate.
	 */
	protected getArgs(): string[] {
		const args: string[] = []

		// Check if we have an rtl_tcp host configured (network mode)
		if (this.options.rtlTcpHost) {
			// Network mode: readsb connects to rtl_tcp and controls sample rate
			args.push("--device-type", "rtltcp")
			const port = this.options.rtlTcpPort ?? 1234
			args.push(
				"--net-connector",
				`${this.options.rtlTcpHost},${port},beast_in`,
			)
			// Gain setting
			if (this.options.gain !== undefined) {
				args.push("--gain", this.options.gain.toString())
			}
			// PPM correction
			if (this.options.ppm !== undefined) {
				args.push("--ppm", this.options.ppm.toString())
			}
		} else {
			// Stdin mode: We receive IQ data via stdin from WaveKit
			// NOTE: readsb expects 2.0 Msps for ADS-B. If the source is 2.4 Msps,
			// decoding will likely fail. Use rtlTcpHost for proper sample rate control.
			args.push("--device-type", "ifile")
			args.push("--ifile", "-")
			args.push("--iformat", "UC8")
			// Note: --sample-rate is not a valid option for ifile mode
			// readsb uses fixed 2.0 Msps internally for ADS-B
		}

		// Gain setting - usually ignored for file input but we can pass it
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
		// Disable other default ports to avoid conflicts/resource contention
		// By default readsb opens multiple ports (30002, 30003, 30004, 30005, etc)
		// which can cause issues. We explicitly set only what we need above,
		// and disable the others to avoid port conflicts if multiple readsb instances run.
		args.push("--net-only") // Listen only on configured ports, don't auto-open defaults

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
	 *
	 * IMPORTANT: ADS-B decoding requires:
	 * - Frequency: 1090 MHz
	 * - Sample rate: 2.0 Msps (fixed, not configurable)
	 *
	 * When using stdin mode (no rtlTcpHost), readsb expects the IQ stream to be
	 * at 2.0 Msps. Shared IQ sources at 2.4 Msps will NOT work correctly.
	 * For proper operation, either:
	 * 1. Use rtlTcpHost to connect to a dedicated RTL-SDR
	 * 2. Ensure the IQ source is configured for 2.0 Msps
	 */
	protected getCaps(): DecoderCaps {
		// Output format depends on configuration
		const outputFormat =
			this.options.outputFormat === "json"
				? "jsonl"
				: this.options.outputFormat === "beast"
					? "beast"
					: "text"

		// ADS-B requires exclusive access when not using network mode
		// because it needs a specific sample rate (2.0 Msps) that other decoders don't use
		const needsExclusive = !this.options.rtlTcpHost

		return {
			input: "iq",
			wantsExclusiveSource: needsExclusive,
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
		rtlTcpHost: options["rtlTcpHost"] as string | undefined,
		rtlTcpPort: options["rtlTcpPort"] as number | undefined,
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
 * @deprecated Use parseRawAircraft for full field extraction
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
 * Parses a JSON object into RawAircraftMessage with ALL available fields.
 * This extracts the full 50+ fields from readsb JSON output for
 * state-of-the-art aircraft tracking.
 *
 * Used by the AircraftTracker service for comprehensive state aggregation.
 */
export function parseRawAircraft(
	json: Record<string, unknown>,
): RawAircraftMessage | null {
	// readsb JSON format uses 'hex' for ICAO address
	const hex = (json["hex"] as string) ?? (json["icao"] as string)
	if (!hex) return null

	// Build result object, only adding defined properties
	// This is required for exactOptionalPropertyTypes compliance
	const result: RawAircraftMessage = {
		hex: hex.toUpperCase().replace(/^~/, ""), // Remove non-ICAO prefix
	}

	// Core identity
	if (typeof json["type"] === "string") result.type = json["type"]
	if (typeof json["flight"] === "string") {
		const trimmed = json["flight"].trim()
		if (trimmed) result.flight = trimmed
	}
	if (typeof json["squawk"] === "string") result.squawk = json["squawk"]
	if (typeof json["emergency"] === "string")
		result.emergency = json["emergency"]
	if (typeof json["category"] === "string") result.category = json["category"]

	// Position
	if (typeof json["lat"] === "number") result.lat = json["lat"]
	if (typeof json["lon"] === "number") result.lon = json["lon"]
	if (typeof json["seen_pos"] === "number") result.seen_pos = json["seen_pos"]
	if (typeof json["nic"] === "number") result.nic = json["nic"]
	if (typeof json["rc"] === "number") result.rc = json["rc"]
	if (typeof json["nac_p"] === "number") result.nac_p = json["nac_p"]

	// Altitude
	if (json["alt_baro"] === "ground") result.alt_baro = "ground"
	else if (typeof json["alt_baro"] === "number")
		result.alt_baro = json["alt_baro"]
	if (typeof json["alt_geom"] === "number") result.alt_geom = json["alt_geom"]
	if (typeof json["baro_rate"] === "number")
		result.baro_rate = json["baro_rate"]
	if (typeof json["geom_rate"] === "number")
		result.geom_rate = json["geom_rate"]

	// Velocity
	if (typeof json["gs"] === "number") result.gs = json["gs"]
	if (typeof json["tas"] === "number") result.tas = json["tas"]
	if (typeof json["ias"] === "number") result.ias = json["ias"]
	if (typeof json["mach"] === "number") result.mach = json["mach"]
	if (typeof json["track"] === "number") result.track = json["track"]
	if (typeof json["track_rate"] === "number")
		result.track_rate = json["track_rate"]
	if (typeof json["mag_heading"] === "number")
		result.mag_heading = json["mag_heading"]
	if (typeof json["true_heading"] === "number")
		result.true_heading = json["true_heading"]
	if (typeof json["roll"] === "number") result.roll = json["roll"]

	// Navigation
	if (typeof json["nav_qnh"] === "number") result.nav_qnh = json["nav_qnh"]
	if (typeof json["nav_altitude_mcp"] === "number")
		result.nav_altitude_mcp = json["nav_altitude_mcp"]
	if (typeof json["nav_altitude_fms"] === "number")
		result.nav_altitude_fms = json["nav_altitude_fms"]
	if (typeof json["nav_heading"] === "number")
		result.nav_heading = json["nav_heading"]
	if (Array.isArray(json["nav_modes"]))
		result.nav_modes = json["nav_modes"] as string[]

	// Enrichment (from readsb db)
	if (typeof json["r"] === "string") result.r = json["r"]
	if (typeof json["t"] === "string") result.t = json["t"]
	if (typeof json["desc"] === "string") result.desc = json["desc"]

	// Signal quality
	if (typeof json["rssi"] === "number") result.rssi = json["rssi"]
	if (typeof json["seen"] === "number") result.seen = json["seen"]
	if (typeof json["messages"] === "number") result.messages = json["messages"]
	if (typeof json["sil"] === "number") result.sil = json["sil"]
	if (typeof json["sil_type"] === "string") result.sil_type = json["sil_type"]
	if (typeof json["nac_v"] === "number") result.nac_v = json["nac_v"]
	if (typeof json["gva"] === "number") result.gva = json["gva"]
	if (typeof json["sda"] === "number") result.sda = json["sda"]
	if (typeof json["version"] === "number") result.version = json["version"]

	return result
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
