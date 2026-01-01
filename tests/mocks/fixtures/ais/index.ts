/**
 * AIS Test Fixtures
 *
 * This module provides sample AIS (Automatic Identification System) data
 * for testing the AIS-catcher decoder. Supports NMEA and JSON formats.
 *
 * Usage:
 * ```typescript
 * import { loadJsonSample, loadNmeaSample, SAMPLE_SHIPS } from '../mocks/fixtures/ais'
 *
 * const jsonMessages = loadJsonSample()
 * const nmeaSentences = loadNmeaSample()
 * ```
 */

import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Raw JSON output structure from AIS-catcher JSON mode.
 */
export interface AisCatcherJsonOutput {
	mmsi?: number | string
	type?: number
	msgtype?: number
	status?: number
	navstatus?: number
	lat?: number
	lon?: number
	cog?: number
	speed?: number
	sog?: number
	heading?: number
	shipname?: string
	name?: string
	callsign?: string
	imo?: number
	shiptype?: number
	destination?: string
	draught?: number
	eta?: string
}

/**
 * Loads the NMEA sample data as an array of lines.
 * Filters out comments and empty lines.
 */
export function loadNmeaSample(): string[] {
	const content = readFileSync(join(__dirname, "nmea-sample.txt"), "utf-8")
	return content
		.split("\n")
		.filter(line => line.trim() && !line.startsWith("#"))
}

/**
 * Loads the NMEA sample data as raw text.
 */
export function loadNmeaSampleRaw(): string {
	return readFileSync(join(__dirname, "nmea-sample.txt"), "utf-8")
}

/**
 * Loads the JSON sample data as an array of parsed objects.
 */
export function loadJsonSample(): AisCatcherJsonOutput[] {
	const content = readFileSync(join(__dirname, "json-sample.jsonl"), "utf-8")
	return content
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as AisCatcherJsonOutput)
}

/**
 * Loads the JSON sample data as raw JSONL text.
 */
export function loadJsonSampleRaw(): string {
	return readFileSync(join(__dirname, "json-sample.jsonl"), "utf-8")
}

/**
 * Sample MMSI numbers used in the fixtures.
 * Format: 9 digits, first 3 indicate country (MID)
 */
export const SAMPLE_MMSI_NUMBERS = [
	"123456789",
	"234567890",
	"345678901",
	"456789012",
	"567890123",
	"678901234",
	"211234567", // Germany
	"311234567", // Singapore
	"411234567", // Japan
	"511234567", // Australia
	"111234567", // USA
	"222345678",
	"333456789",
	"444567890",
	"555678901",
] as const

/**
 * Sample vessel names used in the fixtures.
 */
export const SAMPLE_VESSEL_NAMES = [
	"EVER GIVEN",
	"MAERSK SEALAND",
	"CARNIVAL MAGIC",
	"NORTHERN STAR",
	"SEA BREEZE",
	"WIND DANCER",
	"HAMBURG EXPRESS",
	"SINGAPORE STAR",
	"TOKYO MARU",
	"SYDNEY TRADER",
	"PACIFIC PIONEER",
	"AMBROSE LIGHT",
	"FISHING KING",
	"NORDIC RESCUE",
	"ATLANTIC VOYAGER",
] as const

/**
 * Sample callsigns used in the fixtures.
 */
export const SAMPLE_CALLSIGNS = [
	"H3RC",
	"OWJT2",
	"C6DQ5",
	"MFZQ",
	"FG1234",
	"PA5678",
	"DHAM",
	"9VSG",
	"JD1234",
	"VK1234",
	"WDA1234",
	"KC1234",
	"OXYZ",
	"GBTT",
] as const

/**
 * Ship type codes used in the fixtures.
 */
export const SHIP_TYPE_CODES = {
	FISHING: 30,
	TUG: 52,
	PASSENGER: 60,
	CARGO: 70,
	CARGO_HAZARDOUS_A: 71,
	TANKER: 80,
	SAR: 51,
} as const

