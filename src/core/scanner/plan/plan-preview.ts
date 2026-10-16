import type { TunerControlMode } from "@wavekit/api-types"
import { WaveKitError } from "../../../utils/errors.js"
import { defaultFftSize } from "../../spectrum/fft.js"
import { bandplansFor } from "../bandplan/index.js"
import type { Bandplan, BandRegionCode } from "../bandplan/index.js"
import type { FreqRange, IqFormat } from "../../spectrum/types.js"
import type {
	DecodedElsewhereRange,
	BandPlanSkipSource,
	DecoderCoverageView,
	Hop,
	HopPlan,
	Impact,
	LockoutExclusion,
	NormalisedJobSpec,
	PlanIssue,
	PlanIssueCode,
	PlanPreview,
	ScanExclusion,
	ScanJobSpec,
	ScanMode,
	ScannerClass,
	ScannerProtocol,
	ScannerSettings,
	ScanRange,
} from "../types.js"
import { CPU_COST, probeCores } from "./cost.js"
import { protocolsForHop } from "./protocols.js"
import { describeHop, planHops } from "./hop-planner.js"
import { normaliseCapture } from "../evidence/capture-spec.js"
import type { HopPlanInput } from "./hop-planner.js"
import { isRangeEnabled } from "./range-contract.js"
import { lockoutExclusionsFor, planWithLockouts } from "./lockouts.js"
import type { LockoutTarget } from "./lockouts.js"
import { computeDecodedElsewhere } from "./decoded-elsewhere.js"
import type { StoredScanJobSpec } from "./range-contract.js"

/**
 * POST /api/scanner/plan (spec § 5.4): pure. Normalises a job spec (every derived default plus its
 * provenance), plans the hops through the one plan function create/PATCH also use (P15), and
 * reports estimates and issues. No I/O, no clocks, no mutation of the inputs.
 */

export interface PreviewSourceView {
	id: string
	kind: string
	format: string // IqFormat | "audio_pcm" | "auto"
	sampleRateHz: number
	centreHz: number | null
	controllable: boolean // a TunerController manages it (rtl_tcp)
	controlMode: TunerControlMode | null // null when not controllable
	role: "shared" | "dedicated"
	link: "local" | "network"
}

export interface PreviewMeasured {
	settleMs: { local: number | null; network: number | null }
	markerSupported: Record<string, boolean | null> // by source id; missing or null = not measured yet
	probeStartMs: number | null
}

export interface PreviewContext {
	sources: PreviewSourceView[]
	channelizerAvailable: boolean
	usableFraction: number
	settings: ScannerSettings
	measured: PreviewMeasured
	impactFor(sourceId: string, spec: NormalisedJobSpec): Impact
	region: BandRegionCode
	tunerRange(sourceId: string): FreqRange
	/** Omitted: bandplansFor(region). Present: host ranges and plan-id lookup. */
	bandplans?: readonly Bandplan[]
	/** WG2 req 12: locked-out discoveries heard on the source. Omitted: none (sweeps plan as before). */
	lockouts?: (sourceId: string) => readonly LockoutTarget[]
	/**
	 * WG6 req 1.1: the decoders the plan may treat as covering frequencies elsewhere. Omitted:
	 * no `decodedElsewhere` and plans exactly as before.
	 */
	decoderCoverage?: () => readonly DecoderCoverageView[]
	/**
	 * WG7 req 6.2: the skip-marked segments of the resolved band plans. Omitted: no
	 * `bandPlanSkips` and plans exactly as before.
	 */
	bandPlanSkips?: () => readonly BandPlanSkipSource[]
}

type Provenance = NormalisedJobSpec["provenance"][string]
type DecoderType = "dsd-fme" | "multimon-ng" | "direwolf" | "rtl433"

export const MARKER_RUN_ASSUMED_MS = 30 // spec § 11; A0 (Task 47) replaces it

export const DEFAULT_CONFIRM_HOLD_MS: Readonly<Record<ScannerClass, number>> = {
	"tdma-ms": 1800, // late entry 1337 + 360 + 100; the scheduler adds probe start latency
	"fsk4-12k5": 3800, // DMR late entry + 2000 for the -fn pass
	"fsk4-6k25": 4000, // -fi then -fm, 2000 each
	"gmsk-narrow": 2000,
	"fsk2-wide": 4000,
	"afsk-fm": 3000,
	"ook-burst": 10_000,
	"analog-fm": 1500,
	carrier: 0,
	wideband: 0,
	unknown: 0,
}

export const PROTOCOL_DECODER: Readonly<
	Record<ScannerProtocol, DecoderType | null>
> = {
	"analog-fm": null,
	"analog-am": null,
	dmr: "dsd-fme",
	p25p1: "dsd-fme",
	p25p2: "dsd-fme",
	nxdn48: "dsd-fme",
	nxdn96: "dsd-fme",
	ysf: "dsd-fme",
	dstar: "dsd-fme",
	dpmr: "dsd-fme",
	pocsag: "multimon-ng",
	flex: "multimon-ng",
	aprs: "direwolf",
	ism: "rtl433",
	"digital-unknown": null,
	carrier: null,
	unknown: null,
	// WG7 req 1.1: ambient-only protocols (named from running decoders; no probe decoder).
	ais: null,
	acars: null,
	vdl2: null,
	lora: null,
}

const PROTOCOL_CLASS: Readonly<Record<ScannerProtocol, ScannerClass | null>> = {
	"analog-fm": "analog-fm",
	"analog-am": null,
	dmr: "tdma-ms",
	p25p1: "fsk4-12k5",
	p25p2: "fsk4-12k5",
	nxdn48: "fsk4-6k25",
	nxdn96: "fsk4-12k5",
	ysf: "fsk4-12k5",
	dstar: "gmsk-narrow",
	dpmr: "fsk4-6k25",
	pocsag: "fsk2-wide",
	flex: "fsk2-wide",
	aprs: "afsk-fm",
	ism: "ook-burst",
	"digital-unknown": null,
	carrier: null,
	unknown: null,
	ais: null,
	acars: null,
	vdl2: null,
	lora: null,
}

