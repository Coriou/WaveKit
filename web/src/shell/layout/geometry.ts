// Rectangles for the shell layout (./compute.ts): CSS px in the shell root, top-left origin.

export interface Size {
	readonly w: number
	readonly h: number
}

export interface Rect extends Size {
	readonly x: number
	readonly y: number
}

export const rect = (x: number, y: number, w: number, h: number): Rect => ({
	x,
	y,
	w,
	h,
})

export const right = (r: Rect): number => r.x + r.w
export const bottom = (r: Rect): number => r.y + r.h

/** The two rectangles share area (touching edges do not). */
export function intersects(a: Rect, b: Rect): boolean {
	return a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a)
}

/** The clear distance between two rectangles: the larger of the horizontal and vertical gaps, negative when they
 * overlap on both axes. */
export function separation(a: Rect, b: Rect): number {
	const dx = Math.max(b.x - right(a), a.x - right(b))
	const dy = Math.max(b.y - bottom(a), a.y - bottom(b))
	return Math.max(dx, dy)
}

/** `inner` lies inside `outer` shrunk by `margin` on every side. */
export function insideOf(inner: Rect, outer: Rect, margin = 0): boolean {
	return (
		inner.x >= outer.x + margin &&
		inner.y >= outer.y + margin &&
		right(inner) <= right(outer) - margin &&
		bottom(inner) <= bottom(outer) - margin
	)
}

/** `data-wk-rect`: "x,y,w,h", whole px. */
export const rectAttr = (r: Rect): string =>
	`${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`

/** The smallest rectangle holding both (a card's path from one home to the next). */
export function union(a: Rect, b: Rect): Rect {
	const x = Math.min(a.x, b.x)
	const y = Math.min(a.y, b.y)
	return rect(
		x,
		y,
		Math.max(right(a), right(b)) - x,
		Math.max(bottom(a), bottom(b)) - y,
	)
}
