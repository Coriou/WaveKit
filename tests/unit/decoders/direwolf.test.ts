/**
 * Direwolf APRS Decoder Unit Tests
 *
 * Tests for the DirewolfDecoder class.
 * Requirements: 26.1, 26.2, 26.3, 26.4
 *
 * Property 37: APRS Output Parsing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import {
	DirewolfDecoder,
	extractKissFrames,
	unescapeKissFrame,
	parseKissFrame,
	parseAx25Frame,
	parseAx25Address,
	parseAprsInfo,
	createDirewolfDecoder,
	DIREWOLF_CAPS,
	type APRSData,
} from "../../../src/decoders/builtin/direwolf.js"
import pino from "pino"

// Create a silent logger for tests
const testLogger = pino({ level: "silent" })

/** KISS frame special bytes */
const KISS_FEND = 0xc0
const KISS_FESC = 0xdb
const KISS_TFEND = 0xdc
const KISS_TFESC = 0xdd

/**
 * Creates a test decoder config with optional overrides.
 */
function createConfig(overrides: Partial<DecoderConfig> = {}): DecoderConfig {
	return {
		id: "test-direwolf",
		type: "direwolf",
		enabled: true,
		options: {
			audioDevice: "stdin",
			sampleRate: 48000,
			kissPort: 8001,
			...overrides.options,
		},
		outputHost: "127.0.0.1",
		outputPort: 8001,
		outputProtocol: "tcp",
		...overrides,
	}
}

describe("DirewolfDecoder", () => {
	let decoder: DirewolfDecoder

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
	})

	afterEach(async () => {
		vi.useRealTimers()
		if (decoder) {
			try {
				await decoder.stop()
			} catch {
				// Ignore errors during cleanup
			}
		}
	})

	describe("constructor", () => {
		it("should initialize with correct id and type", () => {
			const config = createConfig({ id: "my-direwolf", type: "direwolf" })
			decoder = new DirewolfDecoder(config, testLogger)

			expect(decoder.id).toBe("my-direwolf")
			expect(decoder.type).toBe("direwolf")
		})

		it("should use default KISS port when not specified", () => {
			const config = createConfig({
				options: { audioDevice: "stdin" },
				outputPort: undefined,
			})
			decoder = new DirewolfDecoder(config, testLogger)

			expect(decoder.caps.output).toBe("text")
		})
	})

	describe("getCaps", () => {
		it("should return correct capabilities", () => {
			const config = createConfig()
			decoder = new DirewolfDecoder(config, testLogger)

			expect(decoder.caps).toEqual({
				input: "audio_pcm",
				wantsExclusiveSource: false,
				preferredSampleRates: [48000, 44100],
				output: "text",
				integrationPattern: "network_producer",
			})
		})
	})

	describe("getStatus", () => {
		it("should return status with all required fields when not running", () => {
			const config = createConfig()
			decoder = new DirewolfDecoder(config, testLogger)
			const status = decoder.getStatus()

			expect(status.id).toBe("test-direwolf")
			expect(status.type).toBe("direwolf")
			expect(status.running).toBe(false)
			expect(status.health).toBe("running")
			expect(status.pid).toBeUndefined()
			expect(status.uptime).toBe(0)
			expect(status.stats).toEqual({ bytesIn: 0, eventsOut: 0, errors: 0 })
			expect(status.restartCount).toBe(0)
		})
	})
})

