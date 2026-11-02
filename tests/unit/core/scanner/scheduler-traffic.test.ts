// tests/unit/core/scanner/scheduler-traffic.test.ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	simulateSweep,
	type SimResult,
	type SimSignal,
} from "../../../../src/core/scanner/plan/sweep-sim.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"

/*
 * Traffic against carriers in a sweep: QSOs on air when the job starts or starting later, an ID
 * after a QSO, decoded calls, and carriers that flap in short gaps. The thresholds of the QSO, ID
 * and decoded scenes are the share heard (or ms heard) by the sweep scheduler as it was before
 * frequency memory existed (holds were one confirm probe per visit, decoded calls followed to
 * maxHoldMs), run on the same scenes: the scheduler must never hear less of real traffic.
 */

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
/** The bound of a hold on a frequency not known as traffic. */
const UNSEEN_HOLD_MS = 8_000
/** A hang that starts before a hold's cap may run this long to class the gap (1000 ms + a block). */
const CLASS_HANG_MS = 1_050
const spec = makeNormalisedSpec({ dwellMs: DWELL_MS, settleMs: SETTLE_MS })
const sim = {
	settleMs: SETTLE_MS,
	blockMs: BLOCK_MS,
	minSurfaceBlocks: 2,
	probeStartMs: 300,
}

