import type { AircraftState } from "@wavekit/api-types"
import { memoOne } from "../data/memo.js"
import { aircraftKey } from "../data/ring-buffer.js"
import type {
	AircraftEntry,
	AircraftLookup,
	AppState,
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
import { fitGroups, fitGroupsDetailed } from "../ui/fit.js"
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
import { cellWidth, sanitize, truncate, truncateLine } from "../ui/text.js"
import { formatMessage } from "../ui/messages/index.js"
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

/** Free text keeps at least this much room once segments must give way. */
const TEXT_RESERVE = 12
const SEP = "  "

/**
 * Fixed segments by priority, then the free text, which takes the rest and is
 * cut at the row end. When segments and text fit, nothing is reserved; when
 * segments are dropped, the `  …` marker ends the line (spec §5.2), never
 * sitting between the segments and the text (R52 m8).
 */
export function summaryLine(fm: FormattedMessage, width: number): Line {
	const groups: Group[] = fm.segments.map(s => ({
		priority: s.priority,
		variants: [[sp(s.text, s.role ?? "value")]],
	}))
	if (fm.text === undefined)
		return fitGroups(groups, width, { dropMarker: ellipsis() })
	// R76: a multi-line body reads on one row with each break as one space.
	const text = fm.text.replace(/\n+/g, " ")
	if (groups.length === 0) return [sp(truncate(text, width))]
	const textW = cellWidth(text)
	const reserve = SEP.length + Math.min(textW, TEXT_RESERVE)
	// The marker's width is part of the fit (R57); it is then moved to the end of the line.
	const marker = ellipsis()
	const fit = fitGroupsDetailed(groups, Math.max(0, width - reserve), {
		dropMarker: marker,
	})
	const dropped = fit.present.some(p => !p)
	// fitGroups appends [sep, marker] when it drops; strip exactly that pair (a truncated fit keeps its own …).
	const last = fit.line[fit.line.length - 1]
	const segs = dropped && last === marker ? fit.line.slice(0, -2) : fit.line
	const line: Line = [...segs, sp(SEP, "label"), sp(text)]
	if (dropped) line.push(sp(SEP, "label"), marker)
	return truncateLine(line, width)
}

const lookupFor = memoOne(
	(_version: number, map: Map<string, AircraftEntry>): AircraftLookup =>
		icao =>
			map.get(aircraftKey(icao))?.state,
)

/** A lookup over the live aircraft map, stable until the map's version changes (R62). */
export function aircraftLookup(state: AppState): AircraftLookup {
	return lookupFor(state.aircraft.version, state.aircraft.map)
}

const enriched = new WeakMap<
	MessageEntry,
	{ ac: AircraftState | undefined; fm: FormattedMessage }
>()

/** The ICAO an ADS-B entry is about, as the aircraft formatter reads it. */
function entryIcao(e: MessageEntry): string | undefined {
	const d = e.output.data
	if (typeof d !== "object" || d === null) return undefined
	const o = d as Record<string, unknown>
	const v = typeof o["icao"] === "string" ? o["icao"] : o["hex"]
	return typeof v === "string" ? v : undefined
}

/**
 * The summary to render. ADS-B entries re-read the aircraft map with `lookup`,
 * so registration, type and operator learned after ingest still show (R62,
 * spec §6.3); the formatter stays pure and the result is cached per entry
 * until that entry's own aircraft state changes, so one aircraft's update
 * re-formats only its rows (MUST 1, final review). Without a lookup: the
 * ingest-time summary.
 */
export function formattedFor(
	e: MessageEntry,
	lookup?: AircraftLookup,
): FormattedMessage {
	if (lookup === undefined || e.formatted.protocol !== "ADS-B")
		return e.formatted
	const icao = entryIcao(e)
	const ac = icao !== undefined ? lookup(icao) : undefined
	const hit = enriched.get(e)
	if (hit && hit.ac === ac) return hit.fm
	const fm = formatMessage(e.output, e.decoderId, lookup)
	enriched.set(e, { ac, fm })
	return fm
}

export function messageRow(
	e: MessageEntry,
	layout: readonly ColumnLayout[],
	selected: boolean,
	old: boolean,
	lookup?: AircraftLookup,
): Line {
	const roleOf = (r: Role): Role => (selected ? "selected" : old ? "old" : r)
	const summaryWidth = layout.find(c => c.id === "summary")?.width ?? 10
	const summary = summaryLine(formattedFor(e, lookup), summaryWidth)
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

export interface FeedCounts {
	in60s: number
	total: number
	cached: number
	/** The ring is full and its oldest entry is under 60 s old: in60s is a lower bound (R52 m6). */
	capped: boolean
}

export function feedCounts(ring: MessageRing, now: number): FeedCounts {
	let in60s = 0
	for (const e of ring.entries) if (e.receivedAt >= now - 60_000) in60s++
	const oldest = ring.entries[0]
	const capped =
		ring.entries.length >= ring.capacity &&
		oldest !== undefined &&
		oldest.receivedAt >= now - 60_000
	return { in60s, total: ring.total, cached: ring.entries.length, capped }
}

/** `3`, or `1000+` when the count is a lower bound. */
export function in60sText(c: FeedCounts): string {
	return c.capped ? `${c.in60s}+` : String(c.in60s)
}

/** Render at most maxRows feed rows, scrolled so the selected message stays visible. */
export function feedLines(
	rows: readonly FeedRow[],
	width: number,
	maxRows: number,
	selectedSeq: number | null,
	now: number,
	old: boolean,
	lookup?: AircraftLookup,
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
				: messageRow(r.entry, layout, r.entry.seq === selectedSeq, old, lookup),
		),
		shownSeqs: slice.flatMap(r => (r.kind === "msg" ? [r.entry.seq] : [])),
	}
}
