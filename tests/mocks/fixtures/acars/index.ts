/**
 * ACARS Test Fixtures
 *
 * This module provides sample ACARS data for testing the Acarsdec decoder.
 * Supports JSON format output from acarsdec -j flag.
 *
 * Usage:
 * ```typescript
 * import { loadJsonSample, loadJsonSampleRaw, SAMPLE_ACARS_MESSAGES } from '../mocks/fixtures/acars'
 *
 * const messages = loadJsonSample()
 * const rawJsonl = loadJsonSampleRaw()
 * ```
 */

import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Raw JSON output structure from acarsdec -j flag.
 */
export interface AcarsdecJsonOutput {
	timestamp?: number | string
	freq?: number
	channel?: number
	level?: number
	error?: number
	mode?: string
	label?: string
	block_id?: string
	ack?: string | boolean
	tail?: string
	flight?: string
	msgno?: string
	text?: string
	// Alternative field names used by some versions
	frequency?: number
	reg?: string
	message?: string
}

/**
 * Loads the JSON sample data as an array of parsed objects.
 */
export function loadJsonSample(): AcarsdecJsonOutput[] {
	const content = readFileSync(join(__dirname, "json-sample.jsonl"), "utf-8")
	return content
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as AcarsdecJsonOutput)
}

/**
 * Loads the JSON sample data as raw JSONL text.
 */
export function loadJsonSampleRaw(): string {
	return readFileSync(join(__dirname, "json-sample.jsonl"), "utf-8")
}

/**
 * Sample aircraft tail numbers used in the fixtures.
 */
export const SAMPLE_TAIL_NUMBERS = [
	"N12345",
	"N67890",
	"G-ABCD",
	"F-WXYZ",
	"D-EFGH",
	"JA1234",
	"VH-ABC",
	"C-FGHI",
	"EC-JKL",
	"PH-MNO",
	"N54321",
	"N98765",
	"N11111",
] as const

/**
 * Sample flight numbers used in the fixtures.
 */
export const SAMPLE_FLIGHT_NUMBERS = [
	"UAL123",
	"DAL456",
	"BAW178",
	"AFR123",
	"DLH789",
	"JAL001",
	"QFA012",
	"ACA456",
	"IBE789",
	"KLM456",
	"SWA321",
	"AAL789",
	"JBU567",
] as const

/**
 * Sample ACARS frequencies in MHz.
 */
export const SAMPLE_FREQUENCIES_MHZ = [131.55, 131.725, 131.85] as const

/**
 * Sample ACARS frequencies in Hz.
 */
export const SAMPLE_FREQUENCIES_HZ = [
	131_550_000, 131_725_000, 131_850_000,
] as const

/**
 * Expected ACARS message data from the JSON sample.
 * Can be used to verify parser output.
 */
export const EXPECTED_ACARS_MESSAGES = [
	{
		tail: "N12345",
		flight: "UAL123",
		frequency: 131_550_000,
		label: "H1",
		mode: "2",
		hasText: true,
	},
	{
		tail: "N67890",
		flight: "DAL456",
		frequency: 131_725_000,
		label: "Q0",
		mode: "2",
		hasText: true,
	},
	{
		tail: "G-ABCD",
		flight: "BAW178",
		frequency: 131_550_000,
		label: "SA",
		mode: "X",
		hasText: true,
	},
	{
		tail: "F-WXYZ",
		flight: "AFR123",
		frequency: 131_850_000,
		label: "H1",
		mode: "2",
		hasText: true,
	},
	{
		tail: "D-EFGH",
		flight: "DLH789",
		frequency: 131_550_000,
		label: "_d",
		mode: "H",
		hasText: true,
	},
] as const

/**
 * Sample ACARS messages with all fields populated.
 * Useful for testing complete message parsing.
 */
export const SAMPLE_ACARS_MESSAGES: AcarsdecJsonOutput[] = [
	{
		timestamp: 1704067200,
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
		text: "POSN40.7128W074.0060,FL350,ETA1430",
	},
	{
		timestamp: 1704067201,
		freq: 131.725,
		channel: 1,
		level: -30,
		error: 0,
		mode: "2",
		label: "Q0",
		block_id: "B",
		tail: "N67890",
		flight: "DAL456",
		msgno: "M02B",
		text: "REQUEST OCEANIC CLEARANCE",
	},
	{
		timestamp: 1704067202,
		freq: 131.55,
		channel: 0,
		level: -22,
		error: 1,
		mode: "X",
		label: "SA",
		block_id: "C",
		ack: "NAK",
		tail: "G-ABCD",
		flight: "BAW178",
		msgno: "M03C",
		text: "WEATHER REQUEST KJFK",
	},
]

/**
 * Recording source configuration for CI testing.
 * Use with the Recording Source feature.
 */
export const RECORDING_SOURCE_CONFIG = {
	id: "test-acars-json",
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
} as const
