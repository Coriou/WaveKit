/**
 * ADS-B Test Fixtures Verification Tests
 *
 * Verifies that the ADS-B test fixtures are valid and can be loaded correctly.
 * These tests ensure the fixtures are usable for CI testing.
 */

import { describe, it, expect } from "vitest"
import {
	loadSbsSample,
	loadSbsSampleRaw,
	loadJsonSample,
	loadJsonSampleRaw,
	loadBeastSample,
	SAMPLE_ICAO_ADDRESSES,
	EXPECTED_SBS_AIRCRAFT,
	EXPECTED_JSON_AIRCRAFT,
	RECORDING_SOURCE_CONFIGS,
} from "../../mocks/fixtures/adsb/index.js"
import {
	parseSbsLine,
	parseJsonAircraft,
	parseBeastMessage,
} from "../../../src/decoders/builtin/readsb.js"

describe("ADS-B Test Fixtures", () => {
	describe("SBS Sample Data", () => {
		it("should load SBS sample lines", () => {
			const lines = loadSbsSample()

			expect(lines.length).toBeGreaterThan(0)
			// Should filter out comments
			expect(lines.every(line => !line.startsWith("#"))).toBe(true)
		})

		it("should load raw SBS sample", () => {
			const raw = loadSbsSampleRaw()

			expect(raw.length).toBeGreaterThan(0)
			expect(raw).toContain("MSG,")
		})

		it("should contain valid SBS messages that can be parsed", () => {
			const lines = loadSbsSample()
			let parsedCount = 0

			for (const line of lines) {
				const result = parseSbsLine(line)
				if (result) {
					parsedCount++
					// Verify ICAO is valid hex
					expect(result.icao).toMatch(/^[A-F0-9]{6}$/)
				}
			}

			// At least some lines should parse successfully
			expect(parsedCount).toBeGreaterThan(0)
		})

		it("should contain expected aircraft data", () => {
			const lines = loadSbsSample()
			const parsed = lines.map(parseSbsLine).filter(Boolean)

			// Check that expected ICAO addresses are present
			const icaos = new Set(parsed.map(a => a!.icao))
			for (const expected of EXPECTED_SBS_AIRCRAFT) {
				expect(icaos.has(expected.icao)).toBe(true)
			}
		})
	})

	describe("JSON Sample Data", () => {
		it("should load JSON sample objects", () => {
			const objects = loadJsonSample()

			expect(objects.length).toBeGreaterThan(0)
			expect(objects.every(obj => typeof obj === "object")).toBe(true)
		})

		it("should load raw JSON sample", () => {
			const raw = loadJsonSampleRaw()

			expect(raw.length).toBeGreaterThan(0)
			expect(raw).toContain('"hex"')
		})

		it("should contain valid JSON aircraft that can be parsed", () => {
			const objects = loadJsonSample()
			let parsedCount = 0

			for (const obj of objects) {
				const result = parseJsonAircraft(obj)
				if (result) {
					parsedCount++
					// Verify ICAO is valid hex
					expect(result.icao).toMatch(/^[A-F0-9]{6}$/)
				}
			}

			// All objects with hex field should parse
			expect(parsedCount).toBe(objects.length)
		})

		it("should contain expected aircraft data", () => {
			const objects = loadJsonSample()
			const parsed = objects.map(parseJsonAircraft).filter(Boolean)

			// Check that expected ICAO addresses are present
			const icaos = new Set(parsed.map(a => a!.icao))
			for (const expected of EXPECTED_JSON_AIRCRAFT) {
				expect(icaos.has(expected.icao)).toBe(true)
			}
		})

		it("should include aircraft with minimal data", () => {
			const objects = loadJsonSample()

			// Should have some objects with only hex field
			const minimalObjects = objects.filter(
				obj => Object.keys(obj).length === 1 && "hex" in obj,
			)
			expect(minimalObjects.length).toBeGreaterThan(0)
		})
	})

	describe("Beast Binary Sample Data", () => {
		it("should load Beast binary sample", () => {
			const buffer = loadBeastSample()

			expect(buffer).toBeInstanceOf(Buffer)
			expect(buffer.length).toBeGreaterThan(0)
		})

		it("should contain valid Beast messages", () => {
			const buffer = loadBeastSample()
			let offset = 0
			let messageCount = 0

			while (offset < buffer.length) {
				// Look for escape byte
				if (buffer[offset] !== 0x1a) {
					offset++
					continue
				}

				if (offset + 2 >= buffer.length) break

				const msgType = buffer[offset + 1]

				// Determine message length
				let msgLen: number
				switch (msgType) {
					case 0x31:
						msgLen = 2
						break
					case 0x32:
						msgLen = 7
						break
					case 0x33:
						msgLen = 14
						break
					default:
						offset++
						continue
				}

				const totalLen = 2 + 6 + 1 + msgLen
				if (offset + totalLen > buffer.length) break

				messageCount++
				offset += totalLen
			}

			expect(messageCount).toBeGreaterThan(0)
		})

		it("should contain parseable Mode-S messages", () => {
			const buffer = loadBeastSample()
			let offset = 0
			let parsedCount = 0

			while (offset < buffer.length) {
				if (buffer[offset] !== 0x1a) {
					offset++
					continue
				}

				if (offset + 2 >= buffer.length) break

				const msgType = buffer[offset + 1]

				let msgLen: number
				switch (msgType) {
					case 0x31:
						msgLen = 2
						break
					case 0x32:
						msgLen = 7
						break
					case 0x33:
						msgLen = 14
						break
					default:
						offset++
						continue
				}

				const totalLen = 2 + 6 + 1 + msgLen
				if (offset + totalLen > buffer.length) break

				const timestamp = buffer.subarray(offset + 2, offset + 8)
				const signal = buffer[offset + 8] ?? 0
				const message = buffer.subarray(offset + 9, offset + 9 + msgLen)

				const result = parseBeastMessage(msgType, timestamp, signal, message)
				if (result) {
					parsedCount++
					expect(result.icao).toMatch(/^[A-F0-9]{6}$/)
				}

				offset += totalLen
			}

			// Mode-S messages should parse (Mode-AC won't)
			expect(parsedCount).toBeGreaterThan(0)
		})

		it("should contain expected ICAO addresses", () => {
			const buffer = loadBeastSample()
			const icaos = new Set<string>()
			let offset = 0

			while (offset < buffer.length) {
				if (buffer[offset] !== 0x1a) {
					offset++
					continue
				}

				if (offset + 2 >= buffer.length) break

				const msgType = buffer[offset + 1]

				let msgLen: number
				switch (msgType) {
					case 0x31:
						msgLen = 2
						break
					case 0x32:
						msgLen = 7
						break
					case 0x33:
						msgLen = 14
						break
					default:
						offset++
						continue
				}

				const totalLen = 2 + 6 + 1 + msgLen
				if (offset + totalLen > buffer.length) break

				const timestamp = buffer.subarray(offset + 2, offset + 8)
				const signal = buffer[offset + 8] ?? 0
				const message = buffer.subarray(offset + 9, offset + 9 + msgLen)

				const result = parseBeastMessage(msgType, timestamp, signal, message)
				if (result) {
					icaos.add(result.icao)
				}

				offset += totalLen
			}

			// Check some expected ICAO addresses are present
			expect(icaos.has("A12345")).toBe(true)
			expect(icaos.has("ABCDEF")).toBe(true)
		})
	})

	describe("Sample Constants", () => {
		it("should have valid ICAO addresses", () => {
			for (const icao of SAMPLE_ICAO_ADDRESSES) {
				expect(icao).toMatch(/^[A-F0-9]{6}$/)
			}
		})

		it("should have expected SBS aircraft data", () => {
			expect(EXPECTED_SBS_AIRCRAFT.length).toBeGreaterThan(0)
			for (const aircraft of EXPECTED_SBS_AIRCRAFT) {
				expect(aircraft.icao).toMatch(/^[A-F0-9]{6}$/)
			}
		})

		it("should have expected JSON aircraft data", () => {
			expect(EXPECTED_JSON_AIRCRAFT.length).toBeGreaterThan(0)
			for (const aircraft of EXPECTED_JSON_AIRCRAFT) {
				expect(aircraft.icao).toMatch(/^[A-F0-9]{6}$/)
			}
		})
	})

	describe("Recording Source Configs", () => {
		it("should have valid SBS recording config", () => {
			const config = RECORDING_SOURCE_CONFIGS.sbs

			expect(config.id).toBe("test-adsb-sbs")
			expect(config.type).toBe("recording")
			expect(config.filePath).toContain("sbs-sample.txt")
			expect(config.caps.kind).toBe("recording")
		})

		it("should have valid JSON recording config", () => {
			const config = RECORDING_SOURCE_CONFIGS.json

			expect(config.id).toBe("test-adsb-json")
			expect(config.type).toBe("recording")
			expect(config.filePath).toContain("json-sample.jsonl")
			expect(config.caps.kind).toBe("recording")
		})

		it("should have valid Beast recording config", () => {
			const config = RECORDING_SOURCE_CONFIGS.beast

			expect(config.id).toBe("test-adsb-beast")
			expect(config.type).toBe("recording")
			expect(config.filePath).toContain("beast-sample.bin")
			expect(config.caps.kind).toBe("recording")
		})
	})
})
