/**
 * NMEA AIS types 5, 18, 19 and 24, fragment reassembly, and the test encoder.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi, afterEach } from "vitest"
import * as fc from "fast-check"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import {
	AisCatcherDecoder,
	decodeAisPayload,
	type DecodedAisPayload,
} from "../../../src/decoders/builtin/ais-catcher.js"
import { createLogger } from "../../../src/utils/logger.js"
import {
	armorBitString,
	encodeType1,
	encodeType5,
	encodeType18,
	encodeType19,
	encodeType24A,
	encodeType24B,
	renderGeneratedNmeaFixture,
	renderNmeaSampleFixture,
	toNmeaFragments,
	unarmorBits,
	type Type5Fields,
} from "../../mocks/fixtures/ais/encode.js"

const logger = createLogger({ level: "error" })
const at = new Date("2026-06-15T12:00:00.000Z")

function config(): DecoderConfig {
	return {
		id: "test-ais",
		type: "ais-catcher",
		enabled: true,
		options: { outputFormat: "nmea" },
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

const mmsiArb = fc.integer({ min: 0, max: 999_999_999 })
const nameArb = fc.stringMatching(/^[A-Z0-9]([A-Z0-9 ]{0,18}[A-Z0-9])?$/)
const callsignArb = fc.stringMatching(/^[A-Z0-9]{1,7}$/)
const destinationArb = fc.stringMatching(/^[A-Z0-9]([A-Z0-9 ]{0,18}[A-Z0-9])?$/)

function expectedEta(
	month: number,
	day: number,
	hour: number,
	minute: number,
): string {
	let year = at.getUTCFullYear()
	let candidate = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
	if (candidate < at.getTime()) {
		year += 1
		candidate = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
	}
	return new Date(candidate).toISOString()
}

describe("decodeAisPayload types", () => {
	it("round-trips type 1, 5, 18 and 24 field values", () => {
		// Feature: web-gaps-1, Property 9: AIS six-bit round trip
		// Validates: Requirements 5.8
		fc.assert(
			fc.property(
				fc.record({
					mmsi: mmsiArb,
					navStatus: fc.integer({ min: 0, max: 14 }),
					sogTenths: fc.integer({ min: 0, max: 1022 }),
					lonRaw: fc.integer({ min: -108_000_000, max: 108_000_000 }),
					latRaw: fc.integer({ min: -54_000_000, max: 54_000_000 }),
					cogTenths: fc.integer({ min: 0, max: 3599 }),
					heading: fc.integer({ min: 0, max: 359 }),
				}),
				fc.record({
					mmsi: mmsiArb,
					imo: fc.integer({ min: 1, max: 9_999_999 }),
					callsign: callsignArb,
					name: nameArb,
					shipType: fc.integer({ min: 1, max: 99 }),
					month: fc.integer({ min: 1, max: 12 }),
					day: fc.integer({ min: 1, max: 28 }),
					hour: fc.integer({ min: 0, max: 23 }),
					minute: fc.integer({ min: 0, max: 59 }),
					draughtTenths: fc.integer({ min: 1, max: 255 }),
					destination: destinationArb,
				}),
				fc.record({
					mmsi: mmsiArb,
					sogTenths: fc.integer({ min: 0, max: 1022 }),
					lonRaw: fc.integer({ min: -108_000_000, max: 108_000_000 }),
					latRaw: fc.integer({ min: -54_000_000, max: 54_000_000 }),
					cogTenths: fc.integer({ min: 0, max: 3599 }),
					heading: fc.integer({ min: 0, max: 359 }),
				}),
				fc.record({
					mmsi: mmsiArb,
					name: nameArb,
					shipType: fc.integer({ min: 1, max: 99 }),
					callsign: callsignArb,
				}),
				(type1, type5, type18, type24) => {
					const decoded1 = decodeArmored(encodeType1(type1), at)
					expect(decoded1?.messageType).toBe(1)
					expect(decoded1?.mmsi).toBe(String(type1.mmsi).padStart(9, "0"))
					expect(decoded1?.navStatus).toBe(type1.navStatus)
					expect(decoded1?.sog).toBe(type1.sogTenths / 10)
					expect(decoded1?.lon).toBe(type1.lonRaw / 600000)
					expect(decoded1?.lat).toBe(type1.latRaw / 600000)
					expect(decoded1?.cog).toBe(type1.cogTenths / 10)
					expect(decoded1?.heading).toBe(type1.heading)

					const decoded5 = decodeArmored(encodeType5(type5), at)
					expect(decoded5?.messageType).toBe(5)
					expect(decoded5?.mmsi).toBe(String(type5.mmsi).padStart(9, "0"))
					expect(decoded5?.imo).toBe(type5.imo)
					expect(decoded5?.callsign).toBe(type5.callsign)
					expect(decoded5?.name).toBe(type5.name)
					expect(decoded5?.shipType).toBe(type5.shipType)
					expect(decoded5?.draught).toBe(type5.draughtTenths / 10)
					expect(decoded5?.destination).toBe(type5.destination)
					expect(decoded5?.eta?.toISOString()).toBe(
						expectedEta(type5.month, type5.day, type5.hour, type5.minute),
					)

					const decoded18 = decodeArmored(encodeType18(type18), at)
					expect(decoded18?.messageType).toBe(18)
					expect(decoded18?.mmsi).toBe(String(type18.mmsi).padStart(9, "0"))
					expect(decoded18?.sog).toBe(type18.sogTenths / 10)
					expect(decoded18?.lon).toBe(type18.lonRaw / 600000)
					expect(decoded18?.lat).toBe(type18.latRaw / 600000)
					expect(decoded18?.cog).toBe(type18.cogTenths / 10)
					expect(decoded18?.heading).toBe(type18.heading)
					expect(decoded18?.navStatus).toBeUndefined()

					const decodedA = decodeArmored(
						encodeType24A({ mmsi: type24.mmsi, name: type24.name }),
						at,
					)
					expect(decodedA?.messageType).toBe(24)
					expect(decodedA?.name).toBe(type24.name)
					expect(decodedA?.callsign).toBeUndefined()

					const decodedB = decodeArmored(
						encodeType24B({
							mmsi: type24.mmsi,
							shipType: type24.shipType,
							callsign: type24.callsign,
						}),
						at,
					)
					expect(decodedB?.shipType).toBe(type24.shipType)
					expect(decodedB?.callsign).toBe(type24.callsign)
					expect(decodedB?.name).toBeUndefined()
				},
			),
			{ numRuns: 100 },
		)
	})

	it("drops a type 5 field that is only completed by fill bits", () => {
		const fields: Type5Fields = {
			mmsi: 555678901,
			imo: 9056789,
			callsign: "GBTT",
			name: "ATLANTIC VOYAGER",
			shipType: 70,
			month: 1,
			day: 15,
			hour: 14,
			minute: 0,
			draughtTenths: 128,
			destination: "SOUTHAMPTON",
		}
		const full = encodeType5(fields)
		const bits = unarmorBits(full.payload, full.fillBits)
		const short = armorBitString(bits.slice(0, 421))
		const decoded = decodeAisPayload(short.payload, {
			fillBits: short.fillBits,
			at,
		})
		expect(decoded?.name).toBe("ATLANTIC VOYAGER")
		expect(decoded?.destination).toBeUndefined()
		expect(decoded?.draught).toBe(12.8)
	})

	it("treats space-padded @ text as absent", () => {
		const fields: Type5Fields = {
			mmsi: 555678901,
			imo: 9056789,
			callsign: "GBTT",
			name: " @@@ ".padEnd(20, " "),
			shipType: 70,
			month: 1,
			day: 15,
			hour: 14,
			minute: 0,
			draughtTenths: 128,
			destination: "SOUTHAMPTON",
		}
		const decoded = decodeArmored(encodeType5(fields), at)
		expect(decoded?.name).toBeUndefined()
		expect(decoded?.destination).toBe("SOUTHAMPTON")
	})

	it("leaves ETA absent for the not-available sentinels", () => {
		const base: Type5Fields = {
			mmsi: 1,
			imo: 1,
			callsign: "ABC",
			name: "N",
			shipType: 70,
			month: 6,
			day: 15,
			hour: 12,
			minute: 0,
			draughtTenths: 10,
			destination: "PORT",
		}
		for (const patch of [
			{ month: 0 },
			{ day: 0 },
			{ hour: 24 },
			{ minute: 60 },
		]) {
			const decoded = decodeArmored(encodeType5({ ...base, ...patch }), at)
			expect(decoded?.eta).toBeUndefined()
		}
	})

	it("uses the next real February 29 for an ETA", () => {
		const fields: Type5Fields = {
			mmsi: 1,
			imo: 1,
			callsign: "ABC",
			name: "N",
			shipType: 70,
			month: 2,
			day: 29,
			hour: 12,
			minute: 0,
			draughtTenths: 10,
			destination: "PORT",
		}
		const fromNonLeap = decodeArmored(
			encodeType5(fields),
			new Date("2026-01-15T00:00:00.000Z"),
		)
		expect(fromNonLeap?.eta?.toISOString()).toBe("2028-02-29T12:00:00.000Z")
		const afterLeapDay = decodeArmored(
			encodeType5(fields),
			new Date("2028-03-01T00:00:00.000Z"),
		)
		expect(afterLeapDay?.eta?.toISOString()).toBe("2032-02-29T12:00:00.000Z")
	})

	it("decodes the checked-in type 1 sample the way it did before", () => {
		const decoded = decodeAisPayload("13u@Dp0P00PH=3pN4T0")
		expect(decoded?.messageType).toBe(1)
		expect(decoded?.mmsi).toMatch(/^\d{9}$/)
		expect(decoded?.lat).toBeUndefined()
	})
})

describe("fragment reassembly", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("drops a bad checksum fragment without finishing or forgetting the group", () => {
		vi.useFakeTimers()
		vi.setSystemTime(at)
		const decoder = new FeedableAis(config(), logger)
		const fields: Type5Fields = {
			mmsi: 555678901,
			imo: 9056789,
			callsign: "GBTT",
			name: "ATLANTIC VOYAGER",
			shipType: 70,
			month: 1,
			day: 15,
			hour: 14,
			minute: 0,
			draughtTenths: 128,
			destination: "SOUTHAMPTON",
		}
		const armored = encodeType5(fields)
		const [first, second] = toNmeaFragments(armored.payload, armored.fillBits, {
			seqId: 3,
			channel: "B",
		})
		expect(first).toBeDefined()
		expect(second).toBeDefined()
		expect(decoder.feed(first!)).toBeNull()
		const broken = second!.slice(0, -2) + "00"
		expect(decoder.feed(broken)).toBeNull()
		expect(decoder.checksumErrors).toBe(1)
		// The bad fragment never entered, so the good one still completes.
		const output = decoder.feed(second!)
		expect(output?.type).toBe("ship")
		const ship = output?.data as { name?: string; mmsi?: string; imo?: number }
		expect(ship.mmsi).toBe("555678901")
		expect(ship.name).toBe("ATLANTIC VOYAGER")
		expect(ship.imo).toBe(9056789)
	})

	it("drops a fragment group that never receives a good replacement before timeout", () => {
		vi.useFakeTimers()
		vi.setSystemTime(at)
		const decoder = new FeedableAis(config(), logger)
		const [first, second] = toNmeaFragments(
			encodeType5(sampleType5()).payload,
			encodeType5(sampleType5()).fillBits,
			{ seqId: 3, channel: "B" },
		)
		expect(decoder.feed(first!)).toBeNull()
		const broken = second!.endsWith("00")
			? `${second!.slice(0, -2)}01`
			: `${second!.slice(0, -2)}00`
		expect(decoder.feed(broken)).toBeNull()
		vi.advanceTimersByTime(2_000)
		expect(decoder.feed(second!)).toBeNull()
		expect(decoder.checksumErrors).toBe(1)
	})

	it("drops a group when another first fragment reuses its key", () => {
		vi.useFakeTimers()
		vi.setSystemTime(at)
		const decoder = new FeedableAis(config(), logger)
		const firstGroup = fragmentsOf(sampleType5(), 4)
		const colliding = fragmentsOf(
			{
				...sampleType5(),
				mmsi: 99,
				name: "OTHER NAME",
				destination: "ELSEWHERE",
			},
			4,
		)
		expect(decoder.feed(firstGroup[0]!)).toBeNull()
		expect(decoder.feed(colliding[0]!)).toBeNull()
		expect(decoder.feed(firstGroup[1]!)).toBeNull()
		expect(decoder.feed(colliding[1]!)).toBeNull()
		const fresh = fragmentsOf(sampleType5(), 4)
		expect(decoder.feed(fresh[0]!)).toBeNull()
		const output = decoder.feed(fresh[1]!)
		expect(output?.type).toBe("ship")
		expect((output?.data as { name?: string }).name).toBe("TEST VESSEL")
	})

	// R1 m2: the talker is part of the fragment key.
	it("keeps interleaved AIVDM and AIVDO groups with the same sequence id and channel apart", () => {
		vi.useFakeTimers()
		vi.setSystemTime(at)
		const decoder = new FeedableAis(config(), logger)
		const other = encodeType5({ ...sampleType5(), mmsi: 99, name: "OWN SHIP" })
		const own = toNmeaFragments(other.payload, other.fillBits, {
			seqId: 4,
			channel: "A",
			talker: "AIVDO",
		})
		const heard = fragmentsOf(sampleType5(), 4)
		expect(own[0]?.startsWith("!AIVDO,2,1,4,A,")).toBe(true)
		expect(decoder.feed(heard[0]!)).toBeNull()
		expect(decoder.feed(own[0]!)).toBeNull()
		const a = decoder.feed(heard[1]!)
		const b = decoder.feed(own[1]!)
		expect((a?.data as { name?: string }).name).toBe("TEST VESSEL")
		expect((b?.data as { name?: string }).name).toBe("OWN SHIP")
	})

	it("drops an out-of-order or timed-out group", () => {
		vi.useFakeTimers()
		vi.setSystemTime(at)
		const decoder = new FeedableAis(config(), logger)
		const [first, second] = fragmentsOf(sampleType5())
		expect(decoder.feed(second!)).toBeNull()
		expect(decoder.feed(first!)).toBeNull()
		vi.advanceTimersByTime(2_000)
		expect(decoder.feed(second!)).toBeNull()
	})

	it("keeps a group that completes just inside the timeout", () => {
		vi.useFakeTimers()
		vi.setSystemTime(at)
		const decoder = new FeedableAis(config(), logger)
		const [first, second] = fragmentsOf(sampleType5())
		expect(decoder.feed(first!)).toBeNull()
		vi.advanceTimersByTime(1_999)
		expect(decoder.feed(second!)?.type).toBe("ship")
	})

	it("evicts the oldest group past eight pending", () => {
		vi.useFakeTimers()
		vi.setSystemTime(at)
		const decoder = new FeedableAis(config(), logger)
		const groups = Array.from({ length: 9 }, (_, seqId) =>
			fragmentsOf(sampleType5(), seqId),
		)
		for (let i = 0; i < 8; i++) expect(decoder.feed(groups[i]![0]!)).toBeNull()
		expect(decoder.feed(groups[8]![0]!)).toBeNull()
		expect(decoder.feed(groups[0]![1]!)).toBeNull()
		expect(decoder.feed(groups[8]![1]!)?.type).toBe("ship")
	})

	it("decodes a type 19 position and name", () => {
		const decoded = decodeArmored(
			encodeType19({
				mmsi: 246801357,
				sogTenths: 45,
				lonRaw: 2_940_600,
				latRaw: 31_420_560,
				cogTenths: 900,
				heading: 88,
				name: "WIND DANCER",
				shipType: 36,
			}),
			at,
		)
		expect(decoded?.sog).toBe(4.5)
		expect(decoded?.name).toBe("WIND DANCER")
		expect(decoded?.shipType).toBe(36)
		expect(decoded?.cog).toBe(90)
	})
})

describe("nmea-sample fixture", () => {
	it("matches the encoder", () => {
		const dir = dirname(fileURLToPath(import.meta.url))
		const file = join(dir, "../../mocks/fixtures/ais/nmea-sample.txt")
		expect(readFileSync(file, "utf8")).toBe(renderNmeaSampleFixture())
	})
})

describe("generated NMEA fixture", () => {
	it("matches the encoder and decodes back to the encoded fields", () => {
		const dir = dirname(fileURLToPath(import.meta.url))
		const file = join(dir, "../../mocks/fixtures/ais/generated-nmea.txt")
		const text = readFileSync(file, "utf8")
		expect(text).toBe(renderGeneratedNmeaFixture())
		const sentences = text.split("\n").filter(line => line.startsWith("!AIVDM"))
		expect(sentences.length).toBeGreaterThan(0)
		const decoder = new FeedableAis(config(), logger)
		const ships = []
		for (const sentence of sentences) {
			const output = decoder.feed(sentence)
			if (output)
				ships.push(output.data as { mmsi: string; messageType: number })
		}
		expect(ships.map(ship => ship.mmsi)).toEqual([
			"123456789",
			"567890123",
			"555678901",
			"333456789",
			"333456789",
			"246801357",
		])
		expect(ships.map(ship => ship.messageType)).toEqual([1, 18, 5, 24, 24, 19])
	})
})

function decodeArmored(
	armored: { payload: string; fillBits: number },
	reportAt: Date,
): DecodedAisPayload | null {
	return decodeAisPayload(armored.payload, {
		fillBits: armored.fillBits,
		at: reportAt,
	})
}

function sampleType5(): Type5Fields {
	return {
		mmsi: 42,
		imo: 1234567,
		callsign: "CALL",
		name: "TEST VESSEL",
		shipType: 70,
		month: 7,
		day: 4,
		hour: 8,
		minute: 30,
		draughtTenths: 50,
		destination: "DOCK",
	}
}

function fragmentsOf(fields: Type5Fields, seqId = 1): string[] {
	const armored = encodeType5(fields)
	return toNmeaFragments(armored.payload, armored.fillBits, {
		seqId,
		channel: "A",
	})
}
