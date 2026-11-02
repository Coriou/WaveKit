// tests/unit/core/scanner/plan/plan-preview-sim.test.ts
import { describe, expect, it } from "vitest"
import {
	MAX_SIM_HOPS,
	MAX_SIM_STEPS,
	previewPlan,
	previewSchedule,
	type PreviewContext,
	type PreviewSourceView,
} from "../../../../../src/core/scanner/plan/plan-preview.js"
import {
	interceptProbability,
	periodicInterceptProbability,
	simulateSweep,
} from "../../../../../src/core/scanner/plan/sweep-sim.js"
import { SweepScheduler } from "../../../../../src/core/scanner/scheduler.js"
import type { Hop, ScanRange } from "../../../../../src/core/scanner/types.js"
import { testSettings } from "../../../../mocks/scanner/engine-fakes.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../../mocks/scanner/job-spec.js"

const MHz = (n: number) => Math.round(n * 1e6)

const SRC: PreviewSourceView = {
	id: "sdr",
	kind: "rtl_tcp",
	format: "U8_IQ",
	sampleRateHz: 2_048_000,
	centreHz: MHz(430),
	controllable: true,
	controlMode: "internal",
	role: "dedicated",
	link: "network",
}

function ctx(
	seed?: PreviewContext["activitySeed"],
	minSurfaceBlocks?: number,
): PreviewContext {
	return {
		sources: [SRC],
		channelizerAvailable: false,
		usableFraction: 0.8,
		settings: testSettings(st => {
			if (minSurfaceBlocks !== undefined)
				st.detection.minSurfaceBlocks = minSurfaceBlocks
		}),
		measured: {
			settleMs: { local: null, network: null },
			markerSupported: { sdr: true },
			probeStartMs: 400,
		},
		impactFor: () => ({
			liveAudioClients: 0,
			digitalVoiceListeners: 0,
			runningDecoders: [],
			pinnedDecoders: [],
			scannerJobs: [],
			unrestorable: [],
		}),
		region: "EU",
		tunerRange: () => ({ startHz: 24_000_000, endHz: 1_766_000_000 }),
		bandplans: [],
		...(seed ? { activitySeed: seed } : {}),
	}
}

/** Synthetic 8 MHz span: several hops. */
const WIDE: ScanRange = {
	startHz: MHz(430),
	endHz: MHz(438),
	rasters: [{ spacingHz: 12_500, firstChannelHz: MHz(430) + 6_250 }],
	obwHz: [9_000],
}

describe("plan preview from the simulated scheduler", () => {
	it("an occupancy seed adds revisits: the seeded hop's POI rises and the period grows", () => {
		// A 300 ms transmission: well under the period, so POI stays below 1
		const spec = {
			mode: "sweep" as const,
			ranges: [WIDE],
			txDurationHintMs: 300,
		}
		const quiet = previewPlan(spec, ctx())
		const busyHz = MHz(434)
		const seeded = previewPlan(
			spec,
			ctx(
				() => (hop: Hop) =>
					busyHz >= hop.covered.startHz && busyHz <= hop.covered.endHz ? 1 : 0,
			),
		)
		expect(quiet.plan.hops.length).toBeGreaterThan(3)
		const busy = seeded.plan.hops.find(
			h => busyHz >= h.covered.startHz && busyHz <= h.covered.endHz,
		)!
		const other = seeded.plan.hops.find(h => h.covered.endHz < busyHz)!
		const poi = (p: typeof quiet, h: Hop) =>
			p.poi.find(x => x.hopIndex === h.index)!.detection
		expect(seeded.sweepPeriodMs!).toBeGreaterThan(quiet.sweepPeriodMs!)
		expect(poi(seeded, busy)).toBeGreaterThan(poi(quiet, busy))
		expect(poi(seeded, other)).toBeLessThan(poi(quiet, other))
	})

	it("a throwing seed plans as no seed", () => {
		const spec = { mode: "sweep" as const, ranges: [WIDE] }
		const throwing = previewPlan(
			spec,
			ctx(() => () => {
				throw new Error("seed down")
			}),
		)
		const outer = previewPlan(
			spec,
			ctx(() => {
				throw new Error("history down")
			}),
		)
		const none = previewPlan(spec, ctx())
		expect(throwing.sweepPeriodMs).toBe(none.sweepPeriodMs)
		expect(throwing.poi).toEqual(none.poi)
		expect(outer.poi).toEqual(none.poi)
	})

	it("the detection POI matches transmissions run through the scheduler, within one block per period", () => {
		const settleMs = 35
		const T = 50
		const plan = makeHopPlan([MHz(430), MHz(431.6), MHz(433.2), MHz(434.8)])
		const spec = makeNormalisedSpec({
			dwellMs: 185,
			settleMs,
			revisit: { share: 0, maxIntervalMs: null },
		})
		const opts = {
			settleMs,
			blockMs: T,
			minSurfaceBlocks: 2,
			probeStartMs: 0,
		}
		const empty = simulateSweep(plan, spec, { ...opts, durationMs: 5_000 })
		const fromMs = empty.sweepEndsMs[0]!
		const toMs = empty.sweepEndsMs[1]!
		const periodMs = toMs - fromMs
		const D = 300
		const spans = empty.listens.filter(l => l.hopIndex === 2)
		const predicted = interceptProbability(spans, D, 2 * T, null, fromMs, toMs)
		// Transmission starts every 5 ms across one period: detected when it surfaces as a track.
		let hits = 0
		let runs = 0
		for (let start = fromMs; start < toMs; start += 5) {
			const r = simulateSweep(plan, spec, {
				...opts,
				durationMs: toMs + D + periodMs,
				signals: [
					{
						centreHz: MHz(433.3),
						startMs: start,
						endMs: start + D,
						snrDb: 20,
						needsConfirm: false,
						confirmHoldMs: 0,
						followOnAir: false,
					},
				],
			})
			runs++
			if (r.detectedAtMs[0] !== null) hits++
		}
		// Blocks are aligned: a span needs 2 to 3 blocks of overlap, so at most one block differs.
		expect(Math.abs(hits / runs - predicted)).toBeLessThanOrEqual(
			T / periodMs + 0.01,
		)
	})
})

