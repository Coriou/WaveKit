// tests/unit/core/scanner/scheduler-fairness.test.ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	CONFIRM_FLOOR_MS,
	type SchedulerAction,
	SweepScheduler,
} from "../../../../src/core/scanner/scheduler.js"
import { DEFAULT_CONFIRM_HOLD_MS } from "../../../../src/core/scanner/plan/plan-preview.js"
import {
	hopTimeMs,
	simulateSweep,
	type SimResult,
	type SimSignal,
} from "../../../../src/core/scanner/plan/sweep-sim.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"

const MHZ = 1_000_000
/** The scheduler's per-frequency follow budget, as a test sets it up. */
interface FollowBudgetView {
	centreHz: number
	halfWidthHz: number
	usedMs: number
	usedAt: number
	strikes: number
}
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

/**
 * Visits of `hopIndex` that held something: longer than a dwell plus the longest listening
 * extension for a missed frequency (23 blocks from the epoch, 1150 ms, so 2 × DWELL_MS) and a
 * block. A hold of one 3-hop sweep makes a visit of 1150 + 3450 ms.
 */
const heldVisits = (r: SimResult, hopIndex: number): SimResult["visits"] =>
	r.visits.filter(
		v =>
			v.hopIndex === hopIndex &&
			v.leftAtMs - v.tunedAtMs > 2 * DWELL_MS + BLOCK_MS,
	)
/**
 * Retry slots of a frequency on air from the job start that is never heard as traffic: its first
 * hold, then retries once its budget refills (8, 16, 32 then 60 s charged, drained at 1/5 rate:
 * 40, 80, 160, then 300 s after the end of each hold). With 3450 ms holds from 0 s (one 3-hop
 * sweep) the holds start no earlier than 0, 43 450, 126 900, 290 350 and 593 800 ms.
 */
const retrySlots = (untilMs: number): number =>
	[0, 43_450, 126_900, 290_350, 593_800].filter(t => t < untilMs).length

