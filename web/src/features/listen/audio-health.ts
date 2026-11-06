// How much of the audio this Listen expected actually played. Ring time is the clock: elapsed time is what
// the ring rendered, so a suspended context counts nothing. Missing is the time the ring had nothing to play
// plus the blocks the core filled with zeros because its source had no audio. Those zeros arrive at full rate
// and look perfect to the ring; only `autoRoute.underruns` shows them. Time with the squelch closed is not
// counted at all: exact silence is correct there, so it cannot read as breaking up.
import { LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS } from "@wavekit/api-types"
import type {
	LiveAudioAutoRoute,
	LiveAudioLevel,
	LiveAudioStatus,
} from "@wavekit/api-types"
import type { RingStats } from "./pcm.ts"
import { autoRouteNow } from "./sound.ts"

/** The figure changes at most once a bucket: 1 s, so the card does not flicker with the 250 ms stats. */
export const HEALTH_BUCKET_MS = 1_000
/** 10 buckets × 1 s = the last 10 s. */
export const HEALTH_WINDOW_BUCKETS = 10
/** No verdict on under half the window (5 s of expected audio): one stall in a short over says little. */
export const HEALTH_MIN_EXPECTED_MS = 5_000
/**
 * Breaking up: over 10% missing, 1 000 ms of a full window. One 1 300 ms stall, the longest seen, loses
 * 1 300 − 500 caught up = 800 ms, 8%: it does not show. A second one inside the window does.
 */
export const BREAKING_MISSING_OVER = 0.1
/** Clears at 5% or less, 500 ms of a full window, so a figure near 10% does not make the card flicker. */
export const BREAKING_CLEARS_AT = 0.05

export interface AudioHealth {
	/** Percent of the expected audio that played in the window (rounded down), null without enough of it. */
	heardPct: number | null
	breaking: boolean
	/** Since Listen started, whole 100 ms: all missing audio, and the part the core filled with zeros. */
	missingMs: number
	coreFilledMs: number
	/** Times the core's pacer gave up on catching up, since Listen started. */
	rebases: number
}

export const NO_AUDIO_HEALTH: AudioHealth = Object.freeze({
	heardPct: null,
	breaking: false,
	missingMs: 0,
	coreFilledMs: 0,
	rebases: 0,
})

/** True while the core says something should be audible on this stream. */
export function audioExpected(
	status: LiveAudioStatus | null,
	level: LiveAudioLevel | null,
	autoRoute: boolean,
): boolean {
	if (autoRoute) {
		const now = autoRouteNow(status, level)
		if (now) return now.active !== "none"
	}
	if (!(level?.squelchOpen ?? status?.squelchOpen ?? true)) return false
	if ((level?.autoSquelch ?? status?.autoSquelch)?.state === "waiting")
		return false
	return status?.toneSquelch?.state !== "waiting"
}

interface Bucket {
	expectedMs: number
	missingMs: number
}

export class AudioHealthTracker {
	private started = false
	private lastRenderedMs = 0
	private lastDryMs = 0
	private lastUnderruns: number | null = null
	private lastRebases = 0
	private readonly buckets: Bucket[] = []
	private bucketRenderedMs = 0
	private bucket: Bucket = { expectedMs: 0, missingMs: 0 }
	private pendingFilledMs = 0
	private totalMissingMs = 0
	private totalFilledMs = 0
	private totalRebases = 0
	private health = NO_AUDIO_HEALTH

	/** The core's counters; the first reading is only a base (they outlive a Listen). */
	noteRoute(
		route: Pick<LiveAudioAutoRoute, "underruns" | "clockRebases">,
	): void {
		if (this.lastUnderruns !== null && this.started) {
			// a lower count is a restarted core: nothing is known about the time between
			const underruns = Math.max(0, route.underruns - this.lastUnderruns)
			this.pendingFilledMs += underruns * LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS
			this.totalRebases += Math.max(0, route.clockRebases - this.lastRebases)
		}
		this.lastUnderruns = route.underruns
		this.lastRebases = route.clockRebases
	}

