import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	planForSpec,
	previewPlan,
	toJobSpec,
} from "../../../../../src/core/scanner/plan/plan-preview.js"
import type {
	PreviewContext,
	PreviewSourceView,
} from "../../../../../src/core/scanner/plan/plan-preview.js"
import type {
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

function deepFreeze<T>(x: T): T {
	if (x !== null && typeof x === "object" && !Object.isFrozen(x)) {
		Object.freeze(x)
		for (const v of Object.values(x)) deepFreeze(v)
	}
	return x
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

describe("plan preview agreement", () => {
	it("is side-effect free and agrees with the plan a job created from it would use", () => {
		// Feature: signal-discovery-scanner, Property 15: Preview agreement
		// Validates: spec § 5.4, § 12.1
		fc.assert(
			fc.property(specArb, spec => {
				const ctx = deepFreeze(context())
				deepFreeze(spec)
				const first = previewPlan(spec, ctx)
				expect(previewPlan(spec, ctx)).toEqual(first)
				expect(planForSpec(first.spec, ctx)).toEqual(first.plan)
				const again = previewPlan(toJobSpec(first.spec), ctx)
				expect(again.plan).toEqual(first.plan)
				const { provenance: _a, ...normalised } = first.spec
				const { provenance: _b, ...renormalised } = again.spec
				expect(renormalised).toEqual(normalised)
			}),
			{ numRuns: 100 },
		)
	}, 60_000) // 100 full previews (planner + POI per hop): ~5 s on a loaded laptop
})
