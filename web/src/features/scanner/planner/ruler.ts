/**
 * The planner's ruler, pure: the visible stretch (zoom, pan, fit), axis ticks, band-plan lanes, numbered tags and,
 * in running mode, a segmented true-frequency scale (disjoint stretches like 169 + 466 MHz get a break).
 */
import type { DisplayGroup, ResolvedBand } from "@wavekit/api-types"

import { TUNER_LIMITS_HZ } from "./plan.ts"

export interface View {
	readonly lo: number
	readonly hi: number
}

/** Narrowest stretch the ruler zooms to (200 kHz). */
export const MIN_SPAN_HZ = 200_000

export function clampView(v: View): View {
	const full = TUNER_LIMITS_HZ.hi - TUNER_LIMITS_HZ.lo
	const span = Math.min(full, Math.max(MIN_SPAN_HZ, v.hi - v.lo))
	let lo = (v.lo + v.hi) / 2 - span / 2
	lo = Math.max(TUNER_LIMITS_HZ.lo, Math.min(TUNER_LIMITS_HZ.hi - span, lo))
	return { lo, hi: lo + span }
}

/** Zoom by `factor` (< 1 zooms in) keeping `atHz` under the same pixel. */
export function zoomView(
	v: View,
	factor: number,
	atHz = (v.lo + v.hi) / 2,
): View {
	const span = v.hi - v.lo
	const next = Math.max(MIN_SPAN_HZ, span * factor)
	const f = span > 0 ? (atHz - v.lo) / span : 0.5
	return clampView({ lo: atHz - f * next, hi: atHz - f * next + next })
}

export function panView(v: View, dHz: number): View {
	return clampView({ lo: v.lo + dHz, hi: v.hi + dHz })
}

/** A view holding every stretch, with a little room on both sides; null without any. */
export function fitView(
	stretches: readonly { startHz: number; endHz: number }[],
	padShare = 0.06,
): View | null {
	if (stretches.length === 0) return null
	const lo = Math.min(...stretches.map(s => s.startHz))
	const hi = Math.max(...stretches.map(s => s.endHz))
	const pad = Math.max(100_000, (hi - lo) * padShare)
	return clampView({ lo: lo - pad, hi: hi + pad })
}

/**
 * Where setup opens with no ranges: the region's VHF bands (118–174 MHz in the EU), where most lanes have a band;
 * the whole plan would draw every band as a sliver. Never an empty stretch: falls back to every band, then 118–174.
 */
export function bandsView(
	bands: readonly { startHz: number; endHz: number }[],
): View {
	const vhf = bands.filter(b => b.startHz >= 100e6 && b.endHz <= 200e6)
	return (
		fitView(vhf.length > 0 ? vhf : bands, 0.02) ??
		clampView({ lo: 117e6, hi: 175e6 })
	)
}

export const xOf = (hz: number, v: View, width: number): number =>
	((hz - v.lo) / (v.hi - v.lo)) * width

export const hzAt = (x: number, v: View, width: number): number =>
	v.lo + (x / Math.max(1, width)) * (v.hi - v.lo)

/** Snaps a drawn edge to 5 kHz. */
export const snapHz = (hz: number): number => Math.round(hz / 5000) * 5000

export interface Tick {
	readonly hz: number
	readonly x: number
	readonly text: string
}

const NICE = [1, 2, 2.5, 5]

/** A round tick step with at least `minPx` between labels. */
export function tickStep(spanHz: number, width: number, minPx = 80): number {
	const want = (spanHz / Math.max(1, width)) * minPx
	const mag = 10 ** Math.floor(Math.log10(Math.max(1, want)))
	for (const m of [...NICE, 10]) if (m * mag >= want) return m * mag
	return 10 * mag
}

/** "146", "156.5", "446.0125": a tick label in MHz. */
export function tickText(hz: number): string {
	return String(+(hz / 1e6).toFixed(4))
}

export function ticks(v: View, width: number, minPx = 80): Tick[] {
	const step = tickStep(v.hi - v.lo, width, minPx)
	const out: Tick[] = []
	for (let hz = Math.ceil(v.lo / step) * step; hz <= v.hi; hz += step)
		out.push({ hz, x: xOf(hz, v, width), text: tickText(hz) })
	return out
}

/** Ticks whose centred label fits inside the track (none cut at an edge). */
export function labelled(list: readonly Tick[], width: number): Tick[] {
	return list.filter(t => {
		const half = (t.text.length * 11 * 0.56) / 2 + 2
		return t.x >= half && t.x <= width - half
	})
}

// ---- band-plan lanes

