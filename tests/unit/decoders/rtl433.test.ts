import { wmbusJsonLine, wmbusPacket } from "../../mocks/rtl433-wmbus.js"
/**
 * RTL_433 Decoder Property-Based Tests
 *
 * Property 15: RTL433 JSON Parsing
 *
 * Requirements: 8.2
 */

import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import {
	Rtl433Decoder,
	rtl433DetectionLevelConfigured,
} from "../../../src/decoders/builtin/rtl433.js"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../src/decoders/types.js"

// Create a silent logger for tests
const testLogger = pino({ level: "silent" })

/**
 * Access the protected methods for testing.
 * We create a test subclass to expose them.
 */
class TestRtl433Decoder extends Rtl433Decoder {
	public testParseOutput(line: string): DecoderOutput | null {
		return this.parseOutput(line)
	}

	public testGetDecoderArgs(): string[] {
		return this.getDecoderArgs()
	}
}

function createTestDecoder(id: string): TestRtl433Decoder {
	const config: DecoderConfig = {
		id,
		type: "rtl_433",
		enabled: true,
		options: { outputFormat: "json" },
	}
	return new TestRtl433Decoder(config, testLogger)
}

/**
 * Arbitrary for generating valid decoder IDs.
 */
const decoderIdArb = fc
	.string({ minLength: 1, maxLength: 50 })
	.filter(s => s.trim().length > 0 && !s.includes(" "))

/**
 * Arbitrary for generating valid dates that can be converted to ISO strings.
 * Uses integer timestamps to avoid invalid date issues with fc.date().
 */
const validDateArb = fc
	.integer({
		min: new Date("2000-01-01").getTime(),
		max: new Date("2030-12-31").getTime(),
	})
	.map(ts => new Date(ts).toISOString())

/**
 * Arbitrary for generating typical rtl_433 JSON output objects.
 * These simulate real weather sensor and ISM band device outputs.
 */
const rtl433JsonObjectArb = fc.oneof(
	// Weather sensor output
	fc.record({
		time: validDateArb,
		model: fc.constantFrom(
			"Acurite-Tower",
			"Oregon-THR128",
			"LaCrosse-TX141THBv2",
			"Ambient-Weather",
		),
		id: fc.integer({ min: 1, max: 65535 }),
		channel: fc.integer({ min: 1, max: 8 }),
		temperature_C: fc.float({ min: -40, max: 60, noNaN: true }),
		humidity: fc.integer({ min: 0, max: 100 }),
		battery_ok: fc.integer({ min: 0, max: 1 }),
	}),
	// Tire pressure monitor output
	fc.record({
		time: validDateArb,
		model: fc.constantFrom("Toyota-TPMS", "Schrader-TPMS", "Citroen-TPMS"),
		id: fc.integer({ min: 100000, max: 999999 }),
		pressure_kPa: fc.float({ min: 100, max: 400, noNaN: true }),
		temperature_C: fc.float({ min: -20, max: 80, noNaN: true }),
	}),
	// Generic device output
	fc.record({
		time: validDateArb,
		model: fc.string({ minLength: 1, maxLength: 30 }),
		id: fc.integer({ min: 0, max: 16777215 }),
		data: fc.string({ minLength: 2, maxLength: 32 }),
	}),
)

/**
 * Arbitrary for generating valid JSON objects (non-empty).
 * Uses simple types to avoid complex recursive structures.
 */
const jsonObjectArb = fc.dictionary(
	fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
	fc.oneof(
		fc.string(),
		fc.integer(),
		fc.float({ noNaN: true, noDefaultInfinity: true }),
		fc.boolean(),
		fc.constant(null),
	),
	{ minKeys: 1, maxKeys: 10 },
)

