/**
 * LoRa/Meshtastic Decoder Property-Based Tests.
 *
 * Eight properties from .kiro/specs/lora-decoder/design.md section 7.
 */

import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../src/decoders/types.js"
import {
	LoraMeshtasticDecoder,
	LORA_MESHTASTIC_CAPS,
	LORA_PRESETS,
	LORA_REGIONS,
	PRESET_TABLE,
	buildDecoderArgs,
	parseLoraMeshtasticOptions,
	parseMeshtasticPacket,
	type LoraPreset,
	type LoraRegion,
	type MeshtasticPacket,
} from "../../../src/decoders/builtin/lora-meshtastic.js"
import { ConfigValidationError } from "../../../src/utils/errors.js"

const testLogger = pino({ level: "silent" })

class TestLoraMeshtasticDecoder extends LoraMeshtasticDecoder {
	public testParseOutput(line: string): DecoderOutput | null {
		return this.parseOutput(line)
	}
}

function makeConfig(options: Record<string, unknown>): DecoderConfig {
	return {
		id: "test-lora",
		type: "lora-meshtastic",
		enabled: true,
		options,
	}
}

function validOptions(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		region: "EU_868",
		preset: "LongFast",
		frequency: 869_525_000,
		channelKey: "AQ==",
		...overrides,
	}
}

const validDateArb = fc
	.integer({
		min: new Date("2020-01-01T00:00:00.000Z").getTime(),
		max: new Date("2030-12-31T23:59:59.999Z").getTime(),
	})
	.map(ms => new Date(ms).toISOString())

const payloadFieldsArb = fc
	.uint8Array({ minLength: 0, maxLength: 100 })
	.map(bytes => ({
		payload_b64: Buffer.from(bytes).toString("base64"),
		payload_len: bytes.length,
	}))

const wireShapeArb = fc
	.record({
		from: fc.integer({ min: 0, max: 4_294_967_295 }),
		to: fc.integer({ min: 0, max: 4_294_967_295 }),
		id: fc.integer({ min: 0, max: 4_294_967_295 }),
		channel: fc.integer({ min: 0, max: 255 }),
		hop_limit: fc.integer({ min: 0, max: 7 }),
		hop_start: fc.integer({ min: 0, max: 7 }),
		want_ack: fc.boolean(),
		via_mqtt: fc.option(fc.boolean(), { nil: undefined }),
		priority: fc.option(fc.integer({ min: 0, max: 255 }), {
			nil: undefined,
		}),
		portnum: fc.integer({ min: 0, max: 255 }),
		rx_rssi: fc.integer({ min: -150, max: 0 }),
		rx_snr: fc
			.double({
				min: -20,
				max: 20,
				noNaN: true,
				noDefaultInfinity: true,
			})
			.map(value => (Object.is(value, -0) ? 0 : value)),
		rx_time: validDateArb,
		frequency: fc.integer({ min: 400_000_000, max: 950_000_000 }),
		bw: fc.constantFrom(62_500, 125_000, 250_000),
		sf: fc.integer({ min: 7, max: 12 }),
		cr: fc.integer({ min: 5, max: 8 }),
	})
	.chain(base =>
		payloadFieldsArb.map(payload => ({
			...base,
			...payload,
		})),
	)