const ALL_PROTOCOLS = Object.keys(PROTOCOL_DECODER) as ScannerProtocol[]
const ALL_CLASSES = Object.keys(DEFAULT_CONFIRM_HOLD_MS) as ScannerClass[]
const IQ_FORMATS: readonly string[] = [
	"U8_IQ",
	"S16_IQ",
	"FLOAT32LE",
] satisfies IqFormat[]
const DEFAULT_PRIORITY = 50
const DEFAULT_AUTO_RESUME_MS = 60_000
const DEFAULT_TX_HINT_MS = 5000
const TYPICAL_OBW_HZ = 9000
const RBW_FINE_HZ = 250
const POI_LOW = 0.5
const VOICE_WAV_MB_PER_HOUR = 57.6 // 8 kHz s16 mono at 100 % airtime (upper bound)
const IQ_SNIPPET_MB = 0.096 // ≤ 1 s at 48 kHz cu8 (spec § 8)
const CONFIRMS_PER_PROBE_HOUR = 60
const DISK_BUDGET_HOURS = 6 // warn when the recordings cap would fill in under 6 h
/** Errors that already explain an empty sweep plan; `plan-empty` covers every other cause (e.g. exclusions eating every channel but not the whole continuum, or a raster range holding no channel). */
const PLAN_EMPTY_CAUSES: ReadonlySet<PlanIssueCode> = new Set<PlanIssueCode>([
	"range-empty",
	"range-outside-tuner",
	"all-excluded",
	"channel-too-wide",
])

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

function issue(
	code: PlanIssueCode,
	severity: "error" | "warning",
	message: string,
	details?: Record<string, unknown>,
): PlanIssue {
	return details === undefined
		? { code, severity, message }
		: { code, severity, message, details }
}

function copyRange(r: ScanRange): ScanRange {
	const out: ScanRange = { startHz: r.startHz, endHz: r.endHz }
	if (r.rasters !== undefined) out.rasters = r.rasters.map(x => ({ ...x }))
	if (r.obwHz !== undefined) out.obwHz = [...r.obwHz]
	if (r.protocols !== undefined) out.protocols = [...r.protocols]
	if (r.bandplanId !== undefined) out.bandplanId = r.bandplanId
	if (r.enabled !== undefined) out.enabled = r.enabled
	if (r.name !== undefined) out.name = r.name
	if (r.dwellMs !== undefined) out.dwellMs = r.dwellMs
	if (r.sensitivity !== undefined) out.sensitivity = r.sensitivity
	return out
}

/**
 * Full-state live overlay, then drop `enabled: true` (absent means enabled). An entry applies
 * only to the range at its index with the same locked identity (SF1 R1 finding 1); entries that
 * no longer match (the band plan under the job changed) are dropped with one warning, never an
 * error, so the job stays editable. Entries without an identity match by index while the counts
 * agree.
 */
function overlayRangeLive(
	ranges: ScanRange[],
	live: StoredScanJobSpec["rangeLive"],
	issues: PlanIssue[],
): void {
	if (live !== undefined) {
		const dropped: number[] = []
		for (let i = 0; i < live.length; i++) {
			const range = ranges[i]
			const src = live[i]
			if (src === undefined) continue
			const legacy = src.startHz === undefined || src.endHz === undefined
			const matches =
				range !== undefined &&
				(legacy
					? live.length === ranges.length
					: src.startHz === range.startHz &&
						src.endHz === range.endHz &&
						src.bandplanId === range.bandplanId)
			if (!matches || range === undefined) {
				dropped.push(i)
				continue
			}
			delete range.enabled
			delete range.protocols
			delete range.name
			delete range.dwellMs
			delete range.sensitivity
			if (src.enabled !== undefined) range.enabled = src.enabled
			if (src.protocols !== undefined) range.protocols = [...src.protocols]
			if (src.name !== undefined) range.name = src.name
			if (src.dwellMs !== undefined) range.dwellMs = src.dwellMs
			if (src.sensitivity !== undefined) range.sensitivity = src.sensitivity
		}
		if (dropped.length > 0)
			issues.push(
				issue(
					"range-locked",
					"warning",
					"the job's ranges changed since their last edit; those edits no longer apply",
					{
						reason: "range-live-stale",
						dropped,
						expected: live.length,
						received: ranges.length,
					},
				),
			)
	}
	for (const range of ranges) if (range.enabled === true) delete range.enabled
}

function unique<T>(xs: Iterable<T>): T[] {
	return [...new Set(xs)]
}

export function probeTransportFor(
	protocol: ScannerProtocol,
	format: string,
	channelizerAvailable: boolean,
): {
	transport: "offset" | "channel" | null
	reason?: "unsupported-format" | "needs-channelizer" | "no-decoder"
} {
	const decoder = PROTOCOL_DECODER[protocol]
	if (decoder === null) return { transport: null, reason: "no-decoder" }
	if (format !== "U8_IQ")
		return { transport: null, reason: "unsupported-format" }
	if (decoder === "rtl433")
		return channelizerAvailable
			? { transport: "channel" }
			: { transport: null, reason: "needs-channelizer" }
	return { transport: channelizerAvailable ? "channel" : "offset" }
}

function findSource(
	id: string | undefined,
	ctx: PreviewContext,
): PreviewSourceView {
	const source =
		id === undefined
			? (ctx.sources.find(s => s.role !== "dedicated") ?? ctx.sources[0])
			: ctx.sources.find(s => s.id === id)
	if (!source)
		throw new WaveKitError(
			`unknown scanner source ${id ?? "(default)"}`,
			"SCANNER_SOURCE_NOT_FOUND",
		)
	return source
}

