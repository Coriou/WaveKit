import { BANDPLANS_LIMITS } from "@wavekit/api-types"
import type { BandPlanStackView, BandRegion } from "@wavekit/api-types"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { projectBuiltinPacks } from "../../../../../src/core/bandplans/builtin-packs.js"
import { resolveScannerBandplans } from "../../../../../src/core/bandplans/scanner-feed.js"
import { previewPlan } from "../../../../../src/core/scanner/plan/plan-preview.js"
import type {
	PreviewContext,
	PreviewSourceView,
} from "../../../../../src/core/scanner/plan/plan-preview.js"
import { bandplansFor } from "../../../../../src/core/scanner/bandplan/index.js"
import type { Bandplan } from "../../../../../src/core/scanner/bandplan/index.js"
import type {
	Impact,
	ScanJobSpec,
	ScannerSettings,
} from "../../../../../src/core/scanner/types.js"
import { BAND_REGIONS } from "../../../../../src/decoders/band-region.js"

const MHz = (value: number) => Math.round(value * 1e6)

function settings(): ScannerSettings {
	return {
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
	}
}

function emptyImpact(): Impact {
	return {
		liveAudioClients: 0,
		digitalVoiceListeners: 0,
		runningDecoders: [],
		pinnedDecoders: [],
		scannerJobs: [],
		unrestorable: [],
	}
}

const PI: PreviewSourceView = {
	id: "pi",
	kind: "rtl_tcp",
	format: "U8_IQ",
	sampleRateHz: 2_048_000,
	centreHz: MHz(446.1),
	controllable: true,
	controlMode: "internal",
	role: "shared",
	link: "network",
}

function ctx(over: Partial<PreviewContext> = {}): PreviewContext {
	const context: PreviewContext = {
		sources: [PI],
		channelizerAvailable: false,
		usableFraction: 0.8,
		settings: settings(),
		measured: {
			settleMs: { local: null, network: null },
			markerSupported: { pi: true },
			probeStartMs: 400,
		},
		impactFor: () => emptyImpact(),
		region: "EU",
		tunerRange: () => ({ startHz: 24_000_000, endHz: 1_766_000_000 }),
	}
	return { ...context, ...over }
}

function width(plan: Bandplan): number {
	return plan.ranges.reduce(
		(sum, range) => sum + (range.endHz - range.startHz),
		0,
	)
}

function narrowIds(region: BandRegion): string[] {
	return bandplansFor(region)
		.filter(plan => width(plan) > 0 && width(plan) <= 5_000_000)
		.map(plan => plan.id)
}

const arbRegion = fc.constantFrom(...BAND_REGIONS)
const arbMode = fc.constantFrom(
	"in-window" as const,
	"sweep" as const,
	"auto" as const,
)

const arbSpec = arbRegion.chain(region => {
	const narrow = narrowIds(region)
	const ids = narrow.length > 0 ? narrow : ["no-such-plan"]
	return fc
		.record({
			mode: arbMode,
			bandplans: fc.uniqueArray(fc.constantFrom(...ids), { maxLength: 2 }),
			ranges: fc.array(
				fc.integer({ min: 144_000_000, max: 450_000_000 }).chain(start =>
					fc.integer({ min: 1_000, max: 150_000 }).map(span => ({
						startHz: start,
						endHz: start + span,
					})),
				),
				{ maxLength: 2 },
			),
			inherit: fc.boolean(),
		})
		.map(sample => {
			const mode = sample.mode === "sweep" ? "in-window" : sample.mode
			const spec: ScanJobSpec = { mode }
			if (sample.bandplans.length > 0) spec.bandplans = [...sample.bandplans]
			if (sample.ranges.length > 0) {
				spec.ranges = sample.ranges.map(range =>
					sample.inherit
						? range
						: { ...range, rasters: [], bandplanId: "operator" },
				)
			}
			return { region, spec }
		})
})

