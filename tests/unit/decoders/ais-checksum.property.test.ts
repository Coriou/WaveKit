/**
 * AIS NMEA checksum gate (WG2 req 8). The XOR is checked before a sentence
 * can enter the fragment buffer. JSON output does not use this gate.
 */

import { Writable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import {
	AisCatcherDecoder,
	nmeaChecksumValid,
} from "../../../src/decoders/builtin/ais-catcher.js"
import {
	encodeType1,
	nmeaChecksum,
	toNmeaSentence,
} from "../../mocks/fixtures/ais/encode.js"
import { loadNmeaBadChecksum } from "../../mocks/fixtures/ais/index.js"

function config(outputFormat: "nmea" | "json" = "nmea"): DecoderConfig {
	return {
		id: "test-ais",
		type: "ais-catcher",
		enabled: true,
		options: { outputFormat },
		outputHost: "127.0.0.1",
		outputPort: 10110,
		outputProtocol: "udp",
	}
}

class FeedableAis extends AisCatcherDecoder {
	feed(line: string) {
		return this.parseOutput(line)
	}
}

function sentenceFor(mmsi: number): string {
	const armored = encodeType1({
		mmsi,
		navStatus: 0,
		sogTenths: 0,
		lonRaw: 0,
		latRaw: 0,
		cogTenths: 0,
		heading: 0,
	})
	return toNmeaSentence(armored.payload, armored.fillBits)
}

function mutateBetween(sentence: string, index: number, code: number): string {
	const star = sentence.indexOf("*")
	const at = 1 + (index % (star - 1))
	let next = String.fromCharCode(code)
	if (next === sentence.charAt(at)) next = next === "A" ? "B" : "A"
	return sentence.slice(0, at) + next + sentence.slice(at + 1)
}

describe("NMEA checksum", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("accepts a sentence exactly when its checksum is right", () => {
		// Feature: web-gaps-2, Property 12: NMEA checksum
		// Validates: Requirements 8.1
		const decoder = new FeedableAis(config(), pino({ level: "silent" }))
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 999_999_999 }),
				fc.integer({ min: 0, max: 10_000 }),
				fc.integer({ min: 32, max: 126 }),
				(mmsi, index, code) => {
					const sentence = sentenceFor(mmsi)
					const before = decoder.checksumErrors
					expect(nmeaChecksumValid(sentence)).toBe(true)
					const lower =
						sentence.slice(0, sentence.length - 2) +
						sentence.slice(-2).toLowerCase()
					expect(nmeaChecksumValid(lower)).toBe(true)
					expect(decoder.feed(sentence)?.type).toBe("ship")
					expect(decoder.checksumErrors).toBe(before)
					expect(decoder.getStatus().stats.errors).toBe(before)

					const mutated = mutateBetween(sentence, index, code)
					expect(nmeaChecksumValid(mutated)).toBe(false)
					expect(decoder.feed(mutated)).toBeNull()
					expect(decoder.checksumErrors).toBe(before + 1)
					expect(decoder.getStatus().stats.errors).toBe(before + 1)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("accepts lowercase hex and a trailing CRLF, and rejects a broken sentence", () => {
		const decoder = new FeedableAis(config(), pino({ level: "silent" }))
		const sentence = sentenceFor(123456789)
		const lower =
			sentence.slice(0, sentence.length - 2) + sentence.slice(-2).toLowerCase()
		expect(decoder.feed(`${lower}\r\n`)?.type).toBe("ship")
		expect(decoder.checksumErrors).toBe(0)

		const star = sentence.indexOf("*")
		const spaced = `${sentence.slice(0, star - 1)} ${sentence.slice(star - 1)}`
		expect(nmeaChecksumValid(spaced)).toBe(false)
		expect(decoder.feed(spaced)).toBeNull()
		expect(nmeaChecksumValid(sentence.slice(0, star))).toBe(false)
		expect(decoder.feed(sentence.slice(0, star))).toBeNull()
		expect(nmeaChecksumValid(`${sentence}\r`)).toBe(false)
		expect(decoder.checksumErrors).toBe(2)
		expect(decoder.getStatus().stats.errors).toBe(2)

		const dollarBody = "GPXXX,1,2"
		const dollar = `$${dollarBody}*${nmeaChecksum(dollarBody)}`
		const dollarLower =
			dollar.slice(0, dollar.length - 2) + dollar.slice(-2).toLowerCase()
		expect(nmeaChecksumValid(dollar)).toBe(true)
		expect(nmeaChecksumValid(dollarLower)).toBe(true)
		expect(decoder.feed(`$${dollarBody}*00`)).toBeNull()
		expect(decoder.checksumErrors).toBe(3)
		// A valid non-AIS sentence is not a checksum failure.
		expect(decoder.feed(dollar)).toBeNull()
		expect(decoder.checksumErrors).toBe(3)
	})

	it("drops every line of the bad-checksum fixture and keeps the JSON path clear", () => {
		const nmea = new FeedableAis(config(), pino({ level: "silent" }))
		const bad = loadNmeaBadChecksum()
		expect(bad.length).toBeGreaterThan(0)
		for (const line of bad) expect(nmea.feed(line)).toBeNull()
		expect(nmea.checksumErrors).toBe(bad.length)
		expect(nmea.getStatus().stats.errors).toBe(bad.length)

		const json = new FeedableAis(config("json"), pino({ level: "silent" }))
		expect(json.feed(bad[0]!)).toBeNull()
		expect(json.feed('{"mmsi":123456789,"type":1}')?.type).toBe("ship")
		expect(json.checksumErrors).toBe(0)
		expect(json.getStatus().stats.errors).toBe(0)
	})

	it("debug-logs a checksum drop at most once per minute", () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const lines: string[] = []
		const stream = new Writable({
			write(chunk, _enc, cb) {
				lines.push(String(chunk))
				cb()
			},
		})
		const decoder = new FeedableAis(config(), pino({ level: "debug" }, stream))
		const bad = sentenceFor(42).slice(0, -2) + "00"
		decoder.feed(bad)
		decoder.feed(bad)
		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain(
			"Dropped an AIS NMEA sentence with a missing or wrong checksum",
		)
		expect(lines[0]).not.toContain("AIVDM")
		vi.advanceTimersByTime(59_999)
		decoder.feed(bad)
		expect(lines).toHaveLength(1)
		vi.advanceTimersByTime(1)
		decoder.feed(bad)
		expect(lines).toHaveLength(2)
		expect(decoder.checksumErrors).toBe(4)
	})
})
