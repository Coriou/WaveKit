// The band ruler under the band lanes: a wide strip around the capture (several captures up to the whole
// tuner range) with the band plan, saved frequencies and scanner discoveries on it, the capture and the view
// marked. Pressing or dragging on it moves the view there and the receiver follows (plot-store.ts slideTo):
// the way to go anywhere in the band without inventing IQ, since what the ruler draws is known, not measured.
// Pure: no DOM, no stores.
import type { DisplayGroup, ResolvedBandPlanView } from "@wavekit/api-types"

import { TUNER_RANGE } from "../features/tuner/frequency.ts"
import type { SpectrumViewSpan } from "../spectrum/index.ts"
import { groupColour, spanCentre, spanWidth } from "./maths.ts"

/** Ruler width in captures, from close to the whole tuner range (Infinity). */
export const RULER_LEVELS = [8, 32, 128, Number.POSITIVE_INFINITY] as const
export const DEFAULT_RULER_LEVEL = 0
/** The ruler recentres once the view's centre leaves this middle share of it. */
const FOLLOW_SHARE = 0.6

/** The ruler's span at `level` around `centreHz`, kept inside the tuner's range. */
export function rulerSpan(
	centreHz: number,
	captureWidthHz: number,
	level: number,
): SpectrumViewSpan {
	const full = TUNER_RANGE.maxHz - TUNER_RANGE.minHz
	const factor = RULER_LEVELS[clampLevel(level)] ?? 8
	const width = Math.min(full, captureWidthHz * factor)
	let startHz = centreHz - width / 2
	startHz = Math.max(
		TUNER_RANGE.minHz,
		Math.min(TUNER_RANGE.maxHz - width, startHz),
	)
	return { startHz, endHz: startHz + width }
}

export function clampLevel(level: number): number {
	return Math.max(0, Math.min(RULER_LEVELS.length - 1, Math.round(level)))
}

/**
 * The centre the ruler should sit on: `current` while the view's centre stays in its middle share,
 * else the view's centre (null `current`: the view's centre).
 */
export function followCentre(
	current: number | null,
	view: SpectrumViewSpan,
	captureWidthHz: number,
	level: number,
): number {
	const mid = spanCentre(view)
	if (current === null) return mid
	const span = rulerSpan(current, captureWidthHz, level)
	const margin = (spanWidth(span) * (1 - FOLLOW_SHARE)) / 2
	return mid < span.startHz + margin || mid > span.endHz - margin
		? mid
		: current
}

export function hzToRulerX(hz: number, span: SpectrumViewSpan): number {
	return (hz - span.startHz) / spanWidth(span)
}

export function rulerXToHz(x: number, span: SpectrumViewSpan): number {
	return span.startHz + Math.min(1, Math.max(0, x)) * spanWidth(span)
}

export interface RulerBand {
	key: string
	/** 0–1 across the ruler. */
	left: number
	width: number
	colour: string
	group: DisplayGroup
	title: string
	/** Drawn over its parent (a nested band is a deeper row). */
	depth: number
}

/**
 * Band-plan segments on the ruler, widest first so narrower bands draw over them; at least one px
 * wide so a channel-sized band still shows. Bands outside the ruler are left out.
 */
export function rulerBands(
	plan: ResolvedBandPlanView | null,
	span: SpectrumViewSpan,
	widthPx: number,
): RulerBand[] {
	if (!plan || !(spanWidth(span) > 0) || !(widthPx > 0)) return []
	const width = spanWidth(span)
	const minWidth = 1 / widthPx
	const out: (RulerBand & { hz: number })[] = []
	for (const b of plan.bands) {
		const mhz = (hz: number) => String(+(hz / 1e6).toFixed(4))
		const title = `${b.band.name} · ${mhz(b.band.startHz)}–${mhz(b.band.endHz)} MHz`
		b.segments.forEach((s, i) => {
			if (s.endHz <= span.startHz || s.startHz >= span.endHz) return
			const a = Math.max(s.startHz, span.startHz)
			const z = Math.min(s.endHz, span.endHz)
			out.push({
				key: `${b.key}#${i}`,
				left: (a - span.startHz) / width,
				width: Math.max(minWidth, (z - a) / width),
				colour: groupColour(b.band.group),
				group: b.band.group,
				title,
				depth: b.band.parentId === null ? 0 : 1,
				hz: z - a,
			})
		})
	}
	out.sort((x, y) => y.hz - x.hz || (x.key < y.key ? -1 : 1))
	return out.map(({ hz: _hz, ...band }) => band)
}

export interface RulerMark {
	key: string
	x: number
	hz: number
	title: string
}

/** Point marks (saved frequencies, discoveries) on the ruler, one per px column at most. */
export function rulerMarks(
	items: readonly { key: string; hz: number; title: string }[],
	span: SpectrumViewSpan,
	widthPx: number,
): RulerMark[] {
	if (!(spanWidth(span) > 0) || !(widthPx > 0)) return []
	const seen = new Set<number>()
	const out: RulerMark[] = []
	for (const it of items) {
		if (it.hz < span.startHz || it.hz > span.endHz) continue
		const x = hzToRulerX(it.hz, span)
		const col = Math.round(x * widthPx)
		if (seen.has(col)) continue
		seen.add(col)
		out.push({ key: it.key, x, hz: it.hz, title: it.title })
	}
	return out
}

export interface ActivityBin {
	/** 0–1 across the ruler. */
	x: number
	width: number
	/** 0–1, log-scaled against the busiest bin. */
	level: number
}

/**
 * Where the scanner has heard things, as a quiet density strip: discoveries counted per `binPx` column,
 * heights on a log scale so one busy repeater does not flatten the rest.
 */
export function activityBins(
	hzs: readonly number[],
	span: SpectrumViewSpan,
	widthPx: number,
	binPx = 3,
): ActivityBin[] {
	const width = spanWidth(span)
	if (!(width > 0) || !(widthPx > 0) || !(binPx > 0)) return []
	const n = Math.max(1, Math.floor(widthPx / binPx))
	const counts = new Map<number, number>()
	for (const hz of hzs) {
		if (hz < span.startHz || hz > span.endHz) continue
		const i = Math.min(n - 1, Math.floor(((hz - span.startHz) / width) * n))
		counts.set(i, (counts.get(i) ?? 0) + 1)
	}
	let max = 0
	for (const c of counts.values()) max = Math.max(max, c)
	if (max === 0) return []
	return [...counts.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([i, c]) => ({
			x: i / n,
			width: 1 / n,
			level: Math.log1p(c) / Math.log1p(max),
		}))
}

/** The narrowest band-plan band holding `hz`, for the ruler's hover readout. */
export function bandNameAt(
	plan: ResolvedBandPlanView | null,
	hz: number,
): string | null {
	let best: { name: string; width: number } | null = null
	for (const b of plan?.bands ?? [])
		for (const s of b.segments)
			if (hz >= s.startHz && hz <= s.endHz) {
				const w = s.endHz - s.startHz
				if (!best || w < best.width) best = { name: b.band.name, width: w }
			}
	return best?.name ?? null
}
