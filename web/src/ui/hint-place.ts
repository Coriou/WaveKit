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
}

export interface HintPlacement {
	readonly x: number
	readonly y: number
	readonly side: "above" | "below"
	/**
	 * Set only when neither side of the kept row has room for the whole bubble: the height it may take on the
	 * roomier side (px). The bubble's body scrolls within it; it never grows back over its row.
	 */
	readonly maxHeight?: number
}

export const HINT_INSET = 12
export const HINT_GAP = 6

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
 * capped to that side's room (`maxHeight`, its body scrolls): never over its own row.
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
	if (above >= box.top) return { x, y: Math.round(above), side: "above" }
	if (below + size.height <= box.bottom)
		return { x, y: Math.round(below), side: "below" }
	// neither fits: the roomier side, the bubble cut to its room (whole px, so rounding never reaches the row)
	const roomAbove = keep.top - gap - box.top
	const roomBelow = box.bottom - below
	const side = roomAbove >= roomBelow ? "above" : "below"
	const start = Math.ceil(side === "above" ? box.top : below)
	const end = Math.floor(side === "above" ? keep.top - gap : box.bottom)
	// a row that fills the host leaves no room: an empty bubble at the box edge, still off the row
	const y = Math.min(
		Math.max(start, Math.ceil(box.top)),
		Math.floor(box.bottom),
	)
	return { x, y, side, maxHeight: Math.max(0, end - y) }
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
