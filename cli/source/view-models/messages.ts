import type { AppState, Gap, MessageEntry, MessageRing } from "../data/types.js"
import { applyFilter, parseFilter, type FilterSubject } from "../ui/filter.js"
import {
	formatAge,
	formatClock,
	formatClockMs,
	formatClockShort,
	formatMHz,
} from "../ui/format.js"
import { listBudget, type DetailPlacement } from "../ui/frame.js"
import { fitGroups } from "../ui/fit.js"
import { sp, type Group, type Line, type Span } from "../ui/line.js"
import { detailJson } from "../ui/messages/index.js"
import { cellWidth, charWidth, padEnd, sanitize, truncate } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { MessagesUi, UiState } from "../ui/ui-state.js"
import { stripInput } from "./chrome.js"
import { LABEL_WIDTH } from "./detail.js"
import {
	feedCounts,
	feedLines,
	in60sText,
	interleave,
	newestFirst,
	type FeedRow,
} from "./message-rows.js"

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

/**
 * Pause freezes the slice at pausedAtSeq; evicted rows simply disappear, nothing
 * is replaced in place (spec §6.3). A pause with nothing to freeze at (an empty
 * list) freezes an empty slice, so header and rows agree (M4).
 */
export function feedView(ring: MessageRing, mu: MessagesUi): FeedView {
	const entries = newestFirst(ring)
	const matched = applyFilter(
		entries,
		parseFilter(mu.filterText),
		mu.preset,
		subject,
	)
	const cut = mu.following ? null : (mu.pausedAtSeq ?? -1)
	const visible = cut === null ? matched : matched.filter(e => e.seq <= cut)
	const newCount = cut === null ? 0 : matched.length - visible.length
	// M5: a gap above the newest frozen row (afterSeq > cut) opened after the pause.
	const gaps =
		cut === null ? ring.gaps : ring.gaps.filter(g => g.afterSeq <= cut)
	return {
		rows: interleave(visible, gaps),
		visible,
		matching: matched.length,
		total: entries.length,
		newCount,
	}
}

const sepText = (): string => ` ${glyphs().sep} `
const title = (): Span => sp(padEnd("MESSAGES", LABEL_WIDTH), "label", true)
const labelGroup = (priority: number, ...variants: string[]): Group => ({
	priority,
	variants: variants.map(v => [sp(v, "label")]),
})

/** The open gap at the top of the ring: evidence the feed ran and when it stopped. */
function openGap(ring: MessageRing): Gap | null {
	const last = ring.gaps.at(-1)
	return last !== undefined && last.to === null ? last : null
}

/**
 * Spec §6.3 header, fitted to `width` (M6): the pause and the counts never drop;
 * the filter text shrinks, then goes. Counts are claimed only for a live feed
 * (I1); a stopped feed says when, from its gap (I2); a full ring reads 1000+ (I4).
 */
export function messagesHeader(
	state: AppState,
	mu: MessagesUi,
	fv: FeedView,
	width: number,
): Line {
	const sep = sepText()
	const groups: Group[] = []
	if (!mu.following)
		groups.push(labelGroup(0, `paused${sep}${fv.newCount} new`))
	// User text is sanitised like any payload: a pasted escape must not reach the terminal.
	if (mu.filterText !== "") {
		const f = sanitize(mu.filterText)
		groups.push(labelGroup(3, `filter ${truncate(f, 16)}`, `filter ${f}`))
	}
	if (mu.preset !== "all") {
		const st = state.aircraft.stats.value
		groups.push(
			mu.preset === "aircraft" && st
				? labelGroup(
						2,
						"preset aircraft",
						`preset aircraft${sep}${st.aircraftCount} tracked${sep}${st.withPosition} with position`,
					)
				: labelGroup(2, `preset ${mu.preset}`),
		)
	}
	const ring = state.messages.ring
	const c = feedCounts(ring, state.now)
	const gap = openGap(ring)
	const counts =
		mu.filterText !== "" || mu.preset !== "all"
			? `${fv.matching} of ${fv.total}`
			: state.conn.ws.state === "open"
				? mu.following
					? `${in60sText(c)} in 60s${sep}${c.total} total`
					: null
				: gap !== null
					? `feed stopped ${formatClock(gap.from)}${sep}${c.cached} cached`
					: "live feed connecting"
	if (counts !== null) groups.push(labelGroup(0, counts))
	return [
		title(),
		...fitGroups(groups, Math.max(1, width - LABEL_WIDTH), { sep }),
	]
}

