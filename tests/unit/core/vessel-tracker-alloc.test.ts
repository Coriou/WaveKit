import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { VesselAton, VesselState } from "@wavekit/api-types"
import { VesselTracker } from "../../../src/core/vessel-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "error" })
const T0 = Date.UTC(2026, 9, 16, 12)

interface FrozenFields {
	aton: VesselAton | null
	altitudeM: number | null
}

/**
 * Frozen copy of the pre-WG7 class-field logic (one new aton object per type 21).
 * vesselClass comes from the emitted state; its derivation did not change.
 */
function frozenApply(
	fields: FrozenFields,
	vesselClass: VesselState["vesselClass"],
	report: Record<string, unknown>,
): { aton: VesselAton | null; altitudeM: number | null } {
	const aidType = report["aidType"]
	const altitudeM = report["altitudeM"]
	if (report["messageType"] === 21) {
		fields.aton = {
			aidType:
				typeof aidType === "number" &&
				Number.isInteger(aidType) &&
				aidType >= 0 &&
				aidType <= 31
					? aidType
					: null,
			virtual: (report["virtualAid"] as boolean | undefined) ?? null,
			offPosition: (report["offPosition"] as boolean | undefined) ?? null,
		}
	}
	if (report["messageType"] === 9) {
		fields.altitudeM =
			typeof altitudeM === "number" &&
			Number.isInteger(altitudeM) &&
			altitudeM >= 0 &&
			altitudeM <= 4094
				? altitudeM
				: null
	}
	return {
		aton: vesselClass === "aton" ? fields.aton : null,
		altitudeM: vesselClass === "sar" ? fields.altitudeM : null,
	}
}

const reportArb = fc.record(
	{
		mmsi: fc.constantFrom("1", "2", "3"),
		messageType: fc.constantFrom(1, 3, 4, 5, 9, 18, 21, 24),
		aidType: fc.oneof(fc.integer({ min: -2, max: 40 }), fc.constant(null)),
		virtualAid: fc.oneof(fc.boolean(), fc.constant(null)),
		offPosition: fc.oneof(fc.boolean(), fc.constant(null)),
		altitudeM: fc.oneof(fc.integer({ min: -5, max: 5000 }), fc.constant(null)),
		name: fc.oneof(fc.constant("BUOY"), fc.constant(null)),
		lat: fc.double({ min: -90, max: 90, noNaN: true }),
		lon: fc.double({ min: -180, max: 180, noNaN: true }),
	},
	{ requiredKeys: ["mmsi", "messageType"] },
)

describe("VesselTracker class-field reuse", () => {
	it("keeps one aton object per vessel across type 21 messages", () => {
		const tracker = new VesselTracker({ now: () => T0 }, logger)
		tracker.processShip("ais", {
			mmsi: "992350001",
			messageType: 21,
			aidType: 1,
			virtualAid: false,
			offPosition: false,
		})
		const first = tracker.get("992350001")?.aton
		expect(first).not.toBeNull()
		tracker.processShip("ais", {
			mmsi: "992350001",
			messageType: 21,
			aidType: 30,
			virtualAid: true,
			offPosition: null,
		})
		const second = tracker.get("992350001")?.aton
		expect(second).toBe(first)
		expect(second).toEqual({ aidType: 30, virtual: true, offPosition: null })
	})

	it("pins the live-reference contract: a shallow copy sees later aton updates, a structuredClone does not", () => {
		const tracker = new VesselTracker({ now: () => T0 }, logger)
		tracker.processShip("ais", {
			mmsi: "992350002",
			messageType: 21,
			aidType: 1,
			virtualAid: false,
			offPosition: false,
		})
		const state = tracker.get("992350002") as VesselState
		const atonBefore = state.aton
		const shallow = { ...state }
		const deep = structuredClone(state)
		tracker.processShip("ais", {
			mmsi: "992350002",
			messageType: 21,
			aidType: 30,
			virtualAid: false,
			offPosition: false,
		})
		expect(state.aton).toBe(atonBefore)
		expect(shallow.aton).toBe(state.aton)
		expect(shallow.aton?.aidType).toBe(30)
		expect(deep.aton?.aidType).toBe(1)
	})

	it("keeps one class-field object per vessel", () => {
		const tracker = new VesselTracker({ now: () => T0 }, logger)
		const peek = (state: VesselState): unknown =>
			(
				tracker as unknown as {
					classFields: WeakMap<VesselState, unknown>
				}
			).classFields.get(state)
		tracker.processShip("ais", { mmsi: "1", messageType: 9, altitudeM: 100 })
		const state = tracker.get("1") as VesselState
		const fields = peek(state)
		tracker.processShip("ais", { mmsi: "1", messageType: 21, aidType: 3 })
		tracker.processShip("ais", { mmsi: "1", messageType: 9, altitudeM: 200 })
		expect(peek(state)).toBe(fields)
	})

	// Feature: web-gaps-7, Property AIS tracker reuse: emitted vessel DTOs equal the frozen tracker's
	// Validates: Requirements 10.6
	it("emits the same DTOs as the frozen class-field logic", () => {
		fc.assert(
			fc.property(fc.array(reportArb, { maxLength: 40 }), reports => {
				const tracker = new VesselTracker({ now: () => T0 }, logger)
				const emitted: string[] = []
				const record = (state: VesselState): void => {
					emitted.push(JSON.stringify(state))
				}
				tracker.on("vessel:new", record)
				tracker.on("vessel:update", record)
				const frozen = new Map<string, FrozenFields>()
				const expected: { aton: unknown; altitudeM: unknown }[] = []
				reports.forEach((report, index) => {
					const before = emitted.length
					tracker.processShip("ais", report, new Date(T0 + index * 1000))
					if (emitted.length === before) return
					const state = JSON.parse(emitted[before] as string) as VesselState
					let fields = frozen.get(state.mmsi)
					if (!fields) {
						fields = { aton: null, altitudeM: null }
						frozen.set(state.mmsi, fields)
					}
					expected.push(frozenApply(fields, state.vesselClass, report))
				})
				expect(
					emitted.map(text => {
						const state = JSON.parse(text) as VesselState
						return { aton: state.aton, altitudeM: state.altitudeM }
					}),
				).toEqual(expected)
			}),
			{ numRuns: 200 },
		)
	})
})
