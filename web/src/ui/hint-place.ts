// Where a hint bubble goes (docs/web/DESIGN.md, Hints): inside the surface that holds its mark, never over the
// row it explains. Pure: rectangles in, a position out, no DOM.

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
}

export interface HintPlacement {
	readonly x: number
	readonly y: number
	/** `none`: no side of the kept row has room for even the shortest cut; the bubble is not shown. */
	readonly side: "above" | "below" | "none"
	/**
	 * Set only when neither side of the kept row has room for the whole bubble: the height it may take on the
	 * roomier side (px). The bubble's body scrolls within it; it never grows back over its row.
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
 * side is shorter than `minHeight` (a row that fills its host), `side: "none"`: no sliver is drawn.
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
	if (maxHeight < Math.max(1, Math.ceil(input.minHeight ?? 0)))
		return { x, y, side: "none" }
	return { x, y, side, maxHeight }
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
