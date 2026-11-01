import { describe, expect, it } from "vitest"
import type { ActivitySummary } from "@wavekit/api-types"

import { rowView, storedAircraft } from "../../src/features/activity/rows.ts"

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
})
