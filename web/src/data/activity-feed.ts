/**
 * One Activity list: a REST snapshot (`GET /api/activity`, newest first) followed by the live
 * `activity` WS feed resumed from the snapshot's replay cursor, so nothing falls between them.
 * Live records are batched (one store update per flush, never one per message) and held while
 * the list is paused or scrolled away from the top ("N new"). A replay reset or a failed
 * snapshot is a visible state; a reset reloads the snapshot and resubscribes.
 *
 * The list is its own cache: stopping (the drawer closed) keeps it, and showing the same query again
 * renders it at once while the snapshot reloads behind it ("loading" with items). The fresh snapshot is
 * merged into the cache only when the two overlap (no hole between them), else it replaces the cache;
 * the merge drops cached rows the snapshot says are gone (pruned, or missing from its range).
 */
import type {
	ActivityQuery,
	ActivityRecord,
	ActivitySearchPage,
	ActivitySummary,
} from "@wavekit/api-types"
import { z } from "zod/v4"

import type { ApiClient, QueryValue } from "./api-client.ts"
import { errorMessage, validated } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import { Store } from "./store.ts"

export type ActivityResetReason =
	| "cursor-gap"
	| "cursor-expired"
	| "store-changed"
	| "query-changed"
	| "invalid-cursor"
	| "reader-failed"

export interface ActivityFeedState {
	query: ActivityQuery | null
	/**
	 * What the list is a search for: the same key keeps the cached rows across reloads. By default the
	 * query's parameters; a caller with a rolling range passes the range by name ("Last hour"), since its
	 * resolved `from` moves every minute while the rows it found stay valid.
	 */
	searchKey: string | null
	status: "idle" | "loading" | "live" | "error"
	/** Newest first, deduplicated by eventId, at most `maxItems` (MAX_ITEMS by default). */
	items: readonly ActivitySummary[]
	/** Live records held while paused or scrolled away (newest first). */
	pending: readonly ActivitySummary[]
	/** The user's Live / Paused toggle. */
	paused: boolean
	/** The list is scrolled away from the newest rows: hold arrivals instead of moving rows. */
	holding: boolean
	nextPageToken: string | null
	loadingMore: boolean
	/** The last replay reset the core reported (shown until the next query). */
	reset: ActivityResetReason | null
	error: string | null
	/** False when the core answered that Activity is off or unavailable (404/503). */
	available: boolean
}

export const MAX_ITEMS = 5000
const PAGE = 100

const INITIAL: ActivityFeedState = {
	query: null,
	searchKey: null,
	status: "idle",
	items: [],
	pending: [],
	paused: false,
	holding: false,
	nextPageToken: null,
	loadingMore: false,
	reset: null,
	error: null,
	available: true,
}

const fieldSchema = z
	.object({
		key: z.string(),
		label: z.string(),
		value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
		unit: z.string().optional(),
	})
	.passthrough()

const summarySchema = z
	.object({
		eventId: z.string(),
		commitSeq: z.string(),
		kind: z.string(),
		producedAt: z.string(),
		receivedAt: z.string(),
		decoderId: z.string().nullable(),
		sourceId: z.string().nullable(),
		protocol: z.string().nullable(),
		category: z.string(),
		frequencyHz: z.number().nullable(),
		entityKey: z.string().nullable(),
		title: z.string().nullable(),
		fields: z.array(fieldSchema),
	})
	.passthrough()

const pageSchema = z
	.object({
		items: z.array(summarySchema),
		nextPageToken: z.string().nullable(),
		replayCursor: z.string(),
		snapshot: z.object({ lowBarrier: z.string() }).passthrough(),
	})
	.passthrough() as unknown as z.ZodType<ActivitySearchPage>

/** Compares decimal commitSeq strings without losing precision. */
export function compareSeq(a: string, b: string): number {
	if (a.length !== b.length) return a.length - b.length
	return a < b ? -1 : a > b ? 1 : 0
}

/** Newest first by commitSeq. */
export function newestFirst(a: ActivitySummary, b: ActivitySummary): number {
	return compareSeq(b.commitSeq, a.commitSeq)
}

