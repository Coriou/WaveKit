/**
 * Recordings (WG8 inventory, WG9 Keep and delete; protected core only): the WAV files WaveKit writes
 * (dsd-fme per-call recordings, scanner recordings), read from the core's catalogue page by page with
 * its server-side filters and counts (a PagedFeed). Keep / unkeep, delete with a grace period for Undo,
 * and the file itself for playback.
 *
 * While the panel is open (`attach`) the store follows the `recordings` socket channel: each
 * `recordings:changed` notice (at most one a second, counts only) re-reads the head of the list, and so
 * does a reconnect. Nothing polls.
 */
import {
	RECORDING_DELETE_ROUTE,
	RECORDING_INVENTORY_KINDS,
	RECORDING_KEEP_ROUTE,
	RECORDINGS_FILE_ROUTE,
	RECORDINGS_PAGE_LIMIT_MAX,
	RECORDINGS_QUERY_TEXT_MAX,
	RECORDINGS_ROUTE,
} from "@wavekit/api-types"
import type {
	RecordingDeleteResult,
	RecordingInventoryCounts,
	RecordingInventoryItem,
	RecordingInventoryKind,
	RecordingKeepResult,
} from "@wavekit/api-types"
import { z } from "zod/v4"

import type { ApiClient, QueryValue } from "./api-client.ts"
import { ApiError } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import type {
	FeedPage,
	PagedFeedOptions,
	PagedFeedState,
} from "./paged-feed.ts"
import { PagedFeed } from "./paged-feed.ts"
import { Store } from "./store.ts"

/** How long a delete waits for Undo before it reaches the core. */
export const RECORDING_DELETE_GRACE_MS = 6000
/**
 * Most recordings held in the browser: 50 pages of RECORDINGS_PAGE_LIMIT_MAX. About 1 kB each as
 * objects, so 10 000 rows stay inside the panels' 30 MB heap budget beside Activity's 5 000 summaries;
 * past it the list says to search (the counts stay true, from the core).
 */
export const RECORDINGS_WINDOW_MAX = 10_000

/** The server-side filters the panel uses (GET /api/recordings query keys). */
export interface RecordingsQuery {
	kept?: true
	/**
	 * false: copies (items with a copyOf) are left out; the core lists them by default. Sent only to a
	 * core that showed it knows the key (an older one refuses it: RecordingsStore.copiesKnown).
	 */
	copies?: false
	kind?: RecordingInventoryKind
	talkgroup?: string
	source?: string
	minHz?: number
	maxHz?: number
	/** Text, 1 to RECORDINGS_QUERY_TEXT_MAX characters (longer text is cut there). */
	q?: string
}

/** What a page says about the whole catalogue. */
export interface RecordingsMeta {
	/** Totals over everything listed, whatever the filters; null from an older core. */
	counts: RecordingInventoryCounts | null
	/** Recordings matching the filters; null from an older core. */
	matched: number | null
	/** The catalogue left the oldest out (past its bound) or a folder bound was reached. */
	truncated: boolean
	truncatedBefore: string | null
	/** The first build is still running: the list is partial, newest folders first. */
	indexing: boolean
	revision: number | null
	scannedAt: string | null
	scannedFiles: number
}

export type RecordingsState = PagedFeedState<
	RecordingInventoryItem,
	RecordingsQuery,
	RecordingsMeta
>

export interface RecordingMarks {
	/** Deleted here, waiting for Undo: hidden from the list until the delete lands or is undone. */
	removing: ReadonlySet<string>
	/** Keep or unkeep in flight. */
	keeping: ReadonlySet<string>
}

const path = (route: string, id: string) =>
	route.replace(":id", encodeURIComponent(id))

const nullableString = z.string().nullable().catch(null)
const itemSchema = z
	.object({
		id: z.string(),
		kind: z.enum(RECORDING_INVENTORY_KINDS as [RecordingInventoryKind]),
		modifiedAt: z.string(),
		bytes: z.number(),
		decoderId: nullableString,
		discoveryId: nullableString,
		startedAtLocal: nullableString,
		durationMs: z.number().nullable().catch(null),
		callType: z.enum(["group", "private", "unit"]).nullable().catch(null),
		talkgroup: nullableString,
		source: nullableString,
		frequencyHz: z.number().nullable().catch(null),
	})
	.passthrough()
