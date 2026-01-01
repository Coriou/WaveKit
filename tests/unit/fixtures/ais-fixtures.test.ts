/**
 * AIS Fixtures Tests
 *
 * Verifies that the AIS test fixtures can be loaded and contain valid data.
 */

import { describe, it, expect } from "vitest"
import {
	loadJsonSample,
	loadJsonSampleRaw,
	loadNmeaSample,
	loadNmeaSampleRaw,
	SAMPLE_MMSI_NUMBERS,
	SAMPLE_VESSEL_NAMES,
	SAMPLE_CALLSIGNS,
	EXPECTED_JSON_SHIPS,
	SAMPLE_SHIPS,
	RECORDING_SOURCE_CONFIGS,
} from "../../mocks/fixtures/ais/index.js"

describe("AIS Fixtures", () => {
	describe("loadJsonSample", () => {
		it("should load JSON sample as array of objects", () => {
			const messages = loadJsonSample()
			expect(Array.isArray(messages)).toBe(true)
			expect(messages.length).toBeGreaterThan(0)
		})

		it("should contain valid MMSI numbers", () => {
			const messages = loadJsonSample()
			for (const msg of messages) {
				expect(msg.mmsi).toBeDefined()
				const mmsiStr = String(msg.mmsi)
				expect(mmsiStr.length).toBeLessThanOrEqual(9)
			}
		})

		it("should contain valid message types", () => {
			const messages = loadJsonSample()
			for (const msg of messages) {
				if (msg.type !== undefined) {
					expect(msg.type).toBeGreaterThanOrEqual(1)
					expect(msg.type).toBeLessThanOrEqual(27)
				}
			}
		})

		it("should contain valid coordinates where present", () => {
			const messages = loadJsonSample()
			for (const msg of messages) {
				if (msg.lat !== undefined) {
					expect(msg.lat).toBeGreaterThanOrEqual(-90)
					expect(msg.lat).toBeLessThanOrEqual(90)
				}
				if (msg.lon !== undefined) {
					expect(msg.lon).toBeGreaterThanOrEqual(-180)
					expect(msg.lon).toBeLessThanOrEqual(180)
				}
			}
		})
	})

	describe("loadJsonSampleRaw", () => {
		it("should load JSON sample as raw JSONL text", () => {
			const raw = loadJsonSampleRaw()
			expect(typeof raw).toBe("string")
			expect(raw.length).toBeGreaterThan(0)
		})

		it("should contain valid JSON lines", () => {
			const raw = loadJsonSampleRaw()
			const lines = raw.split("\n").filter(line => line.trim())
			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow()
			}
		})
	})

	describe("loadNmeaSample", () => {
		it("should load NMEA sample as array of lines", () => {
			const sentences = loadNmeaSample()
			expect(Array.isArray(sentences)).toBe(true)
			expect(sentences.length).toBeGreaterThan(0)
		})

		it("should contain valid AIS NMEA sentences", () => {
			const sentences = loadNmeaSample()
			for (const sentence of sentences) {
				expect(
					sentence.startsWith("!AIVDM") || sentence.startsWith("!AIVDO"),
				).toBe(true)
			}
		})

		it("should filter out comments", () => {
			const sentences = loadNmeaSample()
			for (const sentence of sentences) {
				expect(sentence.startsWith("#")).toBe(false)
			}
		})
	})

	describe("loadNmeaSampleRaw", () => {
		it("should load NMEA sample as raw text", () => {
			const raw = loadNmeaSampleRaw()
			expect(typeof raw).toBe("string")
			expect(raw.length).toBeGreaterThan(0)
		})

		it("should contain comments in raw format", () => {
			const raw = loadNmeaSampleRaw()
			expect(raw).toContain("#")
		})
	})

	describe("Sample Constants", () => {
		it("should have valid MMSI numbers", () => {
			expect(SAMPLE_MMSI_NUMBERS.length).toBeGreaterThan(0)
			for (const mmsi of SAMPLE_MMSI_NUMBERS) {
				expect(mmsi.length).toBe(9)
				expect(/^\d+$/.test(mmsi)).toBe(true)
			}
		})

		it("should have valid vessel names", () => {
			expect(SAMPLE_VESSEL_NAMES.length).toBeGreaterThan(0)
			for (const name of SAMPLE_VESSEL_NAMES) {
				expect(name.length).toBeGreaterThan(0)
			}
		})

		it("should have valid callsigns", () => {
			expect(SAMPLE_CALLSIGNS.length).toBeGreaterThan(0)
			for (const callsign of SAMPLE_CALLSIGNS) {
				expect(callsign.length).toBeGreaterThan(0)
			}
		})
	})

	describe("Expected JSON Ships", () => {
		it("should have expected ship data", () => {
			expect(EXPECTED_JSON_SHIPS.length).toBeGreaterThan(0)
			for (const ship of EXPECTED_JSON_SHIPS) {
				expect(ship.mmsi).toBeDefined()
				expect(ship.messageType).toBeDefined()
			}
		})

		it("should match loaded JSON sample", () => {
			const messages = loadJsonSample()
			// First expected ship should match first message
			const firstExpected = EXPECTED_JSON_SHIPS[0]
			const firstMessage = messages[0]

			expect(String(firstMessage?.mmsi)).toBe(firstExpected?.mmsi)
			expect(firstMessage?.shipname?.trim()).toBe(firstExpected?.name)
		})
	})

	describe("Sample Ships", () => {
		it("should have complete ship data", () => {
			expect(SAMPLE_SHIPS.length).toBeGreaterThan(0)
			for (const ship of SAMPLE_SHIPS) {
				expect(ship.mmsi).toBeDefined()
				expect(ship.type).toBeDefined()
				expect(ship.shipname).toBeDefined()
			}
		})
	})

	describe("Recording Source Configs", () => {
		it("should have NMEA config", () => {
			expect(RECORDING_SOURCE_CONFIGS.nmea).toBeDefined()
			expect(RECORDING_SOURCE_CONFIGS.nmea.type).toBe("recording")
			expect(RECORDING_SOURCE_CONFIGS.nmea.filePath).toContain(
				"nmea-sample.txt",
			)
		})

		it("should have JSON config", () => {
			expect(RECORDING_SOURCE_CONFIGS.json).toBeDefined()
			expect(RECORDING_SOURCE_CONFIGS.json.type).toBe("recording")
			expect(RECORDING_SOURCE_CONFIGS.json.filePath).toContain(
				"json-sample.jsonl",
			)
		})
	})
})