/** Merges `incoming` into a newest-first list, dropping duplicates and keeping at most `max`. */
export function mergeNewest(
	list: readonly ActivitySummary[],
	incoming: readonly ActivitySummary[],
	max = MAX_ITEMS,
): ActivitySummary[] {
	if (incoming.length === 0) return list.slice(0, max)
	const seen = new Set(list.map(i => i.eventId))
	const fresh = incoming.filter(i => {
		if (seen.has(i.eventId)) return false
		seen.add(i.eventId)
		return true
	})
	return [...fresh, ...list].sort(newestFirst).slice(0, max)
}

/** Two queries ask for the same rows (key order aside). */
export function sameQuery(a: ActivityQuery, b: ActivityQuery): boolean {
	return JSON.stringify(queryParams(a)) === JSON.stringify(queryParams(b))
}

/**
 * The cache can be kept beside a fresh snapshot (both newest first) when nothing can be missing between
 * them: the snapshot reaches back to (or past) the cache's newest row. A complete snapshot (no next page)
 * is everything stored, so it replaces the cache (rows pruned since are dropped).
 */
export function joins(
	snapshot: readonly ActivitySummary[],
	cache: readonly ActivitySummary[],
	complete: boolean,
): boolean {
	if (cache.length === 0 || complete) return false
	const oldest = snapshot.at(-1)
	const newest = cache.reduce<ActivitySummary | null>(
		(top, i) =>
			top === null || compareSeq(i.commitSeq, top.commitSeq) > 0 ? i : top,
		null,
	)
	if (oldest === undefined || newest === null) return false
	return compareSeq(oldest.commitSeq, newest.commitSeq) <= 0
}

/**
 * The list after a reopen whose snapshot `joins` the cache: the fresh rows (newest first), plus the cached
 * rows older than the snapshot's oldest row that the store still holds (above `lowBarrier`, the greatest
 * pruned seq). From its oldest row up the snapshot is the truth: a cached row in that range it lacks was
 * removed, and a row in both is taken as the snapshot has it.
 */
export function reopenMerge(
	cached: readonly ActivitySummary[],
	fresh: readonly ActivitySummary[],
	lowBarrier: string,
	max = MAX_ITEMS,
): ActivitySummary[] {
	const oldest = fresh.at(-1)
	if (oldest === undefined) return []
	const ids = new Set(fresh.map(i => i.eventId))
	const older = cached.filter(
		i =>
			!ids.has(i.eventId) &&
			compareSeq(i.commitSeq, lowBarrier) > 0 &&
			compareSeq(i.commitSeq, oldest.commitSeq) < 0,
	)
	return mergeNewest(fresh, older, max)
}

/**
 * Where paging continues after a reopen whose snapshot `joins` the cache (both newest first; the list
 * becomes the snapshot's rows plus the cached rows older than them): the snapshot's own token when no
 * cached row lies below the snapshot (or the snapshot is complete); past the cache's oldest row with the
 * cache's token when that row is still stored, so the rows already cached are never fetched again; nothing
 * more when the store pruned it (`lowBarrier` at or above it: everything older is pruned too). `fallback`
 * is the snapshot's token, for a cache token the core no longer accepts (it expired).
 */
export function reopenPaging(
	cachedOldest: ActivitySummary | undefined,
	cacheToken: string | null,
	fresh: readonly ActivitySummary[],
	snapshotToken: string | null,
	lowBarrier: string,
): { token: string | null; fallback: string | null } {
	const freshOldest = fresh.at(-1)
	if (
		snapshotToken === null ||
		cachedOldest === undefined ||
		freshOldest === undefined ||
		compareSeq(cachedOldest.commitSeq, freshOldest.commitSeq) >= 0
	)
		return { token: snapshotToken, fallback: null }
	if (compareSeq(cachedOldest.commitSeq, lowBarrier) <= 0)
		return { token: null, fallback: null }
	return {
		token: cacheToken,
		fallback: cacheToken === null ? null : snapshotToken,
	}
}

/** Rows heard at or after `fromIso` (a moved rolling range's start); all of them when it is unset. */
export function since(
	rows: readonly ActivitySummary[],
	fromIso: string | undefined,
): readonly ActivitySummary[] {
	if (fromIso === undefined) return rows
	const from = Date.parse(fromIso)
	if (!Number.isFinite(from)) return rows
	return rows.filter(r => Date.parse(r.producedAt) >= from)
}

