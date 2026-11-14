// What the plot tells the spectrum stream about the shown source (SpectrumCanvas `sourcePaused` and
// `resync`), kept apart from Plot.tsx so it is testable without a DOM.
import type { ExtendedSourceStatus, TunerState } from "@wavekit/api-types"
import { feedOf, isPaused, type FeedEntry } from "../features/receiver/feed.ts"

export interface SpectrumStreamHints {
	/**
	 * The stream may rest (slow resubscribes only): the feed reads paused AND the core does not
	 * report the receiver connected. A feed state cached here can lag (a resume this page missed);
	 * a connected receiver streams, so it never counts as paused.
	 */
	paused: boolean
	/** Changes whenever frames are due again or differ: receiver up or down, feed state, centre, rate. */
	resync: string
}

export function spectrumStream(
	row: Pick<ExtendedSourceStatus, "connected" | "feed"> | undefined,
	entry: FeedEntry | undefined,
	tuner: Pick<TunerState, "frequency" | "sampleRate"> | undefined,
): SpectrumStreamHints {
	const feed = feedOf(row, entry)
	const connected = row?.connected === true
	return {
		paused: isPaused(feed) && !connected,
		resync: [
			connected ? "up" : "down",
			feed?.state ?? "none",
			tuner?.frequency ?? "",
			tuner?.sampleRate ?? "",
		].join(":"),
	}
}
