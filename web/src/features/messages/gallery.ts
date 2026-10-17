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
	return dealStable(items, columns, height, () => "", null).columns
}

/**
 * dealColumns that keeps every card already placed (`placed`: key to column) in its column, so a live card arriving
 * on top does not move the others (each move remounts a card). Kept cards count first; the new ones then go, in
 * order, to the shortest column. Returns the placement of the cards dealt, for the next call.
 */
export function dealStable<T>(
	items: readonly T[],
	columns: number,
	height: (item: T) => number,
	key: (item: T) => string,
	placed: ReadonlyMap<string, number> | null,
): { columns: T[][]; placed: Map<string, number> } {
	const n = Math.max(1, Math.floor(columns))
	const col = new Array<number>(items.length).fill(-1)
	const tall = new Array<number>(n).fill(0)
	if (placed)
		items.forEach((item, i) => {
			const c = placed.get(key(item))
			if (c === undefined || c >= n) return
			col[i] = c
			tall[c] = (tall[c] ?? 0) + height(item) + GALLERY_GAP
		})
	items.forEach((item, i) => {
		if (col[i] !== -1) return
		let at = 0
		for (let c = 1; c < n; c++) if ((tall[c] ?? 0) < (tall[at] ?? 0)) at = c
		col[i] = at
		tall[at] = (tall[at] ?? 0) + height(item) + GALLERY_GAP
	})
	const out: T[][] = Array.from({ length: n }, () => [])
	const next = new Map<string, number>()
	items.forEach((item, i) => {
		const c = col[i] ?? 0
		out[c]?.push(item)
		next.set(key(item), c)
	})
	return { columns: out, placed: next }
}
