/**
 * `aircraft` channel publisher: ≤ 1 update per aircraft per second with the latest state, the
 * trail as `trackAppend` deltas, the full trail on new / first sight / reset / resync, and the
 * final state carried by `aircraft:lost`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fc from "fast-check"
import type {
	AircraftState,
	AircraftUpdateData,
	TrackPoint,
} from "@wavekit/api-types"
import {
	AIRCRAFT_TRAIL_RESYNC_UPDATES,
	AIRCRAFT_UPDATE_MAX_KEYS,
	AIRCRAFT_UPDATE_WINDOW_MS,
	AircraftUpdatePublisher,
	type AircraftUpdatePublisherOptions,
} from "../../../src/api/websocket/aircraft-updates.js"
import { AircraftTracker } from "../../../src/core/aircraft-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })

type Sent =
	| { type: "new"; state: AircraftState }
	| { type: "update"; data: AircraftUpdateData; at: number }
	| { type: "lost"; icao: string; state: AircraftState }

function harness(options: Partial<AircraftUpdatePublisherOptions> = {}) {
	const sent: Sent[] = []
	const tracker = new AircraftTracker({}, logger)
	const publisher = new AircraftUpdatePublisher({
		publishNew: state => sent.push({ type: "new", state }),
		publishUpdate: data =>
			sent.push({
				type: "update",
				data: structuredClone(data),
				at: Date.now(),
			}),
		publishLost: (icao, state) => sent.push({ type: "lost", icao, state }),
		...options,
	})
	tracker.on("aircraft:new", s => publisher.onNew(s))
	tracker.on("aircraft:update", s => publisher.onUpdate(s))
	tracker.on("aircraft:lost", (icao, s) => publisher.onLost(icao, s))
	let step = 0
	/** One decoded message; each moves the aircraft ~1.1 km so it adds a trail point. */
	const hear = (hex = "A00001", extra: Record<string, unknown> = {}) => {
		step += 1
		tracker.processUpdate({
			hex,
			flight: "WKA100",
			squawk: "1000",
			lat: 50 + step * 0.01,
			lon: 4,
			alt_baro: 30_000,
			...extra,
		})
	}
	const updates = () => sent.flatMap(m => (m.type === "update" ? [m] : []))
	return { sent, tracker, publisher, hear, updates }
}

