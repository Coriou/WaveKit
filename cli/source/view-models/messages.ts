import type { AppState, MessageEntry, MessageRing } from "../data/types.js"
import { applyFilter, parseFilter, type FilterSubject } from "../ui/filter.js"
import {
	formatAge,
	formatClock,
	formatClockMs,
	formatClockShort,
	formatMHz,
} from "../ui/format.js"
import { listBudget, type DetailPlacement } from "../ui/frame.js"
import { sp, type Line, type Span } from "../ui/line.js"
import { detailJson } from "../ui/messages/index.js"
import { cellWidth, padEnd, sanitize, truncate } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { MessagesUi, UiState } from "../ui/ui-state.js"
import { stripInput } from "./chrome.js"
import {
	feedCounts,
	feedLines,
	interleave,
	newestFirst,
	type FeedRow,
} from "./message-rows.js"

/** Section title column; the same 10 columns as the detail panes' LABEL_WIDTH (Task 39). */
const TITLE_WIDTH = 10

export interface FeedView {
	rows: FeedRow[]
	visible: MessageEntry[]
	matching: number
	total: number
	newCount: number
}

const subject = (e: MessageEntry): FilterSubject => ({
	text: `${e.decoderId} ${e.formatted.protocol} ${e.formatted.searchText}`,
	emergency: e.formatted.emergency,
	category: e.formatted.category,
})

/** Pause freezes the slice at pausedAtSeq; evicted rows simply disappear, nothing is replaced in place (spec §6.3). */
export function feedView(ring: MessageRing, mu: MessagesUi): FeedView {
	const entries = newestFirst(ring)
	const matched = applyFilter(
		entries,
		parseFilter(mu.filterText),
		mu.preset,
		subject,
	)
	const cut = mu.following || mu.pausedAtSeq === null ? null : mu.pausedAtSeq
	const visible = cut === null ? matched : matched.filter(e => e.seq <= cut)
	const newCount = cut === null ? 0 : matched.length - visible.length
	return {
		rows: interleave(visible, ring.gaps),
		visible,
		matching: matched.length,
		total: entries.length,
		newCount,
	}
}

const sepText = (): string => ` ${glyphs().sep} `
const title = (): Span => sp(padEnd("MESSAGES", TITLE_WIDTH), "label", true)

export function messagesHeader(
	state: AppState,
	mu: MessagesUi,
	fv: FeedView,
): Line {
	const sep = sepText()
	const parts: string[] = []
	if (!mu.following) parts.push(`paused${sep}${fv.newCount} new`)
	// User text is sanitised like any payload: a pasted escape must not reach the terminal.
	if (mu.filterText !== "") parts.push(`filter ${sanitize(mu.filterText)}`)
	if (mu.preset !== "all") {
		const st = state.aircraft.stats.value
		parts.push(
			mu.preset === "aircraft" && st
				? `preset aircraft${sep}${st.aircraftCount} tracked${sep}${st.withPosition} with position`
				: `preset ${mu.preset}`,
		)
	}
	const c = feedCounts(state.messages.ring, state.now)
	if (mu.filterText !== "" || mu.preset !== "all")
		parts.push(`${fv.matching} of ${fv.total}`)
	else if (
		state.conn.ws.state !== "open" &&
		state.conn.ws.since !== null &&
		c.cached > 0
	)
		parts.push(
			`feed stopped ${formatClock(state.conn.ws.since)}${sep}${c.cached} cached`,
		)
	else if (mu.following) parts.push(`${c.in60s} in 60s${sep}${c.total} total`)
	return [title(), sp(parts.join(sep), "label")]
}

/** The filter input row: `/ <draft>▏`, clipped from the left so the cursor stays visible. */
export function inputLine(draft: string, width: number): Line {
	const room = Math.max(1, width - 2 - cellWidth(glyphs().cursor))
	const text = sanitize(draft)
	const chars = [...text]
	let start = 0
	while (start < chars.length && cellWidth(chars.slice(start).join("")) > room)
		start++
	return [
		sp("/ ", "accent"),
		sp(chars.slice(start).join(""), "accent"),
		sp(glyphs().cursor, "accent"),
	]
}

/**
 * Spec §6.3 empty states. "no decodes since" is claimed only while the feed is
 * live; a stopped or never-opened socket says so instead (truth rules, §2).
 */
