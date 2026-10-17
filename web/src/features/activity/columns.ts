// Activity columns (docs/web/DESIGN.md, "Activity wide mode: the columns pane"): pinned searches shown side by side in
// the pane left of the drawer, or as a switcher row when there is no room. Pure functions over the column list; the
// controller keeps the list (per browser until the core keeps it: CORE-GAPS "Activity columns and pinned searches").
import type {
	ActivityCategory,
	ActivityQuery,
	ActivitySummary,
} from "@wavekit/api-types"

import type { CategoryChipId, SearchToken } from "./search.ts"
import { buildQuery, chipCategories, frequencyToken, token } from "./search.ts"

export interface ActivityColumn {
	id: string
	title: string
	/** The title was typed (Rename): editing the search keeps it. */
	named: boolean
	tokens: readonly SearchToken[]
	chip: CategoryChipId | null
	/** A preset's own categories (Messages, Positions), AND-ed with the rest; null for a pinned search. */
	categories: readonly ActivityCategory[] | null
}

export const MAX_COLUMNS = 5
/** Pane geometry (Activity board): columns 280–420 px, 8 px apart, the next one peeking in by 52 px. */
export const COL_MIN = 280
export const COL_MAX = 420
export const COL_GAP = 8
export const COL_PEEK = 52
/** The pane's side padding (10 px each side). */
export const PANE_PAD = 20

export interface ColumnPreset {
	id: string
	title: string
	chip: CategoryChipId | null
	categories: readonly ActivityCategory[] | null
}

/** Ready-made columns offered when the pane is empty or has room (Activity board PRESETS). */
export const COLUMN_PRESETS: readonly ColumnPreset[] = [
	{ id: "voice", title: "Voice", chip: "voice", categories: null },
	{
		id: "messages",
		title: "Messages",
		chip: null,
		categories: ["paging", "aviation-data", "mesh"],
	},
	{
		id: "positions",
		title: "Positions",
		chip: null,
		categories: ["aircraft", "marine", "aprs"],
	},
	{ id: "sensors", title: "Sensors", chip: "sensors", categories: null },
]

const sameTokens = (
	a: readonly SearchToken[],
	b: readonly SearchToken[],
): boolean =>
	a.length === b.length &&
	a.every((t, i) => t.kind === b[i]?.kind && t.value === b[i]?.value)

const sameCategories = (
	a: readonly ActivityCategory[] | null,
	b: readonly ActivityCategory[] | null,
): boolean =>
	a === null || b === null
		? a === b
		: a.length === b.length && a.every(c => b.includes(c))

/** Whether a column already shows this search. */
export function sameColumnSearch(
	col: Pick<ActivityColumn, "tokens" | "chip" | "categories">,
	other: Pick<ActivityColumn, "tokens" | "chip" | "categories">,
): boolean {
	return (
		col.chip === other.chip &&
		sameTokens(col.tokens, other.tokens) &&
		sameCategories(col.categories, other.categories)
	)
}

/** A column's list: its own search, narrowed by the drawer's search. Null when they cannot match together. */
export function columnQuery(
	col: Pick<ActivityColumn, "tokens" | "chip" | "categories">,
	search: { tokens: readonly SearchToken[]; chip: CategoryChipId | null },
): ActivityQuery | null {
	const within: (readonly ActivityCategory[])[] = []
	if (col.categories) within.push(col.categories)
	if (search.chip !== null && col.chip !== null)
		within.push(chipCategories(search.chip))
	const chip = col.chip ?? search.chip
	const tokens = [...col.tokens]
	for (const t of search.tokens)
		if (!tokens.some(x => x.kind === t.kind && x.value === t.value))
			tokens.push(t)
	return buildQuery(tokens, chip, within)
}

/** Moves a column one place left (-1) or right (+1); the same list when it cannot move. */
export function moveColumn(
	cols: readonly ActivityColumn[],
	id: string,
	by: -1 | 1,
): readonly ActivityColumn[] {
	const i = cols.findIndex(c => c.id === id)
	const j = i + by
	if (i < 0 || j < 0 || j >= cols.length) return cols
	const next = [...cols]
	const [c] = next.splice(i, 1)
	if (c) next.splice(j, 0, c)
	return next
}