function fullyExcluded(
	r: FreqRange,
	exclusions: readonly ScanExclusion[],
): boolean {
	let reach = r.startHz
	for (const x of [...exclusions].sort((a, b) => a.startHz - b.startHz)) {
		if (x.startHz > reach) break
		reach = Math.max(reach, x.endHz)
		if (reach >= r.endHz) return true
	}
	return false
}

/** Classes whose confirm rule applies to the protocols (all protocols when the list is empty). */
function decodableClasses(
	protocols: readonly ScannerProtocol[],
	format: string,
	channelizer: boolean,
): ScannerClass[] {
	const list = protocols.length > 0 ? protocols : ALL_PROTOCOLS
	const out: ScannerClass[] = []
	for (const p of list) {
		const cls = PROTOCOL_CLASS[p]
		if (
			cls === null ||
			probeTransportFor(p, format, channelizer).transport === null
		)
			continue
		out.push(cls)
	}
	return unique(out)
}

export function normaliseSpec(
	spec: StoredScanJobSpec,
	ctx: PreviewContext,
): { spec: NormalisedJobSpec; source: PreviewSourceView; issues: PlanIssue[] } {
	const issues: PlanIssue[] = []
	const prov: Record<string, Provenance> = {}
	const pv = (
		key: string,
		operator: boolean,
		fallback: Provenance = "default",
	): void => {
		prov[key] = operator ? "operator" : fallback
	}
	const s = ctx.settings
	const source = findSource(spec.sourceId, ctx)
	pv("sourceId", spec.sourceId !== undefined)
	if (!IQ_FORMATS.includes(source.format)) {
		issues.push(
			issue(
				"source-not-iq",
				"error",
				`source ${source.id} delivers ${source.format}, not IQ`,
				{ format: source.format },
			),
		)
	}

	// Ranges: operator ranges (inheriting rasters from the enclosing regional bandplan), then bandplans.
	const ranges: ScanRange[] = []
	let inherited = false
	const scannerPlans = ctx.bandplans ?? bandplansFor(ctx.region)
	const hosts = scannerPlans
		.flatMap(p => p.ranges)
		.sort((a, b) => a.endHz - a.startHz - (b.endHz - b.startHz))
	for (const r of spec.ranges ?? []) {
		const own = copyRange(r)
		// Only ranges with neither rasters nor a bandplan inherit, from the smallest enclosing plan range.
		const host =
			r.rasters === undefined && r.bandplanId === undefined
				? hosts.find(h => h.startHz <= r.startHz && h.endHz >= r.endHz)
				: undefined
		if (host) {
			inherited = true
			if (host.rasters !== undefined)
				own.rasters = host.rasters.map(x => ({ ...x }))
			if (own.obwHz === undefined && host.obwHz !== undefined)
				own.obwHz = [...host.obwHz]
			if (own.protocols === undefined && host.protocols !== undefined)
				own.protocols = [...host.protocols]
			if (own.bandplanId === undefined && host.bandplanId !== undefined)
				own.bandplanId = host.bandplanId
		}
		ranges.push(own)
	}
	for (const id of spec.bandplans ?? []) {
		const bp = scannerPlans.find(p => p.id === id)
		if (!bp) {
			issues.push(
				issue(
					"range-empty",
					"error",
					`bandplan ${id} is not available in region ${ctx.region}`,
					{ bandplan: id },
				),
			)
			continue
		}
		for (const r of bp.ranges) ranges.push(copyRange(r))
	}
	overlayRangeLive(ranges, spec.rangeLive, issues)
	const enabled = ranges.filter(isRangeEnabled)
	const operatorRanges = (spec.ranges ?? []).length > 0
	const planRanges = (spec.bandplans ?? []).length > 0
	prov["ranges"] = operatorRanges
		? "operator"
		: planRanges
			? "bandplan"
			: "default"
	prov["ranges.rasters"] =
		inherited || planRanges
			? "bandplan"
			: operatorRanges
				? "operator"
				: "default"
	const exclusions: ScanExclusion[] = (spec.exclusions ?? []).map(x => ({
		...x,
	}))
	pv("exclusions", spec.exclusions !== undefined)

	const tuner = ctx.tunerRange(source.id)
	for (const r of ranges) {
		const range = { startHz: r.startHz, endHz: r.endHz }
		if (!(r.startHz > 0) || !(r.endHz > r.startHz)) {
			issues.push(
				issue(
					"range-empty",
					"error",
					`range ${r.startHz}–${r.endHz} Hz is empty or inverted`,
					{ range },
				),
			)
		} else if (r.startHz < tuner.startHz || r.endHz > tuner.endHz) {
			issues.push(
				issue(
					"range-outside-tuner",
					"error",
					`range ${r.startHz}–${r.endHz} Hz is outside the tuner's ${tuner.startHz}–${tuner.endHz} Hz`,
					{ range, tuner },
				),
			)
		}
	}
	if (enabled.length > 0 && enabled.every(r => fullyExcluded(r, exclusions))) {
		issues.push(
			issue("all-excluded", "error", "the exclusions cover every range"),
		)
	}

	// Mode.
	const windowHalf = (source.sampleRateHz * ctx.usableFraction) / 2
	const centre = source.centreHz
	const fits =
		centre !== null &&
		enabled.every(
			r => r.startHz >= centre - windowHalf && r.endHz <= centre + windowHalf,
		)
	const requested = spec.mode ?? "auto"
	const mode: ScanMode =
		requested === "auto" ? (fits ? "in-window" : "sweep") : requested
	pv("mode", requested !== "auto")
	if (mode === "in-window" && !fits) {
		issues.push(
			issue(
				"not-in-window",
				"error",
				"in-window mode needs every range inside the source's current usable span",
				{ centreHz: centre, halfSpanHz: windowHalf },
			),
		)
	}
	if (ranges.length > 0 && enabled.length === 0) {
		issues.push(
			issue("range-empty", "error", "every range is disabled", {
				disabled: ranges.length,
			}),
		)
	}
	if (mode === "sweep") {
		// All-disabled already reported the one range-empty above. This is the
		// no-range sweep, unchanged from before per-range enabled existed.
		if (ranges.length === 0)
			issues.push(
				issue(
					"range-empty",
					"error",
					"a sweep needs at least one range or bandplan",
				),
			)
		if (!source.controllable) {
			issues.push(
				issue(
					"no-tuner-control",
					"error",
					`source ${source.id} (${source.kind}) has no tuner control`,
				),
			)
		} else if (source.controlMode === "external") {
			issues.push(
				issue(
					"source-busy",
					"error",
					`source ${source.id} is under external (relay) control`,
				),
			)
		}
	}

	// Detection parameters.
	const fs =
		mode === "sweep"
			? (spec.tuner?.sampleRateHz ?? source.sampleRateHz)
			: source.sampleRateHz
	const sensitivity = spec.sensitivity ?? s.detection.sensitivity
	pv("sensitivity", spec.sensitivity !== undefined)
	const fftSize =
		spec.fftSize ??
		(s.detection.fftSize === "auto" ? defaultFftSize(fs) : s.detection.fftSize)
	pv(
		"fftSize",
		spec.fftSize !== undefined,
		s.detection.fftSize === "auto" ? "default" : "config",
	)
	const integrationMs =
		spec.integrationMs ??
		(sensitivity === "high" ? 100 : s.detection.integrationMs)
	pv("integrationMs", spec.integrationMs !== undefined)
	const thresholdDb = spec.thresholdDb ?? null
	pv("thresholdDb", spec.thresholdDb !== undefined)
	const rbw = fs / fftSize
	const obwClasses = enabled.flatMap(r => r.obwHz ?? []).filter(o => o > 0)
	const typicalObw =
		obwClasses.length > 0 ? Math.min(...obwClasses) : TYPICAL_OBW_HZ
	if (rbw > typicalObw / 4)
		issues.push(
			issue(
				"rbw-coarse",
				"warning",
				`RBW ${rbw.toFixed(0)} Hz is above a quarter of the ${typicalObw} Hz OBW`,
				{ rbwHz: rbw, obwHz: typicalObw },
			),
		)
	if (rbw < RBW_FINE_HZ)
		issues.push(
			issue(
				"rbw-fine",
				"warning",
				`RBW ${rbw.toFixed(0)} Hz is below ${RBW_FINE_HZ} Hz`,
				{ rbwHz: rbw },
			),
		)
	const half = (fs * ctx.usableFraction) / 2
	const spacings = enabled.flatMap(r => (r.rasters ?? []).map(x => x.spacingHz))
	const slack = spacings.length > 0 ? Math.min(...spacings) : 0
	const widest = Math.max(0, ...spacings, ...obwClasses)
	if (widest >= 2 * (half - slack) || widest > 2 * half) {
		issues.push(
			issue(
				"channel-too-wide",
				"error",
				`a ${widest} Hz channel does not fit the ${2 * half} Hz usable span`,
				{ widthHz: widest, usableSpanHz: 2 * half },
			),
		)
	}

	// Settle and dwell.
	let settleMs: number
	if (mode === "in-window") {
		settleMs = spec.settleMs ?? 0
		pv("settleMs", spec.settleMs !== undefined)
	} else {
		const markerSupported = ctx.measured.markerSupported[source.id] ?? null
		const marker = s.sweep.markers && markerSupported !== false
		const measured = ctx.measured.settleMs[source.link]
		if (spec.settleMs !== undefined) settleMs = spec.settleMs
		else if (marker) settleMs = MARKER_RUN_ASSUMED_MS + s.sweep.pllSettleMs
		else settleMs = measured ?? s.sweep.settleMs[source.link]
		pv(
			"settleMs",
			spec.settleMs !== undefined,
			!marker && measured !== null ? "measured" : "default",
		)
		if (!marker)
			issues.push(
				issue(
					"settle-timer",
					"warning",
					`timer settle mode (${settleMs} ms) on ${source.id}`,
					{ settleMs },
				),
			)
		const unmeasured = marker ? markerSupported === null : measured === null
		if (spec.settleMs === undefined && unmeasured) {
			issues.push(
				issue(
					"settle-unmeasured",
					"warning",
					`settle behaviour of ${source.id} is not measured yet`,
					{ link: source.link },
				),
			)
		}
	}
	const minimumDwell =
		settleMs + (s.detection.minSurfaceBlocks + 1) * integrationMs
	const dwellMs = spec.dwellMs ?? minimumDwell
	pv("dwellMs", spec.dwellMs !== undefined)
	if (mode === "sweep" && dwellMs < minimumDwell) {
		issues.push(
			issue(
				"dwell-too-short",
				"error",
				`dwell ${dwellMs} ms is below settle + ${s.detection.minSurfaceBlocks + 1} blocks (${minimumDwell} ms)`,
				{ minimumMs: minimumDwell },
			),
		)
	}
	if (mode === "sweep") {
		for (let i = 0; i < ranges.length; i++) {
			const range = ranges[i]
			if (
				range === undefined ||
				!isRangeEnabled(range) ||
				range.dwellMs === undefined ||
				range.dwellMs >= minimumDwell
			)
				continue
			issues.push(
				issue(
					"dwell-too-short",
					"error",
					`range ${i} dwell ${range.dwellMs} ms is below settle + ${s.detection.minSurfaceBlocks + 1} blocks (${minimumDwell} ms)`,
					{ minimumMs: minimumDwell, rangeIndex: i },
				),
			)
		}
	}

	// Protocols, holds, probes.
	const fromPlans = unique(enabled.flatMap(r => r.protocols ?? []))
	const protocols =
		spec.protocols !== undefined ? [...spec.protocols] : fromPlans
	prov["protocols"] =
		spec.protocols !== undefined
			? "operator"
			: fromPlans.length > 0
				? "bandplan"
				: "default"
	const policy = spec.hold?.policy ?? "hold"
	pv("hold.policy", spec.hold?.policy !== undefined)
	const confirmHoldMs: Partial<Record<ScannerClass, number>> = {}
	for (const c of ALL_CLASSES)
		confirmHoldMs[c] = spec.hold?.confirmHoldMs ?? DEFAULT_CONFIRM_HOLD_MS[c]
	pv("hold.confirmHoldMs", spec.hold?.confirmHoldMs !== undefined)
	const maxHoldMs = spec.hold?.maxHoldMs ?? s.hold.maxHoldMs
	pv("hold.maxHoldMs", spec.hold?.maxHoldMs !== undefined)
	const hangMs = spec.hold?.hangMs ?? s.hold.hangMs
	pv("hold.hangMs", spec.hold?.hangMs !== undefined)
	const relevant = decodableClasses(
		protocols,
		source.format,
		ctx.channelizerAvailable,
	)
	const neededHold = relevant.reduce(
		(m, c) => Math.max(m, confirmHoldMs[c] ?? 0),
		0,
	)
	if (policy !== "never" && maxHoldMs < neededHold) {
		issues.push(
			issue(
				"hold-inconsistent",
				"error",
				`maxHoldMs ${maxHoldMs} is below confirmHoldMs ${neededHold}`,
				{ maxHoldMs, confirmHoldMs: neededHold },
			),
		)
	}
	const unavailable: Record<string, string> = {}
	let needsProbe = 0
	let withTransport = 0
	for (const p of spec.protocols ?? []) {
		const t = probeTransportFor(p, source.format, ctx.channelizerAvailable)
		if (t.reason === "no-decoder") continue
		needsProbe++
		if (t.transport !== null) withTransport++
		else unavailable[p] = t.reason ?? "unsupported-format"
	}
	const requestedProtocols = spec.protocols ?? []
	if (
		needsProbe > 0 &&
		withTransport === 0 &&
		needsProbe === requestedProtocols.length
	) {
		issues.push(
			issue(
				"no-probe-transport",
				"error",
				`no requested protocol can be confirmed on ${source.id}`,
				{ protocols: unavailable },
			),
		)
	} else if (Object.keys(unavailable).length > 0) {
		issues.push(
			issue(
				"probe-unavailable",
				"warning",
				"some requested protocols have no probe transport",
				{ protocols: unavailable },
			),
		)
	}
	if (mode === "sweep" && source.role === "shared") {
		const dedicated = ctx.sources
			.filter(
				o =>
					o.id !== source.id &&
					o.role === "dedicated" &&
					o.controllable &&
					IQ_FORMATS.includes(o.format),
			)
			.map(o => o.id)
		if (dedicated.length > 0)
			issues.push(
				issue(
					"dedicated-available",
					"warning",
					`a dedicated receiver is available: ${dedicated.join(", ")}`,
					{ sourceIds: dedicated },
				),
			)
	}

	pv("revisit.share", spec.revisit?.share !== undefined)
	pv("revisit.maxIntervalMs", spec.revisit?.maxIntervalMs !== undefined)
	pv("priority", spec.priority !== undefined)
	pv("resume.autoAfterIdleMs", spec.resume?.autoAfterIdleMs !== undefined)
	pv("txDurationHintMs", spec.txDurationHintMs !== undefined)
	pv("kind", spec.kind !== undefined)
	pv("capture", spec.capture !== undefined)
	for (let i = 0; i < ranges.length; i++) {
		const range = ranges[i]
		if (range === undefined) continue
		if (range.name !== undefined) prov[`ranges[${i}].name`] = "operator"
		if (range.dwellMs !== undefined) prov[`ranges[${i}].dwellMs`] = "operator"
		if (range.sensitivity !== undefined)
			prov[`ranges[${i}].sensitivity`] = "operator"
	}
	const kind = spec.kind ?? "discover"
	if (spec.signalsOnly !== undefined) prov["signalsOnly"] = "operator"
	if (spec.skipDecodedElsewhere !== undefined)
		prov["skipDecodedElsewhere"] = "operator"
	if (kind === "monitor" && spec.signalsOnly === true) {
		issues.push(
			issue("signals-only-unsupported", "error", "monitor jobs need decoders"),
		)
	}

	const n: NormalisedJobSpec = {
		sourceId: source.id,
		sensitivity,
		priority: spec.priority ?? DEFAULT_PRIORITY,
		mode,
		kind,
		ranges,
		exclusions,
		protocols,
		fftSize,
		integrationMs,
		thresholdDb,
		dwellMs,
		settleMs,
		hold: { policy, confirmHoldMs, maxHoldMs, hangMs },
		revisit: {
			share: spec.revisit?.share ?? s.sweep.revisitShare,
			maxIntervalMs: spec.revisit?.maxIntervalMs ?? null,
		},
		record: {
			voice: spec.record?.voice ?? true,
			analog: spec.record?.analog ?? true,
			data: spec.record?.data ?? true,
		},
		evidence: {
			psd: spec.evidence?.psd ?? true,
			iq: spec.evidence?.iq ?? false,
		},
		tuner: {
			sampleRateHz: spec.tuner?.sampleRateHz ?? null,
			gainTenthsDb: spec.tuner?.gainTenthsDb ?? null,
			agc: spec.tuner?.agc ?? null,
			overload: spec.tuner?.overload ?? "flag",
		},
		stop: {
			afterSweeps: spec.stop?.afterSweeps ?? null,
			afterMs: spec.stop?.afterMs ?? null,
			onFirstDecoded: spec.stop?.onFirstDecoded ?? false,
		},
		takeover: spec.takeover ?? false,
		resume: {
			autoAfterIdleMs:
				spec.resume?.autoAfterIdleMs === undefined
					? DEFAULT_AUTO_RESUME_MS
					: spec.resume.autoAfterIdleMs,
			onBoot: spec.resume?.onBoot ?? false,
		},
		txDurationHintMs: spec.txDurationHintMs ?? DEFAULT_TX_HINT_MS,
		capture: normaliseCapture(spec.capture),
		provenance: prov,
	}
	if (spec.signalsOnly !== undefined) n.signalsOnly = spec.signalsOnly
	if (spec.skipDecodedElsewhere !== undefined)
		n.skipDecodedElsewhere = spec.skipDecodedElsewhere
	return { spec: n, source, issues }
}

