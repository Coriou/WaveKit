/**
 * "Scan a band" in setup mode, pure (docs/web/DESIGN.md, Scanner UX review and second pass; canvas ScanPlanner):
 * presets from the core's scanner band plans, ranges from a band or a dragged stretch, channel spacing from the
 * band-plan rasters, skips, options, and the job spec sent to POST /api/scanner/plan and /api/scanner/jobs.
 */
import { BANDPLANS_LIMITS } from "@wavekit/api-types"
import type {
	Bandplan,
	DisplayGroup,
	Impact,
	PlanPreview,
	PresetRange,
	Raster,
	ScanExclusion,
	ScanJobSpec,
	ScannerProtocol,
	ScanPresetJob,
	ScanPresetView,
	ScanRange,
} from "@wavekit/api-types"

import { protocolName } from "../../../data/scanner-format.ts"
import { formatMHz } from "../../format.ts"

// ---- model

export interface PlanRange {
	/** Local key (stable while the plan is open). */
	readonly key: string
	/** The preset (scanner band plan id) the range came from, else null (a band of a lane, or drawn). */
	readonly preset: string | null
	readonly name: string
	readonly startHz: number
	readonly endHz: number
	/** Channel spacings in Hz, widest first; empty is "Any". */
	readonly spacingHz: readonly number[]
	/** The band plan's spacings ("Use the band plan" and the changed dot). */
	readonly planSpacingHz: readonly number[]
	/** The band plan's rasters, for their first channel. */
	readonly planRasters: readonly Raster[]
	readonly protocols: readonly ScannerProtocol[]
	readonly obwHz?: readonly number[]
	/** Sent only while the edges are the plan's own. */
	readonly bandplanId?: string
	readonly planEdges?: { readonly startHz: number; readonly endHz: number }
}

export interface PlanSkip {
	readonly key: string
	readonly startHz: number
	readonly endHz: number
	readonly reason?: string
}

export type StopAfter = "never" | "pass" | "10m" | "1h"
export type Sensitivity = "low" | "normal" | "high"

export interface PlanOptions {
	readonly sensitivity: Sensitivity
	/** Hold on activity (hold.policy "hold"), else "never". */
	readonly hold: boolean
	/** Record calls (record.voice and record.analog). */
	readonly record: boolean
	readonly stopAfter: StopAfter
	/** "Just find signals": no decoder trials. */
	readonly signalsOnly: boolean
	/** Skip what decodes elsewhere (exclusions from decoders already covering a channel). */
	readonly skipDecodedElsewhere: boolean
}

export const DEFAULT_OPTIONS: PlanOptions = {
	sensitivity: "normal",
	hold: true,
	record: true,
	stopAfter: "never",
	signalsOnly: false,
	skipDecodedElsewhere: true,
}

export interface PlanDraft {
	/** Sorted by frequency (tags read 1, 2, 3 on the ruler). */
	readonly ranges: readonly PlanRange[]
	readonly skips: readonly PlanSkip[]
	readonly options: PlanOptions
}

export const EMPTY_DRAFT: PlanDraft = {
	ranges: [],
	skips: [],
	options: DEFAULT_OPTIONS,
}

/** What the tuner reaches (R820T, about 24–1766 MHz). */
export const TUNER_LIMITS_HZ = { lo: 24_000_000, hi: 1_766_000_000 } as const

let keySeq = 0
/** A fresh local key. */
export function newKey(prefix: string): string {
	keySeq += 1
	return `${prefix}${keySeq}`
}

// ---- protocols (S1 trials; AIS, ACARS, VDL2 and LoRa are dedicated decoders, not trials: CORE-GAPS)

export interface ProtocolChoice {
	readonly label: string
	readonly ids: readonly ScannerProtocol[]
}

