import { rasterUnion } from "../bandplan/index.js"
import type { FreqRange, Raster } from "../../spectrum/types.js"
import type { Hop, HopPlan, ScanExclusion, ScanRange } from "../types.js"

/** Spec § 5.3: greedy covering with a reserved DC-search slack, DC placement on a 100 Hz grid. */
export interface HopPlanInput {
	ranges: ScanRange[]
	exclusions: ScanExclusion[]
	sampleRateHz: number
	usableFraction: number
	rbwHz: number
	dcGuardHz: number
	ppmMargin: number
	tunerRange: FreqRange
}

/** A raster channel: centre, planning width (raster spacing) and expected emission half-width. */
export interface PlanItem {
	hz: number
	widthHz: number
	edgeHalfHz: number
}

export const FREE_RANGE_WIDTH_HZ = 25_000
const DC_GRID_HZ = 100
const DEFAULT_OBW_FRACTION = 0.72 // 9 kHz on 12.5 kHz
const EPS = 1e-6

interface FreeSpan {
	lo: number
	hi: number
	widthHz: number
	next: number
}

function inExclusion(hz: number, exclusions: readonly FreqRange[]): boolean {
	return exclusions.some(x => hz >= x.startHz && hz <= x.endHz)
}

function clamp(hz: number, r: FreqRange): number {
	return Math.min(r.endHz, Math.max(r.startHz, hz))
}

export function rasterItems(
	ranges: ScanRange[],
	exclusions: ScanExclusion[],
): PlanItem[] {
	const byHz = new Map<number, PlanItem>()
	for (const r of ranges) {
		const classes = r.obwHz ?? []
		for (const raster of r.rasters ?? []) {
			const s = raster.spacingHz
			if (!(s > 0)) continue
			let fitting = -Infinity
			for (const o of classes) if (o <= s) fitting = Math.max(fitting, o)
			const obw =
				fitting > 0
					? fitting
					: classes.length > 0
						? Math.min(...classes)
						: DEFAULT_OBW_FRACTION * s
			const first = Math.ceil((r.startHz - raster.firstChannelHz) / s - EPS)
			for (let k = first; raster.firstChannelHz + k * s <= r.endHz + EPS; k++) {
				const hz = Math.round(raster.firstChannelHz + k * s)
				if (inExclusion(hz, exclusions)) continue
				const prev = byHz.get(hz)
				byHz.set(hz, {
					hz,
					widthHz: Math.max(s, prev?.widthHz ?? 0),
					edgeHalfHz: Math.max(obw / 2, prev?.edgeHalfHz ?? 0),
				})
			}
		}
	}
	return [...byHz.values()].sort((a, b) => a.hz - b.hz)
}

function freeSpans(
	ranges: ScanRange[],
	exclusions: ScanExclusion[],
): FreeSpan[] {
	const out: FreeSpan[] = []
	for (const r of ranges) {
		if ((r.rasters ?? []).length > 0) continue
		const widthHz =
			(r.obwHz ?? []).reduce((a, b) => Math.max(a, b), 0) || FREE_RANGE_WIDTH_HZ
		let pieces: [number, number][] = [[r.startHz, r.endHz]]
		for (const x of exclusions) {
			pieces = pieces.flatMap(([a, b]): [number, number][] => {
				if (x.endHz < a || x.startHz > b) return [[a, b]]
				const parts: [number, number][] = []
				if (x.startHz > a) parts.push([a, x.startHz])
				if (x.endHz < b) parts.push([x.endHz, b])
				return parts
			})
		}
		for (const [lo, hi] of pieces) out.push({ lo, hi, widthHz, next: lo })
	}
	return out
}

