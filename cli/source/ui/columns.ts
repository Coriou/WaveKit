import type { Cell, Line } from "./line.js"
import { lineWidth, truncateLine } from "./text.js"

export interface ColumnSpec {
	id: string
	min: number
	pref: number
	priority: number
	align: "left" | "right"
	flex?: boolean
	header: Cell
}

export interface ColumnLayout {
	id: string
	width: number
	align: "left" | "right"
}

/**
 * Spec §5.2: (1) include all, remove the highest priority number (rightmost on
 * ties) until Σmin + gaps fits; (2) grow toward pref in priority order;
 * (3) leftover to the flex column.
 */
export function layoutColumns(
	width: number,
	columns: readonly ColumnSpec[],
	gap = 2,
): ColumnLayout[] {
	const present = columns.map(() => true)
	const sumMin = (): number => {
		let w = 0
		let n = 0
		columns.forEach((c, i) => {
			if (present[i]) {
				w += c.min
				n++
			}
		})
		return w + Math.max(0, n - 1) * gap
	}
	const removal = columns
		.map((c, i) => ({ p: c.priority, i }))
		.sort((a, b) => b.p - a.p || b.i - a.i)
	for (const { i } of removal) {
		if (sumMin() <= width) break
		present[i] = false
	}
	const widths = columns.map(c => c.min)
	let remaining = Math.max(0, width - sumMin())
	const grow = columns
		.map((c, i) => ({ p: c.priority, i }))
		.sort((a, b) => a.p - b.p || a.i - b.i)
	for (const { i } of grow) {
		const c = columns[i]
		if (!present[i] || !c || remaining <= 0) continue
		const add = Math.min(c.pref - c.min, remaining)
		if (add > 0) {
			widths[i] = (widths[i] ?? c.min) + add
			remaining -= add
		}
	}
	const flexIdx = columns.findIndex((c, i) => present[i] && c.flex === true)
	if (flexIdx >= 0 && remaining > 0)
		widths[flexIdx] = (widths[flexIdx] ?? 0) + remaining
	const out: ColumnLayout[] = []
	columns.forEach((c, i) => {
		if (present[i])
			out.push({ id: c.id, width: widths[i] ?? c.min, align: c.align })
	})
	return out
}

/** Richest variant (variants are minimal → rich) that fits; else the minimal one cut with an ellipsis. */
export function pickVariant(c: Cell, widthIn: number): Line {
	const width = Math.max(0, widthIn)
	for (let v = c.variants.length - 1; v >= 0; v--) {
		const line = c.variants[v]
		if (line && lineWidth(line) <= width) return line
	}
	return truncateLine(c.variants[0] ?? [], width)
}

export function padCell(
	line: Line,
	widthIn: number,
	align: "left" | "right",
): Line {
	const width = Math.max(0, widthIn)
	const cut = truncateLine(line, width)
	const pad = width - lineWidth(cut)
	if (pad <= 0) return cut
	const spaces = { text: " ".repeat(pad), role: "value" as const }
	return align === "right" ? [spaces, ...cut] : [...cut, spaces]
}

const EMPTY: Cell = { variants: [[]] }

export function renderRow(
	layout: readonly ColumnLayout[],
	cells: Readonly<Record<string, Cell>>,
	gap = 2,
): Line {
	const out: Line = []
	layout.forEach((col, k) => {
		if (k > 0) out.push({ text: " ".repeat(gap), role: "value" })
		out.push(
			...padCell(
				pickVariant(cells[col.id] ?? EMPTY, col.width),
				col.width,
				col.align,
			),
		)
	})
	return out
}

export function renderHeader(
	layout: readonly ColumnLayout[],
	columns: readonly ColumnSpec[],
	gap = 2,
): Line {
	const cells: Record<string, Cell> = {}
	for (const c of columns) cells[c.id] = c.header
	return renderRow(layout, cells, gap)
}
