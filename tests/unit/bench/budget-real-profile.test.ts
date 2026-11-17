import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
	bucketShares,
	CpuProfileSchema,
	longTasks,
	summariseProfile,
} from "../../../scripts/bench/budget-profile.js"

/**
 * A real `node --cpu-prof --cpu-prof-interval 1000` profile of a tiny script (an 8 ms spin and
 * an 80 ms spin, each in a timer callback, with idle gaps), trimmed by hand: the start-up call
 * chain is dropped, the long idle run between the two spins is cut to its first and last
 * samples, and the script URL is replaced. Every kept delta is the recorded one.
 *
 * Samples (index: node): 0-2 (idle), 3 (program), 4-8 blip>spin, 9-16 (idle), 17-70 burst>spin,
 * 71 (garbage collector), 72 burst>spin, 73 (idle). Sample i's self time is timeDeltas[i + 1]:
 *   (program)  td[4]                          = 1528
 *   blip spin  td[5..9]                       = 7426
 *   burst spin td[18..71] + td[73]            = 76824 + 1423 = 78247
 *   GC         td[72]                         = 1521
 *   idle       td[1..3] + td[10..17]          = 5105 + 11201 = 16306 (sample 73 has no next delta)
 * Busy = 1528 + 7426 + 78247 + 1521 = 88722 µs. The spins sit under processTimers
 * (node:internal/timers), so they fall in bucket J; (program) is K.
 * Long tasks at 50 ms: samples 3-8 make 8954 µs (too short); samples 17-72 make
 * 76824 + 1521 + 1423 = 79768 µs, starting at sum(td[0..17]) = 26326 µs.
 */
const profile = CpuProfileSchema.parse(
	JSON.parse(
		readFileSync(
			new URL("fixtures/budget-real.cpuprofile", import.meta.url),
			"utf8",
		),
	),
)

describe("a real V8 CPU profile", () => {
	it("pairs samples[i] with timeDeltas[i + 1] for bucket self time", () => {
		const b = bucketShares(profile)
		expect(b.idleUs).toBe(16_306)
		expect(b.busyUs).toBe(88_722)
		expect(b.totalUs).toBe(16_306 + 88_722)
		const us = Object.fromEntries(b.buckets.map(x => [x.id, x.us]))
		expect(us["J"]).toBe(7_426 + 78_247)
		expect(us["GC"]).toBe(1_521)
		expect(us["K"]).toBe(1_528)
		const share = Object.fromEntries(b.buckets.map(x => [x.id, x.share]))
		expect(share["J"]).toBeCloseTo(85_673 / 88_722, 12)
		expect(share["GC"]).toBeCloseTo(1_521 / 88_722, 12)
		expect(share["K"]).toBeCloseTo(1_528 / 88_722, 12)
		expect(
			b.buckets
				.filter(x => !["J", "GC", "K"].includes(x.id))
				.every(x => x.us === 0),
		).toBe(true)
	})

	it("finds the one long task with its start, length and mix", () => {
		const r = longTasks(profile, 50)
		expect(r.count).toBe(1)
		expect(r.totalMs).toBeCloseTo(79.768, 9)
		const t = r.top[0]
		expect(t?.startMs).toBeCloseTo(26.326, 9)
		expect(t?.durationMs).toBeCloseTo(79.768, 9)
		expect(t?.buckets["J"]).toBeCloseTo((76_824 + 1_423) / 79_768, 12)
		expect(t?.buckets["GC"]).toBeCloseTo(1_521 / 79_768, 12)
		// The 8954 µs run (program + blip) is a long task only at a lower threshold.
		expect(longTasks(profile, 8.95).count).toBe(2)
		expect(longTasks(profile, 9).count).toBe(1)
	})

	it("summarises it with buckets and long tasks and no warning", () => {
		const s = summariseProfile(profile, "")
		expect(s.warning).toBeNull()
		expect(s.busyShare).toBeCloseTo(88_722 / (16_306 + 88_722), 12)
		expect(s.longTasks?.count).toBe(1)
	})

	it("reports neither buckets nor long tasks for a profile without idle time", () => {
		const idleIds = new Set(
			profile.nodes
				.filter(n => n.callFrame.functionName === "(idle)")
				.map(n => n.id),
		)
		const noIdle = {
			...profile,
			samples: profile.samples.map(id => (idleIds.has(id) ? 2 : id)),
		}
		expect(bucketShares(noIdle).idleUs).toBe(0)
		const s = summariseProfile(noIdle, "")
		expect(s.buckets).toBeNull()
		expect(s.longTasks).toBeNull()
		expect(s.busyShare).toBeNull()
		expect(s.warning).toMatch(/no \(idle\) time/)
	})
})
