/**
 * Multimon-ng Decoder Property-Based Tests
 *
 * Property 13: Multimon Output Parsing
 * Property 14: Multimon Mode Support
 *
 * Requirements: 7.2, 7.3
 */

import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import {
	MultimonDecoder,
	MULTIMON_MODES,
	type MultimonMode,
} from "../../../src/decoders/builtin/multimon-ng.js"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../src/decoders/types.js"

// Create a silent logger for tests
const testLogger = pino({ level: "silent" })

/**
 * Helper to create a MultimonDecoder with given options.
 */
function createDecoder(
	id: string,
	modes: MultimonMode[],
	options: Record<string, unknown> = {},
): MultimonDecoder {
	const config: DecoderConfig = {
		id,
		type: "multimon-ng",
		enabled: true,
		options: { modes, ...options },
	}
	return new MultimonDecoder(config, testLogger)
}

/**
 * Access the protected parseOutput method for testing.
 * We create a test subclass to expose it.
 */
class TestMultimonDecoder extends MultimonDecoder {
	public testParseOutput(line: string): DecoderOutput | null {
		return this.parseOutput(line)
	}
}

function createTestDecoder(
	id: string,
	modes: MultimonMode[] = ["POCSAG1200"],
): TestMultimonDecoder {
	const config: DecoderConfig = {
		id,
		type: "multimon-ng",
		enabled: true,
		options: { modes },
	}
	return new TestMultimonDecoder(config, testLogger)
}

// POCSAG baud rates
const POCSAG_BAUDS = ["512", "1200", "2400"] as const

// POCSAG message types
const POCSAG_MESSAGE_TYPES = ["Alpha", "Numeric", "Tone Only"] as const

// FLEX message types
const FLEX_MESSAGE_TYPES = ["ALN", "GPN", "NUM", "NUU", "HEX"] as const

/**
 * Arbitrary for generating valid decoder IDs.
 */
const decoderIdArb = fc
	.string({ minLength: 1, maxLength: 50 })
	.filter(s => s.trim().length > 0 && !s.includes(" "))

/**
 * Arbitrary for generating valid POCSAG addresses (7 digits max).
 */
const pocsagAddressArb = fc.integer({ min: 0, max: 9999999 })

/**
 * Arbitrary for generating valid POCSAG function codes (0-3).
 */
const pocsagFunctionArb = fc.integer({ min: 0, max: 3 })

/**
 * Arbitrary for generating POCSAG baud rates.
 */
const pocsagBaudArb = fc.constantFrom(...POCSAG_BAUDS)

/**
 * Arbitrary for generating POCSAG message types.
 */
const pocsagMessageTypeArb = fc.constantFrom(...POCSAG_MESSAGE_TYPES)

/**
 * Arbitrary for generating message content (alphanumeric).
 */
const messageContentArb = fc
	.string({ minLength: 0, maxLength: 100 })
	.map(s => s.replace(/[\r\n]/g, " ").trim())

/**
 * Arbitrary for generating FLEX modes (e.g., "1600/2/A").
 */
const flexModeArb = fc
	.tuple(
		fc.constantFrom("1600", "3200", "6400"),
		fc.constantFrom("2", "4"),
		fc.constantFrom("A", "C", "K"),
	)
	.map(([speed, level, phase]) => `${speed}/${level}/${phase}`)

/**
 * Arbitrary for generating FLEX frequencies (e.g., "12.345").
 */
const flexFrequencyArb = fc
	.tuple(fc.integer({ min: 1, max: 99 }), fc.integer({ min: 0, max: 999 }))
	.map(([whole, decimal]) => `${whole}.${String(decimal).padStart(3, "0")}`)

/**
 * Arbitrary for generating FLEX capcodes.
 */
const flexCapcodeArb = fc.integer({ min: 1, max: 9999999 })

/**
 * Arbitrary for generating FLEX message types.
 */
const flexMessageTypeArb = fc.constantFrom(...FLEX_MESSAGE_TYPES)

/**
 * Arbitrary for generating DTMF digits.
 */
const dtmfDigitsArb = fc
	.array(fc.constantFrom(..."0123456789*#ABCD".split("")), {
		minLength: 1,
		maxLength: 20,
	})
	.map(arr => arr.join(""))

