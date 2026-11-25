/**
 * The noise evidence budget of the analog recorder (WidebandAnalogRecorder): on a channel where
 * analog voice is proven, the recording admission discards a file that measures as unpitched noise
 * (recording-verdict.ts finishPath, `discarded:noise`), except NOISE_EVIDENCE_PER_HOUR of them per
 * discovery per rolling hour, kept as `noise-evidence` so a listener can still check the rule on
 * that channel. Recorder state, not a store: it is lost with the process (a restart only grants a
 * fresh budget). No clock of its own: callers pass `now` (monotonic ms).
 *
 * Arithmetic: the spur-like emitter that motivated it made about 360 noise files an hour on one
 * channel; 2 an hour keep about 2 × 24 × 96 KB ≈ 4.6 MB a day of its noise (a 6 s file of 8 kHz
 * 16-bit mono is 96 KB) instead of filling the 512 MB recordings cap.
 *
 * Transition table, per discovery `d` (`kept`: the times of its evidence keeps less than
 * NOISE_EVIDENCE_WINDOW_MS before `now`, oldest first; expired times are dropped first):
 *
 * | state                       | event                           | result                          |
 * | --------------------------- | ------------------------------- | ------------------------------- |
 * | no discovery (null)         | room                            | false (the file is discarded)   |
 * | no discovery (null)         | spend                           | nothing                         |
 * | d unknown, or kept empty    | room                            | true                            |
 * | kept has 1 time             | room                            | true                            |
 * | kept has 2 times            | room                            | false (discarded:noise)         |
 * | kept has under 2 times      | spend                           | kept += now, d moves newest     |
 * | kept has 2 times            | spend                           | nothing (no room was given)     |
 * | every time of d expired     | room, spend or another d's spend | d's entry dropped             |
 * | NOISE_EVIDENCE_MAX_DISCOVERIES entries, new d | spend           | least recently spent d dropped  |
 */
import { TRIAL_MEMORY_MAX_DISCOVERIES } from "../trial-memory.js"

/** Noise files kept as evidence per discovery per rolling hour: 360/h → 2/h (module comment). */
export const NOISE_EVIDENCE_PER_HOUR = 2
/** The rolling window: one hour (3 600 000 ms). A keep counts while `now − at` is under it. */
export const NOISE_EVIDENCE_WINDOW_MS = 3_600_000
/**
 * Discoveries the budget remembers at once: the scanner's per-discovery trial memory bound
 * (TRIAL_MEMORY_MAX_DISCOVERIES, 2 048), at most 2 times each (2 048 × 2 numbers ≈ 32 KB of
 * values). Past it the least recently spent discovery is forgotten (a fresh budget for it).
 */
export const NOISE_EVIDENCE_MAX_DISCOVERIES = TRIAL_MEMORY_MAX_DISCOVERIES

export class NoiseEvidenceBudget {
	/** Discovery → its keep times in the window, oldest first; the map least recently spent first. */
	private readonly kept = new Map<string, number[]>()

	constructor(
		private readonly perHour = NOISE_EVIDENCE_PER_HOUR,
		private readonly maxDiscoveries = NOISE_EVIDENCE_MAX_DISCOVERIES,
	) {}

	/** Whether a noise file of `discoveryId` may be kept as evidence at `now` (table above). */
	room(discoveryId: string | null, now: number): boolean {
		if (discoveryId === null) return false
		this.expire(now)
		const times = this.live(discoveryId, now)
		return times.length < this.perHour
	}

	/** Notes an evidence keep of `discoveryId` at `now` (only after room said true). */
	spend(discoveryId: string | null, now: number): void {
		if (discoveryId === null) return
		this.expire(now)
		const times = this.live(discoveryId, now)
		if (times.length >= this.perHour) return
		this.kept.delete(discoveryId)
		this.kept.set(discoveryId, [...times, now])
		while (this.kept.size > this.maxDiscoveries) {
			const oldest = this.kept.keys().next().value
			if (oldest === undefined) break
			this.kept.delete(oldest)
		}
	}

	/** Discoveries remembered (for tests and bounds). */
	get size(): number {
		return this.kept.size
	}

	/** `discoveryId`'s keep times still in the window (its entry pruned to them). */
	private live(discoveryId: string, now: number): number[] {
		const times = this.kept.get(discoveryId)
		if (times === undefined) return []
		const live = times.filter(at => now - at < NOISE_EVIDENCE_WINDOW_MS)
		if (live.length === 0) this.kept.delete(discoveryId)
		else if (live.length !== times.length) this.kept.set(discoveryId, live)
		return live
	}

	/**
	 * Drops the entries whose newest keep has left the window, from the least recently spent on:
	 * the map is in spend order, so it stops at the first live one (O(expired) per call).
	 */
	private expire(now: number): void {
		for (const [id, times] of this.kept) {
			const newest = times[times.length - 1]
			if (newest !== undefined && now - newest < NOISE_EVIDENCE_WINDOW_MS)
				return
			this.kept.delete(id)
		}
	}
}