/**
 * The only hop-plan function: preview, create, PATCH and re-plan all call it (P15). `extra` adds
 * runtime exclusions (WG2 lockouts) to the spec's own for this plan only; the spec is not changed.
 */
export function planForSpec(
	spec: NormalisedJobSpec,
	ctx: PreviewContext,
	extra: readonly ScanExclusion[] = [],
): HopPlan {
	const source = findSource(spec.sourceId, ctx)
	const fs =
		spec.mode === "sweep"
			? (spec.tuner.sampleRateHz ?? source.sampleRateHz)
			: source.sampleRateHz
	const input: HopPlanInput = {
		ranges: spec.ranges.filter(isRangeEnabled),
		exclusions:
			extra.length === 0 ? spec.exclusions : [...spec.exclusions, ...extra],
		sampleRateHz: fs,
		usableFraction: ctx.usableFraction,
		rbwHz: fs / spec.fftSize,
		dcGuardHz: ctx.settings.detection.dcGuardHz,
		ppmMargin: ctx.settings.detection.ppmMargin,
		tunerRange: ctx.tunerRange(source.id),
	}
	const planned =
		spec.mode === "sweep"
			? planHops(input)
			: inWindowPlan(source.centreHz, input, fs, ctx.usableFraction)
	return spec.mode === "sweep" ? withHopDwell(planned, spec) : planned
}

