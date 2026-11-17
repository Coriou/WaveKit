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
 * in the host; below when above has no room; when neither fits, the roomier side clamped into the host.
 */
export function placeHint(input: HintPlaceInput): HintPlacement {
	const { keep, size } = input
	const gap = input.gap ?? HINT_GAP
	const box = hintBox(input.host, input.viewport, input.inset ?? HINT_INSET)
	const x = Math.max(
		box.left,
		Math.min(Math.max(keep.left, box.left), box.right - size.width),
	)
	const above = keep.top - gap - size.height
	const below = keep.bottom + gap
	const fitsAbove = above >= box.top
	const fitsBelow = below + size.height <= box.bottom
	const side =
		fitsAbove || (!fitsBelow && keep.top - box.top >= box.bottom - keep.bottom)
			? "above"
			: "below"
	const y =
		side === "above"
			? Math.max(above, box.top)
			: Math.max(box.top, Math.min(below, box.bottom - size.height))
	return { x: Math.round(x), y: Math.round(y), side }
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