/** An analog-voice transmission (analog-fm confirm 1500 ms + 300 ms probe start). */
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
	confirmHoldMs: 1_800,
	followOnAir: true,
})
/** A DMR-like call: no analog label, a decoder confirms it 800 ms into the probe. */
const decoded = (
	hz: number,
	startMs: number,
	durationMs: number,
): SimSignal => ({
	...voice(hz, startMs, durationMs),
	followOnAir: false,
	decodeAfterMs: 800,
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
/** A synthetic QSO: overs of 5 to 30 s with turnaround gaps of 1 to 3 s, from `fromMs` to `untilMs`. */
function qso(
	hz: number,
	fromMs: number,
	untilMs: number,
	seed: number,
): SimSignal[] {
	const rnd = random(seed)
	const out: SimSignal[] = []
	let t = fromMs
	while (t < untilMs) {
		const over = Math.round(5_000 + 25_000 * rnd())
		out.push(voice(hz, t, Math.min(over, untilMs - t)))
		t += over + Math.round(1_000 + 2_000 * rnd())
	}
	return out
}
const onAirMs = (signals: readonly SimSignal[]): number =>
	signals.reduce((a, s) => a + s.endMs - s.startMs, 0)
const heardShare = (r: SimResult, signals: readonly SimSignal[]): number =>
	r.heardMs.reduce((a, b) => a + b, 0) / onAirMs(signals)

/** The QSO's hop: the middle one of 3, hop 3 of 7. */
const qsoHop = (hops: number): number => (hops === 3 ? 1 : 3)
const planOf = (hops: number) => makeHopPlan(centres(hops), HALF_SPAN_HZ)
const qsoHz = (hops: number): number =>
	planOf(hops).hops[qsoHop(hops)]!.centreHz + 100_000

describe("a QSO is heard at least as much as one confirm probe per visit heard it", () => {
	// Share of the QSO's air time heard over 10 minutes. The earlier scheduler (one probe of
	// 1800 + 300 ms per visit, revisits by activity) heard 3 hops: 51.4 / 51.1 / 51.0 % on air at
	// the start (seeds 1 to 3) and 51.1 / 51.0 / 51.5 % from 60 s; 7 hops: 39.3 / 40.6 / 39.8 % and
	// 41.6 / 39.3 / 39.2 %. Thresholds: the highest of those, rounded up (52 %, 42 %).
	for (const hops of [3, 7]) {
		const floor = hops === 3 ? 0.52 : 0.42
		for (const fromMs of [0, 60_000])
			for (const seed of [1, 2, 3])
				it(`${hops} hops, ${fromMs === 0 ? "on air when the job starts" : "starting at 60 s"}, seed ${seed}: heard ≥ ${floor * 100} %`, () => {
					const signals = qso(qsoHz(hops), fromMs, fromMs + 600_000, seed)
					const r = simulateSweep(planOf(hops), spec, {
						...sim,
						durationMs: fromMs + 600_000,
						signals,
					})
					expect(heardShare(r, signals)).toBeGreaterThanOrEqual(floor)
				})
	}
})

describe("a 28 s ID right after a QSO on air since the job started", () => {
	// The QSO (seed 1) runs to 600 s; the ID opens on the same frequency 1.5, 8 or 30 s later. The
	// earlier scheduler heard 3 hops: 15 100 / 14 450 / 13 500 ms, 7 hops: 11 250 / 11 250 /
	// 11 500 ms. Thresholds: the highest of those per plan, rounded up (15 500, 12 000 ms).
	for (const hops of [3, 7])
		for (const afterMs of [1_500, 8_000, 30_000]) {
			const floor = hops === 3 ? 15_500 : 12_000
			it(`${hops} hops, ID ${afterMs} ms after the QSO: heard ≥ ${floor} ms`, () => {
				const hz = qsoHz(hops)
				const talk = qso(hz, 0, 600_000, 1)
				const id = voice(hz, 600_000 + afterMs)
				const r = simulateSweep(planOf(hops), spec, {
					...sim,
					durationMs: id.endMs + 5_000,
					signals: [...talk, id],
				})
				expect(r.heardMs[talk.length]).toBeGreaterThanOrEqual(floor)
			})
		}
})

describe("a decode proves a transmission", () => {
	// DMR-like calls decoded 800 ms into the probe are followed to their end, whatever the onset
	// evidence. The earlier scheduler (decoded follows to maxHoldMs) heard a 28 s call at 0 s and at
	// 5 s: 3 hops 25 850 / 27 400 ms, 7 hops 23 550 / 20 500 ms; 40 s calls every 70 s from 10 s:
	// 37 500 then 38 200 ms each (3 hops), 37 500 then 37 050 ms each (7 hops). Thresholds: those.
	const single: Record<number, [number, number]> = {
		3: [25_850, 27_400],
		7: [23_550, 20_500],
	}
	const series: Record<number, [number, number]> = {
		3: [37_500, 38_200],
		7: [37_500, 37_050],
	}
	for (const hops of [3, 7]) {
		;[0, 5_000].forEach((atMs, k) => {
			it(`${hops} hops, a 28 s decoded call at ${atMs} ms is heard ≥ ${single[hops]![k]} ms`, () => {
				const r = simulateSweep(planOf(hops), spec, {
					...sim,
					durationMs: atMs + 40_000,
					signals: [decoded(qsoHz(hops), atMs, 28_000)],
				})
				expect(r.heardMs[0]).toBeGreaterThanOrEqual(single[hops]![k]!)
			})
		})
		it(`${hops} hops, 40 s decoded calls every 70 s are each heard to their end`, () => {
			const calls = Array.from({ length: 5 }, (_, i) =>
				decoded(qsoHz(hops), 10_000 + 70_000 * i, 40_000),
			)
			const r = simulateSweep(planOf(hops), spec, {
				...sim,
				durationMs: 400_000,
				signals: calls,
			})
			const [first, rest] = series[hops]!
			expect(r.heardMs[0]).toBeGreaterThanOrEqual(first)
			for (const ms of r.heardMs.slice(1))
				expect(ms).toBeGreaterThanOrEqual(rest)
		})
	}
})

describe("a gap that starts in a hold is classed before the hop is left", () => {
	// Two hops of 1150 ms: one coarse sweep is 2300 ms. A labelled transmission on air at the job
	// start (not known as traffic) is followed from the dwell end (1150 ms, no confirm probe) to
	// the sweep bound, 3450 ms. It closes 50 ms after `endMs`; the reopening starts at `reopenMs`.
	const plan = makeHopPlan(centres(2), HALF_SPAN_HZ)
	const noRevisit = makeNormalisedSpec({
		dwellMs: DWELL_MS,
		settleMs: SETTLE_MS,
		revisit: { share: 0, maxIntervalMs: null },
	})
	const hz = plan.hops[0]!.centreHz + 100_000
	const run = (endMs: number, reopenMs: number): SimResult =>
		simulateSweep(plan, noRevisit, {
			...sim,
			durationMs: 30_000,
			signals: [
				{ ...voice(hz, 0, endMs), needsConfirm: false },
				{ ...voice(hz, reopenMs, 100_000), needsConfirm: false },
			],
		})
	const laterHolds = (r: SimResult): SimResult["visits"] =>
		r.visits.filter(
			v =>
				v.hopIndex === 0 &&
				v.tunedAtMs > 0 &&
				v.leftAtMs - v.tunedAtMs > 2 * DWELL_MS + BLOCK_MS,
		)

	it("a close 500 ms before the cap: the hang runs to 1050 ms after it, and an off gap that long is traffic", () => {
		// Close at 2950 ms: the hang ends at max(min(2950 + 2000, 3450), 2950 + 1050) = 4000 ms.
		const r = run(2_900, 6_000)
		expect(r.visits[0]?.leftAtMs).toBe(4_000)
		// Traffic: the reopening (on air from 6000 ms) is followed on hop 0's next visits.
		expect(laterHolds(r).length).toBeGreaterThan(0)
	})

	it("a close 1400 ms before the cap is classed within the cap", () => {
		// Close at 2050 ms: the hang ends at the cap, 3450 ms, 1400 ms off air: traffic.
		const r = run(2_000, 6_000)
		expect(r.visits[0]?.leftAtMs).toBe(3_450)
		expect(laterHolds(r).length).toBeGreaterThan(0)
	})

	it("a reopening 450 ms after the close (a flapping carrier's gap) is the same emission", () => {
		// Close at 2950 ms, reopening sighted at 3500 ms (550 ms heard off, short of 1000): the
		// reopening is followed on, already past the 3450 ms cap, so the hop is left; the frequency
		// stays barred and is not held on hop 0's next visits before its retry (40 s after the hold).
		const r = run(2_900, 3_400)
		expect(r.visits[0]?.leftAtMs).toBeLessThanOrEqual(3_500 + BLOCK_MS)
		expect(laterHolds(r)).toEqual([])
	})
})

describe("carriers flapping in short gaps are never followed as traffic", () => {
	// Feature: scanner-sweep-fairness, Property 2: a carrier flapping with gaps of 300 to 600 ms is never followed long, whenever it starts
	// Validates: Requirements 2 (no re-hold or long follow of a steady or flapping carrier), 1 (no hop starved by another hop's holds)
	it("holds a flapping carrier at most one coarse sweep (or until its first short gap) per hold", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 3, max: 7 }),
				fc.nat(1_000),
				// on 2 to 25 s, off 300 to 600 ms: every gap reads at most 650 ms (gap + one block),
				// short of TRAFFIC_GAP_MS (1000 ms)
				fc.integer({ min: 2_000, max: 25_000 }),
				fc.integer({ min: 300, max: 600 }),
				fc.integer({ min: 0, max: 60_000 }),
				(hops, slot, onMs, offMs, startMs) => {
					const plan = makeHopPlan(centres(hops), HALF_SPAN_HZ)
					const hop = slot % hops
					const hz = plan.hops[hop]!.centreHz + 100_000
					const signals: SimSignal[] = []
					for (let t = startMs; t < 300_000; t += onMs + offMs)
						signals.push(voice(hz, t, onMs))
					const r = simulateSweep(plan, spec, {
						...sim,
						durationMs: 300_000,
						signals,
					})
					// A frequency not known as traffic: at most min(one sweep, 8000 ms) per hold, plus a
					// hang classing a gap that started before the cap. One that is new on a hop whose
					// earlier visit missed it is followed as traffic until its first short gap: at most
					// one on-time, its gap and the reopening's sighting (2 blocks).
					const sweep = hops * DWELL_MS
					const bound =
						DWELL_MS +
						Math.max(
							Math.min(sweep, UNSEEN_HOLD_MS),
							onMs + offMs + 2 * BLOCK_MS,
						) +
						CLASS_HANG_MS +
						BLOCK_MS
					for (const v of r.visits.filter(x => x.hopIndex === hop))
						expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(bound)
					// Holds are paced by its retry budget: a first hold (or the follow cut at its first
					// short gap), then retries no earlier than 40, 80, 160 and 300 s after each hold ends
					// (each at least 2100 ms of probe): 40 + 80 + 160 + 4 × 2100 < 300 000 ms, so at most
					// 1 + 1 + 4 = 6 holds in the 300 s run, never one per visit.
					const held = r.visits.filter(
						x =>
							x.hopIndex === hop &&
							x.leftAtMs - x.tunedAtMs > 2 * DWELL_MS + BLOCK_MS,
					)
					expect(held.length).toBeLessThanOrEqual(6)
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)

	it("a new flapping carrier first followed as traffic is cut at its first short gap", () => {
		// 3 hops: hop 2's first visit (2300 to 3450 ms) misses a carrier that starts flapping 3 s on
		// / 0.5 s off at 4 s, so its next visit sees it as new traffic and follows it after the probe.
		// Its first gap (0.5 s, read 550 ms) shows a carrier: the follow is cut to one coarse sweep
		// (3450 ms) from the start of the hold, not maxHoldMs.
		const plan = planOf(3)
		const hz = plan.hops[2]!.centreHz + 100_000
		const signals: SimSignal[] = []
		for (let t = 4_000; t < 120_000; t += 3_500)
			signals.push(voice(hz, t, 3_000))
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 120_000,
			signals,
		})
		const longest = Math.max(
			...r.visits
				.filter(v => v.hopIndex === 2)
				.map(v => v.leftAtMs - v.tunedAtMs),
		)
		expect(longest).toBeLessThanOrEqual(
			DWELL_MS + 3 * DWELL_MS + 3_500 + CLASS_HANG_MS + BLOCK_MS,
		)
		expect(longest).toBeLessThan(DWELL_MS + spec.hold.maxHoldMs)
	})
})

