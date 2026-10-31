// Pause / resume of the receiver feed (POST /api/sources/:id/pause and /resume): the core closes the receiver
// link without reconnecting, decoders wait ("source-paused") and the waterfall stops on its last rows. The feed
// state is the newest of what the source rows said (GET /api/sources, `source:status`) and what the last pause
// or resume answered here. The controller remembers every feed a row carries, so a `source:status` without
// `feed` (an older core's socket) keeps the one known, and a connected source is never shown paused. Feeds
// with the same `since` (resuming then live within one millisecond) are told apart by arrival: socket and REST
// deliveries arrive in order, so the later one wins. A 200 answer with `persisted: false` changed the feed but
// did not save it; the entry keeps that until a repeated call (which retries the write) saves it.
import type {
	DecoderInfo,
	ExtendedSourceStatus,
	SourceFeed,
	SourceFeedResponse,
} from "@wavekit/api-types"
import { SOURCE_RESUME_FAILED_MESSAGE } from "@wavekit/api-types"

import type { DataLayer } from "../../data/index.ts"
import { errorMessage, isApiError, Store } from "../../data/index.ts"

export type FeedOp = "pause" | "resume"

export interface FeedEntry {
	/** The newest feed a pause or resume answered or a source row carried. */
	readonly feed: SourceFeed | null
	/** A pause or resume in flight. */
	readonly pending: FeedOp | null
	/** Why the last call failed (other than a failed resume, which the feed itself says). */
	readonly error: string | null
	/** The call whose change the core could not save (`persisted: false`): repeating it retries the write. */
	readonly unsaved: FeedOp | null
}

export interface FeedState {
	readonly bySource: Readonly<Record<string, FeedEntry>>
}

export interface FeedResult {
	readonly ok: boolean
	/** True when the call changed the feed (false for a repeated pause or resume). */
	readonly changed: boolean
	readonly feed: SourceFeed | null
	/** False when the core changed the feed but could not save it (it will not survive a restart). */
	readonly persisted: boolean
	/** Safe words for a failure or an unsaved change; null on success. `ok` is false for both. */
	readonly error: string | null
}

/** What the receiver shows: "live", "paused", "resuming" or "error" (a resume failed; still paused). */
export type FeedView = SourceFeed["state"]

const EMPTY: FeedEntry = {
	feed: null,
	pending: null,
	error: null,
	unsaved: null,
}

/** What an unsaved pause or resume says: it holds now, a core restart undoes it. */
export const FEED_UNSAVED_TEXT: Readonly<Record<FeedOp, string>> = {
	pause: "Paused, but not saved — it will not survive a restart",
	resume: "Resumed, but not saved — the receiver starts paused after a restart",
}

/**
 * The newer of two feeds, `b` the later to arrive: the later `since` wins, and on equal times `b` (a feed
 * reaches the same `since` only through a quick transition, resuming then live, sent in that order).
 */
function newer(a: SourceFeed | null, b: SourceFeed | null): SourceFeed | null {
	if (a === null) return b
	if (b === null) return a
	const ta = Date.parse(a.since)
	const tb = Date.parse(b.since)
	if (Number.isNaN(ta)) return b
	if (Number.isNaN(tb)) return a
	return tb >= ta ? b : a
}

function isFeed(value: unknown): value is SourceFeed {
	if (typeof value !== "object" || value === null) return false
	const v = value as Record<string, unknown>
	return (
		(v["state"] === "live" ||
			v["state"] === "paused" ||
			v["state"] === "resuming" ||
			v["state"] === "error") &&
		typeof v["since"] === "string"
	)
}

/**
 * The feed to show for a source: the newest of the source's own `feed` and the one known here (the one known
 * here on equal times: it took in every row, so it arrived last). A recording (no feed anywhere) reads null. A source the core reports connected is live whatever is cached: the cache can
 * only lag (another browser resumed it), never a paused source stream.
 */
