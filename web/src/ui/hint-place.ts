// Where a hint bubble goes (docs/web/DESIGN.md, Hints): inside the surface that holds its mark, never over the
// row it explains; out of it, in the window, only when the surface has no room beside the row. Pure: rectangles in, a position out, no DOM.

export interface HintRect {
	readonly left: number
	readonly top: number
	readonly right: number
	readonly bottom: number
}

export interface HintSize {
	readonly width: number
	readonly height: number
}

export interface HintPlaceInput {
	/** The row that stays readable while the hint is open (label line and its control). */
	readonly keep: HintRect
	/** The surface that holds the mark: an island panel, a drawer, a sheet. */
	readonly host: HintRect
	/** The window. */
	readonly viewport: HintSize
	/** The bubble's size. */
	readonly size: HintSize
	/** How far the bubble keeps inside its host (px). */
	readonly inset?: number
	/** The gap between the kept row and the bubble (px). */
	readonly gap?: number
	/**
	 * The shortest cut worth drawing (px): the bubble's padding and border plus two lines of text
	 * (`hintMinCut`). A border-box bubble never draws shorter than its padding and border, so a smaller cut
	 * would spill over its row or out of its host; with less room than this on both sides it is not shown.
	 */
	readonly minHeight?: number
	/**
	 * Where it may go when its host has no room for even the shortest cut beside the row: out of the host, in
	 * the window (`host`: the host's whole surface, kept clear; `obstacles`: other islands, kept clear too).
	 * Without it, no room in the host means not shown.
	 */
	readonly around?: {
		readonly host: HintRect
		readonly obstacles: readonly HintRect[]
	}
}

/** A side of the kept row (inside the host) or of the host (outside it). */
export type HintSide = "above" | "below" | "left" | "right"

export interface HintPlacement {
	readonly x: number
	readonly y: number
	/**
	 * Inside the host: `above` or `below` the kept row. Out of it (`outside`): the side of the host it lies on.
	 * `none`: no room for even the shortest cut, in the host or around it; the bubble is not shown.
	 */
	readonly side: HintSide | "none"
	/** Set when the host had no room beside its row and the bubble lies out of the host, in the window. */
	readonly outside?: true
	/**
	 * Set only when the bubble does not fit whole where it goes: the height it may take there (px). The bubble's
	 * body scrolls within it; it never grows back over its row.
	 */
	readonly maxHeight?: number
}

export const HINT_INSET = 12
export const HINT_GAP = 6
/** Lines of text the shortest cut bubble still shows (with its padding and border). */
export const HINT_MIN_LINES = 2

/** The computed style a bubble's shortest cut is read from (the `CSSStyleDeclaration` strings). */
export interface HintChromeStyle {
	readonly paddingTop: string
	readonly paddingBottom: string
	readonly borderTopWidth: string
	readonly borderBottomWidth: string
	readonly lineHeight: string
	readonly fontSize: string
}

/**
 * The shortest cut worth drawing (px) for a bubble with this computed style: its vertical padding and border
 * (what a border-box element draws at any height) and `lines` lines of its text.
 */
export function hintMinCut(
	style: HintChromeStyle,
	lines = HINT_MIN_LINES,
): number {
	const px = (v: string) => {
		const n = parseFloat(v)
		return Number.isFinite(n) ? n : 0
	}
	const font = px(style.fontSize) || 16
	const lh = style.lineHeight.trim()
	// a resolved line-height is px; "normal" and a bare number are relative to the font
	const line =
		lh === "normal"
			? font * 1.2
			: lh.endsWith("px")
				? px(lh)
				: Number.isFinite(parseFloat(lh))
					? parseFloat(lh) * font
					: font * 1.2
	const chrome =
		px(style.paddingTop) +
		px(style.paddingBottom) +
		px(style.borderTopWidth) +
		px(style.borderBottomWidth)
	return Math.ceil(chrome + lines * line)
}

/** The host's box the bubble may use: the host clipped to the window, `inset` in from every edge. */
export function hintBox(
	host: HintRect,
	viewport: HintSize,
	inset = HINT_INSET,
): HintRect {
	return {
		left: Math.max(host.left, 0) + inset,
		top: Math.max(host.top, 0) + inset,
		right: Math.min(host.right, viewport.width) - inset,
		bottom: Math.min(host.bottom, viewport.height) - inset,
	}
}

/**
 * Above the kept row first (a finger covers what is below), start-aligned with it and shifted sideways to stay
 * in the host; below when above has no room. When neither fits, the roomier side with the bubble's height
 * capped to that side's room (`maxHeight`, its body scrolls): never over its own row. When even the roomier
 * side is shorter than `minHeight` (a row that fills its host), out of the host in the window
 * (`placeHintOutside`, given `around`); with no room there either, `side: "none"`: no sliver is drawn.
 */
