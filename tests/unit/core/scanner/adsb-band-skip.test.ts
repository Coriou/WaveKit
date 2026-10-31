/**
 * The built-in ADS-B band (1089-1091 MHz, builtin-supplement.ts) carries a band-plan skip
 * ("Decoded elsewhere · readsb"). Sweeps that honour band-plan skips leave the band to readsb,
 * the band names no scan protocol (no priors, no analog trial, no replay trial but readsb),
 * and the readsb decode anchor at 1090 MHz forms as before (ambient-readsb.test.ts covers the
 * anchor itself with the skip view wired in).
 */
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import type { BandRegion, ResolvedBandPlanView } from "@wavekit/api-types"
import { projectBuiltinPacks } from "../../../../src/core/bandplans/builtin-packs.js"
import { builtinBandplansFor } from "../../../../src/core/bandplans/builtin-supplement.js"
import { priorsFor } from "../../../../src/core/scanner/bandplan/index.js"
import type { IqCaptureView } from "../../../../src/core/scanner/iq-capture-contract.js"
import { bandPlanSkipSources } from "../../../../src/core/scanner/plan/bandplan-skips.js"
import {
	ADSB_REPLAY_HIGH_HZ,
	ADSB_REPLAY_LOW_HZ,
	planReplayTrialsDetailed,
} from "../../../../src/core/scanner/replay-plan.js"
import type { ScanRange } from "../../../../src/core/scanner/types.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const REGIONS = [
	"EU",
	"US",
	"CA",
	"AU",
	"NZ",
	"JP",
	"CN",
] as const satisfies readonly BandRegion[]
const LOW = 1_089_000_000
const HIGH = 1_091_000_000
const ADSB_HZ = 1_090_000_000

/** The resolved view of one built-in pack alone: every band one segment per scan range. */
function builtinView(region: BandRegion): ResolvedBandPlanView {
	const pack = projectBuiltinPacks().find(p => p.region === region)!
	return {
		bands: pack.bands.map((band, layer) => ({
			key: `${pack.id}/${band.id}`,
			packId: pack.id,
			bandId: band.id,
			layer,
			band,
			segments: (band.scan?.ranges ?? []).map(r => ({
				startHz: r.startHz,
				endHz: r.endHz,
			})),
			editedFields: [],
			issues: [],
		})),
		shadowed: [],
		hidden: [],
	} as unknown as ResolvedBandPlanView
}

describe("built-in ADS-B band skip", () => {
	it("the adsb band is the only built-in skip source, 1089-1091 MHz, in every region", () => {
		for (const region of REGIONS)
			expect(bandPlanSkipSources(builtinView(region))).toEqual([
				{
					key: `builtin-${region.toLowerCase()}/adsb`,
					startHz: LOW,
					endHz: HIGH,
				},
			])
		// the band is the replay plan's ADS-B window
		expect([ADSB_REPLAY_LOW_HZ, ADSB_REPLAY_HIGH_HZ]).toEqual([LOW, HIGH])
	})

	it("names no scan protocol: no priors anywhere in the band", () => {
		for (const region of REGIONS) {
			const ranges = builtinBandplansFor(region).flatMap(p => p.ranges)
			for (const hz of [LOW, ADSB_HZ, HIGH])
				expect(priorsFor(ranges, hz)).toEqual({})
		}
	})

	it("a 1090 MHz capture plans no replay trial but readsb (reported, it has no replay input)", () => {
		const capture: IqCaptureView = {
			captureId: "c1",
			sourceId: "rtl",
			observationId: "o_adsb",
			epoch: 1,
			rfHz: ADSB_HZ,
			tuningTrust: "commanded",
			capturedAtMs: 0,
			durationMs: 2000,
			gapSamples: 0,
			rateHz: 192_000,
		}
		const priors = priorsFor(
			builtinBandplansFor("EU").flatMap(p => p.ranges),
			ADSB_HZ,
		)
		const wideBurst = trackOf({
			centreHz: ADSB_HZ,
			obwHz: 1_200_000,
			flags: { ...trackOf().flags, burst: true },
		})
		for (const track of [null, wideBurst])
			for (const knownProtocol of [null, "adsb"] as const) {
				const plan = planReplayTrialsDetailed({
					capture,
					track,
					knownProtocol: knownProtocol as never,
					priors,
					narrowRaster: false,
				})
				expect(plan.trials).toEqual([])
				expect(plan.skipped).toEqual([
					{ protocol: "adsb", decoder: "readsb", reason: "no-probe-mode" },
				])
			}
	})

	describe("sweeps", () => {
		const cleanups: (() => Promise<void>)[] = []
		afterEach(async () => {
			for (const c of cleanups.splice(0).reverse()) await c()
		})
		function harness() {
			const h = serviceHarness({
				patch: s => {
					s.passive.enabled = false
				},
				bandPlanSkips: () => bandPlanSkipSources(builtinView("EU")),
			})
			cleanups.push(async () => {
				await h.service.stop()
				await rm(h.dir, { recursive: true, force: true })
			})
			return h
		}
		const RANGE: ScanRange = { startHz: 1_080_000_000, endHz: 1_100_000_000 }
		const sweep = (over: Record<string, unknown> = {}) => ({
			sourceId: "rtl",
			mode: "sweep" as const,
			ranges: [RANGE],
			takeover: true,
			resume: { autoAfterIdleMs: null },
			...over,
		})
		const overlaps = (r: { startHz: number; endHz: number }) =>
			r.startHz <= HIGH && r.endHz >= LOW

		it("report the band; with skipBandPlanSkips no hop covers 1089-1091 MHz", async () => {
			const h = harness()
			await h.service.start()
			const plain = h.service.preview(sweep())
			expect(plain.bandPlanSkips).toEqual([
				{
					startHz: LOW,
					endHz: HIGH,
					bandKeys: ["builtin-eu/adsb"],
					applied: false,
				},
			])
			const coversAdsb = plain.plan.hops.some(
				hop =>
					overlaps(hop.covered) &&
					!hop.excluded.some(x => x.startHz <= LOW && x.endHz >= HIGH),
			)
			expect(coversAdsb).toBe(true)

			const job = await h.service.createJob(sweep({ skipBandPlanSkips: true }))
			expect(job.bandPlanSkips).toEqual([
				{
					startHz: LOW,
					endHz: HIGH,
					bandKeys: ["builtin-eu/adsb"],
					applied: true,
				},
			])
			expect(job.plan.hops.length).toBeGreaterThan(0)
			for (const hop of job.plan.hops) {
				if (!overlaps(hop.covered)) continue
				// what the hop still covers inside the band is excluded
				const lo = Math.max(hop.covered.startHz, LOW)
				const hi = Math.min(hop.covered.endHz, HIGH)
				expect(hop.excluded.some(x => x.startHz <= lo && x.endHz >= hi)).toBe(
					true,
				)
			}
		}, 30_000)
	})
})