/** Drops a dragged column onto another: it takes that column's place (after it when moving right). */
export function dropColumn(
	cols: readonly ActivityColumn[],
	dragId: string,
	targetId: string,
): readonly ActivityColumn[] {
	const from = cols.findIndex(c => c.id === dragId)
	const to = cols.findIndex(c => c.id === targetId)
	if (from < 0 || to < 0 || from === to) return cols
	const next = [...cols]
	const [c] = next.splice(from, 1)
	if (c) next.splice(to, 0, c)
	return next
}

export interface HeardSuggestion {
	title: string
	count: number
	tokens: readonly SearchToken[]
}

const fieldValue = (item: ActivitySummary, keys: readonly string[]) => {
	for (const f of item.fields)
		if (keys.includes(f.key) && f.value !== null && f.value !== "")
			return String(f.value)
	return null
}

/**
 * What you hear most, as ready-made columns (Activity board): talkgroups, pager capcodes and voice channels heard more
 * than once in `items`, most first, leaving out titles already taken. At most `limit`.
 */
export function heardMost(
	items: readonly ActivitySummary[],
	taken: readonly string[],
	limit = 3,
): HeardSuggestion[] {
	const by = new Map<string, HeardSuggestion>()
	for (const item of items) {
		let s: Omit<HeardSuggestion, "count"> | null = null
		const tg =
			item.category === "voice" ? fieldValue(item, ["talkgroup", "tg"]) : null
		const cap =
			item.category === "paging"
				? fieldValue(item, ["capcode", "address"])
				: null
		if (tg !== null && /^\d{1,8}$/.test(tg))
			s = { title: `TG ${tg}`, tokens: [token("talkgroup", tg)] }
		else if (cap !== null && /^\d{1,8}$/.test(cap))
			s = { title: `Capcode ${cap}`, tokens: [token("capcode", cap)] }
		else if (item.category === "voice" && item.frequencyHz !== null) {
			const t = frequencyToken(item.frequencyHz)
			s = { title: t.label, tokens: [t] }
		}
		if (!s) continue
		const had = by.get(s.title)
		by.set(s.title, { ...s, count: (had?.count ?? 0) + 1 })
	}
	return [...by.values()]
		.filter(h => h.count > 1 && !taken.includes(h.title))
		.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
		.slice(0, limit)
}

export interface PaneColumns {
	/** Each column's width (px). */
	colW: number
	/** Columns grow to fill the pane (all fit), or keep colW and scroll. */
	grow: boolean
	/** More columns than fit: the next one peeks in at the edge. */
	over: boolean
	/** Whole columns in view. */
	fit: number
}

/**
 * Column widths for a pane `paneW` wide holding `n` columns (Activity board): they fill the pane; with more than fit,
 * the whole ones share what is left after a peek on each side, so once scrolled the next and the previous column peek
 * in under their fades and no fade covers a whole column (the board's first draft hid its timestamps). `extra` is the
 * width of anything after the columns (the "Add a column" tile) that should stay in view when everything fits.
 */
export function paneColumns(paneW: number, n: number, extra = 0): PaneColumns {
	const inner = Math.max(COL_MIN, paneW - PANE_PAD)
	const need =
		n * (COL_MIN + COL_GAP) - COL_GAP + (extra > 0 ? COL_GAP + extra : 0)
	if (n === 0 || need <= inner)
		return { colW: COL_MIN, grow: true, over: false, fit: n }
	const room = inner - 2 * COL_PEEK
	const fit = Math.max(1, Math.floor((room + COL_GAP) / (COL_MIN + COL_GAP)))
	const colW = Math.min(
		COL_MAX,
		Math.max(200, Math.floor((room - fit * COL_GAP) / fit)),
	)
	return { colW, grow: false, over: true, fit }
}