	/** One ring report; the same object back unless the readout changed. */
	noteStats(stats: RingStats, expected: boolean): AudioHealth {
		if (!this.started) {
			// priming at the start of a Listen is not a fault: count from the first audio
			if (!stats.playing) return this.health
			this.started = true
			this.lastRenderedMs = stats.renderedMs
			this.lastDryMs = stats.dryMs
			return this.health
		}
		const renderedMs = Math.max(0, stats.renderedMs - this.lastRenderedMs)
		const dryMs = Math.max(0, stats.dryMs - this.lastDryMs)
		this.lastRenderedMs = stats.renderedMs
		this.lastDryMs = stats.dryMs
		const b = this.bucket
		if (expected) {
			b.expectedMs += renderedMs
			b.missingMs += dryMs
			this.totalMissingMs += dryMs
		}
		// the core only counts these while a source is selected, so they are always missing audio
		b.missingMs += this.pendingFilledMs
		this.totalMissingMs += this.pendingFilledMs
		this.totalFilledMs += this.pendingFilledMs
		this.pendingFilledMs = 0
		this.bucketRenderedMs += renderedMs
		if (this.bucketRenderedMs < HEALTH_BUCKET_MS) return this.health
		this.bucketRenderedMs -= HEALTH_BUCKET_MS
		this.buckets.push(b)
		if (this.buckets.length > HEALTH_WINDOW_BUCKETS) this.buckets.shift()
		this.bucket = { expectedMs: 0, missingMs: 0 }
		return this.evaluate()
	}

	private evaluate(): AudioHealth {
		let expectedMs = 0
		let missingMs = 0
		for (const b of this.buckets) {
			expectedMs += b.expectedMs
			missingMs += b.missingMs
		}
		const enough = expectedMs >= HEALTH_MIN_EXPECTED_MS
		const missing = enough ? Math.min(1, missingMs / expectedMs) : 0
		const next: AudioHealth = {
			heardPct: enough ? 100 - Math.ceil(missing * 100) : null,
			breaking:
				enough &&
				missing >
					(this.health.breaking ? BREAKING_CLEARS_AT : BREAKING_MISSING_OVER),
			missingMs: Math.floor(this.totalMissingMs / 100) * 100,
			coreFilledMs: Math.floor(this.totalFilledMs / 100) * 100,
			rebases: this.totalRebases,
		}
		const h = this.health
		if (
			next.heardPct !== h.heardPct ||
			next.breaking !== h.breaking ||
			next.missingMs !== h.missingMs ||
			next.coreFilledMs !== h.coreFilledMs ||
			next.rebases !== h.rebases
		)
			this.health = next
		return this.health
	}
}

/** For the card: "Breaking up · 71% heard", null while the audio is fine. */
export function breakingUpText(health: AudioHealth): string | null {
	return health.breaking && health.heardPct !== null
		? `Breaking up · ${health.heardPct}% heard`
		: null
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)} s`
}

/** For Audio options: "71% heard · 17.4 s missing", null when nothing has gone missing. */
export function audioHealthText(health: AudioHealth): string | null {
	if (health.missingMs === 0) return null
	const missing = `${seconds(health.missingMs)} missing`
	return health.heardPct === null
		? missing
		: `${health.heardPct}% heard · ${missing}`
}

/** The readout's detail. */
export function audioHealthTitle(health: AudioHealth): string {
	const parts = [
		"Heard: the share of the last 10 s of expected audio that played. Missing: all the time this Listen had no audio to play while a signal was open.",
	]
	if (health.coreFilledMs > 0)
		parts.push(
			`The core had no audio for ${seconds(health.coreFilledMs)} of it and sent silence in its place.`,
		)
	if (health.rebases > 0)
		parts.push(
			`It fell too far behind to catch up ${health.rebases} ${health.rebases === 1 ? "time" : "times"}.`,
		)
	parts.push("Both usually mean the core is too busy.")
	return parts.join(" ")
}
