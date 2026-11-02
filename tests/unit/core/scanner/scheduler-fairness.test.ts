// tests/unit/core/scanner/scheduler-fairness.test.ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { SweepScheduler } from "../../../../src/core/scanner/scheduler.js"
import {
	hopTimeMs,
	simulateSweep,
	type SimSignal,
} from "../../../../src/core/scanner/plan/sweep-sim.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"

const MHZ = 1_000_000
/** About 1.024 Msps at 80 % usable: 819.2 kHz per hop. */
const HALF_SPAN_HZ = 409_600
/** Synthetic centres, 800 kHz apart. */
const centres = (n: number): number[] =>
	Array.from({ length: n }, (_, i) => 150 * MHZ + i * 800_000)
/** Timer settle 1000 ms + (2 + 1) blocks of 50 ms. */
const SETTLE_MS = 1_000
const BLOCK_MS = 50
const DWELL_MS = SETTLE_MS + 3 * BLOCK_MS
const PROBE_START_MS = 300
/** analog-fm confirm (1500) + probe start latency (300), as the job runner passes it. */
const CONFIRM_MS = 1_800
const spec = makeNormalisedSpec({ dwellMs: DWELL_MS, settleMs: SETTLE_MS })
const sim = {
	settleMs: SETTLE_MS,
	blockMs: BLOCK_MS,
	minSurfaceBlocks: 2,
	probeStartMs: PROBE_START_MS,
}

const carrier = (hz: number): SimSignal => ({
	centreHz: hz,
	startMs: 0,
	endMs: Number.POSITIVE_INFINITY,
	snrDb: 25,
	needsConfirm: true,
	confirmHoldMs: CONFIRM_MS,
	followOnAir: false,
})
const voice = (
	hz: number,
	startMs: number,
	durationMs = 28_000,
): SimSignal => ({
	centreHz: hz,
	startMs,
	endMs: startMs + durationMs,
	snrDb: 21,
	needsConfirm: true,
	confirmHoldMs: CONFIRM_MS,
	followOnAir: true,
})

const share = (ms: number[]): number[] => {
	const total = ms.reduce((a, b) => a + b, 0)
	return ms.map(x => x / total)
}

describe("sweep fairness: steady carrier, empty hop, voice hop", () => {
	const plan = makeHopPlan(centres(3), HALF_SPAN_HZ)
	const layouts: [string, number][] = [
		["a carrier inside hop 0", 149.9 * MHZ],
		["a carrier in the hop 0/1 overlap", 150.4 * MHZ],
	]
	for (const [name, carrierHz] of layouts) {
		it(`${name}: quiet-band time follows the plan and the carrier is held once`, () => {
			const r = simulateSweep(plan, spec, {
				...sim,
				durationMs: 180_000,
				signals: [
					carrier(carrierHz),
					voice(151.7 * MHZ, 40_000),
					voice(151.7 * MHZ, 100_000),
				],
			})
			// One hold on the carrier for the whole run (re-holds were the skew).
			expect(r.holds[0]).toBe(1)
			// Quiet window after the first sweep and before the first voice: equal thirds.
			const quiet = share(hopTimeMs(r, 3, 10_000, 40_000))
			for (const s of quiet) {
				expect(s).toBeGreaterThan(0.28)
				expect(s).toBeLessThan(0.39)
			}
			// Both transmissions are detected, followed (one hold each) and heard to their end.
			expect(r.holds[1]).toBe(1)
			expect(r.holds[2]).toBe(1)
			for (const i of [1, 2]) {
				const sig = [40_000, 100_000][i - 1]!
				const at = r.detectedAtMs[i]
				expect(at).not.toBeNull()
				expect(at! - sig).toBeLessThanOrEqual(
					3 * DWELL_MS + CONFIRM_MS + PROBE_START_MS,
				)
				expect(r.heardMs[i]).toBeGreaterThanOrEqual(
					sig + 28_000 - at! - BLOCK_MS,
				)
			}
		})
	}

	it("a hop whose only signal is a steady carrier gets no revisits", () => {
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 120_000,
			signals: [carrier(149.9 * MHZ)],
		})
		const visits = [0, 0, 0]
		for (const v of r.visits.filter(v => v.tunedAtMs >= 10_000))
			visits[v.hopIndex] = (visits[v.hopIndex] ?? 0) + 1
		expect(visits[0]).toBeLessThanOrEqual((visits[1] ?? 0) + 1)
		expect(visits[0]).toBeLessThanOrEqual((visits[2] ?? 0) + 1)
	})

	it("a frequency outlasting maxHoldMs is steady: it is not followed again while it stays on air", () => {
		const short = makeNormalisedSpec({
			dwellMs: DWELL_MS,
			settleMs: SETTLE_MS,
			hold: { ...spec.hold, maxHoldMs: 10_000 },
		})
		// A 60 s voice-like emitter: followed to the 10 s cap once, then steady.
		const r = simulateSweep(plan, short, {
			...sim,
			durationMs: 90_000,
			signals: [voice(151.7 * MHZ, 5_000, 60_000)],
		})
		expect(r.holds[0]).toBe(1)
	})
})

