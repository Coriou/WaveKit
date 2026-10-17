// Screen-space logic of the Map (pure): collision-free label placement, hit testing with "+N nearby", the cluster
// chooser decision and N / Shift-N walking (docs/web/DESIGN.md, "Map refinement": labels never overlap, dense spots).

export type Rect = readonly [x0: number, y0: number, x1: number, y1: number]

export interface LabelRequest {
	readonly id: string
	readonly text: string
	readonly x: number
	readonly y: number
	/** Lower places first. */
	readonly priority: number
	/** Selected or hovered: placed even over other labels and controls (still inside the frame). */
	readonly force: boolean
	readonly bold: boolean
}

export interface PlacedLabel {
	readonly request: LabelRequest
	readonly rect: Rect
}

export const LABEL_H = 16

const overlaps = (r: Rect, o: Rect) =>
	r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1]
const hitsAny = (r: Rect, list: readonly Rect[]) =>
	list.some(o => overlaps(r, o))

/** The six positions the board tries around a marker, in order. */
export function candidates(
	x: number,
	y: number,
	w: number,
	h = LABEL_H,
): Rect[] {
	return (
		[
			[x + 11, y - h / 2],
			[x - 11 - w, y - h / 2],
			[x + 8, y - 8 - h],
			[x + 8, y + 8],
			[x - w / 2, y - 12 - h],
			[x - w / 2, y + 12],
		] as const
	).map(([a, b]) => [a, b, a + w, b + h] as const)
}

/**
 * Greedy placement by priority. Each label takes the first of its six positions that stays inside the frame and
 * clear of the UI rects, the markers and the labels placed before it; otherwise it is dropped. Forced labels
 * only need to stay inside the frame.
 */
export function placeLabels(
	requests: readonly LabelRequest[],
	opts: {
		width: number
		height: number
		measure: (text: string, bold: boolean) => number
		ui: readonly Rect[]
		markers: readonly Rect[]
	},
): PlacedLabel[] {
	const placed: Rect[] = []
	const out: PlacedLabel[] = []
	const inFrame = (r: Rect) =>
		r[0] >= 2 && r[1] >= 2 && r[2] <= opts.width - 2 && r[3] <= opts.height - 2
	const sorted = [...requests].sort((a, b) => a.priority - b.priority)
	for (const l of sorted) {
		const w = opts.measure(l.text, l.bold) + 6
		for (const r of candidates(l.x, l.y, w)) {
			if (!inFrame(r)) continue
			if (
				!l.force &&
				(hitsAny(r, opts.ui) || hitsAny(r, placed) || hitsAny(r, opts.markers))
			)
				continue
			placed.push(r)
			out.push({ request: l, rect: r })
			break
		}
	}
	return out
}

/** Ring distance labels: tries a few angles on each ring and keeps the first free spot. */
export function placeRingLabels(
	rings: readonly { text: string; r: number }[],
	opts: {
		cx: number
		cy: number
		width: number
		height: number
		measure: (text: string) => number
		taken: readonly Rect[]
	},
): { text: string; x: number; y: number }[] {
	const taken = [...opts.taken]
	const out: { text: string; x: number; y: number }[] = []
	for (const ring of rings) {
		const w = opts.measure(ring.text) + 4
		for (const a of [-60, -120, -30, -150, 60, 120]) {
			const x = opts.cx + ring.r * Math.cos((a * Math.PI) / 180)
			const y = opts.cy + ring.r * Math.sin((a * Math.PI) / 180)
			const r: Rect = [x - w / 2, y - 8, x + w / 2, y + 8]
			if (
				r[0] < 2 ||
				r[1] < 2 ||
				r[2] > opts.width - 2 ||
				r[3] > opts.height - 2
			)
				continue
			if (hitsAny(r, taken)) continue
			taken.push(r)
			out.push({ text: ring.text, x, y })
			break
		}
	}
	return out
}

export interface ScreenPoint {
	readonly id: string
	readonly x: number
	readonly y: number
}

export interface Hit extends ScreenPoint {
	readonly d: number
}

/** Points within `r` px of (x, y), nearest first. */
export function hitsNear(
	points: readonly ScreenPoint[],
	x: number,
	y: number,
	r: number,
): Hit[] {
	const out: Hit[] = []
	for (const p of points) {
		const d = Math.hypot(p.x - x, p.y - y)
		if (d < r) out.push({ ...p, d })
	}
	return out.sort((a, b) => a.d - b.d)
}

export interface ChooseResult {
	readonly kind: "choose"
	readonly ids: readonly string[]
	readonly count: number
}

export type ClickResult =
	| { readonly kind: "none" }
	| { readonly kind: "select"; readonly id: string }
	| ChooseResult

/** One clear winner selects; a cluster opens the chooser (at most six rows) instead of guessing. */
export function clickResult(near: readonly Hit[]): ClickResult {
	const first = near[0]
	if (!first) return { kind: "none" }
	const second = near[1]
	if (!second || (first.d < 5 && second.d - first.d > 6))
		return { kind: "select", id: first.id }
	return {
		kind: "choose",
		ids: near.slice(0, 6).map(h => h.id),
		count: near.length,
	}
}

/** N / Shift-N: the next item by distance from the view's centre, wrapping. */
export function cycleNearest(
	points: readonly ScreenPoint[],
	cx: number,
	cy: number,
	current: string | null,
	dir: 1 | -1,
): string | null {
	if (points.length === 0) return null
	const list = [...points].sort(
		(a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy),
	)
	const i = current === null ? -1 : list.findIndex(p => p.id === current)
	const next =
		i < 0
			? dir === 1
				? list[0]
				: list[list.length - 1]
			: list[(i + dir + list.length) % list.length]
	return next?.id ?? null
}
