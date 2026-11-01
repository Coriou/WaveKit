import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
	TRAIL_MAX_POINTS,
	mergeTrackPoints,
	mergeTrail,
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
		expect(
			mergeTrail<Point, Msg>(
				{ trackHistory: desc(9, 8) },
				{ n: 1, trackHistory: desc(5, 4) },
			),
		).toEqual({ n: 1, trackHistory: desc(9, 8, 5, 4) })
		expect(
			mergeTrail<Point, Msg>(
				{ trackHistory: desc(3, 2) },
				{ n: 1, trackHistory: desc(5, 4, 3, 2, 1) },
			),
		).toEqual({ n: 1, trackHistory: desc(5, 4, 3, 2, 1) })
	})

	it("any coalescing of a delta stream gives the trail of applying it in order", () => {
		// Feature: wg19-longevity, Property 3: Coalesced trail deltas lose no point
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