const countsSchema = z
	.object({
		total: z.number(),
		kept: z.number(),
		bytes: z.number(),
		byKind: z.record(z.string(), z.number()),
	})
	.passthrough()
const pageSchema = z
	.object({
		items: z.array(z.unknown()),
		nextCursor: z.string().nullable(),
		scannedFiles: z.number().catch(0),
		truncated: z.boolean().catch(false),
		scannedAt: z.string().nullable().catch(null),
		revision: z.number().optional(),
		indexing: z.boolean().optional(),
		matched: z.number().optional(),
		counts: countsSchema.optional().catch(undefined),
		truncatedBefore: z.string().nullable().optional().catch(null),
	})
	.passthrough()

/**
 * The GET /api/recordings query string of a query, at most `limit` rows after `cursor`. `copies=false`
 * only with `copiesKnown` (the core showed it knows the key: an older core answers 400
 * RECORDINGS_QUERY_INVALID to an unknown key); without it the list asks with copies listed.
 */
export function recordingsParams(
	q: RecordingsQuery,
	limit: number,
	cursor: string | null,
	copiesKnown = true,
): Record<string, QueryValue> {
	const p: Record<string, QueryValue> = { limit }
	if (cursor !== null) p["cursor"] = cursor
	if (q.kept) p["kept"] = "true"
	if (q.copies === false && copiesKnown) p["copies"] = "false"
	if (q.kind !== undefined) p["kind"] = q.kind
	if (q.talkgroup !== undefined) p["talkgroup"] = q.talkgroup
	if (q.source !== undefined) p["source"] = q.source
	if (q.minHz !== undefined) p["minHz"] = Math.round(q.minHz)
	if (q.maxHz !== undefined) p["maxHz"] = Math.round(q.maxHz)
	const text = q.q?.trim().slice(0, RECORDINGS_QUERY_TEXT_MAX)
	if (text) p["q"] = text
	return p
}

