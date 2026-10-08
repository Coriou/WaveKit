import { sp, type Line } from "../ui/line.js"
import { padEnd } from "../ui/text.js"

/** A view row; `drop` rows may go when the view is short, highest number first. */
export interface Row {
	line: Line
	drop?: number
	/** Blank separator: never counted as hidden content. */
	gap?: boolean
	/** Hidden rows of a group fold into that group's own "+N more" marker. */
	group?: string
}

export const keep = (line: Line): Row => ({ line })
export const optional = (line: Line, drop: number): Row => ({ line, drop })
export const gapRow = (drop: number): Row => ({ line: [], drop, gap: true })
export const grouped = (line: Line, group: string, drop?: number): Row =>
	drop === undefined ? { line, group } : { line, drop, group }

/** Items of a group never rendered (beyond its cap), counted into its marker. */
export type GroupHidden = Readonly<Record<string, number>>

const LABEL_W = 10
const markerLine = (text: string): Line => [
	sp(padEnd("", LABEL_W), "label"),
	sp(text, "label"),
]
export const moreMarker = (n: number): Line => markerLine(`+${n} more`)
export const hiddenMarker = (n: number): Line =>
	markerLine(`+${n} row${n === 1 ? "" : "s"} hidden`)

function layout(
	rows: readonly Row[],
	shown: readonly boolean[],
	capped: GroupHidden,
): Line[] {
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
	const out: Line[] = []
	rows.forEach((r, i) => {
		if (shown[i]) out.push(r.line)
		const g = r.group
		if (g !== undefined && lastOf.get(g) === i) {
			const n = hiddenIn.get(g) ?? 0
			if (n > 0) out.push(moreMarker(n))
		}
	})
	if (hidden > 0) out.push(hiddenMarker(hidden))
	return out
}

/**
 * Fit rows to `height` (spec §5.1): shed droppable rows, highest `drop` first (the
 * last such row on ties), and never hide content silently: a group's hidden rows
 * fold into its "+N more" marker, any other hidden rows into one "+N rows hidden"
 * line at the end. Rows without `drop` stay; if they alone overflow, the tail is cut.
 */
export function shed(
	rows: readonly Row[],
	height: number,
	capped: GroupHidden = {},
): Line[] {
	const shown = rows.map(() => true)
	for (;;) {
		const lines = layout(rows, shown, capped)
		if (lines.length <= height) return lines
		let pick = -1
		rows.forEach((r, i) => {
			if (!shown[i] || r.drop === undefined) return
			const best = pick < 0 ? undefined : rows[pick]?.drop
			if (best === undefined || r.drop >= best) pick = i
		})
		if (pick < 0) return lines.slice(0, Math.max(0, height))
		shown[pick] = false
	}
}