describe("sweep fairness: steady carrier, empty hop, voice hop", () => {
	const plan = makeHopPlan(centres(3), HALF_SPAN_HZ)
	const layouts: [string, number][] = [
		["a carrier inside hop 0", 149.9 * MHZ],
		["a carrier in the hop 0/1 overlap", 150.4 * MHZ],
	]
	for (const [name, carrierHz] of layouts) {
		it(`${name}: quiet-band time follows the plan and the carrier is held once per retry slot`, () => {
			const r = simulateSweep(plan, spec, {
				...sim,
				durationMs: 180_000,
				signals: [
					carrier(carrierHz),
					voice(151.7 * MHZ, 40_000),
					voice(151.7 * MHZ, 100_000),
				],
			})
			// One hold on the carrier per retry slot (0, ≥ 43.5, ≥ 126.9 s in 180 s), shared by the
			// overlapping hops, never one per visit (re-holds were the skew).
			expect(r.holds[0]).toBeGreaterThanOrEqual(1)
			expect(r.holds[0]).toBeLessThanOrEqual(retrySlots(180_000))
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

	it("a frequency outlasting maxHoldMs is followed to maxHoldMs once, then held as a carrier", () => {
		const short = makeNormalisedSpec({
			dwellMs: DWELL_MS,
			settleMs: SETTLE_MS,
			hold: { ...spec.hold, maxHoldMs: 10_000 },
		})
		// A 60 s voice-like emitter from 5 s. Hop 2 had one full visit (2.3 s) that missed it, so it
		// is followed as new traffic, to the 10 s cap. Heard on air without a break for all of
		// maxHoldMs, it is a carrier: its retry budget is charged maxHoldMs (drained in 50 s), so
		// no later hold before about 16 + 50 s, after it ended (65 s), and none is long.
		const r = simulateSweep(plan, short, {
			...sim,
			durationMs: 90_000,
			signals: [voice(151.7 * MHZ, 5_000, 60_000)],
		})
		expect(r.holds[0]).toBe(1)
		const held = r.visits.filter(
			x => x.hopIndex === 2 && x.leftAtMs - x.tunedAtMs > 2 * DWELL_MS,
		)
		expect(held.length).toBe(1)
		expect(held[0]!.leftAtMs - held[0]!.tunedAtMs).toBeLessThanOrEqual(
			DWELL_MS + 10_000 + BLOCK_MS,
		)
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
			// The other emitters (on air from the start, never heard as traffic) are held once per
			// retry slot at most on each of their hops, never once per visit.
			for (const hop of [0, 1])
				expect(heldVisits(r, hop).length).toBeLessThanOrEqual(
					retrySlots(RUN_MS),
				)
		})
	}

	it("a lone labelled carrier at job start gets holds of one coarse sweep in its retry slots, not a long follow", () => {
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 120_000,
			signals: [labelledCarrier(C), voice(V, 40_000)],
		})
		expect(r.holds[0]).toBeGreaterThanOrEqual(1)
		expect(r.holds[0]).toBeLessThanOrEqual(retrySlots(120_000))
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

	it("a frequency with back-to-back new calls gets long follows of at most maxHoldMs, a coarse visit of every hop between two, and most of the time", () => {
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
		// Traffic has no budget past maxHoldMs per follow: each long follow is at most settle + dwell
		// + maxHoldMs (+ one block), and the calls get most of the 570 s they are on air. A cycle is
		// at most a 60 s follow, then a coarse visit of hops 1 and 2 and one deferred visit of hop 0
		// (4 × 1150 ms plus a hold of one coarse sweep, 3450 ms): 60 000 / 68 050 ≈ 88 %, less the
		// 3 s gaps that end a follow early. More than 70 % of the run.
		for (const v of long)
			expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(
				DWELL_MS + spec.hold.maxHoldMs + BLOCK_MS,
			)
		expect(followedMs).toBeGreaterThan(0.7 * (RUN_MS - 30_000))
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

	it("busy traffic keeps its hop's revisits; a bare carrier's hop gets none", () => {
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
		// The repeater's onset was seen (it keeps hop activity) though its 0.3 s gaps make it no
		// traffic to follow long; the carrier's hop is visited like the quiet hop.
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

	/**
	 * One case of Property 1: a 28 s call on hop `voiceSlot % hops` starting at `startMs`, beside
	 * `kind` on hop `otherSlot % hops` and, when `busy`, a busy channel on hop `busySlot % hops`.
	 * Returns the simulation and its signals for case-specific checks.
	 */
	const interceptCase = (
		hops: number,
		voiceSlot: number,
		otherSlot: number,
		busySlot: number,
		startMs: number,
		kind: Other,
		busy: boolean,
		revisitShare: number,
	): { r: SimResult; signals: SimSignal[] } => {
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
				...series(plan.hops[bHop]!.centreHz + 200_000, 20_000, 300, durationMs),
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
		return { r, signals }
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
				// A flapping carrier's later holds would end inside its sub-hangMs gaps: the same
				// emission, never held again, so it adds no hold after the first sweep.
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
				(...args) => {
					interceptCase(...args)
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)

	// Regression (fast-check seed 1): voice on hop 1 at 45 s, a labelled carrier flapping 3 s on /
	// 0.5 s off from 25.5 s on hop 6, a busy channel on hop 0. Each short hold of hop 6 ended inside
	// a 0.5 s off gap (heard off for less than hangMs 2000 ms) and freed the frequency, so hop 6 was
	// held for a coarse sweep (8050 ms) on three visits. Hop 1 then had only 2 full visits before
	// 45 s, not the 3 that bracket an onset, and the call got one coarse sweep: 8500 ms heard of 28 s.
	it("a call on a short-period sweep is held to its end beside a carrier flapping in sub-hang gaps", () => {
		const { r, signals } = interceptCase(
			7,
			946,
			181,
			0,
			45_000,
			"flapping",
			true,
			0.3,
		)
		// interceptCase checked the call (signal 0) is heard from detection to its end (8500 ms
		// before the fix).
		expect(r.heardMs[0]).toBeGreaterThan(8_500)
		// The flapping frequency (its first emission on air at the job start) is never heard as
		// traffic (its gaps are 0.5 s): held at most once per retry slot of an 8050 ms hold (0, then
		// no earlier than 8050 + 40 000 ms) in the 85 s run, each hold at most one coarse sweep (and
		// a hang classing a gap that started before its cap, 1050 ms).
		const flapHz = signals[1]!.centreHz
		const flapHop = r.visits.filter(
			v =>
				v.hopIndex === 181 % 7 &&
				v.leftAtMs - v.tunedAtMs > 2 * DWELL_MS + BLOCK_MS,
		)
		expect(flapHop.length).toBeLessThanOrEqual(2)
		for (const v of flapHop)
			expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(
				DWELL_MS + 7 * DWELL_MS + 1_050 + BLOCK_MS,
			)
		expect(signals.some(x => x.centreHz === flapHz)).toBe(true)
	})
})

describe("a hold ending in an off gap shorter than TRAFFIC_GAP_MS", () => {
	// Two hops of 1150 ms (settle 1000 + 3 blocks): one coarse sweep is 2300 ms. A labelled
	// transmission on hop 0 is on air at the job start, so its confirm probe (1800 + 300 ms) ends
	// the hold at 3250 ms. It goes off air at `endMs`; the first block off air (the close) ends
	// 50 ms later. A new transmission opens at 3600 ms, while hop 1 is visited. A close heard
	// 1000 ms (TRAFFIC_GAP_MS) before the hold ends (at the bound) is traffic, so the reopening is
	// held again; 950 ms (past it) is the same emission, still barred.
	for (const [endMs, heardOffMs, heldAgain] of [
		[2_200, 1_000, true],
		[2_250, 950, false],
	] as const) {
		it(`heard off for ${heardOffMs} ms when the hold ends: the reopening is ${heldAgain ? "held again" : "the same emission"}`, () => {
			const plan = makeHopPlan(centres(2), HALF_SPAN_HZ)
			const s = makeNormalisedSpec({
				dwellMs: DWELL_MS,
				settleMs: SETTLE_MS,
				revisit: { share: 0, maxIntervalMs: null },
			})
			const hz = plan.hops[0]!.centreHz + 100_000
			const r = simulateSweep(plan, s, {
				...sim,
				durationMs: 20_000,
				signals: [voice(hz, 0, endMs), voice(hz, 3_600, 100_000)],
			})
			expect(r.visits[0]?.leftAtMs).toBe(3_250)
			expect(3_250 - (endMs + BLOCK_MS)).toBe(heardOffMs)
			expect(r.holds).toEqual([1, heldAgain ? 1 : 0])
		})
	}
})

describe("frequency memory recovers when a gap is observed or may have passed", () => {
	const plan = makeHopPlan(centres(2), HALF_SPAN_HZ)
	/** One visit of 29 s listening: long enough to watch several transmissions come and go. */
	const LONG_DWELL_MS = 30_000

	// The gap heard runs from the close (the first block off air, 25 050 ms) to the reopen's
	// sighting (minSurfaceBlocks = 2 blocks after it goes on air): gap + 50 ms. TRAFFIC_GAP_MS is
	// 1000 ms.
	for (const [gapMs, followed] of [
		[900, false],
		[950, true],
	] as const) {
		it(`a gap of ${gapMs + 50} ms heard inside the dwell (traffic from 1000 ms) ${followed ? "is traffic: the next transmission is followed" : "is the same emission: the steady frequency stays steady"}`, () => {
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
	// minSurfaceBlocks (2), so afterMs − 50 ms. More than the longest gap of a flapping carrier
	// (600 ms) brackets the start of a new call, followed until a gap tells a turnaround from a
	// flap; up to 600 ms, a call on air through the whole previous visit may only have flickered.
	for (const [afterMs, followed] of [
		[650, false],
		[700, true],
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

	// A dwell (3 blocks) that misses a steady frequency listens on for it until 23 blocks: off that
	// long ((23 − 2) × 50 = 1050 ms ≥ TRAFFIC_GAP_MS) it is traffic, and its next sighting is held,
	// however many visits missed it.
	for (const [misses, held] of [
		[1, true],
		[2, true],
		[3, true],
	] as const) {
		it(`a steady frequency missed by ${misses} full visits listened for 1 s is ${held ? "held again" : "still steady"}`, () => {
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

	// Back within that listening (after 10 blocks: (10 − 2) × 50 = 400 ms heard off, short of
	// TRAFFIC_GAP_MS), it is the same emission: still steady, and the wait ends with the next block.
	it("a steady frequency a dwell misses that is back within 1 s stays steady", () => {
		const { s, at } = make(1_000, 185)
		s.start()
		s.onEpochStarted(0)
		s.onTrack(track("a"), false, 0, follow)
		at(1_000)
		s.onTrack(track("a"), false, 0, follow)
		dwell(s, 0)
		s.onEpochStarted(0)
		dwell(s, 0) // hop 1
		s.onEpochStarted(0)
		const early: SchedulerAction[] = []
		for (let k = 1; k <= 10; k++) early.push(...s.onBlock(k * 50))
		// The 3-block dwell missed it: no tune, the visit listens on.
		expect(early).toEqual([])
		s.onTrack(track("b"), false, 0, follow)
		expect(s.onBlock(550).some(a => a.type === "tune")).toBe(true)
		expect(s.progress().holdingOn).toBeNull()
	})

	// A track that opens after the visit received `blocks` blocks heard the frequency off air for
	// (blocks − minSurfaceBlocks) × 50 ms. On a persistent frequency (here a steady one heard on
	// every visit) more than the longest gap of a flapping carrier (600 ms) brackets a new
	// transmission, followed until a gap tells: 15 blocks (650 ms), not 14 (600 ms).
	for (const [blocks, followed] of [
		[14, false],
		[15, true],
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

	// A reopen within TRAFFIC_GAP_MS (1000 ms) is the same emission (a flapping carrier stays
	// steady); a close and an open in the same block is a rollover. TRAFFIC_GAP_MS after the close
	// it is traffic.
	for (const [blocksApart, gapMs, followed] of [
		[0, 0, false],
		[1, 50, false],
		[19, 950, false],
		[20, 1_000, true],
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
	// first visit nothing brackets an onset, so only a heard gap allows a follow past the bound of a
	// frequency not known as traffic (8000 ms). A close at 500 ms and a reopen at 10 050 ms is a
	// 9 550 ms gap (≥ TRAFFIC_GAP_MS 1000) when the visit listened throughout; across an outage (no
	// samples, then a new epoch) nothing was heard.
	for (const outage of [false, true]) {
		it(`a close and a reopen 9 550 ms later ${outage ? "across an outage is the same emission: 8 s" : "heard by the visit is a new call: followed past one coarse sweep"}`, () => {
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
			// The hold started at 10 050: the 8000 ms bound ends at 18 050 (at it, and a ms before).
			set(18_049)
			expect(s.tick(18_049)).toEqual([])
			set(18_050)
			expect(s.tick(18_050).some(a => a.type === "tune")).toBe(outage)
			if (!outage) {
				// Traffic: past one coarse sweep (34 050), up to maxHoldMs.
				set(34_050)
				expect(s.tick(34_050)).toEqual([])
				expect(s.progress().holdingOn).toBe("b")
			}
		})
	}

	// A frequency first heard after 43 blocks (2 050 ms of listening, ≥ TRAFFIC_GAP_MS) opened
	// late; after an outage the visit's listening restarts, so one block later is no late open: it
	// is held 8000 ms at most (the bound of a frequency not known as traffic), not one sweep.
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
			set(t0 + 8_000)
			expect(s.tick(t0 + 8_000).some(a => a.type === "tune")).toBe(outage)
			if (!outage) {
				// A heard onset is traffic: still followed past one coarse sweep (24 000 ms).
				set(t0 + 24_000)
				expect(s.tick(t0 + 24_000)).toEqual([])
				expect(s.progress().holdingOn).toBe("b")
			}
		})
	}

	it("overlapping hops share one retry budget per frequency", () => {
		// 150.4 MHz is inside hop 0 (to 150.4096) and hop 1 (from 150.3904). A carrier labelled
		// analog voice on air from the start, never heard as traffic, no revisits. Both hops hear it;
		// one bucket paces its holds whichever hop holds it: at most retrySlots(300 s) = 4 holds on
		// the two hops together, not 4 per hop.
		const plan = makeHopPlan(centres(3), HALF_SPAN_HZ)
		const noRevisit = makeNormalisedSpec({
			dwellMs: DWELL_MS,
			settleMs: SETTLE_MS,
			revisit: { share: 0, maxIntervalMs: null },
		})
		const r = simulateSweep(plan, noRevisit, {
			...sim,
			durationMs: 300_000,
			signals: [labelledCarrier(150.4 * MHZ)],
		})
		const held = heldVisits(r, 0).length + heldVisits(r, 1).length
		expect(held).toBeGreaterThanOrEqual(2)
		expect(held).toBeLessThanOrEqual(retrySlots(300_000))
	})

	it("between two long follows of traffic in a hop overlap, every hop has a coarse visit", () => {
		// 50 s calls with 3 s gaps (each heard as a new call) from 30 s on 150.4 MHz, in the hop 0/1
		// overlap, no confirm probe, no revisits. Traffic is bounded by maxHoldMs per follow and the
		// long-hold lock, whichever hop follows it.
		const plan = makeHopPlan(centres(3), HALF_SPAN_HZ)
		const noRevisit = makeNormalisedSpec({
			dwellMs: DWELL_MS,
			settleMs: SETTLE_MS,
			revisit: { share: 0, maxIntervalMs: null },
		})
		const RUN = 300_000
		const calls = series(150.4 * MHZ, 50_000, 3_000, RUN, 30_000).map(c => ({
			...c,
			needsConfirm: false,
		}))
		const r = simulateSweep(plan, noRevisit, {
			...sim,
			durationMs: RUN,
			signals: calls,
		})
		const long = r.visits.filter(
			v =>
				(v.hopIndex === 0 || v.hopIndex === 1) &&
				v.leftAtMs - v.tunedAtMs > DWELL_MS + 3 * DWELL_MS + BLOCK_MS,
		)
		expect(long.length).toBeGreaterThan(2)
		for (let k = 1; k < long.length; k++) {
			const between = r.visits.filter(
				v =>
					v.tunedAtMs >= long[k - 1]!.leftAtMs &&
					v.leftAtMs <= long[k]!.tunedAtMs,
			)
			expect(new Set(between.map(v => v.hopIndex)).has(2)).toBe(true)
		}
	})

	// Two hops of 185 ms: one coarse sweep is 370 ms. After three full idle visits of each hop an
	// onset is seen. A long follow on hop 0 locks the next long follow out until both hops had a
	// visit. A new call on hop 1 then needs an 1 800 ms confirm (hold 2 100 ms with the probe
	// start): the probe outlasts the 370 ms follow cap. Held back only by the lock, the call is not
	// barred: the visit of hop 1 after the lock clears follows it past one coarse sweep.
	it("a call whose confirm outlasts the follow cap while a long follow locks it out is followed on a later visit", () => {
		const { s, set } = make(185)
		const VOICE_HZ = 150.9 * MHZ
		/** Feeds blocks from `from` until the visit ends (a tune) or a hold starts. */
		const visit = (from: number): SchedulerAction[] => {
			for (let e = from + 50; e < from + 100_000; e += 50) {
				const a = s.onBlock(e)
				if (a.some(x => x.type === "tune")) return a
				if (s.progress().holdingOn !== null) return a
			}
			return []
		}
		s.start()
		for (let k = 0; k < 6; k++) {
			s.onEpochStarted(0)
			visit(0) // three full visits of each hop
		}
		// Hop 0: a call with a heard onset is followed long, then ends.
		s.onEpochStarted(0)
		s.onTrack(at("a"), false, 0, follow)
		visit(0)
		expect(s.progress().holdingOn).toBe("a")
		set(1_000)
		expect(s.tick(1_000)).toEqual([])
		s.onTrackClosed("a")
		set(3_000)
		expect(s.tick(3_000).some(a => a.type === "tune")).toBe(true)
		// Hop 1, lock active: the confirm probe runs 2 100 ms.
		s.onEpochStarted(0)
		s.onTrack(at("b", VOICE_HZ), true, 1_800, follow)
		expect(visit(0)).toEqual([
			{
				type: "start-probe",
				trackId: "b",
				holdMs: 2_100,
			},
		])
		const end = 3_000 + 2_100
		set(end)
		// No follow (the cap is spent); the hop is left with the call still on air.
		expect(s.tick(end).some(a => a.type === "tune")).toBe(true)
		expect(s.progress().holdingOn).toBeNull()
		s.onEpochStarted(0)
		visit(0) // hop 0: the lock clears
		// Hop 1 again: the same call, on air throughout, is probed and then followed long.
		set(end + 1_000)
		s.onEpochStarted(0)
		s.onTrack(at("b2", VOICE_HZ), true, 1_800, follow)
		// A barred or steady frequency would not be probed at all.
		expect(visit(0)).toEqual([
			{
				type: "start-probe",
				trackId: "b2",
				holdMs: 2_100,
			},
		])
		const probeEnd = end + 1_000 + 2_100
		set(probeEnd)
		expect(s.tick(probeEnd)).toEqual([{ type: "stop-probes" }])
		// Followed past one coarse sweep (370 ms) after the probe.
		set(probeEnd + 1_000)
		expect(s.tick(probeEnd + 1_000)).toEqual([])
		expect(s.progress().holdingOn).toBe("b2")
	})

	/**
	 * The scenario above up to the end of the locked confirm probe of hop 1 (clock `end`), then
	 * leaves hop 1 at `end`, visits hop 0 (the lock clears) and opens a call `b2` on the same
	 * frequency of hop 1. Returns the actions of that last visit (a start-probe unless barred).
	 */
	const lockedConfirm = (
		beforeEnd: (
			s: SweepScheduler,
			end: number,
			set: (ms: number) => void,
		) => void,
	) => {
		const { s, set } = make(185)
		const VOICE_HZ = 150.9 * MHZ
		const visit = (from: number): SchedulerAction[] => {
			for (let e = from + 50; e < from + 100_000; e += 50) {
				const a = s.onBlock(e)
				if (a.some(x => x.type === "tune")) return a
				if (s.progress().holdingOn !== null) return a
			}
			return []
		}
		s.start()
		for (let k = 0; k < 6; k++) {
			s.onEpochStarted(0)
			visit(0)
		}
		s.onEpochStarted(0)
		s.onTrack(at("a"), false, 0, follow)
		visit(0)
		set(1_000)
		s.tick(1_000)
		s.onTrackClosed("a")
		set(3_000)
		s.tick(3_000)
		s.onEpochStarted(0)
		s.onTrack(at("b", VOICE_HZ), true, 1_800, follow)
		expect(visit(0)).toEqual([
			{ type: "start-probe", trackId: "b", holdMs: 2_100 },
		])
		const end = 3_000 + 2_100
		beforeEnd(s, end, set)
		set(end)
		expect(s.tick(end).some(a => a.type === "tune")).toBe(true)
		s.onEpochStarted(0)
		visit(0)
		set(end + 1_000)
		s.onEpochStarted(0)
		s.onTrack(at("b2", VOICE_HZ), true, 1_800, follow)
		return { s, set, end, last: visit(0) }
	}

	// The probed call b closes during its probe and its frequency reopens at once as track b1: the
	// probe end picks b1 (deferred by the lock) while b is the tried track. The deferral covers the
	// frequency: it is not barred and its next visit follows the call.
	it("a reopening picked at the end of a locked confirm keeps its frequency deferred", () => {
		const { s, set, end, last } = lockedConfirm((sc, e, setClock) => {
			setClock(e - 500)
			sc.onTrackClosed("b")
			sc.onTrack(at("b1", 150.9 * MHZ), true, 1_800, follow)
		})
		expect(last).toEqual([
			{ type: "start-probe", trackId: "b2", holdMs: 2_100 },
		])
		const probeEnd = end + 1_000 + 2_100
		set(probeEnd)
		expect(s.tick(probeEnd)).toEqual([{ type: "stop-probes" }])
		set(probeEnd + 1_000)
		expect(s.tick(probeEnd + 1_000)).toEqual([])
		expect(s.progress().holdingOn).toBe("b2")
	})

	// Traffic has no follow budget past maxHoldMs per follow: whatever its frequency's bucket holds
	// at the probe end (here 0 or 1 ms left), the lock alone held it back, so it is deferred and b2
	// is probed.
	for (const left of [0, 1]) {
		it(`a locked confirm of traffic ending with ${left} ms left in its bucket is deferred`, () => {
			const { last } = lockedConfirm((sc, e) => {
				const budgets = (sc as unknown as { budgets: FollowBudgetView[] })
					.budgets
				budgets.push({
					centreHz: 150.9 * MHZ,
					halfWidthHz: 50_000,
					usedMs: 60_000 - left,
					usedAt: e,
					strikes: 0,
				})
			})
			expect(last.filter(a => a.type === "start-probe")).toEqual([
				{ type: "start-probe", trackId: "b2", holdMs: 2_100 },
			])
		})
	}

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