describe("RTL_433 Decoder Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 15: RTL433 JSON Parsing
	 * Validates: Requirements 8.2
	 *
	 * For any valid JSON line output by rtl_433, the parser should produce
	 * a DecoderOutput object with type: 'signal' and the parsed JSON as the data field.
	 */
	describe("Property 15: RTL433 JSON Parsing", () => {
		// Helper to normalize -0 to 0 (JSON.stringify converts -0 to "0")
		const normalizeObject = <T extends Record<string, unknown>>(obj: T): T => {
			const result = { ...obj }
			for (const key of Object.keys(result)) {
				const val = result[key]
				if (typeof val === "number" && Object.is(val, -0)) {
					;(result as Record<string, unknown>)[key] = 0
				}
			}
			return result
		}

		it("should parse valid JSON lines into signal events with parsed data", () => {
			fc.assert(
				fc.property(decoderIdArb, jsonObjectArb, (decoderId, jsonObj) => {
					const decoder = createTestDecoder(decoderId)
					const jsonLine = JSON.stringify(jsonObj)
					const output = decoder.testParseOutput(jsonLine)

					// Should produce a valid DecoderOutput
					expect(output).not.toBeNull()
					expect(output!.type).toBe("signal")
					expect(output!.decoder).toBe(decoderId)
					expect(output!.timestamp).toBeInstanceOf(Date)

					// Data should be the parsed JSON object
					// Note: JSON.stringify converts -0 to "0", so we normalize for comparison
					expect(output!.data).toEqual(normalizeObject(jsonObj))

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should parse typical rtl_433 sensor output into signal events", () => {
			fc.assert(
				fc.property(
					decoderIdArb,
					rtl433JsonObjectArb,
					(decoderId, sensorData) => {
						const decoder = createTestDecoder(decoderId)
						const jsonLine = JSON.stringify(sensorData)
						const output = decoder.testParseOutput(jsonLine)

						// Should produce a valid DecoderOutput
						expect(output).not.toBeNull()
						expect(output!.type).toBe("signal")
						expect(output!.decoder).toBe(decoderId)
						expect(output!.timestamp).toBeInstanceOf(Date)

						// Data should contain the sensor data
						// Note: JSON.stringify converts -0 to "0", so we normalize for comparison
						expect(output!.data).toEqual(normalizeObject(sensorData))

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return null for invalid JSON lines", () => {
			fc.assert(
				fc.property(
					decoderIdArb,
					fc.string().filter(s => {
						// Filter to strings that are not valid JSON objects
						if (!s.trim().startsWith("{")) return true
						try {
							JSON.parse(s)
							return false // Valid JSON, exclude
						} catch {
							return true // Invalid JSON, include
						}
					}),
					(decoderId, invalidLine) => {
						const decoder = createTestDecoder(decoderId)
						const output = decoder.testParseOutput(invalidLine)

						// Should return null for non-JSON lines
						return output === null
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return null for empty lines", () => {
			fc.assert(
				fc.property(
					decoderIdArb,
					fc.constantFrom("", "   ", "\t", "\n", "  \t  "),
					(decoderId, emptyLine) => {
						const decoder = createTestDecoder(decoderId)
						const output = decoder.testParseOutput(emptyLine)

						// Should return null for empty/whitespace lines
						return output === null
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should handle JSON with whitespace padding", () => {
			fc.assert(
				fc.property(
					decoderIdArb,
					jsonObjectArb,
					fc
						.string({ minLength: 0, maxLength: 5 })
						.filter(s => /^\s*$/.test(s)),
					fc
						.string({ minLength: 0, maxLength: 5 })
						.filter(s => /^\s*$/.test(s)),
					(decoderId, jsonObj, leadingWs, trailingWs) => {
						const decoder = createTestDecoder(decoderId)
						const jsonLine = `${leadingWs}${JSON.stringify(jsonObj)}${trailingWs}`
						const output = decoder.testParseOutput(jsonLine)

						// Should still parse successfully after trimming
						// Note: JSON.stringify converts -0 to "0", so we normalize for comparison
						expect(output).not.toBeNull()
						expect(output!.type).toBe("signal")
						expect(output!.data).toEqual(normalizeObject(jsonObj))

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should produce DecoderOutput with all required fields", () => {
			fc.assert(
				fc.property(decoderIdArb, jsonObjectArb, (decoderId, jsonObj) => {
					const decoder = createTestDecoder(decoderId)
					const jsonLine = JSON.stringify(jsonObj)
					const output = decoder.testParseOutput(jsonLine)

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
					expect(output!.type).toBe("signal")

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should preserve JSON data structure exactly", () => {
			// Helper to normalize -0 to 0 (JSON.stringify converts -0 to "0")
			const normalizeValue = (val: unknown): unknown => {
				if (typeof val === "number" && Object.is(val, -0)) {
					return 0
				}
				return val
			}

			fc.assert(
				fc.property(
					decoderIdArb,
					rtl433JsonObjectArb,
					(decoderId, sensorData) => {
						const decoder = createTestDecoder(decoderId)
						const jsonLine = JSON.stringify(sensorData)
						const output = decoder.testParseOutput(jsonLine)

						expect(output).not.toBeNull()

						// Deep equality check - data should match exactly
						// Note: JSON.stringify converts -0 to "0", so we normalize for comparison
						const outputData = output!.data as Record<string, unknown>

						for (const key of Object.keys(sensorData)) {
							expect(outputData).toHaveProperty(key)
							const expected = normalizeValue(
								sensorData[key as keyof typeof sensorData],
							)
							const actual = normalizeValue(outputData[key])
							expect(actual).toEqual(expected)
						}

						return true
					},
				),
				{ numRuns: 100 },
			)
		})
	})

	/**
	 * Command Line Arguments Tests
	 * Validates that rtl_433 command line arguments are correctly formed.
	 */
	describe("Command Line Arguments", () => {
		it("should use cu8:- format for stdin input (not plain -)", () => {
			const decoder = createTestDecoder("test-rtl433")
			const args = decoder.testGetDecoderArgs()

			// Find the -r argument and its value
			const rIndex = args.indexOf("-r")
			expect(rIndex).toBeGreaterThanOrEqual(0)

			const rValue = args[rIndex + 1]
			// rtl_433 requires format:filename syntax for stdin, e.g., "cu8:-"
			// Plain "-" doesn't specify the IQ format and won't work
			expect(rValue).toBe("cu8:-")
		})

		it("should include JSON output format flag", () => {
			const decoder = createTestDecoder("test-rtl433")
			const args = decoder.testGetDecoderArgs()

			// Should have -F json for JSON output
			expect(args).toContain("-F")
			expect(args).toContain("json")
		})

		it("should include sample rate when specified", () => {
			const config: DecoderConfig = {
				id: "test-rtl433-sr",
				type: "rtl_433",
				enabled: true,
				options: {
					outputFormat: "json",
					inputSampleRate: 2_048_000,
					targetSampleRate: 1_000_000, // Target 1 MHz
				},
			}
			const decoder = new TestRtl433Decoder(config, testLogger)
			const args = decoder.testGetDecoderArgs()

			// Should have -s for sample rate (decimated rate: 2048000 / 2 = 1024000)
			expect(args).toContain("-s")
			expect(args).toContain("1024000") // Effective rate after integer decimation
		})

		it("should support extra args for additional flags like frequency", () => {
			const config: DecoderConfig = {
				id: "test-rtl433-extra",
				type: "rtl_433",
				enabled: true,
				options: {
					outputFormat: "json",
					extraArgs: ["-f", "433920000"],
				},
			}
			const decoder = new TestRtl433Decoder(config, testLogger)
			const args = decoder.testGetDecoderArgs()

			// Extra args should be included
			expect(args).toContain("-f")
			expect(args).toContain("433920000")
		})
	})
})

describe("rtl_433 detection level", () => {
	const argsWith = (extraArgs?: string[]) =>
		new TestRtl433Decoder(
			{
				id: "level",
				type: "rtl_433",
				enabled: true,
				options: { outputFormat: "json", ...(extraArgs ? { extraArgs } : {}) },
			},
			testLogger,
		).testGetDecoderArgs()

	it("asks rtl_433 for a noise-derived level by default", () => {
		expect(argsWith()).toEqual([
			"-r",
			"cu8:-",
			"-s",
			"1024000",
			"-F",
			"json",
			"-Y",
			"autolevel",
			"-M",
			"level",
		])
	})

	it("leaves an operator level in extraArgs alone", () => {
		for (const extra of [
			["-Y", "minlevel=-30"],
			["-Y", "level=-20"],
			["-Y", "autolevel"],
			["-Yminlevel=-25"],
		]) {
			const args = argsWith(extra)
			expect(args.filter(a => a === "autolevel").length).toBe(
				extra.includes("autolevel") ? 1 : 0,
			)
			expect(args.slice(-extra.length)).toEqual(extra)
		}
	})

	it("keeps autolevel when extraArgs set other -Y options", () => {
		expect(argsWith(["-Y", "classic"])).toEqual([
			"-r",
			"cu8:-",
			"-s",
			"1024000",
			"-F",
			"json",
			"-Y",
			"autolevel",
			"-M",
			"level",
			"-Y",
			"classic",
		])
	})

	// Feature: rtl433-detection-level, Property 1: a level is configured exactly when a -Y value sets one
	// Validates: operator detection level wins over the default
	it("detects a level setting anywhere in extraArgs", () => {
		const other = fc.constantFrom(
			"-f",
			"433920000",
			"-Y",
			"classic",
			"-M",
			"level",
			"-R",
			"40",
		)
		const setting = fc.constantFrom("level=-20", "minlevel=-30", "autolevel")
		fc.assert(
			fc.property(
				fc.array(other, { maxLength: 8 }),
				fc.option(setting, { nil: undefined }),
				fc.boolean(),
				(rest, level, joined) => {
					const extra =
						level === undefined
							? rest
							: [...rest, ...(joined ? [`-Y${level}`] : ["-Y", level])]
					expect(rtl433DetectionLevelConfigured(extra)).toBe(
						level !== undefined,
					)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("rtl_433 stdin centre", () => {
	const args = (options: Record<string, unknown>) =>
		new TestRtl433Decoder(
			{ id: "c", type: "rtl_433", enabled: true, options },
			testLogger,
		).testGetDecoderArgs()

	it("passes the stdin centre as -f so freq is absolute, and asks for -M level", () => {
		const a = args({ inputCenterFreq: 433_600_000 })
		expect(a.slice(a.indexOf("-f"), a.indexOf("-f") + 2)).toEqual([
			"-f",
			"433600000",
		])
		expect(a).toContain("level")
	})

	it("leaves -f to the operator and drops an out-of-bounds centre", () => {
		const op = args({ inputCenterFreq: 433_600_000, extraArgs: ["-f", "1"] })
		expect(op.filter(x => x === "-f")).toHaveLength(1)
		expect(op.slice(-2)).toEqual(["-f", "1"])
		expect(args({ inputCenterFreq: 999 })).not.toContain("-f")
		expect(args({ inputCenterFreq: 1_000 })).toContain("-f")
		expect(args({ inputCenterFreq: 6_000_000_000 })).toContain("-f")
		expect(args({ inputCenterFreq: 6_000_000_001 })).not.toContain("-f")
	})
})

// The default list in the pinned binary already enables protocols 104, 105 and 238.
it.each([1_200_000, 2_400_000])(
	"reads wM-Bus at %i without protocol filters or decimation",
	rate => {
		const decoder = new TestRtl433Decoder(
			{
				id: "synthetic-meter",
				type: "rtl433",
				enabled: true,
				options: {
					inputSampleRate: rate,
					targetSampleRate: rate,
					inputCenterFreq: 868_900_000,
				},
			},
			testLogger,
		)
		const args = decoder.testGetDecoderArgs()
		expect(args).toEqual(
			expect.arrayContaining([
				"-r",
				"cu8:-",
				"-s",
				String(rate),
				"-f",
				"868900000",
				"-M",
				"level",
			]),
		)
		expect(args).not.toContain("-R")
		expect(args).not.toContain("-G")
		expect(decoder.testParseOutput(wmbusJsonLine)).toMatchObject({
			type: "signal",
			data: wmbusPacket,
		})
	},
)
