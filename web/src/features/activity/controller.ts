// The Activity drawer's state outside React: the search (tokens + category chip), the open event, the
// columns (pinned searches, per browser until the core keeps them: CORE-GAPS "Activity columns and
// pinned searches"), and the feeds they drive: the drawer's list and one per column, each column's
// search narrowed by the drawer's. The tuned card opens it on a frequency through showFrequency().
import type { ActivityQuery, ActivitySummary } from "@wavekit/api-types"

import type { DataLayer } from "../../data/index.ts"
import {
	ActivityFeed,
	compareSeq,
	fetchCategoryCounts,
	queryParams,
} from "../../data/activity-feed.ts"
import { Store } from "../../data/store.ts"
import { shellStore } from "../../shell/store.ts"
import type { ActivityColumn } from "./columns.ts"
import type { ActivityStack } from "./fold.ts"
import { releaseFolds, stackIn } from "./fold.ts"
import {
	MAX_COLUMNS,
	columnQuery,
	dropColumn,
	moveColumn,
	sameColumnSearch,
} from "./columns.ts"
import { setActivityPaneOpen } from "./pane.ts"
import type { ActivityScope, TimeRange } from "./scope.ts"
import { ANY_TIME, sameRange, scopeTitle, scopedQuery } from "./scope.ts"
import type { CategoryChipId, SearchToken } from "./search.ts"
import {
	CATEGORY_CHIPS,
	buildQuery,
	frequencyToken,
	searchTitle,
	token,
} from "./search.ts"

export interface ActivityViewState {
	tokens: readonly SearchToken[]
	chip: CategoryChipId | null
	/** The event shown in the detail pane, or null for the list. */
	openId: string | null
	/** Its summary (it may come from the detail's related rows, not the list). */
	openItem: ActivitySummary | null
	/** Pinned searches, shown as columns in the pane or as the switcher row. */
	columns: readonly ActivityColumn[]
	/** The column whose search the drawer's search is editing ("Update column"), or null. */
	editing: string | null
	/** No room for the pane: the list the drawer shows, "all" or a column id (the switcher row). */
	view: string
	/** Per column, the newest commitSeq seen in the switcher (its new count starts after it). */
	seen: Readonly<Record<string, string>>
	/** Count per category for the current search without its chip; null until loaded. */
	counts: Readonly<Record<string, number>> | null
	/** The time range every list shows (the drawer's and each column). */
	range: TimeRange
	/** "With audio": only transmissions and calls, in every list. */
	audio: boolean
}

const COLUMNS_KEY = "wavekit.web.activity.pins"

/** Now, to the minute: a rolling range keeps the same bounds (and the columns their feeds) within a minute. */
const scopeNow = () => Math.floor(Date.now() / 60_000) * 60_000

const KNOWN_CATEGORIES = new Set<unknown>(
	CATEGORY_CHIPS.flatMap(c => c.categories),
)

const isToken = (t: unknown): t is SearchToken =>
	typeof t === "object" &&
	t !== null &&
	typeof (t as SearchToken).kind === "string" &&
	typeof (t as SearchToken).value === "string" &&
	typeof (t as SearchToken).label === "string"

/** Reads the columns (older pinned searches included: they carry no `named` or `categories`). */
export function readColumns(raw: string | null): ActivityColumn[] {
	if (!raw) return []
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!Array.isArray(parsed)) return []
		const out: ActivityColumn[] = []
		for (const p of parsed) {
			if (typeof p !== "object" || p === null) continue
			const c = p as Partial<ActivityColumn>
			if (typeof c.id !== "string" || typeof c.title !== "string") continue
			if (!Array.isArray(c.tokens) || !c.tokens.every(isToken)) continue
			const chip = CATEGORY_CHIPS.some(x => x.id === c.chip)
				? (c.chip as CategoryChipId)
				: null
			const categories =
				Array.isArray(c.categories) &&
				c.categories.length > 0 &&
				c.categories.every(x => KNOWN_CATEGORIES.has(x))
					? c.categories
					: null
			if (c.tokens.length === 0 && chip === null && categories === null)
				continue
			out.push({
				id: c.id,
				title: c.title,
				named: c.named === true,
				tokens: c.tokens,
				chip,
				categories,
			})
		}
		return out.slice(0, MAX_COLUMNS)
	} catch {
		return []
	}
}

