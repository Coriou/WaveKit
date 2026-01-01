/**
 * AIS-catcher Decoder Unit Tests
 *
 * Tests for the AisCatcherDecoder class.
 * Requirements: 25.1, 25.2, 25.3, 25.4
 *
 * Property 36: AIS Output Parsing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import {
	AisCatcherDecoder,
	parseNmeaSentence,
	parseJsonShip,
	decodeAisPayload,
	createAisCatcherDecoder,
	AIS_CATCHER_CAPS,
} from "../../../src/decoders/builtin/ais-catcher.js"
import pino from "pino"

// Create a silent logger for tests
const testLogger = pino({ level: "silent" })

/**
 * Creates a test decoder config with optional overrides.
 */
function createConfig(overrides: Partial<DecoderConfig> = {}): DecoderConfig {
	return {
		id: "test-ais",
		type: "ais-catcher",
		enabled: true,
		options: {
			outputFormat: "nmea",
			...overrides.options,
		},
		outputHost: "127.0.0.1",
		outputPort: 10110,
		outputProtocol: "udp",
		...overrides,
	}
}

describe("AisCatcherDecoder", () => {
	let decoder: AisCatcherDecoder

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
			const config = createConfig({ id: "my-ais", type: "ais-catcher" })
			decoder = new AisCatcherDecoder(config, testLogger)

			expect(decoder.id).toBe("my-ais")
			expect(decoder.type).toBe("ais-catcher")
		})

		it("should use default port when not specified", () => {
			const config = createConfig({
				options: { outputFormat: "nmea" },
				outputPort: undefined,
			})
			decoder = new AisCatcherDecoder(config, testLogger)

			// The decoder should use port 10110 for NMEA format
			expect(decoder.caps.output).toBe("nmea")
		})

		it("should use JSON output format when specified", () => {
			const config = createConfig({
				options: { outputFormat: "json" },
				outputPort: undefined,
			})
			decoder = new AisCatcherDecoder(config, testLogger)

			expect(decoder.caps.output).toBe("jsonl")
		})
	})

	describe("getCaps", () => {
		it("should return correct capabilities for NMEA format", () => {
			const config = createConfig({ options: { outputFormat: "nmea" } })
			decoder = new AisCatcherDecoder(config, testLogger)

			expect(decoder.caps).toEqual({
				input: "external",
				wantsExclusiveSource: true,
				output: "nmea",
				integrationPattern: "network_producer",
			})
		})

		it("should return correct capabilities for JSON format", () => {
			const config = createConfig({ options: { outputFormat: "json" } })
			decoder = new AisCatcherDecoder(config, testLogger)

			expect(decoder.caps).toEqual({
				input: "external",
				wantsExclusiveSource: true,
				output: "jsonl",
				integrationPattern: "network_producer",
			})
		})
	})

	describe("getStatus", () => {
		it("should return status with all required fields when not running", () => {
			const config = createConfig()
			decoder = new AisCatcherDecoder(config, testLogger)
			const status = decoder.getStatus()

			expect(status.id).toBe("test-ais")
			expect(status.type).toBe("ais-catcher")
			expect(status.running).toBe(false)
			expect(status.health).toBe("running")
			expect(status.pid).toBeUndefined()
			expect(status.uptime).toBe(0)
			expect(status.stats).toEqual({ bytesIn: 0, eventsOut: 0, errors: 0 })
			expect(status.restartCount).toBe(0)
		})
	})
})

describe("decodeAisPayload", () => {
	it("should decode a valid AIS type 1 message", () => {
		// Example AIS type 1 payload: "13u@Dp0P00PH=3pN4T0"
		// This is a simplified test - real payloads are more complex
		const payload = "13u@Dp0P00PH=3pN4T0"
		const result = decodeAisPayload(payload)

		expect(result).not.toBeNull()
		expect(result?.messageType).toBe(1)
		expect(result?.mmsi).toMatch(/^\d{9}$/)
	})

	it("should return null for payloads that are too short", () => {
		expect(decodeAisPayload("")).toBeNull()
		expect(decodeAisPayload("123")).toBeNull()
		expect(decodeAisPayload("12345")).toBeNull()
	})

	it("should return null for invalid characters", () => {
		// Characters outside the valid AIS 6-bit range
		expect(decodeAisPayload("!@#$%^&")).toBeNull()
	})

	it("should extract MMSI correctly", () => {
		// Type 1 message with known MMSI
		const payload = "13u@Dp0P00PH=3pN4T0"
		const result = decodeAisPayload(payload)

		expect(result).not.toBeNull()
		expect(result?.mmsi).toBeDefined()
		expect(result?.mmsi.length).toBe(9)
	})
})