export function feedOf(
	source: Pick<ExtendedSourceStatus, "connected" | "feed"> | undefined,
	entry: FeedEntry | undefined,
): SourceFeed | null {
	const feed = newer(source?.feed ?? null, entry?.feed ?? null)
	if (feed === null) return null
	if (feed.state !== "live" && source?.connected === true && !source.feed)
		return { state: "live", since: feed.since }
	return feed
}

/** Whether the feed holds the source back (anything but live). */
export function isPaused(feed: SourceFeed | null): boolean {
	return feed !== null && feed.state !== "live"
}

/** Decoders on `sourceId` waiting for the feed (suspension reason "source-paused"). */
export function pausedDecoders(
	decoders: readonly DecoderInfo[],
	sourceId: string | null,
): DecoderInfo[] {
	if (sourceId === null) return []
	return decoders.filter(
		d =>
			d.sourceId === sourceId &&
			d.suspended === true &&
			d.suspension?.reasonCode === "source-paused",
	)
}

/** The unsaved call to offer again while the feed still reads what it set; null otherwise. */
export function unsavedOp(
	entry: FeedEntry | undefined,
	feed: SourceFeed | null,
): FeedOp | null {
	const op = entry?.unsaved ?? null
	if (op === null || feed === null) return null
	if (op === "pause" ? feed.state === "paused" : feed.state === "live")
		return op
	return null
}

/** "Paused 14:02" style: the local time the feed entered its state, or null when unknown. */
export function sinceText(feed: SourceFeed | null): string | null {
	if (!feed) return null
	const t = Date.parse(feed.since)
	if (Number.isNaN(t)) return null
	return new Date(t).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	})
}

/** The receiver's short state word for the head and the tag. */
export function feedLabel(feed: SourceFeed | null): string | null {
	switch (feed?.state) {
		case "paused":
			return "Paused"
		case "resuming":
			return "Resuming…"
		case "error":
			return "Paused · resume failed"
		default:
			return null
	}
}

type FeedData = Pick<DataLayer, "api"> & Partial<Pick<DataLayer, "sources">>

/** Pause and resume for every source, with their in-flight state and last failure. */
export class FeedController extends Store<FeedState> {
	private readonly data: FeedData

	/** With `data.sources`, every feed a source row carries is remembered (see `remember`). */
	constructor(data: FeedData) {
		super({ bySource: {} })
		this.data = data
		const sources = data.sources
		if (sources) {
			this.remember(sources.get().sources)
			sources.subscribe(next => this.remember(next.sources))
		}
	}

	/**
	 * Keeps the newest feed each row carries (the row on equal times: it arrived later), so a later row
	 * without `feed` (an older core's `source:status`) does not lose it. Such a row never changes the cache: a connected one already
	 * reads live in `feedOf`, and one sent before a pause may arrive after its answer.
	 */
	remember(rows: readonly Pick<ExtendedSourceStatus, "id" | "feed">[]): void {
		for (const row of rows) {
			if (!row.feed) continue
			const known = this.entry(row.id).feed
			const next = newer(known, row.feed)
			if (next !== known) this.patch(row.id, { feed: next })
		}
	}

	entry(sourceId: string): FeedEntry {
		return this.get().bySource[sourceId] ?? EMPTY
	}

	/** Never rejects: a failure lands in the entry and the result. */
	pause(sourceId: string): Promise<FeedResult> {
		return this.run(sourceId, "pause")
	}

	/** Never rejects. A failed resume reads feed "error" with the core's fixed message. */
	resume(sourceId: string): Promise<FeedResult> {
		return this.run(sourceId, "resume")
	}

	/** Forgets a failure note (the feed's own error stays until a resume succeeds). */
	dismiss(sourceId: string): void {
		this.patch(sourceId, { error: null })
	}

	private patch(sourceId: string, next: Partial<FeedEntry>): void {
		this.update(s => ({
			bySource: {
				...s.bySource,
				[sourceId]: { ...(s.bySource[sourceId] ?? EMPTY), ...next },
			},
		}))
	}

