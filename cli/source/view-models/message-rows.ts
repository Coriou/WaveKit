import type {
	FormattedMessage,
	Gap,
	MessageEntry,
	MessageRing,
} from "../data/types.js"
import {
	layoutColumns,
	renderRow,
	type ColumnLayout,
	type ColumnSpec,
} from "../ui/columns.js"
import { fitGroups } from "../ui/fit.js"
import { formatAge, formatClock, formatClockShort } from "../ui/format.js"
import {
	cell,
	sp,
	type Cell,
	type Group,
	type Line,
	type Role,
	type Span,
} from "../ui/line.js"
import { lineWidth, sanitize, truncate, truncateLine } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"

const hdr = (v: string): Cell => ({ variants: [[sp(v, "label")]] })

/** Spec §5.3: time 5/8 [0] (HH:MM below pref) · decoder 10/12 [0] · type 6/6 [3] · summary flex min 10 [0]. */
export const MESSAGE_COLUMNS: ColumnSpec[] = [
	{ id: "time", min: 5, pref: 8, priority: 0, align: "left", header: hdr("") },
	{
		id: "decoder",
		min: 10,
		pref: 12,
		priority: 0,
		align: "left",
		header: hdr(""),
	},
	{ id: "type", min: 6, pref: 6, priority: 3, align: "left", header: hdr("") },
	{
		id: "summary",
		min: 10,
		pref: 10,
		priority: 0,
		align: "left",
		flex: true,
		header: hdr(""),
	},
]

/** Narrow width class (spec §6.1 60×20): no type column, minimal time. */
const NARROW_MESSAGE_COLUMNS: ColumnSpec[] = [
	{ id: "time", min: 5, pref: 5, priority: 0, align: "left", header: hdr("") },
	{
		id: "decoder",
		min: 10,
		pref: 11,
		priority: 0,
		align: "left",
		header: hdr(""),
	},
	{
		id: "summary",
		min: 10,
		pref: 10,
		priority: 0,
		align: "left",
		flex: true,
		header: hdr(""),
	},
]

export function messageLayout(width: number): ColumnLayout[] {
	return layoutColumns(
		width,
		width < 79 ? NARROW_MESSAGE_COLUMNS : MESSAGE_COLUMNS,
	)
}

export type FeedRow =
	| { kind: "msg"; entry: MessageEntry }
	| { kind: "gap"; gap: Gap }

export function newestFirst(ring: MessageRing): MessageEntry[] {
	return [...ring.entries].reverse()
}

/** A gap with afterSeq k sits between entries k+1 (above) and k (below); newest first. */
export function interleave(
	entries: readonly MessageEntry[],
	gaps: readonly Gap[],
): FeedRow[] {
	const pending = [...gaps].sort((a, b) => b.afterSeq - a.afterSeq)
	const out: FeedRow[] = []
	for (const entry of entries) {
		while (pending.length > 0 && (pending[0]?.afterSeq ?? -1) >= entry.seq) {
			const g = pending.shift()
			if (g) out.push({ kind: "gap", gap: g })
		}
		out.push({ kind: "msg", entry })
	}
	for (const g of pending) out.push({ kind: "gap", gap: g })
	return out
}

const ellipsis = (): Span => ({ text: glyphs().ellipsis, role: "label" })

/** Fixed segments by priority (dropping is marked with "  …"); free text takes the rest and is cut at the row end. */
export function summaryLine(fm: FormattedMessage, width: number): Line {
	const groups: Group[] = fm.segments.map(s => ({
		priority: s.priority,
		variants: [[sp(s.text, s.role ?? "value")]],
	}))
	if (fm.text === undefined)
		return fitGroups(groups, width, { dropMarker: ellipsis() })
	if (groups.length === 0) return [sp(truncate(fm.text, width))]
	const fixed = fitGroups(groups, Math.max(0, width - 12), {
		dropMarker: ellipsis(),
	})
	const rest = width - lineWidth(fixed) - 2
	return rest > 0
		? truncateLine(
				[...fixed, sp("  ", "label"), sp(truncate(fm.text, rest))],
				width,
			)
		: fixed
}

export function messageRow(
	e: MessageEntry,
	layout: readonly ColumnLayout[],
	selected: boolean,
	old: boolean,
): Line {
	const roleOf = (r: Role): Role => (selected ? "selected" : old ? "old" : r)
	const summaryWidth = layout.find(c => c.id === "summary")?.width ?? 10
	const summary = summaryLine(e.formatted, summaryWidth)
	const cells: Record<string, Cell> = {
		time: cell(
			[sp(formatClockShort(e.receivedAt), roleOf("label"))],
			[sp(formatClock(e.receivedAt), roleOf("label"))],
		),
		// Ids come from the server: sanitised like any payload (review focus 4).
		decoder: cell([sp(sanitize(e.decoderId), roleOf("value"))]),
		type: cell([sp(e.formatted.protocol, roleOf("label"))]),
		summary: cell(
			old ? summary.map(x => ({ ...x, role: "old" as const })) : summary,
		),
	}
	return renderRow(layout, cells)
}

export function gapLine(g: Gap, now: number, width: number): Line {
	const rule = glyphs().gap.repeat(2)
	const sep = glyphs().sep
	const text =
		g.to === null
			? `${rule} gap since ${formatClock(g.from)} ${sep} ${formatAge(now - g.from)} ${rule}`
			: `${rule} gap ${formatClock(g.from)}${glyphs().range}${formatClock(g.to)} ${sep} ${formatAge(g.to - g.from)} ${sep} not replayed ${rule}`
	return [sp(truncate(text, width), "label")]
}

export function feedCounts(
	ring: MessageRing,
	now: number,
): { in60s: number; total: number; cached: number } {
	let in60s = 0
	for (const e of ring.entries) if (e.receivedAt >= now - 60_000) in60s++
	return { in60s, total: ring.total, cached: ring.entries.length }
}

/** Render at most maxRows feed rows, scrolled so the selected message stays visible. */
export function feedLines(
	rows: readonly FeedRow[],
	width: number,
	maxRows: number,
	selectedSeq: number | null,
	now: number,
	old: boolean,
): { lines: Line[]; shownSeqs: number[] } {
	const layout = messageLayout(width)
	const sel =
		selectedSeq === null
			? -1
			: rows.findIndex(r => r.kind === "msg" && r.entry.seq === selectedSeq)
	const start = sel < maxRows ? 0 : sel - maxRows + 1
	const slice = rows.slice(start, start + Math.max(0, maxRows))
	return {
		lines: slice.map(r =>
			r.kind === "gap"
				? gapLine(r.gap, now, width)
				: messageRow(r.entry, layout, r.entry.seq === selectedSeq, old),
		),
		shownSeqs: slice.flatMap(r => (r.kind === "msg" ? [r.entry.seq] : [])),
	}
}
