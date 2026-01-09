/**
 * VDL2 Decoder Unit Tests
 *
 * Tests for the Dumpvdl2Decoder class.
 * Requirements: 24.1, 24.2, 24.3, 24.4
 *
 * Property 35: VDL2 Output Parsing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { PassThrough } from "node:stream"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import {
	Dumpvdl2Decoder,
	parseDumpvdl2Json,
	createDumpvdl2Decoder,
	DUMPVDL2_CAPS,
} from "../../../src/decoders/builtin/dumpvdl2.js"
import pino from "pino"

// Create a silent logger for tests
const testLogger = pino({ level: "silent" })

/**
 * Creates a test decoder config with optional overrides.
 */
function createConfig(overrides: Partial<DecoderConfig> = {}): DecoderConfig {
	return {
		id: "test-dumpvdl2",
		type: "dumpvdl2",
		enabled: true,
		deviceSerial: "00000001",
		frequencies: [136_650_000, 136_700_000, 136_975_000],
		options: {
			outputFormat: "json",
			...overrides.options,
		},
		...overrides,
	}
}

describe("Dumpvdl2Decoder", () => {
	let decoder: Dumpvdl2Decoder

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
			const config = createConfig({ id: "my-dumpvdl2", type: "dumpvdl2" })
			decoder = new Dumpvdl2Decoder(config, testLogger)

			expect(decoder.id).toBe("my-dumpvdl2")
			expect(decoder.type).toBe("dumpvdl2")
		})

		it("should use default frequencies when not specified", () => {
			const config = createConfig({
				frequencies: undefined,
				options: {},
			})
			decoder = new Dumpvdl2Decoder(config, testLogger)

			// Should use default VDL2 frequencies
			expect((decoder as any).options.frequencies).toEqual([
				136_650_000, 136_700_000, 136_975_000,
			])
		})

		it("should use configured frequencies (Requirement 24.4)", () => {
			const config = createConfig({
				frequencies: [136_650_000, 136_700_000],
			})
			decoder = new Dumpvdl2Decoder(config, testLogger)

			expect((decoder as any).options.frequencies).toEqual([
				136_650_000, 136_700_000,
			])
		})

		it("should use configured device serial (Requirement 24.1)", () => {
			const config = createConfig({
				deviceSerial: "RTLSDR001",
			})
			decoder = new Dumpvdl2Decoder(config, testLogger)

			expect((decoder as any).options.deviceSerial).toBe("RTLSDR001")
		})
	})

	describe("getCaps", () => {
		it("should return correct capabilities", () => {
			const config = createConfig()
			decoder = new Dumpvdl2Decoder(config, testLogger)

			expect(decoder.caps).toEqual({
				input: "iq",
				wantsExclusiveSource: false,
				output: "jsonl",
				integrationPattern: "pure_consumer",
			})
		})
	})

	describe("getStatus", () => {
		it("should return status with all required fields when not running", () => {
			const config = createConfig()
			decoder = new Dumpvdl2Decoder(config, testLogger)
			const status = decoder.getStatus()

			expect(status.id).toBe("test-dumpvdl2")
			expect(status.type).toBe("dumpvdl2")
			expect(status.running).toBe(false)
			expect(status.health).toBe("running")
			expect(status.pid).toBeUndefined()
			expect(status.uptime).toBe(0)
			expect(status.stats).toEqual({ bytesIn: 0, eventsOut: 0, errors: 0 })
			expect(status.restartCount).toBe(0)
		})
	})

	describe("attachInput/detachInput", () => {
		it("should accept an IQ stream without throwing", () => {
			const config = createConfig()
			decoder = new Dumpvdl2Decoder(config, testLogger)
			const iqStream = new PassThrough()

			// These should not throw
			expect(() => decoder.attachInput(iqStream as any)).not.toThrow()
			expect(() => decoder.detachInput()).not.toThrow()
		})
	})

	describe("getAudioOutput", () => {
		it("should return null (VDL2 decoder does not produce audio)", () => {
			const config = createConfig()
			decoder = new Dumpvdl2Decoder(config, testLogger)

			expect(decoder.getAudioOutput()).toBeNull()
		})
	})
})

