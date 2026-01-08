/**
 * Direwolf APRS Decoder - Amateur radio APRS packet decoder
 *
 * Requirements:
 * - 26.1: WHEN started, THE Direwolf_Decoder SHALL spawn direwolf with the configured audio input and KISS output
 * - 26.2: WHEN direwolf decodes a packet, THE Direwolf_Decoder SHALL parse it into structured APRSData events
 * - 26.3: THE Direwolf_Decoder SHALL support KISS TCP output for packet access
 * - 26.4: THE Direwolf_Decoder SHALL support audio input from PCM streams
 */

import { AudioDemodDecoder } from "../audio-demod-decoder.js"
import { createConnection, type Socket } from "node:net"
import { createSocket, type Socket as UdpSocket } from "node:dgram"
import type {
	DecoderCaps,
	DecoderConfig,
	DecoderOutput,
	DemodulationConfig,
} from "../types.js"
import type { Logger } from "../../utils/logger.js"
import { NetworkConnectionError } from "../../utils/errors.js"

/** Default KISS TCP port for direwolf */
const DEFAULT_KISS_PORT = 8001

/** Default AGW port for direwolf */
const DEFAULT_AGW_PORT = 8000

/** Default sample rate for audio input */
const DEFAULT_SAMPLE_RATE = 48000

/** KISS frame special bytes */
const KISS_FEND = 0xc0 // Frame End
const KISS_FESC = 0xdb // Frame Escape
const KISS_TFEND = 0xdc // Transposed Frame End
const KISS_TFESC = 0xdd // Transposed Frame Escape

const BASE_RECONNECT_DELAY = 2000
const MAX_RECONNECT_DELAY = 30000

/**
 * Configuration options for the Direwolf decoder.
 */
export interface DirewolfOptions {
	/** ALSA audio device or 'stdin' for piped audio (Requirement 26.4) */
	audioDevice?: string | undefined
	/** Sample rate for audio input (default: 48000) */
	sampleRate?: number | undefined
	/** KISS TCP port for packet output (default: 8001) (Requirement 26.3) */
	kissPort?: number | undefined
	/** AGW port for AGW protocol access (default: 8000) */
	agwPort?: number | undefined
	/** IQ sample rate from source (default: 2400000) */
	inputSampleRate?: number | undefined
	/** Station callsign */
	callsign?: string | undefined
	/** Additional command line arguments */
	extraArgs?: string[] | undefined
}

/**
 * Weather data from APRS weather reports.
 */
export interface APRSWeather {
	/** Temperature in Fahrenheit */
	temperature?: number | undefined
	/** Relative humidity percentage */
	humidity?: number | undefined
	/** Barometric pressure in millibars */
	pressure?: number | undefined
	/** Wind speed in mph */
	windSpeed?: number | undefined
	/** Wind direction in degrees */
	windDirection?: number | undefined
	/** Rainfall in inches (last hour) */
	rainfall?: number | undefined
}

/**
 * Message data from APRS messages.
 */
export interface APRSMessage {
	/** Addressee callsign */
	addressee: string
	/** Message text */
	text: string
	/** Message number for acknowledgment */
	messageNo?: string | undefined
}

/**
 * Structured APRS data from packet decoding (Requirement 26.2).
 */
export interface APRSData {
	/** Timestamp of packet reception */
	timestamp: Date
	/** Source callsign with SSID (e.g., "N0CALL-9") */
	source: string
	/** Destination callsign */
	destination: string
	/** Digipeater path */
	path: string[]
	/** APRS data type identifier */
	dataType: string
	/** Latitude in decimal degrees */
	lat?: number | undefined
	/** Longitude in decimal degrees */
	lon?: number | undefined
	/** Altitude in feet */
	altitude?: number | undefined
	/** Course in degrees */
	course?: number | undefined
	/** Speed in mph */
	speed?: number | undefined
	/** APRS symbol table and code */
	symbol?: string | undefined
	/** Comment or status text */
	comment?: string | undefined
	/** Weather data if present */
	weather?: APRSWeather | undefined
	/** Message data if present */
	message?: APRSMessage | undefined
	/** Raw packet data */
	raw?: string | undefined
}