describe("intercept probability: duration feasibility", () => {
	const one = [{ fromMs: 0, toMs: 1_000 }]
	it("a transmission shorter than the overlap it needs is never intercepted", () => {
		// 100 ms on air cannot overlap a span by 200 ms, nor surface and then last a 200 ms hold
		expect(interceptProbability(one, 100, 200, 200, 0, 1_000)).toBe(0)
		expect(interceptProbability(one, 199, 200, null, 0, 1_000)).toBe(0)
		// at the bound (200 ms): starts in [0, 800] overlap the span by 200 ms
		expect(interceptProbability(one, 200, 200, null, 0, 1_000)).toBeCloseTo(
			0.8,
			12,
		)
		// past it: starts in [-100, 800], clipped to the window
		expect(interceptProbability(one, 300, 200, null, 0, 1_000)).toBeCloseTo(
			0.8,
			12,
		)
	})

	it("a span shorter than the overlap it needs never intercepts, however long the transmission", () => {
		const short = (ms: number) => [{ fromMs: 0, toMs: ms }]
		expect(
			interceptProbability(short(199), 1_000, 200, null, -1_000, 1_000),
		).toBe(0)
		// at the bound: starts in [200 - 1000, 0]
		expect(
			interceptProbability(short(200), 1_000, 200, null, -1_000, 1_000),
		).toBeCloseTo(800 / 2_000, 12)
	})

	it("decode needs the transmission on air for the hold after the span ends", () => {
		// need 200 + hold 200 = 400 ms: below, at (an empty start interval) and past the bound
		expect(interceptProbability(one, 399, 200, 200, 0, 1_000)).toBe(0)
		expect(interceptProbability(one, 400, 200, 200, 0, 1_000)).toBe(0)
		// starts in [1000 + 200 - 500, 800] = [700, 800]
		expect(interceptProbability(one, 500, 200, 200, 0, 1_000)).toBeCloseTo(
			0.1,
			12,
		)
	})

	it("a repeating window: long transmissions are bounded work and agree with a long run", () => {
		// One 100 ms span per 1000 ms period: any 2-period transmission contains a whole span
		expect(
			periodicInterceptProbability(
				[{ fromMs: 200, toMs: 300 }],
				600_000,
				50,
				null,
				0,
				1_000,
			),
		).toBe(1)
		expect(
			periodicInterceptProbability(
				[{ fromMs: 200, toMs: 240 }],
				600_000,
				50,
				null,
				0,
				1_000,
			),
		).toBe(0)
		// A span crossing the window end continues at its start
		const wrap = [
			{ fromMs: 0, toMs: 60 },
			{ fromMs: 960, toMs: 1_000 },
		]
		const tiled = Array.from({ length: 6 }, (_, k) => ({
			fromMs: 960 + 1_000 * (k - 1),
			toMs: 1_060 + 1_000 * (k - 1),
		}))
		for (const tx of [80, 150, 900, 1_500, 2_500])
			expect(
				periodicInterceptProbability(wrap, tx, 50, null, 0, 1_000),
			).toBeCloseTo(interceptProbability(tiled, tx, 50, null, 0, 1_000), 12)
	})
})

