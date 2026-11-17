// Where the notice region sits: top centre of the free plot area, 8 px under the top island row, and below
// anything already at the top centre (the connection chip when it drops under the top row, and any overlay that
// marks itself with `data-wk-top-centre`). While Activity is expanded there is no free plot: `regionPlacement`
// finds empty room on the top row or in the drawer's header instead. Pure, so it tests in node; the region feeds it
// measured boxes.

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

/** Narrowest room the region takes outside the free plot: a short notice on one or two lines. */
export const REGION_MIN_W = 360
/** The shell's gutter (layout.ts `G`): the region keeps one from the islands, the controls and the window edge. */
const GUTTER = 16
/** One touch-height toast: the region's height before it is measured. */
const TOAST_H = 44

/** What sits on the expanded Activity drawer's row and in its header, measured in shell px. */
export interface ExpandedDrawer {
	/** The drawer's box: it spans the window between the island rows. */
	readonly drawer: Box
	/** The top-row islands (Tuner, Receiver: their live boxes, open panel included). */
	readonly topRow: readonly Box[]
	/** The drawer header's box, or null when it is not laid out. */
	readonly header: Box | null
	/** The header's controls (title, Live, Columns, ✕): the region keeps a gutter clear of each. */
	readonly headerControls: readonly Box[]
}

export interface PlacementInput {
	/** Shell width. */
	readonly W: number
	/** Bottom of the top island row. */
	readonly topRowBottom: number
	/** Centre of the free plot area (`--wk-free-cx`, else the shell's middle). */
	readonly freeCx: number
	/** What the region stacks under (TOP_CENTRE_SELECTOR). */
	readonly boxes: readonly Box[]
	/** Activity is expanded (Cards, full width): it covers the free plot, so there is none. */
	readonly expanded: ExpandedDrawer | null
	/** The region's measured height (px); one touch-height toast when omitted. */
	readonly height?: number
}

export interface Placement {
	/** Where it went: the free plot's top centre, the top row's widest gap, or the expanded drawer's header. */
	readonly where: "free-plot" | "top-row" | "drawer-head"
	/** The region's centre (shell px). */
	readonly cx: number
	/** Its widest box (px). */
	readonly maxW: number
	readonly top: number
}

/** The spans of [lo, hi] that no box (grown by `pad`) covers, widest first. */
export function freeSpans(
	lo: number,
	hi: number,
	boxes: readonly Box[],
	pad: number,
): { left: number; right: number }[] {
	let spans = [{ left: lo, right: hi }]
	for (const b of boxes) {
		const l = b.left - pad
		const r = b.right + pad
		spans = spans.flatMap(s =>
			r <= s.left || l >= s.right
				? [s]
				: [
						...(l > s.left ? [{ left: s.left, right: l }] : []),
						...(r < s.right ? [{ left: r, right: s.right }] : []),
					],
		)
	}
	return spans.sort((a, b) => b.right - b.left - (a.right - a.left))
}

/**
 * Where the notice region goes. Normally the top centre of the free plot area, 8 px under the top row and under
 * what is already there (`regionTop`). While Activity is expanded (Cards, full width) the drawer covers the whole
 * plot between the island rows, its cards and its header controls included, so the region looks for empty room
 * instead, in this order:
 * 1. the widest gap of the top island row (between the Tuner and the Receiver, or right of the Receiver, which
 *    stays where a full-height drawer would leave it), a gutter from each island and the window edge, when it is
 *    at least REGION_MIN_W wide: the region's top is the row's top, then under the connection chip if it sits
 *    there;
 * 2. else the widest empty stretch of the drawer's header (a gutter clear of the title, Live, Columns and ✕),
 *    when it is that wide: the region centred on the header's height;
 * 3. else the normal place (no room anywhere: a narrow window, where Expand changes nothing).
 */
export function regionPlacement(p: PlacementInput): Placement {
	const normal: Placement = {
		where: "free-plot",
		cx: p.freeCx,
		maxW: Math.max(0, Math.min(REGION_MAX_W, 2 * p.freeCx - 2 * GUTTER)),
		top: regionTop(p.topRowBottom, p.boxes, p.freeCx, REGION_MAX_W),
	}
	const x = p.expanded
	if (!x) return normal
	const row = x.topRow.filter(b => b.top < x.drawer.top)
	const gap = freeSpans(GUTTER, p.W - GUTTER, row, GUTTER)[0]
	if (gap && gap.right - gap.left >= REGION_MIN_W) {
		const w = Math.min(REGION_MAX_W, gap.right - gap.left)
		const cx = Math.round((gap.left + gap.right) / 2)
		return {
			where: "top-row",
			cx,
			maxW: Math.floor(w),
			top: regionTop(GUTTER - REGION_GAP, p.boxes, cx, w),
		}
	}
	const h = x.header
	if (h) {
		const span = freeSpans(
			h.left + GUTTER,
			h.right - GUTTER,
			x.headerControls,
			GUTTER,
		)[0]
		if (span && span.right - span.left >= REGION_MIN_W)
			return {
				where: "drawer-head",
				cx: Math.round((span.left + span.right) / 2),
				maxW: Math.floor(Math.min(REGION_MAX_W, span.right - span.left)),
				top: Math.round(
					h.top + Math.max(0, (h.bottom - h.top - (p.height || TOAST_H)) / 2),
				),
			}
	}
	return normal
}