/**
 * WG2 req 12: the job's plan with the lockout exclusions of its source. Sweep jobs only;
 * `lockoutExclusions` is absent for in-window jobs and when the source has no lockout inside the
 * job's enabled ranges, so plans and previews without lockouts are unchanged.
 *
 * WG6 req 1: `decodedElsewhere` lists the ranges other decoders cover (absent when none);
 * `decodedElsewhereIssues` carries its warnings (absent when none). With `skipDecodedElsewhere`
 * on a sweep job the ranges join the lockouts as exclusions unless that would empty the plan.
 */
export function planJob(
	spec: NormalisedJobSpec,
	ctx: PreviewContext,
): {
	plan: HopPlan
	lockoutExclusions?: LockoutExclusion[]
	decodedElsewhere?: DecodedElsewhereRange[]
	decodedElsewhereIssues?: PlanIssue[]
} {
	const decoded = decodedElsewhereFor(spec, ctx)
	const targets =
		spec.mode === "sweep" ? ctx.lockouts?.(spec.sourceId) : undefined
	const candidates =
		targets === undefined || targets.length === 0
			? []
			: lockoutExclusionsFor(targets, spec.ranges.filter(isRangeEnabled))
	const skip =
		spec.mode === "sweep" &&
		spec.skipDecodedElsewhere === true &&
		decoded.ranges.length > 0
	const issues = decoded.issues
	// Today's plan (lockouts by their own rule) is computed first so the flag never changes
	// which lockouts apply; decoded ranges are layered on top only when hops remain.
	const base: { plan: HopPlan; lockoutExclusions?: LockoutExclusion[] } =
		candidates.length === 0
			? { plan: planForSpec(spec, ctx) }
			: planWithLockouts(extra => planForSpec(spec, ctx, extra), candidates)
	let result = base
	let applied = false
	if (skip) {
		const locked: ScanExclusion[] = (base.lockoutExclusions ?? [])
			.filter(x => x.applied)
			.map(x => ({ startHz: x.startHz, endHz: x.endHz }))
		const decodedEx: ScanExclusion[] = decoded.ranges.map(r => ({
			startHz: r.startHz,
			endHz: r.endHz,
		}))
		const plan = planForSpec(spec, ctx, [...locked, ...decodedEx])
		if (plan.hops.length > 0 || base.plan.hops.length === 0) {
			applied = true
			result = { ...base, plan }
		} else {
			issues.push(
				issue(
					"decoded-elsewhere-not-applied",
					"warning",
					"skipping the ranges decoded elsewhere would leave no hop; none were skipped",
					{ ranges: decoded.ranges.length },
				),
			)
		}
	}
	return {
		...result,
		...(decoded.ranges.length > 0
			? { decodedElsewhere: decoded.ranges.map(r => ({ ...r, applied })) }
			: {}),
		...(issues.length > 0 ? { decodedElsewhereIssues: issues } : {}),
	}
}