/**
 * Navigation status codes.
 */
export const NAV_STATUS_CODES = {
	UNDER_WAY_ENGINE: 0,
	AT_ANCHOR: 1,
	NOT_UNDER_COMMAND: 2,
	RESTRICTED_MANOEUVRABILITY: 3,
	CONSTRAINED_BY_DRAUGHT: 4,
	MOORED: 5,
	AGROUND: 6,
	ENGAGED_IN_FISHING: 7,
	UNDER_WAY_SAILING: 8,
} as const

/**
 * Expected ship data from the JSON sample.
 * Can be used to verify parser output.
 */
export const EXPECTED_JSON_SHIPS = [
	{
		mmsi: "123456789",
		name: "EVER GIVEN",
		callsign: "H3RC",
		shipType: 70,
		lat: 40.7128,
		lon: -74.006,
		cog: 180.5,
		sog: 12.3,
		heading: 179,
		navStatus: 0,
		destination: "NEW YORK",
		messageType: 1,
	},
	{
		mmsi: "234567890",
		name: "MAERSK SEALAND",
		callsign: "OWJT2",
		shipType: 70,
		lat: 51.9054,
		lon: 4.4671,
		cog: 0,
		sog: 0,
		heading: 45,
		navStatus: 1,
		destination: "ROTTERDAM",
		messageType: 1,
	},
	{
		mmsi: "345678901",
		name: "CARNIVAL MAGIC",
		callsign: "C6DQ5",
		shipType: 60,
		lat: 25.7617,
		lon: -80.1918,
		cog: 270.2,
		sog: 18.5,
		heading: 268,
		navStatus: 0,
		destination: "NASSAU",
		messageType: 2,
	},
	{
		mmsi: "456789012",
		name: "NORTHERN STAR",
		callsign: "MFZQ",
		shipType: 30,
		lat: 58.969,
		lon: -3.295,
		cog: 45.8,
		sog: 5.2,
		heading: 50,
		navStatus: 7,
		destination: "SCRABSTER",
		messageType: 3,
	},
	{
		mmsi: "567890123",
		name: "SEA BREEZE",
		callsign: "FG1234",
		lat: 43.2965,
		lon: 5.3698,
		cog: 135.0,
		sog: 6.8,
		heading: 140,
		navStatus: 0,
		messageType: 18,
	},
] as const

/**
 * Sample ships with all fields populated.
 * Useful for testing complete message parsing.
 */
export const SAMPLE_SHIPS: AisCatcherJsonOutput[] = [
	{
		mmsi: 123456789,
		type: 1,
		status: 0,
		lat: 40.7128,
		lon: -74.006,
		cog: 180.5,
		speed: 12.3,
		heading: 179,
		shipname: "EVER GIVEN",
		callsign: "H3RC",
		imo: 9811000,
		shiptype: 70,
		destination: "NEW YORK",
		draught: 14.5,
	},
	{
		mmsi: 234567890,
		type: 1,
		status: 1,
		lat: 51.9054,
		lon: 4.4671,
		cog: 0,
		speed: 0,
		heading: 45,
		shipname: "MAERSK SEALAND",
		callsign: "OWJT2",
		imo: 9778791,
		shiptype: 70,
		destination: "ROTTERDAM",
	},
	{
		mmsi: 345678901,
		type: 2,
		status: 0,
		lat: 25.7617,
		lon: -80.1918,
		cog: 270.2,
		speed: 18.5,
		heading: 268,
		shipname: "CARNIVAL MAGIC",
		callsign: "C6DQ5",
		imo: 9378496,
		shiptype: 60,
		destination: "NASSAU",
	},
]

/**
 * Recording source configurations for CI testing.
 * Use with the Recording Source feature.
 */
export const RECORDING_SOURCE_CONFIGS = {
	nmea: {
		id: "test-ais-nmea",
		type: "recording" as const,
		filePath: join(__dirname, "nmea-sample.txt"),
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
		id: "test-ais-json",
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
} as const
