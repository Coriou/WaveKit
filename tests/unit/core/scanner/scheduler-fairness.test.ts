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
import type { HopPlan } from "../../../../src/core/scanner/types.js"
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
/** The first hold of a frequency not known (CARRIER_WATCH_MS), and the cap of a carrier's holds. */
const WATCH_MS = 8_000
/** A hang that starts before a hold's cap may run this long to class the gap (1000 ms + a block). */
const CLASS_HANG_MS = 1_050
/**
 * L, the longest follow of voice on traffic from the start of a visit's holds (docs/SCANNER.md,
 * Fair holds): max(one coarse sweep, 28 000 − away − 5000), away = (hops − 1 + ⌈hops / 3⌉) ×
 * DWELL_MS + SETTLE_MS + 3 blocks. 2 hops: 28 000 − 3450 − 5000 = 19 550 ms; 3 hops: 28 000 −
 * 4600 − 5000 = 18 400 ms; 7 hops: 28 000 − 11 500 − 5000 = 11 500 ms.
 */
const longFollowMs = (hops: number): number =>
	Math.max(
		hops * DWELL_MS,
		28_000 -
			((hops - 1 + Math.ceil(hops / 3)) * DWELL_MS + SETTLE_MS + 3 * BLOCK_MS) -
			5_000,
	)
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