/**
 * WG6 req 1.8: the decoder view is read at most once per plan; a throwing or non-array view
 * means none.
 */
function decodedElsewhereFor(
	spec: NormalisedJobSpec,
	ctx: PreviewContext,
): { ranges: DecodedElsewhereRange[]; issues: PlanIssue[] } {
	if (ctx.decoderCoverage === undefined) return { ranges: [], issues: [] }
	let r: ReturnType<typeof computeDecodedElsewhere>
	try {
		const views: unknown = ctx.decoderCoverage()
		if (!Array.isArray(views) || views.length === 0)
			return { ranges: [], issues: [] }
		r = computeDecodedElsewhere(views as readonly DecoderCoverageView[], spec)
	} catch {
		return { ranges: [], issues: [] }
	}
	const issues: PlanIssue[] = []
	if (r.truncated)
		issues.push(
			issue(
				"decoded-elsewhere-truncated",
				"warning",
				"too many decoders, targets or ranges: the decoded-elsewhere list is incomplete",
			),
		)
	return { ranges: r.ranges, issues }
}

/** In-window jobs ignore per-range dwell, the same way they ignore the job dwell. */
function inWindowPlan(
	centreHz: number | null,
	input: HopPlanInput,
	fs: number,
	usableFraction: number,
): HopPlan {
	const half = (fs * usableFraction) / 2
	const g = Math.max(input.dcGuardHz, 2 * input.rbwHz)
	if (centreHz === null)
		return { hops: [], usableHalfSpanHz: half, dcGuardHz: g, ppmMarginHz: 0 }
	return {
		hops: [describeHop(0, centreHz, input)],
		usableHalfSpanHz: half,
		dcGuardHz: g,
		ppmMarginHz: input.ppmMargin * 1e-6 * centreHz,
	}
}

