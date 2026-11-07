/**
 * What a voice hold owes the sweep, through the scheduler alone: every other hop gets a coarse visit
 * before the hop gets another voice hold, whatever plan change comes in between; a recording only
 * of frequencies with carrier evidence never becomes a voice hold; and how long independent voice
 * holds can keep one hop waiting. The driver feeds one 50 ms block per step, no tracks unless a
 * test opens them; the clock is the sample count.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { simulateSweep } from "../../../../src/core/scanner/plan/sweep-sim.js"
import {
	type RecordingActivity,
	type SchedulerAction,
	SweepScheduler,
} from "../../../../src/core/scanner/scheduler.js"
import type { Hop, HopPlan } from "../../../../src/core/scanner/types.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"

const MHZ = 1_000_000
const HALF_SPAN_HZ = 409_600
const STEP_HZ = 800_000
const BASE_HZ = 150 * MHZ
const centres = (n: number): number[] =>
	Array.from({ length: n }, (_, i) => BASE_HZ + i * STEP_HZ)
const SETTLE_MS = 1_000
const BLOCK_MS = 50
const DWELL_MS = SETTLE_MS + 3 * BLOCK_MS
const MAX_HOLD_MS = 60_000

const specOf = (share: number, maxHoldMs = MAX_HOLD_MS) =>
	makeNormalisedSpec({
		dwellMs: DWELL_MS,
		settleMs: SETTLE_MS,
		revisit: { share, maxIntervalMs: null },
		hold: { ...makeNormalisedSpec({}).hold, maxHoldMs },
	})

interface VisitLog {
	centreHz: number
	tunedAt: number
	leftAt: number | null
}

/** A visit that lasted past its dwell: the hop was kept. */
const held = (v: VisitLog): boolean =>
	v.leftAt !== null && v.leftAt - v.tunedAt > 2 * DWELL_MS

/**
 * Drives a scheduler in steps of one block. `answer` is the recorder's answer for the tuned centre;
 * `seed` gives a hop an activity score, so an activity revisit would pick it.
 */
function driver(
	plan: HopPlan,
	answer: (centreHz: number, ms: number) => RecordingActivity,
	seed: (hop: Hop) => number,
	share = 0.5,
) {
	let clock = 0
	let centreHz = plan.hops[0]!.centreHz
	let settleAt: number | null = null
	const visits: VisitLog[] = []
	const s = new SweepScheduler(plan, specOf(share), {
		blockSamples: BLOCK_MS,
		sampleRateHz: 1000,
		now: () => clock,
		probeStartMs: 300,
		minSurfaceBlocks: 2,
		activitySeed: seed,
		recordingActive: () => answer(centreHz, clock),
	})
	const apply = (actions: SchedulerAction[]): void => {
		for (const a of actions) {
			if (a.type !== "tune") continue
			const last = visits.at(-1)
			if (last !== undefined) last.leftAt = clock
			visits.push({ centreHz: a.centreHz, tunedAt: clock, leftAt: null })
			centreHz = a.centreHz
			settleAt = clock + SETTLE_MS
		}
	}
	apply(s.start())
	const step = (): void => {
		if (settleAt !== null) {
			if (clock >= settleAt) {
				settleAt = null
				apply(s.onEpochStarted(clock))
			} else {
				clock = settleAt
			}
			return
		}
		clock += BLOCK_MS
		apply(s.onBlock(clock))
		apply(s.tick(clock))
	}
	return {
		s,
		visits,
		now: () => clock,
		runUntil(done: () => boolean, limitMs = 1_000_000): void {
			while (!done()) {
				if (clock > limitMs) throw new Error("the sweep never got there")
				step()
			}
		},
	}
}

const seedAt =
	(...hz: number[]) =>
	(hop: Hop): number =>
		hz.includes(hop.centreHz) ? 1 : 0

