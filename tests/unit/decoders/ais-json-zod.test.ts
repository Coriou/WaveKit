import { describe, expect, it } from "vitest"
import { parseJsonShip } from "../../../src/decoders/builtin/ais-catcher.js"

describe("parseJsonShip Zod validation", () => {
	it("maps aid type, virtual aid, off position and altitude", () => {
		const ship = parseJsonShip({
			mmsi: 992351234,
			type: 21,
			shipname: "AMBROSE LIGHT",
			aid_type: 14,
			virtual_aid: true,
			off_position: false,
		})
		expect(ship?.aidType).toBe(14)
		expect(ship?.virtualAid).toBe(true)
		expect(ship?.offPosition).toBe(false)
		expect(
			parseJsonShip({ mmsi: 111232511, type: 9, alt: 4094 })?.altitudeM,
		).toBe(4094)
	})

	it("ignores unknown keys", () => {
		const ship = parseJsonShip({ mmsi: 1, type: 1, rssi: -40, extra: {} })
		expect(ship?.mmsi).toBe("000000001")
		expect(ship).not.toHaveProperty("rssi")
	})

	it("drops a string aid_type but keeps the ship", () => {
		const ship = parseJsonShip({
			mmsi: 992351234,
			type: 21,
			aid_type: "14",
			lat: 40.5,
		})
		expect(ship?.aidType).toBeUndefined()
		expect(ship?.lat).toBe(40.5)
	})

	it("drops a negative alt", () => {
		const ship = parseJsonShip({ mmsi: 111232511, type: 9, alt: -5, lon: 2 })
		expect(ship?.altitudeM).toBeUndefined()
		expect(ship?.lon).toBe(2)
	})

	it("drops a boolean given as a number", () => {
		const ship = parseJsonShip({
			mmsi: 992351234,
			type: 21,
			virtual_aid: 1,
			off_position: 0,
			aid_type: 3,
		})
		expect(ship?.virtualAid).toBeUndefined()
		expect(ship?.offPosition).toBeUndefined()
		expect(ship?.aidType).toBe(3)
	})

	it("drops wrongly typed core fields one by one", () => {
		const ship = parseJsonShip({
			mmsi: 123456789,
			type: "1",
			lat: "40.1",
			lon: -74,
			shipname: 42,
			name: "FALLBACK",
		})
		expect(ship?.messageType).toBe(0)
		expect(ship?.lat).toBeUndefined()
		expect(ship?.lon).toBe(-74)
		expect(ship?.name).toBe("FALLBACK")
	})

	it("returns null for a non-object or a missing or invalid mmsi", () => {
		expect(parseJsonShip(null)).toBeNull()
		expect(parseJsonShip("x")).toBeNull()
		expect(parseJsonShip({ mmsi: null })).toBeNull()
		expect(parseJsonShip({ mmsi: { a: 1 } })).toBeNull()
	})
})