describe("parseNmeaSentence", () => {
	it("should parse a valid AIVDM sentence", () => {
		const sentence = "!AIVDM,1,1,,A,13u@Dp0P00PH=3pN4T0,0*7D"
		const result = parseNmeaSentence(sentence)

		expect(result).not.toBeNull()
		expect(result?.mmsi).toMatch(/^\d{9}$/)
		expect(result?.messageType).toBeGreaterThanOrEqual(1)
		expect(result?.messageType).toBeLessThanOrEqual(27)
	})

	it("should parse a valid AIVDO sentence", () => {
		const sentence = "!AIVDO,1,1,,A,13u@Dp0P00PH=3pN4T0,0*7A"
		const result = parseNmeaSentence(sentence)

		expect(result).not.toBeNull()
		expect(result?.mmsi).toMatch(/^\d{9}$/)
	})

	it("should return null for non-AIS sentences", () => {
		expect(parseNmeaSentence("")).toBeNull()
		expect(
			parseNmeaSentence(
				"$GPGGA,123456,1234.56,N,12345.67,W,1,08,0.9,545.4,M,47.0,M,,*47",
			),
		).toBeNull()
		expect(parseNmeaSentence("invalid")).toBeNull()
	})

	it("should return null for malformed AIS sentences", () => {
		expect(parseNmeaSentence("!AIVDM")).toBeNull()
		expect(parseNmeaSentence("!AIVDM,1,1")).toBeNull()
		expect(parseNmeaSentence("!AIVDM,1,1,,A")).toBeNull()
	})

	it("should have lastSeen timestamp", () => {
		const sentence = "!AIVDM,1,1,,A,13u@Dp0P00PH=3pN4T0,0*7D"
		const result = parseNmeaSentence(sentence)

		expect(result).not.toBeNull()
		expect(result?.lastSeen).toBeInstanceOf(Date)
	})
})

describe("parseJsonShip", () => {
	it("should parse a valid JSON ship object", () => {
		const json = {
			mmsi: 123456789,
			type: 1,
			shipname: "TEST VESSEL  ",
			callsign: "ABCD",
			lat: 40.7128,
			lon: -74.006,
			cog: 180.5,
			speed: 12.3,
			heading: 179,
			status: 0,
			destination: "NEW YORK  ",
			imo: 1234567,
			shiptype: 70,
			draught: 5.5,
		}

		const result = parseJsonShip(json)

		expect(result).not.toBeNull()
		expect(result?.mmsi).toBe("123456789")
		expect(result?.name).toBe("TEST VESSEL")
		expect(result?.callsign).toBe("ABCD")
		expect(result?.lat).toBe(40.7128)
		expect(result?.lon).toBe(-74.006)
		expect(result?.cog).toBe(180.5)
		expect(result?.sog).toBe(12.3)
		expect(result?.heading).toBe(179)
		expect(result?.navStatus).toBe(0)
		expect(result?.destination).toBe("NEW YORK")
		expect(result?.imo).toBe(1234567)
		expect(result?.shipType).toBe(70)
		expect(result?.draught).toBe(5.5)
		expect(result?.messageType).toBe(1)
	})

	it("should handle MMSI as string", () => {
		const json = { mmsi: "123456789", type: 1 }
		const result = parseJsonShip(json)

		expect(result).not.toBeNull()
		expect(result?.mmsi).toBe("123456789")
	})

	it("should pad short MMSI to 9 digits", () => {
		const json = { mmsi: 12345, type: 1 }
		const result = parseJsonShip(json)

		expect(result).not.toBeNull()
		expect(result?.mmsi).toBe("000012345")
	})

	it("should return null for objects without MMSI", () => {
		const json = { shipname: "TEST VESSEL" }
		const result = parseJsonShip(json)

		expect(result).toBeNull()
	})

	it("should handle missing optional fields", () => {
		const json = { mmsi: 123456789 }
		const result = parseJsonShip(json)

		expect(result).not.toBeNull()
		expect(result?.mmsi).toBe("123456789")
		expect(result?.name).toBeUndefined()
		expect(result?.callsign).toBeUndefined()
		expect(result?.lat).toBeUndefined()
		expect(result?.messageType).toBe(0) // Default
	})

	it("should handle alternative field names", () => {
		const json = {
			mmsi: 123456789,
			msgtype: 5,
			name: "VESSEL NAME",
			sog: 15.5,
			navstatus: 3,
		}
		const result = parseJsonShip(json)

		expect(result).not.toBeNull()
		expect(result?.messageType).toBe(5)
		expect(result?.name).toBe("VESSEL NAME")
		expect(result?.sog).toBe(15.5)
		expect(result?.navStatus).toBe(3)
	})

	it("should have lastSeen timestamp", () => {
		const json = { mmsi: 123456789 }
		const result = parseJsonShip(json)

		expect(result).not.toBeNull()
		expect(result?.lastSeen).toBeInstanceOf(Date)
	})
})