function load(key: string): string | null {
	try {
		return globalThis.localStorage?.getItem(key) ?? null
	} catch {
		return null
	}
}

function save(key: string, value: string): void {
	try {
		globalThis.localStorage?.setItem(key, value)
	} catch {
		// Private windows and full storage: kept for this page only.
	}
}

/**
 * What a list is a search for, with its time range by name: "Last hour" stays the same search (and keeps
 * its cached rows) while its resolved start moves on every minute.
 */
export function searchKey(
	q: ActivityQuery | null,
	scope: ActivityScope,
): string | null {
	const timeless = scopedQuery(q, { ...scope, range: ANY_TIME }, 0)
	if (timeless === null) return null
	const r = scope.range
	const range = r.kind === "custom" ? `custom:${r.from}:${r.to ?? ""}` : r.kind
	return JSON.stringify({ q: queryParams(timeless), range })
}

let columnSeq = 0
const newColumnId = () =>
	`col-${Date.now().toString(36)}-${(columnSeq++).toString(36)}`

export class ActivityController extends Store<ActivityViewState> {
	readonly feed: ActivityFeed
	private readonly data: DataLayer
	private attached = 0
	private countsAbort: AbortController | null = null
	private countsTimer: ReturnType<typeof setTimeout> | null = null
	private readonly offFeed: () => void
	/** One feed per column, kept while the column exists; it follows the core only while the drawer is open. */
	private readonly columnFeeds = new Map<string, ActivityFeed>()
	private readonly columnQueries = new Map<string, string>()
	/** The list the open event was picked from (its stack is folded from that list). */
	private openFeed: ActivityFeed | null = null

	constructor(data: DataLayer) {
		super({
			tokens: [],
			chip: null,
			openId: null,
			openItem: null,
			columns: readColumns(load(COLUMNS_KEY)),
			editing: null,
			view: "all",
			seen: {},
			counts: null,
			range: ANY_TIME,
			audio: false,
		})
		this.data = data
		this.feed = new ActivityFeed(data.api, data.events)
		// New live rows move the chip counts; refresh them at most every few seconds.
		this.offFeed = this.feed.subscribe((s, prev) => {
			if (
				s.items !== prev.items &&
				s.query === prev.query &&
				s.status === "live" &&
				prev.status === "live"
			)
				this.scheduleCounts(4000)
		})
	}

	/** The query the list shows, or null when the search cannot match anything. */
	query(): ActivityQuery | null {
		const s = this.get()
		return scopedQuery(buildQuery(s.tokens, s.chip), s, scopeNow())
	}

	title(): string {
		const s = this.get()
		const scope = scopeTitle(s, Date.now())
		if (s.tokens.length === 0 && s.chip === null && scope !== "") return scope
		const search = searchTitle(s.tokens, s.chip)
		return scope === "" ? search : `${search} · ${scope}`
	}

	/** The time range for every list; a rolling one ("Last hour") is measured from now. */
	setRange(range: TimeRange): void {
		if (sameRange(this.get().range, range)) return
		this.update(s => ({ ...s, range, openId: null, openItem: null }))
		this.refresh()
	}

	setAudio(audio: boolean): void {
		if (this.get().audio === audio) return
		this.update(s => ({ ...s, audio, openId: null, openItem: null }))
		this.refresh()
	}

	/** Puts a whole view back at once (a deep link): search, scope and the open event. */
	restore(
		v: Pick<ActivityViewState, "tokens" | "chip" | "range" | "audio"> & {
			openId: string | null
		},
	): void {
		this.update(s => ({
			...s,
			tokens: v.tokens,
			chip: v.chip,
			range: v.range,
			audio: v.audio,
			editing: null,
			view: "all",
			openId: v.openId,
			openItem: v.openId !== null && s.openId === v.openId ? s.openItem : null,
		}))
		this.refresh()
	}

