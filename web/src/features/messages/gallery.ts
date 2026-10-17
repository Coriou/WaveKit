// The Messages view (Messages board, gallery variant): decoded messages as cards in up to three columns of at least
// 340 px. Pure, so it tests in node: how many columns fit, and which card goes in which column.

export const GALLERY_COL_MIN = 340
export const GALLERY_GAP = 14
export const GALLERY_MAX_COLS = 3
/** Cards drawn at first, and added each time the end of the gallery comes into view. */
export const GALLERY_STEP = 60

/** Columns that fit in `width`: as many 340 px columns as fit, between one and three. */
export function galleryColumns(width: number): number {
	const n = Math.floor((width + GALLERY_GAP) / (GALLERY_COL_MIN + GALLERY_GAP))
	return Math.max(1, Math.min(GALLERY_MAX_COLS, n))
}

/**
 * Deals the cards into `columns` columns, newest first: each card goes to the shortest column so far (by the height
 * guess), the leftmost on a tie. The newest cards read across the top row; columns end close to each other.
 */
export function dealColumns<T>(
	items: readonly T[],
	columns: number,
	height: (item: T) => number,
): T[][] {
	const n = Math.max(1, Math.floor(columns))
	const out: T[][] = Array.from({ length: n }, () => [])
	const tall = new Array<number>(n).fill(0)
	for (const item of items) {
		let at = 0
		for (let c = 1; c < n; c++) if ((tall[c] ?? 0) < (tall[at] ?? 0)) at = c
		out[at]?.push(item)
		tall[at] = (tall[at] ?? 0) + height(item) + GALLERY_GAP
	}
	return out
}
