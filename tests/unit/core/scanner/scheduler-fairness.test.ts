// tests/unit/core/scanner/scheduler-fairness.test.ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	CONFIRM_FLOOR_MS,
	SweepScheduler,
} from "../../../../src/core/scanner/scheduler.js"
import { DEFAULT_CONFIRM_HOLD_MS } from "../../../../src/core/scanner/plan/plan-preview.js"
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

/** A steady carrier the classifier labels analog voice (follow on air). */
const labelledCarrier = (hz: number, startMs = 0): SimSignal => ({
	...voice(hz, startMs, Number.POSITIVE_INFINITY),
	snrDb: 25,
})
/** Labelled transmissions `onMs` long with `offMs` gaps from `fromMs` until `untilMs`. */
const series = (
	hz: number,
	onMs: number,
	offMs: number,
	untilMs: number,
	fromMs = 0,
): SimSignal[] => {
	const out: SimSignal[] = []
	for (let t = fromMs; t < untilMs; t += onMs + offMs)
		out.push(voice(hz, t, onMs))
	return out
}

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

describe("sweep fairness: labelled, flapping and busy emitters beside a voice hop", () => {
	const plan = makeHopPlan(centres(3), HALF_SPAN_HZ)
	const C = 149.9 * MHZ // hop 0
	const BUSY = 150.9 * MHZ // hop 1
	const V = 151.7 * MHZ // hop 2
	const RUN_MS = 600_000
	/** 20 s overs with 0.3 s gaps, on air from the start. */
	const busy = (): SimSignal[] => series(BUSY, 20_000, 300, RUN_MS)
	const scenes: [string, SimSignal[], number[]][] = [
		[
			"a carrier labelled analog voice and a busy channel",
			[labelledCarrier(C), ...busy()],
			[60_000, 240_000, 420_000],
		],
		[
			"a labelled carrier flapping 3 s on / 0.5 s off",
			series(C, 3_000, 500, RUN_MS),
			[40_000, 220_000, 400_000],
		],
		[
			"a labelled carrier flapping 20 s on / 0.3 s off",
			series(C, 20_000, 300, RUN_MS),
			[40_000, 220_000, 400_000],
		],
		[
			"a flapping carrier and a busy channel",
			[...series(C, 3_000, 500, RUN_MS), ...busy()],
			[60_000, 240_000, 420_000],
		],
	]
	for (const [name, others, ids] of scenes) {
		it(`${name}: every 28 s call on the voice hop is detected and held to its end`, () => {
			const signals = [...others, ...ids.map(at => voice(V, at))]
			const r = simulateSweep(plan, spec, {
				...sim,
				durationMs: RUN_MS,
				signals,
			})
			const first = others.length
			ids.forEach((startMs, k) => {
				const at = r.detectedAtMs[first + k]
				expect(at).not.toBeNull()
				// One coarse sweep (3 × 1150), one hold of one coarse sweep (3450), settle + 2 blocks.
				expect(at! - startMs).toBeLessThanOrEqual(
					3 * DWELL_MS + 3 * DWELL_MS + DWELL_MS,
				)
				expect(r.heardMs[first + k]).toBeGreaterThanOrEqual(
					startMs + 28_000 - at! - BLOCK_MS,
				)
			})
			// The carrier and busy hops get about their dwell share; the voice hop gets its calls.
			const [c, b, v] = share(hopTimeMs(r, 3))
			expect(c).toBeLessThan(0.3)
			expect(b).toBeLessThan(0.3)
			expect(v).toBeGreaterThan(0.4)
			// Quiet window before the first call: equal thirds.
			for (const x of share(hopTimeMs(r, 3, 20_000, 40_000))) {
				expect(x).toBeGreaterThan(0.28)
				expect(x).toBeLessThan(0.39)
			}
			// The other emitters are held a handful of times in all, never once per visit.
			const otherHolds = r.holds.slice(0, first).reduce((a, x) => a + x, 0)
			expect(otherHolds).toBeLessThanOrEqual(5)
		})
	}

	it("a lone labelled carrier at job start gets one hold of one coarse sweep, not a long follow", () => {
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 120_000,
			signals: [labelledCarrier(C), voice(V, 40_000)],
		})
		expect(r.holds[0]).toBe(1)
		const longest = Math.max(
			...r.visits
				.filter(v => v.hopIndex === 0)
				.map(v => v.leftAtMs - v.tunedAtMs),
		)
		// settle + dwell (1150), then at most one coarse sweep (3 × 1150) of hold, plus a hang
		// that started before the cap ends at the cap.
		expect(longest).toBeLessThanOrEqual(DWELL_MS + 3 * DWELL_MS + BLOCK_MS)
		// The call at 40 s is caught within one coarse sweep and settle, as with no carrier.
		expect(r.detectedAtMs[1]! - 40_000).toBeLessThanOrEqual(
			3 * DWELL_MS + DWELL_MS,
		)
		expect(r.heardMs[1]).toBeGreaterThanOrEqual(
			68_000 - r.detectedAtMs[1]! - BLOCK_MS,
		)
	})

	it("a frequency with back-to-back new calls is followed for at most maxHoldMs per 5 × maxHoldMs, and a full sweep separates long holds", () => {
		// 50 s calls with 3 s gaps (longer than hangMs) from 30 s: each call is new traffic.
		const calls = series(C, 50_000, 3_000, RUN_MS, 30_000)
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: RUN_MS,
			signals: calls,
		})
		// Long follows (holds past one coarse sweep) on hop 0.
		const long = r.visits.filter(
			v =>
				v.hopIndex === 0 &&
				v.leftAtMs - v.tunedAtMs > DWELL_MS + 3 * DWELL_MS + BLOCK_MS,
		)
		const followedMs = long.reduce(
			(a, v) => a + v.leftAtMs - v.tunedAtMs - DWELL_MS,
			0,
		)
		// The bucket starts full (maxHoldMs) and drains 1 ms per 5 ms: over 570 s of calls at
		// most 60 000 + 570 000 / 5 = 174 000 ms of long follows (about 30 %).
		expect(followedMs).toBeLessThanOrEqual(60_000 + (RUN_MS - 30_000) / 5)
		expect(followedMs).toBeGreaterThan(60_000)
		// Between two long holds every hop had a visit.
		for (let k = 1; k < long.length; k++) {
			const between = r.visits.filter(
				v =>
					v.tunedAtMs >= long[k - 1]!.leftAtMs &&
					v.leftAtMs <= long[k]!.tunedAtMs,
			)
			expect(new Set(between.map(v => v.hopIndex))).toEqual(new Set([0, 1, 2]))
		}
	})

	it("busy traffic that turned steady keeps its hop's revisits; a bare carrier's hop gets none", () => {
		const plan4 = makeHopPlan(centres(4), HALF_SPAN_HZ)
		const withRevisits = makeNormalisedSpec({
			dwellMs: DWELL_MS,
			settleMs: SETTLE_MS,
			revisit: { share: 0.3, maxIntervalMs: null },
		})
		// Hop 1: a repeater whose QSO starts after the first sweeps (its onset is seen) and keeps the
		// channel up with 0.3 s gaps. Hop 2: a bare carrier from the start.
		const r = simulateSweep(plan4, withRevisits, {
			...sim,
			durationMs: 240_000,
			signals: [
				...series(150.8 * MHZ + 100_000, 20_000, 300, 240_000, 20_000),
				carrier(151.6 * MHZ + 100_000),
			],
		})
		const visits = [0, 0, 0, 0]
		for (const v of r.visits.filter(v => v.tunedAtMs >= 120_000))
			visits[v.hopIndex] = (visits[v.hopIndex] ?? 0) + 1
		expect(visits[1]).toBeGreaterThan((visits[2] ?? 0) + 2)
		expect(visits[2]).toBeLessThanOrEqual((visits[0] ?? 0) + 1)
	})

	it("a call labelled analog voice only from its 5th block is still followed (the dwell waits for its class)", () => {
		// No confirm probe: the class (and followOnAir) only arrives with the 5th block, after the
		// dwell's 3 blocks.
		const late: SimSignal = {
			...voice(V, 40_000),
			needsConfirm: false,
			labelAfterBlocks: 5,
		}
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 90_000,
			signals: [late],
		})
		expect(r.holds[0]).toBe(1)
		expect(r.heardMs[0]).toBeGreaterThanOrEqual(
			68_000 - r.detectedAtMs[0]! - 4 * BLOCK_MS,
		)
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
			durationMs: 70_000,
			// On air from 7 s for 40 s (past the 20 s bound). Hop 0 had three full visits by then
			// (0, 2.3 and 4.6 s), so its onset is seen and it may be followed past one sweep.
			signals: [voice(149.9 * MHZ, 7_000, 40_000)],
		})
		const first = r.visits.find(v => v.leftAtMs - v.tunedAtMs > DWELL_MS)!
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
			signals: [voice(149.9 * MHZ, 7_000, 20_000)],
		})
		const first = r.visits.find(v => v.leftAtMs - v.tunedAtMs > DWELL_MS)!
		// off air at 27 s; the hang (2 s) ends the hold on the next block
		expect(first.leftAtMs).toBeGreaterThanOrEqual(27_000 + spec.hold.hangMs)
		expect(first.leftAtMs).toBeLessThanOrEqual(
			27_000 + spec.hold.hangMs + 2 * BLOCK_MS,
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
	type Other = "none" | "carrier" | "labelled" | "flapping" | "flapping-slow"
	/**
	 * A carrier on air from the start, labelled analog voice or not; or a labelled carrier that
	 * starts flapping at 25 s (after the first sweeps heard it as a carrier): 3 s on / 0.5 s off,
	 * or 20 s on / 0.3 s off.
	 */
	const other = (kind: Other, hz: number, untilMs: number): SimSignal[] => {
		if (kind === "carrier") return [carrier(hz)]
		if (kind === "labelled") return [labelledCarrier(hz)]
		if (kind === "flapping")
			return [voice(hz, 0, 25_000), ...series(hz, 3_000, 500, untilMs, 25_500)]
		if (kind === "flapping-slow")
			return [voice(hz, 0, 25_000), ...series(hz, 20_000, 300, untilMs, 25_300)]
		return []
	}

	// Feature: scanner-sweep-fairness, Property 1: a 28 s transmission in a sweep of at most 10 s is always detected and then held to its end, beside carriers (labelled or not, steady or flapping) and a busy channel
	// Validates: Requirements 3 (detection always, hold until it ends bounded by maxHoldMs), 2 (no re-hold on a steady or flapping carrier), 1 (no hop starved by another hop's holds)
	it("detects every 28 s transmission and holds it until it ends", () => {
		fc.assert(
			fc.property(
				// 2..7 hops: 7 × 1150 ms = 8.05 s nominal period
				fc.integer({ min: 2, max: 7 }),
				fc.nat(1_000),
				fc.nat(1_000),
				fc.nat(1_000),
				// After the warm-up: three full visits of every hop, with at most one hold of one
				// coarse sweep per hop in the first sweep: 3 × 8050 + 2 × 8050 = 40 250 ms < 45 000 ms.
				fc.integer({ min: 45_000, max: 105_000 }),
				fc.constantFrom<Other>(
					"none",
					"carrier",
					"labelled",
					"flapping",
					"flapping-slow",
				),
				fc.boolean(),
				fc.constantFrom(0, 0.3),
				(
					hops,
					voiceSlot,
					otherSlot,
					busySlot,
					startMs,
					kind,
					busy,
					revisitShare,
				) => {
					const plan = makeHopPlan(centres(hops), HALF_SPAN_HZ)
					const vHop = voiceSlot % hops
					const oHop = otherSlot % hops
					const bHop = busySlot % hops
					const durationMs = startMs + 40_000
					const s = makeNormalisedSpec({
						dwellMs: DWELL_MS,
						settleMs: SETTLE_MS,
						revisit: { share: revisitShare, maxIntervalMs: null },
					})
					const signals: SimSignal[] = [
						voice(plan.hops[vHop]!.centreHz + 100_000, startMs),
					]
					if (oHop !== vHop)
						signals.push(
							...other(kind, plan.hops[oHop]!.centreHz - 150_000, durationMs),
						)
					// A busy channel on air from the start: 20 s overs, 0.3 s gaps.
					if (busy && bHop !== vHop)
						signals.push(
							...series(
								plan.hops[bHop]!.centreHz + 200_000,
								20_000,
								300,
								durationMs,
							),
						)
					const r = simulateSweep(plan, s, { ...sim, durationMs, signals })
					const at = r.detectedAtMs[0]
					expect(at).not.toBeNull()
					// Worst case: the hop was just left. One coarse sweep of the other hops, each a
					// dwell, at most one hold of one coarse sweep (a carrier's short hold: 8050 ms),
					// at most one revisit per round(1 / 0.3) = 3 hops, then settle + 2 blocks:
					// 7 × 1150 + 8050 + 3 × 1150 + 1150 = 20 700 ms < 28 000 ms.
					expect(at! - startMs).toBeLessThanOrEqual(20_700)
					// Held from detection to the end (28 s < maxHoldMs 60 s): every later block heard.
					expect(r.heardMs[0]).toBeGreaterThanOrEqual(
						startMs + 28_000 - at! - BLOCK_MS,
					)
					expect(r.holds[0]).toBe(1)
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)
})

describe("frequency memory recovers when a gap is observed or may have passed", () => {
	const plan = makeHopPlan(centres(2), HALF_SPAN_HZ)
	/** One visit of 29 s listening: long enough to watch several transmissions come and go. */
	const LONG_DWELL_MS = 30_000

	// The gap heard runs from the close (the first block off air, 25 050 ms) to the reopen's
	// sighting (minSurfaceBlocks = 2 blocks after it goes on air): gap + 50 ms. hangMs is 2000 ms.
	for (const [gapMs, followed] of [
		[1_900, false],
		[1_950, true],
	] as const) {
		it(`a gap of ${gapMs + 50} ms heard inside the dwell (hangMs 2000) ${followed ? "frees the frequency: the next transmission is followed" : "is the same emission: the steady frequency stays steady"}`, () => {
			const long = makeNormalisedSpec({
				dwellMs: LONG_DWELL_MS,
				settleMs: SETTLE_MS,
				revisit: { share: 0, maxIntervalMs: null },
				hold: { ...spec.hold, maxHoldMs: 20_000 },
			})
			// A: on air 25 s from the start of the dwell (steady by the 20 s rule), off at 25 s.
			// B: on the same frequency after the gap, still on air when the dwell ends at 30 s.
			const startB = 25_000 + gapMs
			const r = simulateSweep(plan, long, {
				...sim,
				durationMs: 45_000,
				signals: [
					voice(149.9 * MHZ, 0, 25_000),
					voice(149.9 * MHZ, startB, 40_000 - startB),
				],
			})
			expect(r.holds[0]).toBe(0)
			expect(r.holds[1]).toBe(followed ? 1 : 0)
			// Followed from the dwell end to its end at 40 s.
			if (followed)
				expect(r.heardMs[1]).toBeGreaterThanOrEqual(40_000 - startB - BLOCK_MS)
		})
	}

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

	// The second call opens `afterMs` into the next visit's listening and surfaces 2 blocks later.
	// The off-air time heard is counted without overstating it: the blocks the visit received
	// before the sighting (afterMs / 50 + 1, the track event comes before its block event) less
	// minSurfaceBlocks (2), so afterMs − 50 ms. At hangMs (2000 ms) or more that is a new call;
	// less, and a call on air through the whole previous visit may only have flickered.
	for (const [afterMs, followed] of [
		[2_000, false],
		[2_050, true],
	] as const) {
		it(`a call that outlasted its hold and ended unheard ${followed ? "does not bar" : "still bars"} a call that opens after ${afterMs} ms of a later visit`, () => {
			const s3 = makeNormalisedSpec({
				dwellMs: 4_000,
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
			const startsAt = next.tunedAtMs + SETTLE_MS + afterMs
			const r = simulateSweep(plan3, s3, {
				...sim,
				durationMs: startsAt + 20_000,
				signals: [voice(hz, 0, endsAt), voice(hz, startsAt, 15_000)],
			})
			expect(r.holds[0]).toBe(1)
			expect(r.holds[1]).toBe(followed ? 1 : 0)
		})
	}
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

	// An outage restarts the visit but is no visit: nothing could hear the frequency, so it stays
	// the same emission however long the outage (here at maxHoldMs and an hour past it). Presumed on
	// air throughout, it is steady once maxHoldMs (10 000 ms) passed since it was first heard.
	for (const gapMs of [10_000, 3_600_000]) {
		it(`a sighting after an outage of ${gapMs} ms (maxHoldMs 10 000) is the same emission`, () => {
			const { s, at } = make(10_000, 185)
			s.start()
			s.onEpochStarted(0)
			s.onTrack(track("a"), false, 0, follow)
			at(gapMs)
			// The source dropped and came back: the hop is re-sent and a new epoch starts.
			s.onEpochStarted(1_000)
			s.onTrack(track("b"), false, 0, follow)
			dwell(s, 1_000)
			expect(s.progress().holdingOn).toBeNull()
		})
	}

	// Presence (weight 1/4): from 1, two missed full visits leave (3/4)² ≈ 0.56 ≥ 1/2, the same
	// emission (steady, never held); three leave (3/4)³ ≈ 0.42, so the next sighting is new.
	for (const [misses, held] of [
		[2, false],
		[3, true],
	] as const) {
		it(`a steady frequency missed by ${misses} full visits is ${held ? "held again" : "still steady"}`, () => {
			const { s, at } = make(1_000, 185)
			s.start()
			s.onEpochStarted(0)
			s.onTrack(track("a"), false, 0, follow)
			at(1_000)
			s.onTrack(track("a"), false, 0, follow) // on air for maxHoldMs: steady
			dwell(s, 0) // hop 0 ends without a hold
			expect(s.progress().holdingOn).toBeNull()
			for (let k = 0; k < misses; k++) {
				s.onEpochStarted(0)
				dwell(s, 0) // hop 1
				s.onEpochStarted(0)
				dwell(s, 0) // hop 0, a full visit that does not hear it
			}
			s.onEpochStarted(0)
			dwell(s, 0) // hop 1
			s.onEpochStarted(0)
			s.onTrack(track("b"), false, 0, follow)
			dwell(s, 0)
			expect(s.progress().holdingOn).toBe(held ? "b" : null)
		})
	}

	// A track that opens after the visit received `blocks` blocks heard the frequency off air for
	// (blocks − minSurfaceBlocks) × 50 ms. A persistent frequency (here a steady one heard on every
	// visit) starts a new emission only when that reaches hangMs (2000 ms): 42 blocks, not 41.
	for (const [blocks, followed] of [
		[41, false],
		[42, true],
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

	// A reopen within hangMs (2000 ms) is the same emission (a flapping carrier stays steady); a
	// close and an open in the same block is a rollover. hangMs after the close it is new.
	for (const [blocksApart, gapMs, followed] of [
		[0, 0, false],
		[1, 50, false],
		[39, 1_950, false],
		[40, 2_000, true],
	] as const) {
		it(`a close and a reopen ${blocksApart} blocks (${gapMs} ms) apart on a steady frequency ${followed ? "is a new transmission" : "is the same emission"}`, () => {
			const { s, at } = make(1_000, 3_000)
			s.start()
			s.onEpochStarted(0)
			s.onTrack(track("a"), false, 0, follow)
			at(1_000)
			s.onTrack(track("a"), false, 0, follow)
			s.onBlock(50)
			s.onTrackClosed("a")
			for (let k = 1; k <= blocksApart; k++) s.onBlock(50 + 50 * k)
			at(1_000 + gapMs)
			s.onTrack(track("b"), false, 0, follow)
			dwell(s, 50 + 50 * blocksApart)
			expect(s.progress().holdingOn).toBe(followed ? "b" : null)
		})
	}
})

describe("hold evidence across restarts, shared follow budgets and confirm bounds", () => {
	const HZ = 149.9 * MHZ
	const at = (id: string, hz = HZ): TrackSnapshot => ({
		...makeTrack({ id, centreHz: hz, startedAt: 0 }),
		trackId: id,
	})
	const follow = { followOnAir: true }
	const make = (
		dwellMs: number,
		maxHoldMs = 60_000,
	): { s: SweepScheduler; set: (ms: number) => void } => {
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
				probeStartMs: PROBE_START_MS,
			},
		)
		return { s, set: ms => (clock = ms) }
	}
	/** Feeds 50-sample blocks from `from` until the scheduler acts; returns its actions. */
	const until = (s: SweepScheduler, from: number) => {
		for (let e = from + 50; e < from + 1_000_000; e += 50) {
			const a = s.onBlock(e)
			if (a.length > 0 || s.progress().holdingOn !== null) return a
		}
		return []
	}

	// Dwell 12 000 ms on 2 hops: one coarse sweep is 24 000 ms, maxHoldMs 60 000. On the job's
	// first visit nothing brackets an onset, so only a heard gap allows a follow past one sweep.
	// A close at 500 ms and a reopen at 10 050 ms is a 9 550 ms gap (≥ hangMs 2000) when the visit
	// listened throughout; across an outage (no samples, then a new epoch) nothing was heard.
	for (const outage of [false, true]) {
		it(`a close and a reopen 9 550 ms later ${outage ? "across an outage is the same emission: one coarse sweep" : "heard by the visit is a new call: followed past one coarse sweep"}`, () => {
			const { s, set } = make(12_000)
			s.start()
			s.onEpochStarted(0)
			s.onTrack(at("a"), false, 0, follow)
			for (let e = 50; e <= 500; e += 50) s.onBlock(e)
			set(500)
			s.onTrackClosed("a")
			if (outage) {
				set(10_000)
				s.onEpochStarted(10_000)
			} else for (let e = 550; e <= 10_000; e += 50) s.onBlock(e)
			s.onBlock(10_050)
			set(10_050)
			s.onTrack(at("b"), false, 0, follow)
			until(s, 10_050)
			expect(s.progress().holdingOn).toBe("b")
			// The hold started at 10 050: one coarse sweep ends at 34 050.
			set(34_049)
			expect(s.tick(34_049)).toEqual([])
			set(34_050)
			const left = s.tick(34_050).some(a => a.type === "tune")
			expect(left).toBe(outage)
		})
	}

	// A frequency first heard after 43 blocks (2 050 ms of listening, ≥ hangMs) opened late; after
	// an outage the visit's listening restarts, so one block later is no late open.
	for (const outage of [false, true]) {
		it(`a new frequency opening ${outage ? "one block after an outage is not a heard onset" : "after 2 050 ms of listening is a heard onset"}`, () => {
			const { s, set } = make(12_000)
			s.start()
			s.onEpochStarted(0)
			for (let e = 50; e <= 2_000; e += 50) s.onBlock(e)
			if (outage) {
				set(10_000)
				s.onEpochStarted(10_000)
				for (let e = 10_050; e <= 10_150; e += 50) s.onBlock(e)
			} else for (let e = 2_050; e <= 2_150; e += 50) s.onBlock(e)
			const t0 = outage ? 10_150 : 2_150
			set(t0)
			s.onTrack(at("b"), false, 0, follow)
			until(s, t0)
			expect(s.progress().holdingOn).toBe("b")
			set(t0 + 24_000)
			const left = s.tick(t0 + 24_000).some(a => a.type === "tune")
			expect(left).toBe(outage)
		})
	}

	it("overlapping hops share one follow budget per frequency", () => {
		// 150.4 MHz is inside hop 0 (to 150.4096) and hop 1 (from 150.3904). 50 s calls with 3 s
		// gaps (each a new call) from 30 s, no confirm probe, no revisits.
		const plan = makeHopPlan(centres(3), HALF_SPAN_HZ)
		const noRevisit = makeNormalisedSpec({
			dwellMs: DWELL_MS,
			settleMs: SETTLE_MS,
			revisit: { share: 0, maxIntervalMs: null },
		})
		const RUN = 140_000
		const calls = series(150.4 * MHZ, 50_000, 3_000, RUN, 30_000).map(c => ({
			...c,
			needsConfirm: false,
		}))
		const r = simulateSweep(plan, noRevisit, {
			...sim,
			durationMs: RUN,
			signals: calls,
		})
		// Long follows (holds past one coarse sweep) on either hop: settle + dwell, then the hold.
		const followedMs = r.visits
			.filter(
				v =>
					(v.hopIndex === 0 || v.hopIndex === 1) &&
					v.leftAtMs - v.tunedAtMs > DWELL_MS + 3 * DWELL_MS + BLOCK_MS,
			)
			.reduce((a, v) => a + v.leftAtMs - v.tunedAtMs - DWELL_MS, 0)
		// One bucket of maxHoldMs that drains 1 ms per 5 ms: over 110 s of calls at most
		// 60 000 + 110 000 / 5 = 82 000 ms of long follows, whichever hop holds it.
		expect(followedMs).toBeLessThanOrEqual(60_000 + (RUN - 30_000) / 5)
		// Still followed long: short follows also draw on the bucket, so less than all of it.
		expect(followedMs).toBeGreaterThan(30_000)
	})

	it("the longest built-in confirm hold and its decoder start latency fit the confirm floor", () => {
		const longest = Math.max(...Object.values(DEFAULT_CONFIRM_HOLD_MS))
		expect(longest + 2_000).toBe(CONFIRM_FLOOR_MS)
	})

	// Two hops of 185 ms: one coarse sweep is 370 ms. A confirm hold may run its window up to
	// CONFIRM_FLOOR_MS (12 000) + probe start (300) = 12 300 ms, at the floor and past it.
	for (const [confirmMs, holdMs] of [
		[100, 400],
		[11_999, 12_299],
		[12_000, 12_300],
		[12_001, 12_300],
		[60_000, 12_300],
	] as const) {
		it(`a confirm hold of ${confirmMs} ms on a 370 ms sweep is held ${holdMs} ms`, () => {
			const { s } = make(185)
			s.start()
			s.onEpochStarted(0)
			s.onTrack(at("a"), true, confirmMs)
			expect(until(s, 0)).toEqual([
				{ type: "start-probe", trackId: "a", holdMs },
			])
		})
	}

	it("a 60 s confirm hold on a non-voice carrier does not keep a call on another hop waiting", () => {
		const plan = makeHopPlan(centres(3), HALF_SPAN_HZ)
		const slow: SimSignal = { ...carrier(HZ), confirmHoldMs: 60_000 }
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 75_000,
			signals: [slow, voice(151.7 * MHZ, 10_000), voice(151.5 * MHZ, 40_000)],
		})
		const longest = Math.max(
			...r.visits
				.filter(v => v.hopIndex === 0)
				.map(v => v.leftAtMs - v.tunedAtMs),
		)
		// settle + dwell, then one confirm hold of at most 12 000 + 300 ms (one tick's block late).
		expect(longest).toBeLessThanOrEqual(
			DWELL_MS + CONFIRM_FLOOR_MS + PROBE_START_MS + BLOCK_MS,
		)
		const detected = r.detectedAtMs[1]
		expect(detected).not.toBeNull()
		// The hold on hop 0 ends by 1 150 + 12 300 = 13 450 ms, then hops 1 and 2 dwell.
		expect(detected!).toBeLessThanOrEqual(13_450 + 2 * DWELL_MS + BLOCK_MS)
		// A call after the first sweeps (its onset seen) is followed to its end.
		const later = r.detectedAtMs[2]
		expect(later).not.toBeNull()
		expect(r.heardMs[2]).toBeGreaterThanOrEqual(68_000 - later! - BLOCK_MS)
	})

	// After three full visits of hop 0 (0, 2.3 and 4.6 s on 2 hops of 1150 ms), a voice call's
	// onset is seen and it may be followed long: its confirm hold may then run to maxHoldMs.
	for (const voiceCall of [true, false]) {
		it(`a 60 s confirm hold on ${voiceCall ? "a call that may be followed long runs to maxHoldMs" : "a non-voice signal is cut to the confirm floor"}`, () => {
			const plan = makeHopPlan(centres(2), HALF_SPAN_HZ)
			const sig: SimSignal = {
				...voice(HZ, 7_000, 70_000),
				confirmHoldMs: 60_000,
				followOnAir: voiceCall,
			}
			const r = simulateSweep(plan, spec, {
				...sim,
				durationMs: 90_000,
				signals: [sig],
			})
			const first = r.visits.find(v => v.leftAtMs - v.tunedAtMs > DWELL_MS)!
			const held = first.leftAtMs - first.tunedAtMs - DWELL_MS
			if (voiceCall) {
				expect(held).toBeGreaterThanOrEqual(60_000 - BLOCK_MS)
				expect(held).toBeLessThanOrEqual(60_000 + BLOCK_MS)
			} else
				expect(held).toBeLessThanOrEqual(
					CONFIRM_FLOOR_MS + PROBE_START_MS + BLOCK_MS,
				)
		})
	}
})