/**
 * Direwolf APRS Decoder - Decodes amateur radio APRS packets.
 *
 * HYBRID IMPLEMENTATION:
 * Extends AudioDemodDecoder to consume IQ data and perform internal FM demodulation.
 * ALSO implements Network Consumer logic (like NetworkProducerDecoder) to connect
 * to direwolf's KISS TCP output port.
 *
 * Pipeline:
 * IQ -> csdr demod -> S16LE audio -> direwolf (stdin) -> KISS TCP -> WaveKit
 */
export class DirewolfDecoder extends AudioDemodDecoder {
	private readonly options: DirewolfOptions
	private kissBuffer: Buffer = Buffer.alloc(0)

	// Network Consumer State (from NetworkProducerDecoder)
	protected tcpClient: Socket | null = null
	protected udpClient: UdpSocket | null = null
	protected reconnectAttempts: number = 0
	protected reconnectTimer: ReturnType<typeof setTimeout> | null = null
	protected isReconnecting: boolean = false
	protected isStopping: boolean = false
	protected outputHost: string
	protected outputPort: number

	constructor(config: DecoderConfig, logger: Logger) {
		super(config, logger)
		this.options = parseDirewolfOptions(config.options)

		// Set up network connection params
		this.outputHost = "127.0.0.1" // Always local for spawned process
		this.outputPort = this.options.kissPort ?? DEFAULT_KISS_PORT
	}

	/**
	 * Returns the demodulation configuration for Direwolf.
	 * 12.5kHz bandwidth for APRS (NFM).
	 */
	protected getDemodConfig(): DemodulationConfig {
		return {
			bandwidth: 12500, // 12.5 kHz NFM (standard for APRS on 2m)
			sampleRate: 48000, // Direwolf native rate
			inputSampleRate: this.options.inputSampleRate ?? 2_400_000,
			deEmphasis: false,
			fmGain: 3.0, // Match working POCSAG value
			filterTransition: 0.012, // Narrow transition from working demod-test.sh
			skipDcBlock: true, // Skip DC block for digital signals
		}
	}

	/**
	 * Returns the decoder command.
	 */
	protected getDecoderCommand(): string {
		return "direwolf"
	}

	/**
	 * Returns command line arguments for direwolf.
	 * Base class handles piping audio to stdin.
	 */
	protected getDecoderArgs(): string[] {
		const args: string[] = []

		// Use configuration file
		args.push("-c", "/etc/direwolf.conf")

		// Input from stdin (csdr pipeline pipes here)
		// We explicitly tell direwolf to read from stdin with "-"
		args.push("-")

		// Sample rate override
		const sampleRate = 48000 // Fixed by demod config
		args.push("-r", sampleRate.toString())

		// KISS TCP port
		const kissPort = this.options.kissPort ?? DEFAULT_KISS_PORT
		args.push("-p", kissPort.toString())

		// AGW port
		const agwPort = this.options.agwPort ?? DEFAULT_AGW_PORT
		args.push("-a", agwPort.toString())

		// Callsign
		if (this.options.callsign) {
			args.push("-c", this.options.callsign)
		}

		// Additional arguments
		if (this.options.extraArgs) {
			args.push(...this.options.extraArgs)
		}

		return args
	}

	/**
	 * Starts the decoder process and connects to output.
	 */
	override async start(): Promise<void> {
		this.isStopping = false

		// Start the process (AudioDemodDecoder logic)
		await super.start()

		// Connect to output port (Network Consumer logic)
		// Direwolf needs time to initialize and bind the KISS port.
		// We use a longer delay and rely on exponential backoff reconnection if needed.
		setTimeout(() => {
			void this.connectToOutput()
		}, 2000)
	}

	/**
	 * Stops the decoder process.
	 */
	override async stop(): Promise<void> {
		this.isStopping = true
		// Cancel reconnects
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
		// Diconnect network
		this.disconnectFromOutput()
		// Stop process
		await super.stop()
	}

	/**
	 * Capabilities (Requirement 17.1).
	 * Now consumes IQ.
	 */
	protected override getCaps(): DecoderCaps {
		return {
			input: "iq",
			wantsExclusiveSource: false,
			preferredSampleRates: [48000],
			output: "text",
			integrationPattern: "pure_consumer", // Effectively pure consumer now
		}
	}

	/**
	 * Parses output from stdout/stderr.
	 * Direwolf logs accessible here.
	 */
	protected override parseOutput(line: string): DecoderOutput | null {
		// Log interesting direwolf output if needed
		return null
	}

