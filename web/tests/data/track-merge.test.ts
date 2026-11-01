import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { FleetThrottle, UPDATE_EVERY_MS } from "../../src/data/events-relay.ts"
import {
	TRAIL_MAX_POINTS,
	mergeTrackPoints,
	mergeTrail,
	replaceTrackPoints,
} from "../../src/data/track-merge.ts"

interface Point {
	timestamp: number
	lat: number
}
interface Msg {
	trackHistory?: Point[]
	trackAppend?: Point[]
	n: number
}

const pt = (timestamp: number): Point => ({ timestamp, lat: timestamp / 1000 })
/** Most recent first, like the core. */
const desc = (...ts: number[]): Point[] => ts.map(pt)

describe("mergeTrackPoints", () => {
	it("puts the newer points on top and drops the ones the older trail has", () => {
		expect(mergeTrackPoints(desc(5, 4, 3), desc(3, 2, 1))).toEqual(
			desc(5, 4, 3, 2, 1),
		)
		expect(mergeTrackPoints([], desc(2, 1))).toEqual(desc(2, 1))
		expect(mergeTrackPoints(desc(2), [])).toEqual(desc(2))
	})

	it("keeps at most TRAIL_MAX_POINTS (the core tracker's default), at and past the bound", () => {
		expect(TRAIL_MAX_POINTS).toBe(100)
		const older = Array.from({ length: 99 }, (_, i) => pt(99 - i))
		expect(mergeTrackPoints(desc(100), older)).toHaveLength(100)
		const full = mergeTrackPoints(desc(101), mergeTrackPoints(desc(100), older))
		expect(full).toHaveLength(100)
		expect(full[0]?.timestamp).toBe(101)
		expect(full.at(-1)?.timestamp).toBe(2)
	})
})

describe("replaceTrackPoints", () => {
	it("replaces a full trail of disjoint newer points whole, at the cap", () => {
		const held = Array.from({ length: 100 }, (_, i) => pt(100 - i))
		const snapshot = Array.from({ length: 100 }, (_, i) => pt(300 - i))
		expect(replaceTrackPoints(held, snapshot)).toEqual(snapshot)
	})

	it("clears the trail on an empty snapshot", () => {
		expect(replaceTrackPoints(desc(3, 2, 1), [])).toEqual([])
		expect(
			mergeTrail<Point, Msg>(
				{ trackHistory: desc(2, 1) },
				{ n: 1, trackHistory: [] },
			),
		).toEqual({ n: 1, trackHistory: [] })
	})

	it("keeps only the held points above the snapshot's newest", () => {
		expect(replaceTrackPoints(desc(6, 5, 4, 3), desc(4, 3, 2, 1))).toEqual(
			desc(6, 5, 4, 3, 2, 1),
		)
		// the snapshot's newest is the held newest: nothing is ahead
		expect(replaceTrackPoints(desc(4, 3, 9), desc(4, 3, 2))).toEqual(
			desc(4, 3, 2),
		)
	})
})