describe("a plan change while a voice hold is owed its sweep", () => {
	const VOICE: RecordingActivity = { voice: "tx" }

	it("growing the plan during the hold: all the new hops are visited before the hop holds again, and exactly they (3 to 7 hops: 6 visits, the 7th holds)", () => {
		const [h0] = centres(1)
		let voiced = true
		const d = driver(
			makeHopPlan(centres(3), HALF_SPAN_HZ),
			hz => (hz === h0 && voiced ? VOICE : false),
			seedAt(h0!),
		)
		d.runUntil(() => d.now() >= 5_000)
		expect(d.s.progress().hopIndex).toBe(0)
		// Queued before the hold ends: the swap happens as the hop is left.
		d.s.replan(makeHopPlan(centres(7), HALF_SPAN_HZ), specOf(0.5))
		voiced = false
		d.runUntil(() => d.visits.length >= 2)
		voiced = true
		d.runUntil(() => d.visits.filter(held).length >= 2)
		const [first, second] = d.visits.filter(held)
		expect(first!.centreHz).toBe(h0)
		expect(second!.centreHz).toBe(h0)
		const between = d.visits.slice(
			d.visits.indexOf(first!) + 1,
			d.visits.indexOf(second!),
		)
		expect(between.map(v => v.centreHz)).toEqual(centres(7).slice(1))
	})

	it("shrinking the plan: the hop owes only the hops left (7 to 3 hops: its coarse return after 2 visits holds)", () => {
		const [h0] = centres(1)
		let voiced = true
		const d = driver(
			makeHopPlan(centres(7), HALF_SPAN_HZ),
			hz => (hz === h0 && voiced ? VOICE : false),
			() => 0,
		)
		d.runUntil(() => d.now() >= 5_000)
		d.s.replan(makeHopPlan(centres(3), HALF_SPAN_HZ), specOf(0.5))
		voiced = false
		d.runUntil(() => d.visits.length >= 2)
		voiced = true
		d.runUntil(() => d.visits.filter(held).length >= 2)
		const [first, second] = d.visits.filter(held)
		const between = d.visits.slice(
			d.visits.indexOf(first!) + 1,
			d.visits.indexOf(second!),
		)
		expect(second!.centreHz).toBe(h0)
		expect(between.map(v => v.centreHz)).toEqual(centres(3).slice(1))
	})

	it("a new hop over the held hop's span keeps the lock, even when it is nearest another old hop", () => {
		const old = centres(7)
		const heldHz = old[3]!
		// 450 kHz below the held hop, so nearest the previous old hop (350 kHz), and wide enough to
		// hold most of the held hop's span.
		const wide = [heldHz - 2_050_000, heldHz - 450_000, heldHz + 1_150_000]
		let answerVoice = true
		const d = driver(
			makeHopPlan(old, HALF_SPAN_HZ),
			hz => (answerVoice && (hz === heldHz || hz === wide[1]) ? VOICE : false),
			// The old hop the wide one maps to is active: a revisit would pick it at once.
			seedAt(old[2]!),
		)
		d.runUntil(() => d.visits.at(-1)?.centreHz === heldHz)
		d.runUntil(() => d.now() >= d.visits.at(-1)!.tunedAt + 5_000)
		d.s.replan(makeHopPlan(wide, 800_000), specOf(0.5))
		answerVoice = false
		const leftAt = d.visits.length
		d.runUntil(() => d.visits.length > leftAt)
		answerVoice = true
		d.runUntil(() => d.visits.slice(leftAt).some(held))
		const after = d.visits.slice(leftAt)
		const secondHold = after.findIndex(held)
		expect(after[secondHold]!.centreHz).toBe(wide[1])
		const before = new Set(after.slice(0, secondHold).map(v => v.centreHz))
		expect(before).toEqual(new Set([wide[0], wide[2]]))
	})

	it("splitting the held hop: both parts owe each other and the rest, and neither is revisited or held first", () => {
		const a = BASE_HZ
		const parts = [a - 400_000, a + 400_000]
		const others = [a + 1_600_000, a + 3_200_000]
		let voiced = true
		const onAir = new Set([a, ...parts])
		const d = driver(
			makeHopPlan([a, ...others], 800_000),
			hz => (onAir.has(hz) && voiced ? VOICE : false),
			seedAt(a),
		)
		d.runUntil(() => d.now() >= 5_000)
		d.s.replan(makeHopPlan([...parts, ...others], 800_000), specOf(0.5))
		voiced = false
		const leftAt = 1
		d.runUntil(() => d.visits.length > leftAt)
		voiced = true
		d.runUntil(() => d.visits.slice(leftAt).some(held))
		const after = d.visits.slice(leftAt)
		const firstHold = after.findIndex(held)
		const before = after.slice(0, firstHold).map(v => v.centreHz)
		const holder = after[firstHold]!.centreHz
		// The holder saw its sibling and every other hop since the hold ended.
		const sibling = parts.find(p => p !== holder)!
		expect(parts).toContain(holder)
		expect(before).toEqual(expect.arrayContaining([sibling, ...others]))
		// One visit each, in coarse order: no revisit of a part came in between.
		expect(new Set(before).size).toBe(before.length)
	})

	it("an unchanged plan re-sent mid-sweep keeps what the sweep already paid (hop 1 held, hop 2 visited, re-plan: hop 0, then hop 1 holds)", () => {
		const [, h1] = centres(2)
		let voiced = true
		const plan = makeHopPlan(centres(3), HALF_SPAN_HZ)
		const d = driver(
			plan,
			hz => (hz === h1 && voiced ? VOICE : false),
			() => 0,
		)
		d.runUntil(() => d.visits.at(-1)?.centreHz === h1)
		const tunedAt = d.visits.at(-1)!.tunedAt
		d.runUntil(() => d.now() >= tunedAt + 5_000)
		voiced = false
		d.runUntil(() => d.visits.at(-1)?.centreHz === centres(3)[2])
		voiced = true
		d.s.replan(makeHopPlan(centres(3), HALF_SPAN_HZ), specOf(0.5))
		d.runUntil(() => d.visits.filter(held).length >= 2)
		const [first, second] = d.visits.filter(held)
		expect(second!.centreHz).toBe(h1)
		const between = d.visits
			.slice(d.visits.indexOf(first!) + 1, d.visits.indexOf(second!))
			.map(v => v.centreHz)
		expect(between).toEqual([centres(3)[2], centres(3)[0]])
	})

	// Feature: scanner record whole voice, Property 2: after a voice hold, no hop over the held span
	// gets another voice hold before every other hop of the plan in force got a visit, whatever
	// plan was queued during the hold; and the lock clears within that one coarse sweep.
	// Validates: sweep record hold, a voice hold forces a full coarse sweep
	it("whatever plan is queued during the hold, a hop over the held span holds again only after every other hop's visit", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 2, max: 7 }),
				fc.nat(6),
				// A one-hop plan parks: nothing is kept for a recording, nothing is owed.
				fc.integer({ min: 2, max: 7 }),
				fc.integer({ min: -3, max: 3 }),
				fc.constantFrom(0.25, 0.5, 1),
				(before, heldIndex, after, shift, share) => {
					const old = centres(before)
					const heldHz = old[heldIndex % before]!
					const next = Array.from(
						{ length: after },
						(_, i) => BASE_HZ + shift * 300_000 + i * STEP_HZ,
					)
					const nextPlan = makeHopPlan(next, HALF_SPAN_HZ)
					// The same window: more than half of the span shared (equal spans here).
					const overHeld = new Set(
						next.filter(hz => Math.abs(hz - heldHz) < HALF_SPAN_HZ),
					)
					let phase: "first" | "off" | "second" = "first"
					const d = driver(
						makeHopPlan(old, HALF_SPAN_HZ),
						hz =>
							(phase === "first" && hz === heldHz) ||
							(phase === "second" && overHeld.has(hz))
								? { voice: phase }
								: false,
						// Everything is active: a revisit would pick any hop not locked.
						() => 1,
						share,
					)
					d.runUntil(() => d.visits.at(-1)?.centreHz === heldHz)
					const tunedAt = d.visits.at(-1)!.tunedAt
					d.runUntil(() => d.now() >= tunedAt + 3_000)
					expect(d.visits.at(-1)!.centreHz).toBe(heldHz)
					d.s.replan(nextPlan, specOf(share))
					phase = "off"
					const leftAt = d.visits.length
					d.runUntil(() => d.visits.length > leftAt)
					phase = "second"
					if (overHeld.size === 0) return
					// One coarse sweep at most, then the lock is gone and the hold comes.
					d.runUntil(() => d.visits.slice(leftAt).some(held))
					const log = d.visits.slice(leftAt)
					const at = log.findIndex(held)
					const seen = new Set(log.slice(0, at).map(v => v.centreHz))
					for (const hz of next)
						if (hz !== log[at]!.centreHz) expect(seen.has(hz)).toBe(true)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("a recording that voices after the keep, with a known carrier in its window", () => {
	const HZ_TRACK = 149.9 * MHZ
	const HZ_OTHER = 150.1 * MHZ
	/** L on 3 hops (docs/SCANNER.md): 28 000 − 4600 − 5000. */
	const L3 = 18_400
	const sighting = (id: string, hz: number): TrackSnapshot => ({
		...makeTrack({ id, centreHz: hz, startedAt: 0 }),
		trackId: id,
	})
	const tunes = (a: SchedulerAction[]): boolean =>
		a.some(x => x.type === "tune")

	/** A non-voice recording hold from the dwell's end (150) on hop 0, then the track in it closes. */
	function scene(carrier: boolean) {
		let clock = 0
		let answer: RecordingActivity = true
		const s = new SweepScheduler(
			makeHopPlan(centres(3), HALF_SPAN_HZ),
			specOf(0),
			{
				blockSamples: BLOCK_MS,
				sampleRateHz: 1000,
				now: () => clock,
				probeStartMs: 300,
				recordingActive: () => answer,
			},
		)
		s.start()
		s.onEpochStarted(0)
		s.onTrack(sighting("a", HZ_TRACK), false, 0)
		for (let ms = 50; ms <= 150; ms += 50) {
			clock = ms
			s.onBlock(ms)
		}
		expect(s.progress().holdingOn).toBe("a")
		clock = 500
		s.tick(clock)
		s.onTrack(sighting("c", HZ_OTHER), false, 500, { followOnAir: true })
		if (carrier) {
			const memory = (
				s as unknown as {
					memory: {
						centreHz: number
						evidence: string
						restUntil: number
					}[]
				}
			).memory.find(m => m.centreHz === HZ_OTHER)!
			memory.evidence = "carrier"
			memory.restUntil = Number.POSITIVE_INFINITY
		}
		s.onTrackClosed("a")
		answer = { voice: "c" }
		return {
			leftAt(until: number): number | null {
				for (clock = 550; clock <= until; clock += 50)
					if (tunes(s.tick(clock))) return clock
				return null
			},
		}
	}

	it("every frequency it can be of has carrier evidence: no voice hold, it ends at L (150 + 18 400 = 18 550, still held at 18 500)", () => {
		expect(scene(true).leftAt(70_000)).toBe(150 + L3)
	})

	it("the same answer on a frequency with no carrier evidence takes the voice hold, up to maxHoldMs (150 + 60 000 = 60 150)", () => {
		expect(scene(false).leftAt(70_000)).toBe(150 + MAX_HOLD_MS)
	})
})

describe("how long independent voice holds can keep one hop waiting", () => {
	/**
	 * Each of the other N − 1 hops can hold one voice transmission per wait, since its own hold then
	 * owes this hop a coarse visit: (N − 1) × (dwell + hold.maxHoldMs) to a hop's first visit, and
	 * between two visits (N − 1) × hold.maxHoldMs plus one sweep away (hops − 1 + ⌈hops / 3⌉ dwells,
	 * with revisits). This pins the wait the docs state: 3 hops of 1150 ms 2 × 61 150 = 122 300 ms.
	 */
	const firstVisitBound = (n: number, maxHoldMs: number): number =>
		(n - 1) * (DWELL_MS + maxHoldMs)
	const betweenVisitsBound = (n: number, maxHoldMs: number): number =>
		(n - 1) * maxHoldMs + (n - 1 + Math.ceil(n / 3)) * DWELL_MS

	const everyOtherHopTalks =
		(n: number) => (_ms: number, hop: number | null) =>
			hop !== null && hop !== n - 1 ? { voice: `tx-${hop}` } : false

	const run = (n: number, share: number, maxHoldMs: number, ms: number) =>
		simulateSweep(
			makeHopPlan(centres(n), HALF_SPAN_HZ),
			specOf(share, maxHoldMs),
			{
				settleMs: SETTLE_MS,
				blockMs: BLOCK_MS,
				minSurfaceBlocks: 2,
				probeStartMs: 300,
				durationMs: ms,
				signals: [],
				activitySeed: () => 1,
				recordingActive: everyOtherHopTalks(n),
			},
		)

	/** The longest gap between two visits of the quiet last hop. */
	const longestWait = (n: number, share: number): number => {
		const last = run(n, share, MAX_HOLD_MS, 2_000_000).visits.filter(
			v => v.hopIndex === n - 1,
		)
		expect(last.length).toBeGreaterThan(3)
		let longest = 0
		for (let k = 1; k < last.length; k++)
			longest = Math.max(longest, last[k]!.tunedAtMs - last[k - 1]!.leftAtMs)
		return longest
	}

	it.each([
		[3, MAX_HOLD_MS, 122_300],
		[7, MAX_HOLD_MS, 366_900],
		[3, 30_000, 62_300],
	])(
		"%i hops, maxHoldMs %i: the last hop is first reached at exactly %i ms, however long the voices last",
		(n, maxHoldMs, expected) => {
			expect(firstVisitBound(n, maxHoldMs)).toBe(expected)
			// The voices never end: only the bound ends each hold.
			const r = run(n, 0, maxHoldMs, expected + 10_000)
			const first = r.visits.find(v => v.hopIndex === n - 1)
			expect(first?.tunedAtMs).toBe(expected)
		},
	)

	it.each([
		[2, 0.3],
		[3, 0.3],
		[7, 0.3],
		[3, 1],
	])(
		"%i hops, revisit share %f: every wait of the quiet hop stays within (N − 1) × maxHoldMs + one sweep away",
		(n, share) => {
			expect(longestWait(n, share)).toBeLessThanOrEqual(
				betweenVisitsBound(n, MAX_HOLD_MS),
			)
		},
	)

	it.each([
		[3, 122_300],
		[7, 366_900],
	])(
		"%i hops, no revisits: the wait reaches the bound's holds, one per other hop (%i ms), and never more",
		(n, expected) => {
			expect(longestWait(n, 0)).toBe(expected)
			expect(expected).toBeLessThanOrEqual(betweenVisitsBound(n, MAX_HOLD_MS))
		},
	)
})