describe("extractKissFrames", () => {
	it("should extract a single complete frame", () => {
		const frame = Buffer.from([KISS_FEND, 0x00, 0x41, 0x42, KISS_FEND])
		const result = extractKissFrames(frame)

		expect(result.frames).toHaveLength(1)
		expect(result.frames[0]).toEqual(Buffer.from([0x00, 0x41, 0x42]))
		expect(result.remaining.length).toBe(0)
	})

	it("should extract multiple complete frames", () => {
		const frame = Buffer.from([
			KISS_FEND,
			0x00,
			0x41,
			KISS_FEND,
			KISS_FEND,
			0x00,
			0x42,
			KISS_FEND,
		])
		const result = extractKissFrames(frame)

		expect(result.frames).toHaveLength(2)
		expect(result.frames[0]).toEqual(Buffer.from([0x00, 0x41]))
		expect(result.frames[1]).toEqual(Buffer.from([0x00, 0x42]))
	})

	it("should handle incomplete frame at end", () => {
		const frame = Buffer.from([KISS_FEND, 0x00, 0x41, KISS_FEND, 0x00, 0x42])
		const result = extractKissFrames(frame)

		expect(result.frames).toHaveLength(1)
		expect(result.frames[0]).toEqual(Buffer.from([0x00, 0x41]))
		expect(result.remaining).toEqual(Buffer.from([0x00, 0x42]))
	})

	it("should handle empty buffer", () => {
		const result = extractKissFrames(Buffer.alloc(0))

		expect(result.frames).toHaveLength(0)
		expect(result.remaining.length).toBe(0)
	})

	it("should skip empty frames between delimiters", () => {
		const frame = Buffer.from([KISS_FEND, KISS_FEND, 0x00, 0x41, KISS_FEND])
		const result = extractKissFrames(frame)

		expect(result.frames).toHaveLength(1)
		expect(result.frames[0]).toEqual(Buffer.from([0x00, 0x41]))
	})
})

describe("unescapeKissFrame", () => {
	it("should unescape FESC TFEND to FEND", () => {
		const frame = Buffer.from([0x00, KISS_FESC, KISS_TFEND, 0x41])
		const result = unescapeKissFrame(frame)

		expect(result).toEqual(Buffer.from([0x00, KISS_FEND, 0x41]))
	})

	it("should unescape FESC TFESC to FESC", () => {
		const frame = Buffer.from([0x00, KISS_FESC, KISS_TFESC, 0x41])
		const result = unescapeKissFrame(frame)

		expect(result).toEqual(Buffer.from([0x00, KISS_FESC, 0x41]))
	})

	it("should handle multiple escape sequences", () => {
		const frame = Buffer.from([
			KISS_FESC,
			KISS_TFEND,
			0x41,
			KISS_FESC,
			KISS_TFESC,
		])
		const result = unescapeKissFrame(frame)

		expect(result).toEqual(Buffer.from([KISS_FEND, 0x41, KISS_FESC]))
	})

	it("should pass through non-escaped bytes", () => {
		const frame = Buffer.from([0x00, 0x41, 0x42, 0x43])
		const result = unescapeKissFrame(frame)

		expect(result).toEqual(frame)
	})

	it("should handle FESC at end of frame", () => {
		const frame = Buffer.from([0x00, 0x41, KISS_FESC])
		const result = unescapeKissFrame(frame)

		expect(result).toEqual(Buffer.from([0x00, 0x41, KISS_FESC]))
	})
})

describe("parseAx25Address", () => {
	it("should parse a valid callsign without SSID", () => {
		// "N0CALL" shifted left by 1, SSID byte = 0x60 (SSID 0)
		const data = Buffer.from([
			0x4e << 1, // N
			0x30 << 1, // 0
			0x43 << 1, // C
			0x41 << 1, // A
			0x4c << 1, // L
			0x4c << 1, // L
			0x60, // SSID 0
		])
		const result = parseAx25Address(data)

		expect(result).toBe("N0CALL")
	})

	it("should parse a callsign with SSID", () => {
		// "N0CALL" with SSID 9
		const data = Buffer.from([
			0x4e << 1, // N
			0x30 << 1, // 0
			0x43 << 1, // C
			0x41 << 1, // A
			0x4c << 1, // L
			0x4c << 1, // L
			0x72, // SSID 9 (0x60 | (9 << 1))
		])
		const result = parseAx25Address(data)

		expect(result).toBe("N0CALL-9")
	})

	it("should handle space-padded callsigns", () => {
		// "W1AW  " (4 chars + 2 spaces)
		const data = Buffer.from([
			0x57 << 1, // W
			0x31 << 1, // 1
			0x41 << 1, // A
			0x57 << 1, // W
			0x20 << 1, // space
			0x20 << 1, // space
			0x60, // SSID 0
		])
		const result = parseAx25Address(data)

		expect(result).toBe("W1AW")
	})

	it("should return null for buffer too short", () => {
		const data = Buffer.from([0x4e << 1, 0x30 << 1])
		const result = parseAx25Address(data)

		expect(result).toBeNull()
	})

	it("should return null for empty callsign", () => {
		// All spaces
		const data = Buffer.from([
			0x20 << 1,
			0x20 << 1,
			0x20 << 1,
			0x20 << 1,
			0x20 << 1,
			0x20 << 1,
			0x60,
		])
		const result = parseAx25Address(data)

		expect(result).toBeNull()
	})
})