/** A DMR-like call: no analog label, a decoder confirms it 800 ms into its probe (traffic). */
const decodedCall = (
	hz: number,
	startMs: number,
	durationMs: number,
): SimSignal => ({
	...voice(hz, startMs, durationMs),
	followOnAir: false,
	decodeAfterMs: 800,
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

/** Visits of `hopIndex` that held something: longer than two dwells and a block. */
const heldVisits = (r: SimResult, hopIndex: number): SimResult["visits"] =>
	r.visits.filter(
		v =>
			v.hopIndex === hopIndex &&
			v.leftAtMs - v.tunedAtMs > 2 * DWELL_MS + BLOCK_MS,
	)
/**
 * Most holds a carrier gets in `runMs` on a plan of `hops` hops: its first hold, then one per
 * retry. A carrier's hold watches it to d = min(one sweep, WATCH_MS) from its start, then it rests
 * at least RETRY_REST_FACTOR (2) × 0.5 × d = d (spread from 0.5), so it is held at most half the
 * time and never on every visit.
 */
const carrierHolds = (hops: number, runMs: number): number => {
	const d = Math.min(hops * DWELL_MS, WATCH_MS)
	return 1 + Math.floor(runMs / (d + d))
}
/** Longest visit of a carrier's hold: a dwell, min(one sweep, WATCH_MS) and a hang classing a gap. */
const carrierVisitMs = (hops: number): number =>
	DWELL_MS + Math.min(hops * DWELL_MS, WATCH_MS) + CLASS_HANG_MS + BLOCK_MS
/**
 * Most a call whose onset a visit saw goes unheard after its detection: its first hold watches it
 * WATCH_MS, then every other hop gets a coarse visit (no carrier hold in that sweep), with at most
 * one revisit per round(1 / 0.3) = 3 coarse hops, and its hop is tuned again (a settle unheard):
 * (hops − 1 + ⌈hops / 3⌉) × DWELL_MS + SETTLE_MS (3 hops 4450 ms, 7 hops 11 350 ms). Then it is
 * followed to its end.
 */
const awayMs = (hops: number): number =>
	(hops - 1 + Math.ceil(hops / 3)) * DWELL_MS + SETTLE_MS
/** The hop listened through the last block of a transmission ending at `endMs`. */
const endHeard = (r: SimResult, hopIndex: number, endMs: number): boolean =>
	r.listens.some(
		l =>
			l.hopIndex === hopIndex &&
			l.fromMs <= endMs - BLOCK_MS &&
			l.toMs >= endMs,
	)
/** Whole blocks of a listening span [a, b] (on its block grid from a) inside [from, to]. */
const wholeBlocks = (
	a: number,
	b: number,
	from: number,
	to: number,
): number => {
	const first = a + Math.max(0, Math.ceil((from - a) / BLOCK_MS)) * BLOCK_MS
	return Math.max(0, Math.floor((Math.min(b, to) - first) / BLOCK_MS))
}
/**
 * The sweep saw the start of transmission `i` (docs/SCANNER.md, Fair holds: a full visit of its
 * hop missed it before it appeared): a full visit (minSurfaceBlocks + 1 blocks of listening or
 * more) of a hop holding its frequency, starting after the previous transmission on that frequency
 * started (the job start for the first one) and before this one did, during which no transmission
 * on the frequency was on air for minSurfaceBlocks whole blocks.
 */
const onsetSeen = (
	r: SimResult,
	plan: HopPlan,
	signals: readonly SimSignal[],
	i: number,
): boolean => {
	const sig = signals[i]!
	const same = signals.filter(x => x.centreHz === sig.centreHz)
	const prevStart = Math.max(
		0,
		...same.filter(x => x.startMs < sig.startMs).map(x => x.startMs),
	)
	return r.listens.some(l => {
		const span = plan.hops[l.hopIndex]!.covered
		return (
			sig.centreHz >= span.startHz &&
			sig.centreHz <= span.endHz &&
			l.toMs - l.fromMs >= (sim.minSurfaceBlocks + 1) * BLOCK_MS &&
			l.fromMs >= prevStart &&
			l.fromMs < sig.startMs &&
			same.every(
				e =>
					wholeBlocks(l.fromMs, l.toMs, e.startMs, e.endMs) <
					sim.minSurfaceBlocks,
			)
		)
	})
}
/**
 * Condition under which a 28 s call `i` is heard to its end. `only`: its start was seen and no
 * other transmission whose start the sweep saw is on air at any time during it. `inTime`: it was
 * detected (`at`) no later than latestDetectionMs(hops) after its start.
 */
const endCondition = (
	r: SimResult,
	plan: HopPlan,
	signals: readonly SimSignal[],
	i: number,
): { only: boolean; inTime: boolean } => {
	const call = signals[i]!
	const others = signals.filter(
		(x, j) =>
			j !== i &&
			x.startMs < call.endMs &&
			x.endMs > call.startMs &&
			onsetSeen(r, plan, signals, j),
	)
	const at = r.detectedAtMs[i]
	return {
		only: onsetSeen(r, plan, signals, i) && others.length === 0,
		inTime:
			at !== null &&
			at !== undefined &&
			at - call.startMs <= latestDetectionMs(plan.hops.length),
	}
}
/**
 * Latest detection, after its start, of a 28 s call whose end is guaranteed heard: its first hold
 * starts at the dwell end (a block after the detection) and watches it WATCH_MS; then it is one
 * sweep away (awayMs: every other hop's dwell, a revisit per three coarse hops and the settle of
 * the return, unheard), and the hop must listen again by its last block. 3 hops: 28 000 − 100 −
 * 8000 − 4450 = 15 450 ms; 7 hops: 28 000 − 100 − 8000 − 11 350 = 8550 ms.
 */
const latestDetectionMs = (hops: number): number =>
	28_000 - 2 * BLOCK_MS - WATCH_MS - awayMs(hops)
/** A confirm probe of the earlier scheduler: the job's confirm hold plus the probe start latency. */
const PROBE_HOLD_MS = CONFIRM_MS + PROBE_START_MS
/**
 * Floor of the ms a 28 s call is heard, from the earlier scheduler (one confirm probe per visit,
 * nothing followed without a decode). Each of its visits of the call's hop hears at most its dwell
 * (3 blocks) and one probe: 150 + 2100 = 2250 ms; the probe ends the visit (one track on the hop).
 * Without revisits, consecutive visits of the hop start at least one coarse sweep apart, its own
 * probe included: P = hops × DWELL_MS + 2100 (probes on other hops only lengthen it). So it hears
 * at most Σₖ min(2250, 28 000 − k × P): 2 hops 15 100, 3 hops 11 500, 4 hops 10 200, 5 hops 9000,
 * 6 hops 7750, 7 hops 6750 ms. On plans without revisits this bounds what it hears from above, so
 * a call heard this long is heard at least as long as it was. With revisits the earlier scheduler
 * can visit the hop more often and hear more: this floor is then its coarse cadence only.
 */
const earlierHeardMs = (hops: number): number => {
	const visitMs = DWELL_MS - SETTLE_MS + PROBE_HOLD_MS
	const periodMs = hops * DWELL_MS + PROBE_HOLD_MS
	let sum = 0
	for (let k = 0; 28_000 - k * periodMs > 0; k++)
		sum += Math.min(visitMs, 28_000 - k * periodMs)
	return sum
}

describe("sweep fairness: steady carrier, empty hop, voice hop", () => {
	const plan = makeHopPlan(centres(3), HALF_SPAN_HZ)
	const layouts: [string, number][] = [
		["a carrier inside hop 0", 149.9 * MHZ],
		["a carrier in the hop 0/1 overlap", 150.4 * MHZ],
	]
	for (const [name, carrierHz] of layouts) {
		it(`${name}: watched once, then held as a carrier; the first call is heard to its end, the second (on traffic) for L`, () => {
			const r = simulateSweep(plan, spec, {
				...sim,
				durationMs: 180_000,
				signals: [
					carrier(carrierHz),
					voice(151.7 * MHZ, 40_000),
					voice(151.7 * MHZ, 100_000),
				],
			})
			// The first hold watches it 8 s (on air without a break: carrier evidence); then one
			// carrier hold per retry, shared by the overlapping hops, each at most one sweep.
			const held = [...heldVisits(r, 0), ...heldVisits(r, 1)].filter(
				v => v.tunedAtMs > 0,
			)
			expect(r.holds[0]).toBeGreaterThanOrEqual(1)
			expect(r.holds[0]).toBeLessThanOrEqual(carrierHolds(3, 180_000))
			for (const v of held.filter(x => x.tunedAtMs > 20_000))
				expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(carrierVisitMs(3))
			// Both transmissions are detected (a sweep, a carrier hold, settle + 2 blocks).
			for (const i of [1, 2]) {
				const sig = [40_000, 100_000][i - 1]!
				const at = r.detectedAtMs[i]
				expect(at).not.toBeNull()
				expect(r.holds[i]).toBeLessThanOrEqual(2)
				expect(at! - sig).toBeLessThanOrEqual(
					3 * DWELL_MS + carrierVisitMs(3) + DWELL_MS,
				)
			}
			// The first, its onset seen on a frequency not known: watched 8 s, a coarse visit of
			// every hop (awayMs), then followed to its end.
			expect(endHeard(r, 2, 68_000)).toBe(true)
			expect(r.heardMs[1]).toBeGreaterThanOrEqual(
				68_000 - r.detectedAtMs[1]! - BLOCK_MS - awayMs(3),
			)
			// The second is on traffic (the first closed and the hop heard it off for 1 s): probed and
			// followed for what is left of L (18 400 ms) in its coarse sweep, which a carrier hold of
			// at most one coarse sweep (3450 ms) may have spent, so a 28 s ID on another hop is not
			// hidden; then every hop gets a coarse visit and its hop is probed, not followed, until
			// the lock clears (measured: detected 1050 ms after its start, heard 18 150 and 20 800 ms,
			// its end missed; the scheduler before L heard 27 050 ms and the end).
			const second = r.visits.find(
				v => v.hopIndex === 2 && v.tunedAtMs >= 100_000 - DWELL_MS,
			)!
			expect(second.leftAtMs - second.tunedAtMs).toBeLessThanOrEqual(
				DWELL_MS + longFollowMs(3) + BLOCK_MS,
			)
			expect(r.heardMs[2]).toBeGreaterThanOrEqual(
				longFollowMs(3) - 3 * DWELL_MS,
			)
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

	it("an emitter whose onset was seen is watched 8 s, followed to 30 s of its run, and a carrier once its run lasts maxHoldMs", () => {
		// A 120 s voice-like emitter from 5 s. Hop 2 had a full visit (2.3 s) that missed it, so its
		// onset was seen: its first hold watches it WATCH_MS (never maxHoldMs), the next one, after a
		// coarse visit of every hop, follows it to 30 s of its run (CALL_RUN_MS: a 28 s ID is heard
		// to its end), later ones watch it WATCH_MS each. On air without a break for maxHoldMs (no
		// close heard, no visit missing it), it is a carrier: its holds from then on are a carrier's.
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 200_000,
			signals: [voice(151.7 * MHZ, 5_000, 120_000)],
		})
		const held = heldVisits(r, 2)
		const seen = r.detectedAtMs[0]!
		expect(held.length).toBeGreaterThanOrEqual(3)
		expect(held[0]!.leftAtMs - held[0]!.tunedAtMs).toBeLessThanOrEqual(
			DWELL_MS + WATCH_MS + BLOCK_MS,
		)
		expect(held[1]!.leftAtMs).toBeLessThanOrEqual(seen + 30_000 + BLOCK_MS)
		expect(held[1]!.leftAtMs).toBeGreaterThanOrEqual(seen + 30_000 - BLOCK_MS)
		for (const v of held)
			expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(
				DWELL_MS + 30_000 - WATCH_MS,
			)
		for (const v of held.filter(x => x.tunedAtMs > seen + 60_000))
			expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(carrierVisitMs(3))
	})
})

describe("sweep fairness: labelled, flapping and busy emitters beside a voice hop", () => {
	const RUN_MS = 600_000
	const plan = makeHopPlan(centres(3), HALF_SPAN_HZ)
	const C = 149.9 * MHZ // hop 0
	const V = 151.7 * MHZ // hop 2
	/**
	 * Scenes of 600 s: emitters on hop 0 (and a busy channel on hop 1) on air from the job start,
	 * 28 s IDs on the last hop. On 3 and 7 hops.
	 */
	const scenes = (hops: number): [string, SimSignal[], number[], number][] => {
		const plan = makeHopPlan(centres(hops), HALF_SPAN_HZ)
		const C = plan.hops[0]!.centreHz - 100_000
		const BUSY = plan.hops[1]!.centreHz + 100_000
		/** 20 s overs with 0.3 s gaps, on air from the start. */
		const busy = (): SimSignal[] => series(BUSY, 20_000, 300, RUN_MS)
		return [
			[
				"a carrier labelled analog voice and a busy channel",
				[labelledCarrier(C), ...busy()],
				[60_000, 240_000, 420_000],
				RUN_MS,
			],
			["a lone labelled carrier", [labelledCarrier(C)], [40_000], 120_000],
			[
				"a labelled carrier flapping 3 s on / 0.5 s off",
				series(C, 3_000, 500, RUN_MS),
				[40_000, 220_000, 400_000],
				RUN_MS,
			],
			[
				"a labelled carrier flapping 20 s on / 0.3 s off",
				series(C, 20_000, 300, RUN_MS),
				[40_000, 220_000, 400_000],
				RUN_MS,
			],
			[
				"a flapping carrier and a busy channel",
				[...series(C, 3_000, 500, RUN_MS), ...busy()],
				[60_000, 240_000, 420_000],
				RUN_MS,
			],
			[
				"an unlabelled carrier",
				[carrier(C)],
				[40_000, 220_000, 400_000],
				RUN_MS,
			],
		]
	}
	for (const hops of [3, 7])
		for (const [name, others, ids, runMs] of scenes(hops))
			it(`${hops} hops, ${name}: every 28 s call on the voice hop is detected and followed to its end`, () => {
				const plan = makeHopPlan(centres(hops), HALF_SPAN_HZ)
				const V = plan.hops[hops - 1]!.centreHz + 100_000
				const signals = [...others, ...ids.map(at => voice(V, at))]
				const r = simulateSweep(plan, spec, {
					...sim,
					durationMs: runMs,
					signals,
				})
				const first = others.length
				// Worst case: the hop was just left. A coarse sweep, one carrier hold (at most one per
				// sweep), at most one revisit per round(1 / 0.3) = 3 coarse hops, then settle + 2
				// blocks: 3 hops 3450 + 4600 + 1150 + 1150 = 10 350 ms, 7 hops 8050 + 9100 + 3450 +
				// 1150 = 21 750 ms (the earlier scheduler: up to 6.3 s and 14.1 s on these scenes).
				const bound =
					hops * DWELL_MS +
					(carrierVisitMs(hops) - DWELL_MS) +
					Math.ceil(hops / 3) * DWELL_MS +
					DWELL_MS
				// Its onset was seen: watched 8 s, every hop a coarse visit (awayMs), then followed to
				// its end. One confirm probe per visit heard these calls 4500 to 6750 ms (3 hops) and
				// 4500 to 7050 ms (7 hops): never less than the most of those.
				const earlier = hops === 3 ? 6_750 : 7_050
				ids.forEach((startMs, k) => {
					const at = r.detectedAtMs[first + k]
					expect(at).not.toBeNull()
					expect(at! - startMs).toBeLessThanOrEqual(bound)
					expect(endHeard(r, hops - 1, startMs + 28_000)).toBe(true)
					expect(r.heardMs[first + k]).toBeGreaterThanOrEqual(
						Math.max(earlier, startMs + 28_000 - at! - BLOCK_MS - awayMs(hops)),
					)
				})
				// The other emitters are held as carriers: never on every visit, never long after
				// their first hold.
				for (const hop of [0, 1]) {
					const held = heldVisits(r, hop)
					expect(held.length).toBeLessThanOrEqual(carrierHolds(hops, runMs))
					for (const v of held.slice(1))
						expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(
							carrierVisitMs(hops),
						)
				}
				// The voice hop is no longer starved: more than its dwell share of the run's last
				// minutes would get with a carrier held on every visit (one probe per visit: 12 %).
				const [, , ...rest] = share(hopTimeMs(r, hops))
				expect(rest.at(-1)!).toBeGreaterThan(hops === 3 ? 0.2 : 0.1)
			})

	it("a lone labelled carrier at job start is watched 8 s once, then held one coarse sweep in its retry slots", () => {
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 120_000,
			signals: [labelledCarrier(C)],
		})
		const visits = r.visits.filter(v => v.hopIndex === 0)
		// settle + dwell, then the 8000 ms watch; later holds a carrier's.
		expect(visits[0]!.leftAtMs - visits[0]!.tunedAtMs).toBeLessThanOrEqual(
			DWELL_MS + WATCH_MS + BLOCK_MS,
		)
		for (const v of visits.slice(1))
			expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(carrierVisitMs(3))
		expect(heldVisits(r, 0).length).toBeLessThanOrEqual(
			carrierHolds(3, 120_000),
		)
	})

	it("a frequency with back-to-back new calls gets long follows of at most L in all between two visits of any other hop, and most of the time", () => {
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
		// A follow of traffic voice runs at most L (18 400 ms on 3 hops) from the start of the
		// visit's holds: each long follow is at most settle + dwell + L (+ one block), and the calls
		// still get most of the 570 s they are on air. A cycle is at most an L follow, then a coarse
		// visit of hops 1 and 2 and one visit of hop 0 under the lock, which only probes (4 × 1150
		// ms plus a 2100 ms probe): 18 400 / 25 100 ≈ 73 %, less the 3 s gaps that end a follow
		// early (measured 69 %). More than 60 % of the run (with follows to maxHoldMs: 70 %).
		for (const v of long)
			expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(
				DWELL_MS + longFollowMs(3) + BLOCK_MS,
			)
		expect(followedMs).toBeGreaterThan(0.6 * (RUN_MS - 30_000))
		// The follows share L: between two visits of hop 1 or hop 2, hop 0's follows last at most L
		// in all (a follow ended by a gap leaves the rest of L to the next one, which is cut there).
		// A visit of hop 0 that only probes (a 2100 ms confirm probe, under the lock) is no follow.
		const probeMs = CONFIRM_MS + PROBE_START_MS
		for (const hop of [1, 2]) {
			const own = r.visits.filter(v => v.hopIndex === hop)
			for (let k = 1; k < own.length; k++) {
				const sharedMs = r.visits
					.filter(
						v =>
							v.hopIndex === 0 &&
							v.tunedAtMs >= own[k - 1]!.leftAtMs &&
							v.leftAtMs <= own[k]!.tunedAtMs,
					)
					.map(v => v.leftAtMs - v.tunedAtMs - DWELL_MS)
					.filter(ms => ms > probeMs + BLOCK_MS)
					.reduce((a, ms) => a + ms, 0)
				expect(sharedMs).toBeLessThanOrEqual(longFollowMs(3) + BLOCK_MS)
			}
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
		// Followed from its first visit (a watch, then after a coarse visit of every hop to its end).
		expect(r.holds[0]).toBeGreaterThanOrEqual(1)
		expect(r.holds[0]).toBeLessThanOrEqual(2)
		expect(endHeard(r, 2, 68_000)).toBe(true)
		expect(r.heardMs[0]).toBeGreaterThanOrEqual(
			68_000 - r.detectedAtMs[0]! - 4 * BLOCK_MS - awayMs(3),
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
			// A DMR-like call on air from 7 s for 40 s (past the 20 s bound), decoded 800 ms into
			// its probe: traffic, followed past one sweep up to maxHoldMs.
			signals: [decodedCall(149.9 * MHZ, 7_000, 40_000)],
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

	it("a decoded call ending inside maxHoldMs is followed to its end plus hangMs", () => {
		const plan = makeHopPlan(centres(2), HALF_SPAN_HZ)
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 60_000,
			signals: [decodedCall(149.9 * MHZ, 7_000, 20_000)],
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
			makeNormalisedSpec({
				revisit: { share: 0, maxIntervalMs: null },
				// No watch after the probe: the hold is the probe alone.
				hold: { ...spec.hold, policy: "confirm" },
			}),
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

/** Deterministic uniform [0, 1) from a 32-bit seed (mulberry32). */
function random(seed: number): () => number {
	let x = seed >>> 0
	return () => {
		x = (x + 0x6d2b79f5) >>> 0
		let t = Math.imul(x ^ (x >>> 15), 1 | x)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
	}
}
/**
 * A synthetic QSO: overs of 5 to 30 s with turnarounds of `gapMinMs` to `gapMaxMs` (1 to 3 s by
 * default), from `fromMs` to `untilMs`.
 */
function qso(
	hz: number,
	fromMs: number,
	untilMs: number,
	seed: number,
	gapMinMs = 1_000,
	gapMaxMs = 3_000,
): SimSignal[] {
	const rnd = random(seed)
	const out: SimSignal[] = []
	let t = fromMs
	while (t < untilMs) {
		const over = Math.round(5_000 + 25_000 * rnd())
		out.push(voice(hz, t, Math.min(over, untilMs - t)))
		t += over + Math.round(gapMinMs + (gapMaxMs - gapMinMs) * rnd())
	}
	return out
}

describe("intercept property", () => {
	type Other = "none" | "carrier" | "labelled" | "flapping" | "flapping-slow"
	/**
	 * A busy channel on air from the start: 20 s overs with 0.3 s gaps (a flapping carrier to the
	 * scheduler), or a QSO with real turnarounds (5 to 30 s overs, 1 to 3 s gaps: traffic, followed
	 * long for L).
	 */
	type Busy = "none" | "flapping" | "turnarounds"
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
	 * `kind` on hop `otherSlot % hops` and a `busy` channel on hop `busySlot % hops` (a QSO's
	 * turnarounds from seed `busySeed`).
	 * Checks the guarantee and returns the simulation, its plan and signals, the call's hop and the
	 * end condition for case-specific checks.
	 */
	const interceptCase = (
		hops: number,
		voiceSlot: number,
		otherSlot: number,
		busySlot: number,
		startMs: number,
		kind: Other,
		busy: Busy,
		revisitShare: number,
		busySeed = 1,
	): {
		r: SimResult
		plan: HopPlan
		signals: SimSignal[]
		vHop: number
		condition: { only: boolean; inTime: boolean }
	} => {
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
		const busyHz = plan.hops[bHop]!.centreHz + 200_000
		if (busy === "flapping" && bHop !== vHop)
			signals.push(...series(busyHz, 20_000, 300, durationMs))
		if (busy === "turnarounds" && bHop !== vHop)
			signals.push(...qso(busyHz, 0, durationMs, busySeed))
		const r = simulateSweep(plan, s, { ...sim, durationMs, signals })
		const at = r.detectedAtMs[0]
		expect(at).not.toBeNull()
		if (busy !== "turnarounds") {
			// Detected while on air. Worst case: the hop was just left. One coarse sweep of the
			// other hops, each a dwell, at most one hold of one coarse sweep (a carrier's hold: 8000
			// ms, a hang classing a gap 1050 ms), at most one revisit per round(1 / 0.3) = 3 hops,
			// then settle + 2 blocks: 7 × 1150 + 9050 + 3 × 1150 + 1150 = 21 700 ms < 28 000 ms.
			expect(at! - startMs).toBeLessThanOrEqual(21_700)
			// Heard at least as long as one confirm probe per visit heard it (earlierHeardMs).
			expect(r.heardMs[0]).toBeGreaterThanOrEqual(earlierHeardMs(hops))
		}
		// Beside a QSO with real turnarounds (traffic) it is still detected while on air: the QSO's
		// follows and any carrier hold share L (longFollowMs) per coarse sweep, then every hop gets
		// a coarse visit with no carrier hold and the QSO's hop is not held. The scheduler before L
		// followed such a QSO for maxHoldMs and missed IDs on other hops. Measured over 5000 cases:
		// detected at most 25 511 ms after its start (7 hops); the time it is heard is not bounded
		// by one confirm probe per visit any more (the QSO's follows take that time; measured at
		// least 2550 ms, 7 hops).
		// Heard to its end when it is the only call on air whose start the sweep saw and it was
		// detected in time (latestDetectionMs), and no QSO on another hop is followed as traffic
		// (its follows of up to L may fall between the ID's watch and its return).
		const condition = endCondition(r, plan, signals, 0)
		if (busy !== "turnarounds" && condition.only && condition.inTime)
			expect(endHeard(r, vHop, startMs + 28_000)).toBe(true)
		return { r, plan, signals, vHop, condition }
	}

	// Feature: scanner-sweep-fairness, Property 1: every 28 s ID is detected, also beside a QSO with real 1 to 3 s turnarounds on another hop; beside carriers (labelled or not, steady or flapping) and a busy channel that flaps it is heard at least as long as one confirm probe per visit heard it (proven on plans without revisits; with revisits only against that pace); it is heard to its end when it is the only call on air whose start the sweep saw and it is detected at least 8 s plus one sweep away before its end
	// Validates: Requirements 3 (detection always, hold until it ends bounded by maxHoldMs), 2 (no re-hold on a steady or flapping carrier), 1 (no hop starved by another hop's holds)
	it("detects every 28 s ID, hears it at least as long as one confirm probe per visit (without revisits), and to its end when it is the only onset-seen call and detected in time", () => {
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
				fc.constantFrom<Busy>("none", "flapping", "turnarounds"),
				fc.constantFrom(0, 0.3),
				fc.nat(1_000),
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
	it("a call on a short-period sweep beside a carrier flapping in sub-hang gaps is watched 8 s, and the carrier is held at most twice", () => {
		const { r, signals } = interceptCase(
			7,
			946,
			181,
			0,
			45_000,
			"flapping",
			"flapping",
			0.3,
		)
		// interceptCase checked the guarantee for the call (signal 0); its first hold heard it a
		// watch long (8300 ms; before the fix that hold was one coarse sweep, 8500 ms, and the call
		// was not held again). Detected 13.4 s after its start (later than latestDetectionMs(7),
		// 8550 ms), it ends while every hop has its coarse visit (8050 ms and two revisits).
		expect(r.heardMs[0]).toBeGreaterThanOrEqual(WATCH_MS - BLOCK_MS)
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

	// Regression: 7 hops, the ID on hop 2 from 47 250 ms, a busy channel on hop 1, no revisits. Its
	// start was seen and no other call's was, but hop 2 was just left: it is detected 12 350 ms after
	// its start, watched 8 s, and its hop is back 300 ms after its end (heard 8150 ms). One confirm
	// probe per visit heard 4500 ms of it.
	it("7 hops: an ID detected 12.35 s after its start is heard more than one confirm probe per visit heard it; its end is missed only because it was detected too late", () => {
		const { r, condition, vHop } = interceptCase(
			7,
			30,
			851,
			8,
			47_250,
			"none",
			"flapping",
			0,
		)
		expect(r.detectedAtMs[0]! - 47_250).toBe(12_350)
		expect(r.heardMs[0]).toBeGreaterThanOrEqual(4_500)
		expect(condition.only).toBe(true)
		expect(condition.inTime).toBe(false)
		expect(endHeard(r, vHop, 47_250 + 28_000)).toBe(false)
		expect(latestDetectionMs(7)).toBe(8_550)
	})
})

describe("a transmission that closes during its probe", () => {
	// Two hops of 1150 ms: one coarse sweep is 2300 ms. A labelled transmission on hop 0 on air at
	// the job start is probed from the dwell end (1150 ms) to 3250 ms. It goes off air at 2200 ms
	// (the close is the end of the next block, 2250 ms) and reopens `reopenMs` later: the probe
	// end holds it in its hang (at least 1050 ms on a frequency not known as traffic), so the
	// reopening is heard. 1000 ms or more off air is a turnaround: traffic, followed. Less is a flap:
	// a carrier, held to its cap (one sweep from 1150 ms: 3450 ms).
	for (const [offMs, followed] of [
		[1_000, true],
		[500, false],
	] as const) {
		it(`reopening ${offMs} ms after the close is ${followed ? "traffic: followed" : "a flap: held as a carrier"}`, () => {
			const plan = makeHopPlan(centres(2), HALF_SPAN_HZ)
			const s = makeNormalisedSpec({
				dwellMs: DWELL_MS,
				settleMs: SETTLE_MS,
				revisit: { share: 0, maxIntervalMs: null },
			})
			const hz = plan.hops[0]!.centreHz + 100_000
			const r = simulateSweep(plan, s, {
				...sim,
				durationMs: 30_000,
				signals: [voice(hz, 0, 2_200), voice(hz, 2_250 + offMs, 20_000)],
			})
			const left = r.visits[0]!.leftAtMs
			if (followed) expect(left).toBeGreaterThanOrEqual(2_250 + offMs + 15_000)
			else expect(left).toBeLessThanOrEqual(3_450 + BLOCK_MS)
		})
	}
})

describe("frequency memory: gaps heard inside a visit", () => {
	const plan = makeHopPlan(centres(2), HALF_SPAN_HZ)
	/** One visit of 29 s listening: long enough to watch several transmissions come and go. */
	const LONG_DWELL_MS = 30_000

	// The gap heard runs from the close (the first block off air, 25 050 ms) to the reopen's
	// sighting (minSurfaceBlocks = 2 blocks after it goes on air): gap + 50 ms. TRAFFIC_GAP_MS is
	// 1000 ms: a shorter gap is a flap (a carrier, held to its cap: one sweep from the dwell end,
	// 30 000 + 8000 ms), a longer one a turnaround (traffic, followed to its end at 40 s).
	for (const [gapMs, followed] of [
		[900, false],
		[950, true],
	] as const) {
		it(`a gap of ${gapMs + 50} ms heard inside the dwell ${followed ? "is traffic: the next transmission is followed" : "is a flap: the next transmission is held as a carrier"}`, () => {
			const long = makeNormalisedSpec({
				dwellMs: LONG_DWELL_MS,
				settleMs: SETTLE_MS,
				revisit: { share: 0, maxIntervalMs: null },
				hold: { ...spec.hold, maxHoldMs: 20_000 },
			})
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
			expect(r.holds[1]).toBe(1)
			const left = r.visits[0]!.leftAtMs
			if (followed) {
				expect(r.heardMs[1]).toBeGreaterThanOrEqual(40_000 - startB - BLOCK_MS)
				expect(left).toBeGreaterThanOrEqual(40_000)
			} else
				expect(left).toBeLessThanOrEqual(LONG_DWELL_MS + WATCH_MS + BLOCK_MS)
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
})

describe("evidence rules (direct scheduler)", () => {
	const HZ = 149.9 * MHZ
	const track = (id: string): TrackSnapshot => ({
		...makeTrack({ id, centreHz: HZ, startedAt: 0 }),
		trackId: id,
	})
	const follow = { followOnAir: true }
	/** Two hops of `dwellMs` (one sample per ms, 50 ms blocks, 35 ms settle), no revisits. */
	const make = (
		dwellMs: number,
		maxHoldMs = 60_000,
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
				probeStartMs: PROBE_START_MS,
			},
		)
		return { s, at: ms => (clock = ms) }
	}
	/** Feeds 50-sample blocks from `from` until the scheduler tunes away or starts a hold. */
	const dwell = (s: SweepScheduler, from = 0): void => {
		for (let e = from + 50; e < from + 1_000_000; e += 50) {
			const a = s.onBlock(e)
			if (a.some(x => x.type === "tune") || s.progress().holdingOn !== null)
				return
		}
	}
	const tunes = (a: SchedulerAction[]): boolean =>
		a.some(x => x.type === "tune")
	/**
	 * A frequency on air at the job start on hop 0, watched WATCH_MS without a break on its first
	 * hold (from clock 0): a carrier. The scheduler is back on hop 0 after a visit of hop 1.
	 */
	const carrierAtStart = (dwellMs: number) => {
		const h = make(dwellMs)
		h.s.start()
		h.s.onEpochStarted(0)
		h.s.onTrack(track("a"), false, 0, follow)
		dwell(h.s)
		expect(h.s.progress().holdingOn).toBe("a")
		h.at(WATCH_MS - 1)
		expect(h.s.tick(WATCH_MS - 1)).toEqual([])
		h.at(WATCH_MS)
		expect(tunes(h.s.tick(WATCH_MS))).toBe(true)
		h.s.onEpochStarted(0)
		dwell(h.s) // hop 1
		return h
	}

	it("a frequency on air at the job start is watched at most 8 s, then rests and is held one sweep as a carrier", () => {
		const { s, at } = carrierAtStart(185)
		// Back on hop 0 at once: it rests (at least 2 × 0.5 × 8000 ms), so it is not held.
		s.onEpochStarted(0)
		s.onTrack(track("b"), false, 0, follow)
		dwell(s)
		expect(s.progress().holdingOn).toBeNull()
		s.onEpochStarted(0)
		dwell(s) // hop 1
		// Past its longest rest (8000 + 3 × 8000 ms): held to a carrier's cap, one sweep (370 ms).
		at(40_000)
		s.onEpochStarted(0)
		s.onTrack(track("c"), false, 0, follow)
		dwell(s)
		expect(s.progress().holdingOn).toBe("c")
		at(40_369)
		expect(s.tick(40_369)).toEqual([])
		at(40_370)
		expect(tunes(s.tick(40_370))).toBe(true)
	})

	// A close and a reopen inside one visit: in the same block a rollover (no evidence, still not
	// known: watched WATCH_MS), less than TRAFFIC_GAP_MS apart a flap (a carrier: held one sweep,
	// 6000 ms), TRAFFIC_GAP_MS or more a turnaround (traffic: followed to maxHoldMs).
	for (const [blocksApart, gapMs, kind] of [
		[0, 0, "unknown"],
		[1, 50, "carrier"],
		[19, 950, "carrier"],
		[20, 1_000, "traffic"],
	] as const) {
		it(`a close and a reopen ${blocksApart} blocks (${gapMs} ms) apart: ${kind}`, () => {
			const { s, at } = make(3_000)
			s.start()
			s.onEpochStarted(0)
			at(1_000)
			s.onTrack(track("a"), false, 0, follow)
			s.onBlock(50)
			s.onTrackClosed("a")
			for (let k = 1; k <= blocksApart; k++) s.onBlock(50 + 50 * k)
			const t0 = 1_000 + gapMs
			at(t0)
			s.onTrack(track("b"), false, 0, follow)
			dwell(s, 50 + 50 * blocksApart)
			expect(s.progress().holdingOn).toBe("b")
			at(t0 + 6_000)
			expect(tunes(s.tick(t0 + 6_000))).toBe(kind === "carrier")
			if (kind === "carrier") return
			at(t0 + WATCH_MS)
			expect(tunes(s.tick(t0 + WATCH_MS))).toBe(kind === "unknown")
		})
	}

	// A new frequency that opens after the visit listened without it: (blocks − minSurfaceBlocks)
	// × 50 ms off air heard, one block short (its track event comes before its block's). 22 blocks
	// read 1000 ms: a heard gap, traffic (followed past WATCH_MS); 21 blocks read 950 ms: not known.
	for (const [blocks, traffic] of [
		[21, false],
		[22, true],
	] as const) {
		it(`a new frequency opening after ${blocks} blocks of listening is ${traffic ? "traffic" : "not known"}`, () => {
			const { s, at } = make(3_000)
			s.start()
			s.onEpochStarted(0)
			for (let k = 1; k <= blocks; k++) s.onBlock(k * 50)
			s.onTrack(track("b"), false, 0, follow)
			dwell(s, blocks * 50)
			expect(s.progress().holdingOn).toBe("b")
			at(WATCH_MS)
			expect(tunes(s.tick(WATCH_MS))).toBe(!traffic)
		})
	}

	// A visit of 3000 ms that does not hear a carrier listened for more than TRAFFIC_GAP_MS: it was
	// off air that long, traffic, followed long on its next sighting. A visit that hears it keeps
	// it a carrier: held one sweep (6000 ms) once its rest is over.
	for (const heard of [false, true]) {
		it(`a carrier a 3 s visit ${heard ? "hears stays a carrier" : "does not hear is traffic"}`, () => {
			const { s, at } = carrierAtStart(3_000)
			s.onEpochStarted(0)
			if (heard) s.onTrack(track("b"), false, 0, follow)
			dwell(s) // hop 0, resting or not heard: no hold
			expect(s.progress().holdingOn).toBeNull()
			s.onEpochStarted(0)
			dwell(s) // hop 1
			at(100_000)
			s.onEpochStarted(0)
			s.onTrack(track("c"), false, 0, follow)
			dwell(s)
			expect(s.progress().holdingOn).toBe("c")
			at(106_000)
			expect(tunes(s.tick(106_000))).toBe(heard)
		})
	}

	/**
	 * A frequency on air at the job start on hop 0 that flaps in its first hold: it closes at 200 ms
	 * and reopens a block later (a flap, carrier evidence), so its hold ends at a carrier's cap, one
	 * sweep (370 ms) from its start. It rests at least FLAP_REST_FACTOR (20) × 0.5 × 370 = 3700 ms.
	 * The scheduler is back on hop 0 after a visit of hop 1, at clock 370.
	 */
	const flappedAtStart = () => {
		const h = make(185)
		h.s.start()
		h.s.onEpochStarted(0)
		h.s.onTrack(track("a"), false, 0, follow)
		dwell(h.s)
		expect(h.s.progress().holdingOn).toBe("a")
		h.at(200)
		h.s.onBlock(200)
		h.s.onTrackClosed("a")
		h.at(250)
		h.s.onBlock(250)
		h.s.onTrack(track("a2"), false, 0, follow)
		h.at(369)
		expect(h.s.tick(369)).toEqual([])
		h.at(370)
		expect(tunes(h.s.tick(370))).toBe(true)
		h.s.onEpochStarted(0)
		dwell(h.s) // hop 1
		return h
	}

	// Evidence is kept while full visits keep hearing the frequency: after FORGET_MISSES (10) full
	// visits in a row miss it, it is forgotten: new again, on a hop whose full visits missed it
	// (its onset seen), so watched WATCH_MS, not held to a carrier's 370 ms sweep.
	for (const [misses, forgotten] of [
		[9, false],
		[10, true],
	] as const) {
		it(`a flapping carrier missed by ${misses} full visits is ${forgotten ? "forgotten" : "still a carrier"}`, () => {
			const { s, at } = flappedAtStart()
			at(100_000)
			for (let k = 0; k < misses; k++) {
				s.onEpochStarted(0)
				dwell(s) // hop 0, not heard
				s.onEpochStarted(0)
				dwell(s) // hop 1
			}
			s.onEpochStarted(0)
			s.onTrack(track("b"), false, 0, follow)
			dwell(s)
			expect(s.progress().holdingOn).toBe("b")
			at(100_370)
			expect(tunes(s.tick(100_370))).toBe(!forgotten)
		})
	}

	// Regression: a carrier still resting was kept however many visits missed it, so a call on its
	// frequency after it went silent got no hold until the rest ran out (7 hops: 450 ms heard of a
	// 28 s ID at 100 s, one confirm probe per visit heard 11 250 ms). Forgetting clears the rest too.
	for (const [misses, forgotten] of [
		[9, false],
		[10, true],
	] as const) {
		it(`a resting carrier missed by ${misses} full visits is ${forgotten ? "forgotten with its rest" : "still resting"}`, () => {
			const { s, at } = flappedAtStart()
			// At 1000 ms it rests until 370 + 20 × (0.5 to 1.5) × 370 ≥ 4070 ms.
			at(1_000)
			for (let k = 0; k < misses; k++) {
				s.onEpochStarted(0)
				dwell(s) // hop 0, not heard
				s.onEpochStarted(0)
				dwell(s) // hop 1
			}
			s.onEpochStarted(0)
			s.onTrack(track("b"), false, 0, follow)
			dwell(s)
			expect(s.progress().holdingOn).toBe(forgotten ? "b" : null)
		})
	}

	it("a carrier that never flapped is listened to 1 s when a dwell misses it: still off, it is traffic", () => {
		// Watched WATCH_MS without a break at the job start: a carrier. Past its rest, a dwell of
		// hop 0 that does not hear it listens on to (2 + 20) blocks from its epoch (1000 ms of
		// listening): it stays off, a gap that long is traffic, followed past a carrier's cap.
		const { s, at } = carrierAtStart(185)
		at(100_000)
		s.onEpochStarted(0)
		let ends = 0
		for (let e = 50; e <= 2_000 && ends === 0; e += 50)
			if (tunes(s.onBlock(e))) ends = e
		expect(ends).toBe(22 * 50)
		s.onEpochStarted(0)
		dwell(s) // hop 1
		s.onEpochStarted(0)
		s.onTrack(track("b"), false, 0, follow)
		dwell(s)
		expect(s.progress().holdingOn).toBe("b")
		at(100_000 + WATCH_MS)
		expect(s.tick(100_000 + WATCH_MS)).toEqual([])
	})

	it("overlapping hops share a carrier's evidence and retry budget", () => {
		// 150.4 MHz is inside hop 0 (to 150.4096) and hop 1 (from 150.3904). A carrier labelled
		// analog voice on air from the start, no revisits. Both hops hear it; one memory paces its
		// holds whichever hop holds it: at most carrierHolds(300 s) on the two hops together.
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
		const held = [...heldVisits(r, 0), ...heldVisits(r, 1)]
		expect(held.length).toBeGreaterThanOrEqual(2)
		expect(held.length).toBeLessThanOrEqual(carrierHolds(3, 300_000))
		// One first watch, on whichever hop heard it first; then a carrier's holds on both.
		expect(
			held.filter(v => v.leftAtMs - v.tunedAtMs > carrierVisitMs(3)).length,
		).toBeLessThanOrEqual(1)
	})
})

describe("hold evidence across restarts, the long-hold lock and confirm bounds", () => {
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
				// Traffic: followed past the 8000 ms bound up to L, which on this plan is one coarse
				// sweep (away = 2 × 12 000 + 35 + 150 = 24 185 ms leaves 28 000 − 24 185 − 5000 < 0):
				// 10 050 + 24 000 = 34 050 (a ms before it, and at it).
				set(34_049)
				expect(s.tick(34_049)).toEqual([])
				expect(s.progress().holdingOn).toBe("b")
				set(34_050)
				expect(s.tick(34_050).some(a => a.type === "tune")).toBe(true)
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
				// A heard onset is traffic: followed past the 8000 ms bound up to L, one coarse sweep
				// (24 000 ms) on this plan (a ms before it, and at it).
				set(t0 + 23_999)
				expect(s.tick(t0 + 23_999)).toEqual([])
				expect(s.progress().holdingOn).toBe("b")
				set(t0 + 24_000)
				expect(s.tick(t0 + 24_000).some(a => a.type === "tune")).toBe(true)
			}
		})
	}

	it("follows of traffic in a hop overlap share L between two visits of the other hop", () => {
		// 50 s calls with 3 s gaps (each heard as a new call) from 30 s on 150.4 MHz, in the hop 0/1
		// overlap, no confirm probe, no revisits. Traffic is bounded by L, whichever hop follows it:
		// between two visits of hop 2, the follows of hops 0 and 1 last at most L in all.
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
		// A visit's time past its dwell is its holds, and a dwell lengthened by up to 4 blocks for
		// the class of a young track (a new call's first blocks).
		const own = r.visits.filter(v => v.hopIndex === 2)
		for (let k = 1; k < own.length; k++) {
			const between = r.visits.filter(
				v =>
					v.hopIndex !== 2 &&
					v.tunedAtMs >= own[k - 1]!.leftAtMs &&
					v.leftAtMs <= own[k]!.tunedAtMs,
			)
			const heldMs = between.reduce(
				(a, v) => a + v.leftAtMs - v.tunedAtMs - DWELL_MS,
				0,
			)
			expect(heldMs).toBeLessThanOrEqual(
				longFollowMs(3) + BLOCK_MS + between.length * 4 * BLOCK_MS,
			)
		}
	})

	/**
	 * Hop 1's last idle visit: a decoder confirms a call on `hz` during its probe (the job only
	 * notes it), so its frequency is traffic.
	 */
	const primeTraffic = (
		s: SweepScheduler,
		visit: (from: number) => SchedulerAction[],
		hz: number,
	): void => {
		s.onEpochStarted(0)
		s.onTrack(at("x", hz), true, 1_800)
		expect(visit(0)).toEqual([
			{ type: "start-probe", trackId: "x", holdMs: 2_100 },
		])
		expect(s.onConfirmed("x", false).some(a => a.type === "tune")).toBe(true)
	}

	// Two hops of 185 ms: one coarse sweep is 370 ms. After three full idle visits of each hop an
	// onset is seen; a decoder confirmed a call on 150.9 MHz (hop 1), so it is traffic. A watch of
	// a call on hop 0 (its onset seen) that outlasts one sweep locks the next long follow out until
	// both hops had a visit. A new call on 150.9 MHz then needs an 1 800 ms confirm (hold 2 100 ms
	// with the probe start): the probe outlasts the 370 ms follow cap. Held back only by the lock,
	// the call is held again: the visit of hop 1 after the lock clears follows it past one sweep.
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
		for (let k = 0; k < 5; k++) {
			s.onEpochStarted(0)
			visit(0) // three full visits of each hop
		}
		primeTraffic(s, visit, VOICE_HZ)
		// Hop 0: a call with a heard onset is watched (past one sweep), then ends.
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
	 * frequency of hop 1. Returns the actions of that last visit.
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
		for (let k = 0; k < 5; k++) {
			s.onEpochStarted(0)
			visit(0)
		}
		primeTraffic(s, visit, VOICE_HZ)
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
	// probe end picks b1 (cut to one sweep by the lock) while b is the tried track. Its frequency is
	// held again on the next visit, which follows the call.
	it("a reopening picked at the end of a locked confirm leaves its frequency followable", () => {
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
		// A call after the first sweeps (its onset seen) is followed to its end: watched 8 s, a
		// coarse visit of every hop, then on to its end.
		const later = r.detectedAtMs[2]
		expect(later).not.toBeNull()
		expect(endHeard(r, 2, 68_000)).toBe(true)
		expect(r.heardMs[2]).toBeGreaterThanOrEqual(
			68_000 - later! - BLOCK_MS - awayMs(3),
		)
	})

	// A decoder confirmed a call on the frequency at 2 to 5 s (noted, not followed): it is traffic,
	// so voice on it may be followed long and its confirm hold may then run to that follow's cap,
	// L: 19 550 ms on 2 hops (longFollowMs).
	for (const voiceCall of [true, false]) {
		it(`a 60 s confirm hold on ${voiceCall ? "a call that may be followed long runs to L" : "a non-voice signal is cut to the confirm floor"}`, () => {
			const plan = makeHopPlan(centres(2), HALF_SPAN_HZ)
			const sig: SimSignal = {
				...voice(HZ, 7_000, 70_000),
				confirmHoldMs: 60_000,
				followOnAir: voiceCall,
			}
			const r = simulateSweep(plan, spec, {
				...sim,
				durationMs: 90_000,
				signals: [
					{ ...decodedCall(HZ, 2_000, 3_000), decodeFollows: false },
					sig,
				],
			})
			const first = r.visits.find(
				v => v.tunedAtMs >= 5_000 && v.leftAtMs - v.tunedAtMs > DWELL_MS,
			)!
			const held = first.leftAtMs - first.tunedAtMs - DWELL_MS
			if (voiceCall) {
				expect(longFollowMs(2)).toBe(19_550)
				expect(held).toBeGreaterThanOrEqual(longFollowMs(2) - BLOCK_MS)
				expect(held).toBeLessThanOrEqual(longFollowMs(2) + BLOCK_MS)
			} else
				expect(held).toBeLessThanOrEqual(
					CONFIRM_FLOOR_MS + PROBE_START_MS + BLOCK_MS,
				)
		})
	}
})

describe("calls and carriers whose onset a visit saw", () => {
	// Earlier scheduler (one confirm probe per visit) on the same scenes: detection after the call's
	// start and ms heard.

	// Regression: 7 hops, a carrier labelled analog voice from 10 s on hop 0 (its start seen) and a
	// 28 s ID from 20 s on hop 6. The two share the time: the ID is detected 14.4 s after its start
	// and heard 8150 ms, and its end is missed. One confirm probe per visit heard 4500 ms of it.
	it("7 hops, mid-job carrier: the ID is heard more than one confirm probe per visit heard it; its end is missed: another onset-seen call is on air and it is detected after the deadline", () => {
		const plan = makeHopPlan(centres(7), HALF_SPAN_HZ)
		const signals = [
			labelledCarrier(plan.hops[0]!.centreHz - 100_000, 10_000),
			voice(plan.hops[6]!.centreHz + 100_000, 20_000),
		]
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 60_000,
			signals,
		})
		expect(r.detectedAtMs[1]).not.toBeNull()
		expect(r.heardMs[1]).toBeGreaterThanOrEqual(4_500)
		expect(onsetSeen(r, plan, signals, 0)).toBe(true)
		const condition = endCondition(r, plan, signals, 1)
		expect(condition.only).toBe(false)
		expect(condition.inTime).toBe(false)
		expect(endHeard(r, 6, 48_000)).toBe(false)
	})

	for (const hops of [3, 7]) {
		it(`${hops} hops: a carrier labelled analog voice from 10 s does not hide a 28 s ID on another hop from 20 s`, () => {
			// Regression: the carrier's onset was seen (hop 0's first visits missed it), so it was
			// followed like traffic to maxHoldMs and the ID was never detected. One confirm probe per
			// visit detected the ID 7900 ms (3 hops) or 12 700 ms (7 hops) after its start and heard
			// 4500 ms of it.
			const plan = makeHopPlan(centres(hops), HALF_SPAN_HZ)
			const C = plan.hops[0]!.centreHz - 100_000
			const V = plan.hops[hops - 1]!.centreHz + 100_000
			const r = simulateSweep(plan, spec, {
				...sim,
				durationMs: 60_000,
				signals: [labelledCarrier(C, 10_000), voice(V, 20_000)],
			})
			const at = r.detectedAtMs[1]
			expect(at).not.toBeNull()
			expect(at! - 20_000).toBeLessThan(28_000 - 2 * BLOCK_MS)
			expect(r.heardMs[1]).toBeGreaterThanOrEqual(4_500)
			// The carrier's first hold watches it 8 s (never maxHoldMs); its next one, after a coarse
			// visit of every hop, follows it to at most 30 s of its run.
			const held = heldVisits(r, 0)
			expect(held.length).toBeGreaterThanOrEqual(1)
			expect(held[0]!.leftAtMs - held[0]!.tunedAtMs).toBeLessThanOrEqual(
				DWELL_MS + WATCH_MS + BLOCK_MS,
			)
			for (const v of held)
				expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(
					DWELL_MS + 30_000 - WATCH_MS,
				)
		})

		// A lone 28 s ID after the first sweeps. One confirm probe per visit heard (at 40, 41, 43 and
		// 45.5 s) 3 hops: 13 850 / 14 850 / 13 500 / 13 500 ms; 7 hops: 11 400 / 9 000 / 10 800 /
		// 11 250 ms.
		const earlier: Record<number, number[]> = {
			3: [13_850, 14_850, 13_500, 13_500],
			7: [11_400, 9_000, 10_800, 11_250],
		}
		;[40_000, 41_000, 43_000, 45_500].forEach((startMs, k) => {
			it(`${hops} hops: a lone 28 s ID at ${startMs} ms is followed to its end and heard ≥ ${earlier[hops]![k]} ms`, () => {
				const plan = makeHopPlan(centres(hops), HALF_SPAN_HZ)
				const V = plan.hops[hops - 1]!.centreHz + 100_000
				const r = simulateSweep(plan, spec, {
					...sim,
					durationMs: startMs + 35_000,
					signals: [voice(V, startMs)],
				})
				expect(endHeard(r, hops - 1, startMs + 28_000)).toBe(true)
				expect(r.heardMs[0]).toBeGreaterThanOrEqual(earlier[hops]![k]!)
			})
		})

		it(`${hops} hops: an ID on a frequency silent for 90 s after a flapping carrier gets its holds`, () => {
			// Regression: transmissions at 0-3, 3.5-6.5 and 7-10 s (gaps of 0.5 s: a flapping carrier,
			// resting about 20 × its hold), then silence. Forgetting after ten missed visits was held
			// back by the rest, so a 28 s ID on the frequency at 100 s got no hold: 7 hops heard 450
			// ms of it. One confirm probe per visit heard 14 450 ms (3 hops) and 11 250 ms (7 hops).
			const plan = makeHopPlan(centres(hops), HALF_SPAN_HZ)
			const F = plan.hops[0]!.centreHz - 100_000
			const r = simulateSweep(plan, spec, {
				...sim,
				durationMs: 135_000,
				signals: [
					voice(F, 0, 3_000),
					voice(F, 3_500, 3_000),
					voice(F, 7_000, 3_000),
					voice(F, 100_000),
				],
			})
			expect(r.heardMs[3]).toBeGreaterThanOrEqual(hops === 3 ? 14_450 : 11_250)
			expect(endHeard(r, 0, 128_000)).toBe(true)
		})
	}
})

describe("frequency memory lookups", () => {
	it("closing 205 tracks with a full memory of 60 hops compares a few entries per lookup", () => {
		// 60 hops: MAX_FREQUENCY_MEMORY (256) × 60 = 15 360 frequencies, 12.5 kHz apart, then 205
		// tracks (the channels of one 2.56 MHz hop) open and close in one visit. Each close looks up
		// its frequency and that of every track still open: at most 205 × 206 / 2 + 205 lookups, each
		// reading the entries of the index bins within 6250 Hz (at most 3 here). A scan of the memory
		// per lookup compared about 21 320 × 15 360 / 2 ≈ 1.6 × 10⁸ entries.
		const hops = 60
		let clock = 0
		const s = new SweepScheduler(
			makeHopPlan(
				Array.from({ length: hops }, (_, i) => 150 * MHZ + i * 2_560_000),
				1_280_000,
			),
			makeNormalisedSpec({ revisit: { share: 0, maxIntervalMs: null } }),
			{
				blockSamples: 50,
				sampleRateHz: 1000,
				now: () => clock,
				probeStartMs: PROBE_START_MS,
			},
		)
		const sighting = (id: string, hz: number): TrackSnapshot => ({
			...makeTrack({ id, centreHz: hz, startedAt: 0 }),
			trackId: id,
		})
		s.start()
		s.onEpochStarted(0)
		const total = 256 * hops
		const tracks = 205
		for (let k = 0; k < total - tracks; k++)
			s.onTrack(sighting(`m${k}`, 140 * MHZ + k * 12_500), false, 0)
		const filled = s.memoryComparisons()
		expect(filled).toBeLessThanOrEqual(3 * (total - tracks))
		clock = 1
		s.onEpochStarted(0)
		const base = 140 * MHZ + (total - tracks) * 12_500
		for (let k = 0; k < tracks; k++)
			s.onTrack(sighting(`t${k}`, base + k * 12_500), false, 0)
		for (let k = 0; k < tracks; k++) s.onTrackClosed(`t${k}`)
		const lookups = tracks + (tracks * (tracks + 1)) / 2
		expect(s.memoryComparisons() - filled).toBeLessThanOrEqual(3 * lookups)
	})
})

describe("flaps of a frequency known as a call (direct scheduler)", () => {
	const HZ = 149.9 * MHZ
	interface Entry {
		evidence: string
		flaps: boolean
		flapRest: boolean
		flapListenMs: number
	}
	/**
	 * One 40 000 ms visit of hop 0 (2 hops, 50 ms blocks, no revisits): opens and closes of one
	 * frequency at given clocks, heard inside the visit (no hold: no confirm, no voice). With
	 * `listenedMs`, the frequency's memory is given that much held time of earlier visits since
	 * its last flap (as noteFlapListening adds it) at `listenedMs[0]`.
	 */
	const visit = (
		events: [number, "open" | "close"][],
		listenedMs?: [number, number],
	): Entry => {
		let clock = 0
		const s = new SweepScheduler(
			makeHopPlan(centres(2), HALF_SPAN_HZ),
			makeNormalisedSpec({
				dwellMs: 40_000,
				settleMs: 35,
				revisit: { share: 0, maxIntervalMs: null },
			}),
			{
				blockSamples: 50,
				sampleRateHz: 1000,
				now: () => clock,
				probeStartMs: PROBE_START_MS,
			},
		)
		s.start()
		s.onEpochStarted(0)
		const memory = (): Entry => (s as unknown as { memory: Entry[] }).memory[0]!
		let n = 0
		for (const [ms, kind] of events) {
			while (clock < ms) {
				clock += 50
				s.onBlock(clock)
			}
			if (listenedMs !== undefined && clock === listenedMs[0])
				memory().flapListenMs = listenedMs[1]
			if (kind === "open")
				s.onTrack(
					{
						...makeTrack({ id: `t${n}`, centreHz: HZ, startedAt: 0 }),
						trackId: `t${n}`,
					},
					false,
					0,
				)
			else s.onTrackClosed(`t${n++}`)
		}
		return memory()
	}
	/** On air at 0, a 1500 ms turnaround (traffic), then a 500 ms flap reopening at 5500 ms. */
	const knownCall: [number, "open" | "close"][] = [
		[0, "open"],
		[1_000, "close"],
		[2_500, "open"],
		[5_000, "close"],
		[5_500, "open"],
	]

	// The pairing window (flapPairMs) of this plan: 2 × min(one coarse sweep, 8000) + 1000 + (1 + 5)
	// blocks + the dwell = 2 × 8000 + 1000 + 300 + 40 000 = 57 300 ms. The first flap is heard at
	// 5500 ms, the second at 9500 ms (4000 ms later in this visit); with W − 4000 ms of held time
	// of earlier visits counted since the first, the second is W after it (at the bound) and earns
	// the flap rest; a block more, it does not.
	const W = 2 * WATCH_MS + 1_000 + 6 * BLOCK_MS + 40_000
	for (const [extraMs, rest] of [
		[0, true],
		[BLOCK_MS, false],
	] as const)
		it(`a second flap ${W + extraMs} ms of listening after the first ${rest ? "earns" : "does not earn"} the flap rest`, () => {
			expect(W).toBe(57_300)
			const m = visit(
				[...knownCall, [9_000, "close"], [9_500, "open"]],
				[9_000, W - 4_000 + extraMs],
			)
			expect(m.evidence).toBe("carrier")
			expect(m.flaps).toBe(true)
			expect(m.flapRest).toBe(rest)
		})

	it("one flap of a frequency known as a call is carrier evidence without the flap rest", () => {
		const m = visit(knownCall)
		expect(m.evidence).toBe("carrier")
		expect(m.flapRest).toBe(false)
	})

	it("a turnaround heard between two flaps forgets the first", () => {
		const m = visit([
			...knownCall,
			[8_000, "close"],
			[9_500, "open"],
			[12_000, "close"],
			[12_500, "open"],
		])
		expect(m.flapRest).toBe(false)
	})

	it("an emitter never known as a call (on air at the job start) earns the flap rest from its first flap", () => {
		const m = visit([
			[0, "open"],
			[1_000, "close"],
			[1_500, "open"],
		])
		expect(m.flapRest).toBe(true)
	})
})

describe("a hop kept for a recording", () => {
	const HZ = 149.9 * MHZ
	const sighting = (id: string): TrackSnapshot => ({
		...makeTrack({ id, centreHz: HZ, startedAt: 0 }),
		trackId: id,
	})
	/**
	 * `hops` hops of DWELL_MS (1000 ms settle, 50 ms blocks); one track "a" that is neither probed
	 * nor followed on hop 0. Returns at the end of hop 0's dwell (clock 150: the dwell is 3 blocks
	 * after the settled epoch start), where the scheduler leaves or keeps the hop.
	 */
	const make = (
		opts: {
			hops?: number
			maxHoldMs?: number
			recording?: () => boolean
		} = {},
	) => {
		let clock = 0
		let calls = 0
		const recording = opts.recording
		const s = new SweepScheduler(
			makeHopPlan(centres(opts.hops ?? 2), HALF_SPAN_HZ),
			makeNormalisedSpec({
				dwellMs: DWELL_MS,
				settleMs: SETTLE_MS,
				revisit: { share: 0, maxIntervalMs: null },
				hold: { ...spec.hold, maxHoldMs: opts.maxHoldMs ?? 60_000 },
			}),
			{
				blockSamples: 50,
				sampleRateHz: 1000,
				now: () => clock,
				probeStartMs: PROBE_START_MS,
				...(recording
					? {
							recordingActive: () => {
								calls++
								return recording()
							},
						}
					: {}),
			},
		)
		s.start()
		s.onEpochStarted(0)
		s.onTrack(sighting("a"), false, 0)
		const decided: SchedulerAction[] = []
		for (let e = 50; e <= 150; e += 50) {
			clock = e
			decided.push(...s.onBlock(e))
		}
		return {
			s,
			decided,
			calls: () => calls,
			tick: (ms: number) => {
				clock = ms
				return s.tick(ms)
			},
			/** Moves the clock with no tick and no block: a pause or an outage. */
			at: (ms: number) => {
				clock = ms
			},
		}
	}
	const tunes = (a: SchedulerAction[]): boolean =>
		a.some(x => x.type === "tune")

	it("without a recorder the hop is left at its dwell end", () => {
		const { s, decided } = make()
		expect(tunes(decided)).toBe(true)
		expect(s.progress().holdingOn).toBeNull()
	})

	it("is kept while recording, re-checked every 250 ms, and left at the first re-check that finds the recording ended", () => {
		let on = true
		const { s, decided, tick } = make({ recording: () => on })
		expect(decided).toEqual([])
		expect(s.progress().holdingOn).toBe("a")
		// Re-check at 150 + 250 = 400 (not a ms before), then every 250 ms.
		expect(tick(399)).toEqual([])
		expect(tick(400)).toEqual([])
		on = false
		expect(tick(649)).toEqual([])
		expect(tunes(tick(650))).toBe(true)
	})

	it("is kept at most L from the start of its holds (19 550 ms on 2 hops: 150 + 19 550 = 19 700)", () => {
		const { tick } = make({ recording: () => true })
		expect(longFollowMs(2)).toBe(19_550)
		expect(tick(19_699)).toEqual([])
		expect(tunes(tick(19_700))).toBe(true)
	})

	it("never past hold.maxHoldMs (5000 ms here): a forced leave", () => {
		const { tick } = make({ recording: () => true, maxHoldMs: 5_000 })
		expect(tick(5_149)).toEqual([])
		const left = tick(5_150)
		expect(tunes(left)).toBe(true)
		expect(left.some(x => x.type === "stop-probes")).toBe(true)
	})

	it("probes a new signal of the window at the next re-check", () => {
		const { s, tick } = make({ recording: () => true })
		s.onTrack(sighting("b"), true, CONFIRM_MS)
		expect(tick(400)).toEqual([
			{
				type: "start-probe",
				trackId: "b",
				holdMs: CONFIRM_MS + PROBE_START_MS,
			},
		])
		expect(s.progress().holdingOn).toBe("b")
	})

	it("an abandoned confirm leaves even while recording", () => {
		let clock = 0
		const s = new SweepScheduler(
			makeHopPlan(centres(2), HALF_SPAN_HZ),
			makeNormalisedSpec({ dwellMs: DWELL_MS, settleMs: SETTLE_MS }),
			{
				blockSamples: 50,
				sampleRateHz: 1000,
				now: () => clock,
				probeStartMs: PROBE_START_MS,
				recordingActive: () => true,
			},
		)
		s.start()
		s.onEpochStarted(0)
		s.onTrack(sighting("a"), true, CONFIRM_MS)
		for (let e = 50; e <= 150; e += 50) {
			clock = e
			s.onBlock(e)
		}
		expect(s.progress().holdingOn).toBe("a")
		expect(tunes(s.abandonUnstartedConfirm())).toBe(true)
	})

	it("keeps its cap when its frequency becomes traffic (L from its holds: 150 + 19 550 = 19 700 on 2 hops)", () => {
		// "a" is neither probed nor followed; it closes at 200 ms and reopens as "b" 1500 ms later
		// (a turnaround: traffic). The record hold is not recapped to the probe-only cap of
		// non-voice traffic: the hop is kept until L, re-checked every 250 ms.
		const { s, tick } = make({ recording: () => true })
		let tunedAt: number | null = null
		for (let ms = 200; ms <= 20_000 && tunedAt === null; ms += 50) {
			const actions = [...tick(ms), ...s.onBlock(ms)]
			if (ms === 200) s.onTrackClosed("a")
			if (ms === 1_700) s.onTrack(sighting("b"), false, 0)
			if (tunes(actions)) tunedAt = ms
		}
		expect(tunedAt).toBe(150 + longFollowMs(2))
	})

	it("a probe started from a record hold shares its L: an ID on another hop is detected", () => {
		// 3 hops without revisits; hop 0 recorded from 50 s; at 70.8 s a signal that needs a 10 s
		// confirm window appears there; a 28 s ID on hop 2 from 53 s. The record hold starts at
		// 51 750 + 1150 = 52 900 and may last L = 18 400 ms, to 71 300: the probe is cut there,
		// not run to 70 800 + 10 300 = 81 100 (which left hop 2 unvisited until 82 350, past the
		// ID's end at 81 000).
		const plan = makeHopPlan(centres(3), HALF_SPAN_HZ)
		const noRevisit = makeNormalisedSpec({
			dwellMs: DWELL_MS,
			settleMs: SETTLE_MS,
			revisit: { share: 0, maxIntervalMs: null },
		})
		const signals: SimSignal[] = [
			{
				...carrier(plan.hops[0]!.centreHz - 100_000),
				startMs: 50_000,
				endMs: 200_000,
				needsConfirm: false,
			},
			{
				...carrier(plan.hops[0]!.centreHz + 200_000),
				startMs: 70_800,
				endMs: 100_000,
				confirmHoldMs: 10_000,
			},
			voice(plan.hops[2]!.centreHz + 100_000, 53_000),
		]
		const r = simulateSweep(plan, noRevisit, {
			...sim,
			durationMs: 120_000,
			signals,
			recordingActive: (ms, hop) => hop === 0 && ms >= 50_000,
		})
		const kept = r.visits.find(v => v.hopIndex === 0 && v.tunedAtMs === 51_750)
		expect(kept?.leftAtMs).toBe(51_750 + DWELL_MS + longFollowMs(3))
		for (const v of r.visits)
			expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(
				DWELL_MS + longFollowMs(3) + BLOCK_MS,
			)
		expect(r.detectedAtMs[2]).not.toBeNull()
	})

	it("a carrier hold after a record hold gets what L has left (7 hops: 11 500 − 8000 = 3500 ms)", () => {
		// Hop 0 recorded from 46 to 56 s: its hold runs from 48 200 to 56 200 (8000 ms). The steady
		// carrier on hop 1, due at its next visit (59 650), is held 3500 ms (L less the 8000 ms
		// the other hops waited), not 8000 ms: 8000 + 3500 = L.
		const plan = makeHopPlan(centres(7), HALF_SPAN_HZ)
		const signals: SimSignal[] = [
			{
				...carrier(plan.hops[0]!.centreHz - 100_000),
				startMs: 40_000,
				endMs: 200_000,
				needsConfirm: false,
			},
			carrier(plan.hops[1]!.centreHz + 100_000),
		]
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 120_000,
			signals,
			recordingActive: (ms, hop) => hop === 0 && ms >= 46_000 && ms < 56_000,
		})
		const recordVisit = r.visits.find(
			v => v.hopIndex === 0 && v.tunedAtMs === 47_050,
		)
		expect(recordVisit?.leftAtMs).toBe(56_200)
		const carrierVisit = r.visits.find(
			v => v.hopIndex === 1 && v.tunedAtMs > 56_200,
		)
		expect(carrierVisit?.tunedAtMs).toBe(59_650)
		expect(carrierVisit!.leftAtMs - carrierVisit!.tunedAtMs - DWELL_MS).toBe(
			longFollowMs(7) - (56_200 - 48_200),
		)
	})

	for (const [name, closeMs, leftMs] of [
		// A close one block before the cap (64 300): the hang classing its gap would run to
		// 64 250 + 1050 = 65 300, 1000 ms past what L left; it ends at the cap.
		["one block before its cap", 64_250, 64_300],
		// A close two blocks before: same bound (the hang is not cut short of the cap otherwise).
		["two blocks before its cap", 64_200, 64_300],
	] as const)
		it(`a carrier hold after a record hold that closes ${name} ends at what L has left (7 hops: 8000 + 3500 = L)`, () => {
			// The scene above: the carrier on hop 1 goes off air during its 3500 ms hold (60 800 to
			// 64 300). Its hang may class the gap only within L, so hop 2 (and every other hop) waits
			// at most L for the holds of hops 0 and 1 between two of its visits.
			const plan = makeHopPlan(centres(7), HALF_SPAN_HZ)
			const signals: SimSignal[] = [
				{
					...carrier(plan.hops[0]!.centreHz - 100_000),
					startMs: 40_000,
					endMs: 200_000,
					needsConfirm: false,
				},
				{
					...carrier(plan.hops[1]!.centreHz + 100_000),
					endMs: closeMs - BLOCK_MS + 1,
				},
			]
			const r = simulateSweep(plan, spec, {
				...sim,
				durationMs: 120_000,
				signals,
				recordingActive: (ms, hop) => hop === 0 && ms >= 46_000 && ms < 56_000,
			})
			const carrierVisit = r.visits.find(
				v => v.hopIndex === 1 && v.tunedAtMs > 56_200,
			)
			expect(carrierVisit?.tunedAtMs).toBe(59_650)
			expect(carrierVisit?.leftAtMs).toBe(leftMs)
			const own = r.visits.filter(v => v.hopIndex === 2)
			for (let k = 1; k < own.length; k++) {
				const heldMs = r.visits
					.filter(
						v =>
							v.hopIndex !== 2 &&
							v.tunedAtMs >= own[k - 1]!.leftAtMs &&
							v.leftAtMs <= own[k]!.tunedAtMs,
					)
					.reduce((a, v) => a + v.leftAtMs - v.tunedAtMs - DWELL_MS, 0)
				expect(heldMs).toBeLessThanOrEqual(longFollowMs(7))
			}
		})

	for (const [name, gapMs] of [
		["back to back", 0],
		["after 20 s pauses", 20_000],
	] as const)
		it(`restarts of the visit ${name} keep the hold budget it spent, never the interruptions: kept at most L of holds in all (2 hops: 150 + 19 550 + 3 re-dwells of 150 + 3 gaps)`, () => {
			// Recording throughout; the epoch restarts (an outage, a preemption, a resume) three times,
			// each after 4850 ms of holding, gapMs after the last tick (no blocks, no ticks: the runner
			// drives neither while paused). Each restart re-dwells 150 ms and the record hold resumes
			// with what L has left (3 × 4850 = 14 550, then 5000 ms), not a fresh L and not L less the
			// gaps.
			const { s, tick, at } = make({ recording: () => true })
			const REDWELL_MS = 3 * BLOCK_MS
			const HELD_MS = 4_850
			let holdFrom = 150
			for (let k = 0; k < 3; k++) {
				const heardAt = holdFrom + HELD_MS
				const restartAt = heardAt + gapMs
				const actions = [...tick(heardAt)]
				at(restartAt)
				actions.push(...s.onEpochStarted(0))
				// The dwell phase ignores ticks: they only move the clock.
				for (let e = BLOCK_MS; e <= REDWELL_MS; e += BLOCK_MS)
					actions.push(...tick(restartAt + e), ...s.onBlock(e))
				expect(tunes(actions)).toBe(false)
				holdFrom = restartAt + REDWELL_MS
			}
			expect(s.hopStats()[0]!.holdMs).toBe(3 * HELD_MS)
			let tunedAt: number | null = null
			for (
				let ms = holdFrom;
				ms <= holdFrom + 40_000 && tunedAt === null;
				ms += 50
			)
				if (tunes(tick(ms))) tunedAt = ms
			expect(tunedAt).toBe(150 + longFollowMs(2) + 3 * REDWELL_MS + 3 * gapMs)
			expect(s.hopStats()[0]!.holdMs).toBe(longFollowMs(2))
		})

	it("a hold of 5 s, a 30 s pause and a resume: the hold goes on with L less 5 s, and its stats leave the pause out (2 hops)", () => {
		// Recording throughout: a record hold from 150 to 5000 (4850 ms), heard by blocks and
		// ticks; then nothing for 30 s (the job paused: no blocks, no ticks); the resume re-sends
		// the hop, whose epoch restarts the visit.
		const { s, tick, at } = make({ recording: () => true })
		for (let ms = 200; ms <= 5_000; ms += BLOCK_MS) {
			expect(tunes(tick(ms))).toBe(false)
			expect(tunes(s.onBlock(ms))).toBe(false)
		}
		at(35_000)
		expect(s.onEpochStarted(0)).toEqual([{ type: "stop-probes" }])
		expect(s.hopStats()[0]!.holdMs).toBe(4_850)
		for (let e = BLOCK_MS; e <= 3 * BLOCK_MS; e += BLOCK_MS)
			expect(tunes([...tick(35_000 + e), ...s.onBlock(e)])).toBe(false)
		let tunedAt: number | null = null
		for (let ms = 35_200; ms <= 80_000 && tunedAt === null; ms += 50)
			if (tunes(tick(ms))) tunedAt = ms
		// The hold resumed at 35 150 with L − 4850 left.
		expect(tunedAt).toBe(35_150 + longFollowMs(2) - 4_850)
		expect(s.hopStats()[0]!.holdMs).toBe(longFollowMs(2))
	})

	describe("a recorder that records analog voice on air in the tuned window, with a 2 s tail", () => {
		// 3 hops, 600 s, emitters on air from the job start, 28 s IDs on the last hop (the scenes
		// of "labelled, flapping and busy emitters beside a voice hop"). A frequency with carrier
		// evidence is never kept for its recording: it stays under the carrier rules. Kept for it,
		// a labelled carrier's hop took 45.6 % of the run and 2 of the 3 ID ends were missed (IDs
		// detected 16.95 and 15.6 s after their start, heard 8300 ms each); a carrier flapping
		// 3 s on / 0.5 s off took 69.7 %.
		const RUN_MS = 600_000
		const plan = makeHopPlan(centres(3), HALF_SPAN_HZ)
		const C = plan.hops[0]!.centreHz - 100_000
		const BUSY = plan.hops[1]!.centreHz + 100_000
		const V = plan.hops[2]!.centreHz + 100_000
		const recorder =
			(signals: readonly SimSignal[]) =>
			(ms: number, hop: number | null): boolean => {
				const span = hop === null ? undefined : plan.hops[hop]?.covered
				if (span === undefined) return false
				return signals.some(
					s =>
						s.followOnAir &&
						s.centreHz >= span.startHz &&
						s.centreHz <= span.endHz &&
						s.startMs <= ms &&
						ms < s.endMs + 2_000,
				)
			}
		const run = (others: SimSignal[], ids: number[]) => {
			const signals = [...others, ...ids.map(at => voice(V, at))]
			const r = simulateSweep(plan, spec, {
				...sim,
				durationMs: RUN_MS,
				signals,
				recordingActive: recorder(signals),
			})
			return { r, first: others.length, hopShare: share(hopTimeMs(r, 3)) }
		}

		it("a labelled carrier and a busy channel: every ID is heard to its end, the carrier's hop takes at most 40 % (measured 33.9 %)", () => {
			const ids = [60_000, 240_000, 420_000]
			const { r, hopShare } = run(
				[labelledCarrier(C), ...series(BUSY, 20_000, 300, RUN_MS)],
				ids,
			)
			for (const startMs of ids)
				expect(endHeard(r, 2, startMs + 28_000)).toBe(true)
			expect(hopShare[0]!).toBeLessThanOrEqual(0.4)
		})

		it("a labelled carrier flapping 3 s on / 0.5 s off: its hop takes at most half the run (measured 47.0 %), every ID detected", () => {
			const ids = [40_000, 220_000, 400_000]
			const { r, first, hopShare } = run(series(C, 3_000, 500, RUN_MS), ids)
			expect(hopShare[0]!).toBeLessThanOrEqual(0.5)
			ids.forEach((_, k) => expect(r.detectedAtMs[first + k]).not.toBeNull())
		})
	})

	it("a parked one-hop plan never asks", () => {
		const { s, calls } = make({ hops: 1, recording: () => true })
		expect(s.parked).toBe(true)
		expect(s.progress().holdingOn).toBeNull()
		expect(calls()).toBe(0)
	})

	it("in a sweep: up to L per hold, every hop visited between two, an ID on another hop detected; a recorder that never records changes nothing", () => {
		const plan = makeHopPlan(centres(3), HALF_SPAN_HZ)
		// A signal neither probed nor followed on hop 0, recorded from 20 to 140 s; a 28 s ID on
		// hop 2 at 60 s.
		const recorded: SimSignal = {
			...carrier(plan.hops[0]!.centreHz - 100_000),
			startMs: 20_000,
			endMs: 140_000,
			needsConfirm: false,
		}
		const id = voice(plan.hops[2]!.centreHz + 100_000, 60_000)
		const signals = [recorded, id]
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 160_000,
			signals,
			recordingActive: (ms, hop) => hop === 0 && ms >= 20_000 && ms < 140_000,
		})
		const kept = r.visits.filter(
			v => v.hopIndex === 0 && v.leftAtMs - v.tunedAtMs > 2 * DWELL_MS,
		)
		expect(kept.length).toBeGreaterThanOrEqual(2)
		for (const v of kept)
			expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(
				DWELL_MS + longFollowMs(3) + BLOCK_MS,
			)
		expect(
			kept.some(
				v => v.leftAtMs - v.tunedAtMs >= DWELL_MS + longFollowMs(3) - BLOCK_MS,
			),
		).toBe(true)
		for (let k = 1; k < kept.length; k++) {
			const between = r.visits.filter(
				v =>
					v.tunedAtMs >= kept[k - 1]!.leftAtMs &&
					v.leftAtMs <= kept[k]!.tunedAtMs,
			)
			expect(new Set(between.map(v => v.hopIndex))).toEqual(new Set([0, 1, 2]))
		}
		expect(r.detectedAtMs[1]).not.toBeNull()
		const none = simulateSweep(plan, spec, {
			...sim,
			durationMs: 160_000,
			signals,
		})
		const never = simulateSweep(plan, spec, {
			...sim,
			durationMs: 160_000,
			signals,
			recordingActive: () => false,
		})
		expect(never).toEqual(none)
	})
})

describe("frequency memory bound", () => {
	it("a replan from 60 hops to one keeps the 256 frequencies missed least (then heard last)", () => {
		interface Entry {
			centreHz: number
			halfWidthHz: number
			order: number
			misses: number
			seenVisit: number
		}
		const plan = makeHopPlan(centres(60), HALF_SPAN_HZ)
		const s = new SweepScheduler(plan, spec, {
			blockSamples: 50,
			sampleRateHz: 1000,
			now: () => 0,
			probeStartMs: PROBE_START_MS,
		})
		const inner = s as unknown as {
			memory: Entry[]
			memoryBins: Map<number, Entry[]>
			indexMemory: (m: Entry) => void
		}
		const all: Entry[] = []
		for (let i = 0; i < 60 * 256; i++) {
			const m = {
				centreHz: 150 * MHZ + i * 3_125,
				halfWidthHz: 6_250,
				order: i,
				evidence: "unknown",
				flaps: false,
				flapRest: false,
				flapAt: null,
				flapListenMs: 0,
				wasTraffic: false,
				onsetSeen: false,
				restUntil: 0,
				suspect: false,
				runFrom: 0,
				watchAfter: 0,
				seenVisit: i % 997,
				misses: i % 9,
				closedAt: null,
			}
			all.push(m)
			inner.memory.push(m)
			inner.indexMemory(m)
		}
		// Idle (never started): the plan swaps at once and bounds the memory to 256 × 1 entries.
		s.replan(makeHopPlan([150 * MHZ], HALF_SPAN_HZ), spec)
		const expected = [...all]
			.sort(
				(a, b) =>
					a.misses - b.misses || b.seenVisit - a.seenVisit || b.order - a.order,
			)
			.slice(0, 256)
		expect(new Set(inner.memory)).toEqual(new Set(expected))
		let indexed = 0
		for (const list of inner.memoryBins.values()) indexed += list.length
		expect(indexed).toBe(256)
	})
})