describe("LoRa/Meshtastic Decoder Property-Based Tests", () => {
	describe("Property 1: options round-trip", () => {
		// Feature: lora-meshtastic, Property 1: Options round-trip
		// Validates: Requirements 1.2, 1.5, 4.6
		it("returns the same resolved options on repeated parses", () => {
			fc.assert(
				fc.property(
					fc.constantFrom(...LORA_REGIONS),
					fc.constantFrom(...LORA_PRESETS),
					fc.integer({ min: 400_000_000, max: 950_000_000 }),
					fc.option(fc.integer({ min: 62_500, max: 500_000 }), {
						nil: undefined,
					}),
					fc.option(fc.integer({ min: 7, max: 12 }), {
						nil: undefined,
					}),
					fc.option(fc.integer({ min: 5, max: 8 }), {
						nil: undefined,
					}),
					(
						region,
						preset,
						frequency,
						bandwidth,
						spreadingFactor,
						codingRate,
					) => {
						const opts: Record<string, unknown> = {
							region,
							preset,
							frequency,
							channelKey: "AQ==",
						}
						if (bandwidth !== undefined) opts["bandwidth"] = bandwidth
						if (spreadingFactor !== undefined) {
							opts["spreadingFactor"] = spreadingFactor
						}
						if (codingRate !== undefined) opts["codingRate"] = codingRate

						try {
							const a = parseLoraMeshtasticOptions(opts)
							const b = parseLoraMeshtasticOptions(opts)
							expect(b).toEqual(a)
						} catch (err) {
							expect(err).toBeInstanceOf(ConfigValidationError)
						}
					},
				),
				{ numRuns: 100 },
			)
		})
	})

	describe("Property 2: args determinism", () => {
		// Feature: lora-meshtastic, Property 2: Args determinism
		// Validates: Requirements 3.1, 8.3
		it("produces identical arg arrays for identical resolved options", () => {
			fc.assert(
				fc.property(
					fc.constantFrom(...LORA_REGIONS),
					fc.constantFrom(...LORA_PRESETS),
					fc.integer({ min: 400_000_000, max: 950_000_000 }),
					(region, preset, frequency) => {
						const opts = { region, preset, frequency, channelKey: "AQ==" }
						const a = buildDecoderArgs(parseLoraMeshtasticOptions(opts))
						const b = buildDecoderArgs(parseLoraMeshtasticOptions(opts))
						expect(a).toEqual(b)
					},
				),
				{ numRuns: 100 },
			)
		})
	})

	describe("Property 3: JSONL round-trip", () => {
		// Feature: lora-meshtastic, Property 3: JSONL round-trip
		// Validates: Requirements 4.1, 4.2, 4.4, 5.3
		it("remaps snake_case to camelCase and tags type:'meshtastic'", () => {
			fc.assert(
				fc.property(wireShapeArb, wire => {
					const decoder = new TestLoraMeshtasticDecoder(
						makeConfig(validOptions()),
						testLogger,
					)
					const out = decoder.testParseOutput(JSON.stringify(wire))

					expect(out).not.toBeNull()
					expect(out!.type).toBe("meshtastic")
					expect(out!.decoder).toBe("test-lora")
					expect(out!.timestamp).toBeInstanceOf(Date)

					const data = out!.data as MeshtasticPacket
					expect(data.from).toBe(wire.from)
					expect(data.to).toBe(wire.to)
					expect(data.id).toBe(wire.id)
					expect(data.channel).toBe(wire.channel)
					expect(data.hopLimit).toBe(wire.hop_limit)
					expect(data.hopStart).toBe(wire.hop_start)
					expect(data.wantAck).toBe(wire.want_ack)
					expect(data.portnum).toBe(wire.portnum)
					expect(data.payloadB64).toBe(wire.payload_b64)
					expect(data.payloadLen).toBe(wire.payload_len)
					expect(data.rxRssi).toBe(wire.rx_rssi)
					expect(data.rxSnr).toBe(wire.rx_snr)
					expect(data.rxTime).toBe(wire.rx_time)
					expect(data.frequency).toBe(wire.frequency)
					expect(data.bw).toBe(wire.bw)
					expect(data.sf).toBe(wire.sf)
					expect(data.cr).toBe(wire.cr)
					if (wire.via_mqtt !== undefined) {
						expect(data.viaMqtt).toBe(wire.via_mqtt)
					}
					if (wire.priority !== undefined) {
						expect(data.priority).toBe(wire.priority)
					}
				}),
				{ numRuns: 100 },
			)
		})
	})

	describe("Property 4: non-JSON tolerance", () => {
		// Feature: lora-meshtastic, Property 4: Non-JSON tolerance
		// Validates: Requirements 4.3, 4.5
		it("returns null without throwing for non-JSON, malformed JSON, or invalid shapes", () => {
			const invalidShapeArb = fc.oneof(
				fc.constantFrom("", " ", "\t", "\n", "{", "}", "null", "[]", "log: hi"),
				fc.string({ minLength: 0, maxLength: 80 }),
				fc
					.uint8Array({ minLength: 0, maxLength: 80 })
					.map(bytes => Buffer.from(bytes).toString("latin1")),
				fc
					.dictionary(fc.string(), fc.anything())
					.filter(obj => parseMeshtasticPacket(obj) === null)
					.map(obj => JSON.stringify(obj)),
			)

			fc.assert(
				fc.property(invalidShapeArb, line => {
					const decoder = new TestLoraMeshtasticDecoder(
						makeConfig(validOptions()),
						testLogger,
					)
					expect(() => decoder.testParseOutput(line)).not.toThrow()
					expect(decoder.testParseOutput(line)).toBeNull()
				}),
				{ numRuns: 100 },
			)
		})

		it("parseMeshtasticPacket returns null on null/array/non-object inputs", () => {
			expect(parseMeshtasticPacket(null)).toBeNull()
			expect(parseMeshtasticPacket(undefined)).toBeNull()
			expect(parseMeshtasticPacket([])).toBeNull()
			expect(parseMeshtasticPacket(42)).toBeNull()
			expect(parseMeshtasticPacket("hello")).toBeNull()
		})
	})

	describe("Property 5: effective sample-rate derivation", () => {
		// Feature: lora-meshtastic, Property 5: Effective sample-rate derivation
		// Validates: Requirements 2.2, 2.3, 2.4
		it("matches the documented formula or throws on out-of-range sps", () => {
			fc.assert(
				fc.property(
					fc.integer({ min: 250_000, max: 8_000_000 }),
					fc.constantFrom(62_500, 125_000, 250_000),
					fc.integer({ min: 1, max: 32 }),
					(inputSampleRate, bandwidth, oversampling) => {
						const opts = validOptions({
							region: "EU_868" as LoraRegion,
							preset: "LongFast" as LoraPreset,
							bandwidth,
							inputSampleRate,
							oversampling,
						})

						try {
							const resolved = parseLoraMeshtasticOptions(opts)
							const nominalTarget = bandwidth * oversampling
							const decimation = Math.max(
								1,
								Math.round(inputSampleRate / nominalTarget),
							)
							const expected = inputSampleRate / decimation
							expect(resolved.effectiveTargetRate).toBe(expected)
							const sps = resolved.effectiveTargetRate / bandwidth
							expect(sps).toBeGreaterThanOrEqual(2)
							expect(sps).toBeLessThanOrEqual(32)
						} catch (err) {
							expect(err).toBeInstanceOf(ConfigValidationError)
						}
					},
				),
				{ numRuns: 100 },
			)
		})
	})

	describe("Property 6: required-field rejection", () => {
		// Feature: lora-meshtastic, Property 6: Required-field rejection
		// Validates: Requirements 1.2, 1.6
		const requiredFields = [
			"region",
			"preset",
			"frequency",
			"channelKey",
		] as const

		for (const field of requiredFields) {
			it(`throws ConfigValidationError when "${field}" is missing`, () => {
				fc.assert(
					fc.property(
						fc.constantFrom(...LORA_REGIONS),
						fc.constantFrom(...LORA_PRESETS),
						(region, preset) => {
							const opts = validOptions({ region, preset })
							delete opts[field]
							expect(() => parseLoraMeshtasticOptions(opts)).toThrow(
								ConfigValidationError,
							)
						},
					),
					{ numRuns: 100 },
				)
			})
		}
	})

	describe("Property 7: region & preset enum exhaustiveness", () => {
		// Feature: lora-meshtastic, Property 7: Region & preset enum exhaustiveness
		// Validates: Requirements 1.3, 1.4
		it("accepts every documented region", () => {
			fc.assert(
				fc.property(fc.constantFrom(...LORA_REGIONS), region => {
					const opts = validOptions({ region })
					expect(() => parseLoraMeshtasticOptions(opts)).not.toThrow()
				}),
				{ numRuns: 100 },
			)
		})

		it("accepts every documented preset", () => {
			fc.assert(
				fc.property(fc.constantFrom(...LORA_PRESETS), preset => {
					const opts = validOptions({ preset })
					expect(() => parseLoraMeshtasticOptions(opts)).not.toThrow()
				}),
				{ numRuns: 100 },
			)
		})

		it("rejects unknown region strings", () => {
			fc.assert(
				fc.property(
					fc
						.string({ minLength: 1, maxLength: 20 })
						.filter(s => !(LORA_REGIONS as readonly string[]).includes(s)),
					region => {
						const opts = validOptions({ region })
						expect(() => parseLoraMeshtasticOptions(opts)).toThrow(
							ConfigValidationError,
						)
					},
				),
				{ numRuns: 100 },
			)
		})

		it("rejects unknown preset strings", () => {
			fc.assert(
				fc.property(
					fc
						.string({ minLength: 1, maxLength: 20 })
						.filter(s => !(LORA_PRESETS as readonly string[]).includes(s)),
					preset => {
						const opts = validOptions({ preset })
						expect(() => parseLoraMeshtasticOptions(opts)).toThrow(
							ConfigValidationError,
						)
					},
				),
				{ numRuns: 100 },
			)
		})
	})

	describe("Property 8: preset to params mapping fixed-point", () => {
		// Feature: lora-meshtastic, Property 8: Preset to (bw,sf,cr) fixed-point
		// Validates: Requirements 1.5, 4.6
		it("resolves every preset to the canonical (bw, sf, cr)", () => {
			fc.assert(
				fc.property(fc.constantFrom(...LORA_PRESETS), preset => {
					const expected = PRESET_TABLE[preset]
					const resolved = parseLoraMeshtasticOptions(validOptions({ preset }))
					expect(resolved.bw).toBe(expected.bw)
					expect(resolved.sf).toBe(expected.sf)
					expect(resolved.cr).toBe(expected.cr)
				}),
				{ numRuns: 100 },
			)
		})

		it("LORA_MESHTASTIC_CAPS matches the spec contract", () => {
			expect(LORA_MESHTASTIC_CAPS.input).toBe("iq")
			expect(LORA_MESHTASTIC_CAPS.wantsExclusiveSource).toBe(false)
			expect(LORA_MESHTASTIC_CAPS.output).toBe("jsonl")
			expect(LORA_MESHTASTIC_CAPS.integrationPattern).toBe("pure_consumer")
		})
	})
})