describe("hold bounds", () => {
	it("a follow ends at maxHoldMs (at the bound) and the hop is left", () => {
		const plan = makeHopPlan(centres(2), HALF_SPAN_HZ)
		const capped = makeNormalisedSpec({
			dwellMs: DWELL_MS,
			settleMs: SETTLE_MS,
			hold: { ...spec.hold, maxHoldMs: 20_000 },
		})
		const r = simulateSweep(plan, capped, {
			...sim,
			durationMs: 60_000,
			// On air from the start for 40 s: past the 20 s bound.
			signals: [voice(149.9 * MHZ, 0, 40_000)],
		})
		const first = r.visits[0]!
		// settle + dwell, then the hold: confirm and follow together never pass maxHoldMs.
		expect(first.leftAtMs - first.tunedAtMs).toBeLessThanOrEqual(
			DWELL_MS + 20_000 + BLOCK_MS,
		)
		expect(first.leftAtMs - first.tunedAtMs).toBeGreaterThanOrEqual(
			DWELL_MS + 20_000,
		)
	})

	it("a transmission ending inside maxHoldMs is followed to its end plus hangMs", () => {
		const plan = makeHopPlan(centres(2), HALF_SPAN_HZ)
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 60_000,
			signals: [voice(149.9 * MHZ, 0, 20_000)],
		})
		const first = r.visits[0]!
		// off air at 20 s; the hang (2 s) ends the hold on the next block
		expect(first.leftAtMs).toBeGreaterThanOrEqual(20_000 + spec.hold.hangMs)
		expect(first.leftAtMs).toBeLessThanOrEqual(
			20_000 + spec.hold.hangMs + 2 * BLOCK_MS,
		)
	})
})

describe("hopStats", () => {
	const B = 50
	const track = (id: string, hz: number): TrackSnapshot => ({
		...makeTrack({ id, centreHz: hz, startedAt: 0 }),
		trackId: id,
	})
	it("reports visits, time, hold time and the age of the last visit per hop", () => {
		let clock = 0
		const s = new SweepScheduler(
			makeHopPlan(centres(2), HALF_SPAN_HZ),
			makeNormalisedSpec({ revisit: { share: 0, maxIntervalMs: null } }),
			{
				blockSamples: B,
				sampleRateHz: 1000,
				now: () => clock,
				probeStartMs: 300,
			},
		)
		s.start()
		clock = 35
		s.onEpochStarted(35)
		s.onTrack(track("a", 149.9 * MHZ), true, 1_000)
		clock = 185
		expect(s.onBlock(185)).toEqual([
			{ type: "start-probe", trackId: "a", holdMs: 1_300 },
		])
		clock = 1_485
		s.tick(clock)
		const stats = s.hopStats()
		expect(stats[0]).toEqual({
			hopIndex: 0,
			visits: 1,
			timeMs: 1_485,
			holdMs: 1_300,
			lastVisitAgeMs: 0,
		})
		expect(stats[1]).toMatchObject({ visits: 1, timeMs: 0, lastVisitAgeMs: 0 })
		clock = 1_600
		expect(s.hopStats()[0]?.lastVisitAgeMs).toBe(115)
	})
})