/** The REST query string for a query (the core's flat parameter names). */
export function queryParams(q: ActivityQuery): Record<string, QueryValue> {
	const p: Record<string, QueryValue> = {}
	if (q.kinds?.length) p["kinds"] = q.kinds.join(",")
	if (q.sourceIds?.length) p["sourceIds"] = q.sourceIds.join(",")
	if (q.decoderIds?.length) p["decoderIds"] = q.decoderIds.join(",")
	if (q.protocols?.length) p["protocols"] = q.protocols.join(",")
	if (q.categories?.length) p["categories"] = q.categories.join(",")
	if (q.frequencyHz?.min !== undefined) p["frequencyMin"] = q.frequencyHz.min
	if (q.frequencyHz?.max !== undefined) p["frequencyMax"] = q.frequencyHz.max
	if (q.producedAt?.from !== undefined) p["producedFrom"] = q.producedAt.from
	if (q.producedAt?.to !== undefined) p["producedTo"] = q.producedAt.to
	if (q.entityKey !== undefined) p["entityKey"] = q.entityKey
	if (q.text !== undefined && q.text.length > 0) p["text"] = q.text
	return p
}

export interface ActivityFeedOptions {
	/** Delay that batches live records into one update; default 120 ms. */
	flushMs?: number
	pageSize?: number
	/** Most items kept in the list; default MAX_ITEMS. */
	maxItems?: number
	/** Subscription id prefix; each feed instance needs its own. */
	id?: string
}

let feedCount = 0

export class ActivityFeed extends Store<ActivityFeedState> {
	private readonly api: ApiClient
	private readonly events: EventsClient
	private readonly flushMs: number
	private readonly pageSize: number
	private readonly maxItems: number
	private readonly id: string
	private readonly cleanup: (() => void)[]
	private unsubscribe: (() => void) | null = null
	private inbox: ActivitySummary[] = []
	private timer: ReturnType<typeof setTimeout> | null = null
	private generation = 0
	private subId = ""
	/** The snapshot's page token, kept while paging continues from the cache's own (see reopenPaging). */
	private fallbackToken: string | null = null
	/**
	 * The query `nextPageToken` was issued for: the core binds a cursor to its exact query, so after a
	 * rolling range moved on, the cache's token pages on with the query it came from (a wider range; rows
	 * before the new start are dropped) and never meets "query-changed".
	 */
	private pageQuery: ActivityQuery | null = null

	constructor(
		api: ApiClient,
		events: EventsClient,
		options: ActivityFeedOptions = {},
	) {
		super(INITIAL)
		this.api = api
		this.events = events
		this.flushMs = options.flushMs ?? 120
		this.pageSize = options.pageSize ?? PAGE
		this.maxItems = options.maxItems ?? MAX_ITEMS
		feedCount += 1
		this.id = options.id ?? `activity-${feedCount}`
		this.cleanup = [
			events.on("activity:records", data => {
				if (data.id === this.subId) this.receive(data.items)
			}),
			events.on("activity:reset", data => {
				if (data.id !== this.subId) return
				// another store: its sequence numbers say nothing about the cached rows
				this.update(s =>
					data.reason === "store-changed"
						? { ...s, reset: data.reason, items: [], pending: [] }
						: { ...s, reset: data.reason },
				)
				void this.reload()
			}),
			events.on("error", data => {
				if (data.id !== undefined && data.id === this.subId)
					this.update(s => ({ ...s, error: data.message }))
			}),
		]
	}

	/** Most items the list keeps. */
	get capacity(): number {
		return this.maxItems
	}

	/**
	 * Shows `query` (null clears the list): loads the snapshot, then follows it live. The same search as
	 * the one shown (`key`, else the query's parameters) keeps the list while it reloads: the cache across
	 * close/open. The same parameters keep the query object too; a rolling range that moved takes the new
	 * query and drops the cached rows before its start.
	 */
	setQuery(query: ActivityQuery | null, key?: string): Promise<void> {
		const s = this.get()
		const searchKey =
			query === null ? null : (key ?? JSON.stringify(queryParams(query)))
		if (query !== null && s.query !== null && s.searchKey === searchKey) {
			const same = sameQuery(s.query, query)
			const from = query.producedAt?.from
			this.set({
				...s,
				query: same ? s.query : query,
				items: same ? s.items : since(s.items, from),
				pending: same ? s.pending : since(s.pending, from),
				error: null,
				reset: null,
			})
			return this.reload()
		}
		this.fallbackToken = null
		this.pageQuery = null
		this.set({
			...INITIAL,
			query,
			searchKey,
			paused: s.paused,
			holding: s.holding,
		})
		return this.reload()
	}

