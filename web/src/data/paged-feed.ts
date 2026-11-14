/**
 * One paged list read from a cursor route, newest first: the shared core of the list panels.
 *
 * - A keyed query: the same key keeps the rows on screen while they reload (the cache across a panel's
 *   close and reopen); another key starts over. Every change bumps a generation and aborts what is in
 *   flight, so a late answer never lands on the wrong list.
 * - The first page is the head. A refresh re-reads it and merges it over the rows held: the head is the
 *   truth from the newest row down to its oldest; older rows already paged in stay, the cursor that
 *   pages on from them too (the routes' cursors are positions, not snapshots).
 * - Pages after the head load on demand (`loadMore`) up to `maxItems` rows (`capped` past it).
 * - One status machine, the same words in every panel: `loading` (with `busy` once a read has run past
 *   FEED_BUSY_MS), `ready`, `error` (a read failed or ran past its timeout, FEED_STALL_MS), with an
 *   automatic retry on a backoff (FEED_RETRY_MS) and `retry()` for the Try again button. Rows already
 *   read stay through an error, with `asOf`, the time of the last good answer.
 * - While the list is held (scrolled away from the top, or something in it is playing), a refresh only
 *   counts what is new (`heldNew`); `release()` merges it.
 */
import type { ApiError } from "./api-client.ts"
import { errorMessage } from "./api-client.ts"
import { Store } from "./store.ts"

/** A first read still running after this long shows "Still loading. WaveKit is busy." (3 s, the panel budget). */
export const FEED_BUSY_MS = 3000
/** A read still unanswered after this long is abandoned and shown as failed, with Try again (10 s). */
export const FEED_STALL_MS = 10_000
/**
 * Automatic retries after a failed head read: 2, 4, 8, 16 then every 30 s while the panel is open.
 * The first lands about 12 s after the click on a read that timed out, and a core that stays down costs
 * one read every 30 s.
 */
export const FEED_RETRY_MS: readonly number[] = Object.freeze([
	2000, 4000, 8000, 16_000, 30_000,
])

export type FeedStatus = "idle" | "loading" | "ready" | "error"

export interface FeedPage<T, M> {
	items: readonly T[]
	nextCursor: string | null
	meta: M
}

export interface PagedFeedState<T, Q, M> {
	query: Q | null
	key: string | null
	status: FeedStatus
	/** Newest first, unique by id, at most `maxItems`. */
	items: readonly T[]
	nextCursor: string | null
	loadingMore: boolean
	/** The head read has run past FEED_BUSY_MS. */
	busy: boolean
	error: string | null
	errorCode: string | null
	/** HTTP status of the failed read (0: no answer). */
	errorStatus: number | null
	/** Date.now() of the last good head answer; null before the first. */
	asOf: number | null
	/** Date.now() of the next automatic retry; null when none is planned. */
	retryAt: number | null
	/** The last head page's metadata (counts, flags). */
	meta: M | null
	/** The list holds `maxItems` rows: older rows are not loaded. */
	capped: boolean
	/** Arrivals are held (scrolled away, or playing). */
	holding: boolean
	/** Rows a held refresh found above the newest row shown. */
	heldNew: number
}

export interface PagedFeedOptions {
	/** Most rows held; past it `capped`. */
	maxItems: number
	/** Rows per page. */
	pageSize: number
	busyMs?: number
	/** Per-read timeout (FEED_STALL_MS). */
	timeoutMs?: number
	retryMs?: readonly number[]
	now?: () => number
}

/**
 * The list after a fresh head (both newest first by `compare`): the head, then the held rows older than
 * the head's oldest row. A complete head (no next page) is everything there is.
 */
export function mergeHead<T>(
	list: readonly T[],
	head: readonly T[],
	complete: boolean,
	idOf: (item: T) => string,
	compare: (a: T, b: T) => number,
): T[] {
	const last = head.at(-1)
	if (complete || list.length === 0 || last === undefined) return [...head]
	const ids = new Set(head.map(idOf))
	const out = [...head]
	for (const item of list)
		if (compare(item, last) > 0 && !ids.has(idOf(item))) out.push(item)
	return out
}

/** Rows of `head` that sort before (are newer than) the newest row of `list`, and are not in it. */
export function countNew<T>(
	list: readonly T[],
	head: readonly T[],
	idOf: (item: T) => string,
	compare: (a: T, b: T) => number,
): number {
	const top = list[0]
	if (top === undefined) return head.length
	const ids = new Set(list.map(idOf))
	let n = 0
	for (const item of head) {
		if (compare(item, top) >= 0) break
		if (!ids.has(idOf(item))) n += 1
	}
	return n
}

const isAbort = (error: unknown) =>
	error instanceof DOMException && error.name === "AbortError"

export abstract class PagedFeed<T, Q, M> extends Store<
	PagedFeedState<T, Q, M>
