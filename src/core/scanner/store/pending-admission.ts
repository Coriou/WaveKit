/**
 * WG15 DQ requirement 1.4 to 1.6: weak, undecoded observations wait here before they can create a
 * discovery. Memory only: never stored, surfaced, persisted or journalled.
 *
 * One `Map` per source keyed by bucket (`Math.round(centreHz / 2 500)`), in insertion order of
 * `firstAt`: entries are never re-inserted on touch, so the first key is the oldest first sample
 * and eviction at `DQ_PENDING_PER_SOURCE` is O(1). Each entry lives in
 * [firstAt, firstAt + DQ_PENDING_WINDOW_MS); samples are never aged out individually.
 */
import {
	DQ_PENDING_BUCKET_HZ,
	DQ_PENDING_MEDIAN_SNR_DB,
	DQ_PENDING_MIN_OBS,
	DQ_PENDING_PER_SOURCE,
	DQ_PENDING_SAMPLES,
	DQ_PENDING_WINDOW_MS,
} from "../detection-quality-contract.js"
import type { ObservationInput } from "../types.js"
import type { TrackSnapshot } from "../../spectrum/types.js"

export interface PendingSample {
	id: string
	at: number
	snr: number
}

export interface PendingEntry {
	firstAt: number
	bucket: number
	/** At most `DQ_PENDING_SAMPLES`, the highest SNRs seen. */
	samples: PendingSample[]
	/**
	 * Distinct ids seen. A re-ingest of an id whose sample was replaced counts again, but
	 * replacement only happens once 5 distinct ids were seen, past the 3 promotion needs.
	 */
	distinct: number
}

/**
 * The SNR the creation gate reads: the WG12 channel SNR when the engine has a channel plan,
 * else the track SNR. Present but non-finite stays non-finite (rejected, requirement 1.7).
 */
export function admissionSnrOf(track: TrackSnapshot): number {
	return track.channelSnrDb !== undefined ? track.channelSnrDb : track.snrDb
}

/** Median of a non-empty list (mean of the two middles when even). */
function median(xs: readonly number[]): number {
	const s = [...xs].sort((a, b) => a - b)
	const mid = s.length >> 1
	return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

export class PendingAdmission {
	private readonly bySource = new Map<string, Map<number, PendingEntry>>()
	/** Last tuning epoch seen per source: a change is a retune and clears the source. */
	private readonly epochs = new Map<string, number>()

	constructor(private readonly now: () => number) {}

	/**
	 * Holds one weak observation (finite centre and SNR, not overload; the store checks).
	 * True = promote now; the entry is deleted.
	 */
	note(obs: ObservationInput): boolean {
		const { sourceId } = obs
		const epoch = obs.track.epoch
		const seen = this.epochs.get(sourceId)
		if (seen !== undefined && seen !== epoch) this.clear(sourceId)
		this.epochs.set(sourceId, epoch)
		const now = this.now()
		const snr = admissionSnrOf(obs.track)
		const bucket = Math.round(obs.track.centreHz / DQ_PENDING_BUCKET_HZ)
		let map = this.bySource.get(sourceId)
		if (map === undefined) {
			map = new Map()
			this.bySource.set(sourceId, map)
		}
		let entry = this.nearest(map, bucket)
		if (entry !== undefined && now >= entry.firstAt + DQ_PENDING_WINDOW_MS) {
			map.delete(entry.bucket)
			entry = undefined
		}
		if (entry === undefined) {
			if (map.has(bucket)) map.delete(bucket)
			while (map.size >= DQ_PENDING_PER_SOURCE) {
				const oldest = map.keys().next()
				if (oldest.done === true) break
				map.delete(oldest.value)
			}
			entry = { firstAt: now, bucket, samples: [], distinct: 0 }
			map.set(bucket, entry)
		}
		this.add(entry, obs.id, now, snr)
		if (
			entry.distinct >= DQ_PENDING_MIN_OBS &&
			median(entry.samples.map(s => s.snr)) >= DQ_PENDING_MEDIAN_SNR_DB
		) {
			map.delete(entry.bucket)
			if (map.size === 0) this.bySource.delete(sourceId)
			return true
		}
		return false
	}

	/** Deletes every entry whose window has ended (`now >= firstAt + window`). */
	sweep(now: number = this.now()): void {
		for (const [sourceId, map] of this.bySource) {
			for (const [bucket, e] of map) {
				// Insertion order is firstAt order: the first live entry ends the scan.
				if (now < e.firstAt + DQ_PENDING_WINDOW_MS) break
				map.delete(bucket)
			}
			if (map.size === 0) this.bySource.delete(sourceId)
		}
	}

	/**
	 * A retracted observation (spur, IQ image, truncation raised late): its sample stops
	 * counting. The distinct count drops with it; an emptied entry is deleted.
	 */
	forget(sourceId: string, id: string): void {
		const map = this.bySource.get(sourceId)
		if (map === undefined) return
		for (const [bucket, e] of map) {
			const i = e.samples.findIndex(x => x.id === id)
			if (i < 0) continue
			e.samples.splice(i, 1)
			e.distinct = Math.max(0, e.distinct - 1)
			if (e.samples.length === 0) map.delete(bucket)
		}
		if (map.size === 0) this.bySource.delete(sourceId)
	}

	/** Any create at this centre consumes the matching entry (nearest of b - 1, b, b + 1). */
	consume(obs: ObservationInput): void {
		const map = this.bySource.get(obs.sourceId)
		if (map === undefined) return
		const centre = obs.track.centreHz
		if (!Number.isFinite(centre)) return
		const e = this.nearest(map, Math.round(centre / DQ_PENDING_BUCKET_HZ))
		if (e !== undefined) map.delete(e.bucket)
		if (map.size === 0) this.bySource.delete(obs.sourceId)
	}

	/** Source removal or retune: drops that source; no argument drops all. */
	clear(sourceId?: string): void {
		if (sourceId === undefined) {
			this.bySource.clear()
			this.epochs.clear()
			return
		}
		this.bySource.delete(sourceId)
		this.epochs.delete(sourceId)
	}

	/** Entries held for a source (tests and bounds). */
	entries(sourceId: string): readonly PendingEntry[] {
		return [...(this.bySource.get(sourceId)?.values() ?? [])]
	}

	size(sourceId?: string): number {
		if (sourceId !== undefined) return this.bySource.get(sourceId)?.size ?? 0
		let n = 0
		for (const m of this.bySource.values()) n += m.size
		return n
	}

	/** Buckets b - 1, b, b + 1; the nearest bucket wins, ties to the older entry. */
	private nearest(
		map: Map<number, PendingEntry>,
		bucket: number,
	): PendingEntry | undefined {
		const same = map.get(bucket)
		if (same !== undefined) return same
		const lo = map.get(bucket - 1)
		const hi = map.get(bucket + 1)
		if (lo === undefined) return hi
		if (hi === undefined) return lo
		return hi.firstAt < lo.firstAt ? hi : lo
	}

	private add(e: PendingEntry, id: string, at: number, snr: number): void {
		const same = e.samples.find(s => s.id === id)
		if (same !== undefined) {
			if (snr > same.snr) same.snr = snr // 1.6: the larger SNR, time unchanged
			return
		}
		e.distinct++
		if (e.samples.length < DQ_PENDING_SAMPLES) {
			e.samples.push({ id, at, snr })
			return
		}
		let low = 0
		for (let i = 1; i < e.samples.length; i++)
			if (e.samples[i]!.snr < e.samples[low]!.snr) low = i
		if (snr > e.samples[low]!.snr) e.samples[low] = { id, at, snr }
	}
}
