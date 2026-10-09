import { sp, type Line } from "../ui/line.js"
import { padEnd } from "../ui/text.js"
import { LABEL_WIDTH } from "./detail.js"

/** A view row; `drop` rows may go when the view is short, highest number first. */
export interface Row {
	line: Line
	drop?: number
	/** Blank separator: never counted as hidden content. */
	gap?: boolean
	/** Hidden rows of a group fold into that group's own "+N more" marker. */
	group?: string
	/** A section head that stays while any row can still go (CORE, AUDIO, …). */
	essential?: boolean
}

export const keep = (line: Line): Row => ({ line })
export const essential = (line: Line): Row => ({ line, essential: true })
export const optional = (line: Line, drop: number): Row => ({ line, drop })
export const gapRow = (drop: number): Row => ({ line: [], drop, gap: true })
export const grouped = (line: Line, group: string, drop?: number): Row =>
	drop === undefined ? { line, group } : { line, drop, group }

/** Items of a group never rendered (beyond its cap), counted into its marker. */
export type GroupHidden = Readonly<Record<string, number>>

const markerLine = (text: string): Line => [
	sp(padEnd("", LABEL_WIDTH), "label"),
	sp(text, "label"),
]
export const moreMarker = (n: number): Line => markerLine(`+${n} more`)
export const hiddenMarker = (n: number): Line =>
	markerLine(`+${n} row${n === 1 ? "" : "s"} hidden`)

interface Layout {
	lines: Line[]
	/** Hidden rows outside groups (already in the trailing marker, if any). */
	hidden: number
	/** Every hidden row and capped item, groups included: the combined marker's count. */
	total: number
}

function layout(
	rows: readonly Row[],
	shown: readonly boolean[],
	capped: GroupHidden,
): Layout {
	const lastOf = new Map<string, number>()
	rows.forEach((r, i) => {
		if (r.group !== undefined) lastOf.set(r.group, i)
	})
	const hiddenIn = new Map<string, number>(Object.entries(capped))
	let hidden = 0
	rows.forEach((r, i) => {
		if (shown[i] || r.gap === true) return
		if (r.group !== undefined)
			hiddenIn.set(r.group, (hiddenIn.get(r.group) ?? 0) + 1)
		else hidden++
	})
	const lines: Line[] = []
	rows.forEach((r, i) => {
		if (shown[i]) lines.push(r.line)
		const g = r.group
		if (g !== undefined && lastOf.get(g) === i) {
			const n = hiddenIn.get(g) ?? 0
			if (n > 0) lines.push(moreMarker(n))
		}
	})
	// Capped items of a group with no rows at all still get their marker, at the end.
	for (const [g, n] of hiddenIn)
		if (!lastOf.has(g) && n > 0) lines.push(moreMarker(n))
	if (hidden > 0) lines.push(hiddenMarker(hidden))
	let total = hidden
	for (const n of hiddenIn.values()) total += n
	return { lines, hidden, total }
}

/** Index of the next row to hide: highest `drop`, the last such row on ties. */
function nextDroppable(
	rows: readonly Row[],
	shown: readonly boolean[],
): number {
	let pick = -1
	rows.forEach((r, i) => {
		if (!shown[i] || r.drop === undefined) return
		const best = pick < 0 ? undefined : rows[pick]?.drop
		if (best === undefined || r.drop >= best) pick = i
	})
	return pick
}

/** The last shown row that is neither droppable nor essential (checked after droppables). */
function nextKept(rows: readonly Row[], shown: readonly boolean[]): number {
	for (let i = rows.length - 1; i >= 0; i--)
		if (shown[i] && rows[i]?.essential !== true && rows[i]?.gap !== true)
			return i
	return -1
}

/**
 * When only essential heads remain: the middle heads go first (nearest the end), then
 * the first; the last head (CORE, FANOUT) stays (I4).
 */
function nextEssential(
	rows: readonly Row[],
	shown: readonly boolean[],
): number {
	const heads = rows
		.map((r, i) => (shown[i] && r.essential === true ? i : -1))
		.filter(i => i >= 0)
	if (heads.length <= 1) return -1
	return heads.length > 2 ? (heads[heads.length - 2] ?? -1) : (heads[0] ?? -1)
}

/**
 * Fit rows to `height` (spec §5.1) without hiding anything silently:
 * 1. shed droppable rows, highest `drop` first (the last such row on ties);
 * 2. then plain kept rows, last first;
 * 3. then essential heads, middle ones first, keeping the last head.
 * A group's hidden rows fold into its "+N more" marker; any other hidden row is
 * counted in one "+N rows hidden" line at the end. When only heads are left and the
 * markers still do not fit, they fold into one combined "+N rows hidden" before any
 * head is cut (never hidden silently); at height 1 the last head alone stays.
 */
export function shed(
	rows: readonly Row[],
	height: number,
	capped: GroupHidden = {},
): Line[] {
	if (height <= 0) return []
	const shown = rows.map(() => true)
	for (;;) {
		const out = layout(rows, shown, capped)
		if (out.lines.length <= height) return out.lines
		let pick = nextDroppable(rows, shown)
		if (pick < 0) pick = nextKept(rows, shown)
		if (pick < 0) {
			// Only heads are left: before cutting one, fold every marker into one line.
			const heads = rows.filter((r, i) => shown[i] && r.gap !== true)
			if (out.total > 0 && heads.length + 1 <= height)
				return [...heads.map(r => r.line), hiddenMarker(out.total)]
			pick = nextEssential(rows, shown)
		}
		if (pick >= 0) {
			shown[pick] = false
			continue
		}
		const head = rows.find((r, i) => shown[i] && r.gap !== true)
		return head ? [head.line] : out.lines.slice(0, height)
	}
}
