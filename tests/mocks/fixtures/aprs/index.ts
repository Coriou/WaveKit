/**
 * APRS Test Fixtures
 *
 * This module provides sample APRS (Automatic Packet Reporting System) data
 * for testing the Direwolf decoder. Supports KISS binary and text formats.
 *
 * Usage:
 * ```typescript
 * import { loadKissSample, loadPacketsSample, SAMPLE_PACKETS } from '../mocks/fixtures/aprs'
 *
 * const kissFrames = loadKissSample()
 * const packets = loadPacketsSample()
 * ```
 */

import { readFileSync, writeFileSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** KISS frame special bytes */
const KISS_FEND = 0xc0
const KISS_FESC = 0xdb
const KISS_TFEND = 0xdc
const KISS_TFESC = 0xdd

/**
 * Structured APRS packet data for testing.
 */
export interface APRSPacket {
	/** Source callsign with optional SSID */
	source: string
	/** Destination callsign */
	destination: string
	/** Digipeater path */
	path: string[]
	/** APRS data type character */
	dataTypeChar: string
	/** APRS data type name */
	dataType: string
	/** Information field content */
	info: string
	/** Latitude if position packet */
	lat?: number | undefined
	/** Longitude if position packet */
	lon?: number | undefined
	/** Comment or status text */
	comment?: string | undefined
}

/**
 * Sample amateur radio callsigns used in the fixtures.
 * Includes US, Canadian, European, and Japanese formats.
 */
export const SAMPLE_CALLSIGNS = [
	"N0CALL",
	"W1AW",
	"K1ABC",
	"WA1XYZ",
	"VE3ABC",
	"VE3XYZ",
	"G4ABC",
	"DL1XYZ",
	"JA1ABC",
	"F5ABC",
	"PA3XYZ",
	"OH2ABC",
] as const

/**
 * Sample SSIDs used in the fixtures.
 * Common SSID conventions:
 * - 0: Home station
 * - 1-4: Generic
 * - 5: Smartphone
 * - 7: Handheld
 * - 9: Mobile
 * - 10: Internet gateway
 * - 11: Balloon
 * - 12: Portable
 * - 14: Truck
 * - 15: Generic
 */
export const SAMPLE_SSIDS = [0, 1, 5, 7, 9, 10, 11, 12, 14, 15] as const

/**
 * Common digipeater paths.
 */
export const SAMPLE_PATHS = [
	[],
	["WIDE1-1"],
	["WIDE1-1", "WIDE2-2"],
	["WIDE1-1", "WIDE2-1"],
	["RELAY", "WIDE"],
] as const

/**
 * APRS data type identifiers and their names.
 */
export const APRS_DATA_TYPES: Record<string, string> = {
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
 * Sample APRS packets with all fields populated.
 * Useful for testing complete message parsing.
 */
export const SAMPLE_PACKETS: APRSPacket[] = [
	{
		source: "N0CALL",
		destination: "APRS",
		path: [],
		dataTypeChar: "!",
		dataType: "Position",
		info: "!4903.50N/07201.75W-PHG2360",
		lat: 49.0583,
		lon: -72.0292,
		comment: "PHG2360",
	},
	{
		source: "W1AW",
		destination: "APRS",
		path: ["WIDE1-1", "WIDE2-2"],
		dataTypeChar: "!",
		dataType: "Position",
		info: "!4144.00N/07234.00W-ARRL HQ",
		lat: 41.7333,
		lon: -72.5667,
		comment: "ARRL HQ",
	},
	{
		source: "K1ABC-9",
		destination: "APRS",
		path: [],
		dataTypeChar: "=",
		dataType: "Position with messaging",
		info: "=4903.50N/07201.75W>Mobile station",
		lat: 49.0583,
		lon: -72.0292,
		comment: "Mobile station",
	},
	{
		source: "N0CALL",
		destination: "APRS",
		path: [],
		dataTypeChar: ">",
		dataType: "Status",
		info: ">En route to hamfest",
		comment: "En route to hamfest",
	},
	{
		source: "W1AW",
		destination: "APRS",
		path: [],
		dataTypeChar: ">",
		dataType: "Status",
		info: ">ARRL Headquarters, Newington CT",
		comment: "ARRL Headquarters, Newington CT",
	},
	{
		source: "N0CALL",
		destination: "APRS",
		path: [],
		dataTypeChar: ":",
		dataType: "Message",
		info: ":W1AW     :Hello from N0CALL{001",
		comment: "Hello from N0CALL",
	},
	{
		source: "VE3ABC",
		destination: "APRS",
		path: ["WIDE1-1"],
		dataTypeChar: "!",
		dataType: "Position",
		info: "!4530.00N/07530.00W-Toronto area",
		lat: 45.5,
		lon: -75.5,
		comment: "Toronto area",
	},
	{
		source: "K1ABC-7",
		destination: "APRS",
		path: [],
		dataTypeChar: ">",
		dataType: "Status",
		info: ">Portable operation from summit",
		comment: "Portable operation from summit",
	},
	{
		source: "N0CALL-14",
		destination: "APRS",
		path: [],
		dataTypeChar: "!",
		dataType: "Position",
		info: "!4903.50N/07201.75W>/A=001234",
		lat: 49.0583,
		lon: -72.0292,
		comment: "/A=001234",
	},
	{
		source: "WX1ABC",
		destination: "APRS",
		path: [],
		dataTypeChar: "_",
		dataType: "Positionless weather",
		info: "_01011200c180s005g010t072r001p010P010h50b10200",
	},
]

/**
 * Expected parsed data from the sample packets.
 * Can be used to verify parser output.
 */
export const EXPECTED_PARSED_PACKETS = [
	{
		source: "N0CALL",
		destination: "APRS",
		path: [],
		dataType: "Position",
		lat: 49.0583,
		lon: -72.0292,
	},
	{
		source: "W1AW",
		destination: "APRS",
		path: ["WIDE1-1", "WIDE2-2"],
		dataType: "Position",
		lat: 41.7333,
		lon: -72.5667,
	},
	{
		source: "K1ABC-9",
		destination: "APRS",
		path: [],
		dataType: "Position with messaging",
	},
	{
		source: "N0CALL",
		destination: "APRS",
		path: [],
		dataType: "Status",
		comment: "En route to hamfest",
	},
	{
		source: "W1AW",
		destination: "APRS",
		path: [],
		dataType: "Status",
		comment: "ARRL Headquarters, Newington CT",
	},
] as const

/**
 * Creates an AX.25 address field from callsign and SSID.
 * Address format: 6 bytes callsign (shifted left by 1) + 1 byte SSID
 *
 * @param callsign - Amateur radio callsign (max 6 chars)
 * @param ssid - Secondary Station Identifier (0-15)
 * @param isLast - Whether this is the last address in the header
 * @returns 7-byte Buffer containing the encoded address
 */
export function createAx25Address(
	callsign: string,
	ssid: number = 0,
	isLast: boolean = false,
): Buffer {
	const padded = callsign.toUpperCase().padEnd(6, " ").substring(0, 6)
	const bytes: number[] = []

	// Shift each character left by 1
	for (let i = 0; i < 6; i++) {
		bytes.push(padded.charCodeAt(i) << 1)
	}

	// SSID byte: bits 5-6 = reserved (set to 1), bits 1-4 = SSID, bit 0 = end flag
	let ssidByte = 0x60 | ((ssid & 0x0f) << 1)
	if (isLast) {
		ssidByte |= 0x01 // Set end-of-address bit
	}
	bytes.push(ssidByte)

	return Buffer.from(bytes)
}

/**
 * Creates an AX.25 frame from packet components.
 *
 * @param source - Source callsign
 * @param sourceSsid - Source SSID
 * @param dest - Destination callsign
 * @param destSsid - Destination SSID
 * @param path - Digipeater path
 * @param info - Information field content
 * @returns Buffer containing the complete AX.25 frame
 */
export function createAx25Frame(
	source: string,
	sourceSsid: number,
	dest: string,
	destSsid: number,
	path: string[],
	info: string,
): Buffer {
	const parts: Buffer[] = []

	// Destination address (always first)
	parts.push(createAx25Address(dest, destSsid, path.length === 0))

	// Source address
	const isSourceLast = path.length === 0
	parts.push(createAx25Address(source, sourceSsid, isSourceLast))

	// Digipeater path
	for (let i = 0; i < path.length; i++) {
		const digi = path[i]!
		const [call, ssidStr] = digi.split("-")
		const ssid = ssidStr ? parseInt(ssidStr, 10) : 0
		const isLast = i === path.length - 1
		parts.push(createAx25Address(call!, ssid, isLast))
	}

	// Control field (UI frame = 0x03) and PID (no layer 3 = 0xF0)
	parts.push(Buffer.from([0x03, 0xf0]))

	// Information field
	parts.push(Buffer.from(info, "ascii"))

	return Buffer.concat(parts)
}

/**
 * Escapes a buffer for KISS framing.
 * Replaces FEND with FESC+TFEND and FESC with FESC+TFESC.
 *
 * @param data - Raw data to escape
 * @returns Escaped data safe for KISS framing
 */
export function escapeKissData(data: Buffer): Buffer {
	const escaped: number[] = []

	for (const byte of data) {
		if (byte === KISS_FEND) {
			escaped.push(KISS_FESC, KISS_TFEND)
		} else if (byte === KISS_FESC) {
			escaped.push(KISS_FESC, KISS_TFESC)
		} else {
			escaped.push(byte)
		}
	}

	return Buffer.from(escaped)
}

/**
 * Creates a KISS frame from an AX.25 frame.
 *
 * @param ax25Frame - AX.25 frame data
 * @param port - KISS port number (0-15, default 0)
 * @returns Buffer containing the complete KISS frame
 */
export function createKissFrame(ax25Frame: Buffer, port: number = 0): Buffer {
	// KISS command byte: high nibble = port, low nibble = command (0 = data)
	const command = (port & 0x0f) << 4

	// Escape the AX.25 data
	const escaped = escapeKissData(ax25Frame)

	// Wrap in FEND delimiters
	return Buffer.concat([
		Buffer.from([KISS_FEND]),
		Buffer.from([command]),
		escaped,
		Buffer.from([KISS_FEND]),
	])
}

/**
 * Generates sample KISS frames from the SAMPLE_PACKETS data.
 *
 * @returns Buffer containing multiple KISS frames
 */
export function generateKissSample(): Buffer {
	const frames: Buffer[] = []

	for (const packet of SAMPLE_PACKETS) {
		// Parse source callsign and SSID
		const [srcCall, srcSsidStr] = packet.source.split("-")
		const srcSsid = srcSsidStr ? parseInt(srcSsidStr, 10) : 0

		// Create AX.25 frame
		const ax25Frame = createAx25Frame(
			srcCall!,
			srcSsid,
			packet.destination,
			0,
			[...packet.path],
			packet.info,
		)

		// Create KISS frame
		const kissFrame = createKissFrame(ax25Frame)
		frames.push(kissFrame)
	}

	return Buffer.concat(frames)
}

/**
 * Loads the KISS sample data as a Buffer.
 * Generates the file if it doesn't exist.
 */
export function loadKissSample(): Buffer {
	const filePath = join(__dirname, "kiss-sample.bin")

	// Generate the file if it doesn't exist
	if (!existsSync(filePath)) {
		const data = generateKissSample()
		writeFileSync(filePath, data)
	}

	return readFileSync(filePath)
}

/**
 * Loads the KISS sample data and returns individual frames.
 *
 * @returns Array of KISS frame Buffers
 */
export function loadKissFrames(): Buffer[] {
	const data = loadKissSample()
	const frames: Buffer[] = []
	let start = -1

	for (let i = 0; i < data.length; i++) {
		if (data[i] === KISS_FEND) {
			if (start >= 0 && i > start) {
				const frame = data.subarray(start, i)
				if (frame.length > 0) {
					frames.push(Buffer.from(frame))
				}
			}
			start = i + 1
		}
	}

	return frames
}

/**
 * Loads the packets sample data as an array of lines.
 * Filters out comments and empty lines.
 */
export function loadPacketsSample(): string[] {
	const content = readFileSync(join(__dirname, "packets-sample.txt"), "utf-8")
	return content
		.split("\n")
		.filter(line => line.trim() && !line.startsWith("#"))
}

/**
 * Loads the packets sample data as raw text.
 */
export function loadPacketsSampleRaw(): string {
	return readFileSync(join(__dirname, "packets-sample.txt"), "utf-8")
}

/**
 * Parses a packet line into source, destination, path, and info.
 * Format: SOURCE>DESTINATION,PATH1,PATH2:INFO
 *
 * @param line - Packet line to parse
 * @returns Parsed packet components or null if invalid
 */
export function parsePacketLine(line: string): {
	source: string
	destination: string
	path: string[]
	info: string
} | null {
	const match = line.match(/^([^>]+)>([^:]+):(.*)$/)
	if (!match) return null

	const [, source, destPath, info] = match
	const parts = destPath!.split(",")
	const destination = parts[0]!
	const path = parts.slice(1)

	return { source: source!, destination, path, info: info! }
}

/**
 * Recording source configurations for CI testing.
 * Use with the Recording Source feature.
 */
export const RECORDING_SOURCE_CONFIGS = {
	kiss: {
		id: "test-aprs-kiss",
		type: "recording" as const,
		filePath: join(__dirname, "kiss-sample.bin"),
		loop: false,
		playbackSpeed: 1.0,
		caps: {
			kind: "recording" as const,
			sampleRate: 48000,
			format: "S16LE" as const,
			exclusive: false,
		},
	},
	packets: {
		id: "test-aprs-packets",
		type: "recording" as const,
		filePath: join(__dirname, "packets-sample.txt"),
		loop: false,
		playbackSpeed: 1.0,
		caps: {
			kind: "recording" as const,
			sampleRate: 48000,
			format: "S16LE" as const,
			exclusive: false,
		},
	},
} as const