	/**
	 * Sets health and emits event (Helper from NetworkProducerDecoder)
	 * Using basic typing to avoid complexity with conditional types
	 */
	protected override setHealth(health: any): void {
		if (this._health !== health) {
			const previousHealth = this._health
			this._health = health
			this.logger.info(
				{ previousHealth, newHealth: health },
				"Decoder health changed",
			)
			this.emit("health", health)
		}
	}

	// =========================================================================
	// Network Consumer Logic (Adapted from NetworkProducerDecoder)
	// =========================================================================

	protected async connectToOutput(): Promise<void> {
		const host = this.outputHost
		const port = this.outputPort

		this.logger.info({ host, port }, "Connecting to Direwolf KISS output")

		return new Promise<void>((resolve, reject) => {
			this.tcpClient = createConnection({ host, port }, () => {
				this.logger.info({ host, port }, "Connected to Direwolf KISS")
				this.reconnectAttempts = 0
				this.isReconnecting = false
				resolve()
			})

			this.tcpClient.on("data", (data: Buffer) => {
				this.handleNetworkData(data)
			})

			this.tcpClient.on("error", (err: Error) => {
				this.logger.error({ err }, "KISS connection error")
				if (!this.isReconnecting && this.reconnectAttempts === 0) {
					this.scheduleReconnect()
					resolve()
				}
			})

			this.tcpClient.on("close", () => {
				this.logger.info("KISS connection closed")
				this.tcpClient = null
				if (!this.isStopping) {
					this.scheduleReconnect()
				}
			})
		})
	}

	protected disconnectFromOutput(): void {
		if (this.tcpClient) {
			this.tcpClient.destroy()
			this.tcpClient = null
		}
	}

	protected scheduleReconnect(): void {
		if (this.isStopping || this.isReconnecting) return

		this.isReconnecting = true
		this.reconnectAttempts++
		const delay = Math.min(
			BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1),
			MAX_RECONNECT_DELAY,
		)

		this.logger.info(
			{ attempt: this.reconnectAttempts, delay },
			"Scheduling reconnect",
		)
		this.reconnectTimer = setTimeout(() => {
			void this.attemptReconnect()
		}, delay)
	}

	private async attemptReconnect(): Promise<void> {
		this.reconnectTimer = null
		if (this.isStopping) return

		try {
			await this.connectToOutput()
		} catch (err) {
			this.isReconnecting = false
			this.scheduleReconnect()
		}
	}

	private handleNetworkData(data: Buffer): void {
		this.stats.bytesIn += data.length

		// Append new data to buffer
		this.kissBuffer = Buffer.concat([this.kissBuffer, data])

		// Extract complete KISS frames
		const frames = extractKissFrames(this.kissBuffer)
		this.kissBuffer = frames.remaining

		for (const frame of frames.frames) {
			const aprs = parseKissFrame(frame)
			if (aprs) {
				const output: DecoderOutput = {
					timestamp: new Date(),
					decoder: this.id,
					type: "aprs",
					data: aprs,
				}
				this.stats.eventsOut++
				this.lastOutputAt = new Date()
				this.emit("output", output)

				// Update health
				if (this._health === "idle") {
					this.setHealth("running")
				}
			}
		}
	}
}

/**
 * Parses and validates decoder options from config.
 */
function parseDirewolfOptions(
	options: Record<string, unknown>,
): DirewolfOptions {
	return {
		audioDevice: options["audioDevice"] as string | undefined,
		sampleRate: options["sampleRate"] as number | undefined,
		kissPort: options["kissPort"] as number | undefined,
		agwPort: options["agwPort"] as number | undefined,
		callsign: options["callsign"] as string | undefined,
		extraArgs: options["extraArgs"] as string[] | undefined,
		inputSampleRate: options["inputSampleRate"] as number | undefined,
	}
}

/**
 * Result of extracting KISS frames from a buffer.
 */
interface KissFrameResult {
	/** Complete frames extracted */
	frames: Buffer[]
	/** Remaining data (incomplete frame) */
	remaining: Buffer
}

/**
 * Extracts complete KISS frames from a buffer.
 * KISS frames are delimited by FEND (0xC0) bytes.
 *
 * @param buffer - Buffer containing KISS data
 * @returns Object with extracted frames and remaining data
 */