	/** Reloads the snapshot for the current query and restarts the live feed after it. */
	async reload(): Promise<void> {
		const generation = ++this.generation
		this.stopLive()
		const query = this.get().query
		if (query === null) {
			this.update(s => ({ ...s, status: "idle", items: [], pending: [] }))
			return
		}
		// A reload invalidates any older-page request in flight (its generation check drops it), so the
		// paging flag it set must clear here or loadMore() would stay blocked.
		this.update(s => ({
			...s,
			status: "loading",
			error: null,
			loadingMore: false,
		}))
		try {
			const page = await this.fetchPage(query, null)
			if (generation !== this.generation) return
			this.update(s => {
				const cached = [...s.pending, ...s.items]
				const fresh = [...page.items].sort(newestFirst)
				const keep = joins(fresh, cached, page.nextPageToken === null)
				const items = keep
					? reopenMerge(cached, fresh, page.snapshot.lowBarrier, this.maxItems)
					: fresh.slice(0, this.maxItems)
				const paging = keep
					? reopenPaging(
							cached.at(-1),
							s.nextPageToken,
							fresh,
							page.nextPageToken,
							page.snapshot.lowBarrier,
						)
					: { token: page.nextPageToken, fallback: null }
				this.fallbackToken = paging.fallback
				// the cache's token belongs to the query it was issued for; the snapshot's to this one
				const fromCache =
					keep && paging.token !== null && paging.token === s.nextPageToken
				if (!fromCache) this.pageQuery = query
				else this.pageQuery ??= query
				return {
					...s,
					status: "live",
					items,
					pending: [],
					nextPageToken: paging.token,
					available: true,
				}
			})
			this.subId = `${this.id}-${generation}`
			this.unsubscribe = this.events.subscribeActivity(
				this.subId,
				query,
				page.replayCursor,
			)
		} catch (error) {
			if (generation !== this.generation) return
			const status = (error as { status?: number }).status
			this.update(s => ({
				...s,
				status: "error",
				error: errorMessage(error),
				available: status !== 404 && status !== 503,
			}))
		}
	}

	/**
	 * The next (older) page of the snapshot. Continuing from the cache's own token, with the query that
	 * token was issued for, no cached row is fetched again. When the core no longer takes that token (it
	 * expired), paging starts over from the snapshot's token, whose pages first repeat the cached rows below
	 * the snapshot: those pages are skipped (fetched, never merged) up to a bound of one page per page of
	 * rows held, plus one.
	 */
	async loadMore(): Promise<void> {
		const s = this.get()
		const query = s.query
		if (query === null || s.nextPageToken === null || s.loadingMore) return
		const generation = this.generation
		const tokenQuery = this.pageQuery ?? query
		this.update(v => ({ ...v, loadingMore: true }))
		try {
			let pagedWith = tokenQuery
			let page = await this.fetchPage(tokenQuery, s.nextPageToken).catch(
				(error: unknown) => {
					// the cache's token expired: page on from the snapshot's
					const fallback = this.fallbackToken
					const status = (error as { status?: number }).status
					if (
						fallback === null ||
						generation !== this.generation ||
						status === undefined ||
						status < 400 ||
						status >= 500 ||
						status === 429
					)
						throw error
					pagedWith = query
					return this.fetchPage(query, fallback).then(p =>
						this.pastHeld(query, p, s.items, generation),
					)
				},
			)
			if (generation !== this.generation) return
			const fallback = this.fallbackToken
			this.fallbackToken = null
			this.pageQuery = pagedWith
			// a wider query's page (the range before it moved on): only the rows inside the current range
			if (pagedWith !== query) {
				const inside = since(page.items, query.producedAt?.from)
				// every row before the range's start (today, past midnight): older pages are older still, so
				// page on from the snapshot's token with this query, or stop
				const stale = page.items.length > 0 && inside.length === 0
				if (stale) this.pageQuery = query
				page = {
					...page,
					items: [...inside],
					nextPageToken: stale ? fallback : page.nextPageToken,
				}
			}
			this.update(v => ({
				...v,
				loadingMore: false,
				items: mergeNewest(v.items, page.items, this.maxItems),
				nextPageToken: page.nextPageToken,
			}))
		} catch (error) {
			if (generation !== this.generation) return
			this.update(v => ({
				...v,
				loadingMore: false,
				error: errorMessage(error),
			}))
		}
	}

