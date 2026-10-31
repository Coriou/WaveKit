// New aviation-data rows (ACARS, VDL2) as they arrive, for the whole Map: one Activity subscription shared by the
// ACARS layer (reported positions) and the selected aircraft's datalink story. The core allows two Activity
// subscriptions per client, so the Map never opens one per aircraft or per registration. Rows of the snapshot,
// or of a reload after a reset, are not "new": `onReset` tells readers to read their history again instead,
// each time the follow goes live, the first time too (a report between a reader's first read and the
// subscription would otherwise be lost).
import type { ActivitySummary } from "@wavekit/api-types"

import {
	ActivityFeed,
	type ActivityFeedState,
} from "../../data/activity-feed.ts"
import type { ApiClient } from "../../data/api-client.ts"
import type { EventsClient } from "../../data/events-client.ts"

/**
 * Live rows the feed keeps to tell new ones from those already seen. The feed delivers a batch every
 * 120 ms; 500 rows per batch is about 4,000 datalink messages a second, far above any VHF station.
 */
export const LIVE_WINDOW_ROWS = 500

type RowsListener = (rows: readonly ActivitySummary[]) => void

export class AviationLive {
	private readonly api: ApiClient
	private readonly events: EventsClient
	private readonly rowListeners = new Set<RowsListener>()
	private readonly resetListeners = new Set<() => void>()
	private attached = 0
	private stopFeed: (() => void) | null = null

	constructor(api: ApiClient, events: EventsClient) {
		this.api = api
		this.events = events
	}

	/** New rows, newest first, while attached. */
	onRows(listener: RowsListener): () => void {
		this.rowListeners.add(listener)
		return () => {
			this.rowListeners.delete(listener)
		}
	}

	/**
	 * The live follow (re)started: on attach, after a reset or a reconnect. Rows from before it may be
	 * missing from what a reader read earlier, so it reads its history again (the read now starts after the
	 * subscription, and the subscription's rows after its snapshot arrive through `onRows`).
	 */
	onReset(listener: () => void): () => void {
		this.resetListeners.add(listener)
		return () => {
			this.resetListeners.delete(listener)
		}
	}

	/** Follows while at least one reader is attached (reference counted). */
	attach(): () => void {
		this.attached += 1
		if (this.attached === 1) this.stopFeed = this.start()
		let done = false
		return () => {
			if (done) return
			done = true
			this.attached -= 1
			if (this.attached > 0) return
			this.stopFeed?.()
			this.stopFeed = null
		}
	}

	private start(): () => void {
		const feed = new ActivityFeed(this.api, this.events, {
			id: "map-aviation-live",
			pageSize: 1,
			maxItems: LIVE_WINDOW_ROWS,
		})
		let seen: Set<string> | null = null
		const off = feed.subscribe((s: ActivityFeedState) => {
			if (s.status !== "live") {
				seen = null
				return
			}
			const ids = new Set(s.items.map(r => r.eventId))
			if (seen === null) {
				seen = ids
				// what came before the snapshot, after a reader's last read, is only in the history
				for (const l of [...this.resetListeners]) l()
				return
			}
			const before = seen
			const fresh = s.items.filter(r => !before.has(r.eventId))
			seen = ids
			if (fresh.length > 0) for (const l of [...this.rowListeners]) l(fresh)
		})
		void feed.setQuery({ categories: ["aviation-data"] })
		return () => {
			off()
			feed.dispose()
		}
	}
}

const shared = new WeakMap<EventsClient, AviationLive>()

/** The one AviationLive of this events client. */
export function aviationLive(
	api: ApiClient,
	events: EventsClient,
): AviationLive {
	let live = shared.get(events)
	if (!live) {
		live = new AviationLive(api, events)
		shared.set(events, live)
	}
	return live
}