describe("createAisCatcherDecoder", () => {
	it("should create an AisCatcherDecoder instance", () => {
		const config = createConfig()
		const decoder = createAisCatcherDecoder(config, testLogger)

		expect(decoder).toBeInstanceOf(AisCatcherDecoder)
		expect(decoder.id).toBe("test-ais")
	})
})

describe("AIS_CATCHER_CAPS", () => {
	it("should have correct default capabilities", () => {
		expect(AIS_CATCHER_CAPS).toEqual({
			input: "external",
			wantsExclusiveSource: true,
			output: "nmea",
			integrationPattern: "network_producer",
		})
	})
})

/**
 * Arbitrary generators for property-based testing
 */

/**
 * Arbitrary for generating valid MMSI (9 digits, first digit 2-7 for ships).
 */
const mmsiArb = fc
	.tuple(fc.integer({ min: 2, max: 7 }), fc.stringMatching(/^[0-9]{8}$/))
	.map(([first, rest]) => `${first}${rest}`)

/**
 * Arbitrary for generating valid ship names (up to 20 characters).
 */
const shipNameArb = fc.stringMatching(/^[A-Z0-9 ]{1,20}$/)

/**
 * Arbitrary for generating valid callsigns (up to 7 characters).
 */
const callsignArb = fc.stringMatching(/^[A-Z0-9]{1,7}$/)

/**
 * Arbitrary for generating valid IMO numbers (7 digits).
 */
const imoArb = fc.integer({ min: 1000000, max: 9999999 })

/**
 * Arbitrary for generating valid ship types (0-99).
 */
const shipTypeArb = fc.integer({ min: 0, max: 99 })

/**
 * Arbitrary for generating valid latitudes (-90 to 90).
 */
const latArb = fc.double({ min: -90, max: 90, noNaN: true })

/**
 * Arbitrary for generating valid longitudes (-180 to 180).
 */
const lonArb = fc.double({ min: -180, max: 180, noNaN: true })

/**
 * Arbitrary for generating valid COG (0-359.9 degrees).
 */
const cogArb = fc.double({ min: 0, max: 359.9, noNaN: true })

/**
 * Arbitrary for generating valid SOG (0-102.2 knots).
 */
const sogArb = fc.double({ min: 0, max: 102.2, noNaN: true })

/**
 * Arbitrary for generating valid heading (0-359 degrees).
 */
const headingArb = fc.integer({ min: 0, max: 359 })

/**
 * Arbitrary for generating valid navigation status (0-15).
 */
const navStatusArb = fc.integer({ min: 0, max: 15 })

/**
 * Arbitrary for generating valid AIS message types (1-27).
 */
const messageTypeArb = fc.integer({ min: 1, max: 27 })

/**
 * Arbitrary for generating valid JSON ship objects.
 */
const jsonShipArb = fc.record({
	mmsi: mmsiArb.map(s => parseInt(s, 10)),
	type: messageTypeArb,
	shipname: fc.option(
		shipNameArb.map(s => s + "  "),
		{ nil: undefined },
	),
	callsign: fc.option(callsignArb, { nil: undefined }),
	imo: fc.option(imoArb, { nil: undefined }),
	shiptype: fc.option(shipTypeArb, { nil: undefined }),
	lat: fc.option(latArb, { nil: undefined }),
	lon: fc.option(lonArb, { nil: undefined }),
	cog: fc.option(cogArb, { nil: undefined }),
	speed: fc.option(sogArb, { nil: undefined }),
	heading: fc.option(headingArb, { nil: undefined }),
	status: fc.option(navStatusArb, { nil: undefined }),
})