/**
 * The filter input row: `/ <draft>▏`, clipped from the left so the cursor stays
 * visible. Walks back from the end, so a huge paste costs O(n) (I5).
 */
export function inputLine(draft: string, width: number): Line {
	const room = Math.max(1, width - 2 - cellWidth(glyphs().cursor))
	const chars = [...sanitize(draft)]
	let start = chars.length
	let used = 0
	while (start > 0) {
		const w = charWidth(chars[start - 1] ?? "")
		if (used + w > room) break
		used += w
		start--
	}
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
function emptyLine(
	state: AppState,
	mu: MessagesUi,
	fv: FeedView,
	width: number,
): Line {
	const sep = sepText()
	// I3: paused, and every match came after the pause (or was evicted while paused).
	if (!mu.following && fv.visible.length === 0 && fv.matching > 0)
		return [
			sp(
				truncate(
					`nothing before the pause${sep}${fv.newCount} new${sep}G newest`,
					width,
				),
				"label",
			),
		]
	if (fv.total > 0) {
		const what = [
			sanitize(mu.filterText),
			...(mu.preset !== "all" ? [`preset ${mu.preset}`] : []),
		]
			.filter(x => x !== "")
			.join(" ")
		return [sp(truncate(`0 of ${fv.total} match "${what}"`, width), "label")]
	}
	const ws = state.conn.ws
	if (ws.state !== "open") {
		// An open gap is the evidence the feed ran; failed connects also read "closed".
		const gap = openGap(state.messages.ring)
		return [
			sp(
				truncate(
					gap !== null
						? `no decodes cached${sep}feed stopped ${formatClock(gap.from)}`
						: `no decodes${sep}live feed connecting`,
					width,
				),
				"label",
			),
		]
	}
	// One rule with the strip for "in window" and the rx centre.
	const strip = stripInput(state)
	const since = ws.since ?? state.now
	const d = strip.decoders
	// Fitted by priority: the window count goes before rx; the first clause stays.
	const group = (text: string, priority: number): Group => ({
		priority,
		variants: [[sp(text, "label")]],
	})
	return fitGroups(
		[
			group(
				`no decodes since ${formatClockShort(since)} (${formatAge(state.now - since)})`,
				0,
			),
			...(d !== null && d.inWindow !== null
				? [group(`${d.inWindow} of ${d.total} decoders in window`, 2)]
				: []),
			...(strip.rx !== null
				? [group(`rx ${formatMHz(strip.rx.centreHz)}`, 1)]
				: []),
		],
		width,
		{ sep },
	)
}

/** Word wrap to `width` cells; words longer than a row are broken (spec §8: the detail pane wraps). */
export function wrapText(text: string, width: number): string[] {
	const room = Math.max(1, width)
	const out: string[] = []
	let cur: string[] = []
	let used = 0
	const flush = (): void => {
		out.push(cur.join(""))
		cur = []
		used = 0
	}
	for (const word of text.split(" ")) {
		const chars = [...word]
		const ww = chars.reduce((n, ch) => n + charWidth(ch), 0)
		if (used > 0) {
			if (used + 1 + ww <= room) {
				cur.push(" ")
				used++
			} else flush()
		}
		for (const ch of chars) {
			const cw = charWidth(ch)
			if (used > 0 && used + cw > room) flush()
			cur.push(ch)
			used += cw
		}
	}
	if (cur.length > 0 || out.length === 0) flush()
	return out
}

/** A label column (LABEL_WIDTH, or wider for a long label) and its value wrapped beside it. */
function wrappedField(
	label: string,
	value: string,
	width: number,
	role: "value" | "attention",
): Line[] {
	const col = Math.min(
		Math.max(LABEL_WIDTH, cellWidth(label) + 1),
		Math.max(1, width - 10),
	)
	return wrapText(value, width - col).map((chunk, i) => [
		sp(
			i === 0 ? padEnd(truncate(label, col - 1), col) : " ".repeat(col),
			"label",
		),
		sp(chunk, role),
	])
}

/** Label/value groups packed three spaces apart; a field too long for a row of its own wraps. */
function packFields(
	fields: MessageEntry["formatted"]["fields"],
	width: number,
): Line[] {
	const out: Line[] = []
	let cur: Line = []
	let used = 0
	const flush = (): void => {
		if (cur.length > 0) out.push(cur)
		cur = []
		used = 0
	}
	for (const f of fields) {
		const role = f.attention === true ? "attention" : "value"
		const w = cellWidth(f.label) + 1 + cellWidth(f.value)
		if (w > width) {
			flush()
			out.push(...wrappedField(f.label, f.value, width, role))
			continue
		}
		if (used > 0 && used + 3 + w > width) flush()
		if (used > 0) {
			cur.push(sp("   ", "label"))
			used += 3
		}
		cur.push(sp(`${f.label} `, "label"), sp(f.value, role))
		used += w
	}
	flush()
	return out
}

/** Long JSON lines wrap under their own indentation instead of being cut (I7). */
function jsonLines(data: unknown, width: number): Line[] {
	const out: Line[] = []
	for (const l of detailJson(data)) {
		if (cellWidth(l) <= width) {
			out.push([sp(l, "label")])
			continue
		}
		const indent = Math.min(l.length - l.trimStart().length + 2, width >> 1)
		const chunks = wrapText(l.trimStart(), width - indent)
		chunks.forEach((chunk, i) => {
			const pad = i === 0 ? indent - 2 : indent
			out.push([sp(" ".repeat(Math.max(0, pad)) + chunk, "label")])
		})
	}
	return out
}

/**
 * Head row, protocol fields, the text body, then the bounded JSON; everything
 * wraps to `width` (spec §8). At most `height` lines; scroll clamped to the last page.
 */
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
	const text = e.formatted.text
	const body: Line[] = [
		...packFields(e.formatted.fields, width),
		// R76: the body keeps its line breaks; each line wraps on its own.
		...(text !== undefined
			? text
					.split("\n")
					.flatMap((line, i) =>
						wrappedField(i === 0 ? "text" : "", line, width, "value"),
					)
			: []),
		...jsonLines(e.output.data, width),
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

interface Layout {
	fv: FeedView
	selected: MessageEntry | null
	open: boolean
	headerRows: number
	b: ReturnType<typeof listBudget>
}

function layout(
	state: AppState,
	ui: UiState,
	width: number,
	height: number,
	roomy: boolean,
): Layout {
	const mu = ui.messages
	const fv = feedView(state.messages.ring, mu)
	const selSeq =
		ui.selected.messages === null ? null : Number(ui.selected.messages)
	const selected = fv.visible.find(e => e.seq === selSeq) ?? null
	const open = ui.detail.messages.open && selected !== null
	const headerRows = mu.draft !== null ? 2 : 1
	const b = listBudget(width + 1, height, roomy, headerRows, open)
	return { fv, selected, open, headerRows, b }
}

/** What the key layer needs, without building any lines (M2). */
export function messagesKeys(
	state: AppState,
	ui: UiState,
	width: number,
	height: number,
	roomy: boolean,
): { rowIds: string[]; pageSize: number; hasSelection: boolean } {
	const { fv, selected, b } = layout(state, ui, width, height, roomy)
	return {
		rowIds: fv.visible.map(e => String(e.seq)),
		pageSize: Math.max(1, b.listRows),
		hasSelection: selected !== null,
	}
}

export function messagesModel(
	state: AppState,
	ui: UiState,
	width: number,
	height: number,
	roomy: boolean,
): MessagesModel {
	const mu = ui.messages
	const { fv, selected, open, headerRows, b } = layout(
		state,
		ui,
		width,
		height,
		roomy,
	)
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
						emptyLine(state, mu, fv, listWidth),
					].slice(-Math.max(1, b.listRows))
	// A bottom detail under a short list takes the rows the list leaves free
	// (body = list + 1 blank + detail); a full list leaves it b.detailRows.
	const detailRows =
		b.placement.kind === "bottom"
			? Math.max(b.detailRows, height - headerRows - list.length - b.gapRows)
			: b.detailRows
	return {
		header: messagesHeader(state, mu, fv, width),
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