function euFeed(hiddenId?: string): readonly Bandplan[] {
	const pack = projectBuiltinPacks().find(item => item.region === "EU")
	if (!pack) throw new Error("missing EU pack")
	const view: BandPlanStackView = {
		schemaVersion: 1,
		store: { state: "unavailable" },
		context: { region: "EU", effectiveCountry: null },
		capabilities: { writable: false, importFormats: [] },
		stack: {
			source: "default",
			entries: [
				{
					packId: pack.id,
					enabled: true,
					kind: "builtin",
					name: pack.name,
				},
			],
		},
		packs: [
			{
				id: pack.id,
				kind: pack.kind,
				name: pack.name,
				region: pack.region,
				provenance: pack.provenance,
				bandCount: pack.bands.length,
				editCount: hiddenId === undefined ? 0 : 1,
			},
		],
		operatorBands: [],
		edits:
			hiddenId === undefined
				? []
				: [
						{
							packId: pack.id,
							bandId: hiddenId,
							set: { hidden: true },
							updatedAt: "2026-01-01T00:00:00.000Z",
						},
					],
		orphanedEdits: [],
		limits: BANDPLANS_LIMITS,
	}
	return resolveScannerBandplans(view)
}

describe("previewPlan effective bandplans", () => {
	it("matches the regional feed when the context passes that same list", () => {
		// Feature: band-plans, Property 16: Default scanner parity
		// Validates: Requirements 11.2, 11.4, 1.1
		const listed = bandplansFor("EU")
		const frozen = Object.freeze([...listed])
		expect(() =>
			previewPlan(
				{ bandplans: ["pmr446"], mode: "sweep" },
				ctx({ bandplans: frozen }),
			),
		).not.toThrow()
		expect(
			previewPlan(
				{ bandplans: ["pmr446"], mode: "sweep" },
				ctx({ bandplans: listed }),
			),
		).toStrictEqual(
			previewPlan({ bandplans: ["pmr446"], mode: "sweep" }, ctx()),
		)
		fc.assert(
			fc.property(arbSpec, ({ region, spec }) => {
				const plans = bandplansFor(region)
				expect(
					previewPlan(spec, ctx({ region, bandplans: plans })),
				).toStrictEqual(previewPlan(spec, ctx({ region })))
			}),
			{ numRuns: 100 },
		)
	})

	it("reports range-empty for an id absent from the supplied list", () => {
		fc.assert(
			fc.property(arbRegion, fc.nat(), (region, salt) => {
				const all = bandplansFor(region)
				const dropped = all[salt % all.length]
				if (!dropped) return
				const plans = all.filter(plan => plan.id !== dropped.id)
				const preview = previewPlan(
					{ bandplans: [dropped.id], mode: "in-window" },
					ctx({ region, bandplans: plans }),
				)
				expect(preview.issues).toContainEqual({
					code: "range-empty",
					severity: "error",
					message: `bandplan ${dropped.id} is not available in region ${region}`,
					details: { bandplan: dropped.id },
				})
				expect(
					preview.spec.ranges.some(range => range.bandplanId === dropped.id),
				).toBe(false)
			}),
			{ numRuns: 100 },
		)
	})

	it("stops inheriting rasters from a plan the feed hid", () => {
		const visible = euFeed()
		const hidden = euFeed("ism-433")
		expect(visible.some(plan => plan.id === "ism-433")).toBe(true)
		expect(hidden.some(plan => plan.id === "ism-433")).toBe(false)
		const spec: ScanJobSpec = {
			mode: "in-window",
			ranges: [{ startHz: MHz(433.2), endHz: MHz(433.3) }],
		}
		const hosted = previewPlan(spec, ctx({ bandplans: visible }))
		const unhosted = previewPlan(spec, ctx({ bandplans: hidden }))
		expect(hosted.spec.ranges[0]).toMatchObject({
			bandplanId: "ism-433",
			protocols: ["ism"],
			obwHz: [],
		})
		expect(hosted.spec.ranges[0]?.rasters).toBeUndefined()
		expect(unhosted.spec.ranges[0]?.bandplanId).toBe("amateur-70cm")
		expect(unhosted.spec.ranges[0]?.protocols).not.toEqual(["ism"])
		expect(unhosted.spec.ranges[0]?.rasters?.length).toBeGreaterThan(0)
		expect(previewPlan(spec, ctx({ bandplans: visible }))).toStrictEqual(
			previewPlan(spec, ctx()),
		)
	})
})
