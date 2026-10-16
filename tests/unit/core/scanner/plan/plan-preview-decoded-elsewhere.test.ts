import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	normaliseSpec,
	planJob,
	previewPlan,
	toJobSpec,
} from "../../../../../src/core/scanner/plan/plan-preview.js"
import type {
	PreviewContext,
	PreviewSourceView,
} from "../../../../../src/core/scanner/plan/plan-preview.js"
import type {
	DecoderCoverageView,
	NormalisedJobSpec,
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
		bandplans: fc.subarray(["pmr446", "dpmr446", "uhf-land-mobile", "ism-433"]),
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

function external(id: string, targetsHz: number[]): DecoderCoverageView {
	return {
		id,
		running: true,
		health: "running",
		suspended: false,
		owner: "config",
		sourceId: null,
		inputKind: "external",
		band: {
			verdict: "in-band",
			basis: "configured",
			targetsHz,
			rangesHz: [],
			captureCenterHz: null,
			windowHalfWidthHz: null,
		},
	}
}

const targetsArb = fc.array(
	fc.integer({ min: 400_000, max: 470_000 }).map(k => k * 1000),
	{ minLength: 1, maxLength: 6 },
)
/** Views that never prove coverage (req 1.3). */
const untrustedArb = targetsArb.chain(t =>
	fc.constantFrom<DecoderCoverageView[]>(
		[{ ...external("a", t), running: false }],
		[{ ...external("b", t), health: "faulted" }],
		[{ ...external("c", t), suspended: true }],
		[{ ...external("d", t), owner: "scanner" }],
		[{ ...external("e", t), band: null }],
		[{ ...external("f", t), sourceId: "pi", inputKind: "iq" }],
	),
)

function withCoverage(
	views: (() => readonly DecoderCoverageView[]) | undefined,
): PreviewContext {
	const ctx = context()
	if (views !== undefined) ctx.decoderCoverage = views
	return ctx
}

const sweep = (
	ranges: ScanRange[],
	extra: Partial<ScanJobSpec> = {},
): ScanJobSpec => ({
	mode: "sweep",
	ranges,
	...extra,
})

function normalised(spec: ScanJobSpec, ctx: PreviewContext): NormalisedJobSpec {
	return normaliseSpec(spec, ctx).spec
}

describe("decoded elsewhere is inert without views or flag", () => {
	// Feature: web-gaps-6, Property 1: Decoded elsewhere is inert without views or flag
	// Validates: Requirements 1.1, 1.6
	it("no view, empty view list, untrusted views or a throwing view change nothing", () => {
		fc.assert(
			fc.property(specArb, untrustedArb, (spec, untrusted) => {
				const base = previewPlan(spec, context())
				const baseJob = planJob(base.spec, context())
				const variants: (() => readonly DecoderCoverageView[])[] = [
					() => [],
					() => untrusted,
					() => {
						throw new Error("boom")
					},
				]
				for (const v of variants) {
					const ctx = withCoverage(v)
					expect(previewPlan(spec, ctx)).toEqual(base)
					expect(planJob(base.spec, ctx)).toEqual(baseJob)
				}
				expect("decodedElsewhere" in base).toBe(false)
			}),
			{ numRuns: 100 },
		)
	}, 60_000)

	it("covering views without the flag keep the hops", () => {
		fc.assert(
			fc.property(
				specArb,
				targetsArb,
				fc.constantFrom<boolean | undefined>(undefined, false),
				(spec, targets, flag) => {
					const s: ScanJobSpec =
						flag === undefined ? spec : { ...spec, skipDecodedElsewhere: flag }
					const base = previewPlan(s, context())
					const ctx = withCoverage(() => [external("x", targets)])
					const p = previewPlan(s, ctx)
					expect(p.plan).toEqual(base.plan)
					expect(p.lockoutExclusions).toEqual(base.lockoutExclusions)
					for (const d of p.decodedElsewhere ?? [])
						expect(d.applied).toBe(false)
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)
})

describe("skip excludes", () => {
	// Feature: web-gaps-6, Property 4: Skip excludes
	// Validates: Requirements 1.6
	it("a sweep with the flag avoids applied ranges or applies none with a warning", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 440_000, max: 460_000 }),
				fc.integer({ min: 500, max: 6000 }),
				fc.array(fc.integer({ min: 0, max: 6000 }), {
					minLength: 1,
					maxLength: 5,
				}),
				(startKhz, widthKhz, offsetsKhz) => {
					const ranges: ScanRange[] = [
						{ startHz: startKhz * 1000, endHz: (startKhz + widthKhz) * 1000 },
					]
					const targets = offsetsKhz.map(o => (startKhz + o) * 1000)
					let calls = 0
					const ctx = withCoverage(() => {
						calls++
						return [external("x", targets)]
					})
					const spec = sweep(ranges, { skipDecodedElsewhere: true })
					const n = normalised(spec, ctx)
					calls = 0
					const job = planJob(n, ctx)
					expect(calls).toBe(1)
					const p = previewPlan(spec, ctx)
					const entries = p.decodedElsewhere ?? []
					expect(job.decodedElsewhere ?? []).toEqual(entries)
					const notApplied = p.issues.filter(
						i => i.code === "decoded-elsewhere-not-applied",
					)
					const applied = entries.filter(e => e.applied)
					if (applied.length > 0) {
						expect(applied).toHaveLength(entries.length)
						expect(notApplied).toHaveLength(0)
						// The applied ranges act exactly as operator exclusions would.
						const excluded = previewPlan(
							sweep(ranges, {
								exclusions: applied.map(e => ({
									startHz: e.startHz,
									endHz: e.endHz,
								})),
							}),
							context(),
						)
						expect(p.plan).toEqual(excluded.plan)
						// No hop is spent inside an applied range.
						for (const h of p.plan.hops)
							for (const e of applied)
								expect(
									h.covered.startHz >= e.startHz && h.covered.endHz <= e.endHz,
								).toBe(false)
					} else if (entries.length > 0) {
						const plain = previewPlan(spec, context())
						if (notApplied.length === 1) {
							expect(p.plan).toEqual(plain.plan)
							expect(plain.plan.hops.length).toBeGreaterThan(0)
						}
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)

	it("a flag that would empty the plan applies none and warns", () => {
		const ranges: ScanRange[] = [{ startHz: 446_000_000, endHz: 446_010_000 }]
		const ctx = withCoverage(() => [external("x", [446_005_000])])
		const spec = sweep(ranges, { skipDecodedElsewhere: true })
		const p = previewPlan(spec, ctx)
		const plain = previewPlan(sweep(ranges), context())
		expect(plain.plan.hops.length).toBeGreaterThan(0)
		expect(p.plan).toEqual(plain.plan)
		expect(p.decodedElsewhere).toEqual([
			{
				startHz: 446_000_000,
				endHz: 446_010_000,
				sourceId: null,
				decoderIds: ["x"],
				applied: false,
			},
		])
		expect(
			p.issues.filter(i => i.code === "decoded-elsewhere-not-applied"),
		).toHaveLength(1)
	})

	it("an in-window job reports but never applies", () => {
		const ranges: ScanRange[] = [{ startHz: 446_000_000, endHz: 446_200_000 }]
		const ctx = withCoverage(() => [external("x", [446_100_000])])
		const spec: ScanJobSpec = {
			mode: "in-window",
			ranges,
			skipDecodedElsewhere: true,
		}
		const p = previewPlan(spec, ctx)
		expect(p.plan).toEqual(previewPlan(spec, context()).plan)
		expect(p.decodedElsewhere?.length).toBe(1)
		expect(p.decodedElsewhere?.every(d => !d.applied)).toBe(true)
	})

	it("lockouts and decoded ranges apply together", () => {
		const ranges: ScanRange[] = [{ startHz: 440_000_000, endHz: 450_000_000 }]
		const ctx = withCoverage(() => [external("x", [445_000_000])])
		ctx.lockouts = () => [
			{ discoveryId: "d1", centreHz: 442_000_000, bandwidthHz: 20_000 },
		]
		const p = previewPlan(sweep(ranges, { skipDecodedElsewhere: true }), ctx)
		expect(p.lockoutExclusions?.map(x => x.applied)).toEqual([true])
		expect(p.decodedElsewhere?.map(x => x.applied)).toEqual([true])
		const lockOnly = previewPlan(sweep(ranges), ctx)
		expect(lockOnly.lockoutExclusions).toEqual(p.lockoutExclusions)
		expect(lockOnly.decodedElsewhere?.map(x => x.applied)).toEqual([false])
		const excluded = previewPlan(
			sweep(ranges, {
				exclusions: [
					...(p.lockoutExclusions ?? []),
					...(p.decodedElsewhere ?? []),
				].map(e => ({ startHz: e.startHz, endHz: e.endHz })),
			}),
			context(),
		)
		expect(p.plan).toEqual(excluded.plan)
	})

	it("surfaces the truncated warning in the preview", () => {
		const views = Array.from({ length: 65 }, (_, i) =>
			external(`d${String(i).padStart(2, "0")}`, [446_100_000]),
		)
		const ctx = withCoverage(() => views)
		const p = previewPlan(
			sweep([{ startHz: 446_000_000, endHz: 446_200_000 }]),
			ctx,
		)
		expect(
			p.issues.filter(i => i.code === "decoded-elsewhere-truncated"),
		).toHaveLength(1)
		expect(p.decodedElsewhere?.length).toBe(1)
	})
})

describe("skipDecodedElsewhere normalisation", () => {
	it("round-trips the flag with operator provenance; absent stays absent", () => {
		const ranges: ScanRange[] = [{ startHz: 446_000_000, endHz: 446_200_000 }]
		for (const flag of [true, false]) {
			const n = normalised(
				sweep(ranges, { skipDecodedElsewhere: flag }),
				context(),
			)
			expect(n.skipDecodedElsewhere).toBe(flag)
			expect(n.provenance["skipDecodedElsewhere"]).toBe("operator")
			expect(toJobSpec(n).skipDecodedElsewhere).toBe(flag)
		}
		const n = normalised(sweep(ranges), context())
		expect("skipDecodedElsewhere" in n).toBe(false)
		expect(n.provenance["skipDecodedElsewhere"]).toBeUndefined()
		expect("skipDecodedElsewhere" in toJobSpec(n)).toBe(false)
	})
})
