import type { ScanJobHit, ScanJobHitStats } from "@wavekit/api-types"

/**
 * WG2 requirement 13: per-job hit statistics, in memory only. A hit is one observation of the job
 * attributed to a discovery. At most `JOB_HITS_TRACKED_MAX` discoveries keep a per-discovery entry;
 * hits on the others count in the totals only (`truncated`).
 */

/** 13.4: discoveries tracked per job. */
export const JOB_HITS_TRACKED_MAX = 2000
/**
 * Distinct untracked discoveries remembered for `stats.discoveries` once truncated. Bounds the
 * memory of a pathological job (10,000 ids of 28 characters, about 1 MB); past it,
 * `discoveries` stops growing while `hits` keeps counting.
 */
export const JOB_HITS_UNTRACKED_DISTINCT_MAX = 10_000
/**
 * Observation ids already credited to the job, so a re-placed observation (unlinked or trimmed,
 * then placed again) is not counted twice. FIFO-pruned at 4,096 ids (about 0.4 MB): dedupe is
 * exact until the first eviction; from then on a re-placed evicted observation may count again,
 * so the job's stats say `truncated: true` (best-effort, WG2 req 13.4).
 */
export const JOB_HITS_CREDITED_MAX = 4096
/** 13.3: `GET /api/scanner/jobs/:id/hits?limit` bounds. */
export const JOB_HITS_LIMIT_DEFAULT = 100
export const JOB_HITS_LIMIT_MAX = 500

interface Entry {
	hits: number
	firstHitAt: number
	lastHitAt: number
	firstSeenInJob: boolean
	lastObservationId: string
	lastDurationMs: number | null
}

export class JobHits {
	/** Insertion order is recency: a hit moves its entry to the end. */
	private readonly byDiscovery = new Map<string, Entry>()
	private readonly untracked = new Set<string>()
	private readonly credited = new Set<string>()
	private hits = 0
	private newDiscoveries = 0
	private truncated = false

	constructor(
		readonly jobId: string,
		private readonly trackedMax = JOB_HITS_TRACKED_MAX,
	) {}

	/**
	 * Counts observation `observationId` attributed to `discoveryId` once; `created` = it created the
	 * discovery. Returns false for an observation already credited.
	 */
	record(
		observationId: string,
		discoveryId: string,
		at: number,
		created: boolean,
	): boolean {
		if (this.credited.has(observationId)) return false
		this.credited.add(observationId)
		if (this.credited.size > JOB_HITS_CREDITED_MAX) {
			const oldest = this.credited.values().next()
			if (oldest.done !== true) this.credited.delete(oldest.value)
			this.truncated = true
		}
		this.hits += 1
		const known = this.byDiscovery.get(discoveryId)
		// A promotion credits several observations of one new discovery: count it once.
		if (created && !known && !this.untracked.has(discoveryId))
			this.newDiscoveries += 1
		if (known) {
			known.hits += 1
			known.lastHitAt = Math.max(known.lastHitAt, at)
			known.lastObservationId = observationId
			this.byDiscovery.delete(discoveryId)
			this.byDiscovery.set(discoveryId, known)
			return true
		}
		if (this.byDiscovery.size < this.trackedMax) {
			this.byDiscovery.set(discoveryId, {
				hits: 1,
				firstHitAt: at,
				lastHitAt: at,
				firstSeenInJob: created,
				lastObservationId: observationId,
				lastDurationMs: null,
			})
			return true
		}
		this.truncated = true
		if (this.untracked.size < JOB_HITS_UNTRACKED_DISTINCT_MAX)
			this.untracked.add(discoveryId)
		return true
	}

	/**
	 * WG6 2.1: observation `observationId` ended after `durationMs`. Applies only when it is the
	 * entry's latest credit and the duration is finite and non-negative.
	 */
	ended(observationId: string, discoveryId: string, durationMs: number): void {
		const e = this.byDiscovery.get(discoveryId)
		if (!e || e.lastObservationId !== observationId) return
		if (!Number.isFinite(durationMs) || durationMs < 0) return
		e.lastDurationMs = Math.round(durationMs)
	}

	entry(discoveryId: string): ScanJobHit | undefined {
		const e = this.byDiscovery.get(discoveryId)
		return e ? this.view(discoveryId, e) : undefined
	}

	stats(): ScanJobHitStats {
		return {
			discoveries: this.byDiscovery.size + this.untracked.size,
			hits: this.hits,
			newDiscoveries: this.newDiscoveries,
			truncated: this.truncated,
		}
	}

	/** Most recent hit first. */
	list(limit: number): ScanJobHit[] {
		const out: ScanJobHit[] = []
		const entries = [...this.byDiscovery]
		for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
			const pair = entries[i]
			if (pair) out.push(this.view(pair[0], pair[1]))
		}
		return out
	}

	private view(discoveryId: string, e: Entry): ScanJobHit {
		return {
			jobId: this.jobId,
			discoveryId,
			hits: e.hits,
			firstHitAt: new Date(e.firstHitAt).toISOString(),
			lastHitAt: new Date(e.lastHitAt).toISOString(),
			firstSeenInJob: e.firstSeenInJob,
			lastDurationMs: e.lastDurationMs,
		}
	}
}

export function emptyHitStats(): ScanJobHitStats {
	return { discoveries: 0, hits: 0, newDiscoveries: 0, truncated: false }
}
