// The Activity drawer's state outside React: the search (tokens + category chip), the open event,
// pinned searches (per browser until the core keeps them: CORE-GAPS "Activity columns and pinned
// searches"), and the feed it drives. The tuned card opens it on a frequency through showFrequency().
import type { ActivityQuery, ActivitySummary } from "@wavekit/api-types"

import type { DataLayer } from "../../data/index.ts"
import { ActivityFeed, fetchCategoryCounts } from "../../data/activity-feed.ts"
import { Store } from "../../data/store.ts"
import { shellStore } from "../../shell/store.ts"
import type { CategoryChipId, SearchToken } from "./search.ts"
import {
	CATEGORY_CHIPS,
	buildQuery,
	frequencyToken,
	searchTitle,
	token,
} from "./search.ts"

export interface PinnedSearch {
	id: string
	title: string
	tokens: readonly SearchToken[]
	chip: CategoryChipId | null
}

export interface ActivityViewState {
	tokens: readonly SearchToken[]
	chip: CategoryChipId | null
	/** The event shown in the detail pane, or null for the list. */
	openId: string | null
	/** Its summary (it may come from the detail's related rows, not the list). */
	openItem: ActivitySummary | null
	pins: readonly PinnedSearch[]
	/** Count per category for the current search without its chip; null until loaded. */
	counts: Readonly<Record<string, number>> | null
}

const PINS_KEY = "wavekit.web.activity.pins"
const MAX_PINS = 12

function readPins(): PinnedSearch[] {
	try {
		const raw = globalThis.localStorage?.getItem(PINS_KEY)
		if (!raw) return []
		const parsed = JSON.parse(raw) as unknown
		if (!Array.isArray(parsed)) return []
		return parsed
			.filter(
				(p): p is PinnedSearch =>
					typeof p === "object" &&
					p !== null &&
					typeof (p as PinnedSearch).id === "string" &&
					typeof (p as PinnedSearch).title === "string" &&
					Array.isArray((p as PinnedSearch).tokens),
			)
			.slice(0, MAX_PINS)
	} catch {
		return []
	}
}

function writePins(pins: readonly PinnedSearch[]): void {
	try {
		globalThis.localStorage?.setItem(PINS_KEY, JSON.stringify(pins))
	} catch {
		// Private windows and full storage: pins stay for this page only.
	}
}

const sameSearch = (
	a: { tokens: readonly SearchToken[]; chip: CategoryChipId | null },
	b: { tokens: readonly SearchToken[]; chip: CategoryChipId | null },
): boolean =>
	a.chip === b.chip &&
	a.tokens.length === b.tokens.length &&
	a.tokens.every(
		(t, i) => t.kind === b.tokens[i]?.kind && t.value === b.tokens[i]?.value,
	)

export class ActivityController extends Store<ActivityViewState> {
	readonly feed: ActivityFeed
	private readonly data: DataLayer
	private attached = 0
	private countsAbort: AbortController | null = null
	private countsTimer: ReturnType<typeof setTimeout> | null = null
	private readonly offFeed: () => void

	constructor(data: DataLayer) {
		super({
			tokens: [],
			chip: null,
			openId: null,
			openItem: null,
			pins: readPins(),
			counts: null,
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
		return buildQuery(s.tokens, s.chip)
	}

	title(): string {
		const s = this.get()
		return searchTitle(s.tokens, s.chip)
	}

	/** The drawer mounted: follow the feed. Returns the detach. */
	attach(): () => void {
		this.attached += 1
		if (this.attached === 1) this.refresh()
		return () => {
			this.attached -= 1
			if (this.attached === 0) {
				this.feed.stop()
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

	clear(): void {
		this.setSearch([], null)
	}

	/** Opens an event's detail (null goes back to the list). */
	open(item: ActivitySummary | null): void {
		this.update(s => ({ ...s, openId: item?.eventId ?? null, openItem: item }))
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
		this.setSearch([frequencyToken(hz, span)], null)
		shellStore.openDrawer("activity")
	}

	/** Pins the current search; returns false when it is already pinned or there is nothing to pin. */
	pinCurrent(): boolean {
		const s = this.get()
		if (s.tokens.length === 0 && s.chip === null) return false
		if (s.pins.some(p => sameSearch(p, s))) return false
		const pin: PinnedSearch = {
			id: `pin-${Date.now().toString(36)}`,
			title: searchTitle(s.tokens, s.chip),
			tokens: s.tokens,
			chip: s.chip,
		}
		const pins = [...s.pins, pin].slice(-MAX_PINS)
		writePins(pins)
		this.update(v => ({ ...v, pins }))
		return true
	}

	unpin(id: string): void {
		const pins = this.get().pins.filter(p => p.id !== id)
		writePins(pins)
		this.update(v => ({ ...v, pins }))
	}

	/** The pin matching the current search, if any. */
	currentPin(): PinnedSearch | null {
		const s = this.get()
		return s.pins.find(p => sameSearch(p, s)) ?? null
	}

	dispose(): void {
		this.offFeed()
		this.countsAbort?.abort()
		if (this.countsTimer !== null) clearTimeout(this.countsTimer)
		this.feed.dispose()
	}

	private refresh(counts = true): void {
		if (this.attached === 0) return
		void this.feed.setQuery(this.query())
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
		const base = buildQuery(s.tokens, null)
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