	/** The drawer mounted: follow the feed and the columns. Returns the detach. */
	attach(): () => void {
		this.attached += 1
		if (this.attached === 1) {
			this.refresh()
			this.syncColumns(true)
		}
		return () => {
			this.attached -= 1
			if (this.attached === 0) {
				this.feed.stop()
				for (const f of this.columnFeeds.values()) f.stop()
				this.columnQueries.clear()
				this.countsAbort?.abort()
				if (this.countsTimer !== null) clearTimeout(this.countsTimer)
				this.countsTimer = null
			}
		}
	}

	addToken(t: SearchToken): void {
		this.update(s =>
			s.tokens.some(x => x.kind === t.kind && x.value === t.value)
				? s
				: { ...s, tokens: [...s.tokens, t], openId: null, openItem: null },
		)
		this.refresh()
	}

	removeToken(index: number): void {
		this.update(s => ({
			...s,
			tokens: s.tokens.filter((_, i) => i !== index),
			openId: null,
			openItem: null,
		}))
		this.refresh()
	}

	setChip(chip: CategoryChipId | null): void {
		if (this.get().chip === chip) return
		this.update(s => ({ ...s, chip, openId: null, openItem: null }))
		this.refresh(false)
	}

	setSearch(tokens: readonly SearchToken[], chip: CategoryChipId | null): void {
		this.update(s => ({ ...s, tokens, chip, openId: null, openItem: null }))
		this.refresh()
	}

	/** Clears the search (and leaves a column's edit). */
	clear(): void {
		this.update(s => ({ ...s, editing: null }))
		this.setSearch([], null)
	}

	/** Live / Paused, for the drawer's list and every column. */
	setPaused(paused: boolean): void {
		this.feed.setPaused(paused)
		for (const f of this.columnFeeds.values()) f.setPaused(paused)
	}

	/**
	 * Opens an event's detail (null goes back to the list), exactly as stored: what older rows of its stack
	 * knew is the detail's separate "Latest known" block, never mixed into the event.
	 */
	open(item: ActivitySummary | null): void {
		this.update(s => ({ ...s, openId: item?.eventId ?? null, openItem: item }))
	}

	/** The list the next open() comes from (a column's or the drawer's); the detail folds that list. */
	noteOpenFeed(feed: ActivityFeed): void {
		this.openFeed = feed
	}

	/** The list the open event's stack is folded from: the one it was picked from, else the drawer's. */
	stackFeed(): ActivityFeed {
		return this.openFeed ?? this.feed
	}

	/** The stack holding an event in the list it came from, or null (opened by a link, or since dropped). */
	stackFor(eventId: string): ActivityStack | null {
		const feed = this.stackFeed()
		return stackIn(feed.get().items, feed, eventId)
	}

	/** Narrows the list to one entity (the detail's "Only this"). */
	showEntity(entityKey: string, label: string): void {
		this.setSearch([token("entity", entityKey, { label })], null)
	}

	/** The tuned card's Activity button: what was heard on this channel. */
	showFrequency(hz: number, bandwidthHz?: number): void {
		const span =
			bandwidthHz !== undefined && bandwidthHz > 0
				? Math.max(1000, Math.round(bandwidthHz / 2))
				: undefined
		this.update(s => ({ ...s, editing: null, view: "all" }))
		this.setSearch([frequencyToken(hz, span)], null)
		shellStore.openDrawer("activity")
	}

	// ---- columns

	/** A column's own feed (its search under the drawer's), or null for an unknown id. */
	columnFeed(id: string): ActivityFeed | null {
		return this.columnFeeds.get(id) ?? null
	}

	/** The column whose search is the drawer's search now, if any. */
	currentColumn(): ActivityColumn | null {
		const s = this.get()
		return (
			s.columns.find(
				c =>
					c.categories === null &&
					sameColumnSearch(c, { ...s, categories: null }),
			) ?? null
		)
	}

