/**
 * Aviation Data Link Fixtures Tests
 *
 * Tests to verify that ACARS and VDL2 test fixtures load correctly
 * and contain valid data for CI testing.
 */

import { describe, it, expect } from "vitest"

// ACARS fixtures
import {
	loadJsonSample as loadAcarsJsonSample,
	loadJsonSampleRaw as loadAcarsJsonSampleRaw,
	SAMPLE_TAIL_NUMBERS as ACARS_TAIL_NUMBERS,
	SAMPLE_FLIGHT_NUMBERS as ACARS_FLIGHT_NUMBERS,
	SAMPLE_FREQUENCIES_MHZ as ACARS_FREQUENCIES_MHZ,
	SAMPLE_FREQUENCIES_HZ as ACARS_FREQUENCIES_HZ,
	EXPECTED_ACARS_MESSAGES,
	SAMPLE_ACARS_MESSAGES,
	RECORDING_SOURCE_CONFIG as ACARS_RECORDING_CONFIG,
} from "../../mocks/fixtures/acars/index.js"

// VDL2 fixtures
import {
	loadJsonSample as loadVdl2JsonSample,
	loadJsonSampleRaw as loadVdl2JsonSampleRaw,
	SAMPLE_ICAO_ADDRESSES as VDL2_ICAO_ADDRESSES,
	SAMPLE_STATIONS as VDL2_STATIONS,
	SAMPLE_FREQUENCIES_HZ as VDL2_FREQUENCIES_HZ,
	SAMPLE_TAIL_NUMBERS as VDL2_TAIL_NUMBERS,
	SAMPLE_FLIGHT_NUMBERS as VDL2_FLIGHT_NUMBERS,
	EXPECTED_VDL2_MESSAGES,
	SAMPLE_VDL2_MESSAGES,
	SAMPLE_VDL2_WITH_ACARS,
	RECORDING_SOURCE_CONFIG as VDL2_RECORDING_CONFIG,
} from "../../mocks/fixtures/vdl2/index.js"

// Import parsers to verify fixtures work with actual decoders
import { parseAcarsdecJson } from "../../../src/decoders/builtin/acarsdec.js"
import { parseDumpvdl2Json } from "../../../src/decoders/builtin/dumpvdl2.js"

describe("ACARS Test Fixtures", () => {
	describe("loadJsonSample", () => {
		it("should load JSON sample as array of objects", () => {
			const messages = loadAcarsJsonSample()

			expect(Array.isArray(messages)).toBe(true)
			expect(messages.length).toBeGreaterThan(0)
		})

		it("should contain valid ACARS message objects", () => {
			const messages = loadAcarsJsonSample()

			for (const msg of messages) {
				// All messages should have freq field
				expect(msg.freq).toBeDefined()
				expect(typeof msg.freq).toBe("number")
			}
		})

		it("should be parseable by the ACARS decoder", () => {
			const messages = loadAcarsJsonSample()

			for (const msg of messages) {
				const parsed = parseAcarsdecJson(msg)
				expect(parsed).not.toBeNull()
				expect(parsed?.timestamp).toBeInstanceOf(Date)
				expect(parsed?.frequency).toBeGreaterThan(0)
			}
		})
	})

	describe("loadJsonSampleRaw", () => {
		it("should load raw JSONL text", () => {
			const raw = loadAcarsJsonSampleRaw()

			expect(typeof raw).toBe("string")
			expect(raw.length).toBeGreaterThan(0)
		})

		it("should contain valid JSON lines", () => {
			const raw = loadAcarsJsonSampleRaw()
			const lines = raw.split("\n").filter(line => line.trim())

			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow()
			}
		})
	})

	describe("Sample constants", () => {
		it("should have valid tail numbers", () => {
			expect(ACARS_TAIL_NUMBERS.length).toBeGreaterThan(0)
			for (const tail of ACARS_TAIL_NUMBERS) {
				expect(typeof tail).toBe("string")
				expect(tail.length).toBeGreaterThan(0)
			}
		})

		it("should have valid flight numbers", () => {
			expect(ACARS_FLIGHT_NUMBERS.length).toBeGreaterThan(0)
			for (const flight of ACARS_FLIGHT_NUMBERS) {
				expect(typeof flight).toBe("string")
				expect(flight.length).toBeGreaterThan(0)
			}
		})

		it("should have valid frequencies in MHz", () => {
			expect(ACARS_FREQUENCIES_MHZ.length).toBeGreaterThan(0)
			for (const freq of ACARS_FREQUENCIES_MHZ) {
				expect(freq).toBeGreaterThan(100)
				expect(freq).toBeLessThan(200)
			}
		})

		it("should have valid frequencies in Hz", () => {
			expect(ACARS_FREQUENCIES_HZ.length).toBeGreaterThan(0)
			for (const freq of ACARS_FREQUENCIES_HZ) {
				expect(freq).toBeGreaterThan(100_000_000)
				expect(freq).toBeLessThan(200_000_000)
			}
		})
	})

	describe("EXPECTED_ACARS_MESSAGES", () => {
		it("should contain expected message metadata", () => {
			expect(EXPECTED_ACARS_MESSAGES.length).toBeGreaterThan(0)

			for (const expected of EXPECTED_ACARS_MESSAGES) {
				expect(expected.tail).toBeDefined()
				expect(expected.flight).toBeDefined()
				expect(expected.frequency).toBeGreaterThan(0)
				expect(expected.label).toBeDefined()
				expect(expected.mode).toBeDefined()
			}
		})
	})

	describe("SAMPLE_ACARS_MESSAGES", () => {
		it("should contain complete message objects", () => {
			expect(SAMPLE_ACARS_MESSAGES.length).toBeGreaterThan(0)

			for (const msg of SAMPLE_ACARS_MESSAGES) {
				expect(msg.timestamp).toBeDefined()
				expect(msg.freq).toBeDefined()
				expect(msg.tail).toBeDefined()
				expect(msg.flight).toBeDefined()
			}
		})

		it("should be parseable by the ACARS decoder", () => {
			for (const msg of SAMPLE_ACARS_MESSAGES) {
				const parsed = parseAcarsdecJson(msg)
				expect(parsed).not.toBeNull()
			}
		})
	})

	describe("RECORDING_SOURCE_CONFIG", () => {
		it("should have valid recording source configuration", () => {
			expect(ACARS_RECORDING_CONFIG.id).toBe("test-acars-json")
			expect(ACARS_RECORDING_CONFIG.type).toBe("recording")
			expect(ACARS_RECORDING_CONFIG.filePath).toContain("json-sample.jsonl")
			expect(ACARS_RECORDING_CONFIG.caps.kind).toBe("recording")
		})
	})
})