describe("intercept property", () => {
	// Feature: scanner-sweep-fairness, Property 1: a 28 s transmission in a sweep of at most 10 s is always detected and then held to its end
	// Validates: Requirements 3 (detection always, hold until it ends bounded by maxHoldMs), 2 (no re-hold on a steady carrier)
	it("detects every 28 s transmission and holds it until it ends", () => {
		fc.assert(
			fc.property(
				// 2..7 hops: 7 × 1150 ms = 8.05 s nominal period, ≤ 10 s with one carrier hold
				fc.integer({ min: 2, max: 7 }),
				fc.nat(1_000),
				fc.nat(1_000),
				fc.integer({ min: 0, max: 60_000 }),
				fc.boolean(),
				fc.constantFrom(0, 0.3),
				(hops, voiceSlot, carrierSlot, startMs, withCarrier, revisitShare) => {
					const plan = makeHopPlan(centres(hops), HALF_SPAN_HZ)
					const vHop = voiceSlot % hops
					const cHop = carrierSlot % hops
					const s = makeNormalisedSpec({
						dwellMs: DWELL_MS,
						settleMs: SETTLE_MS,
						revisit: { share: revisitShare, maxIntervalMs: null },
					})
					const signals: SimSignal[] = [
						voice(plan.hops[vHop]!.centreHz + 100_000, startMs),
					]
					if (withCarrier && cHop !== vHop)
						signals.push(carrier(plan.hops[cHop]!.centreHz - 150_000))
					const r = simulateSweep(plan, s, {
						...sim,
						durationMs: startMs + 40_000,
						signals,
					})
					const at = r.detectedAtMs[0]
					expect(at).not.toBeNull()
					// Worst case: the hop was just left. One coarse sweep of the other hops, each a
					// dwell, at most one carrier hold (confirm 1800 + start 300), at most one revisit
					// per round(1 / 0.3) = 3 hops, then settle + 2 blocks to surface:
					// 7 × 1150 + 2100 + 3 × 1150 + 1150 = 14 750 ms < 28 000 ms.
					expect(at! - startMs).toBeLessThanOrEqual(14_750)
					// Held from detection to the end (28 s < maxHoldMs 60 s): every later block heard.
					expect(r.heardMs[0]).toBeGreaterThanOrEqual(
						startMs + 28_000 - at! - BLOCK_MS,
					)
					expect(r.holds[0]).toBe(1)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("frequency memory recovers when a gap is observed or may have passed", () => {
	const plan = makeHopPlan(centres(2), HALF_SPAN_HZ)
	/** One visit of 29 s listening: long enough to watch several transmissions come and go. */
	const LONG_DWELL_MS = 30_000

	it("a close inside the dwell frees the frequency: the next transmission on it is followed", () => {
		const long = makeNormalisedSpec({
			dwellMs: LONG_DWELL_MS,
			settleMs: SETTLE_MS,
			revisit: { share: 0, maxIntervalMs: null },
			hold: { ...spec.hold, maxHoldMs: 20_000 },
		})
		// A: on air 25 s from the start of the dwell (steady by the 20 s rule), off at 25 s.
		// B: on the same frequency from 26 s, still on air when the dwell ends at 30 s.
		const r = simulateSweep(plan, long, {
			...sim,
			durationMs: 45_000,
			signals: [
				voice(149.9 * MHZ, 0, 25_000),
				voice(149.9 * MHZ, 26_000, 14_000),
			],
		})
		expect(r.holds[0]).toBe(0)
		expect(r.holds[1]).toBe(1)
		// Followed from the dwell end to its end at 40 s.
		expect(r.heardMs[1]).toBeGreaterThanOrEqual(40_000 - 26_000 - BLOCK_MS)
	})

	it("repeater-like transmissions within one long visit stay followable, and the hold follows each reopening", () => {
		const long = makeNormalisedSpec({
			dwellMs: LONG_DWELL_MS,
			settleMs: SETTLE_MS,
			revisit: { share: 0, maxIntervalMs: null },
			hold: { ...spec.hold, maxHoldMs: 10_000 },
		})
		// 4 s on, 1 s off from 2 s: the frequency is busy for far longer than maxHoldMs, but no
		// single transmission is.
		const signals = Array.from({ length: 12 }, (_, k) =>
			voice(149.9 * MHZ, 2_000 + 5_000 * k, 4_000),
		)
		const r = simulateSweep(plan, long, { ...sim, durationMs: 60_000, signals })
		const first = r.visits[0]!
		// The transmission on air at the dwell end (27..31 s) is followed; the 1 s gaps are shorter
		// than hangMs (2 s), so the hold follows 32..36 s and 37..41 s up to maxHoldMs after 30 s.
		expect(r.holds[5]).toBe(1)
		expect(r.holds[6]).toBe(1)
		expect(r.holds[7]).toBe(1)
		expect(first.leftAtMs).toBeGreaterThanOrEqual(LONG_DWELL_MS + 10_000)
		expect(first.leftAtMs).toBeLessThanOrEqual(
			LONG_DWELL_MS + 10_000 + BLOCK_MS,
		)
	})

	it("a call that outlasted its hold and ended unheard does not bar the next call that opens during a visit", () => {
		const s3 = makeNormalisedSpec({
			dwellMs: 3_000,
			settleMs: SETTLE_MS,
			revisit: { share: 0, maxIntervalMs: null },
			hold: { ...spec.hold, maxHoldMs: 10_000 },
		})
		const plan3 = makeHopPlan(centres(3), HALF_SPAN_HZ)
		const hz = 150.7 * MHZ
		// Run 1 finds when the first call's 10 s hold ends (the hop is left with it on air).
		const probe = simulateSweep(plan3, s3, {
			...sim,
			durationMs: 60_000,
			signals: [voice(hz, 0, 100_000)],
		})
		const held = probe.visits.find(
			v => v.hopIndex === 1 && v.leftAtMs - v.tunedAtMs > 10_000,
		)!
		expect(held).toBeDefined()
		const endsAt = held.leftAtMs + 100
		const next = probe.visits.find(
			v => v.hopIndex === 1 && v.tunedAtMs > endsAt,
		)!
		expect(next).toBeDefined()
		// The first call ends while the scheduler is on other hops; the second starts 1.5 s into
		// the next visit of its hop (30 blocks after settling: well past minSurfaceBlocks + 2).
		const startsAt = next.tunedAtMs + SETTLE_MS + 500
		const r = simulateSweep(plan3, s3, {
			...sim,
			durationMs: startsAt + 20_000,
			signals: [voice(hz, 0, endsAt), voice(hz, startsAt, 15_000)],
		})
		expect(r.holds[0]).toBe(1)
		expect(r.holds[1]).toBe(1)
	})
})

describe("frequency memory bounds (direct scheduler)", () => {
	const HZ = 149.9 * MHZ
	const track = (id: string): TrackSnapshot => ({
		...makeTrack({ id, centreHz: HZ, startedAt: 0 }),
		trackId: id,
	})
	const follow = { followOnAir: true }
	const make = (
		maxHoldMs: number,
		dwellMs: number,
	): { s: SweepScheduler; at: (ms: number) => void } => {
		let clock = 0
		const s = new SweepScheduler(
			makeHopPlan(centres(2), HALF_SPAN_HZ),
			makeNormalisedSpec({
				dwellMs,
				settleMs: 35,
				revisit: { share: 0, maxIntervalMs: null },
				hold: { ...spec.hold, maxHoldMs },
			}),
			{
				blockSamples: 50,
				sampleRateHz: 1000,
				now: () => clock,
				probeStartMs: 300,
			},
		)
		return { s, at: ms => (clock = ms) }
	}
	/** Feeds 50-sample blocks from `from` until the scheduler tunes away or starts a hold. */
	const dwell = (s: SweepScheduler, from: number): void => {
		for (let e = from + 50; e < from + 1_000_000; e += 50) {
			const a = s.onBlock(e)
			if (a.some(x => x.type === "tune") || s.progress().holdingOn !== null)
				return
		}
	}

	// An outage restarts the visit: continuity spans the gap only up to maxHoldMs (10 000 ms).
	for (const [gapMs, followed] of [
		[10_000, false],
		[10_001, true],
	] as const) {
		it(`a sighting ${gapMs} ms after the last one (maxHoldMs 10 000) is ${followed ? "a new transmission" : "the same emission"}`, () => {
			const { s, at } = make(10_000, 185)
			s.start()
			s.onEpochStarted(0)
			s.onTrack(track("a"), false, 0, follow)
			at(gapMs)
			// The source dropped and came back: the hop is re-sent and a new epoch starts.
			s.onEpochStarted(1_000)
			s.onTrack(track("b"), false, 0, follow)
			dwell(s, 1_000)
			// At the bound, 10 000 ms of presumed presence reach maxHoldMs: steady, never held.
			expect(s.progress().holdingOn).toBe(followed ? "b" : null)
		})
	}

	// A track that opens after the visit received minSurfaceBlocks + 2 = 4 blocks went on air
	// during the visit; at 3 blocks it may have been on air from the first block.
	for (const [blocks, followed] of [
		[3, false],
		[4, true],
	] as const) {
		it(`a new track of a steady frequency opening after ${blocks} blocks of a later visit is ${followed ? "followed" : "still steady"}`, () => {
			const { s, at } = make(1_000, 3_000)
			s.start()
			s.onEpochStarted(0)
			s.onTrack(track("a"), false, 0, follow)
			at(1_000)
			// On air for maxHoldMs: steady, so the dwell ends without a hold.
			s.onTrack(track("a"), false, 0, follow)
			dwell(s, 0)
			expect(s.progress().holdingOn).toBeNull()
			s.onEpochStarted(0)
			dwell(s, 0) // hop 1, then back to hop 0
			s.onEpochStarted(0)
			for (let k = 1; k <= blocks; k++) s.onBlock(k * 50)
			s.onTrack(track("b"), false, 0, follow)
			dwell(s, blocks * 50)
			expect(s.progress().holdingOn).toBe(followed ? "b" : null)
		})
	}

	it("a close and an open on the same frequency in the same block is one emission (rollover); a block apart they are two", () => {
		for (const apart of [false, true]) {
			const { s, at } = make(1_000, 3_000)
			s.start()
			s.onEpochStarted(0)
			s.onTrack(track("a"), false, 0, follow)
			at(1_000)
			s.onTrack(track("a"), false, 0, follow)
			s.onBlock(50)
			s.onTrackClosed("a")
			if (apart) s.onBlock(100)
			s.onTrack(track("b"), false, 0, follow)
			dwell(s, apart ? 100 : 50)
			expect(s.progress().holdingOn).toBe(apart ? "b" : null)
		}
	})
})
