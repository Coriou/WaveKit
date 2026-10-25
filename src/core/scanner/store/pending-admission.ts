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
	DQ_SUSTAIN_FLOOR_SNR_DB,
	DQ_SUSTAIN_MAX_GAP_MS,
	DQ_SUSTAIN_MEDIAN_SNR_DB,
	DQ_SUSTAIN_MIN_SAMPLES,
	DQ_SUSTAIN_MS,
	DQ_SUSTAIN_PER_SOURCE,
	DQ_SUSTAIN_SAMPLES,
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
	 * Distinct valid (not retracted) ids, insertion order, at most `PENDING_IDS_MAX`. Every
	 * retained sample's id is in it; an id whose sample was replaced stays counted until it is
	 * retracted or pushed out by the cap (oldest non-retained id first). The set never holds a
	 * retracted id, so it can under-count but never over-count.
	 */
	ids: Set<string>
}

/**
 * Distinct ids tracked per entry: 5 retained samples + 3 needed for promotion = 8. About 8 ×
 * (40 B id + 16 B slot) ≈ 450 B per entry, × 512 entries ≈ 230 kB per source on top of the
 * samples (about 150 kB).
 */
export const PENDING_IDS_MAX = 8

/**
 * The SNR the creation gate reads: the WG12 channel SNR when the engine has a channel plan,
 * else the track SNR. Present but non-finite stays non-finite (rejected, requirement 1.7).
 * WG16 SC: a track wider than one slot is judged at its best slot (`peakChannelSnrDb`) when
 * that is higher than the wide-track sum.
 */
export function admissionSnrOf(track: TrackSnapshot): number {
	if (track.channelSnrDb === undefined) return track.snrDb
	const peak = track.peakChannelSnrDb
	return Number.isFinite(track.channelSnrDb) &&
		peak !== undefined &&
		Number.isFinite(peak) &&
		peak > track.channelSnrDb
		? peak
		: track.channelSnrDb
}

/** Req 1.4b: one observation's sustained run (memory only). */
export interface SustainRun {
	firstAt: number
	lastAt: number
	/** Newest last, at most `DQ_SUSTAIN_SAMPLES`. */
	snrs: number[]
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
	/** Req 1.4b: sustained runs per source, keyed by observation id, insertion order. */
	private readonly runs = new Map<string, Map<string, SustainRun>>()

	constructor(private readonly now: () => number) {}

	/**
	 * Req 1.4b: one sample of a weak observation's sustained run (finite centre and SNR, not
	 * overload; the store checks). True = the run promotes now; it is deleted. A sample under
	 * `DQ_SUSTAIN_FLOOR_SNR_DB`, or after a gap over `DQ_SUSTAIN_MAX_GAP_MS`, restarts the run;
	 * a closing observation's run is dropped after this sample.
	 */
	sustained(obs: ObservationInput): boolean {
		const { sourceId, id } = obs
		this.syncEpoch(sourceId, obs.track.epoch)
		const now = this.now()
		const snr = admissionSnrOf(obs.track)
		let map = this.runs.get(sourceId)
		if (!(snr >= DQ_SUSTAIN_FLOOR_SNR_DB)) {
			if (map?.delete(id) === true && map.size === 0) this.runs.delete(sourceId)
			return false
		}
		if (map === undefined) {
			map = new Map()
			this.runs.set(sourceId, map)
		}
		let run = map.get(id)
		if (run !== undefined && now - run.lastAt > DQ_SUSTAIN_MAX_GAP_MS) {
			map.delete(id)
			run = undefined
		}
		if (run === undefined) {
			while (map.size >= DQ_SUSTAIN_PER_SOURCE) {
				const oldest = map.keys().next()
				if (oldest.done === true) break
				map.delete(oldest.value)
			}
			run = { firstAt: now, lastAt: now, snrs: [] }
			map.set(id, run)
		}
		run.lastAt = now
		run.snrs.push(snr)
		if (run.snrs.length > DQ_SUSTAIN_SAMPLES) run.snrs.shift()
		const promotes =
			now - run.firstAt >= DQ_SUSTAIN_MS &&
			run.snrs.length >= DQ_SUSTAIN_MIN_SAMPLES &&
			median(run.snrs) >= DQ_SUSTAIN_MEDIAN_SNR_DB
		if (promotes || obs.endReason !== undefined) {
			map.delete(id)
			if (map.size === 0) this.runs.delete(sourceId)
		}
		return promotes
	}

	/** Req 1.4b: drops one observation's run (it was admitted another way). */
	dropRun(sourceId: string, id: string): void {
		const runs = this.runs.get(sourceId)
		if (runs?.delete(id) === true && runs.size === 0) this.runs.delete(sourceId)
	}

	/** One observation's run (tests and bounds). */
	runOf(sourceId: string, id: string): Readonly<SustainRun> | undefined {
		return this.runs.get(sourceId)?.get(id)
	}

	/** Sustained runs held for a source (tests and bounds). */
	runCount(sourceId?: string): number {
		if (sourceId !== undefined) return this.runs.get(sourceId)?.size ?? 0
		let n = 0
		for (const m of this.runs.values()) n += m.size
		return n
	}

	/** A retune (new epoch) clears the source's entries and runs. */
	private syncEpoch(sourceId: string, epoch: number): void {
		const seen = this.epochs.get(sourceId)
		if (seen !== undefined && seen !== epoch) this.clear(sourceId)
		this.epochs.set(sourceId, epoch)
	}

	/**
	 * Holds one weak observation (finite centre and SNR, not overload; the store checks).
	 * True = promote now; the entry is deleted.
	 */
	note(obs: ObservationInput): boolean {
		const { sourceId } = obs
		this.syncEpoch(sourceId, obs.track.epoch)
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
			entry = { firstAt: now, bucket, samples: [], ids: new Set() }
			map.set(bucket, entry)
		}
		this.add(entry, obs.id, now, snr)
		if (
			entry.ids.size >= DQ_PENDING_MIN_OBS &&
			entry.samples.length >= DQ_PENDING_MIN_OBS &&
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
		for (const [sourceId, map] of this.runs) {
			for (const [id, r] of map)
				if (now - r.lastAt > DQ_SUSTAIN_MAX_GAP_MS) map.delete(id)
			if (map.size === 0) this.runs.delete(sourceId)
		}
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
	 * counting, retained or already replaced. An entry left with no samples is deleted.
	 */
	forget(sourceId: string, id: string): void {
		this.dropRun(sourceId, id)
		const map = this.bySource.get(sourceId)
		if (map === undefined) return
		for (const [bucket, e] of map) {
			if (!e.ids.delete(id)) continue
			const i = e.samples.findIndex(x => x.id === id)
			if (i >= 0) e.samples.splice(i, 1)
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
			this.runs.clear()
			this.epochs.clear()
			return
		}
		this.bySource.delete(sourceId)
		this.runs.delete(sourceId)
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
		if (!e.ids.has(id)) {
			if (e.ids.size >= PENDING_IDS_MAX) {
				for (const old of e.ids)
					if (!e.samples.some(x => x.id === old)) {
						e.ids.delete(old)
						break
					}
			}
			e.ids.add(id)
		}
		if (e.samples.length < DQ_PENDING_SAMPLES) {
			e.samples.push({ id, at, snr })
			return
		}
		let low = 0
		for (let i = 1; i < e.samples.length; i++)
			if (e.samples[i]!.snr < e.samples[low]!.snr) low = i
		// A replaced id stays in `ids`: it was seen and not retracted.
		if (snr > e.samples[low]!.snr) e.samples[low] = { id, at, snr }
	}
}