export function extractKissFrames(buffer: Buffer): KissFrameResult {
	const frames: Buffer[] = []
	let start = -1

	for (let i = 0; i < buffer.length; i++) {
		if (buffer[i] === KISS_FEND) {
			if (start >= 0 && i > start) {
				// We have a complete frame
				const frame = buffer.subarray(start, i)
				if (frame.length > 0) {
					frames.push(Buffer.from(frame))
				}
			}
			start = i + 1
		}
	}

	// Return remaining data (incomplete frame)
	const remaining = start >= 0 ? buffer.subarray(start) : buffer

	return { frames, remaining }
}

/**
 * Unescapes a KISS frame by replacing escape sequences.
 * FESC TFEND -> FEND
 * FESC TFESC -> FESC
 *
 * @param frame - Raw KISS frame with escape sequences
 * @returns Unescaped frame data
 */
export function unescapeKissFrame(frame: Buffer): Buffer {
	const result: number[] = []

	for (let i = 0; i < frame.length; i++) {
		if (frame[i] === KISS_FESC && i + 1 < frame.length) {
			const next = frame[i + 1]
			if (next === KISS_TFEND) {
				result.push(KISS_FEND)
				i++
			} else if (next === KISS_TFESC) {
				result.push(KISS_FESC)
				i++
			} else {
				result.push(frame[i]!)
			}
		} else {
			result.push(frame[i]!)
		}
	}

	return Buffer.from(result)
}

/**
 * Parses a KISS frame into APRSData.
 * KISS frame format: [command byte] [AX.25 frame]
 *
 * @param frame - KISS frame (after FEND delimiters removed)
 * @returns APRSData or null if parsing fails
 */
export function parseKissFrame(frame: Buffer): APRSData | null {
	if (frame.length < 2) {
		return null
	}

	// Unescape the frame
	const unescaped = unescapeKissFrame(frame)

	// First byte is the KISS command (0x00 for data frame)
	const command = unescaped[0]
	if ((command! & 0x0f) !== 0x00) {
		// Not a data frame, skip
		return null
	}

	// Rest is the AX.25 frame
	const ax25Frame = unescaped.subarray(1)

	return parseAx25Frame(ax25Frame)
}

/**
 * Parses an AX.25 frame into APRSData.
 *
 * AX.25 frame format:
 * - Destination address (7 bytes)
 * - Source address (7 bytes)
 * - Digipeater addresses (0-8 x 7 bytes each)
 * - Control field (1 byte)
 * - PID field (1 byte, 0xF0 for no layer 3)
 * - Information field (variable)
 *
 * @param frame - AX.25 frame data
 * @returns APRSData or null if parsing fails
 */
export function parseAx25Frame(frame: Buffer): APRSData | null {
	// Minimum AX.25 frame: dest(7) + src(7) + ctrl(1) + pid(1) = 16 bytes
	if (frame.length < 16) {
		return null
	}

	// Parse destination address (bytes 0-6)
	const destination = parseAx25Address(frame.subarray(0, 7))
	if (!destination) return null

	// Parse source address (bytes 7-13)
	const source = parseAx25Address(frame.subarray(7, 14))
	if (!source) return null

	// Parse digipeater path
	const path: string[] = []
	let offset = 14

	// Check if there are digipeaters (bit 0 of last byte of address is 0)
	while (offset < frame.length - 2 && (frame[offset - 1]! & 0x01) === 0) {
		const digi = parseAx25Address(frame.subarray(offset, offset + 7))
		if (digi) {
			path.push(digi)
		}
		offset += 7
	}

	// Skip control and PID fields
	offset += 2

	// Information field
	if (offset >= frame.length) {
		return null
	}

	const info = frame.subarray(offset).toString("ascii")

	// Parse APRS data from information field
	return parseAprsInfo(source, destination, path, info)
}

/**
 * Parses an AX.25 address field.
 * Address format: 6 bytes callsign (space padded) + 1 byte SSID
 *
 * @param data - 7 bytes of address data
 * @returns Callsign-SSID string or null if invalid
 */
export function parseAx25Address(data: Buffer): string | null {
	if (data.length < 7) {
		return null
	}

	// Extract callsign (6 bytes, each shifted right by 1)
	let callsign = ""
	for (let i = 0; i < 6; i++) {
		const char = (data[i]! >> 1) & 0x7f
		if (char !== 0x20) {
			// Not a space
			callsign += String.fromCharCode(char)
		}
	}

	if (callsign.length === 0) {
		return null
	}

	// Extract SSID (bits 1-4 of byte 7)
	const ssid = (data[6]! >> 1) & 0x0f

	// Format as CALLSIGN-SSID (omit -0)
	return ssid > 0 ? `${callsign}-${ssid}` : callsign
}