describe("parseAprsInfo", () => {
	it("should parse a position report (! data type)", () => {
		const info = "!4903.50N/07201.75W-PHG2360"
		const result = parseAprsInfo("N0CALL", "APRS", [], info)

		expect(result.source).toBe("N0CALL")
		expect(result.destination).toBe("APRS")
		expect(result.dataType).toBe("Position")
		expect(result.raw).toBe(info)
	})

	it("should parse a message (: data type)", () => {
		const info = ":BLN1     :Test bulletin message"
		const result = parseAprsInfo("N0CALL", "APRS", [], info)

		expect(result.dataType).toBe("Message")
		expect(result.message).toBeDefined()
		expect(result.message?.addressee).toBe("BLN1")
		expect(result.message?.text).toBe("Test bulletin message")
	})

	it("should parse a message with message number", () => {
		const info = ":W1AW     :Hello there{123"
		const result = parseAprsInfo("N0CALL", "APRS", [], info)

		expect(result.message?.addressee).toBe("W1AW")
		expect(result.message?.text).toBe("Hello there")
		expect(result.message?.messageNo).toBe("123")
	})

	it("should parse a status report (> data type)", () => {
		const info = ">En route to meeting"
		const result = parseAprsInfo("N0CALL", "APRS", [], info)

		expect(result.dataType).toBe("Status")
		expect(result.comment).toBe("En route to meeting")
	})

	it("should handle unknown data types", () => {
		const info = "XUnknown data"
		const result = parseAprsInfo("N0CALL", "APRS", [], info)

		expect(result.dataType).toBe("Unknown")
		expect(result.raw).toBe(info)
	})

	it("should preserve digipeater path", () => {
		const result = parseAprsInfo(
			"N0CALL",
			"APRS",
			["WIDE1-1", "WIDE2-2"],
			">Test",
		)

		expect(result.path).toEqual(["WIDE1-1", "WIDE2-2"])
	})
})

describe("parseKissFrame", () => {
	it("should return null for frames too short", () => {
		expect(parseKissFrame(Buffer.from([0x00]))).toBeNull()
		expect(parseKissFrame(Buffer.alloc(0))).toBeNull()
	})

	it("should return null for non-data frames", () => {
		// Command byte 0x01 (not data frame)
		const frame = Buffer.alloc(20)
		frame[0] = 0x01
		expect(parseKissFrame(frame)).toBeNull()
	})
})

describe("createDirewolfDecoder", () => {
	it("should create a DirewolfDecoder instance", () => {
		const config = createConfig()
		const decoder = createDirewolfDecoder(config, testLogger)

		expect(decoder).toBeInstanceOf(DirewolfDecoder)
		expect(decoder.id).toBe("test-direwolf")
	})
})

describe("DIREWOLF_CAPS", () => {
	it("should have correct default capabilities", () => {
		expect(DIREWOLF_CAPS).toEqual({
			input: "audio_pcm",
			wantsExclusiveSource: false,
			preferredSampleRates: [48000, 44100],
			output: "text",
			integrationPattern: "network_producer",
		})
	})
})

/**
 * Arbitrary generators for property-based testing
 */