export const PROTOCOL_CHOICES: readonly ProtocolChoice[] = [
	{ label: "DMR", ids: ["dmr"] },
	{ label: "P25", ids: ["p25p1", "p25p2"] },
	{ label: "NXDN", ids: ["nxdn48", "nxdn96"] },
	{ label: "dPMR", ids: ["dpmr"] },
	{ label: "YSF", ids: ["ysf"] },
	{ label: "D-STAR", ids: ["dstar"] },
	{ label: "FM voice", ids: ["analog-fm"] },
	{ label: "AM voice", ids: ["analog-am"] },
	{ label: "POCSAG", ids: ["pocsag"] },
	{ label: "FLEX", ids: ["flex"] },
	{ label: "APRS", ids: ["aprs"] },
	{ label: "ISM", ids: ["ism"] },
]

/** Display names of a protocol list, deduplicated (p25p1 + p25p2 read "P25"), in the choices' order. */
export function protocolLabels(protocols: readonly string[]): string[] {
	const names = new Set(protocols.map(p => protocolName(p)))
	const ordered = PROTOCOL_CHOICES.map(c => c.label).filter(l => names.has(l))
	for (const n of names) if (!ordered.includes(n)) ordered.push(n)
	return ordered
}

export function choiceOn(
	protocols: readonly ScannerProtocol[],
	choice: ProtocolChoice,
): boolean {
	return choice.ids.some(id => protocols.includes(id))
}

/** Toggles one choice (all of its ids) in a protocol list, keeping the choices' order. */
export function toggleChoice(
	protocols: readonly ScannerProtocol[],
	choice: ProtocolChoice,
): ScannerProtocol[] {
	const on = choiceOn(protocols, choice)
	const rest = protocols.filter(p => !choice.ids.includes(p))
	if (on) return rest
	const next = new Set([...rest, ...choice.ids])
	const order = PROTOCOL_CHOICES.flatMap(c => c.ids)
	return [
		...order.filter(p => next.has(p)),
		...[...next].filter(p => !order.includes(p)),
	]
}

// ---- words

/** "Airband (8.33 / 25 kHz)" → "Airband": the chip and row name of a band plan. */
export function shortPlanName(name: string): string {
	const s = name.replace(/\s*\([^)]*\)\s*$/, "").trim()
	return s || name
}

/** "12.5", "6.25", "8.33" (kHz, two decimals at most). */
export const kHz = (hz: number): string => String(+(hz / 1000).toFixed(2))

/** "12.5 kHz", "12.5 + 6.25", "Any". */
export function spacingText(spacingHz: readonly number[]): string {
	if (spacingHz.length === 0 || spacingHz.includes(0)) return "Any"
	const sorted = [...spacingHz].sort((a, b) => b - a)
	if (sorted.length === 1) return `${kHz(sorted[0] ?? 0)} kHz`
	return sorted.map(kHz).join(" + ")
}

export function sameSpacing(
	a: readonly number[],
	b: readonly number[],
): boolean {
	return a.length === b.length && a.every(v => b.includes(v))
}

/** "146.000–174.000". */
export function edgesText(startHz: number, endHz: number): string {
	return `${formatMHz(startHz)}–${formatMHz(endHz)}`
}

/** "MHz" text field value: "146", "156.025". */
export function mhzField(hz: number): string {
	return String(+(hz / 1e6).toFixed(6))
}

/** A typed MHz edge ("156,025" too) in Hz, or null. */
export function parseMHz(text: string): number | null {
	const v = Number.parseFloat(text.trim().replace(",", "."))
	return Number.isFinite(v) && v > 0 ? Math.round(v * 1e6) : null
}

/** A core message as a sentence: "every range is disabled" → "Every range is disabled". */
export function sentence(text: string): string {
	const t = text.trim()
	return t ? t.charAt(0).toUpperCase() + t.slice(1) : t
}

