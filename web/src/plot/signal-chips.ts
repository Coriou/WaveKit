// Signal chips over the trace (band inspection UX req 1.1, extended to the live-signal layer): co-located
// signals share one chip ("+n-1"), a leaving chip never lands on another, and the number of chips is
// capped. Pure: no DOM, no stores.
import type { Discovery } from "@wavekit/api-types"

import type { SpectrumViewSpan } from "../spectrum/index.ts"
import { tagState, tagTier } from "./discovery-tags.ts"
import type { PlacedLabel, SignalInfo } from "./maths.ts"

/** Two signals closer than this on screen share one chip. */
export const SIGNAL_CLUSTER_PX = 19
/** At most this many chips over the trace (the rest stay clickable on the trace itself). */
export const SIGNAL_CHIPS_MAX = 12

const LABEL_H = 28

/**
 * Groups signals whose centres sit less than SIGNAL_CLUSTER_PX apart (chained, frequency order) or whose
 * spans overlap into one signal: the representative (named first, then the strongest) keeps its label with
 * " +n-1" and spans the whole cluster.
 */
export function clusterSignals(
	signals: readonly SignalInfo[],
	view: SpectrumViewSpan,
	widthPx: number,
): SignalInfo[] {
	const span = view.endHz - view.startHz
	if (!(span > 0) || !(widthPx > 0)) return [...signals]
	const pxPerHz = widthPx / span
	const sorted = [...signals].sort((a, b) => a.hz - b.hz)
	const groups: SignalInfo[][] = []
	for (const s of sorted) {
		const g = groups[groups.length - 1]
		const p = g?.[g.length - 1]
		if (
			g &&
			p &&
			((s.hz - p.hz) * pxPerHz < SIGNAL_CLUSTER_PX ||
				s.hz - s.widthHz / 2 <= p.hz + p.widthHz / 2)
		)
			g.push(s)
		else groups.push([s])
	}
	return groups.map(g => {
		const rep = [...g].sort(
			(a, b) =>
				Number(b.known) - Number(a.known) ||
				(b.peakDb ?? -Infinity) - (a.peakDb ?? -Infinity) ||
				a.hz - b.hz,
		)[0] as SignalInfo
		if (g.length === 1) return rep
		const lo = Math.min(...g.map(s => s.hz - s.widthHz / 2))
		const hi = Math.max(...g.map(s => s.hz + s.widthHz / 2))
		return {
			...rep,
			label: `${rep.label} +${g.length - 1}`,
			widthHz: Math.max(rep.widthHz, hi - lo),
		}
	})
}

/** A chip's rectangle [x0, y0, x1, y1] in px, as placeLabels measures it. */
export function chipRect(
	l: Pick<PlacedLabel, "x" | "top" | "label" | "sub">,
	charPx = 7.4,
	subCharPx = 6.6,
): [number, number, number, number] {
	const w =
		40 + l.label.length * charPx + (l.sub ? 6 + l.sub.length * subCharPx : 0)
	return [l.x - w / 2 - 3, l.top - 2, l.x + w / 2 + 3, l.top + LABEL_H]
}

function overlaps(
	a: [number, number, number, number],
	b: [number, number, number, number],
): boolean {
	return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}

/**
 * The chips drawn: the placed ones (already free of overlap, in priority order) up to the cap, then each
 * leaving chip (fading where it last stood) only where it overlaps none of them.
 */
export function layoutChips<
	T extends Pick<PlacedLabel, "x" | "top" | "label" | "sub">,
>(
	placed: readonly T[],
	leaving: readonly T[],
	max = SIGNAL_CHIPS_MAX,
): { placed: T[]; leaving: T[] } {
	const kept = placed.slice(0, max)
	const rects = kept.map(l => chipRect(l))
	const fading: T[] = []
	for (const l of leaving) {
		if (kept.length + fading.length >= max) break
		const r = chipRect(l)
		if (rects.some(o => overlaps(r, o))) continue
		rects.push(r)
		fading.push(l)
	}
	return { placed: kept, leaving: fading }
}

/** Screen x (CSS px) of an absolute frequency in `view`, or null when it lies outside the view. */
export function chipX(
	hz: number,
	view: SpectrumViewSpan,
	widthPx: number,
): number | null {
	const span = view.endHz - view.startHz
	if (!(span > 0) || !(widthPx > 0) || !Number.isFinite(hz)) return null
	if (hz < view.startHz || hz > view.endHz) return null
	return ((hz - view.startHz) / span) * widthPx
}

/**
 * The leaving chips (band view retune correctness): each fades where its signal is now, at x = f(hz) in
 * the current view, never at a stored screen position (which belongs to the view it was placed in, so
 * after a retune it would land a chip of another band at its old relative place). One whose frequency
 * is outside the view, or that was never placed, is not drawn.
 */
export function fadingChips<T extends Pick<PlacedLabel, "x" | "hz">>(
	leaving: readonly { id: number; hz: number }[],
	lastAt: ReadonlyMap<number, T>,
	view: SpectrumViewSpan,
	widthPx: number,
): (T & { id: number })[] {
	const out: (T & { id: number })[] = []
	for (const g of leaving) {
		const last = lastAt.get(g.id)
		if (!last) continue
		const x = chipX(g.hz, view, widthPx)
		if (x === null) continue
		out.push({ ...last, hz: g.hz, x, id: g.id })
	}
	return out
}

/** The closest discovery within max(3 kHz, half the signal's width) that `pick` accepts; Ignored ones never. */
function closestDiscovery(
	items: Iterable<Discovery>,
	hz: number,
	widthHz: number,
	pick: (d: Discovery) => boolean,
): Discovery | null {
	if (!Number.isFinite(hz)) return null
	const tol = Math.max(3000, Number.isFinite(widthHz) ? widthHz / 2 : 0)
	let best: Discovery | null = null
	for (const d of items) {
		if (d.operator?.lockout || !Number.isFinite(d.frequencyHz)) continue
		const off = Math.abs(d.frequencyHz - hz)
		if (off > tol || (best && off >= Math.abs(best.frequencyHz - hz))) continue
		if (pick(d)) best = d
	}
	return best
}

/**
 * The proven discovery on a signal whose tag is live (tagTier active: heard now or within PROVEN_LIVE_HOLD_MS),
 * or null: its chip holds between bursts like the tag (label-gate.ts provenLive). `now` is the wall clock.
 */
export function provenLiveAt(
	items: Iterable<Discovery>,
	hz: number,
	widthHz: number,
	activeNow: ReadonlySet<string>,
	now: number,
): Discovery | null {
	return closestDiscovery(
		items,
		hz,
		widthHz,
		d => tagState(d) === "proven" && tagTier(d, activeNow, now) === "active",
	)
}

/**
 * The discovery a chip says it is not proven yet (likely or only heard), or null: an unknown chip near one reads
 * "Unidentified · 4FSK ~9 kHz" instead of the bare frequency.
 */
export function weakDiscoveryAt(
	items: Iterable<Discovery>,
	hz: number,
	widthHz: number,
): Discovery | null {
	return closestDiscovery(items, hz, widthHz, d => tagState(d) !== "proven")
}