describe("VDL2 Test Fixtures", () => {
	describe("loadJsonSample", () => {
		it("should load JSON sample as array of objects", () => {
			const messages = loadVdl2JsonSample()

			expect(Array.isArray(messages)).toBe(true)
			expect(messages.length).toBeGreaterThan(0)
		})

		it("should contain valid VDL2 message objects", () => {
			const messages = loadVdl2JsonSample()

			for (const msg of messages) {
				// All messages should have vdl2 field
				expect(msg.vdl2).toBeDefined()
				expect(msg.vdl2?.freq).toBeDefined()
				expect(typeof msg.vdl2?.freq).toBe("number")
			}
		})

		it("should be parseable by the VDL2 decoder", () => {
			const messages = loadVdl2JsonSample()

			for (const msg of messages) {
				const parsed = parseDumpvdl2Json(msg)
				expect(parsed).not.toBeNull()
				expect(parsed?.timestamp).toBeInstanceOf(Date)
				expect(parsed?.frequency).toBeGreaterThanOrEqual(0)
				expect(parsed?.msgType).toBeDefined()
			}
		})
	})

	describe("loadJsonSampleRaw", () => {
		it("should load raw JSONL text", () => {
			const raw = loadVdl2JsonSampleRaw()

			expect(typeof raw).toBe("string")
			expect(raw.length).toBeGreaterThan(0)
		})

		it("should contain valid JSON lines", () => {
			const raw = loadVdl2JsonSampleRaw()
			const lines = raw.split("\n").filter(line => line.trim())

			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow()
			}
		})
	})

	describe("Sample constants", () => {
		it("should have valid ICAO addresses", () => {
			expect(VDL2_ICAO_ADDRESSES.length).toBeGreaterThan(0)
			for (const addr of VDL2_ICAO_ADDRESSES) {
				expect(typeof addr).toBe("string")
				expect(addr.length).toBe(6)
				expect(/^[A-F0-9]{6}$/.test(addr)).toBe(true)
			}
		})

		it("should have valid station identifiers", () => {
			expect(VDL2_STATIONS.length).toBeGreaterThan(0)
			for (const station of VDL2_STATIONS) {
				expect(typeof station).toBe("string")
				expect(station.length).toBe(4)
			}
		})

		it("should have valid frequencies in Hz", () => {
			expect(VDL2_FREQUENCIES_HZ.length).toBeGreaterThan(0)
			for (const freq of VDL2_FREQUENCIES_HZ) {
				expect(freq).toBeGreaterThan(130_000_000)
				expect(freq).toBeLessThan(140_000_000)
			}
		})

		it("should have valid tail numbers", () => {
			expect(VDL2_TAIL_NUMBERS.length).toBeGreaterThan(0)
			for (const tail of VDL2_TAIL_NUMBERS) {
				expect(typeof tail).toBe("string")
				expect(tail.length).toBeGreaterThan(0)
			}
		})

		it("should have valid flight numbers", () => {
			expect(VDL2_FLIGHT_NUMBERS.length).toBeGreaterThan(0)
			for (const flight of VDL2_FLIGHT_NUMBERS) {
				expect(typeof flight).toBe("string")
				expect(flight.length).toBeGreaterThan(0)
			}
		})
	})

	describe("EXPECTED_VDL2_MESSAGES", () => {
		it("should contain expected message metadata", () => {
			expect(EXPECTED_VDL2_MESSAGES.length).toBeGreaterThan(0)

			for (const expected of EXPECTED_VDL2_MESSAGES) {
				expect(expected.icao).toBeDefined()
				expect(expected.frequency).toBeGreaterThan(0)
				expect(expected.msgType).toBeDefined()
			}
		})
	})

	describe("SAMPLE_VDL2_MESSAGES", () => {
		it("should contain complete message objects", () => {
			expect(SAMPLE_VDL2_MESSAGES.length).toBeGreaterThan(0)

			for (const msg of SAMPLE_VDL2_MESSAGES) {
				expect(msg.vdl2).toBeDefined()
				expect(msg.vdl2?.freq).toBeDefined()
				expect(msg.vdl2?.avlc).toBeDefined()
			}
		})

		it("should be parseable by the VDL2 decoder", () => {
			for (const msg of SAMPLE_VDL2_MESSAGES) {
				const parsed = parseDumpvdl2Json(msg)
				expect(parsed).not.toBeNull()
			}
		})
	})

	describe("SAMPLE_VDL2_WITH_ACARS", () => {
		it("should contain VDL2 messages with embedded ACARS", () => {
			expect(SAMPLE_VDL2_WITH_ACARS.length).toBeGreaterThan(0)

			for (const msg of SAMPLE_VDL2_WITH_ACARS) {
				expect(msg.vdl2?.avlc?.acars).toBeDefined()
			}
		})

		it("should parse with embedded ACARS data", () => {
			for (const msg of SAMPLE_VDL2_WITH_ACARS) {
				const parsed = parseDumpvdl2Json(msg)
				expect(parsed).not.toBeNull()
				expect(parsed?.msgType).toBe("acars")
				expect(parsed?.acars).toBeDefined()
				expect(parsed?.acars?.tail).toBeDefined()
			}
		})
	})

	describe("RECORDING_SOURCE_CONFIG", () => {
		it("should have valid recording source configuration", () => {
			expect(VDL2_RECORDING_CONFIG.id).toBe("test-vdl2-json")
			expect(VDL2_RECORDING_CONFIG.type).toBe("recording")
			expect(VDL2_RECORDING_CONFIG.filePath).toContain("json-sample.jsonl")
			expect(VDL2_RECORDING_CONFIG.caps.kind).toBe("recording")
		})
	})
})

describe("Cross-fixture validation", () => {
	it("should have consistent frequency ranges between ACARS and VDL2", () => {
		// ACARS frequencies are typically 129-137 MHz
		for (const freq of ACARS_FREQUENCIES_HZ) {
			expect(freq).toBeGreaterThanOrEqual(129_000_000)
			expect(freq).toBeLessThanOrEqual(137_000_000)
		}

		// VDL2 frequencies are typically 136 MHz range
		for (const freq of VDL2_FREQUENCIES_HZ) {
			expect(freq).toBeGreaterThanOrEqual(136_000_000)
			expect(freq).toBeLessThanOrEqual(137_000_000)
		}
	})

	it("should have unique identifiers in each fixture set", () => {
		// ACARS tail numbers should be unique
		const acarsTails = new Set(ACARS_TAIL_NUMBERS)
		expect(acarsTails.size).toBe(ACARS_TAIL_NUMBERS.length)

		// VDL2 ICAO addresses should be unique
		const vdl2Icaos = new Set(VDL2_ICAO_ADDRESSES)
		expect(vdl2Icaos.size).toBe(VDL2_ICAO_ADDRESSES.length)
	})
})