/** Newest modification first, ties by id ascending (the core's order). */
export function compareRecordings(
	a: RecordingInventoryItem,
	b: RecordingInventoryItem,
): number {
	if (a.modifiedAt !== b.modifiedAt) return a.modifiedAt > b.modifiedAt ? -1 : 1
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** `protected-only`: the routes are not mounted (a core without access protection). */
export function recordingsUnavailable(
	s: Pick<RecordingsState, "status" | "errorStatus" | "errorCode">,
): "protected-only" | null {
	return s.status === "error" &&
		s.errorStatus === 404 &&
		s.errorCode !== "RECORDING_NOT_FOUND"
		? "protected-only"
		: null
}

const withSet = (set: ReadonlySet<string>, id: string, on: boolean) => {
	const next = new Set(set)
	if (on) next.add(id)
	else next.delete(id)
	return next
}

export class RecordingsStore extends PagedFeed<
	RecordingInventoryItem,
	RecordingsQuery,
	RecordingsMeta
> {
	private readonly api: ApiClient
	private readonly events: EventsClient | null
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
	/** Deletes waiting for Undo and Keeps in flight. */
	readonly marks = new Store<RecordingMarks>({
		removing: new Set(),
		keeping: new Set(),
	})
	private attached = 0
	private detachLive: (() => void) | null = null
	/**
	 * Keep outcomes and deletes that landed here, by id, with the number of head reads started when they
	 * landed: a head asked for before then cannot know them, so they are applied over it; the first head
	 * asked for after them is the truth and ends them.
	 */
	private readonly kept = new Map<string, { kept: boolean; after: number }>()
	/**
	 * The core showed it knows copies (an answer with `counts.copiesTotal`, or an item carrying
	 * `copyOf`): only then is `copies=false` sent. Never forgotten for this store's life.
	 */
	private copiesKnown = false
	private readonly gone = new Map<string, number>()

	constructor(
		api: ApiClient,
		events: EventsClient | null = null,
		options: Partial<PagedFeedOptions> = {},
	) {
		super({
			maxItems: RECORDINGS_WINDOW_MAX,
			pageSize: RECORDINGS_PAGE_LIMIT_MAX,
			...options,
		})
		this.api = api
		this.events = events
	}

	/**
	 * The panel is open: show `query` (the same search keeps its rows and refreshes them) and follow the
	 * catalogue's change notices. Returns the detach (the panel closed): the rows stay for the next open.
	 */
	attach(query: RecordingsQuery = {}): () => void {
		this.attached += 1
		if (this.attached === 1) this.follow()
		void this.setQuery(query)
		return () => {
			this.attached -= 1
			if (this.attached > 0) return
			this.detachLive?.()
			this.detachLive = null
			this.stop()
		}
	}

	/** The search changed. Never rejects. */
	show(query: RecordingsQuery): Promise<void> {
		return this.setQuery(query)
	}

	/** The download link (whole WAV, `Content-Disposition: attachment`). */
	fileUrl(id: string): string {
		return this.api.url(path(RECORDINGS_FILE_ROUTE, id))
	}

	/** The WAV file, for playback in this browser. Rejects with the ApiError. */
	file(id: string, signal?: AbortSignal): Promise<Blob> {
		return this.api.blob(
			path(RECORDINGS_FILE_ROUTE, id),
			signal ? { signal } : {},
		)
	}

	/** Keep (true) or unkeep (false). Shows the change at once; rejects with the ApiError and reverts. */
	async setKept(id: string, kept: boolean): Promise<void> {
		const before = this.get().items.find(i => i.id === id)
		if (!before) return
		this.patchItem(id, { kept })
		this.mark("keeping", id, true)
		try {
			const route = path(RECORDING_KEEP_ROUTE, id)
			const result = kept
				? await this.api.put<RecordingKeepResult>(route)
				: await this.api.delete<RecordingKeepResult>(route)
			this.patchItem(id, { kept: result.kept })
			this.kept.set(id, { kept: result.kept, after: this.headReads })
		} catch (error) {
			this.patchItem(id, { kept: before.kept === true })
			if (error instanceof ApiError && error.code === "RECORDING_NOT_FOUND")
				this.drop(id)
			throw error
		} finally {
			this.mark("keeping", id, false)
		}
	}

	/**
	 * Hides the recording now and deletes it after `graceMs` unless the returned undo runs first.
	 * `onError` hears a failed delete (the recording shows again).
	 */
	scheduleRemove(
		id: string,
		onError: (error: unknown) => void,
		graceMs = RECORDING_DELETE_GRACE_MS,
	): () => void {
		this.cancelTimer(id)
		this.mark("removing", id, true)
		this.timers.set(
			id,
			setTimeout(() => {
				this.timers.delete(id)
				void this.remove(id).catch(onError)
			}, graceMs),
		)
		return () => {
			if (!this.timers.has(id)) return
			this.cancelTimer(id)
			this.mark("removing", id, false)
		}
	}

	/** Sends every delete still waiting for Undo (the page is going away). */
	flushRemovals(): void {
		for (const id of [...this.timers.keys()]) {
			this.cancelTimer(id)
			void this.remove(id).catch(() => {})
		}
	}

	/** DELETE now. Rejects with the ApiError (the recording shows again). */
	async remove(id: string): Promise<void> {
		try {
			await this.api.delete<RecordingDeleteResult>(
				path(RECORDING_DELETE_ROUTE, id),
			)
			this.drop(id)
		} catch (error) {
			if (error instanceof ApiError && error.code === "RECORDING_NOT_FOUND") {
				this.drop(id)
				return
			}
			this.mark("removing", id, false)
			throw error
		}
	}

	override dispose(): void {
		this.flushRemovals()
		this.detachLive?.()
		this.detachLive = null
		super.dispose()
	}

	protected fetchPage(
		query: RecordingsQuery,
		cursor: string | null,
		signal: AbortSignal,
	): Promise<FeedPage<RecordingInventoryItem, RecordingsMeta>> {
		return this.api
			.get<unknown>(RECORDINGS_ROUTE, {
				query: recordingsParams(query, this.pageSize, cursor, this.copiesKnown),
				signal,
				timeoutMs: this.timeoutMs,
			})
			.then(body => {
				const page = pageSchema.safeParse(body)
				if (!page.success)
					throw new ApiError({
						status: 200,
						code: "RESPONSE_INVALID",
						message: `Unexpected answer from ${RECORDINGS_ROUTE}`,
						body,
						method: "GET",
						path: RECORDINGS_ROUTE,
					})
				const items: RecordingInventoryItem[] = []
				for (const raw of page.data.items) {
					const item = itemSchema.safeParse(raw)
					if (item.success) items.push(item.data as RecordingInventoryItem)
				}
				const d = page.data
				const counts =
					(d.counts as RecordingInventoryCounts | undefined) ?? null
				if (
					!this.copiesKnown &&
					(counts?.copiesTotal !== undefined ||
						items.some(i => i.copyOf !== undefined))
				) {
					this.copiesKnown = true
					// A list that wanted copies left out was read with them: read again (the key changed).
					if (query.copies === false)
						setTimeout(() => void this.setQuery(query), 0)
				}
				return {
					items,
					nextCursor: d.nextCursor,
					meta: {
						counts,
						matched: d.matched ?? null,
						truncated: d.truncated,
						truncatedBefore: d.truncatedBefore ?? null,
						indexing: d.indexing === true,
						revision: d.revision ?? null,
						scannedAt: d.scannedAt,
						scannedFiles: d.scannedFiles,
					},
				}
			})
	}

	protected override adjustPage(
		page: FeedPage<RecordingInventoryItem, RecordingsMeta>,
		read: number,
	): FeedPage<RecordingInventoryItem, RecordingsMeta> {
		for (const [id, after] of this.gone) if (read > after) this.gone.delete(id)
		for (const [id, k] of this.kept) if (read > k.after) this.kept.delete(id)
		if (this.gone.size === 0 && this.kept.size === 0) return page
		const items: RecordingInventoryItem[] = []
		for (const item of page.items) {
			if (this.gone.has(item.id)) continue
			const k = this.kept.get(item.id)
			items.push(k === undefined ? item : { ...item, kept: k.kept })
		}
		return { ...page, items }
	}

	protected idOf(item: RecordingInventoryItem): string {
		return item.id
	}

	protected compare(
		a: RecordingInventoryItem,
		b: RecordingInventoryItem,
	): number {
		return compareRecordings(a, b)
	}

	protected override keyOf(q: RecordingsQuery): string {
		return JSON.stringify(recordingsParams(q, 0, null, this.copiesKnown))
	}

	protected override retryable(error: unknown): boolean {
		// a core without protection does not grow the routes by itself
		if (error instanceof ApiError && error.status === 404) return false
		// a browser paired (or its session refreshed) after the panel opened: the next try reads
		if (error instanceof ApiError && error.status === 401) return true
		return super.retryable(error)
	}

	/** The `recordings` channel while attached; a notice or a reconnect re-reads the head. */
	private follow(): void {
		const events = this.events
		if (events === null) return
		let hiddenChange = false
		const changed = (revision: number | null) => {
			if (revision !== null && revision === this.get().meta?.revision) return
			if (
				typeof document !== "undefined" &&
				document.visibilityState === "hidden"
			) {
				hiddenChange = true
				return
			}
			void this.notify()
		}
		const onVisible = () => {
			if (document.visibilityState !== "visible" || !hiddenChange) return
			hiddenChange = false
			void this.notify()
		}
		const offs = [
			events.subscribe(["recordings"]),
			events.on("recordings:changed", data =>
				changed(typeof data?.revision === "number" ? data.revision : null),
			),
			events.onReconnected(() => changed(null)),
		]
		if (typeof document !== "undefined") {
			document.addEventListener("visibilitychange", onVisible)
			offs.push(() =>
				document.removeEventListener("visibilitychange", onVisible),
			)
		}
		this.detachLive = () => {
			for (const off of offs) off()
		}
	}

	private mark(which: keyof RecordingMarks, id: string, on: boolean): void {
		this.marks.update(m => ({ ...m, [which]: withSet(m[which], id, on) }))
	}

	private drop(id: string): void {
		this.gone.set(id, this.headReads)
		this.kept.delete(id)
		this.patchItems(items => items.filter(i => i.id !== id))
		this.mark("removing", id, false)
	}

	private patchItem(id: string, patch: Partial<RecordingInventoryItem>): void {
		this.patchItems(items =>
			items.map(i => (i.id === id ? { ...i, ...patch } : i)),
		)
	}

	private cancelTimer(id: string): void {
		const t = this.timers.get(id)
		if (t) clearTimeout(t)
		this.timers.delete(id)
	}
}
