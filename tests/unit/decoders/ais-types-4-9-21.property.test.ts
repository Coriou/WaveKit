import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	decodeAisPayload,
	type DecodedAisPayload,
} from "../../../src/decoders/builtin/ais-catcher.js"
import {
	AIS_TEXT_ALPHABET,
	armorBitString,
	encodeType21,
	encodeType4,
	encodeType9,
	sixBitChar,
	unarmorBits,
	type ArmoredPayload,
} from "../../mocks/fixtures/ais/encode.js"

const LON_NA = 108_600_000
const LAT_NA = 54_600_000

const mmsiArb = fc.integer({ min: 0, max: 2 ** 30 - 1 })
const lonArb = fc.oneof(
	fc.integer({ min: -108_000_000, max: 108_000_000 }),
	fc.constant(LON_NA),
)
const latArb = fc.oneof(
	fc.integer({ min: -54_000_000, max: 54_000_000 }),
	fc.constant(LAT_NA),
)
const nameArb = fc
	.array(fc.constantFrom(...AIS_TEXT_ALPHABET.split("")), {
		minLength: 0,
		maxLength: 34,
	})
	.map(chars => chars.join("").trim())

function expectPosition(
	decoded: DecodedAisPayload | null,
	lonRaw: number,
	latRaw: number,
): void {
	if (lonRaw === LON_NA) expect(decoded?.lon).toBeUndefined()
	else expect(decoded?.lon).toBe(lonRaw / 600000)
	if (latRaw === LAT_NA) expect(decoded?.lat).toBeUndefined()
	else expect(decoded?.lat).toBe(latRaw / 600000)
}

const decode = (armored: ArmoredPayload) =>
	decodeAisPayload(armored.payload, { fillBits: armored.fillBits })