	/**
	 * Pin as column: the drawer's search becomes a column and the search clears (it narrows every column). With room
	 * the pane opens; without, the switcher shows the new column. While editing a column, its search is updated instead.
	 * Returns the column's id, or null when there was nothing to pin or no place left.
	 */
	pinSearch(room: boolean): string | null {
		const s = this.get()
		if (s.tokens.length === 0 && s.chip === null) return null
		const title = searchTitle(s.tokens, s.chip)
		if (s.editing !== null) {
			const id = s.editing
			this.setColumns(
				s.columns.map(c =>
					c.id === id
						? {
								...c,
								tokens: s.tokens,
								chip: s.chip,
								categories: null,
								title: c.named ? c.title : title,
							}
						: c,
				),
			)
			this.update(v => ({ ...v, editing: null }))
			this.setSearch([], null)
			return id
		}
		const id = this.addColumn(
			{ title, tokens: s.tokens, chip: s.chip, categories: null },
			room,
		)
		if (id !== null) this.setSearch([], null)
		return id
	}

	/** Adds a column (a preset, a heard suggestion, the search); with room the pane opens, without the switcher picks it. */
	addColumn(
		def: Pick<ActivityColumn, "title" | "tokens" | "chip" | "categories">,
		room: boolean,
	): string | null {
		const s = this.get()
		const had = s.columns.find(c => sameColumnSearch(c, def))
		if (had) {
			this.showColumn(had.id, room)
			return had.id
		}
		if (s.columns.length >= MAX_COLUMNS) return null
		const col: ActivityColumn = { ...def, id: newColumnId(), named: false }
		this.setColumns([...s.columns, col])
		this.showColumn(col.id, room)
		return col.id
	}

	private showColumn(id: string, room: boolean): void {
		if (room) setActivityPaneOpen(true)
		else this.pickView(id)
	}

	renameColumn(id: string, title: string): void {
		const t = title.trim()
		const cols = this.get().columns
		const col = cols.find(c => c.id === id)
		if (!col || t === "" || t === col.title) return
		this.setColumns(
			cols.map(c => (c.id === id ? { ...c, title: t, named: true } : c)),
		)
	}

	/** Edit search: the column's tokens go into the drawer's search, whose pin button becomes "Update column". */
	editColumn(id: string): void {
		const col = this.get().columns.find(c => c.id === id)
		if (!col) return
		this.update(s => ({ ...s, editing: id }))
		this.setSearch(col.tokens, col.chip)
	}

	/** Leaves a column's edit and clears the search it loaded. */
	cancelEdit(): void {
		if (this.get().editing === null) return
		this.clear()
	}

	moveColumn(id: string, by: -1 | 1): void {
		this.setColumns(moveColumn(this.get().columns, id, by))
	}

	dropColumn(dragId: string, targetId: string): void {
		this.setColumns(dropColumn(this.get().columns, dragId, targetId))
	}

	/** Removes a column; returns an undo that puts it back where it was. */
	removeColumn(id: string): (() => void) | null {
		const before = this.get().columns
		const at = before.findIndex(c => c.id === id)
		const col = before[at]
		if (!col) return null
		this.setColumns(before.filter(c => c.id !== id))
		this.update(s => ({
			...s,
			editing: s.editing === id ? null : s.editing,
			view: s.view === id ? "all" : s.view,
		}))
		return () => {
			const now = this.get().columns
			if (now.some(c => c.id === id) || now.length >= MAX_COLUMNS) return
			const next = [...now]
			next.splice(Math.min(at, next.length), 0, col)
			this.setColumns(next)
		}
	}

	/** The switcher row (no room for the pane): which list the drawer shows. */
	pickView(view: string): void {
		this.update(s => {
			const seen = { ...s.seen }
			for (const id of [s.view, view]) {
				const top = this.columnFeeds.get(id)?.get().items[0]?.commitSeq
				if (top !== undefined) seen[id] = top
			}
			return { ...s, view, seen, openId: null, openItem: null }
		})
	}

	/** Items a column got since it was last shown in the switcher. */
	newInColumn(id: string): number {
		const feed = this.columnFeeds.get(id)
		if (!feed) return 0
		const seen = this.get().seen[id]
		const items = feed.get().items
		if (seen === undefined) return 0
		let n = 0
		for (const i of items) {
			if (compareSeq(i.commitSeq, seen) <= 0) break
			n += 1
		}
		return n
	}

