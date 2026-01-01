/**
 * ADS-B Test Fixtures
 *
 * This module provides sample ADS-B data for testing the Readsb decoder.
 * Supports SBS, Beast binary, and JSON formats.
 *
 * Usage:
 * ```typescript
 * import { loadSbsSample, loadJsonSample, loadBeastSample } from '../mocks/fixtures/adsb'
 *
 * const sbsLines = loadSbsSample()
 * const jsonObjects = loadJsonSample()
 * const beastBuffer = loadBeastSample()
 * ```
 */

import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Loads the SBS sample data as an array of lines.
 * Filters out comments and empty lines.
 */
export function loadSbsSample(): string[] {
	const content = readFileSync(join(__dirname, "sbs-sample.txt"), "utf-8")
	return content
		.split("\n")
		.filter(line => line.trim() && !line.startsWith("#"))
}

/**
 * Loads the SBS sample data as raw text.
 */
export function loadSbsSampleRaw(): string {
	return readFileSync(join(__dirname, "sbs-sample.txt"), "utf-8")
}

/**
 * Loads the JSON sample data as an array of parsed objects.
 */
export function loadJsonSample(): Record<string, unknown>[] {
	const content = readFileSync(join(__dirname, "json-sample.jsonl"), "utf-8")
	return content
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Loads the JSON sample data as raw JSONL text.
 */
export function loadJsonSampleRaw(): string {
	return readFileSync(join(__dirname, "json-sample.jsonl"), "utf-8")
}

/**
 * Loads the Beast binary sample data as a Buffer.
 */
export function loadBeastSample(): Buffer {
	return readFileSync(join(__dirname, "beast-sample.bin"))
}

/**
 * Sample ICAO addresses used in the fixtures.
 * Useful for verifying parser output.
 * All addresses are valid 6-character hex strings.
 */
export const SAMPLE_ICAO_ADDRESSES = [
	"A12345",
	"ABCDEF",
	"789ABC",
	"DEF012",
	"345678",
	"9ABCDE",
	"F12345",
	"E67890",
	"C0FFEE",
	"DEADBE",
	"BEEF01",
	"CAFE12",
	"123456",
	"FEDCBA",
	"AABBCC",
] as const

/**
 * Sample callsigns used in the fixtures.
 */
export const SAMPLE_CALLSIGNS = [
	"UAL123",
	"DAL456",
	"AAL789",
	"SWA321",
	"N12345",
	"JBU567",
	"FDX890",
	"EMG001",
	"BAW178",
	"AFR123",
	"KLM456",
	"LH789",
	"N456HE",
	"TEST123",
] as const

/**
 * Expected aircraft data from the SBS sample.
 * Can be used to verify parser output.
 */
export const EXPECTED_SBS_AIRCRAFT = [
	{
		icao: "A12345",
		callsign: "UAL123",
		altitude: 35000,
		groundSpeed: 450,
		track: 180,
		lat: 40.7128,
		lon: -74.006,
		squawk: "1234",
		onGround: false,
	},
	{
		icao: "ABCDEF",
		callsign: "DAL456",
		altitude: 28000,
		groundSpeed: 380,
		track: 270,
		lat: 34.0522,
		lon: -118.2437,
		verticalRate: -1500,
		squawk: "2345",
		onGround: false,
	},
	{
		icao: "789ABC",
		callsign: "AAL789",
		altitude: 15000,
		groundSpeed: 320,
		track: 90,
		lat: 41.8781,
		lon: -87.6298,
		verticalRate: 2500,
		squawk: "3456",
		onGround: false,
	},
	{
		icao: "DEF012",
		callsign: "SWA321",
		altitude: 0,
		groundSpeed: 25,
		track: 45,
		lat: 33.9425,
		lon: -118.4081,
		squawk: "4567",
		onGround: true,
	},
	{
		icao: "345678",
		callsign: "N12345",
		altitude: 45000,
		groundSpeed: 520,
		track: 315,
		lat: 36.1699,
		lon: -115.1398,
		squawk: "5670",
		onGround: false,
	},
] as const

/**
 * Expected aircraft data from the JSON sample.
 */
export const EXPECTED_JSON_AIRCRAFT = [
	{
		icao: "A12345",
		callsign: "UAL123",
		altitude: 35000,
		groundSpeed: 450,
		track: 180,
		lat: 40.7128,
		lon: -74.006,
		squawk: "1234",
		onGround: false,
		messageCount: 42,
	},
	{
		icao: "ABCDEF",
		callsign: "DAL456",
		altitude: 28000,
		groundSpeed: 380,
		track: 270,
		lat: 34.0522,
		lon: -118.2437,
		verticalRate: -1500,
		squawk: "2345",
		onGround: false,
		messageCount: 38,
	},
] as const

/**
 * Recording source configuration for CI testing.
 * Use with the Recording Source feature.
 */
export const RECORDING_SOURCE_CONFIGS = {
	sbs: {
		id: "test-adsb-sbs",
		type: "recording" as const,
		filePath: join(__dirname, "sbs-sample.txt"),
		loop: false,
		playbackSpeed: 1.0,
		caps: {
			kind: "recording" as const,
			sampleRate: 48000,
			format: "S16LE" as const,
			exclusive: false,
		},
	},
	json: {
		id: "test-adsb-json",
		type: "recording" as const,
		filePath: join(__dirname, "json-sample.jsonl"),
		loop: false,
		playbackSpeed: 1.0,
		caps: {
			kind: "recording" as const,
			sampleRate: 48000,
			format: "S16LE" as const,
			exclusive: false,
		},
	},
	beast: {
		id: "test-adsb-beast",
		type: "recording" as const,
		filePath: join(__dirname, "beast-sample.bin"),
		loop: false,
		playbackSpeed: 1.0,
		caps: {
			kind: "recording" as const,
			sampleRate: 48000,
			format: "S16LE" as const,
			exclusive: false,
		},
	},
} as const
