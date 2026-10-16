/**
 * Readsb ADS-B Decoder - Aircraft transponder signal decoder
 *
 * Requirements:
 * - 22.1: WHEN started, THE Readsb_Decoder SHALL spawn readsb with the configured device and output options
 * - 22.2: WHEN readsb outputs aircraft data, THE Readsb_Decoder SHALL parse it into structured AircraftData events
 * - 22.3: THE Readsb_Decoder SHALL support output formats: SBS (BaseStation), Beast binary, JSON
 * - 22.4: WHEN configured, THE Readsb_Decoder SHALL expose its network ports for external feeders
 */

import { iqResampleCommand, shellCommand } from "../process-tools.js"
import {
	NetworkProducerDecoder,
	type NetworkProducerConfig,
} from "../network-producer-decoder.js"
import type {
	DecoderBandDeclaration,
	DecoderCaps,
	DecoderConfig,
	DecoderOutput,
	DecoderRateAdapter,
	DecoderRateRequirements,
} from "../types.js"
import type { Logger } from "../../utils/logger.js"
import {
	readExtraArgsOption,
	createOptionWarner,
	readNumericOption,
	type NumericOptionWarn,
} from "../option-values.js"
import { READSB_BOUNDS } from "../options/readsb.js"
import type { RawAircraftMessage } from "@wavekit/api-types"
import { safeErrorFields } from "../safe-error-fields.js"

/** Mode S / ADS-B carrier (1090ES). */
export const ADSB_FREQUENCY_HZ = 1_090_000_000

/** readsb's fixed ADS-B sample rate; stdin mode adapts the source to it. */
export const READSB_SAMPLE_RATE = 2_400_000

/**
 * Adapter facts for stdin mode at source rate `fs`; undefined in rtlTcpHost
 * mode, where readsb owns its input and no core pipeline exists.
 */
export function readsbRateAdapter(
	options: Pick<ReadsbOptions, "rtlTcpHost">,
	fs: number,
): DecoderRateAdapter | undefined {
	if (options.rtlTcpHost) return undefined
	return {
		adaptation: fs === READSB_SAMPLE_RATE ? "none" : "resample",
		frontendRateHz: READSB_SAMPLE_RATE,
		decoderInputKind: "iq",
		decoderInputRateHz: READSB_SAMPLE_RATE,
		decoderInputFormat: "uc8",
	}
}

/** Supported output formats for readsb (Requirement 22.3) */
export type ReadsbOutputFormat = "sbs" | "beast" | "json"

/**
 * Configuration options for the Readsb decoder.
 */
export interface ReadsbOptions {
	inputSampleRate?: number | undefined
	/** RTL-SDR device index or serial (local device mode) */
	device?: string | undefined
	/** RTL-SDR device serial number (local device mode) */
	deviceSerial?: string | undefined
	/** RTL-TCP host for network mode (e.g., "192.168.1.69") */
	rtlTcpHost?: string | undefined
	/** RTL-TCP port for network mode (default: 1235) */
	rtlTcpPort?: number | undefined
	/** Gain setting for the RTL-SDR */
	gain?: number | "auto" | undefined
	/** PPM correction for the RTL-SDR */
	ppm?: number | undefined
	/** Output format: sbs, beast, or json (Requirement 22.3) */
	outputFormat: ReadsbOutputFormat
	/** Output port (default: 30003 for SBS, 30005 for Beast, 30047 for JSON) */
	outputPort?: number | undefined
	/** Enable MLAT support */
	enableMlat?: boolean | undefined
	/** Receiver latitude (wins over `station.lat` when both coordinates are set) */
	lat?: number | undefined
	/** Receiver longitude (wins over `station.lon` when both coordinates are set) */
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
/** Receiver location from `config.station`; either coordinate may be unset. */
export interface ReadsbStationLocation {
	lat?: number | undefined
	lon?: number | undefined
}

/**
 * Station location source: a fixed location, or a getter read at each process
 * start so a changed station applies at the next start. A getter returning
 * null or throwing counts as no station.
 */
export type ReadsbStationSource =
	| ReadsbStationLocation
	| (() => ReadsbStationLocation | null)

export class ReadsbDecoder extends NetworkProducerDecoder {
	private options: ReadsbOptions
	private lineBuffer: string = ""
	private readonly station: ReadsbStationSource
	private readonly warnOption: NumericOptionWarn