	private async run(sourceId: string, op: FeedOp): Promise<FeedResult> {
		const busy = this.entry(sourceId).pending
		if (busy !== null)
			return {
				ok: false,
				changed: false,
				feed: this.entry(sourceId).feed,
				persisted: true,
				error: busy === "pause" ? "Already pausing" : "Already resuming",
			}
		this.patch(sourceId, { pending: op, error: null })
		try {
			const answer = await this.data.api.post<SourceFeedResponse>(
				`/api/sources/${encodeURIComponent(sourceId)}/${op}`,
			)
			const feed = isFeed(answer?.feed) ? answer.feed : null
			// an older core leaves `persisted` out: only an explicit false is unsaved
			const persisted = answer?.persisted !== false
			this.patch(sourceId, {
				pending: null,
				feed,
				unsaved: persisted ? null : op,
			})
			const changed = answer?.changed === true
			return persisted
				? { ok: true, changed, feed, persisted, error: null }
				: { ok: false, changed, feed, persisted, error: FEED_UNSAVED_TEXT[op] }
		} catch (error) {
			// 503 SOURCE_RESUME_FAILED carries the feed ("error"): the source stays paused, resume retries
			if (isApiError(error) && error.code === "SOURCE_RESUME_FAILED") {
				const body = error.body as { feed?: unknown } | null
				const feed: SourceFeed = isFeed(body?.feed)
					? body.feed
					: {
							state: "error",
							since: new Date().toISOString(),
							error: SOURCE_RESUME_FAILED_MESSAGE,
						}
				this.patch(sourceId, { pending: null, feed })
				return {
					ok: false,
					changed: true,
					feed,
					persisted: true,
					error: feed.error ?? SOURCE_RESUME_FAILED_MESSAGE,
				}
			}
			const text = failureText(error, op)
			this.patch(sourceId, { pending: null, error: text })
			return {
				ok: false,
				changed: false,
				feed: this.entry(sourceId).feed,
				persisted: true,
				error: text,
			}
		}
	}
}

/** Fixed words for the core's codes; other failures say what the client knows. */
function failureText(error: unknown, op: FeedOp): string {
	if (isApiError(error)) {
		if (error.code === "SOURCE_FEED_UNSUPPORTED")
			return "A recording cannot be paused"
		if (error.code === "SOURCE_NOT_FOUND") return "The receiver is gone"
		if (error.status === 401 || error.status === 403)
			return "Pair this browser to pause or resume the receiver"
		if (error.status === 404) return "This core cannot pause the receiver"
	}
	return `Could not ${op}: ${errorMessage(error)}`
}

const controllers = new WeakMap<object, FeedController>()

/** The app's one feed controller (per data layer, so tests never share one). */
export function feedControllerFor(data: FeedData): FeedController {
	let c = controllers.get(data)
	if (!c) {
		c = new FeedController(data)
		controllers.set(data, c)
	}
	return c
}

/** The receiver the palette and the P key act on (the tuner's source, else the first) and its feed. */
export function feedTarget(
	data: Pick<DataLayer, "api" | "sources" | "tuner">,
): { readonly sourceId: string; readonly feed: SourceFeed } | null {
	const tunerSource = data.tuner.state()?.sourceId
	const source =
		tunerSource !== undefined
			? data.sources.byId(tunerSource)
			: data.sources.get().sources[0]
	if (!source) return null
	const feed = feedOf(source, feedControllerFor(data).entry(source.id))
	return feed === null ? null : { sourceId: source.id, feed }
}

/** Pauses a live feed or resumes a paused one; null when there is no feed to act on or a call is in flight. */
export function toggleFeed(
	data: Pick<DataLayer, "api" | "sources" | "tuner">,
): {
	readonly op: FeedOp
	readonly sourceId: string
	readonly result: Promise<FeedResult>
} | null {
	const target = feedTarget(data)
	if (!target) return null
	const feeds = feedControllerFor(data)
	if (feeds.entry(target.sourceId).pending !== null) return null
	if (target.feed.state === "resuming") return null
	const op: FeedOp = isPaused(target.feed) ? "resume" : "pause"
	return {
		op,
		sourceId: target.sourceId,
		result:
			op === "pause"
				? feeds.pause(target.sourceId)
				: feeds.resume(target.sourceId),
	}
}
