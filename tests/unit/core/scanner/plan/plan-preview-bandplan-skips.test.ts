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
	BandPlanSkipSource,
	DecoderCoverageView,
	ScanJobSpec,
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

function withCoverage(views: DecoderCoverageView[]): PreviewContext {
	const ctx = context()
	ctx.decoderCoverage = () => views
	return ctx
}

function withSkips(sources: readonly BandPlanSkipSource[]): PreviewContext {
	const ctx = context()
	ctx.bandPlanSkips = () => sources
	return ctx
}

const sweep = (
	ranges: ScanRange[],
	extra: Partial<ScanJobSpec> = {},
): ScanJobSpec => ({ mode: "sweep", ranges, ...extra })

const exclusionsOf = (xs: readonly { startHz: number; endHz: number }[]) =>
	xs.map(x => ({ startHz: x.startHz, endHz: x.endHz }))

const RANGES: ScanRange[] = [{ startHz: 440_000_000, endHz: 450_000_000 }]

describe("band-plan skips on plans", () => {
	it("applies skips on a sweep with the flag; hops avoid the skipped ranges", () => {
		let calls = 0
		const ctx = context()
		ctx.bandPlanSkips = () => {
			calls++
			return [
				{ key: "op/b", startHz: 443_000_000, endHz: 444_000_000 },
				{ key: "op/a", startHz: 443_500_000, endHz: 444_500_000 },
			]
		}
		const spec = sweep(RANGES, { skipBandPlanSkips: true })
		const n = normaliseSpec(spec, ctx).spec
		calls = 0
		planJob(n, ctx)
		expect(calls).toBe(1)
		const p = previewPlan(spec, ctx)
		expect(p.bandPlanSkips).toEqual([
			{
				startHz: 443_000_000,
				endHz: 444_500_000,
				bandKeys: ["op/a", "op/b"],
				applied: true,
			},
		])
		const excluded = previewPlan(
			sweep(RANGES, {
				exclusions: [{ startHz: 443_000_000, endHz: 444_500_000 }],
			}),
			context(),
		)
		expect(p.plan).toEqual(excluded.plan)
		expect(p.plan).not.toEqual(previewPlan(sweep(RANGES), context()).plan)
		for (const h of p.plan.hops)
			expect(
				h.covered.startHz >= 443_000_000 && h.covered.endHz <= 444_500_000,
			).toBe(false)
		expect(p.issues.some(i => i.code.startsWith("bandplan-skips"))).toBe(false)
	})

	it("without the flag reports entries applied:false and keeps the plan", () => {
		const ctx = withSkips([
			{ key: "op/a", startHz: 443_000_000, endHz: 444_000_000 },
		])
		const p = previewPlan(sweep(RANGES), ctx)
		const plain = previewPlan(sweep(RANGES), context())
		expect(p.plan).toEqual(plain.plan)
		expect(p.bandPlanSkips?.map(x => x.applied)).toEqual([false])
	})

	it("a flag that would empty the plan applies none and warns once", () => {
		const ranges: ScanRange[] = [{ startHz: 446_000_000, endHz: 446_010_000 }]
		const ctx = withSkips([
			{ key: "op/secret-key", startHz: 445_000_000, endHz: 447_000_000 },
		])
		const p = previewPlan(sweep(ranges, { skipBandPlanSkips: true }), ctx)
		const plain = previewPlan(sweep(ranges), context())
		expect(plain.plan.hops.length).toBeGreaterThan(0)
		expect(p.plan).toEqual(plain.plan)
		expect(p.bandPlanSkips).toEqual([
			{
				startHz: 446_000_000,
				endHz: 446_010_000,
				bandKeys: ["op/secret-key"],
				applied: false,
			},
		])
		const warn = p.issues.filter(i => i.code === "bandplan-skips-not-applied")
		expect(warn).toHaveLength(1)
		expect(warn[0]?.severity).toBe("warning")
		expect(JSON.stringify(warn[0])).not.toContain("secret-key")
	})

	it("an in-window job reports skips but never applies them", () => {
		const ranges: ScanRange[] = [{ startHz: 446_000_000, endHz: 446_200_000 }]
		const ctx = withSkips([
			{ key: "op/a", startHz: 446_050_000, endHz: 446_100_000 },
		])
		const spec: ScanJobSpec = {
			mode: "in-window",
			ranges,
			skipBandPlanSkips: true,
		}
		const p = previewPlan(spec, ctx)
		expect(p.plan).toEqual(previewPlan(spec, context()).plan)
		expect(p.bandPlanSkips).toEqual([
			{
				startHz: 446_050_000,
				endHz: 446_100_000,
				bandKeys: ["op/a"],
				applied: false,
			},
		])
		expect(p.issues.some(i => i.code === "bandplan-skips-not-applied")).toBe(
			false,
		)
	})

	it("lockouts, skips and decoded-elsewhere apply together", () => {
		const ctx = withSkips([
			{ key: "op/a", startHz: 447_000_000, endHz: 448_000_000 },
		])
		ctx.decoderCoverage = () => [external("x", [445_000_000])]
		ctx.lockouts = () => [
			{ discoveryId: "d1", centreHz: 442_000_000, bandwidthHz: 20_000 },
		]
		const p = previewPlan(
			sweep(RANGES, { skipBandPlanSkips: true, skipDecodedElsewhere: true }),
			ctx,
		)
		expect(p.lockoutExclusions?.map(x => x.applied)).toEqual([true])
		expect(p.bandPlanSkips?.map(x => x.applied)).toEqual([true])
		expect(p.decodedElsewhere?.map(x => x.applied)).toEqual([true])
		const excluded = previewPlan(
			sweep(RANGES, {
				exclusions: exclusionsOf([
					...(p.lockoutExclusions ?? []),
					...(p.bandPlanSkips ?? []),
					...(p.decodedElsewhere ?? []),
				]),
			}),
			context(),
		)
		expect(p.plan).toEqual(excluded.plan)
	})

	it("skips not applied: decoded-elsewhere still evaluated against the base plan", () => {
		const ranges: ScanRange[] = [{ startHz: 446_000_000, endHz: 446_400_000 }]
		const ctx = withSkips([
			{ key: "op/a", startHz: 446_000_000, endHz: 446_400_000 },
		])
		ctx.decoderCoverage = () => [external("x", [446_100_000])]
		const p = previewPlan(
			sweep(ranges, { skipBandPlanSkips: true, skipDecodedElsewhere: true }),
			ctx,
		)
		expect(p.bandPlanSkips?.map(x => x.applied)).toEqual([false])
		expect(
			p.issues.filter(i => i.code === "bandplan-skips-not-applied"),
		).toHaveLength(1)
		const de = previewPlan(
			sweep(ranges, { skipDecodedElsewhere: true }),
			withCoverage([external("x", [446_100_000])]),
		)
		expect(p.plan).toEqual(de.plan)
		expect(p.decodedElsewhere).toEqual(de.decodedElsewhere)
	})

	it("skips applied but decoded-elsewhere would empty: decoded not applied, plan keeps skips", () => {
		// Skips take the upper half; the decoded range takes what is left.
		const ranges: ScanRange[] = [{ startHz: 446_000_000, endHz: 446_020_000 }]
		const ctx = withSkips([
			{ key: "op/a", startHz: 446_010_001, endHz: 446_020_000 },
		])
		ctx.decoderCoverage = () => [external("x", [446_005_000])]
		const spec = sweep(ranges, {
			skipBandPlanSkips: true,
			skipDecodedElsewhere: true,
		})
		const p = previewPlan(spec, ctx)
		const skipOnly = previewPlan(
			sweep(ranges, { skipBandPlanSkips: true }),
			withSkips([{ key: "op/a", startHz: 446_010_001, endHz: 446_020_000 }]),
		)
		expect(p.bandPlanSkips?.map(x => x.applied)).toEqual([true])
		expect(p.decodedElsewhere?.map(x => x.applied)).toEqual([false])
		expect(
			p.issues.filter(i => i.code === "decoded-elsewhere-not-applied"),
		).toHaveLength(1)
		expect(p.plan).toEqual(skipOnly.plan)
		// Without the skips the decoded range alone would apply.
		const deOnly = previewPlan(
			sweep(ranges, { skipDecodedElsewhere: true }),
			withCoverage([external("x", [446_005_000])]),
		)
		expect(deOnly.decodedElsewhere?.map(x => x.applied)).toEqual([true])
	})

	it("passes the truncation warning through", () => {
		const sources: BandPlanSkipSource[] = Array.from(
			{ length: 1100 },
			(_, i) => ({
				key: `op/b${i}`,
				startHz: 441_000_000 + i * 1000,
				endHz: 441_000_000 + i * 1000 + 10,
			}),
		)
		const p = previewPlan(sweep(RANGES), withSkips(sources))
		expect(
			p.issues.filter(i => i.code === "bandplan-skips-truncated"),
		).toHaveLength(1)
		expect((p.bandPlanSkips ?? []).length).toBeGreaterThan(0)
	})

	it("a non-array view changes nothing", () => {
		const spec = sweep(RANGES, { skipBandPlanSkips: true })
		const base = previewPlan(spec, context())
		const ctx = context()
		ctx.bandPlanSkips = () =>
			({ length: 1 }) as unknown as readonly BandPlanSkipSource[]
		expect(previewPlan(spec, ctx)).toEqual(base)
	})
})

describe("skipBandPlanSkips normalisation", () => {
	it("round-trips the flag with operator provenance; absent stays absent", () => {
		for (const flag of [true, false]) {
			const n = normaliseSpec(
				sweep(RANGES, { skipBandPlanSkips: flag }),
				context(),
			).spec
			expect(n.skipBandPlanSkips).toBe(flag)
			expect(n.provenance["skipBandPlanSkips"]).toBe("operator")
			expect(toJobSpec(n).skipBandPlanSkips).toBe(flag)
			const again = normaliseSpec(toJobSpec(n), context()).spec
			expect(again.skipBandPlanSkips).toBe(flag)
			expect(toJobSpec(again)).toEqual(toJobSpec(n))
		}
	})

	it("an old persisted spec without the key loads unchanged", () => {
		const n = normaliseSpec(sweep(RANGES), context()).spec
		expect("skipBandPlanSkips" in n).toBe(false)
		expect(n.provenance["skipBandPlanSkips"]).toBeUndefined()
		expect("skipBandPlanSkips" in toJobSpec(n)).toBe(false)
	})
})
