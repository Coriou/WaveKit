/**
 * VDL2 Test Fixtures
 *
 * This module provides sample VDL Mode 2 data for testing the Dumpvdl2 decoder.
 * Supports JSON format output from dumpvdl2 --output decoded:json:file:- flag.
 *
 * Usage:
 * ```typescript
 * import { loadJsonSample, loadJsonSampleRaw, SAMPLE_VDL2_MESSAGES } from '../mocks/fixtures/vdl2'
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
 * Embedded ACARS data in VDL2 messages.
 */
export interface AcarsEmbedded {
	err?: boolean
	crc_ok?: boolean
	more?: boolean
	reg?: string
	mode?: string
	label?: string
	blk_id?: string
	ack?: string
	flight?: string
	msg_num?: string
	msg_num_seq?: string
	msg_text?: string
}

/**
 * XID data in VDL2 messages.
 */
export interface XidData {
	type?: string
	type_descr?: string
	params?: Record<string, unknown>
}

/**
 * AVLC frame data.
 */
export interface AvlcData {
	src?: {
		addr?: string
		type?: string
		status?: string
	}
	dst?: {
		addr?: string
		type?: string
	}
	cr?: string
	frame_type?: string
	rseq?: number
	sseq?: number
	poll?: boolean
	final?: boolean
	acars?: AcarsEmbedded
	xid?: XidData
}

/**
 * Raw JSON output structure from dumpvdl2 --output decoded:json:file:- flag.
 */
export interface Dumpvdl2JsonOutput {
	vdl2?: {
		t?: {
			sec?: number
			usec?: number
		}
		freq?: number
		sig_level?: number
		noise_level?: number
		station?: string
		avlc?: AvlcData
	}
}

/**
 * Loads the JSON sample data as an array of parsed objects.
 */
export function loadJsonSample(): Dumpvdl2JsonOutput[] {
	const content = readFileSync(join(__dirname, "json-sample.jsonl"), "utf-8")
	return content
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as Dumpvdl2JsonOutput)
}

/**
 * Loads the JSON sample data as raw JSONL text.
 */
export function loadJsonSampleRaw(): string {
	return readFileSync(join(__dirname, "json-sample.jsonl"), "utf-8")
}

/**
 * Sample ICAO addresses used in the fixtures.
 */
export const SAMPLE_ICAO_ADDRESSES = [
	"ABC123",
	"DEF456",
	"789ABC",
	"FEDCBA",
	"123456",
	"AABBCC",
	"DDEEFF",
	"112233",
	"445566",
	"778899",
	"CCDDEE",
] as const

/**
 * Sample ground station identifiers used in the fixtures.
 */
export const SAMPLE_STATIONS = [
	"EDDF",
	"EGLL",
	"LFPG",
	"EHAM",
	"LEMD",
	"KJFK",
	"RJTT",
	"YSSY",
	"CYYZ",
] as const

/**
 * Sample VDL2 frequencies in Hz.
 */
export const SAMPLE_FREQUENCIES_HZ = [
	136_650_000, 136_700_000, 136_975_000,
] as const

/**
 * Sample aircraft tail numbers used in the fixtures.
 */
export const SAMPLE_TAIL_NUMBERS = [
	"N12345",
	"G-ABCD",
	"PH-MNO",
	"EC-JKL",
	"JA1234",
	"VH-ABC",
	"C-FGHI",
] as const

/**
 * Sample flight numbers used in the fixtures.
 */
export const SAMPLE_FLIGHT_NUMBERS = [
	"UAL123",
	"BAW178",
	"KLM456",
	"IBE789",
	"JAL001",
	"QFA012",
	"ACA456",
] as const

/**
 * Expected VDL2 message data from the JSON sample.
 * Can be used to verify parser output.
 */