describe("AIS types 4, 9 and 21 properties", () => {
	// Feature: web-gaps-5, Property 7: AIS round trip
	// Validates: Requirements 5.1, 5.3
	it("round-trips random type 4, 9 and 21 fields", () => {
		fc.assert(
			fc.property(mmsiArb, lonArb, latArb, (mmsi, lonRaw, latRaw) => {
				const decoded = decode(encodeType4({ mmsi, lonRaw, latRaw }))
				expect(decoded?.messageType).toBe(4)
				expect(decoded?.mmsi).toBe(String(mmsi).padStart(9, "0"))
				expectPosition(decoded, lonRaw, latRaw)
			}),
			{ numRuns: 200 },
		)
		fc.assert(
			fc.property(
				mmsiArb,
				fc.integer({ min: 0, max: 4095 }),
				fc.integer({ min: 0, max: 1023 }),
				lonArb,
				latArb,
				fc.integer({ min: 0, max: 3600 }),
				(mmsi, altitude, sogKnots, lonRaw, latRaw, cogTenths) => {
					const decoded = decode(
						encodeType9({
							mmsi,
							altitude,
							sogKnots,
							lonRaw,
							latRaw,
							cogTenths,
						}),
					)
					expect(decoded?.altitudeM).toBe(
						altitude === 4095 ? undefined : altitude,
					)
					expect(decoded?.sog).toBe(sogKnots === 1023 ? undefined : sogKnots)
					expect(decoded?.cog).toBe(
						cogTenths === 3600 ? undefined : cogTenths / 10,
					)
					expectPosition(decoded, lonRaw, latRaw)
				},
			),
			{ numRuns: 200 },
		)
		fc.assert(
			fc.property(
				fc.record({
					mmsi: mmsiArb,
					aidType: fc.integer({ min: 0, max: 31 }),
					name: nameArb,
					lonRaw: lonArb,
					latRaw: latArb,
					second: fc.integer({ min: 0, max: 63 }),
					offPosition: fc.boolean(),
					virtualAid: fc.boolean(),
					trailingBits: fc
						.array(fc.constantFrom("0", "1"), { maxLength: 5 })
						.map(bits => bits.join("")),
				}),
				fields => {
					const decoded = decode(encodeType21(fields))
					expect(decoded?.aidType).toBe(fields.aidType)
					expect(decoded?.name).toBe(
						fields.name.length > 0 ? fields.name : undefined,
					)
					expectPosition(decoded, fields.lonRaw, fields.latRaw)
					expect(decoded?.offPosition).toBe(
						fields.second <= 59 ? fields.offPosition : undefined,
					)
					expect(decoded?.virtualAid).toBe(fields.virtualAid)
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: web-gaps-5, Property 8: AIS truncation
	// Validates: Requirements 5.1, 5.2
	it("never throws on a prefix and decodes fields only from present bits", () => {
		const ends: Record<number, [keyof DecodedAisPayload, number][]> = {
			4: [
				["lon", 107],
				["lat", 134],
			],
			9: [
				["altitudeM", 50],
				["sog", 60],
				["lon", 89],
				["lat", 116],
				["cog", 128],
			],
			21: [
				["aidType", 43],
				["name", 163],
				["lon", 192],
				["lat", 219],
				["offPosition", 260],
				["virtualAid", 270],
			],
		}
		const messageArb = fc.oneof(
			fc
				.record({ mmsi: mmsiArb, lonRaw: lonArb, latRaw: latArb })
				.map(f => ({ type: 4, armored: encodeType4(f) })),
			fc
				.record({
					mmsi: mmsiArb,
					altitude: fc.integer({ min: 0, max: 4095 }),
					sogKnots: fc.integer({ min: 0, max: 1023 }),
					lonRaw: lonArb,
					latRaw: latArb,
					cogTenths: fc.integer({ min: 0, max: 3600 }),
				})
				.map(f => ({ type: 9, armored: encodeType9(f) })),
			fc
				.record({
					mmsi: mmsiArb,
					aidType: fc.integer({ min: 0, max: 31 }),
					name: nameArb,
					lonRaw: lonArb,
					latRaw: latArb,
					second: fc.integer({ min: 0, max: 63 }),
					offPosition: fc.boolean(),
					virtualAid: fc.boolean(),
				})
				.map(f => ({ type: 21, armored: encodeType21(f) })),
		)
		fc.assert(
			fc.property(messageArb, fc.nat(), ({ type, armored }, cut) => {
				const bits = unarmorBits(armored.payload, armored.fillBits)
				const length = 1 + (cut % bits.length)
				const truncated = armorBitString(bits.slice(0, length))
				const full = decode(armored)
				const decoded = decode(truncated)
				if (length < 38) {
					expect(decoded).toBeNull()
					return
				}
				for (const [field, end] of ends[type] ?? []) {
					if (length >= end) expect(decoded?.[field]).toEqual(full?.[field])
					else expect(decoded?.[field]).toBeUndefined()
				}
			}),
			{ numRuns: 300 },
		)
	})

	// Feature: web-gaps-5, Property 8: AIS truncation
	// Validates: Requirements 5.2
	it("never throws on random 6-bit strings", () => {
		const armorArb = fc
			.array(fc.integer({ min: 0, max: 63 }), { maxLength: 60 })
			.map(values => values.map(sixBitChar).join(""))
		const headerArb = fc.constantFrom(4, 9, 21).map(
			type =>
				// Type, repeat indicator and MMSI: 38 bits, then random characters.
				armorBitString(type.toString(2).padStart(6, "0") + "0".repeat(32))
					.payload,
		)
		fc.assert(
			fc.property(
				fc.oneof(
					armorArb,
					fc.tuple(headerArb, armorArb).map(p => p[0] + p[1]),
				),
				fc.integer({ min: 0, max: 5 }),
				(payload, fillBits) => {
					expect(() => decodeAisPayload(payload, { fillBits })).not.toThrow()
					const decoded = decodeAisPayload(payload, { fillBits })
					if (decoded?.name !== undefined) {
						expect(decoded.name.length).toBeLessThanOrEqual(34)
					}
					if (decoded?.aidType !== undefined) {
						expect(decoded.aidType).toBeLessThanOrEqual(31)
					}
					if (decoded?.altitudeM !== undefined) {
						expect(decoded.altitudeM).toBeLessThanOrEqual(4094)
					}
				},
			),
			{ numRuns: 300 },
		)
	})
})