	constructor(
		config: DecoderConfig,
		logger: Logger,
		station: ReadsbStationSource = {},
	) {
		// Build the network producer config from decoder config
		const warnOption = createOptionWarner((fields, message) =>
			logger.warn(fields, message),
		)
		const options = parseReadsbOptions(config.options, warnOption)
		const outputPort = options.outputPort ?? DEFAULT_PORTS[options.outputFormat]

		const networkConfig: NetworkProducerConfig = {
			...config,
			outputHost: config.outputHost ?? "127.0.0.1",
			outputPort,
			outputProtocol: "tcp",
		}

		super(networkConfig, logger)
		this.options = options
		this.warnOption = warnOption
		this.station = typeof station === "function" ? station : { ...station }
	}

	/**
	 * Station location resolved now: a getter is consulted on every call, and
	 * invalid, out-of-range or non-finite coordinates count as unset.
	 */
	private stationLocation(): ReadsbStationLocation {
		let station: ReadsbStationLocation | null
		if (typeof this.station === "function") {
			try {
				station = this.station()
			} catch (error: unknown) {
				this.logger.warn(
					{ err: safeErrorFields(error) },
					"Station location lookup failed; starting readsb without it",
				)
				return {}
			}
		} else {
			station = this.station
		}
		if (station === null || typeof station !== "object") return {}
		return {
			lat: coordinate(station.lat, 90),
			lon: coordinate(station.lon, 180),
		}
	}

	/**
	 * Receiver location for readsb (WG3 req 9.1): the decoder options when both
	 * coordinates are set, else the station when both are set, else none. Read
	 * at each process start (from getArgs), so a station change applies at the
	 * next start.
	 */
	private receiverLocation(): { lat: number; lon: number } | null {
		const { lat, lon } = this.options
		if (lat !== undefined && lon !== undefined) return { lat, lon }
		const station = this.stationLocation()
		if (station.lat !== undefined && station.lon !== undefined)
			return { lat: station.lat, lon: station.lon }
		return null
	}

	/**
	 * Returns the readsb command (Requirement 22.1).
	 */
	protected getCommand(): string {
		return this.options.rtlTcpHost ? "readsb" : "/bin/sh"
	}

	/**
	 * Returns command line arguments for readsb (Requirement 22.1).
	 *
	 * IMPORTANT: readsb requires 2.4 Msps sample rate for ADS-B decoding.
	 * When using ifile mode (stdin), the data must already be at 2.4 Msps.
	 * If rtlTcpHost is configured, we use network mode where readsb controls the sample rate.
	 */
	protected override onOptionsUpdated(): void {
		this.options = parseReadsbOptions(this.config.options, this.warnOption)
	}

	protected getArgs(): string[] {
		const args = this.getReadsbArgs()
		if (this.options.rtlTcpHost) return args
		const decoder = shellCommand("readsb", args)
		const rate = this.options.inputSampleRate ?? 2048000
		return [
			"-c",
			rate === READSB_SAMPLE_RATE
				? decoder
				: `${iqResampleCommand(rate, READSB_SAMPLE_RATE)} | ${decoder}`,
		]
	}

	/**
	 * The readsb 2.0 Msps capture floor is an evidence gap, so stdin mode
	 * declares only its fixed adapter rate (verdict stays unknown). rtlTcpHost
	 * mode owns its input and is never evaluated against the core source.
	 */
	getRateRequirements(): DecoderRateRequirements {
		if (this.options.rtlTcpHost)
			return {
				version: 1,
				sourceKind: "external",
				decoderInput: { kind: "external" },
			}
		const accepted = [
			{ kind: "discrete" as const, valuesHz: [READSB_SAMPLE_RATE] },
		]
		return {
			version: 1,
			sourceKind: "iq",
			frontendIq: { preferredHz: READSB_SAMPLE_RATE, accepted },
			decoderInput: {
				kind: "iq",
				format: "uc8",
				preferredHz: READSB_SAMPLE_RATE,
				accepted,
			},
		}
	}

	getRateAdapter(input: {
		sampleRateHz: number
	}): DecoderRateAdapter | undefined {
		return readsbRateAdapter(this.options, input.sampleRateHz)
	}

	/**
	 * Stdin mode demodulates the capture centre and Mode S/ADS-B is 1090 MHz
	 * by protocol. rtlTcpHost mode tunes its own receiver: nothing to declare.
	 */
	getBandDeclaration(): DecoderBandDeclaration {
		if (this.options.rtlTcpHost) return { ownSource: true }
		return { intrinsic: { targetsHz: [ADSB_FREQUENCY_HZ], basis: "protocol" } }
	}

