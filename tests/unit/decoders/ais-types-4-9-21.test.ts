import { describe, expect, it } from "vitest"
import {
	decodeAisPayload,
	parseNmeaSentence,
	type DecodedAisPayload,
} from "../../../src/decoders/builtin/ais-catcher.js"
import {
	armorBitString,
	encodeType21,
	encodeType4,
	encodeType9,
	toNmeaSentence,
	unarmorBits,
	type ArmoredPayload,
	type Type21Fields,
	type Type9Fields,
} from "../../mocks/fixtures/ais/encode.js"

const decode = (armored: ArmoredPayload) =>
	decodeAisPayload(armored.payload, { fillBits: armored.fillBits })

const prefix = (armored: ArmoredPayload, length: number) => {
	const bits = unarmorBits(armored.payload, armored.fillBits).slice(0, length)
	return armorBitString(bits)
}

const type9: Type9Fields = {
	mmsi: 111232511,
	altitude: 305,
	sogKnots: 120,
	lonRaw: -3_000_000,
	latRaw: 30_000_000,
	cogTenths: 2705,
}

const type21: Type21Fields = {
	mmsi: 992351234,
	aidType: 14,
	name: "AMBROSE LIGHT",
	lonRaw: -44_426_700,
	latRaw: 24_413_520,
	second: 30,
	offPosition: true,
	virtualAid: false,
}

/** Field name and the bit that must be present for it (exclusive end). */
type FieldEnds = [keyof DecodedAisPayload, number][]

function expectTruncation(armored: ArmoredPayload, ends: FieldEnds): void {
	const full = unarmorBits(armored.payload, armored.fillBits).length
	const complete = decode(armored)
	for (let length = 38; length <= full; length++) {
		const decoded = decode(prefix(armored, length))
		expect(decoded).not.toBeNull()
		for (const [field, end] of ends) {
			if (length >= end) expect(decoded?.[field]).toEqual(complete?.[field])
			else expect(decoded?.[field]).toBeUndefined()
		}
	}
}

describe("AIS type 4 base station", () => {
	it("decodes the position", () => {
		const decoded = decode(
			encodeType4({ mmsi: 3669702, lonRaw: -44_403_600, latRaw: 24_427_680 }),
		)
		expect(decoded?.messageType).toBe(4)
		expect(decoded?.mmsi).toBe("003669702")
		expect(decoded?.lon).toBeCloseTo(-74.006, 6)
		expect(decoded?.lat).toBeCloseTo(40.7128, 6)
	})

	it("omits lon 181 and lat 91", () => {
		const decoded = decode(
			encodeType4({ mmsi: 3669702, lonRaw: 108_600_000, latRaw: 54_600_000 }),
		)
		expect(decoded?.lon).toBeUndefined()
		expect(decoded?.lat).toBeUndefined()
	})

	it("omits each field when truncated at every boundary", () => {
		expectTruncation(
			encodeType4({ mmsi: 3669702, lonRaw: 1_000, latRaw: -2_000 }),
			[
				["lon", 107],
				["lat", 134],
			],
		)
	})
})

describe("AIS type 9 SAR aircraft", () => {
	it("decodes altitude, whole-knot sog, position and course", () => {
		const decoded = decode(encodeType9(type9))
		expect(decoded?.messageType).toBe(9)
		expect(decoded?.altitudeM).toBe(305)
		expect(decoded?.sog).toBe(120)
		expect(decoded?.lon).toBeCloseTo(-5, 6)
		expect(decoded?.lat).toBeCloseTo(50, 6)
		expect(decoded?.cog).toBe(270.5)
	})

	it("omits altitude 4095 and keeps 4094", () => {
		expect(
			decode(encodeType9({ ...type9, altitude: 4095 }))?.altitudeM,
		).toBeUndefined()
		expect(decode(encodeType9({ ...type9, altitude: 4094 }))?.altitudeM).toBe(
			4094,
		)
	})

	it("omits sog 1023, cog 3600, lon 181 and lat 91", () => {
		const decoded = decode(
			encodeType9({
				...type9,
				sogKnots: 1023,
				cogTenths: 3600,
				lonRaw: 108_600_000,
				latRaw: 54_600_000,
			}),
		)
		expect(decoded?.sog).toBeUndefined()
		expect(decoded?.cog).toBeUndefined()
		expect(decoded?.lon).toBeUndefined()
		expect(decoded?.lat).toBeUndefined()
		expect(decoded?.altitudeM).toBe(305)
	})

	it("omits each field when truncated at every boundary", () => {
		expectTruncation(encodeType9(type9), [
			["altitudeM", 50],
			["sog", 60],
			["lon", 89],
			["lat", 116],
			["cog", 128],
		])
	})

	it("carries altitude through parseNmeaSentence", () => {
		const armored = encodeType9(type9)
		const ship = parseNmeaSentence(
			toNmeaSentence(armored.payload, armored.fillBits, { channel: "B" }),
		)
		expect(ship?.altitudeM).toBe(305)
		expect(ship?.channel).toBe("B")
	})
})