function andText(items: readonly string[]): string {
	if (items.length < 2) return items.join("")
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`
}

/** "Land mobile + Marine", "Airband", "3 ranges": the plan's name. */
export function planName(ranges: readonly PlanRange[]): string {
	const names = [...new Set(ranges.map(r => r.name))]
	if (names.length === 0) return "Scan"
	if (names.length <= 2) return names.join(" + ")
	return `${names[0] ?? ""} + ${names.length - 1} more`
}

// ---- presets (the core's scan presets: yours first, then the region's built-ins; the scanner band plans without it)

export interface Preset {
	readonly id: string
	/** Chip text. */
	readonly label: string
	/** Full name (tooltip). */
	readonly name: string
	readonly ranges: readonly ScanRange[]
	/** An operator preset (stored in core, yours to update or delete). */
	readonly user?: true
	/** The scanner band plans it scans by id (a built-in, or a saved preset that kept a plan whole). */
	readonly bandplans: readonly string[]
	/** Skips it adds (operator presets). */
	readonly skips?: readonly ScanExclusion[]
	/** Sensitivity it sets (operator presets), when not the default. */
	readonly sensitivity?: Sensitivity
	/** What the core keeps of it, to update it with the same job (operator presets). */
	readonly job?: ScanPresetJob
	/** Band plans it names that this WaveKit does not scan. */
	readonly missing?: readonly string[]
}

/** Pieces of one plan closer than this read as one range (CB's 40 channels, paging around 169 MHz). */
const JOIN_GAP_HZ = 100_000

function joinRanges(ranges: readonly ScanRange[]): ScanRange[] {
	const sorted = [...ranges].sort((a, b) => a.startHz - b.startHz)
	const out: ScanRange[] = []
	for (const r of sorted) {
		const last = out[out.length - 1]
		if (last && r.startHz - last.endHz <= JOIN_GAP_HZ)
			out[out.length - 1] = { ...last, endHz: Math.max(last.endHz, r.endHz) }
		else out.push({ ...r })
	}
	return out
}

/** One preset per scanner band plan, in the core's order (the fallback when the core lists no presets). */
export function presetsOf(bandplans: readonly Bandplan[] | null): Preset[] {
	return (bandplans ?? [])
		.filter(p => p.ranges.length > 0)
		.map(p => ({
			id: p.id,
			label: shortPlanName(p.name),
			name: p.name,
			ranges: joinRanges(p.ranges),
			bandplans: [p.id],
		}))
}

/** The ranges of some scanner band plans (each plan joined on its own, so a combination repeats its plans' ranges). */
function planRanges(
	ids: readonly string[],
	bandplans: readonly Bandplan[],
): { ranges: ScanRange[]; missing: string[] } {
	const ranges: ScanRange[] = []
	const missing: string[] = []
	for (const id of ids) {
		const plan = bandplans.find(p => p.id === id)
		if (!plan || plan.ranges.length === 0) missing.push(id)
		else
			ranges.push(
				...joinRanges(plan.ranges).map(r => ({
					...r,
					name: shortPlanName(plan.name),
				})),
			)
	}
	return { ranges, missing }
}

/** A saved range's name: the band it lies in, else its edges (the core keeps no range names: CORE-GAPS). */
export type RangeNamer = (startHz: number, endHz: number) => string | undefined

/**
 * The preset list of "Scan a band": operator presets first (newest first), then the built-ins in the core's order.
 * Without the core's list, one preset per scanner band plan.
 */
export function presetsFrom(
	list: readonly ScanPresetView[] | null,
	bandplans: readonly Bandplan[] | null,
	nameOf: RangeNamer = () => undefined,
): Preset[] {
	if (list === null) return presetsOf(bandplans)
	const plans = bandplans ?? []
	const out: Preset[] = []
	const users = list
		.flatMap(v => (v.preset.kind === "operator" ? [v.preset] : []))
		.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
	for (const p of users) {
		const fromPlans = planRanges(p.job.bandplans, plans)
		const own = p.job.ranges.map(
			(r): ScanRange => ({
				startHz: r.startHz,
				endHz: r.endHz,
				name: nameOf(r.startHz, r.endHz) ?? edgesText(r.startHz, r.endHz),
				rasters: r.rasters.map(x => ({ ...x })),
				...(r.obwHz.length > 0 ? { obwHz: [...r.obwHz] } : {}),
				protocols: [
					...(r.protocols.length > 0 ? r.protocols : p.job.protocols),
				],
			}),
		)
		out.push({
			id: p.id,
			label: p.name,
			name: p.name,
			user: true,
			ranges: [...fromPlans.ranges, ...own].sort(
				(a, b) => a.startHz - b.startHz,
			),
			bandplans: [...p.job.bandplans],
			skips: p.job.exclusions.map(x => ({
				startHz: x.startHz,
				endHz: x.endHz,
				...(x.reason !== null ? { reason: x.reason } : {}),
			})),
			...(p.job.sensitivity !== null && p.job.sensitivity !== "normal"
				? { sensitivity: p.job.sensitivity }
				: {}),
			job: p.job,
			...(fromPlans.missing.length > 0 ? { missing: fromPlans.missing } : {}),
		})
	}
	for (const v of list) {
		const p = v.preset
		if (p.kind !== "builtin") continue
		const { ranges } = planRanges(p.job.bandplans, plans)
		if (ranges.length === 0) continue
		out.push({
			id: p.id,
			label: shortPlanName(p.name),
			name: p.name,
			ranges,
			bandplans: [...p.job.bandplans],
		})
	}
	return out
}

function spacingsOf(rasters: readonly Raster[] | undefined): number[] {
	return [...new Set((rasters ?? []).map(r => Math.round(r.spacingHz)))].sort(
		(a, b) => b - a,
	)
}

function fromScanRange(
	r: ScanRange,
	name: string,
	preset: string | null,
): PlanRange {
	const spacing = spacingsOf(r.rasters)
	const out: PlanRange = {
		key: newKey("r"),
		preset,
		name,
		startHz: r.startHz,
		endHz: r.endHz,
		spacingHz: spacing,
		planSpacingHz: spacing,
		planRasters: r.rasters ?? [],
		protocols: r.protocols ?? [],
		...(r.obwHz && r.obwHz.length > 0 ? { obwHz: r.obwHz } : {}),
		...(r.bandplanId !== undefined
			? {
					bandplanId: r.bandplanId,
					planEdges: { startHz: r.startHz, endHz: r.endHz },
				}
			: {}),
	}
	return out
}

/** The ranges a preset adds (one row per joined piece). */
export function rangesOfPreset(preset: Preset): PlanRange[] {
	const many = preset.ranges.length > 1 && preset.bandplans.length === 1
	return preset.ranges.map((r, i) =>
		fromScanRange(
			r,
			preset.user
				? (r.name ?? preset.label)
				: many
					? `${preset.label} ${i + 1}`
					: preset.bandplans.length > 1
						? (r.name ?? preset.label)
						: preset.label,
			preset.id,
		),
	)
}

export function sortRanges(ranges: readonly PlanRange[]): PlanRange[] {
	return [...ranges].sort(
		(a, b) =>
			a.startHz - b.startHz || a.endHz - b.endHz || (a.key < b.key ? -1 : 1),
	)
}

const sameEdges = (
	a: { startHz: number; endHz: number },
	b: { startHz: number; endHz: number },
) => a.startHz === b.startHz && a.endHz === b.endHz

const sameList = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && [...a].sort().join() === [...b].sort().join()

/** A plan range that is a preset's range as the band plan has it: same edges, spacing and protocols. */
function sameRange(r: PlanRange, pr: ScanRange): boolean {
	return (
		sameEdges(r, pr) &&
		sameSpacing(r.spacingHz, spacingsOf(pr.rasters)) &&
		sameList(r.protocols, pr.protocols ?? [])
	)
}

/**
 * A preset is on while each of its ranges is in the plan: one it added (edited or not), or the same range another
 * preset brought (PMR446 inside Personal radio).
 */
export function presetOn(
	preset: Preset,
	ranges: readonly PlanRange[],
): boolean {
	const mine = ranges.filter(r => r.preset === preset.id).length
	const shared = preset.ranges.filter(pr =>
		ranges.some(r => r.preset !== preset.id && sameRange(r, pr)),
	).length
	return mine > 0 || shared > 0 ? mine + shared >= preset.ranges.length : false
}

/**
 * Adds a preset's ranges (a range already in the plan as is, from another preset, is not added twice; an overlap
 * with other protocols is, and the scan combines them), its skips and its sensitivity; or takes out what it added
 * when it is on.
 */
export function togglePreset(draft: PlanDraft, preset: Preset): PlanDraft {
	const skipsOf = preset.skips ?? []
	if (presetOn(preset, draft.ranges))
		return {
			...draft,
			ranges: draft.ranges.filter(r => r.preset !== preset.id),
			skips: draft.skips.filter(x => !skipsOf.some(p => sameEdges(p, x))),
		}
	const kept = draft.ranges.filter(r => r.preset !== preset.id)
	const added = rangesOfPreset(preset).filter((_, i) => {
		const pr = preset.ranges[i]
		return !pr || !kept.some(k => sameRange(k, pr))
	})
	const skips = [
		...draft.skips,
		...skipsOf
			.filter(p => !draft.skips.some(x => sameEdges(p, x)))
			.map(
				(p): PlanSkip => ({
					key: newKey("x"),
					startHz: p.startHz,
					endHz: p.endHz,
					...(p.reason ? { reason: p.reason } : {}),
				}),
			),
	].sort((x, y) => x.startHz - y.startHz)
	return {
		...draft,
		ranges: sortRanges([...kept, ...added]),
		skips,
		options: preset.sensitivity
			? { ...draft.options, sensitivity: preset.sensitivity }
			: draft.options,
	}
}

/** The operator preset the whole plan comes from (Save then offers Update), else null. */
export function userPresetOf(
	presets: readonly Preset[],
	ranges: readonly PlanRange[],
): Preset | null {
	if (ranges.length === 0) return null
	const ids = new Set(ranges.map(r => r.preset))
	if (ids.size !== 1) return null
	const p = presets.find(x => x.user && ids.has(x.id))
	return p && presetOn(p, ranges) ? p : null
}

/** A built-in preset whose ranges are all in the plan as the band plan has them (saved by id, so it follows the plan). */
function presetIntact(preset: Preset, ranges: readonly PlanRange[]): boolean {
	return preset.ranges.every(pr => ranges.some(r => sameRange(r, pr)))
}

/**
 * What "Save as preset" stores (the core's closed preset job): band plans kept whole by id, every other range with its
 * spacing and protocols, the skips and the sensitivity. Range names, Hold, Record, Stop after and the trial options
 * have no place in it (CORE-GAPS).
 */
export function presetJobOf(
	draft: PlanDraft,
	presets: readonly Preset[],
): ScanPresetJob {
	const whole = presets.filter(
		p =>
			!p.user &&
			draft.ranges.some(r => r.preset === p.id) &&
			presetIntact(p, draft.ranges),
	)
	const covered = (r: PlanRange) =>
		whole.some(p => p.ranges.some(pr => sameRange(r, pr)))
	const bandplans = [...new Set(whole.flatMap(p => p.bandplans))].slice(
		0,
		BANDPLANS_LIMITS.presetBandplans,
	)
	const ranges: PresetRange[] = draft.ranges
		.filter(r => !covered(r))
		.slice(0, BANDPLANS_LIMITS.presetRanges)
		.map(r => ({
			startHz: Math.round(r.startHz),
			endHz: Math.round(r.endHz),
			rasters: rastersOf(r).slice(0, 8),
			obwHz: [...(r.obwHz ?? [])].slice(0, 8),
			protocols: [...r.protocols],
		}))
	return {
		mode: "sweep",
		bandplans,
		ranges,
		exclusions: draft.skips
			.slice(0, BANDPLANS_LIMITS.presetExclusions)
			.map(x => ({
				startHz: Math.round(x.startHz),
				endHz: Math.round(x.endHz),
				reason: x.reason?.slice(0, 200) ?? null,
			})),
		protocols: [],
		sensitivity:
			draft.options.sensitivity === "normal" ? null : draft.options.sensitivity,
		thresholdDb: null,
		fftSize: null,
		integrationMs: null,
		dwellMs: null,
		settleMs: null,
	}
}

/** Tags the plan's ranges with a preset just saved (its chip reads on). */
export function tagRanges(draft: PlanDraft, presetId: string): PlanDraft {
	return {
		...draft,
		ranges: draft.ranges.map(r => ({ ...r, preset: presetId })),
	}
}

/**
 * The band-plan range a stretch borrows its spacing and protocols from: the narrowest scanner range that holds it,
 * else the one overlapping it most. Null when none overlaps.
 */
export function planRangeFor(
	startHz: number,
	endHz: number,
	bandplans: readonly Bandplan[] | null,
): ScanRange | null {
	const all = (bandplans ?? []).flatMap(p => p.ranges)
	const holding = all
		.filter(r => r.startHz <= startHz && r.endHz >= endHz)
		.sort((a, b) => a.endHz - a.startHz - (b.endHz - b.startHz))
	if (holding[0]) return holding[0]
	let best: ScanRange | null = null
	let bestOverlap = 0
	for (const r of all) {
		const o = Math.min(r.endHz, endHz) - Math.max(r.startHz, startHz)
		if (o > bestOverlap) {
			best = r
			bestOverlap = o
		}
	}
	return best
}

const FALLBACK_SPACING = [12_500]
const FALLBACK_PROTOCOLS: ScannerProtocol[] = ["analog-fm", "dmr", "p25p1"]

/** What a band of a display group is worth trying when no scanner plan fits it (Marine VHF inside VHF paging). */
const GROUP_PROTOCOLS: Readonly<
	Partial<Record<DisplayGroup, readonly ScannerProtocol[]>>
> = {
	marine: ["analog-fm"],
	air: ["analog-am"],
	pagers: ["pocsag", "flex"],
	amateur: ["analog-fm", "dmr", "ysf", "dstar"],
	"personal-radio": ["analog-fm", "dmr", "dpmr"],
	"ism-srd": ["ism"],
}

/** The band a stretch lies in, when it comes from (or falls in) a band of the resolved plan. */
export interface BandHint {
	readonly name?: string
	readonly stepHz?: number | null
	readonly group?: DisplayGroup
}

/**
 * A range for a stretch with no preset (a band of a lane, or one drawn on the ruler). It takes the spacing and
 * protocols of the scanner plan holding it when that plan is about its size (at least half of the plan is the
 * stretch); otherwise the band's own step and its group's protocols, then the plan's, then 12.5 kHz and FM, DMR,
 * P25.
 */
export function customRange(
	startHz: number,
	endHz: number,
	bandplans: readonly Bandplan[] | null,
	hint: BandHint = {},
): PlanRange {
	const lo = Math.round(Math.min(startHz, endHz))
	const hi = Math.round(Math.max(startHz, endHz))
	const from = planRangeFor(lo, hi, bandplans)
	const overlap = from
		? Math.max(0, Math.min(from.endHz, hi) - Math.max(from.startHz, lo))
		: 0
	const fits = from !== null && overlap >= 0.5 * (from.endHz - from.startHz)
	const planSpacing = from ? spacingsOf(from.rasters) : []
	const step = hint.stepHz && hint.stepHz > 0 ? [Math.round(hint.stepHz)] : []
	const spacing =
		fits && planSpacing.length > 0
			? planSpacing
			: step.length > 0
				? step
				: planSpacing.length > 0
					? planSpacing
					: FALLBACK_SPACING
	const groupProtocols = hint.group ? GROUP_PROTOCOLS[hint.group] : undefined
	const planProtocols = from?.protocols?.length ? from.protocols : null
	const protocols =
		(fits ? planProtocols : null) ??
		groupProtocols ??
		planProtocols ??
		FALLBACK_PROTOCOLS
	const useRasters = sameSpacing(spacing, planSpacing)
	return {
		key: newKey("r"),
		preset: null,
		name: hint.name ?? edgesText(lo, hi),
		startHz: lo,
		endHz: hi,
		spacingHz: spacing,
		planSpacingHz: spacing,
		planRasters: useRasters ? (from?.rasters ?? []) : [],
		protocols: [...protocols],
		...(fits && from?.obwHz && from.obwHz.length > 0
			? { obwHz: from.obwHz }
			: {}),
	}
}

export function addRange(draft: PlanDraft, range: PlanRange): PlanDraft {
	return { ...draft, ranges: sortRanges([...draft.ranges, range]) }
}

export function removeRange(draft: PlanDraft, key: string): PlanDraft {
	return { ...draft, ranges: draft.ranges.filter(r => r.key !== key) }
}

export function updateRange(
	draft: PlanDraft,
	key: string,
	patch: Partial<Omit<PlanRange, "key">>,
): PlanDraft {
	return {
		...draft,
		ranges: sortRanges(
			draft.ranges.map(r => (r.key === key ? { ...r, ...patch } : r)),
		),
	}
}

export function addSkip(
	draft: PlanDraft,
	startHz: number,
	endHz: number,
	reason?: string,
): PlanDraft {
	const lo = Math.round(Math.min(startHz, endHz))
	const hi = Math.round(Math.max(startHz, endHz))
	const skip: PlanSkip = {
		key: newKey("x"),
		startHz: lo,
		endHz: hi,
		...(reason ? { reason } : {}),
	}
	return {
		...draft,
		skips: [...draft.skips, skip].sort((a, b) => a.startHz - b.startHz),
	}
}

export function removeSkip(draft: PlanDraft, key: string): PlanDraft {
	return { ...draft, skips: draft.skips.filter(s => s.key !== key) }
}

/** Skips (yours or the core's) overlapping a range. */
export function skipsIn<T extends { startHz: number; endHz: number }>(
	skips: readonly T[],
	range: { startHz: number; endHz: number },
): T[] {
	return skips.filter(s => s.endHz > range.startHz && s.startHz < range.endHz)
}

/** A range's problem in words, or null. */
export function rangeError(
	r: Pick<PlanRange, "startHz" | "endHz">,
): string | null {
	if (!(r.endHz > r.startHz)) return "Low edge above high edge"
	if (r.startHz < TUNER_LIMITS_HZ.lo || r.endHz > TUNER_LIMITS_HZ.hi)
		return "Outside the tuner (24–1766 MHz)"
	return null
}

export function optionsChanged(o: PlanOptions): boolean {
	return (Object.keys(DEFAULT_OPTIONS) as (keyof PlanOptions)[]).some(
		k => o[k] !== DEFAULT_OPTIONS[k],
	)
}

// ---- the job spec

function rastersOf(r: PlanRange): Raster[] {
	return r.spacingHz
		.filter(s => s > 0)
		.map(spacingHz => {
			const plan = r.planRasters.find(
				x => Math.round(x.spacingHz) === spacingHz,
			)
			return { spacingHz, firstChannelHz: plan?.firstChannelHz ?? r.startHz }
		})
}

/** The spec of one range (edges, rasters from the spacing, protocols, the plan id while the edges are the plan's). */
export function scanRangeOf(r: PlanRange): ScanRange {
	const out: ScanRange = {
		startHz: r.startHz,
		endHz: r.endHz,
		name: r.name.slice(0, 100),
		rasters: rastersOf(r),
		protocols: [...r.protocols],
	}
	if (r.obwHz && r.obwHz.length > 0) out.obwHz = [...r.obwHz]
	if (
		r.bandplanId !== undefined &&
		r.planEdges?.startHz === r.startHz &&
		r.planEdges.endHz === r.endHz &&
		sameSpacing(r.spacingHz, r.planSpacingHz)
	)
		out.bandplanId = r.bandplanId
	return out
}

const STOP: Readonly<Record<StopAfter, ScanJobSpec["stop"] | undefined>> = {
	never: undefined,
	pass: { afterSweeps: 1 },
	"10m": { afterMs: 600_000 },
	"1h": { afterMs: 3_600_000 },
}

/** The job spec for the plan preview and the start (sweep, discover). Options only when they differ from the defaults. */
export function buildSpec(draft: PlanDraft): ScanJobSpec {
	const o = draft.options
	const exclusions: ScanExclusion[] = draft.skips.map(s => ({
		startHz: s.startHz,
		endHz: s.endHz,
		...(s.reason ? { reason: s.reason } : {}),
	}))
	const spec: ScanJobSpec = {
		name: planName(draft.ranges).slice(0, 100),
		mode: "sweep",
		kind: "discover",
		ranges: draft.ranges.map(scanRangeOf),
	}
	if (exclusions.length > 0) spec.exclusions = exclusions
	if (o.sensitivity !== "normal") spec.sensitivity = o.sensitivity
	if (!o.hold) spec.hold = { policy: "never" }
	if (!o.record) spec.record = { voice: false, analog: false }
	const stop = STOP[o.stopAfter]
	if (stop) spec.stop = stop
	if (o.signalsOnly) spec.signalsOnly = true
	if (o.skipDecodedElsewhere) spec.skipDecodedElsewhere = true
	return spec
}

/** The plan can be previewed and started: at least one range, none broken. */
export function draftValid(draft: PlanDraft): boolean {
	return (
		draft.ranges.length > 0 && draft.ranges.every(r => rangeError(r) === null)
	)
}

// ---- the footer

/** "< 1 s", "10 s", "2.5 min". */
export function passTime(ms: number): string {
	const t = ms / 1000
	if (t < 1) return "< 1 s"
	if (t < 60) return `${Math.round(t)} s`
	return `${Math.round(t / 6) / 10} min`
}

/** How long a full pass takes, after "full pass": "under 1 s", else "≈ 10 s" (never "≈ < 1 s"). */
export function passPhrase(ms: number): string {
	return ms < 1000 ? "under 1 s" : `≈ ${passTime(ms)}`
}

/** "Full pass ≈ 10 s · 26 hops", or one hop: "One hop · parks at 446.100". */
export function previewSummary(
	preview: Pick<PlanPreview, "plan" | "sweepPeriodMs">,
): string {
	const hops = preview.plan.hops
	if (hops.length === 1 && hops[0])
		return `One hop · parks at ${formatMHz(hops[0].centreHz)}`
	const ms = preview.sweepPeriodMs
	const pass = ms === null ? "Full pass" : `Full pass ${passPhrase(ms)}`
	return `${pass} · ${hops.length} hops`
}

/**
 * The amber consent line: "Takes the receiver · pauses ADS-B, AIS and 3 others · live audio follows the scan".
 * `decoderName` maps a decoder id to its display name.
 */
export function consentText(
	impact: Impact | null,
	decoderName: (id: string) => string,
): string {
	const parts = ["Takes the receiver"]
	if (!impact) return parts[0] ?? ""
	const names = [
		...new Set(
			[...impact.runningDecoders, ...impact.pinnedDecoders].map(decoderName),
		),
	]
	const scans = impact.scannerJobs.length
	const all =
		scans > 0 ? [...names, scans === 1 ? "a scan" : `${scans} scans`] : names
	if (all.length > 0)
		parts.push(
			`pauses ${
				all.length <= 3
					? andText(all)
					: `${all.slice(0, 2).join(", ")} and ${all.length - 2} others`
			}`,
		)
	if (impact.liveAudioClients > 0 || impact.digitalVoiceListeners > 0)
		parts.push("live audio follows the scan")
	return parts.join(" · ")
}

/** Anyone the sweep disturbs (a start then carries `takeover: true`). */
export function impactDisturbs(impact: Impact | null): boolean {
	return (
		impact !== null &&
		(impact.runningDecoders.length > 0 ||
			impact.pinnedDecoders.length > 0 ||
			impact.scannerJobs.length > 0 ||
			impact.liveAudioClients > 0 ||
			impact.digitalVoiceListeners > 0)
	)
}