describe("mergeTrail", () => {
	it("appends a delta to the full trail it follows", () => {
		const out = mergeTrail<Point, Msg>(
			{ trackHistory: desc(2, 1) },
			{ n: 2, trackAppend: desc(4, 3) },
		)
		expect(out).toEqual({ n: 2, trackHistory: desc(4, 3, 2, 1) })
	})

	it("keeps a delta a delta when there is no full trail under it", () => {
		expect(
			mergeTrail<Point, Msg>(
				{ trackAppend: desc(2) },
				{ n: 2, trackAppend: desc(3) },
			),
		).toEqual({ n: 2, trackAppend: desc(3, 2) })
		const alone: Msg = { n: 1, trackAppend: desc(1) }
		expect(mergeTrail<Point, Msg>(undefined, alone)).toBe(alone)
	})

	it("carries the trail over an update without one", () => {
		expect(
			mergeTrail<Point, Msg>({ trackHistory: desc(2, 1) }, { n: 3 }),
		).toEqual({ n: 3, trackHistory: desc(2, 1) })
	})

	it("lets a full trail win, keeping newer points a delta brought first", () => {
		// disjoint: the snapshot replaces the held trail
		expect(
			mergeTrail<Point, Msg>(
				{ trackHistory: desc(9, 8) },
				{ n: 1, trackHistory: desc(5, 4) },
			),
		).toEqual({ n: 1, trackHistory: desc(5, 4) })
		// the held trail is ahead of the snapshot: its points above the snapshot's newest stay
		expect(
			mergeTrail<Point, Msg>(
				{ trackHistory: desc(7, 6, 5, 4) },
				{ n: 1, trackHistory: desc(5, 4, 3) },
			),
		).toEqual({ n: 1, trackHistory: desc(7, 6, 5, 4, 3) })
		expect(
			mergeTrail<Point, Msg>(
				{ trackHistory: desc(3, 2) },
				{ n: 1, trackHistory: desc(5, 4, 3, 2, 1) },
			),
		).toEqual({ n: 1, trackHistory: desc(5, 4, 3, 2, 1) })
	})

	it("any coalescing of a delta stream gives the trail of applying it in order", () => {
		// Feature: longevity, Property 3: Coalesced trail deltas lose no point
		// Validates: Requirement C.2 (trail complete in the UI)
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 5 }),
				fc.array(fc.integer({ min: 0, max: 4 }), { maxLength: 60 }),
				fc.array(fc.boolean(), { maxLength: 60 }),
				(start, added, cuts) => {
					// the core: a full trail, then updates adding 0..4 points each
					let t = start
					const base: Msg = {
						n: 0,
						trackHistory: Array.from({ length: start }, (_, i) =>
							pt(start - i),
						),
					}
					const stream: Msg[] = added.map((k, i) => {
						const points = Array.from({ length: k }, (_, j) => pt(t + k - j))
						t += k
						return k > 0 ? { n: i + 1, trackAppend: points } : { n: i + 1 }
					})
					// in order, one by one
					let sequential: Msg = base
					for (const m of stream)
						sequential = mergeTrail<Point, Msg>(sequential, m)
					// coalesced: runs of messages merged together first (the worker, the pending map)
					let state: Msg = base
					let run: Msg | undefined
					stream.forEach((m, i) => {
						run = run ? mergeTrail<Point, Msg>(run, m) : m
						if (cuts[i] ?? true) {
							state = mergeTrail<Point, Msg>(state, run)
							run = undefined
						}
					})
					if (run) state = mergeTrail<Point, Msg>(state, run)
					const expected = Array.from({ length: t }, (_, i) => pt(t - i)).slice(
						0,
						TRAIL_MAX_POINTS,
					)
					expect(sequential.trackHistory).toEqual(expected)
					expect(state.trackHistory).toEqual(expected)
					expect(state.n).toBe(stream.at(-1)?.n ?? 0)
				},
			),
			{ numRuns: 200 },
		)
	})
})

interface TrackPoint {
	lat: number
	lon: number
	altitude: number | null
	timestamp: number
}
interface Update {
	icao: string
	messages: number
	trackHistory?: TrackPoint[]
	trackAppend?: TrackPoint[]
}

/** FleetStore's aircraft merge (AIRCRAFT_SPEC.merge). */
const AIRCRAFT_MERGE = (previous: Update, next: Update): Update =>
	mergeTrail<TrackPoint, Update>(previous, next)

const at = (timestamp: number, lat: number): TrackPoint => ({
	lat,
	lon: 2,
	altitude: 3000,
	timestamp,
})

