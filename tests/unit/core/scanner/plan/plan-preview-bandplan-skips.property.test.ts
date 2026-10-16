import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	planJob,
	previewPlan,
} from "../../../../../src/core/scanner/plan/plan-preview.js"
import type {
	PreviewContext,
	PreviewSourceView,
} from "../../../../../src/core/scanner/plan/plan-preview.js"
import type {
	BandPlanSkipSource,
	ScanJobSpec,
	ScannerProtocol,
	ScanRange,
} from "../../../../../src/core/scanner/types.js"

const PI: PreviewSourceView = {
	id: "pi",
	kind: "rtl_tcp",
	format: "U8_IQ",
	sampleRateHz: 2_048_000,
	centreHz: 446_100_000,
	controllable: true,
	controlMode: "internal",
	role: "shared",
	link: "network",
}

function context(): PreviewContext {
	return {
		sources: [PI],
		channelizerAvailable: false,
		usableFraction: 0.8,
		settings: {
			enabled: true,
			passive: { enabled: true, offsetProbes: false },
			cpuBudgetCores: 1,
			cpuGuardPercent: 90,
			maxProbes: { offset: 1, channel: 4 },
			ringSeconds: 3,
			detection: {
				fftSize: "auto",
				integrationMs: 50,
				sensitivity: "normal",
				faTargetPerMhzMin: 1,
				dcGuardHz: 1500,
				ppmMargin: 2,
				clipFraction: 0.001,
				hysteresisDb: 3,
				minSurfaceBlocks: 2,
				shortIntegrationMs: 5,
				overlap: 0,
			},
			sweep: {
				markers: true,
				markerTimeoutMs: 2000,
				pllSettleMs: 5,
				settleMs: { local: 300, network: 1000 },
				revisitShare: 0.3,
			},
			hold: { maxHoldMs: 60_000, hangMs: 2000, preRollMs: 300 },
			storage: {
				dir: null,
				maxRecordingsMb: 512,
				maxEvidenceMb: 64,
				maxJournalMb: 64,
				maxAgeDays: 30,
				discoveryMaxAgeDays: 180,
				minFreeDiskMb: 2048,
				maxDiscoveries: 10_000,
				maxCapturesMb: 256,
			},
			ws: {
				maxMessagesPerSecond: 10,
				spectrumHz: 2,
				spectrumBins: 512,
				spectrumSummaryBins: 2048,
				spectrumMaxProfiles: 4,
			},
		},
		measured: {
			settleMs: { local: null, network: null },
			markerSupported: { pi: true },
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
	}
}

const rangeArb = fc
	.record({
		startKhz: fc.integer({ min: 400_000, max: 468_000 }),
		widthKhz: fc.integer({ min: 10, max: 2000 }),
		raster: fc.constantFrom("inherit", "free", "12k5"),
	})
	.map(({ startKhz, widthKhz, raster }): ScanRange => {
		const base = {
			startHz: startKhz * 1000,
			endHz: (startKhz + widthKhz) * 1000,
		}
		if (raster === "inherit") return base
		if (raster === "free") return { ...base, rasters: [] }
		return {
			...base,
			rasters: [{ spacingHz: 12_500, firstChannelHz: base.startHz + 6250 }],
			obwHz: [9000],
		}
	})
const specArb = fc
	.record({
		ranges: fc.array(rangeArb, { maxLength: 2 }),
		bandplans: fc.subarray(
			["pmr446", "dpmr446", "uhf-land-mobile", "ism-433"],
			{
				maxLength: 1,
			},
		),
		exclusions: fc.array(
			fc.record({
				startKhz: fc.integer({ min: 400_000, max: 470_000 }),
				widthKhz: fc.integer({ min: 1, max: 500 }),
			}),
			{ maxLength: 2 },
		),
		mode: fc.constantFrom(
			"auto" as const,
			"sweep" as const,
			"in-window" as const,
			null,
		),
		fftSize: fc.constantFrom(1024, 2048, 4096, null),
		sensitivity: fc.constantFrom(
			"low" as const,
			"normal" as const,
			"high" as const,
			null,
		),
		sampleRateHz: fc.constantFrom(2_048_000, 2_400_000, null),
		protocols: fc.option(
			fc.subarray<ScannerProtocol>(["dmr", "analog-fm", "pocsag", "ism"]),
			{ nil: null },
		),
		confirmHoldMs: fc.option(fc.integer({ min: 500, max: 5000 }), {
			nil: null,
		}),
	})
	.map(r => {
		const spec: ScanJobSpec = {
			ranges: r.ranges,
			bandplans: r.bandplans,
			exclusions: r.exclusions.map(x => ({
				startHz: x.startKhz * 1000,
				endHz: (x.startKhz + x.widthKhz) * 1000,
			})),
		}
		if (r.mode !== null) spec.mode = r.mode
		if (r.fftSize !== null) spec.fftSize = r.fftSize
		if (r.sensitivity !== null) spec.sensitivity = r.sensitivity
		if (r.sampleRateHz !== null) spec.tuner = { sampleRateHz: r.sampleRateHz }
		if (r.protocols !== null) spec.protocols = r.protocols
		if (r.confirmHoldMs !== null)
			spec.hold = { policy: "hold", confirmHoldMs: r.confirmHoldMs }
		return spec
	})

const sourcesArb: fc.Arbitrary<BandPlanSkipSource[]> = fc.array(
	fc
		.record({
			key: fc.constantFrom("op/a", "op/b", "pack/c", "pack/d"),
			startKhz: fc.integer({ min: 398_000, max: 470_000 }),
			widthKhz: fc.integer({ min: 1, max: 3000 }),
		})
		.map(r => ({
			key: r.key,
			startHz: r.startKhz * 1000,
			endHz: (r.startKhz + r.widthKhz) * 1000,
		})),
	{ minLength: 1, maxLength: 6 },
)

function withSkips(
	fn: (() => readonly BandPlanSkipSource[]) | undefined,
): PreviewContext {
	const ctx = context()
	if (fn !== undefined) ctx.bandPlanSkips = fn
	return ctx
}

describe("band-plan skips inert without view or flag", () => {
	// Feature: web-gaps-7, Property 9: Band-plan skips inert without view or flag
	// Validates: Requirements 6.1, 6.6
	it("absent, empty, malformed or throwing views change nothing", () => {
		fc.assert(
			fc.property(specArb, fc.boolean(), (spec, flag) => {
				const s: ScanJobSpec = flag
					? { ...spec, skipBandPlanSkips: true }
					: spec
				const base = previewPlan(s, context())
				const baseJob = planJob(base.spec, context())
				const variants: ((() => readonly BandPlanSkipSource[]) | undefined)[] =
					[
						() => [],
						() => null as unknown as readonly BandPlanSkipSource[],
						() => {
							throw new Error("boom")
						},
					]
				// Absent is the baseline itself.
				for (const v of variants) {
					const ctx = withSkips(v)
					expect(previewPlan(s, ctx)).toEqual(base)
					expect(planJob(base.spec, ctx)).toEqual(baseJob)
				}
				expect("bandPlanSkips" in base).toBe(false)
			}),
			{ numRuns: 100 },
		)
	}, 60_000)

	it("entries without the flag keep the hops", () => {
		fc.assert(
			fc.property(
				specArb,
				sourcesArb,
				fc.constantFrom<boolean | undefined>(undefined, false),
				(spec, sources, flag) => {
					const s: ScanJobSpec =
						flag === undefined ? spec : { ...spec, skipBandPlanSkips: flag }
					const base = previewPlan(s, context())
					const p = previewPlan(
						s,
						withSkips(() => sources),
					)
					expect(p.plan).toEqual(base.plan)
					expect(p.lockoutExclusions).toEqual(base.lockoutExclusions)
					for (const e of p.bandPlanSkips ?? []) expect(e.applied).toBe(false)
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)
})

describe("skip excludes", () => {
	// Feature: web-gaps-7, Property 11: Skip excludes
	// Validates: Requirements 6.4
	it("a sweep with the flag avoids applied ranges or applies none with a warning", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 440_000, max: 460_000 }),
				fc.integer({ min: 20, max: 6000 }),
				fc.array(
					fc.record({
						offsetKhz: fc.integer({ min: -500, max: 6000 }),
						widthKhz: fc.integer({ min: 1, max: 3000 }),
					}),
					{ minLength: 1, maxLength: 5 },
				),
				(startKhz, widthKhz, skips) => {
					const ranges: ScanRange[] = [
						{ startHz: startKhz * 1000, endHz: (startKhz + widthKhz) * 1000 },
					]
					const sources = skips.map((x, i) => ({
						key: `op/b${i}`,
						startHz: (startKhz + x.offsetKhz) * 1000,
						endHz: (startKhz + x.offsetKhz + x.widthKhz) * 1000,
					}))
					const spec: ScanJobSpec = {
						mode: "sweep",
						ranges,
						skipBandPlanSkips: true,
					}
					const p = previewPlan(
						spec,
						withSkips(() => sources),
					)
					const entries = p.bandPlanSkips ?? []
					const applied = entries.filter(e => e.applied)
					const warn = p.issues.filter(
						i => i.code === "bandplan-skips-not-applied",
					)
					if (applied.length > 0) {
						expect(applied).toHaveLength(entries.length)
						expect(warn).toHaveLength(0)
						const excluded = previewPlan(
							{
								mode: "sweep",
								ranges,
								exclusions: applied.map(e => ({
									startHz: e.startHz,
									endHz: e.endHz,
								})),
							},
							context(),
						)
						expect(p.plan).toEqual(excluded.plan)
						for (const h of p.plan.hops)
							for (const e of applied)
								expect(
									h.covered.startHz >= e.startHz && h.covered.endHz <= e.endHz,
								).toBe(false)
					} else if (entries.length > 0) {
						expect(warn).toHaveLength(1)
						const plain = previewPlan({ mode: "sweep", ranges }, context())
						expect(p.plan).toEqual(plain.plan)
						expect(plain.plan.hops.length).toBeGreaterThan(0)
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)
})
