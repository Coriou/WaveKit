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

/**
 * Noise-read files of one discovery in the rolling hour before a file at or over which the
 * proven-channel noise discard applies (DiscoveryNoiseRate; recording-verdict.ts finishPath).
 * Below it a noise-read file is kept as before the noise rule (`prior-none`, or the later rules).
 *
 * Arithmetic (recall corpus of 2026-11-25): the busiest real-voice discoveries made at most 9
 * noise-read files in any rolling hour, the spur-like emitter at least 20 in the hours it ran.
 * 15 sits between with margin both ways (9 × 1.67, 20 × 0.75). Without the latch
 * (DISCOVERY_NOISE_LATCH_MS) a noise source kept up to 15 files after each quiet hour before the
 * gate closed on it again: the corpus emitter warmed up 4 times a day (54 files kept).
 */
export const DISCOVERY_NOISE_GATE = 15

/**
 * How long the gate stays closed after a discovery last reached it: 24 h (86 400 000 ms). While
 * closed the discard applies at any rate, so the warm-up of up to DISCOVERY_NOISE_GATE kept files
 * happens once per process start (the state is in memory) instead of after every quiet hour: the
 * corpus emitter kept 45 files over its day (15 of warm-up, then the evidence budget's 2 an hour)
 * instead of 73. Voice discoveries' noise reads peak at 9 in any rolling hour of the corpus, under
 * the gate, so the latch never closes on them.
 */
export const DISCOVERY_NOISE_LATCH_MS = 86_400_000

/**
 * The noise-read rate of each discovery: a file counts when the proven-channel noise rule judges
 * it (recording-verdict.ts noiseRuleJudges: admission noise, no decoded tone, a periodic share
 * under 0.10), kept or discarded, once per file, and its gate latch. Recorder state like
 * NoiseEvidenceBudget: lost with the process, no clock of its own (callers pass monotonic ms),
 * the same discovery bound: at most NOISE_EVIDENCE_MAX_DISCOVERIES discoveries, each at most
 * `gate + 1` times and one latch time (2 048 × 17 numbers ≈ 272 KB of values), times past
 * NOISE_EVIDENCE_WINDOW_MS dropped.
 *
 * The latch: a note that leaves `gate` or more live times (the note's own time included: the
 * gate is reached) sets `latchedAt` to its time; it is the only thing that sets it, so a judged
 * read while closed refreshes `latchedAt` only when the rolling-hour count is again at or over
 * the gate. The discovery is `latched` while `now − latchedAt` is under `latchMs`
 * (DISCOVERY_NOISE_LATCH_MS, 24 h): the gate is closed (the discard applies) whatever `before`
 * reads. An entry is dropped only when its latch expired (or never set) and every time expired.
 *
 * Transition table, per discovery `d` (`reads`: its noise-read times less than
 * NOISE_EVIDENCE_WINDOW_MS before `now`, oldest first, at most `gate + 1`; expired times first;
 * `latchedAt`: null or the time of the last note that reached the gate):
 *
 * | state                              | event   | result                                       |
 * | ---------------------------------- | ------- | -------------------------------------------- |
 * | no discovery (null)                | before  | 0 (never gated)                              |
 * | no discovery (null)                | latched | false                                        |
 * | no discovery (null)                | note    | nothing                                      |
 * | d unknown, or reads empty          | before  | 0                                            |
 * | reads has n times                  | before  | n (gated when n ≥ DISCOVERY_NOISE_GATE)      |
 * | latchedAt null, or now − it ≥ 24 h | latched | false                                        |
 * | now − latchedAt < 24 h             | latched | true (gated at any n)                        |
 * | reads has under gate + 1 times     | note    | reads += now, d moves newest                 |
 * | reads has gate + 1 times           | note    | oldest dropped, reads += now, d moves newest |
 * | reads after the note ≥ gate        | note    | latchedAt = now (reached or refreshed)       |
 * | reads after the note < gate        | note    | latchedAt unchanged                          |
 * | every time expired, latch expired  | any     | d's entry dropped                            |
 * | every time expired, latch live     | any     | entry kept (times dropped, latch held)       |
 * | max entries, new d                 | note    | least recently noted d dropped, latched too  |
 *
 * Capping at `gate + 1` keeps `before` exact up to the gate: the newest `gate + 1` times are the
 * live ones whenever `gate + 1` or more are live, so `before` is min(live count, gate + 1).
 */