/**
 * A hop dwells for the longest overlapping enabled range that sets `dwellMs`,
 * using the job dwell for an overlapping range that does not. The key stays
 * absent when no overlapping enabled range sets one, so plans without per-range
 * dwell are unchanged.
 */
function withHopDwell(plan: HopPlan, spec: NormalisedJobSpec): HopPlan {
	const ranges = spec.ranges.filter(isRangeEnabled)
	if (!ranges.some(r => r.dwellMs !== undefined)) return plan
	let changed = false
	const hops = plan.hops.map(hop => {
		const overlapping = ranges.filter(
			r => r.endHz >= hop.covered.startHz && r.startHz <= hop.covered.endHz,
		)
		if (!overlapping.some(r => r.dwellMs !== undefined)) return hop
		changed = true
		return {
			...hop,
			dwellMs: Math.max(...overlapping.map(r => r.dwellMs ?? spec.dwellMs)),
		}
	})
	return changed ? { ...plan, hops } : plan
}

function sweepPeriod(
	hops: readonly Hop[],
	dwellMs: number,
	share: number,
): number {
	const count = hops.length
	const every = share > 0 ? Math.max(1, Math.round(1 / share)) : Infinity
	const revisits = Number.isFinite(every) ? Math.floor(count / every) : 0
	// No hop dwell: exactly the pre-SF1 formula, so previews stay byte-identical (R1 finding 3).
	if (count === 0 || hops.every(hop => hop.dwellMs === undefined))
		return (count + revisits) * dwellMs
	let sum = 0
	for (const hop of hops) sum += hop.dwellMs ?? dwellMs
	return sum + revisits * (sum / count)
}

function poiFor(
	hop: Hop,
	n: NormalisedJobSpec,
	periodMs: number | null,
	source: PreviewSourceView,
	channelizer: boolean,
): PlanPreview["poi"][number] {
	const T = n.integrationMs
	const D = n.txDurationHintMs
	const classes = decodableClasses(
		protocolsForHop(n, hop),
		source.format,
		channelizer,
	)
	const confirm =
		classes.length > 0
			? classes.reduce(
					(m, c) =>
						Math.max(m, n.hold.confirmHoldMs[c] ?? DEFAULT_CONFIRM_HOLD_MS[c]),
					0,
				)
			: null
	if (periodMs === null) {
		return {
			hopIndex: hop.index,
			detection: D >= 2 * T ? 1 : 0,
			decode: confirm !== null && D >= confirm ? 1 : 0,
		}
	}
	// WG1 req 8.2: a hop with its own (per-range) dwell listens for that long.
	const d = (hop.dwellMs ?? n.dwellMs) - n.settleMs
	return {
		hopIndex: hop.index,
		detection: Math.min(1, Math.max(0, D + d - 2 * T) / periodMs),
		decode:
			confirm === null
				? 0
				: Math.min(1, Math.max(0, D - confirm + d) / periodMs),
	}
}

function estimate(
	n: NormalisedJobSpec,
	source: PreviewSourceView,
	ctx: PreviewContext,
): PlanPreview["estimates"] {
	const s = ctx.settings
	const candidates = n.protocols.length > 0 ? n.protocols : ALL_PROTOCOLS
	const usable: { decoder: DecoderType; transport: "offset" | "channel" }[] = []
	for (const p of candidates) {
		const decoder = PROTOCOL_DECODER[p]
		const t = probeTransportFor(
			p,
			source.format,
			ctx.channelizerAvailable,
		).transport
		if (decoder !== null && t !== null) usable.push({ decoder, transport: t })
	}
	if (usable.length === 0)
		return { cpuCores: CPU_COST.engine, diskMbPerHour: 0, probes: 0 }
	const channel = usable.some(u => u.transport === "channel")
	const probes = channel ? s.maxProbes.channel : s.maxProbes.offset
	const decoders = unique(usable.map(u => u.decoder))
	const perProbe = decoders.reduce(
		(m, d) => Math.max(m, probeCores(channel ? "channel" : "offset", d)),
		0,
	)
	const voice =
		n.record.voice && decoders.includes("dsd-fme")
			? probes * VOICE_WAV_MB_PER_HOUR
			: 0
	const iq = n.evidence.iq
		? probes * CONFIRMS_PER_PROBE_HOUR * IQ_SNIPPET_MB
		: 0
	return {
		cpuCores: Math.round((CPU_COST.engine + probes * perProbe) * 1000) / 1000,
		diskMbPerHour: Math.round((voice + iq) * 10) / 10,
		probes,
	}
}