/**
 * Arbitrary for generating valid amateur radio callsigns.
 * Format: 1-2 letters, 1 digit, 1-3 letters (e.g., N0CALL, W1AW, VE3ABC)
 */
const callsignArb = fc
	.tuple(
		fc.stringMatching(/^[A-Z]{1,2}$/),
		fc.integer({ min: 0, max: 9 }),
		fc.stringMatching(/^[A-Z]{1,3}$/),
	)
	.map(([prefix, digit, suffix]) => `${prefix}${digit}${suffix}`)

/**
 * Arbitrary for generating valid SSIDs (0-15).
 */
const ssidArb = fc.integer({ min: 0, max: 15 })

/**
 * Arbitrary for generating callsign with optional SSID.
 */
const callsignWithSsidArb = fc
	.tuple(callsignArb, fc.option(ssidArb, { nil: undefined }))
	.map(([call, ssid]) => (ssid && ssid > 0 ? `${call}-${ssid}` : call))

/**
 * Arbitrary for generating valid latitudes (-90 to 90).
 */
const latArb = fc.double({ min: -90, max: 90, noNaN: true })

/**
 * Arbitrary for generating valid longitudes (-180 to 180).
 */
const lonArb = fc.double({ min: -180, max: 180, noNaN: true })

/**
 * Arbitrary for generating valid course (0-359 degrees).
 */
const courseArb = fc.integer({ min: 0, max: 359 })

/**
 * Arbitrary for generating valid speed (0-999 mph).
 */
const speedArb = fc.integer({ min: 0, max: 999 })

/**
 * Arbitrary for generating valid altitude (-99999 to 999999 feet).
 */
const altitudeArb = fc.integer({ min: -99999, max: 999999 })

/**
 * Arbitrary for generating APRS data types.
 */
const dataTypeArb = fc.constantFrom(
	"!",
	"=",
	"/",
	"@",
	";",
	")",
	"`",
	"'",
	":",
	">",
	"<",
	"?",
	"T",
	"#",
	"*",
	"_",
	"$",
	"{",
	"}",
)

/**
 * Arbitrary for generating APRS symbol table and code.
 */
const symbolArb = fc
	.tuple(fc.constantFrom("/", "\\"), fc.stringMatching(/^[!-~]$/))
	.map(([table, code]) => `${table}${code}`)

/**
 * Arbitrary for generating digipeater paths.
 */
const pathArb = fc.array(callsignWithSsidArb, { minLength: 0, maxLength: 8 })

/**
 * Arbitrary for generating comment text.
 */
const commentArb = fc.stringMatching(/^[A-Za-z0-9 ]{0,40}$/)

/**
 * Helper to create an AX.25 address field from callsign and SSID.
 */
function createAx25Address(callsign: string, ssid: number = 0): Buffer {
	const padded = callsign.padEnd(6, " ").substring(0, 6)
	const bytes: number[] = []

	for (let i = 0; i < 6; i++) {
		bytes.push(padded.charCodeAt(i) << 1)
	}

	// SSID byte: bits 1-4 are SSID, bit 0 is end-of-address flag
	bytes.push(0x60 | (ssid << 1))

	return Buffer.from(bytes)
}

/**
 * Helper to create a minimal valid AX.25 frame.
 */
function createAx25Frame(
	source: string,
	sourceSsid: number,
	dest: string,
	destSsid: number,
	info: string,
): Buffer {
	const destAddr = createAx25Address(dest, destSsid)
	const srcAddr = createAx25Address(source, sourceSsid)

	// Set end-of-address bit on source address
	srcAddr[6] = srcAddr[6]! | 0x01

	// Control field (UI frame) and PID (no layer 3)
	const control = Buffer.from([0x03, 0xf0])

	// Information field
	const infoField = Buffer.from(info, "ascii")

	return Buffer.concat([destAddr, srcAddr, control, infoField])
}

/**
 * Helper to create a KISS frame from AX.25 data.
 */