	setPaused(paused: boolean): void {
		this.update(s => ({ ...s, paused }))
		if (!paused) this.release()
	}

	setHolding(holding: boolean): void {
		if (this.get().holding === holding) return
		this.update(s => ({ ...s, holding }))
		if (!holding) this.release()
	}

	/** Moves held records into the list ("N new" clicked, or live again). */
	release(): void {
		const s = this.get()
		if (s.pending.length === 0) return
		this.set({
			...s,
			items: mergeNewest(s.items, s.pending, this.maxItems),
			pending: [],
		})
	}

	/** Stops the live feed and pending flushes; the store keeps its last state. */
	stop(): void {
		this.generation += 1
		this.stopLive()
	}

	dispose(): void {
		this.stop()
		for (const off of this.cleanup) off()
	}

	/**
	 * Pages on from `page` while it holds only rows at or above the oldest held row (the cache, fetched
	 * again from the snapshot's token): at most one page per `pageSize` rows held, plus one.
	 */
	private async pastHeld(
		query: ActivityQuery,
		page: ActivitySearchPage,
		held: readonly ActivitySummary[],
		generation: number,
	): Promise<ActivitySearchPage> {
		const oldest = held.at(-1)
		if (oldest === undefined) return page
		const bound = Math.ceil(held.length / this.pageSize) + 1
		const repeats = (p: ActivitySearchPage) =>
			p.items.length > 0 &&
			p.items.every(i => compareSeq(i.commitSeq, oldest.commitSeq) >= 0)
		for (let n = 0; n < bound && repeats(page); n++) {
			if (page.nextPageToken === null || generation !== this.generation) break
			page = await this.fetchPage(query, page.nextPageToken)
		}
		return page
	}

	private fetchPage(
		query: ActivityQuery,
		pageToken: string | null,
	): Promise<ActivitySearchPage> {
		const q: Record<string, QueryValue> = {
			...queryParams(query),
			order: "desc",
			limit: this.pageSize,
		}
		if (pageToken !== null) q["pageToken"] = pageToken
		return this.api
			.request<unknown>("GET", "/api/activity", undefined, { query: q })
			.then(body => validated(pageSchema, body, "GET", "/api/activity"))
	}

	private receive(items: readonly ActivitySummary[]): void {
		if (items.length === 0) return
		this.inbox.push(...items)
		if (this.timer === null)
			this.timer = setTimeout(() => this.flush(), this.flushMs)
	}

	private flush(): void {
		this.timer = null
		const batch = this.inbox
		this.inbox = []
		if (batch.length === 0) return
		const s = this.get()
		if (s.paused || s.holding)
			this.set({ ...s, pending: mergeNewest(s.pending, batch, this.maxItems) })
		else this.set({ ...s, items: mergeNewest(s.items, batch, this.maxItems) })
	}

	private stopLive(): void {
		if (this.timer !== null) clearTimeout(this.timer)
		this.timer = null
		this.inbox = []
		this.unsubscribe?.()
		this.unsubscribe = null
		this.subId = ""
	}
}

/** GET /api/activity/:eventId: the full stored record, or null when it expired. */
export async function fetchActivityRecord(
	api: ApiClient,
	eventId: string,
	signal?: AbortSignal,
): Promise<ActivityRecord | null> {
	try {
		return await api.request<ActivityRecord>(
			"GET",
			`/api/activity/${encodeURIComponent(eventId)}`,
			undefined,
			signal ? { signal } : {},
		)
	} catch (error) {
		if ((error as { status?: number }).status === 404) return null
		throw error
	}
}

/** POST /api/activity/facets for one dimension; counts by value (null values dropped). */
export async function fetchCategoryCounts(
	api: ApiClient,
	query: ActivityQuery,
	signal?: AbortSignal,
): Promise<Record<string, number>> {
	const body = await api.request<{
		facets?: Record<string, readonly { value: string | null; count: number }[]>
	}>(
		"POST",
		"/api/activity/facets",
		{ query, dimensions: ["category"] },
		signal ? { signal } : {},
	)
	const out: Record<string, number> = {}
	for (const row of body.facets?.["category"] ?? [])
		if (row.value !== null) out[row.value] = row.count
	return out
}