describe("AIS type 21 aid to navigation", () => {
	it("decodes aid type, name, position and flags", () => {
		const decoded = decode(encodeType21(type21))
		expect(decoded?.messageType).toBe(21)
		expect(decoded?.aidType).toBe(14)
		expect(decoded?.name).toBe("AMBROSE LIGHT")
		expect(decoded?.lon).toBeCloseTo(-74.0445, 6)
		expect(decoded?.lat).toBeCloseTo(40.6892, 6)
		expect(decoded?.offPosition).toBe(true)
		expect(decoded?.virtualAid).toBe(false)
	})

	it("joins the name extension up to 34 characters", () => {
		const name = "NORTH CHANNEL RANGE FRONT LIGHT 12"
		expect(name).toHaveLength(34)
		expect(decode(encodeType21({ ...type21, name }))?.name).toBe(name)
	})

	it("keeps a space at the extension boundary", () => {
		const name = "ABCDEFGHIJKLMNOPQRS EXT"
		expect(decode(encodeType21({ ...type21, name }))?.name).toBe(name)
	})

	it("ignores an extension of 5 bits", () => {
		const decoded = decode(encodeType21({ ...type21, trailingBits: "11111" }))
		expect(decoded?.name).toBe("AMBROSE LIGHT")
	})

	it("omits a name that is all @", () => {
		const decoded = decode(encodeType21({ ...type21, name: "" }))
		expect(decoded?.name).toBeUndefined()
		expect(decoded?.aidType).toBe(14)
	})

	it.each([60, 61, 62, 63])("omits offPosition when second is %i", second => {
		const decoded = decode(encodeType21({ ...type21, second }))
		expect(decoded?.offPosition).toBeUndefined()
		expect(decoded?.virtualAid).toBe(false)
	})

	it("decodes second 59 and a virtual aid", () => {
		const decoded = decode(
			encodeType21({
				...type21,
				second: 59,
				offPosition: false,
				virtualAid: true,
			}),
		)
		expect(decoded?.offPosition).toBe(false)
		expect(decoded?.virtualAid).toBe(true)
	})

	it("omits lon 181 and lat 91", () => {
		const decoded = decode(
			encodeType21({ ...type21, lonRaw: 108_600_000, latRaw: 54_600_000 }),
		)
		expect(decoded?.lon).toBeUndefined()
		expect(decoded?.lat).toBeUndefined()
	})

	it("omits each field when truncated at every boundary", () => {
		expectTruncation(encodeType21(type21), [
			["aidType", 43],
			["name", 163],
			["lon", 192],
			["lat", 219],
			["offPosition", 260],
			["virtualAid", 270],
		])
	})

	it("carries the aid fields through parseNmeaSentence", () => {
		const armored = encodeType21({ ...type21, virtualAid: true })
		const ship = parseNmeaSentence(
			toNmeaSentence(armored.payload, armored.fillBits),
		)
		expect(ship?.name).toBe("AMBROSE LIGHT")
		expect(ship?.aidType).toBe(14)
		expect(ship?.virtualAid).toBe(true)
		expect(ship?.offPosition).toBe(true)
		expect(ship?.lat).toBeCloseTo(40.6892, 6)
	})
})