describe("trail overlap is found by content, not by timestamp", () => {
	it("keeps a distinct point that shares the newest point's millisecond", () => {
		const out = mergeTrail<TrackPoint, Update>(
			{ trackHistory: [at(1000, 50)] },
			{ icao: "A", messages: 2, trackAppend: [at(1000, 50.01)] },
		)
		expect(out.trackHistory).toEqual([at(1000, 50.01), at(1000, 50)])
	})

	it("keeps exact duplicates once (a delta the snapshot already holds)", () => {
		// delta of points the snapshot holds, coalesced under a later snapshot
		expect(
			mergeTrail<TrackPoint, Update>(
				{ trackAppend: [at(2000, 51), at(1000, 50)] },
				{
					icao: "A",
					messages: 3,
					trackHistory: [at(2000, 51), at(1000, 50)],
				},
			).trackHistory,
		).toEqual([at(2000, 51), at(1000, 50)])
		// a delta that overlaps the snapshot it follows: only the new part goes on top
		expect(
			mergeTrackPoints(
				[at(3000, 52), at(2000, 51)],
				[at(2000, 51), at(1000, 50)],
			),
		).toEqual([at(3000, 52), at(2000, 51), at(1000, 50)])
	})

	it("keeps points after a clock rollback", () => {
		const out = mergeTrail<TrackPoint, Update>(
			{ trackHistory: [at(5000, 50), at(4000, 49)] },
			{ icao: "A", messages: 2, trackAppend: [at(1001, 51.1), at(1000, 51)] },
		)
		expect(out.trackHistory).toEqual([
			at(1001, 51.1),
			at(1000, 51),
			at(5000, 50),
			at(4000, 49),
		])
	})

	it("delta reconstruction through the events worker equals the core's trail, over resyncs and late snapshots", () => {
		// Feature: longevity, Property 4: Trail deltas rebuild the core trail whatever the timestamps
		// Validates: Requirement C.2 (trail complete in the UI)
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 3 }),
				fc.array(
					fc.record({
						// timestamps repeat and step back: Date.now() within a millisecond, clock rollback
						stamps: fc.array(fc.integer({ min: 0, max: 4 }), { maxLength: 4 }),
						dt: fc.integer({ min: 0, max: 700 }),
						sweep: fc.boolean(),
						resync: fc.integer({ min: 0, max: 19 }),
						// 0: the core's trail resets to new disjoint points (a full trackHistory follows)
						reset: fc.integer({ min: 0, max: 14 }),
						resetLength: fc.integer({ min: 1, max: 5 }),
						// 0: take a GET snapshot; 1: apply the one taken earlier (deltas overtook it)
						get: fc.integer({ min: 0, max: 7 }),
					}),
					{ maxLength: 60 },
				),
				(start, steps) => {
					// the core tracker: newest first, capped, each point a new position
					let lat = 0
					let history: TrackPoint[] = []
					const add = (stamp: number) => {
						lat += 1
						history = [at(1000 + stamp, lat), ...history].slice(
							0,
							TRAIL_MAX_POINTS,
						)
					}
					for (let i = 0; i < start; i++) add(i)
					const reset = (length: number) => {
						history = []
						for (let i = 0; i < length; i++) add(i)
					}
					// AircraftUpdatePublisher: delta since the last point sent, found by identity
					let anchor: TrackPoint | undefined = history[0]
					const publish = (n: number, resync: boolean): string => {
						const data: Update = { icao: "A", messages: n }
						const newest = history[0]
						if (newest) {
							const i = !resync && anchor ? history.indexOf(anchor) : -1
							if (i < 0) data.trackHistory = [...history]
							else if (i > 0) data.trackAppend = history.slice(0, i)
							anchor = newest
						}
						return JSON.stringify({ type: "aircraft:update", data })
					}
					// the browser: the GET snapshot, then what the worker's throttle lets through
					let state: Update = {
						icao: "A",
						messages: 0,
						...(history.length > 0 ? { trackHistory: [...history] } : {}),
					}
					const apply = (text: string) => {
						const { data } = JSON.parse(text) as { data: Update }
						state = AIRCRAFT_MERGE(state, data)
					}
					const throttle = new FleetThrottle(apply, UPDATE_EVERY_MS)
					let now = 0
					let snapshot: TrackPoint[] | undefined
					steps.forEach((s, n) => {
						if (s.reset === 0) {
							reset(s.resetLength)
							snapshot = undefined
						}
						for (const stamp of s.stamps) add(stamp)
						now += s.dt
						throttle.push(publish(n + 1, s.resync === 0), now)
						if (s.sweep) throttle.sweep(now)
						if (s.get === 0) snapshot = [...history]
						else if (s.get === 1 && snapshot) {
							// GET /api/aircraft answered late: the updates sent meanwhile are applied first
							throttle.drain()
							const top = snapshot[0]
							// an empty snapshot, or one older than a whole trail (none of it held), cannot be placed
							if (top !== undefined && history.includes(top))
								state = AIRCRAFT_MERGE(state, {
									icao: "A",
									messages: state.messages,
									trackHistory: JSON.parse(
										JSON.stringify(snapshot),
									) as TrackPoint[],
								})
							snapshot = undefined
						}
					})
					throttle.drain()
					expect(state.trackHistory ?? []).toEqual(history)
					expect(state.messages).toBe(steps.length)
				},
			),
			{ numRuns: 300 },
		)
	})
})