function greedyCentres(
	items: PlanItem[],
	spans: FreeSpan[],
	H: number,
	slack: number,
	wMax: number,
): number[] {
	const margin = H - slack
	const sorted = [...items].sort(
		(a, b) => a.hz - a.widthHz / 2 - (b.hz - b.widthHz / 2),
	)
	let lowAll = Infinity
	let highAll = -Infinity
	for (const i of sorted) {
		lowAll = Math.min(lowAll, i.hz - i.widthHz / 2)
		highAll = Math.max(highAll, i.hz + i.widthHz / 2)
	}
	for (const s of spans) {
		lowAll = Math.min(lowAll, s.lo - s.widthHz / 2)
		highAll = Math.max(highAll, s.hi + s.widthHz / 2)
	}
	if (highAll - lowAll <= 2 * margin) return [(lowAll + highAll) / 2]
	const step = 2 * H - wMax - 2 * slack
	const covered = new Uint8Array(sorted.length)
	const out: number[] = []
	let ptr = 0
	let prev: number | null = null
	for (;;) {
		while (ptr < sorted.length && covered[ptr] === 1) ptr++
		let low = Infinity
		let high = -Infinity
		const first = sorted[ptr]
		if (first) {
			low = first.hz - first.widthHz / 2
			high = first.hz + first.widthHz / 2
		}
		for (const s of spans) {
			if (s.next > s.hi) continue
			const l = s.next - s.widthHz / 2
			if (l < low) {
				low = l
				high = s.next + s.widthHz / 2
			}
		}
		if (low === Infinity) break
		let hG = low + margin
		if (prev !== null) {
			const c = prev + step
			if (low >= c - margin - EPS && high <= c + margin + EPS) hG = c
		}
		out.push(hG)
		prev = hG
		const lo = hG - margin - EPS
		const hi = hG + margin + EPS
		for (let j = ptr; j < sorted.length; j++) {
			const x = sorted[j]
			if (!x) break
			const xl = x.hz - x.widthHz / 2
			if (xl > hi) break
			if (xl >= lo && x.hz + x.widthHz / 2 <= hi) covered[j] = 1
		}
		for (const s of spans) {
			if (s.next > s.hi) continue
			const upTo = hG + margin - s.widthHz / 2
			if (upTo < s.next) continue
			s.next = upTo >= s.hi ? Infinity : upTo
		}
	}
	return out
}

/** Maximise min(|c − h| − edgeHalf) over the 100 Hz grid in [greedy ± slack] ∩ tunerRange. */
export function placeDc(
	greedyHz: number,
	slackHz: number,
	items: PlanItem[],
	mainRaster: Raster | null,
	tunerRange: FreqRange,
): { centreHz: number; minEdgeHz: number } {
	const sorted = [...items].sort((a, b) => a.hz - b.hz)
	const maxEdge = sorted.reduce((m, i) => Math.max(m, i.edgeHalfHz), 0)
	// min(|c − h| − edgeHalf), walking outward from h; stops once no farther channel can lower it.
	const objective = (h: number): number => {
		let m = Infinity
		const at = lowerBound(sorted, h)
		for (let j = at; j < sorted.length; j++) {
			const i = sorted[j]
			if (!i || i.hz - h - maxEdge >= m) break
			m = Math.min(m, i.hz - h - i.edgeHalfHz)
		}
		for (let j = at - 1; j >= 0; j--) {
			const i = sorted[j]
			if (!i || h - i.hz - maxEdge >= m) break
			m = Math.min(m, h - i.hz - i.edgeHalfHz)
		}
		return m
	}
	const score = (h: number): number => (items.length > 0 ? objective(h) : 0)
	const isHalf = (h: number): boolean => {
		if (!mainRaster) return false
		const s = mainRaster.spacingHz
		return (((h - mainRaster.firstChannelHz) % s) + s) % s === s / 2
	}
	const prefer = (a: number, b: number): boolean => {
		const ha = isHalf(a)
		const hb = isHalf(b)
		if (ha !== hb) return ha
		const da = Math.abs(a - greedyHz)
		const db = Math.abs(b - greedyHz)
		if (da !== db) return da < db
		return a < b
	}
	const lo = Math.max(tunerRange.startHz, greedyHz - slackHz)
	const hi = Math.min(tunerRange.endHz, greedyHz + slackHz)
	const first = Math.ceil(lo / DC_GRID_HZ) * DC_GRID_HZ
	if (first > hi) {
		const c = clamp(greedyHz, tunerRange)
		return { centreHz: c, minEdgeHz: objective(c) }
	}
	let best = first
	let bestScore = score(first)
	for (let h = first + DC_GRID_HZ; h <= hi; h += DC_GRID_HZ) {
		const v = score(h)
		if (
			v > bestScore + EPS ||
			(Math.abs(v - bestScore) <= EPS && prefer(h, best))
		) {
			best = h
			bestScore = v
		}
	}
	return { centreHz: best, minEdgeHz: objective(best) }
}

