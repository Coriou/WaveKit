// Where the notice region sits: top centre of the free plot area, 8 px under the top island row, and below
// anything already at the top centre (the connection chip when it drops under the top row, and any overlay that
// marks itself with `data-wk-top-centre`). Pure, so it tests in node; the region feeds it measured boxes.

/** Room between the top row (or what sits under it) and the region. */
export const REGION_GAP = 8
/** The region's widest box (shell.css `.wk-notices`). */
export const REGION_MAX_W = 560
/** Height a region needs before the next participant: one touch-height toast. */
const REGION_MIN_H = 44

/** What the region stacks under: the connection chip and marked overlays. */
export const TOP_CENTRE_SELECTOR = ".wkf-conn-chip, [data-wk-top-centre]"

export interface Box {
	readonly top: number
	readonly bottom: number
	readonly left: number
	readonly right: number
}

/**
 * The region's top: `topRowBottom` + 8 px, pushed under each box that overlaps the region's column
 * ([cx − w/2, cx + w/2]) and starts above where the region would end.
 */
export function regionTop(
	topRowBottom: number,
	boxes: readonly Box[],
	cx: number,
	w: number,
): number {
	const left = cx - w / 2
	const right = cx + w / 2
	let top = topRowBottom + REGION_GAP
	for (const b of [...boxes].sort((a, c) => a.top - c.top)) {
		if (b.bottom <= b.top || b.right <= left || b.left >= right) continue
		if (b.bottom + REGION_GAP <= top) continue
		if (b.top >= top + REGION_MIN_H) continue
		top = b.bottom + REGION_GAP
	}
	return Math.round(top)
}
