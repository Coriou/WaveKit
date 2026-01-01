/**
 * APRS Fixtures Unit Tests
 *
 * Tests for the APRS test fixtures to ensure they are valid and usable.
 */

import { describe, it, expect, beforeAll } from "vitest"
import {
	loadKissSample,
	loadKissFrames,
	loadPacketsSample,
	loadPacketsSampleRaw,
	parsePacketLine,
	generateKissSample,
	createAx25Address,
	createAx25Frame,
	createKissFrame,
	escapeKissData,
	SAMPLE_CALLSIGNS,
	SAMPLE_SSIDS,
	SAMPLE_PATHS,
	SAMPLE_PACKETS,
	EXPECTED_PARSED_PACKETS,
	APRS_DATA_TYPES,
	RECORDING_SOURCE_CONFIGS,
} from "../../mocks/fixtures/aprs/index.js"
import {
	extractKissFrames,
	unescapeKissFrame,
	parseKissFrame,
	parseAx25Frame,
	parseAx25Address,
} from "../../../src/decoders/builtin/direwolf.js"

/** KISS frame special bytes */
const KISS_FEND = 0xc0
const KISS_FESC = 0xdb
const KISS_TFEND = 0xdc
const KISS_TFESC = 0xdd

describe("APRS Fixtures", () => {
	describe("Sample Data Constants", () => {
		it("should have valid callsigns", () => {
			expect(SAMPLE_CALLSIGNS.length).toBeGreaterThan(0)
			for (const call of SAMPLE_CALLSIGNS) {
				// Callsigns should be 3-6 characters, alphanumeric
				expect(call).toMatch(/^[A-Z0-9]{3,6}$/)
			}
		})

		it("should have valid SSIDs (0-15)", () => {
			expect(SAMPLE_SSIDS.length).toBeGreaterThan(0)
			for (const ssid of SAMPLE_SSIDS) {
				expect(ssid).toBeGreaterThanOrEqual(0)
				expect(ssid).toBeLessThanOrEqual(15)
			}
		})

		it("should have valid digipeater paths", () => {
			expect(SAMPLE_PATHS.length).toBeGreaterThan(0)
			// First path should be empty (direct)
			expect(SAMPLE_PATHS[0]).toEqual([])
		})

		it("should have valid APRS data types", () => {
			expect(Object.keys(APRS_DATA_TYPES).length).toBeGreaterThan(0)
			// Check some common types
			expect(APRS_DATA_TYPES["!"]).toBe("Position")
			expect(APRS_DATA_TYPES[">"]).toBe("Status")
			expect(APRS_DATA_TYPES[":"]).toBe("Message")
		})

		it("should have sample packets with required fields", () => {
			expect(SAMPLE_PACKETS.length).toBeGreaterThan(0)
			for (const packet of SAMPLE_PACKETS) {
				expect(packet.source).toBeDefined()
				expect(packet.destination).toBeDefined()
				expect(packet.path).toBeDefined()
				expect(packet.dataTypeChar).toBeDefined()
				expect(packet.dataType).toBeDefined()
				expect(packet.info).toBeDefined()
			}
		})

		it("should have expected parsed packets matching sample packets", () => {
			expect(EXPECTED_PARSED_PACKETS.length).toBeGreaterThan(0)
			for (const expected of EXPECTED_PARSED_PACKETS) {
				expect(expected.source).toBeDefined()
				expect(expected.destination).toBeDefined()
				expect(expected.dataType).toBeDefined()
			}
		})
	})

	describe("AX.25 Address Creation", () => {
		it("should create valid 7-byte address", () => {
			const addr = createAx25Address("N0CALL", 0)
			expect(addr.length).toBe(7)
		})

		it("should shift callsign characters left by 1", () => {
			const addr = createAx25Address("N0CALL", 0)
			// 'N' = 0x4E, shifted = 0x9C
			expect(addr[0]).toBe(0x4e << 1)
			// '0' = 0x30, shifted = 0x60
			expect(addr[1]).toBe(0x30 << 1)
		})

		it("should pad short callsigns with spaces", () => {
			const addr = createAx25Address("W1AW", 0)
			// Space = 0x20, shifted = 0x40
			expect(addr[4]).toBe(0x20 << 1)
			expect(addr[5]).toBe(0x20 << 1)
		})

		it("should encode SSID correctly", () => {
			const addr = createAx25Address("N0CALL", 9)
			// SSID byte: 0x60 | (9 << 1) = 0x60 | 0x12 = 0x72
			expect(addr[6]).toBe(0x72)
		})

		it("should set end-of-address bit when isLast is true", () => {
			const addr = createAx25Address("N0CALL", 0, true)
			// End bit is bit 0
			expect(addr[6]! & 0x01).toBe(1)
		})

		it("should not set end-of-address bit when isLast is false", () => {
			const addr = createAx25Address("N0CALL", 0, false)
			expect(addr[6]! & 0x01).toBe(0)
		})
	})

	describe("AX.25 Frame Creation", () => {
		it("should create valid AX.25 frame", () => {
			const frame = createAx25Frame("N0CALL", 0, "APRS", 0, [], ">Test")
			// Minimum: dest(7) + src(7) + ctrl(1) + pid(1) + info(5) = 21
			expect(frame.length).toBeGreaterThanOrEqual(21)
		})

		it("should include control and PID bytes", () => {
			const frame = createAx25Frame("N0CALL", 0, "APRS", 0, [], ">Test")
			// After dest(7) + src(7) = 14, control should be 0x03
			expect(frame[14]).toBe(0x03)
			// PID should be 0xF0
			expect(frame[15]).toBe(0xf0)
		})

		it("should include digipeater path", () => {
			const frame = createAx25Frame(
				"N0CALL",
				0,
				"APRS",
				0,
				["WIDE1-1"],
				">Test",
			)
			// dest(7) + src(7) + digi(7) + ctrl(1) + pid(1) + info(5) = 28
			expect(frame.length).toBeGreaterThanOrEqual(28)
		})

		it("should be parseable by the decoder", () => {
			const frame = createAx25Frame("N0CALL", 9, "APRS", 0, [], ">Test status")
			const parsed = parseAx25Frame(frame)

			expect(parsed).not.toBeNull()
			expect(parsed!.source).toBe("N0CALL-9")
			expect(parsed!.destination).toBe("APRS")
			expect(parsed!.dataType).toBe("Status")
		})
	})

	describe("KISS Frame Creation", () => {
		it("should wrap AX.25 frame with FEND delimiters", () => {
			const ax25 = createAx25Frame("N0CALL", 0, "APRS", 0, [], ">Test")
			const kiss = createKissFrame(ax25)

			expect(kiss[0]).toBe(KISS_FEND)
			expect(kiss[kiss.length - 1]).toBe(KISS_FEND)
		})

		it("should include command byte after first FEND", () => {
			const ax25 = createAx25Frame("N0CALL", 0, "APRS", 0, [], ">Test")
			const kiss = createKissFrame(ax25, 0)

			// Command byte for port 0, data command = 0x00
			expect(kiss[1]).toBe(0x00)
		})

		it("should escape FEND bytes in data", () => {
			// Create data that contains FEND
			const data = Buffer.from([0x41, KISS_FEND, 0x42])
			const escaped = escapeKissData(data)

			expect(escaped).toEqual(Buffer.from([0x41, KISS_FESC, KISS_TFEND, 0x42]))
		})

		it("should escape FESC bytes in data", () => {
			const data = Buffer.from([0x41, KISS_FESC, 0x42])
			const escaped = escapeKissData(data)

			expect(escaped).toEqual(Buffer.from([0x41, KISS_FESC, KISS_TFESC, 0x42]))
		})
	})

	describe("KISS Sample Generation", () => {
		it("should generate non-empty KISS sample", () => {
			const sample = generateKissSample()
			expect(sample.length).toBeGreaterThan(0)
		})

		it("should generate valid KISS frames", () => {
			const sample = generateKissSample()
			const result = extractKissFrames(sample)

			expect(result.frames.length).toBe(SAMPLE_PACKETS.length)
			expect(result.remaining.length).toBe(0)
		})

		it("should generate parseable frames", () => {
			const sample = generateKissSample()
			const result = extractKissFrames(sample)

			for (const frame of result.frames) {
				const parsed = parseKissFrame(frame)
				expect(parsed).not.toBeNull()
				expect(parsed!.source).toBeDefined()
				expect(parsed!.destination).toBeDefined()
			}
		})
	})

	describe("loadKissSample", () => {
		it("should load KISS sample data", () => {
			const data = loadKissSample()
			expect(data).toBeInstanceOf(Buffer)
			expect(data.length).toBeGreaterThan(0)
		})

		it("should contain valid KISS frames", () => {
			const data = loadKissSample()
			const result = extractKissFrames(data)

			expect(result.frames.length).toBeGreaterThan(0)
		})
	})

	describe("loadKissFrames", () => {
		it("should return array of KISS frames", () => {
			const frames = loadKissFrames()
			expect(Array.isArray(frames)).toBe(true)
			expect(frames.length).toBeGreaterThan(0)
		})

		it("should return frames that can be parsed", () => {
			const frames = loadKissFrames()

			for (const frame of frames) {
				const parsed = parseKissFrame(frame)
				expect(parsed).not.toBeNull()
			}
		})
	})

	describe("loadPacketsSample", () => {
		it("should load packet lines", () => {
			const lines = loadPacketsSample()
			expect(Array.isArray(lines)).toBe(true)
			expect(lines.length).toBeGreaterThan(0)
		})

		it("should filter out comments", () => {
			const lines = loadPacketsSample()
			for (const line of lines) {
				expect(line.startsWith("#")).toBe(false)
			}
		})

		it("should filter out empty lines", () => {
			const lines = loadPacketsSample()
			for (const line of lines) {
				expect(line.trim().length).toBeGreaterThan(0)
			}
		})
	})

	describe("loadPacketsSampleRaw", () => {
		it("should load raw packet data", () => {
			const raw = loadPacketsSampleRaw()
			expect(typeof raw).toBe("string")
			expect(raw.length).toBeGreaterThan(0)
		})

		it("should include comments", () => {
			const raw = loadPacketsSampleRaw()
			expect(raw).toContain("#")
		})
	})

	describe("parsePacketLine", () => {
		it("should parse valid packet line", () => {
			const result = parsePacketLine("N0CALL>APRS:>Test status")

			expect(result).not.toBeNull()
			expect(result!.source).toBe("N0CALL")
			expect(result!.destination).toBe("APRS")
			expect(result!.path).toEqual([])
			expect(result!.info).toBe(">Test status")
		})

		it("should parse packet with path", () => {
			const result = parsePacketLine("N0CALL>APRS,WIDE1-1,WIDE2-2:>Test")

			expect(result).not.toBeNull()
			expect(result!.source).toBe("N0CALL")
			expect(result!.destination).toBe("APRS")
			expect(result!.path).toEqual(["WIDE1-1", "WIDE2-2"])
		})

		it("should parse packet with SSID", () => {
			const result = parsePacketLine("N0CALL-9>APRS:>Mobile")

			expect(result).not.toBeNull()
			expect(result!.source).toBe("N0CALL-9")
		})

		it("should return null for invalid line", () => {
			expect(parsePacketLine("invalid")).toBeNull()
			expect(parsePacketLine("")).toBeNull()
		})
	})

	describe("Recording Source Configs", () => {
		it("should have kiss config", () => {
			expect(RECORDING_SOURCE_CONFIGS.kiss).toBeDefined()
			expect(RECORDING_SOURCE_CONFIGS.kiss.type).toBe("recording")
			expect(RECORDING_SOURCE_CONFIGS.kiss.caps.kind).toBe("recording")
		})

		it("should have packets config", () => {
			expect(RECORDING_SOURCE_CONFIGS.packets).toBeDefined()
			expect(RECORDING_SOURCE_CONFIGS.packets.type).toBe("recording")
		})

		it("should have valid file paths", () => {
			expect(RECORDING_SOURCE_CONFIGS.kiss.filePath).toContain(
				"kiss-sample.bin",
			)
			expect(RECORDING_SOURCE_CONFIGS.packets.filePath).toContain(
				"packets-sample.txt",
			)
		})
	})

	describe("Integration with Direwolf Decoder", () => {
		it("should produce APRSData matching expected values", () => {
			const frames = loadKissFrames()

			// Parse first frame and check against expected
			const parsed = parseKissFrame(frames[0]!)

			expect(parsed).not.toBeNull()
			expect(parsed!.source).toBe(SAMPLE_PACKETS[0]!.source)
			expect(parsed!.destination).toBe(SAMPLE_PACKETS[0]!.destination)
			expect(parsed!.dataType).toBe(SAMPLE_PACKETS[0]!.dataType)
		})

		it("should parse all sample packets correctly", () => {
			const frames = loadKissFrames()

			expect(frames.length).toBe(SAMPLE_PACKETS.length)

			for (let i = 0; i < frames.length; i++) {
				const parsed = parseKissFrame(frames[i]!)
				const expected = SAMPLE_PACKETS[i]!

				expect(parsed).not.toBeNull()
				expect(parsed!.source).toBe(expected.source)
				expect(parsed!.destination).toBe(expected.destination)
				expect(parsed!.dataType).toBe(expected.dataType)
			}
		})
	})
})