describe("parseDumpvdl2Json", () => {
	it("should parse a valid JSON message with all fields", () => {
		const json = {
			vdl2: {
				t: {
					sec: 1704067200, // 2024-01-01 00:00:00 UTC
					usec: 500000,
				},
				freq: 136_650_000,
				sig_level: -25.5,
				noise_level: -45.0,
				station: "GROUND1",
				avlc: {
					src: {
						addr: "ABC123",
						type: "aircraft",
						status: "airborne",
					},
					dst: {
						addr: "GROUND1",
						type: "ground",
					},
					cr: "command",
					frame_type: "I",
					rseq: 1,
					sseq: 2,
					poll: false,
					final: false,
					acars: {
						err: false,
						crc_ok: true,
						more: false,
						reg: "N12345",
						mode: "2",
						label: "H1",
						blk_id: "A",
						ack: "!",
						flight: "UAL123",
						msg_num: "M01",
						msg_num_seq: "A",
						msg_text: "TEST MESSAGE",
					},
				},
			},
		}

		const result = parseDumpvdl2Json(json)

		expect(result).not.toBeNull()
		expect(result?.frequency).toBe(136_650_000)
		expect(result?.station).toBe("GROUND1")
		expect(result?.icao).toBe("ABC123")
		expect(result?.toaddr).toBe("GROUND1")
		expect(result?.fromaddr).toBe("ABC123")
		expect(result?.msgType).toBe("acars")
		expect(result?.level).toBe(-25.5)
		expect(result?.noiseFloor).toBe(-45.0)
		expect(result?.frameType).toBe("I")

		// Check embedded ACARS
		expect(result?.acars).not.toBeUndefined()
		expect(result?.acars?.tail).toBe("N12345")
		expect(result?.acars?.mode).toBe("2")
		expect(result?.acars?.label).toBe("H1")
		expect(result?.acars?.flight).toBe("UAL123")
		expect(result?.acars?.text).toBe("TEST MESSAGE")
	})

	it("should parse a message with minimal fields", () => {
		const json = {
			vdl2: {
				freq: 136_700_000,
			},
		}

		const result = parseDumpvdl2Json(json)

		expect(result).not.toBeNull()
		expect(result?.frequency).toBe(136_700_000)
		expect(result?.msgType).toBe("unknown")
		expect(result?.timestamp).toBeInstanceOf(Date)
	})

	it("should return null when vdl2 field is missing", () => {
		const json = {
			timestamp: 1704067200,
			freq: 136_650_000,
		}

		const result = parseDumpvdl2Json(json as any)

		expect(result).toBeNull()
	})

	it("should parse XID messages", () => {
		const json = {
			vdl2: {
				freq: 136_975_000,
				avlc: {
					src: { addr: "ABC123" },
					dst: { addr: "GROUND1" },
					frame_type: "XID",
					xid: {
						type: "GSIF",
						type_descr: "Ground Station Information Frame",
						params: { airport: "KJFK" },
					},
				},
			},
		}

		const result = parseDumpvdl2Json(json)

		expect(result).not.toBeNull()
		expect(result?.msgType).toBe("Ground Station Information Frame")
		expect(result?.frameType).toBe("XID")
	})

	it("should use frame_type as msgType when no acars or xid", () => {
		const json = {
			vdl2: {
				freq: 136_650_000,
				avlc: {
					src: { addr: "ABC123" },
					dst: { addr: "GROUND1" },
					frame_type: "UI",
				},
			},
		}

		const result = parseDumpvdl2Json(json)

		expect(result).not.toBeNull()
		expect(result?.msgType).toBe("UI")
	})

	it("should handle timestamp with sec/usec fields", () => {
		const json = {
			vdl2: {
				t: {
					sec: 1704067200,
					usec: 500000,
				},
				freq: 136_650_000,
			},
		}

		const result = parseDumpvdl2Json(json)

		expect(result).not.toBeNull()
		expect(result?.timestamp).toBeInstanceOf(Date)
		// 1704067200 * 1000 + 500000 / 1000 = 1704067200500
		expect(result?.timestamp.getTime()).toBe(1704067200500)
	})

	it("should use current time when timestamp is missing", () => {
		const before = new Date()
		const json = {
			vdl2: {
				freq: 136_650_000,
			},
		}
		const result = parseDumpvdl2Json(json)
		const after = new Date()

		expect(result).not.toBeNull()
		expect(result?.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
		expect(result?.timestamp.getTime()).toBeLessThanOrEqual(after.getTime())
	})
})

describe("createDumpvdl2Decoder", () => {
	it("should create a Dumpvdl2Decoder instance", () => {
		const config = createConfig()
		const decoder = createDumpvdl2Decoder(config, testLogger)

		expect(decoder).toBeInstanceOf(Dumpvdl2Decoder)
		expect(decoder.id).toBe("test-dumpvdl2")
	})
})

describe("DUMPVDL2_CAPS", () => {
	it("should have correct capabilities", () => {
		expect(DUMPVDL2_CAPS).toEqual({
			input: "iq",
			wantsExclusiveSource: false,
			output: "jsonl",
			integrationPattern: "pure_consumer",
		})
	})
})

/**
 * Arbitrary generators for property-based testing
 */

/**
 * Arbitrary for generating valid VDL2 frequencies in Hz.
 * Common VDL2 frequencies are in the 136 MHz range.
 */
const frequencyHzArb = fc.constantFrom(
	136_650_000,
	136_700_000,
	136_725_000,
	136_775_000,
	136_800_000,
	136_825_000,
	136_875_000,
	136_900_000,
	136_975_000,
)

/**
 * Arbitrary for generating Unix timestamps (recent).
 */
const timestampSecArb = fc.integer({
	min: 1704067200, // 2024-01-01
	max: 1735689600, // 2025-01-01
})

/**
 * Arbitrary for generating microseconds.
 */
const timestampUsecArb = fc.integer({ min: 0, max: 999999 })

/**
 * Arbitrary for generating signal levels in dB (-50 to 0).
 */
const signalLevelArb = fc.double({
	min: -50,
	max: 0,
	noNaN: true,
	noDefaultInfinity: true,
})

/**
 * Arbitrary for generating noise levels in dB (-60 to -30).
 */
const noiseLevelArb = fc.double({
	min: -60,
	max: -30,
	noNaN: true,
	noDefaultInfinity: true,
})

/**
 * Arbitrary for generating ICAO addresses (6 hex characters).
 */
const icaoAddrArb = fc.stringMatching(/^[A-F0-9]{6}$/)

/**
 * Arbitrary for generating ground station identifiers.
 */
const stationArb = fc.stringMatching(/^[A-Z0-9]{4,8}$/)

/**
 * Arbitrary for generating frame types.
 */
const frameTypeArb = fc.constantFrom("I", "S", "U", "UI", "XID", "DISC", "DM")

/**
 * Arbitrary for generating ACARS mode characters.
 */
const acarsModeArb = fc.constantFrom("2", "X", "H", "Q")

/**
 * Arbitrary for generating ACARS labels (2 characters).
 */
const acarsLabelArb = fc.stringMatching(/^[A-Z0-9_]{2}$/)

/**
 * Arbitrary for generating aircraft tail numbers.
 */
const tailArb = fc.stringMatching(/^[A-Z]-?[A-Z0-9]{2,5}$/)

/**
 * Arbitrary for generating flight numbers.
 */
const flightArb = fc.stringMatching(/^[A-Z]{2,3}[0-9]{1,4}$/)

/**
 * Arbitrary for generating message text.
 */
const textArb = fc.string({ minLength: 0, maxLength: 220 })

/**
 * Arbitrary for generating XID type descriptions.
 */
const xidTypeDescrArb = fc.constantFrom(
	"Ground Station Information Frame",
	"Link Connection Request",
	"Link Connection Response",
	"Link Disconnect Request",
)

/**
 * Arbitrary for generating embedded ACARS data.
 */
const acarsEmbeddedArb = fc.record({
	err: fc.option(fc.boolean(), { nil: undefined }),
	crc_ok: fc.option(fc.boolean(), { nil: undefined }),
	more: fc.option(fc.boolean(), { nil: undefined }),
	reg: fc.option(tailArb, { nil: undefined }),
	mode: fc.option(acarsModeArb, { nil: undefined }),
	label: fc.option(acarsLabelArb, { nil: undefined }),
	blk_id: fc.option(fc.stringMatching(/^[A-Z0-9]$/), { nil: undefined }),
	ack: fc.option(fc.constantFrom("!", "NAK"), { nil: undefined }),
	flight: fc.option(flightArb, { nil: undefined }),
	msg_num: fc.option(fc.stringMatching(/^[A-Z][0-9]{2}$/), { nil: undefined }),
	msg_num_seq: fc.option(fc.stringMatching(/^[A-Z]$/), { nil: undefined }),
	msg_text: fc.option(textArb, { nil: undefined }),
})

/**
 * Arbitrary for generating XID data.
 */
const xidDataArb = fc.record({
	type: fc.option(fc.constantFrom("GSIF", "LCR", "LCM", "LDR"), {
		nil: undefined,
	}),
	type_descr: fc.option(xidTypeDescrArb, { nil: undefined }),
	params: fc.option(fc.record({ airport: fc.stringMatching(/^[A-Z]{4}$/) }), {
		nil: undefined,
	}),
})

/**
 * Arbitrary for generating AVLC frame data.
 */
const avlcArb = fc.record({
	src: fc.option(
		fc.record({
			addr: icaoAddrArb,
			type: fc.option(fc.constantFrom("aircraft", "ground"), {
				nil: undefined,
			}),
			status: fc.option(fc.constantFrom("airborne", "on_ground"), {
				nil: undefined,
			}),
		}),
		{ nil: undefined },
	),
	dst: fc.option(
		fc.record({
			addr: fc.oneof(icaoAddrArb, stationArb),
			type: fc.option(fc.constantFrom("aircraft", "ground"), {
				nil: undefined,
			}),
		}),
		{ nil: undefined },
	),
	cr: fc.option(fc.constantFrom("command", "response"), { nil: undefined }),
	frame_type: fc.option(frameTypeArb, { nil: undefined }),
	rseq: fc.option(fc.integer({ min: 0, max: 7 }), { nil: undefined }),
	sseq: fc.option(fc.integer({ min: 0, max: 7 }), { nil: undefined }),
	poll: fc.option(fc.boolean(), { nil: undefined }),
	final: fc.option(fc.boolean(), { nil: undefined }),
	acars: fc.option(acarsEmbeddedArb, { nil: undefined }),
	xid: fc.option(xidDataArb, { nil: undefined }),
})

/**
 * Arbitrary for generating valid dumpvdl2 JSON output with all fields.
 */
const dumpvdl2JsonArb = fc.record({
	vdl2: fc.record({
		t: fc.option(
			fc.record({
				sec: timestampSecArb,
				usec: fc.option(timestampUsecArb, { nil: undefined }),
			}),
			{ nil: undefined },
		),
		freq: frequencyHzArb,
		sig_level: fc.option(signalLevelArb, { nil: undefined }),
		noise_level: fc.option(noiseLevelArb, { nil: undefined }),
		station: fc.option(stationArb, { nil: undefined }),
		avlc: fc.option(avlcArb, { nil: undefined }),
	}),
})

/**
 * Arbitrary for generating dumpvdl2 JSON with ACARS content.
 */
const dumpvdl2JsonWithAcarsArb = fc.record({
	vdl2: fc.record({
		t: fc.option(
			fc.record({
				sec: timestampSecArb,
				usec: fc.option(timestampUsecArb, { nil: undefined }),
			}),
			{ nil: undefined },
		),
		freq: frequencyHzArb,
		sig_level: fc.option(signalLevelArb, { nil: undefined }),
		noise_level: fc.option(noiseLevelArb, { nil: undefined }),
		station: fc.option(stationArb, { nil: undefined }),
		avlc: fc.record({
			src: fc.record({
				addr: icaoAddrArb,
				type: fc.option(fc.constantFrom("aircraft", "ground"), {
					nil: undefined,
				}),
			}),
			dst: fc.record({
				addr: fc.oneof(icaoAddrArb, stationArb),
				type: fc.option(fc.constantFrom("aircraft", "ground"), {
					nil: undefined,
				}),
			}),
			frame_type: fc.option(frameTypeArb, { nil: undefined }),
			acars: acarsEmbeddedArb,
		}),
	}),
})

describe("VDL2 Decoder Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 35: VDL2 Output Parsing
	 * Validates: Requirements 24.2
	 *
	 * For any valid dumpvdl2 JSON output line, the parser should produce
	 * a DecoderOutput object with type: 'vdl2' and a VDL2Message object
	 * containing timestamp, frequency, and message type.
	 */
	describe("Property 35: VDL2 Output Parsing", () => {
		it("should parse any valid dumpvdl2 JSON into VDL2Message with required fields", () => {
			fc.assert(
				fc.property(dumpvdl2JsonArb, json => {
					const result = parseDumpvdl2Json(json as any)

					// Should produce a valid VDL2Message
					expect(result).not.toBeNull()

					// Must contain timestamp
					expect(result!.timestamp).toBeInstanceOf(Date)

					// Must contain frequency
					expect(typeof result!.frequency).toBe("number")
					expect(result!.frequency).toBeGreaterThanOrEqual(0)

					// Frequency should match input
					expect(result!.frequency).toBe(json.vdl2.freq)

					// Must have msgType
					expect(typeof result!.msgType).toBe("string")
					expect(result!.msgType.length).toBeGreaterThan(0)

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should parse JSON with ACARS content and extract embedded message", () => {
			fc.assert(
				fc.property(dumpvdl2JsonWithAcarsArb, json => {
					const result = parseDumpvdl2Json(json as any)

					// Should produce a valid VDL2Message
					expect(result).not.toBeNull()

					// Must contain timestamp
					expect(result!.timestamp).toBeInstanceOf(Date)

					// Must contain frequency
					expect(result!.frequency).toBe(json.vdl2.freq)

					// Message type should be 'acars' when ACARS is present
					expect(result!.msgType).toBe("acars")

					// Should have embedded ACARS message
					expect(result!.acars).not.toBeUndefined()

					// ACARS message should have required fields
					expect(result!.acars!.timestamp).toBeInstanceOf(Date)
					expect(typeof result!.acars!.frequency).toBe("number")
					expect(typeof result!.acars!.channel).toBe("number")
					expect(typeof result!.acars!.level).toBe("number")
					expect(typeof result!.acars!.error).toBe("number")
					expect(typeof result!.acars!.mode).toBe("string")
					expect(typeof result!.acars!.label).toBe("string")

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should extract source and destination addresses from AVLC frame", () => {
			fc.assert(
				fc.property(
					fc.record({
						vdl2: fc.record({
							freq: frequencyHzArb,
							avlc: fc.record({
								src: fc.record({
									addr: icaoAddrArb,
								}),
								dst: fc.record({
									addr: fc.oneof(icaoAddrArb, stationArb),
								}),
								frame_type: frameTypeArb,
							}),
						}),
					}),
					json => {
						const result = parseDumpvdl2Json(json as any)

						expect(result).not.toBeNull()

						// Should extract addresses
						expect(result!.icao).toBe(json.vdl2.avlc.src.addr)
						expect(result!.fromaddr).toBe(json.vdl2.avlc.src.addr)
						expect(result!.toaddr).toBe(json.vdl2.avlc.dst.addr)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should handle timestamp with sec/usec correctly", () => {
			fc.assert(
				fc.property(
					fc.record({
						vdl2: fc.record({
							t: fc.record({
								sec: timestampSecArb,
								usec: timestampUsecArb,
							}),
							freq: frequencyHzArb,
						}),
					}),
					json => {
						const result = parseDumpvdl2Json(json as any)

						expect(result).not.toBeNull()

						// Timestamp should be converted correctly
						// Note: usec/1000 may have floating point precision issues,
						// and Date.getTime() returns integer ms, so allow ±1ms tolerance
						const expectedMs = json.vdl2.t.sec * 1000 + json.vdl2.t.usec / 1000
						const actualMs = result!.timestamp.getTime()
						expect(Math.abs(actualMs - expectedMs)).toBeLessThanOrEqual(1)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should preserve signal and noise levels when present", () => {
			fc.assert(
				fc.property(
					fc.record({
						vdl2: fc.record({
							freq: frequencyHzArb,
							sig_level: signalLevelArb,
							noise_level: noiseLevelArb,
						}),
					}),
					json => {
						const result = parseDumpvdl2Json(json as any)

						expect(result).not.toBeNull()
						expect(result!.level).toBe(json.vdl2.sig_level)
						expect(result!.noiseFloor).toBe(json.vdl2.noise_level)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return null for JSON without vdl2 field", () => {
			fc.assert(
				fc.property(
					fc.record({
						timestamp: fc.option(timestampSecArb, { nil: undefined }),
						freq: fc.option(frequencyHzArb, { nil: undefined }),
						station: fc.option(stationArb, { nil: undefined }),
					}),
					json => {
						// Ensure no vdl2 field
						const result = parseDumpvdl2Json(json as any)
						return result === null
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should produce VDL2Message with all required fields for any valid input", () => {
			fc.assert(
				fc.property(dumpvdl2JsonArb, json => {
					const result = parseDumpvdl2Json(json as any)

					// All valid inputs should produce VDL2Message
					expect(result).not.toBeNull()

					// Verify required fields exist and have correct types
					expect(result).toHaveProperty("timestamp")
					expect(result).toHaveProperty("frequency")
					expect(result).toHaveProperty("msgType")

					// timestamp must be a Date
					expect(result!.timestamp).toBeInstanceOf(Date)

					// frequency must be a number
					expect(typeof result!.frequency).toBe("number")

					// msgType must be a non-empty string
					expect(typeof result!.msgType).toBe("string")
					expect(result!.msgType.length).toBeGreaterThan(0)

					return true
				}),
				{ numRuns: 100 },
			)
		})

		it("should determine msgType based on frame content", () => {
			// Test with XID frame
			fc.assert(
				fc.property(
					fc.record({
						vdl2: fc.record({
							freq: frequencyHzArb,
							avlc: fc.record({
								src: fc.record({ addr: icaoAddrArb }),
								dst: fc.record({ addr: stationArb }),
								frame_type: fc.constant("XID"),
								xid: fc.record({
									type: fc.constantFrom("GSIF", "LCR"),
									type_descr: xidTypeDescrArb,
								}),
							}),
						}),
					}),
					json => {
						const result = parseDumpvdl2Json(json as any)

						expect(result).not.toBeNull()
						// msgType should be the XID type description
						expect(result!.msgType).toBe(json.vdl2.avlc.xid.type_descr)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})
	})
})
