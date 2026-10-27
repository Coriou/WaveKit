/**
 * Activity-ranked decoder channels: the contract between the scanner-side ranker (evidence: live
 * energy, tracks, occupancy, decodes, trial outcomes) and the decoder planner (which channels of a
 * decoder's eligible set run within the CPU budget). Observed energy centres are suggestions,
 * never placements; the planner never reads scanner state except through this port.
 */

/** Decoder types whose channels can be chosen by activity. */
export type ActivityDecoder = "multimon-ng" | "dsd-fme"

export type ActivityState = "hot" | "warm" | "cold"

export type ActivityReason =
	| "live-energy"
	| "track"
	| "occupancy"
	| "decoded"
	| "trial-success"
	| "trial-backoff"

/** One spectrum engine generation of a source; numeric epochs may restart with a new engine. */
export interface ActivityEpoch {
	readonly sourceId: string
	readonly engineId: string
	readonly epoch: number
}

export interface ActivityQuery {
	readonly epoch: ActivityEpoch
	readonly decoderId: string
	readonly decoderType: ActivityDecoder
	readonly protocols: readonly string[]
	readonly centreHz: number
	/** Unique, eligible, integer Hz, before any capacity slicing. */
	readonly candidatesHz: readonly number[]
	readonly channelWidthHz: number
}

export interface ChannelActivity {
	readonly hz: number
	/** Recent decode of a non-voice protocol excludes this candidate from dsd-fme. */
	readonly excluded?: boolean
	/** Finite and at least 0. */
	readonly score: number
	readonly state: ActivityState
	readonly reasons: readonly ActivityReason[]
	/** Energy on the channel in the latest accepted block. */
	readonly live: boolean
	readonly lastEnergyMonoMs: number | null
	readonly stateSinceMonoMs: number
}

export interface ActivitySnapshot {
	readonly query: ActivityQuery
	readonly revision: number
	readonly evaluatedMonoMs: number
	readonly lastFrameMonoMs: number | null
	/** Anything but `ready` means the planner uses its nearest-first order. */
	readonly status: "ready" | "unavailable" | "retuning" | "stale"
	/** Earliest decay, state or staleness deadline that needs a new evaluation. */
	readonly nextEvaluationMonoMs: number | null
	/** Exactly one entry per candidate, in candidate input order. */
	readonly channels: readonly ChannelActivity[]
}

export interface ActivityChange {
	readonly epoch: ActivityEpoch
	readonly revision: number
}

export interface ObservedActivityCentre {
	readonly actualHz: number
	readonly candidateHz: number
}

export interface ChannelActivityPort {
	/** Actual energy and stable candidate identity, before coverage deduplication. */
	observedCentres?(
		epoch: ActivityEpoch,
		nowMonoMs: number,
	): readonly ObservedActivityCentre[]
	/** Optional bounded energy centres of this exact epoch, on the planner clock. */
	// The planner still enforces decoder band, reach, ownership and slot budgets.
	observedChannels?(epoch: ActivityEpoch, nowMonoMs: number): readonly number[]
	/** One atomic, immutable batch: no mutation, I/O or history refresh happens here. */
	snapshot(
		queries: readonly ActivityQuery[],
		nowMonoMs: number,
	): readonly ActivitySnapshot[]
	/** Coalesced change notices (at most 250 ms late); returns the unsubscribe function. */
	subscribe(listener: (change: ActivityChange) => void): () => void
}

/**
 * Candidates per query: 1 024 (a 12.8 MHz span at a 12.5 kHz raster). A larger query answers
 * `unavailable`, still one channel per candidate.
 */
export const ACTIVITY_MAX_CANDIDATES = 1_024

/** Observed centres: at most 512 = one scanner block's maximum track count. */
export const ACTIVITY_MAX_OBSERVED = 512

/**
 * Nearest 6 250 Hz raster: round(hz / 6 250) × 6 250, ties upward.
 * Maximum rounding error is 3 125 Hz, one quarter of a 12.5 kHz voice channel.
 */
export function quantiseObservedCentre(hz: number): number {
	return Math.round(hz / 6_250) * 6_250
}
