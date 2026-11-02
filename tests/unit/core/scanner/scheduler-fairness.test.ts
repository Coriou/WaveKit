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
