// What the tuned card shows under "now" and "Earlier": the Activity heard on the card's channel. One small Activity
// list (REST snapshot, then the live feed from its cursor) that follows the card's frequency once it settles, so a
// drag across the spectrum does not ask the core for every frequency on the way.
import type { ActivityQuery } from "@wavekit/api-types"

import type { DataLayer } from "../../data/index.ts"
import { ActivityFeed } from "../../data/activity-feed.ts"
import { Store } from "../../data/index.ts"

/** Rows kept: enough for a message rate over the last minute on a busy channel, never the drawer's 5000. */
export const TUNED_MAX_ITEMS = 200
/** The card follows a frequency once it has been still this long. */
export const TUNED_SETTLE_MS = 250

export interface TunedSpan {
	hz: number
	/** Half the channel: events within ± this of `hz` belong to the card. */
	toleranceHz: number
}

/** The Activity query for a channel: its frequency ± the tolerance, rounded to the hertz. */
export function spanQuery(span: TunedSpan): ActivityQuery {
	return {
		frequencyHz: {
			min: Math.round(span.hz - span.toleranceHz),
			max: Math.round(span.hz + span.toleranceHz),
		},
	}
}

export class TunedActivity {
	readonly feed: ActivityFeed
	/** The span the feed shows (null before the first one settles). */
	readonly span = new Store<TunedSpan | null>(null)
	private timer: ReturnType<typeof setTimeout> | null = null
	private wanted: TunedSpan | null = null
	private readonly settleMs: number

	constructor(
		data: Pick<DataLayer, "api" | "events">,
		options: { settleMs?: number; flushMs?: number } = {},
	) {
		this.settleMs = options.settleMs ?? TUNED_SETTLE_MS
		this.feed = new ActivityFeed(data.api, data.events, {
			id: "tuned",
			pageSize: 50,
			maxItems: TUNED_MAX_ITEMS,
			...(options.flushMs !== undefined ? { flushMs: options.flushMs } : {}),
		})
	}

	/** Follows `span` once it has been still for the settle delay; null stops following. */
	follow(span: TunedSpan | null): void {
		const same = (a: TunedSpan | null, b: TunedSpan | null) =>
			a === b ||
			(a !== null &&
				b !== null &&
				a.hz === b.hz &&
				a.toleranceHz === b.toleranceHz)
		if (same(span, this.wanted)) return
		this.wanted = span
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
		if (same(span, this.span.get())) return
		if (span === null) {
			this.apply(null)
			return
		}
		this.timer = setTimeout(() => {
			this.timer = null
			this.apply(this.wanted)
		}, this.settleMs)
	}

	private apply(span: TunedSpan | null): void {
		this.span.set(span)
		void this.feed.setQuery(span === null ? null : spanQuery(span))
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
		this.feed.dispose()
	}
}
