/**
 * WG5 vessel channel, AtoN and SAR altitude fields.
 */

import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { VesselTracker } from "../../../src/core/vessel-tracker.js"
import { decodeAisPayload } from "../../../src/decoders/builtin/ais-catcher.js"
import { encodeType9 } from "../../mocks/fixtures/ais/encode.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "error" })
const T0 = new Date("2026-06-15T12:00:00.000Z")

function tracker() {
	return new VesselTracker({}, logger)
}

describe("VesselTracker WG5 fields", () => {
	it("keeps a type 9 SAR sog above 102.3 knots from decoder to tracker", () => {
		const armored = encodeType9({
			mmsi: 111232511,
			altitude: 300,
			sogKnots: 120,
			lonRaw: 1_200_000,
			latRaw: 30_000_000,
			cogTenths: 900,
		})
		const decoded = decodeAisPayload(armored.payload, {
			fillBits: armored.fillBits,
		})
		expect(decoded?.sog).toBe(120)
		const t = tracker()
		t.processShip(
			"d",
			{ mmsi: "111232511", messageType: 9, sog: decoded?.sog },
			T0,
		)
		expect(t.get("111232511")?.sog).toBe(120)
		t.processShip("d", { mmsi: "111232512", messageType: 1, sog: 120 }, T0)
		expect(t.get("111232512")?.sog).toBeNull()
	})

	it("is null for channel, aton and altitude before any carry", () => {
		const t = tracker()
		t.processShip("d", { mmsi: "1", messageType: 1 }, T0)
		expect(t.get("1")).toMatchObject({
			channel: null,
			aton: null,
			altitudeM: null,
		})
	})

	it("keeps the channel when a message has none and updates it when one does", () => {
		const t = tracker()
		t.processShip("d", { mmsi: "1", messageType: 1, channel: "A" }, T0)
		t.processShip("d", { mmsi: "1", messageType: 3 }, T0)
		expect(t.get("1")?.channel).toBe("A")
		t.processShip("d", { mmsi: "1", messageType: 3, channel: "B" }, T0)
		expect(t.get("1")?.channel).toBe("B")
	})

	it("sets aton only for class aton, from the newest type 21", () => {
		const t = tracker()
		t.processShip(
			"d",
			{
				mmsi: "2",
				messageType: 21,
				aidType: 5,
				virtualAid: true,
				offPosition: false,
			},
			T0,
		)
		expect(t.get("2")?.aton).toEqual({
			aidType: 5,
			virtual: true,
			offPosition: false,
		})
		t.processShip("d", { mmsi: "2", messageType: 21, aidType: 7 }, T0)
		expect(t.get("2")?.aton).toEqual({
			aidType: 7,
			virtual: null,
			offPosition: null,
		})
		t.processShip("d", { mmsi: "2", messageType: 4 }, T0)
		expect(t.get("2")?.vesselClass).toBe("base-station")
		expect(t.get("2")?.aton).toBeNull()
		t.processShip("d", { mmsi: "3", messageType: 1, aidType: 5 }, T0)
		expect(t.get("3")?.aton).toBeNull()
	})

	it("sets altitude only for class sar, from the newest type 9", () => {
		const t = tracker()
		t.processShip("d", { mmsi: "4", messageType: 9, altitudeM: 150 }, T0)
		expect(t.get("4")?.altitudeM).toBe(150)
		t.processShip("d", { mmsi: "4", messageType: 9 }, T0)
		expect(t.get("4")?.altitudeM).toBeNull()
		t.processShip("d", { mmsi: "4", messageType: 9, altitudeM: 4094 }, T0)
		expect(t.get("4")?.altitudeM).toBe(4094)
		t.processShip("d", { mmsi: "5", messageType: 1, altitudeM: 10 }, T0)
		expect(t.get("5")?.altitudeM).toBeNull()
	})

	it("ignores wrongly typed new fields without dropping the report", () => {
		const t = tracker()
		t.processShip(
			"d",
			{ mmsi: "6", messageType: 21, channel: "C", aidType: "x", virtualAid: 1 },
			T0,
		)
		expect(t.get("6")).toMatchObject({
			channel: null,
			aton: { aidType: null, virtual: null, offPosition: null },
		})
	})

	// Feature: web-gaps-5, Property 9: Vessel channel and class fields
	// Validates: Requirements 5.5, 5.6
	it("Property 9: vessel channel and class fields over random sequences", () => {
		const message = fc.record({
			messageType: fc.constantFrom(1, 3, 4, 5, 9, 11, 18, 21, 24),
			channel: fc.option(fc.constantFrom("A", "B"), { nil: undefined }),
			altitudeM: fc.option(fc.integer({ min: 0, max: 4094 }), {
				nil: undefined,
			}),
			aidType: fc.option(fc.integer({ min: 0, max: 31 }), { nil: undefined }),
			virtualAid: fc.option(fc.boolean(), { nil: undefined }),
			offPosition: fc.option(fc.boolean(), { nil: undefined }),
		})
		fc.assert(
			fc.property(fc.array(message, { minLength: 1, maxLength: 30 }), seq => {
				const t = tracker()
				let channel: string | null = null
				let last21: (typeof seq)[number] | undefined
				let last9: (typeof seq)[number] | undefined
				const types = new Set<number>()
				for (const m of seq) {
					t.processShip("d", { mmsi: "123456789", ...m }, T0)
					if (m.channel !== undefined) channel = m.channel
					if (m.messageType === 21) last21 = m
					if (m.messageType === 9) last9 = m
					types.add(m.messageType)
				}
				const v = t.get("123456789")
				expect(v?.channel).toBe(channel)
				const base = types.has(4) || types.has(11)
				if (!base && last21) {
					expect(v?.vesselClass).toBe("aton")
					expect(v?.aton).toEqual({
						aidType: last21.aidType ?? null,
						virtual: last21.virtualAid ?? null,
						offPosition: last21.offPosition ?? null,
					})
				} else {
					expect(v?.aton).toBeNull()
				}
				if (!base && !last21 && last9) {
					expect(v?.vesselClass).toBe("sar")
					expect(v?.altitudeM).toBe(last9.altitudeM ?? null)
				} else {
					expect(v?.altitudeM).toBeNull()
				}
			}),
			{ numRuns: 200 },
		)
	})
})