function emptyLine(state: AppState, mu: MessagesUi, fv: FeedView): Line {
	const sep = sepText()
	if (fv.total > 0) {
		const what = [
			sanitize(mu.filterText),
			...(mu.preset !== "all" ? [`preset ${mu.preset}`] : []),
		]
			.filter(x => x !== "")
			.join(" ")
		return [sp(`0 of ${fv.total} match "${what}"`, "label")]
	}
	const ws = state.conn.ws
	if (ws.state !== "open") {
		// An open gap is the evidence the feed ran; failed connects also read "closed".
		const gap = state.messages.ring.gaps.at(-1)
		return [
			sp(
				gap !== undefined && gap.to === null
					? `no decodes cached${sep}feed stopped ${formatClock(gap.from)}`
					: `no decodes${sep}feed not connected yet`,
				"label",
			),
		]
	}
	// One rule with the strip for "in window" and the rx centre.
	const strip = stripInput(state)
	const since = ws.since ?? state.now
	const d = strip.decoders
	return [
		sp(
			[
				`no decodes since ${formatClockShort(since)} (${formatAge(state.now - since)})`,
				...(d !== null && d.inWindow !== null
					? [`${d.inWindow} of ${d.total} decoders in window`]
					: []),
				...(strip.rx !== null ? [`rx ${formatMHz(strip.rx.centreHz)}`] : []),
			].join(sep),
			"label",
		),
	]
}

/** Label/value groups packed three spaces apart, wrapping to the pane width. */
function packFields(
	fields: MessageEntry["formatted"]["fields"],
	width: number,
): Line[] {
	const out: Line[] = []
	let cur: Line = []
	let used = 0
	for (const f of fields) {
		const w = cellWidth(f.label) + 1 + cellWidth(f.value)
		if (used > 0 && used + 3 + w > width) {
			out.push(cur)
			cur = []
			used = 0
		}
		if (used > 0) {
			cur.push(sp("   ", "label"))
			used += 3
		}
		const room = Math.max(1, width - used - cellWidth(f.label) - 1)
		cur.push(
			sp(`${f.label} `, "label"),
			sp(truncate(f.value, room), f.attention === true ? "attention" : "value"),
		)
		used += cellWidth(f.label) + 1 + Math.min(cellWidth(f.value), room)
	}
	if (cur.length > 0) out.push(cur)
	return out
}

/** Head row, protocol fields, then the bounded JSON; at most `height` lines, scroll clamped to the last page. */
export function messageDetail(
	e: MessageEntry,
	width: number,
	height: number,
	scroll: number,
): Line[] {
	const sep = sepText()
	const head: Line = [
		sp(
			truncate(
				`${sanitize(e.decoderId)}${sep}${sanitize(e.output.type)}${sep}${formatClockMs(e.receivedAt)}`,
				width,
			),
			"value",
			true,
		),
	]
	const body: Line[] = [
		...packFields(e.formatted.fields, width),
		...detailJson(e.output.data).map(l => [sp(truncate(l, width), "label")]),
	]
	const rows = Math.max(0, height - 1)
	const start = Math.min(Math.max(0, scroll), Math.max(0, body.length - rows))
	return height <= 0 ? [] : [head, ...body.slice(start, start + rows)]
}

export interface MessagesModel {
	header: Line
	input: Line | null
	list: Line[]
	detail: Line[] | null
	placement: DetailPlacement
	listWidth: number
	detailWidth: number
	rowIds: string[]
	pageSize: number
	selected: MessageEntry | null
}

export function messagesModel(
	state: AppState,
	ui: UiState,
	width: number,
	height: number,
	roomy: boolean,
): MessagesModel {
	const mu = ui.messages
	const fv = feedView(state.messages.ring, mu)
	const selSeq =
		ui.selected.messages === null ? null : Number(ui.selected.messages)
	const selected = fv.visible.find(e => e.seq === selSeq) ?? null
	const open = ui.detail.messages.open && selected !== null
	const headerRows = mu.draft !== null ? 2 : 1
	const b = listBudget(width + 1, height, roomy, headerRows, open)
	const listWidth =
		open && b.placement.kind === "right" ? width - b.placement.width - 2 : width
	const detailWidth = b.placement.kind === "right" ? b.placement.width : width
	const old = state.conn.ws.state !== "open"
	const feed = (rows: readonly FeedRow[]): Line[] =>
		feedLines(
			rows,
			listWidth,
			b.listRows,
			selected?.seq ?? null,
			state.now,
			old,
		).lines
	// No message rows: the explanation always shows. Gap rows stay above it only
	// when nothing was ever received; under a filter they would be noise.
	const list =
		open && b.placement.kind === "overlay"
			? []
			: fv.visible.length > 0
				? feed(fv.rows)
				: [
						...(fv.total === 0 ? feed(fv.rows) : []),
						emptyLine(state, mu, fv),
					].slice(-Math.max(1, b.listRows))
	// A bottom detail under a short list takes the rows the list leaves free
	// (body = list + 1 blank + detail); a full list leaves it b.detailRows.
	const detailRows =
		b.placement.kind === "bottom"
			? Math.max(b.detailRows, height - headerRows - list.length - b.gapRows)
			: b.detailRows
	return {
		header: messagesHeader(state, mu, fv),
		input: mu.draft !== null ? inputLine(mu.draft, width) : null,
		list,
		detail:
			open && selected
				? messageDetail(
						selected,
						detailWidth,
						detailRows,
						ui.detail.messages.scroll,
					)
				: null,
		placement: b.placement,
		listWidth,
		detailWidth,
		rowIds: fv.visible.map(e => String(e.seq)),
		pageSize: Math.max(1, b.listRows),
		selected,
	}
}