export function placeHint(input: HintPlaceInput): HintPlacement {
	const { keep, size } = input
	const gap = input.gap ?? HINT_GAP
	const box = hintBox(input.host, input.viewport, input.inset ?? HINT_INSET)
	const x = Math.round(
		Math.max(
			box.left,
			Math.min(Math.max(keep.left, box.left), box.right - size.width),
		),
	)
	const above = keep.top - gap - size.height
	const below = keep.bottom + gap
	// whole px rounded toward the room (never out of the box; the gap absorbs the step toward the row)
	if (above >= box.top) return { x, y: Math.ceil(above), side: "above" }
	if (below + size.height <= box.bottom)
		return { x, y: Math.floor(below), side: "below" }
	// neither fits: the roomier side, the bubble cut to its room (whole px, so rounding never reaches the row)
	const aboveStart = Math.ceil(box.top)
	const aboveRoom = Math.floor(keep.top - gap) - aboveStart
	const belowStart = Math.ceil(below)
	const belowRoom = Math.floor(box.bottom) - belowStart
	const side = aboveRoom >= belowRoom ? "above" : "below"
	const y = side === "above" ? aboveStart : belowStart
	const maxHeight = side === "above" ? aboveRoom : belowRoom
	// less room than the bubble's own padding, border and two lines: a sliver would spill, so none is drawn
	// in the host; out of it, around the host in the window, if there is room there
	if (maxHeight < Math.max(1, Math.ceil(input.minHeight ?? 0))) {
		const out = input.around
			? placeHintOutside({
					keep,
					host: input.around.host,
					obstacles: input.around.obstacles,
					viewport: input.viewport,
					size,
					inset: input.inset ?? HINT_INSET,
					gap,
					minHeight: input.minHeight ?? 0,
				})
			: null
		return out ?? { x, y, side: "none" }
	}
	return { x, y, side, maxHeight }
}

export interface HintOutsideInput {
	/** The row the hint explains: kept clear. */
	readonly keep: HintRect
	/** The host's whole surface: kept clear (the bubble lies beside it, not on it). */
	readonly host: HintRect
	/** Other islands: kept clear. */
	readonly obstacles: readonly HintRect[]
	readonly viewport: HintSize
	readonly size: HintSize
	/** How far the bubble keeps inside the window (px). */
	readonly inset?: number
	/** The gap kept to the host, the row and every obstacle (px). */
	readonly gap?: number
	/** The shortest cut worth drawing (px), as `HintPlaceInput.minHeight`. */
	readonly minHeight?: number
}

/** The order the sides of the host are tried in: above first (a finger covers what is below), then below, beside. */
const OUTSIDE_SIDES: readonly HintSide[] = ["above", "below", "right", "left"]

/**
 * The fallback for a host with no room beside its row: the bubble out of the host, in the window `inset` in from
 * its edges, on a side of the host (above, below, right, left, in that order), clear by `gap` of the host, its
 * row and every obstacle. Whole where it fits on some side (nearest the host and the row); else cut (`maxHeight`,
 * its body scrolls) to the tallest free room any side has, when that is at least `minHeight`; else null.
 * Whole px: the bubble's box (its width and its height, rounded up) never leaves the room it was given.
 */