describe("plan preview: configured minSurfaceBlocks", () => {
	const spec = {
		mode: "sweep" as const,
		ranges: [WIDE],
		// well under the period, so detection stays below 1
		txDurationHintMs: 300,
	}
	// minSurfaceBlocks is 1..20 (config schema); integrationMs 50 by default.
	it("needs minSurfaceBlocks blocks on air: fewer blocks, higher detection POI", () => {
		const at = (k: number) =>
			previewPlan(spec, ctx(undefined, k)).poi[0]!.detection
		expect(at(1)).toBeGreaterThan(at(2))
		expect(at(2)).toBeGreaterThan(at(20))
	})

	it("minSurfaceBlocks 20 × 50 ms: a 999 ms transmission is never detected, a 1000 ms one can be", () => {
		const at = (tx: number) =>
			previewPlan({ ...spec, txDurationHintMs: tx }, ctx(undefined, 20)).poi
		expect(at(999).every(p => p.detection === 0)).toBe(true)
		expect(at(1_000).every(p => p.detection > 0)).toBe(true)
	})
})

describe("plan preview: bounded simulation work", () => {
	/** Largest inputs the job schema allows: 10-minute dwell, 5 ms blocks, 10 s settle. */
	const worst = makeNormalisedSpec({
		dwellMs: 600_000,
		settleMs: 10_000,
		integrationMs: 5,
		txDurationHintMs: 600_000,
		revisit: { share: 1, maxIntervalMs: 0 },
	})
	const centres = (n: number) =>
		Array.from({ length: n }, (_, i) => MHz(100) + i * 1_600_000)

	it("172 hops of 600 s dwell in 5 ms blocks take a few steps per visit, not one per block", () => {
		const s = previewSchedule(makeHopPlan(centres(172)), worst, 20, () => 1)!
		expect(s.source).toBe("simulated")
		// at most 3 steps per visit, 2 visits per coarse hop, 4 sweeps: 3 × 4 × (2 × 172 + 1)
		expect(s.steps).toBeLessThanOrEqual(3 * 4 * (2 * 172 + 1))
		// 120 M blocks per sweep if stepped block by block
		expect(s.periodMs).toBeGreaterThanOrEqual(172 * 600_000)
	})

	it(`at MAX_SIM_HOPS (${MAX_SIM_HOPS}) the simulation stays under MAX_SIM_STEPS; past it the round-robin schedule is used`, () => {
		const at = previewSchedule(
			makeHopPlan(centres(MAX_SIM_HOPS)),
			worst,
			20,
			() => 1,
		)!
		expect(at.source).toBe("simulated")
		expect(at.steps).toBeLessThanOrEqual(MAX_SIM_STEPS)
		const past = previewSchedule(
			makeHopPlan(centres(MAX_SIM_HOPS + 1)),
			worst,
			20,
			() => 1,
		)!
		expect(past.source).toBe("round-robin")
		expect(past.steps).toBe(0)
		// settle + 600 000 - 10 000 listening per hop
		expect(past.periodMs).toBe((MAX_SIM_HOPS + 1) * 600_000)
	})

	it("without revisits the simulation matches the round-robin arithmetic: settle + dwell per hop, listening rounded to blocks", () => {
		const plan = makeHopPlan(centres(5))
		const spec = makeNormalisedSpec({
			dwellMs: 185,
			settleMs: 35,
			revisit: { share: 0, maxIntervalMs: null },
		})
		const sim = previewSchedule(plan, spec, 2, undefined)!
		expect(sim.source).toBe("simulated")
		expect(sim.periodMs).toBe(5 * 185)
		for (const spans of sim.listens.values())
			for (const sp of spans) expect(sp.toMs - sp.fromMs).toBe(150)
	})

	it("onBlocks(end, k) is k onBlock calls", () => {
		const plan = makeHopPlan(centres(3))
		const spec = makeNormalisedSpec({ dwellMs: 2_000, settleMs: 35 })
		const make = () =>
			new SweepScheduler(plan, spec, {
				blockSamples: 50,
				sampleRateHz: 1000,
				now: () => 0,
				probeStartMs: 0,
			})
		const a = make()
		const b = make()
		for (const s of [a, b]) {
			s.start()
			s.onEpochStarted(0)
		}
		const left = a.dwellBlocksLeft()!
		expect(left).toBe(Math.ceil(1_965 / 50))
		const stepped = []
		for (let k = 1; k <= left; k++) stepped.push(...a.onBlock(k * 50))
		expect(b.onBlocks(left * 50, left)).toEqual(stepped)
		expect(b.hopStats()).toEqual(a.hopStats())
		expect(b.progress()).toEqual(a.progress())
	})
})