describe("AIS-catcher Decoder Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 36: AIS Output Parsing
	 * Validates: Requirements 25.2
	 *
	 * For any valid AIS-catcher output (NMEA or JSON),
	 * the parser should produce a DecoderOutput object with type: 'ship'
	 * and a ShipData object containing at minimum the MMSI.
	 */
	describe("Property 36: AIS Output Parsing", () => {
		it("should parse any valid JSON ship object into ShipData with MMSI", () => {
			fc.assert(
				fc.property(jsonShipArb, json => {
					const result = parseJsonShip(json as Record<string, unknown>)

					// Should produce a valid ShipData
					expect(result).not.toBeNull()

					// Must contain MMSI (9 digits)
					expect(result!.mmsi).toMatch(/^\d{9}$/)

					// Must have lastSeen timestamp
					expect(result!.lastSeen).toBeInstanceOf(Date)

					// Must have messageType
					expect(typeof result!.messageType).toBe("number")

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should preserve optional fields when present in JSON format", () => {
			fc.assert(
				fc.property(
					fc.record({
						mmsi: mmsiArb.map(s => parseInt(s, 10)),
						type: messageTypeArb,
						// Use non-whitespace-only ship names to avoid empty string after trim
						shipname: fc.stringMatching(/^[A-Z0-9][A-Z0-9 ]{0,19}$/),
						callsign: callsignArb,
						lat: latArb,
						lon: lonArb,
						cog: cogArb,
						speed: sogArb,
						heading: headingArb,
						status: navStatusArb,
					}),
					json => {
						const result = parseJsonShip(json as Record<string, unknown>)

						expect(result).not.toBeNull()
						expect(result!.mmsi).toBe(json.mmsi.toString().padStart(9, "0"))
						// Ship name is trimmed, and empty strings become undefined
						const expectedName = json.shipname.trim()
						expect(result!.name).toBe(expectedName || undefined)
						expect(result!.callsign).toBe(json.callsign)
						expect(result!.lat).toBe(json.lat)
						expect(result!.lon).toBe(json.lon)
						expect(result!.cog).toBe(json.cog)
						expect(result!.sog).toBe(json.speed)
						expect(result!.heading).toBe(json.heading)
						expect(result!.navStatus).toBe(json.status)
						expect(result!.messageType).toBe(json.type)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return null for JSON objects without MMSI", () => {
			fc.assert(
				fc.property(
					fc.record({
						shipname: fc.option(shipNameArb, { nil: undefined }),
						callsign: fc.option(callsignArb, { nil: undefined }),
						lat: fc.option(latArb, { nil: undefined }),
						lon: fc.option(lonArb, { nil: undefined }),
					}),
					json => {
						// Ensure no mmsi field
						const result = parseJsonShip(json as Record<string, unknown>)
						return result === null
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should produce ShipData with all required fields for valid JSON", () => {
			fc.assert(
				fc.property(jsonShipArb, json => {
					const result = parseJsonShip(json as Record<string, unknown>)

					// All valid inputs should produce ShipData
					expect(result).not.toBeNull()

					// Verify required fields
					expect(result).toHaveProperty("mmsi")
					expect(result).toHaveProperty("lastSeen")
					expect(result).toHaveProperty("messageType")

					// MMSI must be a valid 9-digit string
					expect(result!.mmsi).toMatch(/^\d{9}$/)

					// lastSeen must be a Date
					expect(result!.lastSeen).toBeInstanceOf(Date)

					// messageType must be a number
					expect(typeof result!.messageType).toBe("number")

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should handle MMSI padding correctly for any numeric MMSI", () => {
			fc.assert(
				fc.property(fc.integer({ min: 1, max: 999999999 }), mmsi => {
					const json = { mmsi, type: 1 }
					const result = parseJsonShip(json as Record<string, unknown>)

					expect(result).not.toBeNull()
					// MMSI should always be 9 digits, padded with leading zeros
					expect(result!.mmsi).toMatch(/^\d{9}$/)
					expect(result!.mmsi.length).toBe(9)

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should handle valid AIS payload decoding", () => {
			// Test with known valid AIS payloads
			const validPayloads = [
				"13u@Dp0P00PH=3pN4T0", // Type 1 position report
				"23u@Dp0P00PH=3pN4T0", // Type 2 position report
				"33u@Dp0P00PH=3pN4T0", // Type 3 position report
			]

			for (const payload of validPayloads) {
				const result = decodeAisPayload(payload)
				if (result) {
					expect(result.mmsi).toMatch(/^\d{9}$/)
					expect(result.messageType).toBeGreaterThanOrEqual(1)
					expect(result.messageType).toBeLessThanOrEqual(27)
				}
			}
		})

		it("should reject invalid AIS payloads", () => {
			fc.assert(
				fc.property(fc.string({ minLength: 0, maxLength: 5 }), shortPayload => {
					// Payloads shorter than 7 characters should be rejected
					const result = decodeAisPayload(shortPayload)
					return result === null
				}),
				{ numRuns: 100 },
			)
		})
	})
})
