/**
 * ACARS Decoder Unit Tests
 *
 * Tests for the AcarsdecDecoder class.
 * Requirements: 23.1, 23.2, 23.3, 23.4
 *
 * Property 34: ACARS Output Parsing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import {
	AcarsdecDecoder,
	parseAcarsdecJson,
	createAcarsdecDecoder,
	ACARSDEC_CAPS,
	type ACARSMessage,
	type AcarsdecOptions,
} from "../../../src/decoders/builtin/acarsdec.js"
import pino from "pino"

// Create a silent logger for tests
const testLogger = pino({ level: "silent" })

/**
 * Creates a test decoder config with optional overrides.
 */
function createConfig(overrides: Partial<DecoderConfig> = {}): DecoderConfig {
	return {
		id: "test-acarsdec",
		type: "acarsdec",
		enabled: true,
		deviceSerial: "00000001",
		frequencies: [131_550_000, 131_725_000],
		options: {
			outputFormat: "json",
			...overrides.options,
		},
		...overrides,
	}
}

describe("AcarsdecDecoder", () => {
	let decoder: AcarsdecDecoder

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
			const config = createConfig({ id: "my-acarsdec", type: "acarsdec" })
			decoder = new AcarsdecDecoder(config, testLogger)

			expect(decoder.id).toBe("my-acarsdec")
			expect(decoder.type).toBe("acarsdec")
		})

		it("should use default frequencies when not specified", () => {
			const config = createConfig({
				frequencies: undefined,
				options: {},
			})
			decoder = new AcarsdecDecoder(config, testLogger)

			// Should use default ACARS frequencies
			expect(decoder.getFrequencies()).toEqual([131_550_000, 131_725_000])
		})

		it("should use configured frequencies (Requirement 23.3)", () => {
			const config = createConfig({
				frequencies: [131_550_000, 131_725_000, 131_850_000],
			})
			decoder = new AcarsdecDecoder(config, testLogger)

			expect(decoder.getFrequencies()).toEqual([
				131_550_000, 131_725_000, 131_850_000,
			])
		})

		it("should use configured device serial (Requirement 23.1)", () => {
			const config = createConfig({
				deviceSerial: "RTLSDR001",
			})
			decoder = new AcarsdecDecoder(config, testLogger)

			expect(decoder.getDeviceSerial()).toBe("RTLSDR001")
		})
	})

	describe("getCaps", () => {
		it("should return correct capabilities", () => {
			const config = createConfig()
			decoder = new AcarsdecDecoder(config, testLogger)

			expect(decoder.caps).toEqual({
				input: "external",
				wantsExclusiveSource: true,
				output: "jsonl",
				integrationPattern: "external_sdr",
			})
		})
	})

	describe("getStatus", () => {
		it("should return status with all required fields when not running", () => {
			const config = createConfig()
			decoder = new AcarsdecDecoder(config, testLogger)
			const status = decoder.getStatus()

			expect(status.id).toBe("test-acarsdec")
			expect(status.type).toBe("acarsdec")
			expect(status.running).toBe(false)
			expect(status.health).toBe("running")
			expect(status.pid).toBeUndefined()
			expect(status.uptime).toBe(0)
			expect(status.stats).toEqual({ bytesIn: 0, eventsOut: 0, errors: 0 })
			expect(status.restartCount).toBe(0)
		})
	})

	describe("attachInput/detachInput", () => {
		it("should be no-ops for external SDR decoder (Requirement 19.2)", () => {
			const config = createConfig()
			decoder = new AcarsdecDecoder(config, testLogger)

			// These should not throw
			expect(() => decoder.attachInput({} as any)).not.toThrow()
			expect(() => decoder.detachInput()).not.toThrow()
		})
	})

	describe("getAudioOutput", () => {
		it("should return null (ACARS decoder does not produce audio)", () => {
			const config = createConfig()
			decoder = new AcarsdecDecoder(config, testLogger)

			expect(decoder.getAudioOutput()).toBeNull()
		})
	})
})

