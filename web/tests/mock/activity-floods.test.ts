import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ActivitySearchPage } from "@wavekit/api-types"

import {
	FLOOD_AIRCRAFT_INTERVAL_MS,
	FLOOD_BEACON_INTERVAL_MS,
	FLOOD_BURST_INTERVAL_MS,
	FLOOD_CALL_BURSTS,
	FLOOD_CALL_PERIOD_MS,
	floodEvents,
} from "../../mock/activity-floods.ts"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"
import { explainStack, foldActivity } from "../../src/features/activity/fold.ts"

const HOUR = 3_600_000
// a window start on every schedule's grid (multiple of 400 ms, 45 s and 180 s)
const FROM = 1_800_000_000_000 - (1_800_000_000_000 % 1_800_000)

describe("mock activity floods", () => {
	it("schedules an aircraft at 2.5/s, a beacon every 45 ± 3 s and a 24-row call every 3 min", () => {
		const events = floodEvents(FROM, FROM + 10 * 60_000)
		const by = (key: string) => events.filter(e => e.summary.entityKey === key)
		expect(by("icao:ABC123")).toHaveLength(
			(10 * 60_000) / FLOOD_AIRCRAFT_INTERVAL_MS,
		)
		const beacons = by("capcode:0042001").map(e => e.at)
		expect(beacons.length).toBeGreaterThanOrEqual(13)
		expect(beacons.length).toBeLessThanOrEqual(14)
		for (let i = 1; i < beacons.length; i++) {
			const gap = (beacons[i] ?? 0) - (beacons[i - 1] ?? 0)
			expect(Math.abs(gap - FLOOD_BEACON_INTERVAL_MS)).toBeLessThanOrEqual(6000)
		}
		const bursts = by("talkgroup:99")
		// 10 min holds 3 full periods and one more call (600 / 180 = 3.33; 0.33 × 180 = 60 s ≥ the call's 57.6 s)
		expect(bursts).toHaveLength(4 * FLOOD_CALL_BURSTS)
		expect((bursts[1]?.at ?? 0) - (bursts[0]?.at ?? 0)).toBe(
			FLOOD_BURST_INTERVAL_MS,
		)
		expect((bursts[FLOOD_CALL_BURSTS]?.at ?? 0) - (bursts[0]?.at ?? 0)).toBe(
			FLOOD_CALL_PERIOD_MS,
		)
		// sorted, and windows add up: [a, b) + [b, c) = [a, c)
		expect(events.map(e => e.at)).toEqual(
			[...events.map(e => e.at)].sort((a, b) => a - b),
		)
		const split = FROM + 123_456
		expect(
			floodEvents(FROM, split).length +
				floodEvents(split, FROM + 10 * 60_000).length,
		).toBe(events.length)
	})

	it("folds the floods into one row per thing going on", () => {
		let seq = 0
		const rows = floodEvents(FROM, FROM + HOUR / 4).map(e => {
			seq += 1
			const iso = new Date(e.at).toISOString()
			return {
				...e.summary,
				eventId: `f${seq}`,
				commitSeq: String(seq),
				producedAt: iso,
				receivedAt: iso,
			}
		})
		const stacks = foldActivity(rows)
		const of = (key: string) => stacks.filter(s => s.latest.entityKey === key)
		// 15 min of one aircraft: one stack of 2 250 rows, titled by its callsign
		expect(of("icao:ABC123")).toHaveLength(1)
		expect(of("icao:ABC123")[0]?.members).toHaveLength(2250)
		expect(of("icao:ABC123")[0]?.view.title).toBe("WKT101")
		// 15 min of beacons: one stack, called a likely idle beacon
		const beacon = of("capcode:0042001")[0]
		expect(of("capcode:0042001")).toHaveLength(1)
		expect(beacon && explainStack(beacon).headline).toMatch(
			/^Likely a paging-network idle beacon \(no content, repeats about every 4\d s\)$/,
		)
		// five calls, one stack each (122.4 s of silence between calls, past the 10 s gap); each call's first
		// call_start, sent before the radio is known, folds into it
		expect(of("talkgroup:99")).toHaveLength(5)
		expect(of("talkgroup:99").every(s => s.members.length === 24)).toBe(true)
	})

	it("sends calls as dsd-fme does: call_start with no duration, call_end with one", () => {
		const call = floodEvents(FROM, FROM + FLOOD_CALL_PERIOD_MS).filter(
			e => e.summary.entityKey === "talkgroup:99",
		)
		expect(call).toHaveLength(FLOOD_CALL_BURSTS)
		const keys = (k: number) => call[k]?.summary.fields.map(f => f.key) ?? []
		call.forEach((e, k) => {
			expect(e.data["event"]).toBe(k % 2 === 0 ? "call_start" : "call_end")
			expect(keys(k).includes("duration")).toBe(k % 2 === 1)
		})
		// the first start has no radio yet; every later row has it
		expect(keys(0)).not.toContain("source")
		expect(call[0]?.summary.title).toBe("DMR TG 99")
		expect(
			call.slice(1).every(e => e.summary.fields.some(f => f.key === "source")),
		).toBe(true)
		// an end's duration is its over (start to end), never the call's running total
		const end = call[1]?.summary.fields.find(f => f.key === "duration")
		expect(end?.value).toBe(FLOOD_BURST_INTERVAL_MS)
	})
})

describe("mock server with floods", () => {
	let server: MockServer
	beforeAll(async () => {
		server = await buildMockServer({
			port: 0,
			audioPort: 0,
			activityFloods: true,
		})
	})
	afterAll(async () => {
		await server.close()
	})

	it("seeds 30 min of beacons and calls and the last 3 min of aircraft into the history", async () => {
		const res = await server.app.inject({
			method: "GET",
			url: "/api/activity?limit=500&entityKey=capcode:0042001",
		})
		const beacons = res.json<ActivitySearchPage>().items
		// 30 min / 45 s = 40, ± one at each edge from the jitter
		expect(beacons.length).toBeGreaterThanOrEqual(39)
		expect(beacons.length).toBeLessThanOrEqual(41)
		expect(beacons[0]?.fields).toContainEqual({
			key: "label",
			label: "Label",
			value: "tone only",
		})
		const planes = (
			await server.app.inject({
				method: "GET",
				url: "/api/activity?limit=500&entityKey=icao:ABC123",
			})
		).json<ActivitySearchPage>()
		// the seeded window ends 1 s before now: 179 s × 2.5/s = 447.5
		expect(planes.items.length).toBeGreaterThanOrEqual(447)
		expect(planes.items.length).toBeLessThanOrEqual(448)
	})

	it("serves no floods unless asked (buildMockServer's default)", async () => {
		const plain = await buildMockServer({ port: 0, audioPort: 0 })
		const res = await plain.app.inject({
			method: "GET",
			url: "/api/activity?limit=50&entityKey=icao:ABC123",
		})
		expect(res.json<ActivitySearchPage>().items).toHaveLength(0)
		await plain.close()
	})
})
