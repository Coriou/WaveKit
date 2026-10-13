/**
 * Throttle identities (WG2 req 9.2): field text with a separator, or null against "", must
 * not collide, or an identity change would be held back as a plain update.
 */

import { describe, expect, it } from "vitest"
import type { AprsStation, MeshNode, VesselState } from "@wavekit/api-types"
import {
	aprsIdentity,
	meshIdentity,
	vesselIdentity,
} from "../../../src/api/server.js"

describe("entity update identities", () => {
	it("keeps separator-bearing fields apart", () => {
		const mesh = (longName: string, shortName: string) =>
			({ longName, shortName, role: 1, hwModel: 2 }) as MeshNode
		expect(meshIdentity(mesh("A|B", "C"))).not.toBe(
			meshIdentity(mesh("A", "B|C")),
		)
		const vessel = (name: string | null, callsign: string | null) =>
			({
				name,
				callsign,
				navStatus: 0,
				shipType: 70,
				destination: null,
			}) as VesselState
		expect(vesselIdentity(vessel("A|B", "C"))).not.toBe(
			vesselIdentity(vessel("A", "B|C")),
		)
		const aprs = (comment: string | null, status: string | null) =>
			({
				kind: "station",
				symbol: "/>",
				comment,
				status,
				killed: false,
			}) as AprsStation
		expect(aprsIdentity(aprs("a|b", "c"))).not.toBe(
			aprsIdentity(aprs("a", "b|c")),
		)
	})

	it("keeps null apart from an empty string and is stable for equal fields", () => {
		const vessel = (name: string | null) =>
			({
				name,
				callsign: "PDAB",
				navStatus: 0,
				shipType: 70,
				destination: "ROTTERDAM",
			}) as VesselState
		expect(vesselIdentity(vessel(null))).not.toBe(vesselIdentity(vessel("")))
		expect(vesselIdentity(vessel("X"))).toBe(vesselIdentity(vessel("X")))
	})
})
