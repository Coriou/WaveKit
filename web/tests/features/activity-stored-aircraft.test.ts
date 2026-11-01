import { describe, expect, it } from "vitest"
import type { ActivitySummary } from "@wavekit/api-types"

import {
	rowAircraft,
	rowView,
	storedAircraft,
} from "../../src/features/activity/rows.ts"

const AT = "2026-10-13T00:00:00.000Z"

/** An ADS-B row as the core stores it: titled by the ICAO address, with the identity known when stored. */
function row(aircraft?: ActivitySummary["aircraft"]): ActivitySummary {
	return {
		eventId: "e1",
		commitSeq: "1",
		kind: "decoder-reception",
		producedAt: AT,
		receivedAt: AT,
		decoderId: "readsb",
		sourceId: null,
		protocol: "adsb",
		category: "aircraft",
		frequencyHz: 1_090_000_000,
		entityKey: "icao:A0B001",
		title: "A0B001",
		fields: [{ key: "altitude", label: "Altitude", value: 35_000, unit: "ft" }],
		...(aircraft === undefined ? {} : { aircraft }),
	}
}

describe("Activity rows of an aircraft the fleet no longer tracks", () => {
	it("title and subtitle come from the identity stored with the row", () => {
		const v = rowView(
			row({
				registration: "N0WK01",
				typeCode: "A320",
				typeDescription: "Airbus A320",
				operator: "WaveKit Air",
			}),
		)
		expect(v.title).toBe("N0WK01")
		expect(v.subtitle).toContain("WaveKit Air · Airbus A320")
	})

	it("prefers the stored callsign, and the type code when there is no description", () => {
		const s = row({
			callsign: "WKA01 ",
			registration: "N0WK01",
			typeCode: "A320",
		})
		expect(storedAircraft(s)).toEqual({ name: "WKA01", about: "A320" })
		expect(rowView(s).title).toBe("WKA01")
	})

	it("the live fleet wins over the stored identity", () => {
		const v = rowView(row({ registration: "N0WK01" }), {
			name: "WKA99",
			about: "Live Air",
		})
		expect(v.title).toBe("WKA99")
		expect(v.subtitle).toContain("Live Air")
	})

	it("a row without a stored identity keeps its own title", () => {
		expect(storedAircraft(row())).toBeNull()
		expect(rowView(row()).title).toBe("A0B001")
	})

	it("a live name that is only the hex address never hides the stored identity", () => {
		const s = row({ registration: "N0WK01", operator: "WaveKit Air" })
		const v = rowView(s, { name: "A0B001", about: "" })
		expect(v.title).toBe("N0WK01")
		expect(v.subtitle).toContain("WaveKit Air")
		expect(rowAircraft(s, { name: "a0b001", about: "Live Air" })).toEqual({
			name: "N0WK01",
			about: "WaveKit Air",
		})
	})

	it("a historical row keeps the callsign it was stored with", () => {
		// The aircraft flies as WKA02 now; this row was heard as WKA01.
		const s = row({ callsign: "WKA01", typeCode: "A320" })
		expect(rowAircraft(s, { name: "WKA02", about: "Live Air · A321" })).toEqual(
			{ name: "WKA01", about: "A320" },
		)
	})

	it("fills each missing field from the live fleet", () => {
		// Stored: an operator but no name; live: a callsign.
		expect(
			rowAircraft(row({ operator: "WaveKit Air" }), {
				name: "WKA03",
				about: "Live Air",
			}),
		).toEqual({ name: "WKA03", about: "WaveKit Air" })
		// Nothing stored: the live fleet as it is, even its hex fallback.
		expect(rowAircraft(row(), { name: "A0B001", about: "Live Air" })).toEqual({
			name: "A0B001",
			about: "Live Air",
		})
		expect(rowAircraft(row(), null)).toBeNull()
	})
})