function lowerBound(items: PlanItem[], hz: number): number {
	let lo = 0
	let hi = items.length
	while (lo < hi) {
		const mid = (lo + hi) >> 1
		if ((items[mid]?.hz ?? Infinity) < hz) lo = mid + 1
		else hi = mid
	}
	return lo
}

function mergeRanges(ranges: FreqRange[]): FreqRange[] {
	const sorted = [...ranges].sort((a, b) => a.startHz - b.startHz)
	const out: FreqRange[] = []
	for (const r of sorted) {
		const last = out.at(-1)
		if (last && r.startHz <= last.endHz)
			last.endHz = Math.max(last.endHz, r.endHz)
		else out.push({ ...r })
	}
	return out
}

function hopAt(
	index: number,
	centreHz: number,
	items: PlanItem[],
	input: HopPlanInput,
	H: number,
	g: number,
): Hop {
	const m = input.ppmMargin * 1e-6 * centreHz
	let channelCount = 0
	let dcMinEdgeHz = H
	const dcAdjacentChannelsHz: number[] = []
	for (let j = lowerBound(items, centreHz - H); j < items.length; j++) {
		const i = items[j]
		if (!i || i.hz > centreHz + H) break
		const d = Math.abs(i.hz - centreHz)
		if (d + i.widthHz / 2 > H + EPS) continue
		channelCount++
		const edge = d - i.edgeHalfHz
		dcMinEdgeHz = Math.min(dcMinEdgeHz, edge)
		if (edge < g + m) dcAdjacentChannelsHz.push(i.hz)
	}
	const lo = centreHz - H
	const hi = centreHz + H
	const excluded = mergeRanges(
		input.exclusions
			.filter(x => x.endHz > lo && x.startHz < hi)
			.map(x => ({
				startHz: Math.max(x.startHz, lo),
				endHz: Math.min(x.endHz, hi),
			})),
	)
	return {
		index,
		centreHz,
		covered: { startHz: lo, endHz: hi },
		channelCount,
		dcAdjacentChannelsHz,
		excluded,
		dcMinEdgeHz,
	}
}

function geometry(input: HopPlanInput): { H: number; g: number } {
	return {
		H: (input.sampleRateHz * input.usableFraction) / 2,
		g: Math.max(input.dcGuardHz, 2 * input.rbwHz),
	}
}

/** The hop report for a given centre (in-window jobs use the source's current centre). */
export function describeHop(
	index: number,
	centreHz: number,
	input: HopPlanInput,
): Hop {
	const { H, g } = geometry(input)
	return hopAt(
		index,
		centreHz,
		rasterItems(input.ranges, input.exclusions),
		input,
		H,
		g,
	)
}

export function planHops(input: HopPlanInput): HopPlan {
	const { H, g } = geometry(input)
	const items = rasterItems(input.ranges, input.exclusions)
	const spans = freeSpans(input.ranges, input.exclusions)
	const rasters = rasterUnion(input.ranges)
	const main = rasters[0] ?? null
	const slack =
		items.length > 0
			? rasters.reduce((a, r) => Math.min(a, r.spacingHz), Infinity)
			: 0
	let wMax = 0
	for (const i of items) wMax = Math.max(wMax, i.widthHz)
	for (const s of spans) wMax = Math.max(wMax, s.widthHz)
	const finish = (hops: Hop[]): HopPlan => ({
		hops,
		usableHalfSpanHz: H,
		dcGuardHz: g,
		ppmMarginHz: hops.reduce(
			(a, h) => Math.max(a, input.ppmMargin * 1e-6 * h.centreHz),
			0,
		),
	})
	if ((items.length === 0 && spans.length === 0) || wMax >= 2 * (H - slack))
		return finish([])
	const hops = greedyCentres(items, spans, H, slack, wMax).map((hG, index) => {
		// Free-only hops (no raster channel nearby) keep the greedy centre.
		let centre = clamp(hG, input.tunerRange)
		if (slack > 0) {
			const from = lowerBound(items, hG - H - slack)
			const near: PlanItem[] = []
			for (let j = from; j < items.length; j++) {
				const i = items[j]
				if (!i || i.hz > hG + H + slack) break
				near.push(i)
			}
			if (near.length > 0)
				centre = placeDc(hG, slack, near, main, input.tunerRange).centreHz
		}
		return hopAt(index, centre, items, input, H, g)
	})
	return finish(hops)
}