/**
 * APRS data type identifiers.
 */
const APRS_DATA_TYPES: Record<string, string> = {
	"!": "Position",
	"=": "Position with messaging",
	"/": "Position with timestamp",
	"@": "Position with timestamp and messaging",
	";": "Object",
	")": "Item",
	"`": "Mic-E",
	"'": "Mic-E (old)",
	":": "Message",
	">": "Status",
	"<": "Capabilities",
	"?": "Query",
	T: "Telemetry",
	"#": "Peet Bros weather",
	"*": "Peet Bros weather",
	_: "Positionless weather",
	$: "Raw GPS/NMEA",
	"{": "User-defined",
	"}": "Third-party",
}

/**
 * Parses APRS information field into APRSData.
 *
 * @param source - Source callsign
 * @param destination - Destination callsign
 * @param path - Digipeater path
 * @param info - Information field content
 * @returns APRSData object
 */
export function parseAprsInfo(
	source: string,
	destination: string,
	path: string[],
	info: string,
): APRSData {
	const dataTypeChar = info.charAt(0)
	const dataType = APRS_DATA_TYPES[dataTypeChar] ?? "Unknown"

	const result: APRSData = {
		timestamp: new Date(),
		source,
		destination,
		path,
		dataType,
		raw: info,
	}

	// Parse based on data type
	switch (dataTypeChar) {
		case "!":
		case "=":
			parsePositionReport(info.substring(1), result)
			break
		case "/":
		case "@":
			parsePositionWithTimestamp(info.substring(1), result)
			break
		case ":":
			parseMessage(info.substring(1), result)
			break
		case ">":
			result.comment = info.substring(1).trim()
			break
		case "_":
			parseWeatherReport(info.substring(1), result)
			break
		case "`":
		case "'":
			parseMicE(info, destination, result)
			break
	}

	return result
}

/**
 * Parses a position report (! or = data type).
 * Format: !DDMM.hhN/DDDMM.hhW$... or compressed format
 */
function parsePositionReport(data: string, result: APRSData): void {
	// Check for compressed format (starts with symbol table ID)
	if (data.length >= 13 && /^[\/\\A-Z]/.test(data)) {
		parseCompressedPosition(data, result)
		return
	}

	// Uncompressed format: DDMM.hhN/DDDMM.hhW$comment
	const match = data.match(
		/^(\d{4}\.\d{2})([NS])(.)(\d{5}\.\d{2})([EW])(.)(.*)$/,
	)
	if (match) {
		const [, latStr, latDir, symTable, lonStr, lonDir, symCode, comment] = match
		result.lat = parseLatitude(latStr!, latDir!)
		result.lon = parseLongitude(lonStr!, lonDir!)
		result.symbol = `${symTable}${symCode}`
		if (comment) {
			parseCommentExtensions(comment, result)
		}
	}
}

/**
 * Parses a position report with timestamp (/ or @ data type).
 * Format: /HHMMSSh... or /DDHHMMz...
 */
function parsePositionWithTimestamp(data: string, result: APRSData): void {
	// Skip timestamp (7 characters: HHMMSSh or DDHHMMz)
	if (data.length >= 7) {
		parsePositionReport(data.substring(7), result)
	}
}

/**
 * Parses compressed position format.
 */
function parseCompressedPosition(data: string, result: APRSData): void {
	if (data.length < 13) return

	const symTable = data.charAt(0)
	const latChars = data.substring(1, 5)
	const lonChars = data.substring(5, 9)
	const symCode = data.charAt(9)
	const csT = data.charCodeAt(10) - 33
	const sT = data.charCodeAt(11) - 33
	const cT = data.charCodeAt(12) - 33

	// Decode latitude: 90 - (y1*91^3 + y2*91^2 + y3*91 + y4) / 380926
	const latVal =
		(latChars.charCodeAt(0) - 33) * Math.pow(91, 3) +
		(latChars.charCodeAt(1) - 33) * Math.pow(91, 2) +
		(latChars.charCodeAt(2) - 33) * 91 +
		(latChars.charCodeAt(3) - 33)
	result.lat = 90 - latVal / 380926

	// Decode longitude: -180 + (x1*91^3 + x2*91^2 + x3*91 + x4) / 190463
	const lonVal =
		(lonChars.charCodeAt(0) - 33) * Math.pow(91, 3) +
		(lonChars.charCodeAt(1) - 33) * Math.pow(91, 2) +
		(lonChars.charCodeAt(2) - 33) * 91 +
		(lonChars.charCodeAt(3) - 33)
	result.lon = -180 + lonVal / 190463

	result.symbol = `${symTable}${symCode}`

	// Decode course/speed if present
	if (cT >= 0 && cT <= 89) {
		result.course = csT * 4
		result.speed = Math.pow(1.08, sT) - 1
	}

	// Parse remaining comment
	if (data.length > 13) {
		parseCommentExtensions(data.substring(13), result)
	}
}