describe("unidentified holds on a large plan", () => {
	it("five carriers labelled analog voice add at most 8 s each to the first sweep of a 60-hop plan", () => {
		// 60 hops of 1150 ms: a nominal sweep of 69 000 ms (an empty band takes exactly that). Each
		// carrier on air from the start is held at most UNSEEN_HOLD_MS (8000), not one sweep
		// (69 000 ms, cut to maxHoldMs 60 000), and the hops active during those holds get at most
		// one revisit per round(1 / 0.3) = 3 coarse hops (20 × 1150 = 23 000 ms): at most
		// 69 000 + 5 × 8000 + 23 000 = 132 000 ms. (One confirm probe per visit took 141 250 ms.)
		const plan = planOf(60)
		const signals = [3, 15, 27, 39, 51].map(i => ({
			...voice(plan.hops[i]!.centreHz + 100_000, 0, Number.POSITIVE_INFINITY),
			snrDb: 25,
		}))
		const empty = simulateSweep(plan, spec, {
			...sim,
			durationMs: 900_000,
			maxSweeps: 1,
		})
		expect(empty.sweepEndsMs[0]).toBe(60 * DWELL_MS)
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 900_000,
			signals,
			maxSweeps: 1,
		})
		expect(r.sweepEndsMs[0]).toBeLessThanOrEqual(
			60 * DWELL_MS + 5 * UNSEEN_HOLD_MS + 20 * DWELL_MS,
		)
		for (const v of r.visits)
			expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(
				DWELL_MS + UNSEEN_HOLD_MS + BLOCK_MS,
			)
	})
})