export const EXPECTED_VDL2_MESSAGES = [
	{
		icao: "ABC123",
		station: "EDDF",
		frequency: 136_650_000,
		msgType: "acars",
		hasAcars: true,
		tail: "N12345",
		flight: "UAL123",
	},
	{
		icao: "DEF456",
		station: "EGLL",
		frequency: 136_700_000,
		msgType: "acars",
		hasAcars: true,
		tail: "G-ABCD",
		flight: "BAW178",
	},
	{
		icao: "789ABC",
		station: "LFPG",
		frequency: 136_975_000,
		msgType: "Ground Station Information Frame",
		hasAcars: false,
		hasXid: true,
	},
	{
		icao: "FEDCBA",
		station: "EHAM",
		frequency: 136_650_000,
		msgType: "acars",
		hasAcars: true,
		tail: "PH-MNO",
		flight: "KLM456",
	},
	{
		icao: "123456",
		station: "EDDF",
		frequency: 136_700_000,
		msgType: "UI",
		hasAcars: false,
	},
] as const

/**
 * Sample VDL2 messages with all fields populated.
 * Useful for testing complete message parsing.
 */
export const SAMPLE_VDL2_MESSAGES: Dumpvdl2JsonOutput[] = [
	{
		vdl2: {
			t: { sec: 1704067200, usec: 500000 },
			freq: 136_650_000,
			sig_level: -25.5,
			noise_level: -45.0,
			station: "EDDF",
			avlc: {
				src: { addr: "ABC123", type: "aircraft", status: "airborne" },
				dst: { addr: "EDDF", type: "ground" },
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
					msg_text: "POSN40.7128W074.0060,FL350,ETA1430",
				},
			},
		},
	},
	{
		vdl2: {
			t: { sec: 1704067202, usec: 750000 },
			freq: 136_975_000,
			sig_level: -22.1,
			noise_level: -44.0,
			station: "LFPG",
			avlc: {
				src: { addr: "789ABC", type: "aircraft", status: "airborne" },
				dst: { addr: "LFPG", type: "ground" },
				cr: "command",
				frame_type: "XID",
				xid: {
					type: "GSIF",
					type_descr: "Ground Station Information Frame",
					params: { airport: "LFPG", gs_addr: "LFPG" },
				},
			},
		},
	},
	{
		vdl2: {
			t: { sec: 1704067206, usec: 800000 },
			freq: 136_650_000,
			sig_level: -32.0,
			noise_level: -50.0,
			station: "KJFK",
			avlc: {
				src: { addr: "DDEEFF", type: "aircraft", status: "airborne" },
				dst: { addr: "KJFK", type: "ground" },
				cr: "command",
				frame_type: "XID",
				xid: {
					type: "LCR",
					type_descr: "Link Connection Request",
					params: { modulation: "D8PSK" },
				},
			},
		},
	},
]

/**
 * Sample VDL2 messages with embedded ACARS content.
 * Useful for testing ACARS extraction from VDL2 frames.
 */
export const SAMPLE_VDL2_WITH_ACARS: Dumpvdl2JsonOutput[] = [
	{
		vdl2: {
			t: { sec: 1704067200, usec: 500000 },
			freq: 136_650_000,
			sig_level: -25.5,
			noise_level: -45.0,
			station: "EDDF",
			avlc: {
				src: { addr: "ABC123", type: "aircraft" },
				dst: { addr: "EDDF", type: "ground" },
				frame_type: "I",
				acars: {
					err: false,
					crc_ok: true,
					reg: "N12345",
					mode: "2",
					label: "H1",
					flight: "UAL123",
					msg_text: "POSN40.7128W074.0060,FL350,ETA1430",
				},
			},
		},
	},
	{
		vdl2: {
			t: { sec: 1704067201, usec: 250000 },
			freq: 136_700_000,
			sig_level: -28.3,
			noise_level: -46.5,
			station: "EGLL",
			avlc: {
				src: { addr: "DEF456", type: "aircraft" },
				dst: { addr: "EGLL", type: "ground" },
				frame_type: "I",
				acars: {
					err: false,
					crc_ok: true,
					reg: "G-ABCD",
					mode: "2",
					label: "Q0",
					flight: "BAW178",
					msg_text: "REQUEST OCEANIC CLEARANCE",
				},
			},
		},
	},
]

/**
 * Recording source configuration for CI testing.
 * Use with the Recording Source feature.
 */
export const RECORDING_SOURCE_CONFIG = {
	id: "test-vdl2-json",
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