	dispose(): void {
		this.offFeed()
		this.countsAbort?.abort()
		if (this.countsTimer !== null) clearTimeout(this.countsTimer)
		this.feed.dispose()
		releaseFolds(this.feed)
		for (const f of this.columnFeeds.values()) {
			f.dispose()
			releaseFolds(f)
		}
		this.columnFeeds.clear()
	}

	private setColumns(columns: readonly ActivityColumn[]): void {
		save(COLUMNS_KEY, JSON.stringify(columns))
		this.update(s => ({ ...s, columns }))
		this.syncColumns()
	}

	/** Makes one feed per column and, while attached, points each at its search under the drawer's. */
	private syncColumns(force = false): void {
		const s = this.get()
		const now = scopeNow()
		const ids = new Set(s.columns.map(c => c.id))
		for (const [id, f] of this.columnFeeds)
			if (!ids.has(id)) {
				if (this.openFeed === f) this.openFeed = null
				f.dispose()
				releaseFolds(f)
				this.columnFeeds.delete(id)
				this.columnQueries.delete(id)
			}
		for (const col of s.columns) {
			let f = this.columnFeeds.get(col.id)
			if (!f) {
				f = new ActivityFeed(this.data.api, this.data.events, {
					maxItems: 1000,
					pageSize: 50,
				})
				f.setPaused(this.feed.get().paused)
				this.columnFeeds.set(col.id, f)
				// the first load marks what the switcher has seen
				const id = col.id
				const off = f.subscribe(v => {
					if (v.status !== "live") return
					off()
					const top = v.items[0]?.commitSeq
					if (top !== undefined && this.get().seen[id] === undefined)
						this.update(x => ({ ...x, seen: { ...x.seen, [id]: top } }))
				})
			}
			if (this.attached === 0) continue
			// while a column's search is being edited, that column previews the drawer's search and the others
			// show their own (the edit is not a filter on them)
			const base =
				s.editing === null
					? columnQuery(col, s)
					: s.editing === col.id
						? buildQuery(s.tokens, s.chip)
						: columnQuery(col, { tokens: [], chip: null })
			const q = scopedQuery(base, s, now)
			const key = JSON.stringify(q)
			if (!force && this.columnQueries.get(col.id) === key) continue
			this.columnQueries.set(col.id, key)
			void f.setQuery(q, searchKey(base, s) ?? undefined)
		}
	}

	private refresh(counts = true): void {
		if (this.attached === 0) return
		const s = this.get()
		void this.feed.setQuery(
			this.query(),
			searchKey(buildQuery(s.tokens, s.chip), s) ?? undefined,
		)
		this.syncColumns()
		if (counts) this.scheduleCounts(0)
	}
	private scheduleCounts(delayMs: number): void {
		if (this.attached === 0) return
		if (this.countsTimer !== null) {
			if (delayMs > 0) return
			clearTimeout(this.countsTimer)
		}
		this.countsTimer = setTimeout(() => {
			this.countsTimer = null
			void this.loadCounts()
		}, delayMs)
	}

	/** Chip counts: the search without its chip, so every chip shows what it would add. */
	private async loadCounts(): Promise<void> {
		const s = this.get()
		const base = scopedQuery(buildQuery(s.tokens, null), s, scopeNow())
		this.countsAbort?.abort()
		if (base === null) {
			this.update(v => ({ ...v, counts: {} }))
			return
		}
		const abort = new AbortController()
		this.countsAbort = abort
		try {
			const byCategory = await fetchCategoryCounts(
				this.data.api,
				base,
				abort.signal,
			)
			const counts: Record<string, number> = {}
			for (const chip of CATEGORY_CHIPS)
				counts[chip.id] = chip.categories.reduce(
					(n, c) => n + (byCategory[c] ?? 0),
					0,
				)
			if (!abort.signal.aborted) this.update(v => ({ ...v, counts }))
		} catch {
			// Counts are a hint: an older core without facets leaves the chips bare.
		}
	}
}
