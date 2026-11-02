// tests/unit/core/scanner/plan/plan-preview-sim.test.ts
import { describe, expect, it } from "vitest"
import {
	previewPlan,
	type PreviewContext,
	type PreviewSourceView,
} from "../../../../../src/core/scanner/plan/plan-preview.js"
import {
	interceptProbability,
	simulateSweep,
} from "../../../../../src/core/scanner/plan/sweep-sim.js"
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

function ctx(seed?: PreviewContext["activitySeed"]): PreviewContext {
	return {
		sources: [SRC],
		channelizerAvailable: false,
		usableFraction: 0.8,
		settings: testSettings(),
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
		const predicted = interceptProbability(spans, D, 2 * T, 2 * T, fromMs, toMs)
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