function createKissFrame(ax25Data: Buffer): Buffer {
	// KISS command byte 0x00 (data frame, port 0)
	const command = Buffer.from([0x00])

	// Wrap in FEND delimiters
	return Buffer.concat([
		Buffer.from([KISS_FEND]),
		command,
		ax25Data,
		Buffer.from([KISS_FEND]),
	])
}

describe("Direwolf Decoder Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 37: APRS Output Parsing
	 * Validates: Requirements 26.2
	 *
	 * For any valid direwolf KISS frame containing an APRS packet,
	 * the parser should produce a DecoderOutput object with type: 'aprs'
	 * and an APRSData object containing source callsign and data type.
	 */
	describe("Property 37: APRS Output Parsing", () => {
		it("should parse any valid KISS frame into APRSData with source and dataType", () => {
			fc.assert(
				fc.property(
					callsignArb,
					ssidArb,
					callsignArb,
					ssidArb,
					dataTypeArb,
					commentArb,
					(srcCall, srcSsid, destCall, destSsid, dataType, comment) => {
						// Create a simple APRS info field
						const info = `${dataType}${comment}`

						// Create AX.25 frame
						const ax25Frame = createAx25Frame(
							srcCall,
							srcSsid,
							destCall,
							destSsid,
							info,
						)

						// Parse the frame
						const result = parseAx25Frame(ax25Frame)

						// Should produce valid APRSData
						expect(result).not.toBeNull()

						// Must contain source callsign
						expect(result!.source).toBeDefined()
						expect(result!.source.length).toBeGreaterThan(0)

						// Source should match input (with optional SSID)
						const expectedSource =
							srcSsid > 0 ? `${srcCall}-${srcSsid}` : srcCall
						expect(result!.source).toBe(expectedSource)

						// Must contain data type
						expect(result!.dataType).toBeDefined()
						expect(result!.dataType.length).toBeGreaterThan(0)

						// Must have timestamp
						expect(result!.timestamp).toBeInstanceOf(Date)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should preserve destination callsign in parsed APRSData", () => {
			fc.assert(
				fc.property(
					callsignArb,
					ssidArb,
					callsignArb,
					ssidArb,
					(srcCall, srcSsid, destCall, destSsid) => {
						const info = ">Test status"
						const ax25Frame = createAx25Frame(
							srcCall,
							srcSsid,
							destCall,
							destSsid,
							info,
						)

						const result = parseAx25Frame(ax25Frame)

						expect(result).not.toBeNull()

						// Destination should match input
						const expectedDest =
							destSsid > 0 ? `${destCall}-${destSsid}` : destCall
						expect(result!.destination).toBe(expectedDest)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should correctly identify APRS data types", () => {
			const dataTypeMap: Record<string, string> = {
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

			fc.assert(
				fc.property(
					callsignArb,
					fc.constantFrom(...Object.keys(dataTypeMap)),
					(srcCall, dataTypeChar) => {
						const info = `${dataTypeChar}Test data`
						const ax25Frame = createAx25Frame(srcCall, 0, "APRS", 0, info)

						const result = parseAx25Frame(ax25Frame)

						expect(result).not.toBeNull()
						expect(result!.dataType).toBe(dataTypeMap[dataTypeChar])

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should extract KISS frames correctly from any buffer with FEND delimiters", () => {
			fc.assert(
				fc.property(
					fc.array(fc.uint8Array({ minLength: 1, maxLength: 50 }), {
						minLength: 1,
						maxLength: 5,
					}),
					frameContents => {
						// Filter out frames that contain FEND bytes (would break framing)
						const cleanFrames = frameContents.map(f =>
							Buffer.from(f.filter(b => b !== KISS_FEND)),
						)

						// Build a buffer with FEND-delimited frames
						const parts: Buffer[] = [Buffer.from([KISS_FEND])]
						for (const frame of cleanFrames) {
							if (frame.length > 0) {
								parts.push(frame)
								parts.push(Buffer.from([KISS_FEND]))
							}
						}
						const buffer = Buffer.concat(parts)

						const result = extractKissFrames(buffer)

						// Should extract the same number of non-empty frames
						const expectedCount = cleanFrames.filter(f => f.length > 0).length
						expect(result.frames.length).toBe(expectedCount)

						// Remaining should be empty (all frames complete)
						expect(result.remaining.length).toBe(0)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should correctly unescape KISS escape sequences", () => {
			fc.assert(
				fc.property(
					fc.array(fc.uint8Array({ minLength: 1, maxLength: 20 }), {
						minLength: 1,
						maxLength: 3,
					}),
					byteArrays => {
						// Create a frame with escape sequences for FEND and FESC bytes
						const escaped: number[] = []
						const original: number[] = []

						for (const arr of byteArrays) {
							for (const b of arr) {
								original.push(b)
								if (b === KISS_FEND) {
									escaped.push(KISS_FESC, KISS_TFEND)
								} else if (b === KISS_FESC) {
									escaped.push(KISS_FESC, KISS_TFESC)
								} else {
									escaped.push(b)
								}
							}
						}

						const escapedBuffer = Buffer.from(escaped)
						const result = unescapeKissFrame(escapedBuffer)

						// Unescaped should match original
						expect(result).toEqual(Buffer.from(original))

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should parse status messages preserving comment text", () => {
			fc.assert(
				fc.property(callsignArb, commentArb, (srcCall, comment) => {
					const info = `>${comment}`
					const ax25Frame = createAx25Frame(srcCall, 0, "APRS", 0, info)

					const result = parseAx25Frame(ax25Frame)

					expect(result).not.toBeNull()
					expect(result!.dataType).toBe("Status")
					expect(result!.comment).toBe(comment.trim())

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should parse message packets with addressee and text", () => {
			fc.assert(
				fc.property(
					callsignArb,
					callsignArb,
					fc.stringMatching(/^[A-Za-z0-9 ]{1,67}$/),
					(srcCall, addressee, msgText) => {
						// Message format: :ADDRESSEE:message text
						// Addressee is padded to 9 characters
						const paddedAddressee = addressee.padEnd(9, " ").substring(0, 9)
						const info = `:${paddedAddressee}:${msgText}`
						const ax25Frame = createAx25Frame(srcCall, 0, "APRS", 0, info)

						const result = parseAx25Frame(ax25Frame)

						expect(result).not.toBeNull()
						expect(result!.dataType).toBe("Message")
						expect(result!.message).toBeDefined()
						expect(result!.message!.addressee).toBe(addressee.trim())
						expect(result!.message!.text).toBe(msgText)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should handle digipeater paths correctly", () => {
			fc.assert(
				fc.property(
					callsignArb,
					callsignArb,
					fc.array(callsignArb, { minLength: 1, maxLength: 3 }),
					(srcCall, destCall, digiPath) => {
						// For this test, we use parseAprsInfo directly since
						// creating multi-hop AX.25 frames is complex
						const info = ">Test with path"
						const result = parseAprsInfo(srcCall, destCall, digiPath, info)

						expect(result.source).toBe(srcCall)
						expect(result.destination).toBe(destCall)
						expect(result.path).toEqual(digiPath)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should produce APRSData with raw field containing original info", () => {
			fc.assert(
				fc.property(
					callsignArb,
					dataTypeArb,
					commentArb,
					(srcCall, dataType, comment) => {
						const info = `${dataType}${comment}`
						const ax25Frame = createAx25Frame(srcCall, 0, "APRS", 0, info)

						const result = parseAx25Frame(ax25Frame)

						expect(result).not.toBeNull()
						expect(result!.raw).toBe(info)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return null for AX.25 frames that are too short", () => {
			fc.assert(
				fc.property(
					fc.uint8Array({ minLength: 0, maxLength: 15 }),
					shortFrame => {
						const result = parseAx25Frame(Buffer.from(shortFrame))
						return result === null
					},
				),
				{ numRuns: 100 },
			)
		})
	})
})
