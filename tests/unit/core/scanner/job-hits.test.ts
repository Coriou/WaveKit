import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	JOB_HITS_CREDITED_MAX,
	JOB_HITS_TRACKED_MAX,
	JOB_HITS_UNTRACKED_DISTINCT_MAX,
	JobHits,
} from "../../../../src/core/scanner/job-hits.js"

const T0 = Date.parse("2026-10-13T12:00:00.000Z")
let obsSeq = 0
const nextObs = (): string => `o_${obsSeq++}`

describe("JobHits (WG2 req 13)", () => {
	it("counts hits per discovery with first and last time, most recent first", () => {
		const h = new JobHits("j_1")
		h.record(nextObs(), "d_a", T0, true)
		h.record(nextObs(), "d_b", T0 + 1000, false)
		h.record(nextObs(), "d_a", T0 + 2000, false)
		expect(h.stats()).toEqual({
			discoveries: 2,
			hits: 3,
			newDiscoveries: 1,
			truncated: false,
		})
		expect(h.list(10)).toEqual([
			{
				jobId: "j_1",
				discoveryId: "d_a",
				hits: 2,
				firstHitAt: "2026-10-13T12:00:00.000Z",
				lastHitAt: "2026-10-13T12:00:02.000Z",
				firstSeenInJob: true,
			},
			{
				jobId: "j_1",
				discoveryId: "d_b",
				hits: 1,
				firstHitAt: "2026-10-13T12:00:01.000Z",
				lastHitAt: "2026-10-13T12:00:01.000Z",
				firstSeenInJob: false,
			},
		])
		expect(h.list(1).map(x => x.discoveryId)).toEqual(["d_a"])
		expect(h.entry("d_b")?.hits).toBe(1)
		expect(h.entry("d_x")).toBeUndefined()
	})

	it("counts a discovery promoted from several observations as one new discovery (R1 #1)", () => {
		const h = new JobHits("j_1")
		for (const o of ["o_1", "o_2", "o_3"]) h.record(o, "d_p", T0, true)
		expect(h.stats()).toEqual({
			discoveries: 1,
			hits: 3,
			newDiscoveries: 1,
			truncated: false,
		})
	})

	it("credits an observation once, however often it is placed again", () => {
		const h = new JobHits("j_1")
		expect(h.record("o_1", "d_a", T0, true)).toBe(true)
		expect(h.record("o_1", "d_a", T0 + 1, false)).toBe(false)
		expect(h.record("o_1", "d_b", T0 + 2, false)).toBe(false)
		expect(h.stats()).toEqual({
			discoveries: 1,
			hits: 1,
			newDiscoveries: 1,
			truncated: false,
		})
		// Exact while the credited-id memory has not evicted anything.
		for (let i = 0; i < JOB_HITS_CREDITED_MAX - 1; i++)
			h.record(`o_x${i}`, "d_a", T0, false)
		expect(h.record("o_1", "d_a", T0, false)).toBe(false)
		expect(h.stats().truncated).toBe(false)
		// The first eviction (o_1, the oldest) marks the stats best-effort; o_1 may count again.
		h.record("o_last", "d_a", T0, false)
		expect(h.stats().truncated).toBe(true)
		expect(h.record("o_1", "d_a", T0, false)).toBe(true)
	})

	it("tracks at most 2000 discoveries; the rest count in the totals only (13.4)", () => {
		const h = new JobHits("j_1")
		for (let i = 0; i < JOB_HITS_TRACKED_MAX; i++)
			h.record(nextObs(), `d_${i}`, T0 + i, true)
		expect(h.stats().truncated).toBe(false)
		h.record(nextObs(), "d_over", T0, true)
		h.record(nextObs(), "d_over", T0, false)
		h.record(nextObs(), "d_0", T0 + 5000, false)
		expect(h.entry("d_over")).toBeUndefined()
		expect(h.entry("d_0")?.hits).toBe(2)
		expect(h.stats()).toEqual({
			discoveries: JOB_HITS_TRACKED_MAX + 1,
			hits: JOB_HITS_TRACKED_MAX + 3,
			newDiscoveries: JOB_HITS_TRACKED_MAX + 1,
			truncated: true,
		})
		expect(h.list(500)).toHaveLength(500)
		expect(h.list(500)[0]?.discoveryId).toBe("d_0")
		// The distinct count of untracked discoveries is bounded too.
		for (let i = 0; i < JOB_HITS_UNTRACKED_DISTINCT_MAX + 10; i++)
			h.record(nextObs(), `u_${i}`, T0, false)
		expect(h.stats().discoveries).toBe(
			JOB_HITS_TRACKED_MAX + JOB_HITS_UNTRACKED_DISTINCT_MAX,
		)
	})

	// Feature: web-gaps-2, Property 16: Hit counts
	// Validates: Requirements 13.1, 13.4, 13.5
	it("per-discovery hits equal the attributed observations, totals add up, tracked stays bounded", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 40 }),
				fc.array(
					fc.record({
						d: fc.nat({ max: 60 }),
						dt: fc.nat({ max: 5000 }),
						created: fc.boolean(),
						again: fc.option(fc.nat(), { nil: undefined }),
					}),
					{ maxLength: 300 },
				),
				(cap, seq) => {
					// A small cap exercises truncation; the real bound is tested above.
					const h = new JobHits("j_p", cap)
					const perDiscovery = new Map<string, number>()
					const tracked = new Map<string, boolean>()
					let created = 0
					let at = T0
					let counted = 0
					const placed: string[] = []
					for (const { d, dt, created: isNew, again } of seq) {
						at += dt
						const id = `d_${d}`
						// A re-placed observation (same id) is never counted twice.
						if (again !== undefined && placed.length > 0) {
							const o = placed[again % placed.length]!
							expect(h.record(o, id, at, isNew)).toBe(false)
							continue
						}
						const o = `o_${placed.length}`
						placed.push(o)
						expect(h.record(o, id, at, isNew)).toBe(true)
						counted += 1
						// A discovery counts as new once, on its first credited observation.
						if (isNew && !perDiscovery.has(id)) created += 1
						perDiscovery.set(id, (perDiscovery.get(id) ?? 0) + 1)
						if (!tracked.has(id) && tracked.size < cap) tracked.set(id, isNew)
					}
					const stats = h.stats()
					expect(stats).toEqual({
						discoveries: perDiscovery.size,
						hits: counted,
						newDiscoveries: created,
						truncated: perDiscovery.size > cap,
					})
					const listed = h.list(JOB_HITS_TRACKED_MAX)
					expect(listed.length).toBe(tracked.size)
					expect(listed.length).toBeLessThanOrEqual(cap)
					for (const x of listed) {
						expect(x.hits).toBe(perDiscovery.get(x.discoveryId))
						expect(x.firstSeenInJob).toBe(tracked.get(x.discoveryId))
						expect(Date.parse(x.firstHitAt)).toBeLessThanOrEqual(
							Date.parse(x.lastHitAt),
						)
					}
					for (let i = 1; i < listed.length; i++)
						expect(Date.parse(listed[i - 1]!.lastHitAt)).toBeGreaterThanOrEqual(
							Date.parse(listed[i]!.lastHitAt),
						)
				},
			),
			{ numRuns: 100 },
		)
	})
})