/** The resolved band plan's display groups, mapped to the canvas group tokens (--wk-grp-*). */
const GROUP: Readonly<Record<DisplayGroup, { name: string; token: string }>> = {
	marine: { name: "Marine", token: "marine" },
	air: { name: "Air", token: "air" },
	"ism-srd": { name: "ISM / SRD", token: "srd" },
	pagers: { name: "Pagers", token: "pagers" },
	"personal-radio": { name: "Personal radio", token: "personal" },
	amateur: { name: "Amateur", token: "amateur" },
	"land-mobile": { name: "Land mobile", token: "landmobile" },
	broadcast: { name: "Broadcast", token: "broadcast" },
	other: { name: "Other", token: "other" },
}

export function groupName(g: DisplayGroup): string {
	return GROUP[g].name
}

export function groupColour(g: DisplayGroup): string {
	return `var(--wk-grp-${GROUP[g].token})`
}

export interface LaneBand {
	readonly key: string
	readonly group: DisplayGroup
	readonly name: string
	readonly startHz: number
	readonly endHz: number
	readonly stepHz: number | null
	/** Scans skip it by default (hatched, never added by a click), with the plan's reason. */
	readonly skip: string | null
}

export interface Lane {
	readonly group: DisplayGroup
	readonly name: string
	readonly colour: string
	readonly bands: readonly LaneBand[]
}

/** One lane per display group present, ordered by the frequency of its first band. */
export function lanesOf(bands: readonly ResolvedBand[]): Lane[] {
	const by = new Map<DisplayGroup, LaneBand[]>()
	for (const rb of bands) {
		const b = rb.band
		const list = by.get(b.group) ?? []
		list.push({
			key: rb.key,
			group: b.group,
			name: b.name,
			startHz: b.startHz,
			endHz: b.endHz,
			stepHz: b.stepHz,
			skip: b.skip?.reason ?? null,
		})
		by.set(b.group, list)
	}
	return [...by.entries()]
		.map(([group, list]) => ({
			group,
			name: groupName(group),
			colour: groupColour(group),
			bands: list.sort((a, b) => a.startHz - b.startHz),
		}))
		.sort(
			(a, b) =>
				(a.bands[0]?.startHz ?? 0) - (b.bands[0]?.startHz ?? 0) ||
				(a.group < b.group ? -1 : 1),
		)
}

/** The narrowest band of a lane under `x` (3 px of slack), or null. */
export function bandAtX(
	lane: Lane,
	x: number,
	v: View,
	width: number,
): LaneBand | null {
	const hits = lane.bands.filter(
		b => xOf(b.startHz, v, width) - 3 <= x && xOf(b.endHz, v, width) + 3 >= x,
	)
	hits.sort((a, b) => a.endHz - a.startHz - (b.endHz - b.startHz))
	return hits[0] ?? null
}

// ---- numbered tags

export interface TagIn {
	readonly num: number
	readonly name: string
	/** Pixel edges of the range. */
	readonly x0: number
	readonly x1: number
}

export interface TagOut extends TagIn {
	readonly left: number
	readonly w: number
	readonly nameLeft: number
	/** Room for the name; 0 when it does not show. */
	readonly nameW: number
}

const textW = (t: string, px: number) => t.length * px * 0.56 + 2

/**
 * One numbered tag per range at its low edge; tags never overlap (a later one moves right) and a name shows only in
 * the free room between its tag and the next one (or its own high edge). Nothing stacks.
 */
export function placeTags(items: readonly TagIn[], width: number): TagOut[] {
	const placed: { it: TagIn; left: number; w: number }[] = []
	let edge = -Infinity
	for (const it of items) {
		const w = String(it.num).length > 1 ? 24 : 18
		let left = Math.max(it.x0 + 2, edge + 3)
		left = Math.min(left, width - w - 1)
		placed.push({ it, left, w })
		edge = left + w
	}
	return placed.map((p, i) => {
		const next = placed
			.slice(i + 1)
			.reduce((m, o) => Math.min(m, o.left), Infinity)
		const nameLeft = p.left + p.w + 5
		const room = Math.min(next - 8, p.it.x1 - 6, width - 4) - nameLeft
		const show = room >= Math.min(textW(p.it.name, 12), 52)
		return { ...p.it, left: p.left, w: p.w, nameLeft, nameW: show ? room : 0 }
	})
}

// ---- running: a segmented true-frequency scale

export interface ScaleSegment {
	readonly lo: number
	readonly hi: number
	readonly x0: number
	readonly x1: number
}

export interface Scale {
	readonly width: number
	readonly segments: readonly ScaleSegment[]
	/** Pixel stretches between segments (drawn as a break). */
	readonly breaks: readonly { readonly x0: number; readonly x1: number }[]
}