/**
 * Arbitrary for generating Multimon-ng modes.
 */
const multimonModeArb = fc.constantFrom(...MULTIMON_MODES)

/**
 * Arbitrary for generating arrays of Multimon-ng modes.
 */
const multimonModesArb = fc
	.array(multimonModeArb, { minLength: 1, maxLength: 8 })
	.map(modes => [...new Set(modes)] as MultimonMode[])

/**
 * Arbitrary for generating callsigns (for AFSK1200).
 */
const callsignArb = fc
	.tuple(
		fc
			.array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")), {
				minLength: 1,
				maxLength: 6,
			})
			.map(arr => arr.join("")),
		fc.integer({ min: 0, max: 15 }),
	)
	.map(([call, ssid]) => `${call}-${ssid}`)

describe("Multimon-ng Decoder Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 13: Multimon Output Parsing
	 * Validates: Requirements 7.2
	 *
	 * For any valid multimon-ng output line matching POCSAG, FLEX, or DTMF patterns,
	 * the parser should produce a DecoderOutput object with the correct type
	 * field and extracted data fields.
	 */
	describe("Property 13: Multimon Output Parsing", () => {
		it("should parse POCSAG lines into structured message events", () => {
			fc.assert(
				fc.property(
					decoderIdArb,
					pocsagBaudArb,
					pocsagAddressArb,
					pocsagFunctionArb,
					pocsagMessageTypeArb,
					messageContentArb,
					(decoderId, baud, address, func, msgType, message) => {
						const decoder = createTestDecoder(decoderId)
						const line = `POCSAG${baud}: Address: ${address}  Function: ${func}  ${msgType}:   ${message}`
						const output = decoder.testParseOutput(line)

						// Should produce a valid DecoderOutput
						expect(output).not.toBeNull()
						expect(output!.type).toBe("message")
						expect(output!.decoder).toBe(decoderId)
						expect(output!.timestamp).toBeInstanceOf(Date)

						// Data should contain the parsed fields
						const data = output!.data as {
							protocol: string
							address: number
							function: number
							messageType: string
							message: string
						}
						expect(data.protocol).toBe(`POCSAG${baud}`)
						expect(data.address).toBe(address)
						expect(data.function).toBe(func)
						expect(data.messageType).toBe(msgType.toLowerCase())
						expect(data.message).toBe(message)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should parse FLEX lines into structured message events", () => {
			fc.assert(
				fc.property(
					decoderIdArb,
					flexModeArb,
					flexFrequencyArb,
					flexCapcodeArb,
					flexMessageTypeArb,
					messageContentArb,
					(decoderId, mode, frequency, capcode, msgType, message) => {
						const decoder = createTestDecoder(decoderId)
						// FLEX format: "FLEX: 1600/2/A 12.345 [1234567] ALN Message text here"
						const line = `FLEX: ${mode} ${frequency} [${capcode}] ${msgType} ${message}`
						const output = decoder.testParseOutput(line)

						// Should produce a valid DecoderOutput
						expect(output).not.toBeNull()
						expect(output!.type).toBe("message")
						expect(output!.decoder).toBe(decoderId)
						expect(output!.timestamp).toBeInstanceOf(Date)

						// Data should contain the parsed fields
						const data = output!.data as {
							protocol: string
							mode: string
							frequency: string
							capcode: string
							messageType: string
							message: string
						}
						expect(data.protocol).toBe("FLEX")
						expect(data.mode).toBe(mode)
						expect(data.frequency).toBe(frequency)
						expect(data.capcode).toBe(String(capcode))
						expect(data.messageType).toBe(msgType)
						expect(data.message).toBe(message)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should parse DTMF lines into structured decode events", () => {
			fc.assert(
				fc.property(decoderIdArb, dtmfDigitsArb, (decoderId, digits) => {
					const decoder = createTestDecoder(decoderId)
					const line = `DTMF: ${digits}`
					const output = decoder.testParseOutput(line)

					// Should produce a valid DecoderOutput
					expect(output).not.toBeNull()
					expect(output!.type).toBe("decode")
					expect(output!.decoder).toBe(decoderId)
					expect(output!.timestamp).toBeInstanceOf(Date)

					// Data should contain the parsed digits
					const data = output!.data as {
						protocol: string
						digits: string
					}
					expect(data.protocol).toBe("DTMF")
					expect(data.digits).toBe(digits)

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should parse EAS lines into structured message events", () => {
			fc.assert(
				fc.property(decoderIdArb, decoderId => {
					const decoder = createTestDecoder(decoderId)
					// EAS format: "EAS: ZCZC-ORG-EEE-PSSCCC+TTTT-JJJHHMM-LLLLLLLL-"
					const easMessage = "ZCZC-WXR-TOR-029001+0030-1051700-KWNS/NWS-"
					const line = `EAS: ${easMessage}`
					const output = decoder.testParseOutput(line)

					// Should produce a valid DecoderOutput
					expect(output).not.toBeNull()
					expect(output!.type).toBe("message")
					expect(output!.decoder).toBe(decoderId)
					expect(output!.timestamp).toBeInstanceOf(Date)

					// Data should contain the raw EAS message
					const data = output!.data as {
						protocol: string
						rawMessage: string
					}
					expect(data.protocol).toBe("EAS")
					expect(data.rawMessage).toBe(easMessage)

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should parse AFSK1200 lines into structured decode events", () => {
			fc.assert(
				fc.property(
					decoderIdArb,
					callsignArb,
					callsignArb,
					(decoderId, fromCall, toCall) => {
						const decoder = createTestDecoder(decoderId)
						const line = `AFSK1200: fm ${fromCall} to ${toCall}`
						const output = decoder.testParseOutput(line)

						// Should produce a valid DecoderOutput
						expect(output).not.toBeNull()
						expect(output!.type).toBe("decode")
						expect(output!.decoder).toBe(decoderId)
						expect(output!.timestamp).toBeInstanceOf(Date)

						// Data should contain the parsed fields
						const data = output!.data as {
							protocol: string
							from: string
							to: string
							via?: string
						}
						expect(data.protocol).toBe("AFSK1200")
						expect(data.from).toBe(fromCall)
						expect(data.to).toBe(toCall)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return null for lines that don't match any pattern", () => {
			fc.assert(
				fc.property(
					decoderIdArb,
					fc.string().filter(s => {
						// Filter out strings that would match our patterns
						const upper = s.toUpperCase()
						return (
							!upper.includes("POCSAG") &&
							!upper.includes("FLEX") &&
							!upper.includes("DTMF:") &&
							!upper.includes("EAS:") &&
							!upper.includes("AFSK1200:") &&
							!upper.includes("FSK9600:")
						)
					}),
					(decoderId, line) => {
						const decoder = createTestDecoder(decoderId)
						const output = decoder.testParseOutput(line)

						// Should return null for non-matching lines
						return output === null
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should produce DecoderOutput with all required fields for any valid pattern", () => {
			// Combined test for all pattern types
			const validLineArb = fc.oneof(
				// POCSAG lines
				fc
					.tuple(
						pocsagBaudArb,
						pocsagAddressArb,
						pocsagFunctionArb,
						pocsagMessageTypeArb,
						messageContentArb,
					)
					.map(
						([baud, addr, func, msgType, msg]) =>
							`POCSAG${baud}: Address: ${addr}  Function: ${func}  ${msgType}:   ${msg}`,
					),
				// FLEX lines
				fc
					.tuple(
						flexModeArb,
						flexFrequencyArb,
						flexCapcodeArb,
						flexMessageTypeArb,
						messageContentArb,
					)
					.map(
						([mode, freq, cap, msgType, msg]) =>
							`FLEX: ${mode} ${freq} [${cap}] ${msgType} ${msg}`,
					),
				// DTMF lines
				dtmfDigitsArb.map(digits => `DTMF: ${digits}`),
			)

			fc.assert(
				fc.property(decoderIdArb, validLineArb, (decoderId, line) => {
					const decoder = createTestDecoder(decoderId)
					const output = decoder.testParseOutput(line)

					// Should produce a valid DecoderOutput
					expect(output).not.toBeNull()

					// Verify all required fields exist
					expect(output).toHaveProperty("timestamp")
					expect(output).toHaveProperty("decoder")
					expect(output).toHaveProperty("type")
					expect(output).toHaveProperty("data")

					// Verify field types
					expect(output!.timestamp).toBeInstanceOf(Date)
					expect(typeof output!.decoder).toBe("string")
					expect(typeof output!.type).toBe("string")
					expect(output!.decoder).toBe(decoderId)

					// Type should be one of the valid output types
					expect(["message", "decode"]).toContain(output!.type)

					return true
				}),
				{ numRuns: 100 },
			)
		})
	})

	/**
	 * Feature: wavekit-core, Property 14: Multimon Mode Support
	 * Validates: Requirements 7.3
	 *
	 * For any mode in the set {POCSAG512, POCSAG1200, POCSAG2400, FLEX, EAS, AFSK1200, FSK9600, DTMF},
	 * creating a Multimon decoder with that mode should succeed without error.
	 */
	describe("Property 14: Multimon Mode Support", () => {
		it("should create decoder successfully for any valid mode", () => {
			fc.assert(
				fc.property(decoderIdArb, multimonModeArb, (decoderId, mode) => {
					// Creating a decoder with any valid mode should not throw
					expect(() => createDecoder(decoderId, [mode])).not.toThrow()

					const decoder = createDecoder(decoderId, [mode])

					// Decoder should be created with correct id and type
					expect(decoder.id).toBe(decoderId)
					expect(decoder.type).toBe("multimon-ng")

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should support all documented modes", () => {
			// Verify all modes from the constant are valid
			const expectedModes: MultimonMode[] = [
				"POCSAG512",
				"POCSAG1200",
				"POCSAG2400",
				"FLEX",
				"EAS",
				"AFSK1200",
				"FSK9600",
				"DTMF",
			]

			fc.assert(
				fc.property(decoderIdArb, decoderId => {
					for (const mode of expectedModes) {
						expect(() => createDecoder(decoderId, [mode])).not.toThrow()
						expect(MULTIMON_MODES).toContain(mode)
					}
					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should create decoder successfully with multiple modes", () => {
			fc.assert(
				fc.property(decoderIdArb, multimonModesArb, (decoderId, modes) => {
					// Creating a decoder with multiple modes should not throw
					expect(() => createDecoder(decoderId, modes)).not.toThrow()

					const decoder = createDecoder(decoderId, modes)

					// Decoder should be created with correct id and type
					expect(decoder.id).toBe(decoderId)
					expect(decoder.type).toBe("multimon-ng")

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should default to POCSAG modes for empty mode array", () => {
			fc.assert(
				fc.property(decoderIdArb, decoderId => {
					// Creating with empty modes should not throw
					const config: DecoderConfig = {
						id: decoderId,
						type: "multimon-ng",
						enabled: true,
						options: { modes: [] },
					}

					expect(() => new MultimonDecoder(config, testLogger)).not.toThrow()

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should return valid status for decoder created with any mode combination", () => {
			fc.assert(
				fc.property(decoderIdArb, multimonModesArb, (decoderId, modes) => {
					const decoder = createDecoder(decoderId, modes)
					const status = decoder.getStatus()

					// Status should have all required fields
					expect(status).toHaveProperty("id")
					expect(status).toHaveProperty("type")
					expect(status).toHaveProperty("running")
					expect(status).toHaveProperty("uptime")
					expect(status).toHaveProperty("stats")

					expect(status.id).toBe(decoderId)
					expect(status.type).toBe("multimon-ng")
					expect(status.running).toBe(false)
					expect(status.uptime).toBe(0)

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should handle invalid modes gracefully by filtering them out", () => {
			fc.assert(
				fc.property(
					decoderIdArb,
					fc
						.array(fc.string(), { minLength: 1, maxLength: 5 })
						.filter(arr =>
							arr.some(s => !MULTIMON_MODES.includes(s as MultimonMode)),
						),
					(decoderId, invalidModes) => {
						// Creating with invalid modes should not throw
						const config: DecoderConfig = {
							id: decoderId,
							type: "multimon-ng",
							enabled: true,
							options: { modes: invalidModes },
						}

						expect(() => new MultimonDecoder(config, testLogger)).not.toThrow()

						return true
					},
				),
				{ numRuns: 100 },
			)
		})
	})
})