describe("parseAcarsdecJson", () => {
	it("should parse a valid JSON message with all fields", () => {
		const json = {
			timestamp: 1704067200, // 2024-01-01 00:00:00 UTC
			freq: 131.55,
			channel: 0,
			level: -25,
			error: 0,
			mode: "2",
			label: "H1",
			block_id: "A",
			ack: "!",
			tail: "N12345",
			flight: "UAL123",
			msgno: "M01A",
			text: "TEST MESSAGE",
		}

		const result = parseAcarsdecJson(json)

		expect(result).not.toBeNull()
		expect(result?.frequency).toBeCloseTo(131_550_000, 0)
		expect(result?.channel).toBe(0)
		expect(result?.level).toBe(-25)
		expect(result?.error).toBe(0)
		expect(result?.mode).toBe("2")
		expect(result?.label).toBe("H1")
		expect(result?.blockId).toBe("A")
		expect(result?.ack).toBe("!")
		expect(result?.tail).toBe("N12345")
		expect(result?.flight).toBe("UAL123")
		expect(result?.msgno).toBe("M01A")
		expect(result?.text).toBe("TEST MESSAGE")
	})

	it("should parse a message with minimal fields", () => {
		const json = {
			freq: 131.725,
		}

		const result = parseAcarsdecJson(json)

		expect(result).not.toBeNull()
		expect(result?.frequency).toBe(131_725_000)
		expect(result?.channel).toBe(0)
		expect(result?.level).toBe(0)
		expect(result?.error).toBe(0)
		expect(result?.mode).toBe("")
		expect(result?.label).toBe("")
	})

	it("should return null when frequency is missing", () => {
		const json = {
			timestamp: 1704067200,
			channel: 0,
			level: -25,
		}

		const result = parseAcarsdecJson(json)

		expect(result).toBeNull()
	})

	it("should handle alternative field names", () => {
		const json = {
			frequency: 131.55, // Alternative to freq
			reg: "N12345", // Alternative to tail
			message: "TEST MESSAGE", // Alternative to text
		}

		const result = parseAcarsdecJson(json)

		expect(result).not.toBeNull()
		expect(result?.frequency).toBeCloseTo(131_550_000, 0)
		expect(result?.tail).toBe("N12345")
		expect(result?.text).toBe("TEST MESSAGE")
	})

	it("should handle boolean ack field", () => {
		const jsonTrue = { freq: 131.55, ack: true }
		const jsonFalse = { freq: 131.55, ack: false }

		const resultTrue = parseAcarsdecJson(jsonTrue)
		const resultFalse = parseAcarsdecJson(jsonFalse)

		expect(resultTrue?.ack).toBe("!")
		expect(resultFalse?.ack).toBeUndefined()
	})

	it("should handle ISO timestamp string", () => {
		const json = {
			timestamp: "2024-01-01T12:30:45.000Z",
			freq: 131.55,
		}

		const result = parseAcarsdecJson(json)

		expect(result).not.toBeNull()
		expect(result?.timestamp).toBeInstanceOf(Date)
		expect(result?.timestamp.toISOString()).toBe("2024-01-01T12:30:45.000Z")
	})

	it("should use current time when timestamp is missing", () => {
		const before = new Date()
		const json = { freq: 131.55 }
		const result = parseAcarsdecJson(json)
		const after = new Date()

		expect(result).not.toBeNull()
		expect(result?.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
		expect(result?.timestamp.getTime()).toBeLessThanOrEqual(after.getTime())
	})
})

describe("createAcarsdecDecoder", () => {
	it("should create an AcarsdecDecoder instance", () => {
		const config = createConfig()
		const decoder = createAcarsdecDecoder(config, testLogger)

		expect(decoder).toBeInstanceOf(AcarsdecDecoder)
		expect(decoder.id).toBe("test-acarsdec")
	})
})

describe("ACARSDEC_CAPS", () => {
	it("should have correct capabilities", () => {
		expect(ACARSDEC_CAPS).toEqual({
			input: "external",
			wantsExclusiveSource: true,
			output: "jsonl",
			integrationPattern: "external_sdr",
		})
	})
})

/**
 * Arbitrary generators for property-based testing
 */

/**
 * Arbitrary for generating valid ACARS frequencies in MHz.
 * Common ACARS frequencies are in the 129-137 MHz range.
 */
const frequencyMhzArb = fc.double({
	min: 129.0,
	max: 137.0,
	noNaN: true,
	noDefaultInfinity: true,
})

/**
 * Arbitrary for generating valid channel numbers (0-7).
 */
const channelArb = fc.integer({ min: 0, max: 7 })

/**
 * Arbitrary for generating signal levels in dB (-50 to 0).
 */
const levelArb = fc.integer({ min: -50, max: 0 })

/**
 * Arbitrary for generating error counts (0-5).
 */
const errorArb = fc.integer({ min: 0, max: 5 })

/**
 * Arbitrary for generating ACARS mode characters.
 */
const modeArb = fc.constantFrom("2", "X", "H", "Q")

/**
 * Arbitrary for generating ACARS labels (2 characters).
 */
const labelArb = fc.stringMatching(/^[A-Z0-9_]{2}$/)

/**
 * Arbitrary for generating block IDs (single character).
 */
const blockIdArb = fc.stringMatching(/^[A-Z0-9]$/)

/**
 * Arbitrary for generating ack characters.
 */
const ackArb = fc.constantFrom("!", "NAK", undefined)

/**
 * Arbitrary for generating aircraft tail numbers.
 */
const tailArb = fc.stringMatching(/^[A-Z]-?[A-Z0-9]{2,5}$/)

/**
 * Arbitrary for generating flight numbers.
 */
const flightArb = fc.stringMatching(/^[A-Z]{2,3}[0-9]{1,4}$/)

/**
 * Arbitrary for generating message numbers.
 */
const msgnoArb = fc.stringMatching(/^[A-Z][0-9]{2}[A-Z]$/)

/**
 * Arbitrary for generating message text.
 */
const textArb = fc.string({ minLength: 0, maxLength: 220 })

/**
 * Arbitrary for generating Unix timestamps (recent).
 */
const timestampArb = fc.integer({
	min: 1704067200, // 2024-01-01
	max: 1735689600, // 2025-01-01
})

/**
 * Arbitrary for generating valid acarsdec JSON output with all fields.
 */
const acarsdecJsonArb = fc.record({
	timestamp: fc.option(timestampArb, { nil: undefined }),
	freq: frequencyMhzArb,
	channel: fc.option(channelArb, { nil: undefined }),
	level: fc.option(levelArb, { nil: undefined }),
	error: fc.option(errorArb, { nil: undefined }),
	mode: fc.option(modeArb, { nil: undefined }),
	label: fc.option(labelArb, { nil: undefined }),
	block_id: fc.option(blockIdArb, { nil: undefined }),
	ack: fc.option(ackArb, { nil: undefined }),
	tail: fc.option(tailArb, { nil: undefined }),
	flight: fc.option(flightArb, { nil: undefined }),
	msgno: fc.option(msgnoArb, { nil: undefined }),
	text: fc.option(textArb, { nil: undefined }),
})

/**
 * Arbitrary for generating valid acarsdec JSON with alternative field names.
 */
const acarsdecJsonAltArb = fc.record({
	timestamp: fc.option(timestampArb, { nil: undefined }),
	frequency: frequencyMhzArb, // Alternative to freq
	channel: fc.option(channelArb, { nil: undefined }),
	level: fc.option(levelArb, { nil: undefined }),
	error: fc.option(errorArb, { nil: undefined }),
	mode: fc.option(modeArb, { nil: undefined }),
	label: fc.option(labelArb, { nil: undefined }),
	block_id: fc.option(blockIdArb, { nil: undefined }),
	ack: fc.option(fc.boolean(), { nil: undefined }), // Boolean ack
	reg: fc.option(tailArb, { nil: undefined }), // Alternative to tail
	flight: fc.option(flightArb, { nil: undefined }),
	msgno: fc.option(msgnoArb, { nil: undefined }),
	message: fc.option(textArb, { nil: undefined }), // Alternative to text
})

describe("ACARS Decoder Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 34: ACARS Output Parsing
	 * Validates: Requirements 23.2
	 *
	 * For any valid acarsdec JSON output line, the parser should produce
	 * a DecoderOutput object with type: 'acars' and an ACARSMessage object
	 * containing timestamp, frequency, and message content.
	 */
	describe("Property 34: ACARS Output Parsing", () => {
		it("should parse any valid acarsdec JSON into ACARSMessage with required fields", () => {
			fc.assert(
				fc.property(acarsdecJsonArb, json => {
					const result = parseAcarsdecJson(json as any)

					// Should produce a valid ACARSMessage
					expect(result).not.toBeNull()

					// Must contain timestamp
					expect(result!.timestamp).toBeInstanceOf(Date)

					// Must contain frequency (converted to Hz)
					expect(typeof result!.frequency).toBe("number")
					expect(result!.frequency).toBeGreaterThan(0)

					// Frequency should be in Hz (original is MHz)
					expect(result!.frequency).toBeCloseTo(json.freq * 1_000_000, 0)

					// Must have channel, level, error, mode, label
					expect(typeof result!.channel).toBe("number")
					expect(typeof result!.level).toBe("number")
					expect(typeof result!.error).toBe("number")
					expect(typeof result!.mode).toBe("string")
					expect(typeof result!.label).toBe("string")

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should parse JSON with alternative field names", () => {
			fc.assert(
				fc.property(acarsdecJsonAltArb, json => {
					const result = parseAcarsdecJson(json as any)

					// Should produce a valid ACARSMessage
					expect(result).not.toBeNull()

					// Must contain timestamp
					expect(result!.timestamp).toBeInstanceOf(Date)

					// Must contain frequency (from 'frequency' field)
					expect(result!.frequency).toBeCloseTo(json.frequency * 1_000_000, 0)

					// Should handle alternative tail field (reg)
					if (json.reg !== undefined) {
						expect(result!.tail).toBe(json.reg)
					}

					// Should handle alternative text field (message)
					if (json.message !== undefined) {
						expect(result!.text).toBe(json.message)
					}

					// Should handle boolean ack
					if (json.ack === true) {
						expect(result!.ack).toBe("!")
					} else if (json.ack === false) {
						expect(result!.ack).toBeUndefined()
					}

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should preserve optional fields when present", () => {
			fc.assert(
				fc.property(
					fc.record({
						timestamp: timestampArb,
						freq: frequencyMhzArb,
						channel: channelArb,
						level: levelArb,
						error: errorArb,
						mode: modeArb,
						label: labelArb,
						block_id: blockIdArb,
						ack: fc.constantFrom("!", "NAK"),
						tail: tailArb,
						flight: flightArb,
						msgno: msgnoArb,
						text: textArb,
					}),
					json => {
						const result = parseAcarsdecJson(json as any)

						expect(result).not.toBeNull()

						// Verify all fields are preserved
						expect(result!.channel).toBe(json.channel)
						expect(result!.level).toBe(json.level)
						expect(result!.error).toBe(json.error)
						expect(result!.mode).toBe(json.mode)
						expect(result!.label).toBe(json.label)
						expect(result!.blockId).toBe(json.block_id)
						expect(result!.ack).toBe(json.ack)
						expect(result!.tail).toBe(json.tail)
						expect(result!.flight).toBe(json.flight)
						expect(result!.msgno).toBe(json.msgno)
						expect(result!.text).toBe(json.text)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return null for JSON without frequency", () => {
			fc.assert(
				fc.property(
					fc.record({
						timestamp: fc.option(timestampArb, { nil: undefined }),
						channel: fc.option(channelArb, { nil: undefined }),
						level: fc.option(levelArb, { nil: undefined }),
						error: fc.option(errorArb, { nil: undefined }),
						mode: fc.option(modeArb, { nil: undefined }),
						label: fc.option(labelArb, { nil: undefined }),
						tail: fc.option(tailArb, { nil: undefined }),
						flight: fc.option(flightArb, { nil: undefined }),
						text: fc.option(textArb, { nil: undefined }),
					}),
					json => {
						// Ensure no freq or frequency field
						const result = parseAcarsdecJson(json as any)
						return result === null
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should handle Unix timestamp correctly", () => {
			fc.assert(
				fc.property(
					fc.record({
						timestamp: timestampArb,
						freq: frequencyMhzArb,
					}),
					json => {
						const result = parseAcarsdecJson(json as any)

						expect(result).not.toBeNull()

						// Timestamp should be converted from Unix seconds to Date
						const expectedDate = new Date(json.timestamp * 1000)
						expect(result!.timestamp.getTime()).toBe(expectedDate.getTime())

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should produce ACARSMessage with all required fields for any valid input", () => {
			fc.assert(
				fc.property(fc.oneof(acarsdecJsonArb, acarsdecJsonAltArb), json => {
					const result = parseAcarsdecJson(json as any)

					// All valid inputs should produce ACARSMessage
					expect(result).not.toBeNull()

					// Verify required fields exist and have correct types
					expect(result).toHaveProperty("timestamp")
					expect(result).toHaveProperty("frequency")
					expect(result).toHaveProperty("channel")
					expect(result).toHaveProperty("level")
					expect(result).toHaveProperty("error")
					expect(result).toHaveProperty("mode")
					expect(result).toHaveProperty("label")

					// timestamp must be a Date
					expect(result!.timestamp).toBeInstanceOf(Date)

					// frequency must be a positive number in Hz
					expect(result!.frequency).toBeGreaterThan(0)

					// channel, level, error must be numbers
					expect(typeof result!.channel).toBe("number")
					expect(typeof result!.level).toBe("number")
					expect(typeof result!.error).toBe("number")

					// mode and label must be strings
					expect(typeof result!.mode).toBe("string")
					expect(typeof result!.label).toBe("string")

					return true
				}),
				{ numRuns: 100 },
			)
		})
	})
})