describe("AircraftUpdatePublisher", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: Date.parse("2026-11-01T00:00:00.000Z") })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("states its bounds", () => {
		expect(AIRCRAFT_UPDATE_WINDOW_MS).toBe(1000)
		expect(AIRCRAFT_TRAIL_RESYNC_UPDATES).toBe(300)
		expect(AIRCRAFT_UPDATE_MAX_KEYS).toBe(10_000)
	})

	it("sends one update per second per aircraft, the latest state, and never loses the last", () => {
		const { hear, updates, tracker } = harness()
		hear() // new
		for (let i = 0; i < 10; i++) {
			hear()
			vi.advanceTimersByTime(100)
		}
		// first update at once, the other nine coalesced into the trailing one at 1 s
		vi.advanceTimersByTime(1000)
		const got = updates()
		expect(got).toHaveLength(2)
		expect(got[1]!.at - got[0]!.at).toBeGreaterThanOrEqual(1000)
		const state = tracker.get("A00001")!
		expect(got[1]!.data.position).toEqual(state.position)
		expect(got[1]!.data.messages).toBe(state.messages)
	})

	it("sends a callsign, squawk or emergency change at once", () => {
		const { hear, updates } = harness()
		hear()
		hear()
		hear("A00001", { squawk: "7700" })
		expect(updates().map(u => u.data.squawk)).toEqual(["1000", "7700"])
	})

	it("drops the pending update on lost; the lost message carries the final state", () => {
		const { hear, sent, tracker, publisher } = harness()
		hear()
		hear()
		hear()
		const final = tracker.get("A00001")!
		publisher.onLost("A00001", final)
		vi.advanceTimersByTime(5000)
		expect(sent.map(m => m.type)).toEqual(["new", "update", "lost"])
		expect(sent.at(-1)).toMatchObject({ type: "lost", state: final })
	})

	it("sends the full trail with new, then only the new points", () => {
		const { hear, sent, updates } = harness()
		hear()
		expect(sent[0]).toMatchObject({ type: "new" })
		hear() // sent at once
		hear() // these two coalesce into the trailing update
		hear()
		vi.advanceTimersByTime(1000)
		const [first, second] = updates()
		expect(first!.data.trackHistory).toBeUndefined()
		expect(first!.data.trackAppend).toHaveLength(1)
		expect(second!.data.trackHistory).toBeUndefined()
		// two points since the previous update, most recent first
		expect(second!.data.trackAppend).toHaveLength(2)
		const [a, b] = second!.data.trackAppend!
		expect(a!.timestamp).toBeGreaterThanOrEqual(b!.timestamp)
	})

	it("sends no trail field when the trail did not change", () => {
		const { hear, tracker, updates } = harness()
		hear()
		vi.advanceTimersByTime(1000)
		tracker.applyIdentification("A00001", { registration: "F-WAVE" })
		const u = updates().at(-1)!
		expect(u.data.identification?.registration).toBe("F-WAVE")
		expect(u.data.trackAppend).toBeUndefined()
		expect(u.data.trackHistory).toBeUndefined()
	})

	it("sends the full trail for an aircraft it never saw new, and when the last point sent is gone", () => {
		const { hear, tracker, publisher, updates } = harness()
		// another tracker knew the aircraft before this publisher listened
		const earlier = new AircraftTracker({}, logger)
		earlier.processUpdate({ hex: "B00002", lat: 1, lon: 1 })
		publisher.onUpdate(earlier.get("B00002")!)
		expect(updates()[0]!.data.trackHistory).toHaveLength(1)

		hear()
		vi.advanceTimersByTime(1000)
		hear()
		vi.advanceTimersByTime(1000)
		// the trail is replaced (a reset): the anchor is not in it any more
		const reset = tracker.get("A00001")!
		reset.trackHistory = [{ lat: 0, lon: 0, altitude: null, timestamp: 1 }]
		publisher.onUpdate(reset)
		expect(updates().at(-1)!.data.trackHistory).toEqual(reset.trackHistory)
	})

	it("resyncs the full trail every resyncEvery updates (at and past the bound)", () => {
		const { hear, updates } = harness({ resyncEvery: 3 })
		hear()
		for (let i = 0; i < 7; i++) {
			hear()
			vi.advanceTimersByTime(1000)
		}
		const full = updates().map(u => u.data.trackHistory !== undefined)
		// updates 1 and 2 are deltas, the 3rd (at the bound) is full, then the cycle restarts
		expect(full).toEqual([false, false, true, false, false, true, false])
	})

	it("staggers the resync of aircraft that appear together", () => {
		const { hear, updates } = harness({ resyncEvery: 4 })
		const fleet = ["E00001", "E00002", "E00003", "E00004"]
		for (const hex of fleet) hear(hex)
		for (let round = 1; round <= 4; round++) {
			for (const hex of fleet) hear(hex)
			vi.advanceTimersByTime(1000)
		}
		// the round of each aircraft's full trail: one per round, not all in the same one
		const fullRounds = fleet.map(hex =>
			updates()
				.filter(u => u.data.icao === hex)
				.findIndex(u => u.data.trackHistory !== undefined),
		)
		expect(new Set(fullRounds).size).toBe(4)
	})

	it("remembers at most maxKeys aircraft; past it an aircraft gets its full trail every time", () => {
		const { hear, publisher, updates } = harness({ maxKeys: 2 })
		hear("C00001")
		hear("C00002")
		expect(publisher.size()).toBe(2)
		hear("C00003") // past the bound: not remembered, so every update carries the full trail
		expect(publisher.size()).toBe(2)
		hear("C00003")
		hear("C00003")
		vi.advanceTimersByTime(1000)
		const third = updates().filter(u => u.data.icao === "C00003")
		expect(third).toHaveLength(2)
		expect(third.every(u => u.data.trackHistory !== undefined)).toBe(true)
		// at the bound: a remembered one still gets deltas
		hear("C00002")
		expect(updates().at(-1)!.data.trackAppend).toHaveLength(1)
	})

	it("forgets an aircraft on lost and stops cleanly", () => {
		const { hear, tracker, publisher, updates } = harness()
		hear()
		publisher.onLost("A00001", tracker.get("A00001")!)
		expect(publisher.size()).toBe(0)
		hear()
		publisher.stop()
		hear()
		vi.advanceTimersByTime(5000)
		expect(publisher.size()).toBe(0)
		expect(updates()).toHaveLength(1)
	})

	it("a client applying new, deltas and resyncs always holds the tracker's trail", () => {
		// Feature: wg19-longevity, Property 1: Aircraft trail deltas reconstruct the trail
		// Validates: Requirement C.2 (trail on snapshot, then deltas; never lost)
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						moves: fc.boolean(),
						waitMs: fc.integer({ min: 0, max: 1500 }),
					}),
					{ minLength: 1, maxLength: 250 },
				),
				fc.integer({ min: 2, max: 50 }),
				(steps, resyncEvery) => {
					vi.setSystemTime(Date.parse("2026-11-01T00:00:00.000Z"))
					const sent: Sent[] = []
					const tracker = new AircraftTracker({ maxTrackPoints: 20 }, logger)
					const publisher = new AircraftUpdatePublisher({
						resyncEvery,
						publishNew: state =>
							sent.push({ type: "new", state: structuredClone(state) }),
						publishUpdate: data =>
							sent.push({ type: "update", data: structuredClone(data), at: 0 }),
						publishLost: () => {},
					})
					tracker.on("aircraft:new", s => publisher.onNew(s))
					tracker.on("aircraft:update", s => publisher.onUpdate(s))
					let lat = 50
					for (const step of steps) {
						if (step.moves) lat += 0.01
						tracker.processUpdate({ hex: "D00001", lat, lon: 4 })
						vi.advanceTimersByTime(step.waitMs)
					}
					vi.advanceTimersByTime(AIRCRAFT_UPDATE_WINDOW_MS)
					publisher.stop()
					// the client: full trail replaces, a delta goes on top, capped like the tracker
					let trail: TrackPoint[] = []
					for (const m of sent) {
						if (m.type === "new") trail = m.state.trackHistory ?? []
						else if (m.type === "update") {
							if (m.data.trackHistory) trail = m.data.trackHistory
							else if (m.data.trackAppend)
								trail = [...m.data.trackAppend, ...trail].slice(0, 20)
						}
					}
					expect(trail).toEqual(tracker.get("D00001")?.trackHistory ?? [])
				},
			),
			{ numRuns: 100 },
		)
	})
})