/**
 * Parses a message (: data type).
 * Format: :ADDRESSEE:message{msgno
 */
function parseMessage(data: string, result: APRSData): void {
	// Addressee is 9 characters, padded with spaces
	if (data.length < 10) return

	const addressee = data.substring(0, 9).trim()
	const rest = data.substring(10) // Skip the colon after addressee

	// Check for message number
	const msgMatch = rest.match(/^(.*)\{(\w+)$/)
	if (msgMatch) {
		result.message = {
			addressee,
			text: msgMatch[1]!,
			messageNo: msgMatch[2],
		}
	} else {
		result.message = {
			addressee,
			text: rest,
		}
	}
}

/**
 * Parses a positionless weather report (_ data type).
 * Format: _MMDDhhmm... weather data
 */
function parseWeatherReport(data: string, result: APRSData): void {
	// Skip timestamp (8 characters: MMDDhhmm)
	const weatherData = data.length >= 8 ? data.substring(8) : data
	result.weather = parseWeatherData(weatherData)
}

/**
 * Parses weather data from various formats.
 */
function parseWeatherData(data: string): APRSWeather {
	const weather: APRSWeather = {}

	// Wind direction: cDDD (3 digits)
	const windDirMatch = data.match(/c(\d{3})/)
	if (windDirMatch) {
		weather.windDirection = parseInt(windDirMatch[1]!, 10)
	}

	// Wind speed: sSS (2-3 digits, mph)
	const windSpeedMatch = data.match(/s(\d{2,3})/)
	if (windSpeedMatch) {
		weather.windSpeed = parseInt(windSpeedMatch[1]!, 10)
	}

	// Temperature: tTTT (3 digits, Fahrenheit, can be negative)
	const tempMatch = data.match(/t(-?\d{2,3})/)
	if (tempMatch) {
		weather.temperature = parseInt(tempMatch[1]!, 10)
	}

	// Humidity: hHH (2 digits, 00 = 100%)
	const humidityMatch = data.match(/h(\d{2})/)
	if (humidityMatch) {
		const h = parseInt(humidityMatch[1]!, 10)
		weather.humidity = h === 0 ? 100 : h
	}

	// Barometric pressure: bBBBBB (5 digits, tenths of millibars)
	const pressureMatch = data.match(/b(\d{5})/)
	if (pressureMatch) {
		weather.pressure = parseInt(pressureMatch[1]!, 10) / 10
	}

	// Rain last hour: rRRR (3 digits, hundredths of inch)
	const rainMatch = data.match(/r(\d{3})/)
	if (rainMatch) {
		weather.rainfall = parseInt(rainMatch[1]!, 10) / 100
	}

	return weather
}

/**
 * Parses Mic-E encoded position (` or ' data type).
 * Mic-E encodes position in the destination field and info field.
 */
function parseMicE(info: string, destination: string, result: APRSData): void {
	if (info.length < 9 || destination.length < 6) return

	// Decode latitude from destination field
	const latDigits: number[] = []
	const latNS: boolean[] = []
	const lonOffset: boolean[] = []

	for (let i = 0; i < 6; i++) {
		const c = destination.charCodeAt(i)
		if (c >= 0x30 && c <= 0x39) {
			// 0-9
			latDigits.push(c - 0x30)
			latNS.push(false)
			lonOffset.push(false)
		} else if (c >= 0x41 && c <= 0x4a) {
			// A-J (custom)
			latDigits.push(c - 0x41)
			latNS.push(false)
			lonOffset.push(false)
		} else if (c >= 0x50 && c <= 0x59) {
			// P-Y
			latDigits.push(c - 0x50)
			latNS.push(true)
			lonOffset.push(true)
		} else if (c === 0x4b || c === 0x4c) {
			// K, L (space)
			latDigits.push(0)
			latNS.push(false)
			lonOffset.push(true)
		} else if (c === 0x5a) {
			// Z (space)
			latDigits.push(0)
			latNS.push(true)
			lonOffset.push(true)
		} else {
			return // Invalid character
		}
	}

	// Calculate latitude
	const latDeg = latDigits[0]! * 10 + latDigits[1]!
	const latMin =
		latDigits[2]! * 10 +
		latDigits[3]! +
		(latDigits[4]! * 10 + latDigits[5]!) / 100
	result.lat = latDeg + latMin / 60
	if (!latNS[0] && !latNS[1] && !latNS[2]) {
		result.lat = -result.lat // South
	}

	// Decode longitude from info field
	const d = info.charCodeAt(1) - 28
	const m = info.charCodeAt(2) - 28
	const h = info.charCodeAt(3) - 28

	let lonDeg = d
	if (lonOffset[4]) lonDeg += 100
	if (lonDeg >= 180 && lonDeg <= 189) lonDeg -= 80
	if (lonDeg >= 190 && lonDeg <= 199) lonDeg -= 190

	let lonMin = m
	if (lonMin >= 60) lonMin -= 60

	const lonHun = h

	result.lon = lonDeg + (lonMin + lonHun / 100) / 60
	if (!lonOffset[5]) {
		result.lon = -result.lon // West
	}

	// Decode speed and course
	const sp = info.charCodeAt(4) - 28
	const dc = info.charCodeAt(5) - 28
	const se = info.charCodeAt(6) - 28

	result.speed = sp * 10 + Math.floor(dc / 10)
	result.course = (dc % 10) * 100 + se

	// Symbol
	if (info.length >= 9) {
		result.symbol = `${info.charAt(8)}${info.charAt(7)}`
	}

	// Comment
	if (info.length > 9) {
		result.comment = info.substring(9).trim()
	}
}

/**
 * Parses comment extensions (altitude, course/speed, etc.).
 */
function parseCommentExtensions(comment: string, result: APRSData): void {
	// Course/Speed: CCC/SSS
	const csMatch = comment.match(/(\d{3})\/(\d{3})/)
	if (csMatch) {
		result.course = parseInt(csMatch[1]!, 10)
		result.speed = parseInt(csMatch[2]!, 10)
	}

	// Altitude: /A=NNNNNN (feet)
	const altMatch = comment.match(/\/A=(-?\d{6})/)
	if (altMatch) {
		result.altitude = parseInt(altMatch[1]!, 10)
	}

	// Weather data in comment
	if (comment.includes("g") || comment.includes("t") || comment.includes("h")) {
		const weather = parseWeatherData(comment)
		if (Object.keys(weather).length > 0) {
			result.weather = weather
		}
	}

	// Store remaining comment
	const cleanComment = comment
		.replace(/\d{3}\/\d{3}/, "")
		.replace(/\/A=-?\d{6}/, "")
		.trim()
	if (cleanComment) {
		result.comment = cleanComment
	}
}

/**
 * Parses latitude from DDMM.hh format.
 */
function parseLatitude(str: string, dir: string): number {
	const deg = parseInt(str.substring(0, 2), 10)
	const min = parseFloat(str.substring(2))
	let lat = deg + min / 60
	if (dir === "S") lat = -lat
	return lat
}

/**
 * Parses longitude from DDDMM.hh format.
 */
function parseLongitude(str: string, dir: string): number {
	const deg = parseInt(str.substring(0, 3), 10)
	const min = parseFloat(str.substring(3))
	let lon = deg + min / 60
	if (dir === "W") lon = -lon
	return lon
}

/**
 * Factory function for creating Direwolf decoder instances.
 * Used by the DecoderRegistry.
 */
export function createDirewolfDecoder(
	config: DecoderConfig,
	logger: Logger,
): DirewolfDecoder {
	return new DirewolfDecoder(config, logger)
}

/**
 * Capabilities for the Direwolf decoder.
 * Used when registering with the DecoderRegistry.
 */
export const DIREWOLF_CAPS: DecoderCaps = {
	input: "iq",
	wantsExclusiveSource: false,
	preferredSampleRates: [48000],
	output: "text",
	integrationPattern: "pure_consumer",
}