	private getReadsbArgs(): string[] {
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
			// The stdin pipeline adapts the shared source to readsb's fixed 2.4 Msps.
			args.push("--device-type", "ifile")
			args.push("--ifile", "-")
			args.push("--iformat", "UC8")
			// Note: --sample-rate is not a valid option for ifile mode
			// readsb uses fixed 2.4 Msps internally for ADS-B
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
		// Pinned readsb treats --net-only as a legacy alias for --net.

		// Receiver location (range, CPR local decode, MLAT), independent of
		// enableMlat (WG3 req 9.1)
		const location = this.receiverLocation()
		if (location) {
			args.push("--lat", location.lat.toString())
			args.push("--lon", location.lon.toString())
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
	 * - Sample rate: 2.4 Msps (fixed, not configurable)
	 *
	 * Stdin mode resamples the shared source to the fixed decoder rate.
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
			// rtlTcpHost mode connects to rtl_tcp itself and ignores stdin, so it
			// must not take a fanout branch (or a source reservation).
			input: this.options.rtlTcpHost ? "external" : "iq",
			wantsExclusiveSource: false,
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
				// Decoder output line: documented diagnostic exception to the no-option-text log rule (Main, WG7 HW R2).
				this.logger.debug({ line: trimmed }, "Failed to parse JSON line")
			}
		}

		return outputs
	}
}

/**
 * A usable receiver coordinate: a finite number within [-limit, limit].
 * Anything else (null, NaN, string, out of range) counts as unset.
 */
function coordinate(value: unknown, limit: number): number | undefined {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		Math.abs(value) <= limit
		? value
		: undefined
}

/**
 * Parses and validates decoder options from config.
 */
function parseReadsbOptions(
	options: Record<string, unknown>,
	warn: NumericOptionWarn,
): ReadsbOptions {
	const port = (key: string) =>
		readNumericOption(
			options[key],
			{ key, integer: true, ...READSB_BOUNDS.port },
			warn,
		)
	const outputFormat = (options["outputFormat"] as ReadsbOutputFormat) ?? "sbs"

	return {
		inputSampleRate: readNumericOption(
			options["inputSampleRate"],
			{
				key: "inputSampleRate",
				integer: false,
				...READSB_BOUNDS.sampleRateHz,
			},
			warn,
		),
		device: options["device"] as string | undefined,
		deviceSerial: options["deviceSerial"] as string | undefined,
		rtlTcpHost: options["rtlTcpHost"] as string | undefined,
		rtlTcpPort: port("rtlTcpPort"),
		gain:
			options["gain"] === "auto"
				? "auto"
				: readNumericOption(
						options["gain"],
						{ key: "gain", integer: false, ...READSB_BOUNDS.gainDb },
						warn,
					),
		ppm: readNumericOption(
			options["ppm"],
			{ key: "ppm", integer: false, ...READSB_BOUNDS.ppm },
			warn,
		),
		outputFormat:
			outputFormat === "sbs" ||
			outputFormat === "beast" ||
			outputFormat === "json"
				? outputFormat
				: "sbs",
		outputPort: port("outputPort"),
		enableMlat: options["enableMlat"] as boolean | undefined,
		lat: coordinate(options["lat"], 90),
		lon: coordinate(options["lon"], 180),
		extraArgs: readExtraArgsOption(options["extraArgs"], warn),
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
	// IsOnGround is -1 (ground), 0 (airborne) or empty (not in this message).
	const onGround =
		match[18] === "-1" ? true : match[18] === "0" ? false : undefined

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
 * Registry factory that injects the station location (WG3 req 9.1), either
 * fixed or as a getter read at each start. Explicit `lat`/`lon` decoder
 * options still win.
 */
export function readsbDecoderFactory(
	station: ReadsbStationSource,
): (config: DecoderConfig, logger: Logger) => ReadsbDecoder {
	return (config, logger) => new ReadsbDecoder(config, logger, station)
}

/**
 * Capabilities for the Readsb decoder.
 * Used when registering with the DecoderRegistry.
 */
export const READSB_CAPS: DecoderCaps = {
	input: "iq",
	wantsExclusiveSource: false,
	output: "jsonl", // Default, actual depends on outputFormat option
	integrationPattern: "network_producer",
}