export function placeHintOutside(
	input: HintOutsideInput,
): HintPlacement | null {
	const { keep, host, viewport } = input
	const inset = input.inset ?? HINT_INSET
	const gap = input.gap ?? HINT_GAP
	const w = Math.ceil(input.size.width)
	const h = Math.ceil(input.size.height)
	const min = Math.max(1, Math.ceil(input.minHeight ?? 0))
	// the window, inset; every region and free stretch in whole px, rounded inward
	const win = {
		left: Math.ceil(inset),
		top: Math.ceil(inset),
		right: Math.floor(viewport.width - inset),
		bottom: Math.floor(viewport.height - inset),
	}
	// what the bubble keeps clear: the host, its row and the obstacles, each grown by the gap
	const grow = (r: HintRect): HintRect => ({
		left: Math.floor(r.left - gap),
		top: Math.floor(r.top - gap),
		right: Math.ceil(r.right + gap),
		bottom: Math.ceil(r.bottom + gap),
	})
	const clear = [host, keep, ...input.obstacles]
		.filter(r => r.right > r.left && r.bottom > r.top)
		.map(grow)
	const g = grow(host)
	const region = (side: HintSide): HintRect => {
		switch (side) {
			case "above":
				return { ...win, bottom: Math.min(win.bottom, g.top) }
			case "below":
				return { ...win, top: Math.max(win.top, g.bottom) }
			case "left":
				return { ...win, right: Math.min(win.right, g.left) }
			case "right":
				return { ...win, left: Math.max(win.left, g.right) }
		}
	}
	interface Spot {
		readonly side: HintSide
		readonly x: number
		/** A free vertical stretch at `x`, `w` wide. */
		readonly top: number
		readonly bottom: number
	}
	const spots: Spot[] = []
	for (const side of OUTSIDE_SIDES) {
		const r = region(side)
		if (r.right - r.left < w || r.bottom - r.top < min) continue
		const fit = (x: number) => Math.max(r.left, Math.min(x, r.right - w))
		// the start-aligned spot first (beside the host for left and right), then beside each obstacle
		const first =
			side === "left"
				? r.right - w
				: side === "right"
					? r.left
					: fit(Math.round(keep.left))
		const xs = [first]
		for (const o of clear) xs.push(fit(o.right), fit(o.left - w))
		xs.push(r.left, r.right - w)
		const seen = new Set<number>()
		for (const x of xs
			.map(fit)
			.sort((a, b) => Math.abs(a - first) - Math.abs(b - first))) {
			if (seen.has(x)) continue
			seen.add(x)
			// the stretches of the region's height that no obstacle in this column takes
			const blocks = clear
				.filter(o => o.left < x + w && o.right > x)
				.map(
					o => [Math.max(o.top, r.top), Math.min(o.bottom, r.bottom)] as const,
				)
				.filter(([a, b]) => b > a)
				.sort((a, b) => a[0] - b[0])
			let from = r.top
			for (const [a, b] of blocks) {
				if (a - from >= min) spots.push({ side, x, top: from, bottom: a })
				from = Math.max(from, b)
			}
			if (r.bottom - from >= min)
				spots.push({ side, x, top: from, bottom: r.bottom })
		}
	}
	// how far a spot is from the host's side and the row (nearer first)
	const away = (s: Spot, y: number): number =>
		s.side === "above"
			? host.top - (y + h)
			: s.side === "below"
				? y - host.bottom
				: Math.abs(y - keep.top) +
					(s.side === "left" ? host.left - (s.x + w) : s.x - host.right)
	const yWhole = (s: Spot): number =>
		s.side === "above"
			? s.bottom - h
			: s.side === "below"
				? s.top
				: Math.max(s.top, Math.min(Math.round(keep.top), s.bottom - h))
	// whole: the first side with a spot it fits in, the nearest spot on that side
	for (const side of OUTSIDE_SIDES) {
		let best: { x: number; y: number; d: number } | null = null
		for (const s of spots) {
			if (s.side !== side || s.bottom - s.top < h) continue
			const y = yWhole(s)
			const d = away(s, y)
			if (!best || d < best.d) best = { x: s.x, y, d }
		}
		if (best) return { x: best.x, y: best.y, side, outside: true }
	}
	// cut: the tallest free stretch (the earlier side and the nearer spot on a tie)
	let cut: Spot | null = null
	for (const s of spots)
		if (!cut || s.bottom - s.top > cut.bottom - cut.top) cut = s
	if (!cut) return null
	return {
		x: cut.x,
		y: cut.top,
		side: cut.side,
		outside: true,
		maxHeight: cut.bottom - cut.top,
	}
}

/**
 * The host with the parts other surfaces lie over cut away (a layout can stack an island over a panel's edge):
 * an obstacle above the kept row lowers the top, one below it raises the bottom. One beside the row is left.
 */
export function hintRoom(
	host: HintRect,
	keep: HintRect,
	obstacles: readonly HintRect[],
): HintRect {
	let { top, bottom } = host
	for (const o of obstacles) {
		if (!hintRectsMeet(o, host)) continue
		if (o.bottom <= keep.top) top = Math.max(top, o.bottom)
		else if (o.top >= keep.bottom) bottom = Math.min(bottom, o.top)
	}
	return { left: host.left, right: host.right, top, bottom }
}

/** True when two rectangles overlap by more than `slack` px on both axes. */
export function hintRectsMeet(a: HintRect, b: HintRect, slack = 0): boolean {
	return (
		Math.min(a.right, b.right) - Math.max(a.left, b.left) > slack &&
		Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > slack
	)
}

/**
 * True when the layout an open hint was placed against has changed: another island moved or resized (a
 * transform transition ResizeObserver cannot see), one came or went, or the kept row or host moved. Two lists
 * of the same rectangles in the same order; a move under `slack` px (sub-pixel jitter) is no change.
 */
export function hintLayoutChanged(
	before: readonly HintRect[],
	after: readonly HintRect[],
	slack = 0.5,
): boolean {
	if (before.length !== after.length) return true
	return before.some((a, i) => {
		const b = after[i]
		return (
			b === undefined ||
			Math.abs(a.left - b.left) > slack ||
			Math.abs(a.top - b.top) > slack ||
			Math.abs(a.right - b.right) > slack ||
			Math.abs(a.bottom - b.bottom) > slack
		)
	})
}