> {
	protected readonly maxItems: number
	protected readonly pageSize: number
	private readonly busyMs: number
	protected readonly timeoutMs: number
	private readonly retryMs: readonly number[]
	protected readonly now: () => number
	private generation = 0
	private headAbort: AbortController | null = null
	private moreAbort: AbortController | null = null
	private busyTimer: ReturnType<typeof setTimeout> | null = null
	private retryTimer: ReturnType<typeof setTimeout> | null = null
	private failures = 0
	private inflight: Promise<void> | null = null
	private again = false
	/** The newest head read while holding, merged on release. */
	private held: FeedPage<T, M> | null = null

	constructor(options: PagedFeedOptions) {
		super({
			query: null,
			key: null,
			status: "idle",
			items: [],
			nextCursor: null,
			loadingMore: false,
			busy: false,
			error: null,
			errorCode: null,
			errorStatus: null,
			asOf: null,
			retryAt: null,
			meta: null,
			capped: false,
			holding: false,
			heldNew: 0,
		})
		this.maxItems = options.maxItems
		this.pageSize = options.pageSize
		this.busyMs = options.busyMs ?? FEED_BUSY_MS
		this.timeoutMs = options.timeoutMs ?? FEED_STALL_MS
		this.retryMs = options.retryMs ?? FEED_RETRY_MS
		this.now = options.now ?? (() => Date.now())
	}

	/** One page of `query` after `cursor` (null: the head). Rejects with the ApiError. */
	protected abstract fetchPage(
		query: Q,
		cursor: string | null,
		signal: AbortSignal,
	): Promise<FeedPage<T, M>>
	protected abstract idOf(item: T): string
	/** The list's order: negative when `a` is listed before `b`. */
	protected abstract compare(a: T, b: T): number
	protected keyOf(query: Q): string {
		return JSON.stringify(query)
	}

	/**
	 * Shows `query`. The key shown already (the same search) keeps its rows and refreshes them; another
	 * starts from an empty list. Never rejects.
	 */
	setQuery(query: Q, key: string = this.keyOf(query)): Promise<void> {
		const s = this.get()
		if (s.key === key && s.query !== null) {
			if (s.query !== query) this.set({ ...s, query })
			return this.refresh()
		}
		this.cancel()
		this.held = null
		this.failures = 0
		this.set({
			...s,
			query,
			key,
			status: "idle",
			items: [],
			nextCursor: null,
			loadingMore: false,
			busy: false,
			error: null,
			errorCode: null,
			errorStatus: null,
			retryAt: null,
			capped: false,
			heldNew: 0,
		})
		return this.refresh()
	}

	/**
	 * Re-reads the head. A refresh asked while one runs runs once more after it (never two at once, never
	 * a lost change). Never rejects.
	 */
	refresh(): Promise<void> {
		if (this.get().query === null) return Promise.resolve()
		if (this.inflight !== null) {
			this.again = true
			return this.inflight
		}
		const run = async () => {
			do {
				this.again = false
				await this.readHead()
			} while (this.again && this.get().query !== null)
		}
		this.inflight = run().finally(() => {
			this.inflight = null
		})
		return this.inflight
	}

	/** Try again now (the button): the backoff starts over. */
	retry(): Promise<void> {
		this.failures = 0
		this.clearRetry()
		return this.refresh()
	}

	/** The next (older) page, up to `maxItems` rows. Never rejects. */
	async loadMore(): Promise<void> {
		const s = this.get()
		if (
			s.query === null ||
			s.nextCursor === null ||
			s.loadingMore ||
			s.capped ||
			s.status !== "ready"
		)
			return
		const generation = this.generation
		const abort = new AbortController()
		this.moreAbort = abort
		this.update(v => ({ ...v, loadingMore: true }))
		try {
			const page = await this.fetchPage(s.query, s.nextCursor, abort.signal)
			if (generation !== this.generation) return
			this.update(v => {
				const ids = new Set(v.items.map(i => this.idOf(i)))
				const added = page.items.filter(i => !ids.has(this.idOf(i)))
				const items = [...v.items, ...added]
				const capped = items.length >= this.maxItems
				return {
					...v,
					loadingMore: false,
					items: capped ? items.slice(0, this.maxItems) : items,
					nextCursor: page.nextCursor,
					capped: capped && page.nextCursor !== null,
				}
			})
		} catch (error) {
			if (generation !== this.generation || isAbort(error)) return
			this.update(v => ({
				...v,
				loadingMore: false,
				error: errorMessage(error),
				errorCode: (error as Partial<ApiError>).code ?? null,
				errorStatus: (error as Partial<ApiError>).status ?? null,
			}))
		} finally {
			if (this.moreAbort === abort) this.moreAbort = null
		}
	}

	/** Holds arrivals (true) or shows them (false). */
	setHolding(holding: boolean): void {
		if (this.get().holding === holding) return
		this.update(s => ({ ...s, holding }))
		if (!holding) this.release()
	}

	/** Merges what a held refresh read ("N new" clicked, or back at the top). */
	release(): void {
		const page = this.held
		this.held = null
		if (page === null) {
			if (this.get().heldNew !== 0) this.update(s => ({ ...s, heldNew: 0 }))
			return
		}
		this.applyHead(page)
	}

	/** The panel closed: nothing in flight, no timers; the rows stay for the next open. */
	stop(): void {
		this.cancel()
		if (this.get().status === "loading" || this.get().busy)
			this.update(s => ({
				...s,
				status: s.asOf === null ? "idle" : "ready",
				busy: false,
				loadingMore: false,
			}))
	}

	dispose(): void {
		this.cancel()
	}

	/** Edits held rows in place (Keep), without a read. */
	protected patchItems(fn: (items: readonly T[]) => readonly T[]): void {
		this.update(s => ({ ...s, items: fn(s.items) }))
		if (this.held !== null)
			this.held = { ...this.held, items: fn(this.held.items) }
	}

	private cancel(): void {
		this.generation += 1
		this.headAbort?.abort()
		this.headAbort = null
		this.moreAbort?.abort()
		this.moreAbort = null
		this.again = false
		this.clearBusy()
		this.clearRetry()
	}

	private async readHead(): Promise<void> {
		const query = this.get().query
		if (query === null) return
		const generation = this.generation
		this.clearRetry()
		const abort = new AbortController()
		this.headAbort = abort
		this.update(s => ({
			...s,
			status: "loading",
			retryAt: null,
			// a pending older page is outrun by the head: its answer is dropped by the generation below
			loadingMore: false,
		}))
		this.moreAbort?.abort()
		this.clearBusy()
		this.busyTimer = setTimeout(() => {
			this.busyTimer = null
			if (generation === this.generation && this.get().status === "loading")
				this.update(s => ({ ...s, busy: true }))
		}, this.busyMs)
		try {
			const page = await this.fetchPage(query, null, abort.signal)
			if (generation !== this.generation) return
			this.failures = 0
			this.clearBusy()
			if (this.get().holding && this.get().items.length > 0) {
				this.held = page
				this.update(s => ({
					...s,
					status: "ready",
					busy: false,
					error: null,
					errorCode: null,
					errorStatus: null,
					asOf: this.now(),
					meta: page.meta,
					heldNew: countNew(
						s.items,
						page.items,
						i => this.idOf(i),
						(a, b) => this.compare(a, b),
					),
				}))
				return
			}
			this.applyHead(page)
		} catch (error) {
			if (generation !== this.generation || isAbort(error)) return
			this.clearBusy()
			const delay =
				this.retryMs[Math.min(this.failures, this.retryMs.length - 1)] ?? 30_000
			this.failures += 1
			const retryable = this.retryable(error)
			this.update(s => ({
				...s,
				status: "error",
				busy: false,
				error: errorMessage(error),
				errorCode: (error as Partial<ApiError>).code ?? null,
				errorStatus: (error as Partial<ApiError>).status ?? null,
				retryAt: retryable ? this.now() + delay : null,
			}))
			if (retryable)
				this.retryTimer = setTimeout(() => {
					this.retryTimer = null
					if (generation === this.generation) void this.refresh()
				}, delay)
		} finally {
			if (this.headAbort === abort) this.headAbort = null
		}
	}

	/** Whether a failed read is tried again by itself (not for an answer that will not change). */
	protected retryable(error: unknown): boolean {
		const status = (error as Partial<ApiError>).status
		return (
			status === undefined || status === 0 || status === 429 || status >= 500
		)
	}

	private applyHead(page: FeedPage<T, M>): void {
		this.update(s => {
			const merged = mergeHead(
				s.items,
				page.items,
				page.nextCursor === null,
				i => this.idOf(i),
				(a, b) => this.compare(a, b),
			)
			// older pages already read page on from where they ended
			const pagedPast = merged.length > page.items.length
			const capped = merged.length >= this.maxItems
			const nextCursor = pagedPast ? s.nextCursor : page.nextCursor
			return {
				...s,
				status: "ready",
				busy: false,
				items: capped ? merged.slice(0, this.maxItems) : merged,
				nextCursor,
				capped: capped && nextCursor !== null,
				error: null,
				errorCode: null,
				errorStatus: null,
				asOf: this.now(),
				meta: page.meta,
				heldNew: 0,
			}
		})
	}

	private clearBusy(): void {
		if (this.busyTimer !== null) clearTimeout(this.busyTimer)
		this.busyTimer = null
	}

	private clearRetry(): void {
		if (this.retryTimer !== null) clearTimeout(this.retryTimer)
		this.retryTimer = null
	}
}
