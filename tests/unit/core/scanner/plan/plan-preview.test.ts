import { describe, expect, it } from "vitest"
import { probeCores } from "../../../../../src/core/scanner/plan/cost.js"
import {
	DEFAULT_CONFIRM_HOLD_MS,
	previewPlan,
	probeTransportFor,
} from "../../../../../src/core/scanner/plan/plan-preview.js"
import type {
	PreviewContext,
	PreviewSourceView,
} from "../../../../../src/core/scanner/plan/plan-preview.js"
import type {
	Impact,
	PlanPreview,
	ScanJobSpec,
	ScannerSettings,
} from "../../../../../src/core/scanner/types.js"
import type { WaveKitError } from "../../../../../src/utils/errors.js"

const MHz = (x: number) => Math.round(x * 1e6)

function settings(
	edit: (s: ScannerSettings) => void = () => undefined,
): ScannerSettings {
	const s: ScannerSettings = {
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
	edit(s)
	return s
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
const SDRPP: PreviewSourceView = {
	...PI,
	id: "sdrpp",
	kind: "sdrpp",
	controllable: false,
	controlMode: null,
}
const EXT: PreviewSourceView = { ...PI, id: "ext", controlMode: "external" }
const AUDIO: PreviewSourceView = { ...PI, id: "audio", format: "audio_pcm" }
const S16: PreviewSourceView = { ...PI, id: "s16", format: "S16_IQ" }
const DEDI: PreviewSourceView = {
	...PI,
	id: "dedi",
	role: "dedicated",
	link: "local",
}

function ctx(over: Partial<PreviewContext> = {}): PreviewContext {
	return {
		sources: [PI, SDRPP, EXT, AUDIO, S16],
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
		...over,
	}
}
const codes = (p: PlanPreview) => p.issues.map(i => `${i.severity}:${i.code}`)
const errors = (p: PlanPreview) =>
	p.issues.filter(i => i.severity === "error").map(i => i.code)
const PMR = { startHz: MHz(446.0), endHz: MHz(446.2) }

describe("previewPlan derived defaults", () => {
	it("fills every default for a bandplan sweep, with provenance, period, POI and estimates", () => {
		const p = previewPlan({ bandplans: ["uhf-land-mobile"] }, ctx())
		expect(p.spec).toMatchObject({
			sourceId: "pi",
			mode: "sweep",
			kind: "discover",
			sensitivity: "normal",
			priority: 50,
			fftSize: 2048,
			integrationMs: 50,
			thresholdDb: null,
			settleMs: 35,
			dwellMs: 185,
			protocols: ["dmr", "analog-fm", "p25p1", "nxdn48", "nxdn96"],
			revisit: { share: 0.3, maxIntervalMs: null },
			record: { voice: true, analog: true, data: true },
			evidence: { psd: true, iq: false },
			tuner: {
				sampleRateHz: null,
				gainTenthsDb: null,
				agc: null,
				overload: "flag",
			},
			stop: { afterSweeps: null, afterMs: null, onFirstDecoded: false },
			takeover: false,
			resume: { autoAfterIdleMs: 60_000, onBoot: false },
			txDurationHintMs: 5000,
		})
		expect(p.spec.hold).toEqual({
			policy: "hold",
			confirmHoldMs: DEFAULT_CONFIRM_HOLD_MS,
			maxHoldMs: 60_000,
			hangMs: 2000,
		})
		expect(p.spec.provenance).toMatchObject({
			mode: "default",
			ranges: "bandplan",
			"ranges.rasters": "bandplan",
			protocols: "bandplan",
			fftSize: "default",
			settleMs: "default",
			dwellMs: "default",
			"hold.confirmHoldMs": "default",
			sourceId: "default",
		})
		expect(p.plan.hops).toHaveLength(44)
		expect(p.sweepPeriodMs).toBe(58 * 185) // 44 hops + 14 revisits at share 0.3
		expect(p.poi[0]!.detection).toBeCloseTo(5050 / 10_730, 9)
		expect(p.poi[0]!.decode).toBeCloseTo(1150 / 10_730, 9)
		expect(errors(p)).toEqual([])
		expect(codes(p)).toContain("warning:poi-low")
		expect(codes(p)).not.toContain("warning:settle-unmeasured")
		expect(p.estimates).toEqual({
			cpuCores: 0.58,
			diskMbPerHour: 57.6,
			probes: 1,
		})
	})

	it("chooses in-window when the ranges fit, inherits the PMR446 raster, and never asks for impact", () => {
		let calls = 0
		const p = previewPlan(
			{ ranges: [PMR] },
			ctx({ impactFor: () => (calls++, emptyImpact()) }),
		)
		expect(p.spec.mode).toBe("in-window")
		expect(p.spec.ranges[0]).toMatchObject({
			rasters: [{ spacingHz: 12_500, firstChannelHz: MHz(446.00625) }],
			obwHz: [9000, 11_000],
			bandplanId: "pmr446",
		})
		expect(p.spec.provenance).toMatchObject({
			"ranges.rasters": "bandplan",
			ranges: "operator",
			protocols: "bandplan",
		})
		expect(p.plan.hops.map(h => h.centreHz)).toEqual([MHz(446.1)])
		expect(p.sweepPeriodMs).toBeNull()
		expect(p.poi).toEqual([{ hopIndex: 0, detection: 1, decode: 1 }])
		expect(p.spec.settleMs).toBe(0)
		expect(calls).toBe(0)
		expect(p.impact).toEqual(emptyImpact())
		expect(codes(p)).toContain("warning:dc-adjacent-channels")
		expect(errors(p)).toEqual([])
	})

	it("follows the whole current window when no range is given", () => {
		const p = previewPlan({}, ctx())
		expect(p.spec.mode).toBe("in-window")
		expect(p.spec.ranges).toEqual([])
		expect(p.spec.protocols).toEqual([])
		expect(p.plan.hops).toHaveLength(1)
		expect(p.plan.hops[0]!.centreHz).toBe(MHz(446.1))
		expect(errors(p)).toEqual([])
	})

	it("uses 100 ms blocks for high sensitivity and lengthens the dwell", () => {
		const p = previewPlan(
			{ bandplans: ["uhf-land-mobile"], sensitivity: "high" },
			ctx(),
		)
		expect(p.spec.integrationMs).toBe(100)
		expect(p.spec.dwellMs).toBe(35 + 3 * 100)
	})

	it("applies an operator confirmHoldMs to every class", () => {
		const p = previewPlan(
			{
				bandplans: ["uhf-land-mobile"],
				hold: { policy: "confirm", confirmHoldMs: 2500 },
			},
			ctx(),
		)
		expect(
			Object.values(p.spec.hold.confirmHoldMs).every(v => v === 2500),
		).toBe(true)
		expect(p.spec.hold.policy).toBe("confirm")
		expect(p.spec.provenance["hold.confirmHoldMs"]).toBe("operator")
	})

	it("labels hold.policy operator only when the operator gave a policy", () => {
		// ScanJobSpec makes `policy` required inside `hold`; a raw, unvalidated spec can still omit it
		const other = previewPlan(
			{
				bandplans: ["uhf-land-mobile"],
				hold: { maxHoldMs: 30_000 } as unknown as NonNullable<
					ScanJobSpec["hold"]
				>,
			},
			ctx(),
		)
		expect(other.spec.hold.policy).toBe("hold")
		expect(other.spec.provenance["hold.policy"]).toBe("default")
		expect(other.spec.provenance["hold.maxHoldMs"]).toBe("operator")
		const given = previewPlan(
			{ bandplans: ["uhf-land-mobile"], hold: { policy: "never" } },
			ctx(),
		)
		expect(given.spec.provenance["hold.policy"]).toBe("operator")
	})

	it("picks the first non-dedicated source and rejects unknown ones", () => {
		expect(previewPlan({}, ctx({ sources: [DEDI, PI] })).spec.sourceId).toBe(
			"pi",
		)
		let code = ""
		try {
			previewPlan({ sourceId: "nope" }, ctx())
		} catch (err) {
			code = (err as WaveKitError).code
		}
		expect(code).toBe("SCANNER_SOURCE_NOT_FOUND")
	})

	it("uses the measured timer settle when markers are unsupported", () => {
		const measured = previewPlan(
			{ bandplans: ["uhf-land-mobile"] },
			ctx({
				measured: {
					settleMs: { local: null, network: 700 },
					markerSupported: { pi: false },
					probeStartMs: null,
				},
			}),
		)
		expect(measured.spec.settleMs).toBe(700)
		expect(measured.spec.provenance["settleMs"]).toBe("measured")
		expect(measured.spec.dwellMs).toBe(850)
		expect(codes(measured)).toContain("warning:settle-timer")
		expect(codes(measured)).not.toContain("warning:settle-unmeasured")
		const fallback = previewPlan(
			{ bandplans: ["uhf-land-mobile"] },
			ctx({
				measured: {
					settleMs: { local: null, network: null },
					markerSupported: { pi: false },
					probeStartMs: null,
				},
			}),
		)
		expect(fallback.spec.settleMs).toBe(1000)
		expect(codes(fallback)).toEqual(
			expect.arrayContaining([
				"warning:settle-timer",
				"warning:settle-unmeasured",
			]),
		)
	})
})

describe("previewPlan errors", () => {
	const UHF = { bandplans: ["uhf-land-mobile"] }
	it.each<[string, ScanJobSpec, Partial<PreviewContext>, string]>([
		[
			"an inverted range",
			{ ranges: [{ startHz: MHz(446.2), endHz: MHz(446.1) }] },
			{},
			"range-empty",
		],
		["an unknown bandplan", { bandplans: ["no-such-plan"] }, {}, "range-empty"],
		[
			"a range outside the tuner",
			{ ranges: [{ startHz: MHz(10), endHz: MHz(11) }] },
			{},
			"range-outside-tuner",
		],
		[
			"exclusions covering everything",
			{
				ranges: [PMR],
				exclusions: [{ startHz: MHz(445.9), endHz: MHz(446.3) }],
			},
			{},
			"all-excluded",
		],
		[
			"exclusions covering every channel but not the continuum",
			{
				bandplans: ["pmr446"],
				mode: "sweep",
				exclusions: [{ startHz: MHz(446.0), endHz: MHz(446.199) }],
			},
			{},
			"plan-empty",
		],
		[
			"a raster range holding no channel",
			{
				mode: "sweep",
				ranges: [
					{
						startHz: MHz(446.0),
						endHz: MHz(446.005),
						rasters: [{ spacingHz: 12_500, firstChannelHz: MHz(446.00625) }],
						obwHz: [9000],
					},
				],
			},
			{},
			"plan-empty",
		],
		[
			"an in-window job outside the window",
			{ mode: "in-window", ranges: [{ startHz: MHz(400), endHz: MHz(470) }] },
			{},
			"not-in-window",
		],
		[
			"a sweep without tuner control",
			{ ...UHF, sourceId: "sdrpp" },
			{},
			"no-tuner-control",
		],
		[
			"a sweep under relay control",
			{ ...UHF, sourceId: "ext" },
			{},
			"source-busy",
		],
		[
			"a dwell shorter than settle + 3 blocks",
			{ ...UHF, dwellMs: 100 },
			{},
			"dwell-too-short",
		],
		[
			"maxHoldMs below confirmHoldMs",
			{ ...UHF, protocols: ["dmr"], hold: { policy: "hold", maxHoldMs: 1000 } },
			{},
			"hold-inconsistent",
		],
		[
			"a channel wider than the span",
			{
				mode: "sweep",
				ranges: [
					{
						startHz: MHz(400),
						endHz: MHz(410),
						rasters: [{ spacingHz: 1_200_000, firstChannelHz: MHz(400.6) }],
					},
				],
			},
			{},
			"channel-too-wide",
		],
		["a non-IQ source", { sourceId: "audio" }, {}, "source-not-iq"],
		[
			"a DMR-only job on an S16 source",
			{ sourceId: "s16", ranges: [PMR], protocols: ["dmr"] },
			{},
			"no-probe-transport",
		],
		[
			"an ISM-only job before the channelizer",
			{
				mode: "sweep",
				ranges: [{ startHz: MHz(433.9), endHz: MHz(434.0) }],
				protocols: ["ism"],
			},
			{},
			"no-probe-transport",
		],
	])("reports %s", (_name, spec, over, code) => {
		expect(errors(previewPlan(spec, ctx(over)))).toContain(code)
	})
})

describe("previewPlan warnings", () => {
	const UHF: ScanJobSpec = { bandplans: ["uhf-land-mobile"] }
	it.each<[string, ScanJobSpec, Partial<PreviewContext>, string]>([
		[
			"a coarse RBW",
			{ bandplans: ["pmr446"], mode: "sweep", fftSize: 512 },
			{},
			"rbw-coarse",
		],
		["a fine RBW", { bandplans: ["pmr446"], fftSize: 16_384 }, {}, "rbw-fine"],
		[
			"timer settle",
			UHF,
			{
				measured: {
					settleMs: { local: null, network: null },
					markerSupported: { pi: false },
					probeStartMs: null,
				},
			},
			"settle-timer",
		],
		[
			"unmeasured markers",
			UHF,
			{
				measured: {
					settleMs: { local: null, network: null },
					markerSupported: {},
					probeStartMs: null,
				},
			},
			"settle-unmeasured",
		],
		[
			"the CPU budget",
			UHF,
			{ settings: settings(s => (s.cpuBudgetCores = 0.5)) },
			"budget-cpu",
		],
		["the disk budget", UHF, { channelizerAvailable: true }, "budget-disk"],
		["DC-adjacent channels", { ranges: [PMR] }, {}, "dc-adjacent-channels"],
		[
			"a dedicated receiver",
			UHF,
			{ sources: [PI, DEDI] },
			"dedicated-available",
		],
		[
			"unrestorable fields",
			UHF,
			{
				impactFor: () => ({ ...emptyImpact(), unrestorable: ["gainTenthsDb"] }),
			},
			"unrestorable",
		],
		[
			"protocols without a probe",
			{ ...UHF, protocols: ["dmr", "ism"] },
			{},
			"probe-unavailable",
		],
		["a low intercept probability", UHF, {}, "poi-low"],
	])("warns about %s", (_name, spec, over, code) => {
		const p = previewPlan(spec, ctx(over))
		expect(codes(p)).toContain(`warning:${code}`)
		expect(errors(p)).toEqual([])
	})

	it("estimates channel probes after the channelizer and echoes the impact", () => {
		const impact = {
			...emptyImpact(),
			runningDecoders: ["dmr-1"],
			liveAudioClients: 1,
		}
		const p = previewPlan(
			{ bandplans: ["uhf-land-mobile"] },
			ctx({ channelizerAvailable: true, impactFor: () => impact }),
		)
		expect(p.estimates).toEqual({
			cpuCores: 0.46,
			diskMbPerHour: 230.4,
			probes: 4,
		})
		expect(p.impact).toEqual(impact)
	})
})

describe("preview helpers", () => {
	it("maps protocols to probe transports", () => {
		expect(probeTransportFor("dmr", "U8_IQ", false)).toEqual({
			transport: "offset",
		})
		expect(probeTransportFor("dmr", "U8_IQ", true)).toEqual({
			transport: "channel",
		})
		expect(probeTransportFor("dmr", "S16_IQ", false)).toEqual({
			transport: null,
			reason: "unsupported-format",
		})
		expect(probeTransportFor("ism", "U8_IQ", false)).toEqual({
			transport: null,
			reason: "needs-channelizer",
		})
		expect(probeTransportFor("ism", "U8_IQ", true)).toEqual({
			transport: "channel",
		})
		expect(probeTransportFor("analog-fm", "U8_IQ", true)).toEqual({
			transport: null,
			reason: "no-decoder",
		})
	})
	it("costs probes per transport and decoder", () => {
		expect(probeCores("offset", "dsd-fme")).toBe(0.5)
		expect(probeCores("channel", "dsd-fme")).toBeCloseTo(0.095, 9)
		expect(probeCores("channel", "something-new")).toBeCloseTo(0.15, 9)
	})
})
