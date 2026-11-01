import { describe, expect, it } from "vitest"
import type { ActivitySummary } from "@wavekit/api-types"

import {
	FLOOD_AIRCRAFT_INTERVAL_MS,
	floodEvents,
} from "../../mock/activity-floods.ts"
import {
	explainStack,
	firstSeenOf,
	foldActivity,
	receptionsOf,
	timeOf,
} from "../../src/features/activity/fold.ts"

const T0 = Date.parse("2026-10-13T00:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()

/** A merged aircraft row as the core stores it: one per 60 s, `coalesced` for the receptions it stands for. */
function merged(seq: number, at: number, receptions?: number): ActivitySummary {
	return {
		eventId: `e${seq}`,
		commitSeq: String(seq),
		kind: "decoder-reception",
		producedAt: iso(at),
		receivedAt: iso(at),
		decoderId: "readsb",
		sourceId: null,
		protocol: "adsb",
		category: "aircraft",
		frequencyHz: 1_090_000_000,
		entityKey: "icao:A0B001",
		title: "TST001",
		fields: [{ key: "callsign", label: "Callsign", value: "TST001" }],
		...(receptions === undefined
			? {}
			: {
					coalesced: {
						receptions,
						firstSeenAt: iso(at - 59_500),
						lastSeenAt: iso(at),
					},
				}),
	}
}

describe("Activity folding of the core's merged entity rows", () => {
	it("counts receptions, not rows, and spans from the first merged reception", () => {
		const rows = [
			merged(1, T0),
			merged(2, T0 + 60_000, 120),
			merged(3, T0 + 120_000, 118),
		]
		expect(rows.map(receptionsOf)).toEqual([1, 120, 118])
		expect(firstSeenOf(rows[1] as ActivitySummary)).toBe(T0 + 500)
		const [stack] = foldActivity(rows)
		expect(stack?.members).toHaveLength(3)
		expect(stack?.receptions).toBe(239)
		expect(stack?.firstMs).toBe(T0)
		expect(explainStack(stack!).headline).toBe(
			"Likely one aircraft in range for 2 min (239 times)",
		)
	})

	it("explains a single merged row as many receptions", () => {
		const [stack] = foldActivity([merged(1, T0 + 60_000, 120)])
		expect(stack?.firstMs).toBe(T0 + 500)
		expect(explainStack(stack!).headline).toBe(
			"Likely one aircraft in range for 1 min (120 times)",
		)
	})

	it("ignores a malformed span or count", () => {
		const bad = {
			...merged(1, T0),
			coalesced: {
				receptions: Number.NaN,
				firstSeenAt: "nope",
				lastSeenAt: iso(T0),
			},
		}
		expect(receptionsOf(bad)).toBe(1)
		expect(firstSeenOf(bad)).toBe(T0)
	})

	it("dates a flushed row when its latest reception was heard, not when it was stored", () => {
		// The final flush of a fading aircraft: stamped at store time, heard 55 s before.
		const flushed: ActivitySummary = {
			...merged(2, T0 + 60_000),
			coalesced: {
				receptions: 3,
				firstSeenAt: iso(T0 + 1_000),
				lastSeenAt: iso(T0 + 5_000),
			},
		}
		expect(timeOf(flushed)).toBe(T0 + 5_000)
		// A reception's own merged row (lastSeenAt is its receivedAt) keeps producedAt.
		const own: ActivitySummary = {
			...merged(3, T0 + 120_000, 2),
			producedAt: iso(T0 + 119_900),
		}
		expect(timeOf(own)).toBe(T0 + 119_900)
		// A row without a span, or with an unparseable one, keeps producedAt.
		expect(timeOf(merged(4, T0))).toBe(T0)
		expect(
			timeOf({
				...merged(5, T0 + 60_000),
				coalesced: { receptions: 2, firstSeenAt: "x", lastSeenAt: "nope" },
			}),
		).toBe(T0 + 60_000)
		// The stack spans to the heard time; the list keeps commitSeq order.
		const [stack] = foldActivity([merged(1, T0, 1), flushed])
		expect(stack?.lastMs).toBe(T0 + 5_000)
		expect(stack?.latest.eventId).toBe("e2")
	})

	it("the mock's full aircraft rows carry the core's coalesced shape", () => {
		const full = floodEvents(T0, T0 + 10_000).filter(
			e => e.summary.entityKey === "icao:ABC123" && e.summary.fields.length > 0,
		)
		expect(full.length).toBeGreaterThan(0)
		for (const e of full) expect(e.receptions).toBe(10)
		expect(FLOOD_AIRCRAFT_INTERVAL_MS * 9).toBe(3_600)
	})
})