export function previewPlan(
	spec: StoredScanJobSpec,
	ctx: PreviewContext,
): PlanPreview {
	const { spec: n, source, issues } = normaliseSpec(spec, ctx)
	const { plan, lockoutExclusions, decodedElsewhere, decodedElsewhereIssues } =
		planJob(n, ctx)
	if (decodedElsewhereIssues) issues.push(...decodedElsewhereIssues)
	const s = ctx.settings
	const explained = issues.some(i => PLAN_EMPTY_CAUSES.has(i.code))
	if (n.mode === "sweep" && plan.hops.length === 0 && !explained) {
		issues.push(
			issue(
				"plan-empty",
				"error",
				"the sweep plan has no hops: no channel or free span is left to scan",
			),
		)
	}
	const adjacent = plan.hops.filter(h => h.dcAdjacentChannelsHz.length > 0)
	if (adjacent.length > 0) {
		issues.push(
			issue(
				"dc-adjacent-channels",
				"warning",
				`${adjacent.length} hop(s) have channels within g + m of DC`,
				{
					hops: adjacent.map(h => ({
						index: h.index,
						channelsHz: h.dcAdjacentChannelsHz,
					})),
				},
			),
		)
	}
	const sweepPeriodMs =
		n.mode === "sweep" && plan.hops.length > 1
			? sweepPeriod(plan.hops, n.dwellMs, n.revisit.share)
			: null
	const poi = plan.hops.map(h =>
		poiFor(h, n, sweepPeriodMs, source, ctx.channelizerAvailable),
	)
	const low = poi.filter(p => p.detection < POI_LOW)
	if (low.length > 0) {
		issues.push(
			issue(
				"poi-low",
				"warning",
				`detection POI below ${POI_LOW * 100} % for a ${n.txDurationHintMs} ms transmission`,
				{
					hops: low.map(p => p.hopIndex),
					txDurationHintMs: n.txDurationHintMs,
				},
			),
		)
	}
	const estimates = estimate(n, source, ctx)
	if (estimates.cpuCores > s.cpuBudgetCores) {
		issues.push(
			issue(
				"budget-cpu",
				"warning",
				`estimated ${estimates.cpuCores} cores exceeds the ${s.cpuBudgetCores} core budget`,
				{ cpuCores: estimates.cpuCores },
			),
		)
	}
	if (estimates.diskMbPerHour * DISK_BUDGET_HOURS > s.storage.maxRecordingsMb) {
		issues.push(
			issue(
				"budget-disk",
				"warning",
				`${estimates.diskMbPerHour} MB/h fills the ${s.storage.maxRecordingsMb} MB recordings cap in under ${DISK_BUDGET_HOURS} h`,
				{ diskMbPerHour: estimates.diskMbPerHour },
			),
		)
	}
	const impact =
		n.mode === "sweep" ? ctx.impactFor(source.id, n) : emptyImpact()
	if (impact.unrestorable.length > 0) {
		issues.push(
			issue(
				"unrestorable",
				"warning",
				`pre-job value unknown for: ${impact.unrestorable.join(", ")}`,
				{ fields: impact.unrestorable },
			),
		)
	}
	return {
		spec: n,
		plan,
		sweepPeriodMs,
		poi,
		estimates,
		impact,
		issues,
		...(lockoutExclusions ? { lockoutExclusions } : {}),
		...(decodedElsewhere ? { decodedElsewhere } : {}),
	}
}

/** Inverse of normaliseSpec for create/PATCH round trips, preserving protocol override intent. */
export function toJobSpec(n: NormalisedJobSpec): ScanJobSpec {
	const holds = Object.values(n.hold.confirmHoldMs)
	const first = holds[0]
	const uniform =
		n.provenance["hold.confirmHoldMs"] === "operator" &&
		first !== undefined &&
		holds.every(v => v === first)
	const out: ScanJobSpec = {
		sourceId: n.sourceId,
		mode: n.mode,
		kind: n.kind,
		ranges: n.ranges.map(copyRange),
		exclusions: n.exclusions.map(x => ({ ...x })),
		sensitivity: n.sensitivity,
		fftSize: n.fftSize,
		integrationMs: n.integrationMs,
		dwellMs: n.dwellMs,
		settleMs: n.settleMs,
		hold: {
			policy: n.hold.policy,
			maxHoldMs: n.hold.maxHoldMs,
			hangMs: n.hold.hangMs,
		},
		revisit: { share: n.revisit.share },
		record: { ...n.record },
		evidence: { ...n.evidence },
		tuner: { overload: n.tuner.overload },
		stop: { onFirstDecoded: n.stop.onFirstDecoded },
		priority: n.priority,
		takeover: n.takeover,
		resume: {
			autoAfterIdleMs: n.resume.autoAfterIdleMs,
			onBoot: n.resume.onBoot,
		},
		txDurationHintMs: n.txDurationHintMs,
		capture: { ...n.capture },
	}
	if (n.provenance["protocols"] === "operator") out.protocols = [...n.protocols]
	if (uniform && out.hold && first !== undefined) out.hold.confirmHoldMs = first
	if (n.revisit.maxIntervalMs !== null && out.revisit)
		out.revisit.maxIntervalMs = n.revisit.maxIntervalMs
	if (out.tuner) {
		if (n.tuner.sampleRateHz !== null)
			out.tuner.sampleRateHz = n.tuner.sampleRateHz
		if (n.tuner.gainTenthsDb !== null)
			out.tuner.gainTenthsDb = n.tuner.gainTenthsDb
		if (n.tuner.agc !== null) out.tuner.agc = n.tuner.agc
	}
	if (out.stop) {
		if (n.stop.afterSweeps !== null) out.stop.afterSweeps = n.stop.afterSweeps
		if (n.stop.afterMs !== null) out.stop.afterMs = n.stop.afterMs
	}
	if (n.thresholdDb !== null) out.thresholdDb = n.thresholdDb
	if (n.signalsOnly !== undefined) out.signalsOnly = n.signalsOnly
	if (n.skipDecodedElsewhere !== undefined)
		out.skipDecodedElsewhere = n.skipDecodedElsewhere
	return out
}