export class DiscoveryNoiseRate {
	/** Discovery → its noise-read times in the window (oldest first) and latch; the map least recently noted first. */
	private readonly reads = new Map<
		string,
		{ times: number[]; latchedAt: number | null }
	>()

	constructor(
		private readonly gate = DISCOVERY_NOISE_GATE,
		private readonly maxDiscoveries = NOISE_EVIDENCE_MAX_DISCOVERIES,
		private readonly latchMs = DISCOVERY_NOISE_LATCH_MS,
	) {}

	/** Noise-read files of `discoveryId` in the hour before `now` (capped at gate + 1; table above). */
	before(discoveryId: string | null, now: number): number {
		if (discoveryId === null) return 0
		this.expire(now)
		return this.live(discoveryId, now)?.times.length ?? 0
	}

	/** The gate of `discoveryId` is latched closed at `now`: it reached the gate under 24 h ago. */
	latched(discoveryId: string | null, now: number): boolean {
		if (discoveryId === null) return false
		this.expire(now)
		return this.latchLive(this.live(discoveryId, now), now)
	}

	/** Notes a noise-read file of `discoveryId` at `now` (call once per file, after `before`). */
	note(discoveryId: string | null, now: number): void {
		if (discoveryId === null) return
		this.expire(now)
		const entry = this.live(discoveryId, now)
		const times = [...(entry?.times ?? []), now].slice(-(this.gate + 1))
		// Reaching the gate (this note's time included) sets or refreshes the latch, nothing else.
		const latchedAt =
			times.length >= this.gate ? now : (entry?.latchedAt ?? null)
		this.reads.delete(discoveryId)
		this.reads.set(discoveryId, { times, latchedAt })
		while (this.reads.size > this.maxDiscoveries) {
			const oldest = this.reads.keys().next().value
			if (oldest === undefined) break
			this.reads.delete(oldest)
		}
	}

	/** Discoveries remembered (for tests and bounds). */
	get size(): number {
		return this.reads.size
	}

	/** Times stored for `discoveryId`, expired ones included (for tests of the bound). */
	stored(discoveryId: string): number {
		return this.reads.get(discoveryId)?.times.length ?? 0
	}

	private latchLive(
		entry: { latchedAt: number | null } | undefined,
		now: number,
	): boolean {
		const at = entry?.latchedAt ?? null
		return at !== null && now - at < this.latchMs
	}

	/** The entry with its expired times dropped; dropped itself (undefined) when nothing is live. */
	private live(
		discoveryId: string,
		now: number,
	): { times: number[]; latchedAt: number | null } | undefined {
		const entry = this.reads.get(discoveryId)
		if (entry === undefined) return undefined
		const times = entry.times.filter(at => now - at < NOISE_EVIDENCE_WINDOW_MS)
		if (times.length === 0 && !this.latchLive(entry, now)) {
			this.reads.delete(discoveryId)
			return undefined
		}
		if (times.length !== entry.times.length) entry.times = times
		return entry
	}

	/**
	 * As NoiseEvidenceBudget.expire: the map is in note order, so it stops at the first entry with
	 * a live time; before it, an entry whose latch still holds is kept (its expired times dropped).
	 */
	private expire(now: number): void {
		for (const [id, entry] of this.reads) {
			const newest = entry.times[entry.times.length - 1]
			if (newest !== undefined && now - newest < NOISE_EVIDENCE_WINDOW_MS)
				return
			if (this.latchLive(entry, now)) entry.times = []
			else this.reads.delete(id)
		}
	}
}