export const BREAK_PX = 22

/**
 * A true-frequency scale over the stretches: close ones share one linear segment; a gap wider than the stretches
 * themselves becomes a break, and each segment gets pixels in proportion to its width (at least a fifth of the
 * room, so PMR446 next to 28 MHz of land mobile still reads).
 */
export function segmentedScale(
	stretches: readonly { startHz: number; endHz: number }[],
	width: number,
): Scale {
	const sorted = [...stretches]
		.filter(s => s.endHz > s.startHz)
		.sort((a, b) => a.startHz - b.startHz)
	if (sorted.length === 0) return { width, segments: [], breaks: [] }
	const total = sorted.reduce((n, s) => n + (s.endHz - s.startHz), 0)
	const groups: { lo: number; hi: number }[] = []
	for (const s of sorted) {
		const last = groups[groups.length - 1]
		if (last && s.startHz - last.hi <= Math.max(total, 2e6))
			last.hi = Math.max(last.hi, s.endHz)
		else groups.push({ lo: s.startHz, hi: s.endHz })
	}
	const padded = groups.map(g => {
		const pad = Math.max(50_000, (g.hi - g.lo) * 0.04)
		return { lo: g.lo - pad, hi: g.hi + pad }
	})
	const room = Math.max(1, width - BREAK_PX * (padded.length - 1))
	const sum = padded.reduce((n, g) => n + (g.hi - g.lo), 0)
	// small segments are raised to the minimum share; the others split what is left in proportion
	const minShare = Math.min(0.2, 1 / padded.length)
	const raw = padded.map(g => (g.hi - g.lo) / sum)
	const small = raw.map(r => r < minShare)
	const bigSum = raw.reduce((n, r, i) => (small[i] ? n : n + r), 0)
	const left = 1 - minShare * small.filter(Boolean).length
	const shares = raw.map((r, i) =>
		small[i] ? minShare : bigSum > 0 ? (r / bigSum) * left : 0,
	)
	const segments: ScaleSegment[] = []
	const breaks: { x0: number; x1: number }[] = []
	let x = 0
	padded.forEach((g, i) => {
		const w = room * (shares[i] ?? 0)
		segments.push({ lo: g.lo, hi: g.hi, x0: x, x1: x + w })
		x += w
		if (i < padded.length - 1) {
			breaks.push({ x0: x, x1: x + BREAK_PX })
			x += BREAK_PX
		}
	})
	return { width, segments, breaks }
}

/** Pixel of a frequency on a scale (clamped into the nearest segment), or null on an empty scale. */
export function scaleX(scale: Scale, hz: number): number | null {
	const segs = scale.segments
	if (segs.length === 0) return null
	let best = segs[0]
	for (const s of segs) {
		if (hz >= s.lo && hz <= s.hi) {
			best = s
			break
		}
		if (
			best &&
			Math.abs(hz - (s.lo + s.hi) / 2) < Math.abs(hz - (best.lo + best.hi) / 2)
		)
			best = s
	}
	if (!best) return null
	const f = (hz - best.lo) / (best.hi - best.lo)
	return best.x0 + f * (best.x1 - best.x0)
}

/** Pixel width of a stretch at `hz` on a scale (the capture window's real width). */
export function scaleWidth(scale: Scale, hz: number, widthHz: number): number {
	const a = scaleX(scale, hz - widthHz / 2)
	const b = scaleX(scale, hz + widthHz / 2)
	if (a === null || b === null) return 0
	const seg = scale.segments.find(s => hz >= s.lo && hz <= s.hi)
	if (!seg) return Math.max(0, b - a)
	return ((seg.x1 - seg.x0) / (seg.hi - seg.lo)) * widthHz
}

/** Axis ticks per segment of a scale. */
export function scaleTicks(scale: Scale, minPx = 80): Tick[] {
	const out: Tick[] = []
	for (const s of scale.segments) {
		const w = s.x1 - s.x0
		for (const t of ticks({ lo: s.lo, hi: s.hi }, w, minPx))
			out.push({ ...t, x: s.x0 + t.x })
	}
	return out
}

/** Merges stretches that touch or overlap. */
export function mergeStretches(
	stretches: readonly { startHz: number; endHz: number }[],
): { startHz: number; endHz: number }[] {
	const sorted = [...stretches].sort((a, b) => a.startHz - b.startHz)
	const out: { startHz: number; endHz: number }[] = []
	for (const s of sorted) {
		const last = out[out.length - 1]
		if (last && s.startHz <= last.endHz)
			last.endHz = Math.max(last.endHz, s.endHz)
		else out.push({ startHz: s.startHz, endHz: s.endHz })
	}
	return out
}
