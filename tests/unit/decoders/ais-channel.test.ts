/**
 * WG4 req 5.1, 5.2: AIS radio channel on ShipData from NMEA field 4 and
 * AIS-catcher JSON `channel`, and its provenance frequency.
 */

import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import {
	AisCatcherDecoder,
	normaliseAisChannel,
	parseJsonShip,
	parseNmeaSentence,
} from "../../../src/decoders/builtin/ais-catcher.js"
import { resolveProvenance } from "../../../src/core/activity/provenance/resolve.js"
import { createLogger } from "../../../src/utils/logger.js"
import {
	encodeType1,
	encodeType5,
	nmeaChecksum,
	toNmeaFragments,
} from "../../mocks/fixtures/ais/encode.js"

const logger = createLogger({ level: "error" })

function config(outputFormat: "nmea" | "json"): DecoderConfig {
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

const position = encodeType1({
	mmsi: 123456789,
	navStatus: 0,
	sogTenths: 123,
	lonRaw: -900_000,
	latRaw: 30_300_000,
	cogTenths: 900,
	heading: 90,
})

const staticReport = encodeType5({
	mmsi: 235000001,
	imo: 9_000_001,
	callsign: "ABCD",
	name: "TEST VESSEL",
	shipType: 70,
	draughtTenths: 55,
	destination: "SOUTHAMPTON",
	month: 6,
	day: 20,
	hour: 12,
	minute: 30,
})

/** Single-sentence AIVDM with an arbitrary raw field 4 and a valid checksum. */
function sentenceWithChannel(field: string): string {
	const body = `AIVDM,1,1,,${field},${position.payload},${position.fillBits}`
	return `!${body}*${nmeaChecksum(body)}`
}

const binding = {
	sourceId: "src-1",
	targetFrequenciesHz: [],
	tuningTrust: "unverified",
} as const

describe("normaliseAisChannel", () => {
	it.each([
		["A", "A"],
		["a", "A"],
		[" a ", "A"],
		["1", "A"],
		["\t1\n", "A"],
		["B", "B"],
		["b", "B"],
		[" B", "B"],
		["2", "B"],
	] as const)("maps %j to %s", (raw, expected) => {
		expect(normaliseAisChannel(raw)).toBe(expected)
	})

	it.each(["", " ", "C", "AB", "3", "0", "87B", "88B", "A1", "garbage"])(
		"rejects string %j",
		raw => {
			expect(normaliseAisChannel(raw)).toBeUndefined()
		},
	)

	it.each([1, 2, 0, null, undefined, true, {}, ["A"], Number.NaN])(
		"rejects non-string %j",
		raw => {
			expect(normaliseAisChannel(raw)).toBeUndefined()
		},
	)

	// Feature: web-gaps-4, Property 7: AIS channel normalisation
	// Validates: Requirements 5.1
	it("is A or B exactly for padded case-insensitive A/1 or B/2 strings", () => {
		const pad = fc.stringMatching(/^[ \t]{0,3}$/)
		fc.assert(
			fc.property(
				fc.oneof(
					fc.anything(),
					fc.string(),
					fc
						.tuple(pad, fc.constantFrom("A", "a", "1", "B", "b", "2"), pad)
						.map(([l, c, r]) => `${l}${c}${r}`),
				),
				raw => {
					const result = normaliseAisChannel(raw)
					if (typeof raw !== "string") {
						expect(result).toBeUndefined()
						return
					}
					const core = raw.trim().toUpperCase()
					const expected =
						core === "A" || core === "1"
							? "A"
							: core === "B" || core === "2"
								? "B"
								: undefined
					expect(result).toBe(expected)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("NMEA channel", () => {
	it.each([
		["A", "A"],
		["B", "B"],
		["1", "A"],
		["2", "B"],
		["a", "A"],
		["b", "B"],
	] as const)("field 4 %j gives channel %s", (field, expected) => {
		const ship = new FeedableAis(config("nmea"), logger).feed(
			sentenceWithChannel(field),
		)?.data as Record<string, unknown> | undefined
		expect(ship?.["mmsi"]).toBe("123456789")
		expect(ship?.["channel"]).toBe(expected)
	})

	it.each(["", "C", "3", "AB"])("field 4 %j omits the channel key", field => {
		const ship = new FeedableAis(config("nmea"), logger).feed(
			sentenceWithChannel(field),
		)?.data as Record<string, unknown> | undefined
		expect(ship?.["mmsi"]).toBe("123456789")
		expect(ship).not.toHaveProperty("channel")
	})

	it("parseNmeaSentence carries the channel too", () => {
		expect(parseNmeaSentence(sentenceWithChannel("B"))?.channel).toBe("B")
	})

	it("multi-fragment groups on different channels keep their own channel", () => {
		const decoder = new FeedableAis(config("nmea"), logger)
		const onA = toNmeaFragments(staticReport.payload, staticReport.fillBits, {
			channel: "A",
			seqId: 3,
		})
		const onB = toNmeaFragments(staticReport.payload, staticReport.fillBits, {
			channel: "B",
			seqId: 3,
		})
		expect(onA).toHaveLength(2)
		expect(onB).toHaveLength(2)
		expect(decoder.feed(onA[0] ?? "")).toBeNull()
		expect(decoder.feed(onB[0] ?? "")).toBeNull()
		const fromB = decoder.feed(onB[1] ?? "")?.data as
			| Record<string, unknown>
			| undefined
		const fromA = decoder.feed(onA[1] ?? "")?.data as
			| Record<string, unknown>
			| undefined
		expect(fromB?.["name"]).toBe("TEST VESSEL")
		expect(fromB?.["channel"]).toBe("B")
		expect(fromA?.["name"]).toBe("TEST VESSEL")
		expect(fromA?.["channel"]).toBe("A")
	})

	it("a multi-fragment group with an unknown channel omits the key", () => {
		const decoder = new FeedableAis(config("nmea"), logger)
		const [first, second] = toNmeaFragments(
			staticReport.payload,
			staticReport.fillBits,
			{ seqId: 4 },
		).map(s => {
			const body = s.slice(1, s.indexOf("*")).replace(",4,A,", ",4,,")
			return `!${body}*${nmeaChecksum(body)}`
		})
		expect(decoder.feed(first ?? "")).toBeNull()
		const ship = decoder.feed(second ?? "")?.data
		expect(ship).toMatchObject({ name: "TEST VESSEL" })
		expect(ship).not.toHaveProperty("channel")
	})
})

describe("JSON channel", () => {
	it.each([
		["A", "A"],
		["B", "B"],
		[" b ", "B"],
		["1", "A"],
		["2", "B"],
	] as const)("channel %j gives %s", (raw, expected) => {
		expect(parseJsonShip({ mmsi: 1, type: 1, channel: raw })?.channel).toBe(
			expected,
		)
	})

	it.each([1, 2, null, true, "C", "", { a: 1 }])(
		"non-channel value %j omits the key",
		raw => {
			const ship = parseJsonShip({ mmsi: 1, type: 1, channel: raw })
			expect(ship).not.toBeNull()
			expect(ship).not.toHaveProperty("channel")
		},
	)

	it("missing channel omits the key", () => {
		expect(parseJsonShip({ mmsi: 1, type: 1 })).not.toHaveProperty("channel")
	})

	it("adapter JSON output carries the channel", () => {
		const out = new FeedableAis(config("json"), logger).feed(
			JSON.stringify({ mmsi: 235000001, type: 1, channel: "B" }),
		)
		expect(out?.data).toMatchObject({ mmsi: "235000001", channel: "B" })
	})
})

describe("adapter output to provenance (req 5.2)", () => {
	function hzFor(out: DecoderOutput | null): number | undefined {
		expect(out).not.toBeNull()
		if (!out) return undefined
		return resolveProvenance(out, binding).frequency?.hz
	}

	it("NMEA channel A resolves to 161.975 MHz and B to 162.025 MHz", () => {
		const decoder = new FeedableAis(config("nmea"), logger)
		expect(hzFor(decoder.feed(sentenceWithChannel("A")))).toBe(161_975_000)
		expect(hzFor(decoder.feed(sentenceWithChannel("B")))).toBe(162_025_000)
		expect(hzFor(decoder.feed(sentenceWithChannel("1")))).toBe(161_975_000)
		expect(hzFor(decoder.feed(sentenceWithChannel("2")))).toBe(162_025_000)
	})

	it("JSON channel A resolves to 161.975 MHz and B to 162.025 MHz", () => {
		const decoder = new FeedableAis(config("json"), logger)
		const line = (channel: string) =>
			JSON.stringify({ mmsi: 235000001, type: 1, channel })
		expect(hzFor(decoder.feed(line("A")))).toBe(161_975_000)
		expect(hzFor(decoder.feed(line("B")))).toBe(162_025_000)
	})

	it("an unknown channel leaves provenance without a frequency", () => {
		const decoder = new FeedableAis(config("nmea"), logger)
		const out = decoder.feed(sentenceWithChannel("C"))
		expect(out).not.toBeNull()
		if (out) expect(resolveProvenance(out, binding).frequency).toBeNull()
	})
})
