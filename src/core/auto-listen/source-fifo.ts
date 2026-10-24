/**
 * Per-source 48 kHz Int16 FIFO with one qualification flag per sample
 * (docs/specs/auto-listen-route/design.md, SourceFifo). The resampler writes straight into ring
 * space (two calls when wrapping); overflow drops the oldest samples and counts them.
 *
 * All storage is allocated in the constructor (requirement 2.4): a 144 000-sample Int16 ring
 * (288 000 B), a parallel Uint8 flag ring (144 000 B) and a 256-entry write-time ring.
 */
import type { PolyphaseResampler } from "./resampler.js"
import { AUTO_ROUTE_FIFO_SAMPLES } from "./contract.js"

export const FLAG_SILENT = 0
/** Analog: the governing squelch plays this sample. */
export const FLAG_AUDIBLE = 1
/** Digital: received while the source was admitted (requirement 3.2). */
export const FLAG_ADMITTED = 2
export type SampleFlag =
	| typeof FLAG_SILENT
	| typeof FLAG_AUDIBLE
	| typeof FLAG_ADMITTED

/**
 * Write times (`oldestQueuedAt`). The ring holds entries (end position, time). A write within
 * the tolerance of the newest entry's time, earlier than it, or untimed extends that entry; the
 * entry keeps the minimum of its time and the write's time (a backward clock step lowers it).
 * Otherwise the write appends a new entry, so with nondecreasing write times the entries are
 * strictly more than `AUTO_ROUTE_TIME_TOLERANCE_MS` apart. Consumed entries are retired before
 * each append. When the ring is full, the two oldest entries merge under the earlier time.
 *
 * Never late (enforced for any finite input): every entry's time is ≤ the true write time of
 * each timed sample in it, because an entry starts at its first write's time, is only extended
 * by writes at or after (time − ∞, time + 1 ms] with the minimum kept, and merges keep the
 * minimum. Non-finite write times are treated as untimed.
 *
 * Error bound (for nondecreasing write times): the error is ≤ 1 ms whenever the oldest queued
 * sample's true age, measured from the newest write, is at most (4 096 − 2) × 1 ms = 4 094 ms.
 * Proof: tolerance merging alone moves a sample's time by ≤ 1 ms. A full-ring merge happens when
 * a write at W meets 4 096 entries t1 < t2 < … < t4096, each > 1 ms apart, with W > t4096 + 1 ms.
 * It gives the samples of the second-oldest entry the time t1; those samples were written at
 * most t2 + 1 ms, so their age W − (t2 + 1) > (4 096 − 1) − 1 = 4 094 ms, and ages only grow.
 * (4 096 − 1 is not a bound: a sample extending t2 by up to 1 ms is that much younger; see the
 * regression test.) 4 094 ms > `LIVE_AUDIO_AUTO_ROUTE_FIFO_MS` (3 000 ms), the longest age the
 * router acts on.
 *
 * Why early is the safe direction for the router (design, AutoListenRouter and admission versus
 * drain): age invalidation (> FIFO_MS) never keeps audio past its age; the preemption wait
 * (PREEMPT_MAX_MS) and the digital start wait (DIGITAL_START_MS) are never extended, so
 * Property 6's bound holds; and selection by oldest queued voice can only change for two inputs
 * within 1 ms of each other. A late error could hold stale audio or delay preemption past its
 * bound. The early error (≤ 1 ms) is below the 20 ms block on which decisions are taken.
 *
 * Size: 4 096 × 2 × 8 B = 64 kB per FIFO, allocated once.
 */
export const AUTO_ROUTE_TIME_TOLERANCE_MS = 1
export const AUTO_ROUTE_TIME_ENTRIES = 4_096

export class SourceFifo {
	readonly capacity: number
	private readonly ring: Int16Array
	private readonly flagRing: Uint8Array
	private readonly timeEntries: number
	private readonly timeEnd: Float64Array
	private readonly timeAt: Float64Array
	private timeHead = 0
	private timeCount = 0
	private head = 0
	private size = 0
	private qualified = 0
	/** Total samples ever removed from the head (read, discarded or dropped). */
	private headPos = 0
	private dropped = 0

	/**
	 * `timeEntries` (≥ 2) sizes the write-time ring; the age bound above becomes
	 * (timeEntries − 2) × 1 ms. Tests use small rings to reach saturation.
	 */
	constructor(
		capacity: number = AUTO_ROUTE_FIFO_SAMPLES,
		timeEntries: number = AUTO_ROUTE_TIME_ENTRIES,
	) {
		const t = Math.trunc(timeEntries)
		this.timeEntries =
			Number.isFinite(t) && t >= 2 ? t : AUTO_ROUTE_TIME_ENTRIES
		this.timeEnd = new Float64Array(this.timeEntries)
		this.timeAt = new Float64Array(this.timeEntries)
		const c = Math.trunc(capacity)
		this.capacity = Number.isFinite(c) && c > 0 ? c : AUTO_ROUTE_FIFO_SAMPLES
		this.ring = new Int16Array(this.capacity)
		this.flagRing = new Uint8Array(this.capacity)
	}

	get queuedSamples(): number {
		return this.size
	}

	/** Queued samples flagged audible or admitted. */
	get queuedAudibleSamples(): number {
		return this.qualified
	}

	/** Samples dropped at the head because the FIFO was full. */
	get overflowDroppedSamples(): number {
		return this.dropped
	}

	/** Write time of the oldest queued sample, or null when empty or not timed. */
	get oldestQueuedAt(): number | null {
		if (this.size === 0) return null
		this.trimTimes()
		if (this.timeCount === 0) return null
		const at = this.timeAt[this.timeHead] ?? Number.NaN
		return Number.isFinite(at) ? at : null
	}

	/** Flag of the oldest queued sample, or silent when empty. */
	get headFlag(): SampleFlag {
		if (this.size === 0) return FLAG_SILENT
		return (this.flagRing[this.head] ?? FLAG_SILENT) as SampleFlag
	}

	/**
	 * Resamples `view[start..end)` straight into ring space with `flag` (the resampler maps it per
	 * output sample by its filter centre). `at` is the write time for `oldestQueuedAt`.
	 */
	writeFrom(
		resampler: PolyphaseResampler,
		view: Int16Array | Float32Array,
		start: number,
		end: number,
		flag: SampleFlag,
		at = Number.NaN,
	): void {
		let i = Math.max(0, Math.min(view.length, Math.trunc(start) || 0))
		const stop = Math.max(0, Math.min(view.length, Math.trunc(end) || 0))
		const f =
			flag === FLAG_AUDIBLE || flag === FLAG_ADMITTED ? flag : FLAG_SILENT
		const cap = this.capacity
		let wrote = 0
		// Loop until the input is used up and the resampler has no output left that the consumed
		// input already made available (a ring segment can fill before that output is written).
		while (i < stop || resampler.pendingOutput(0) > 0) {
			if (this.size === cap) {
				// Drop exactly what this write will overwrite (at most the whole ring).
				const need = Math.min(resampler.pendingOutput(stop - i), cap)
				if (need > 0) this.dropHead(need)
			}
			const tail = (this.head + this.size) % cap
			const len = Math.min(cap - tail, cap - this.size)
			resampler.process(
				view,
				i,
				stop,
				this.ring,
				tail,
				tail + len,
				f,
				this.flagRing,
			)
			const p = resampler.produced
			const c = resampler.consumed
			if (p > 0) {
				this.size += p
				// Output flags follow the filter centre; the resampler counts them as it writes.
				this.qualified += resampler.producedFlagged
				wrote += p
			}
			i += c
			if (c === 0 && p === 0) break
		}
		if (wrote > 0) this.noteTime(at)
	}

	/**
	 * Copies up to `n` queued samples into `out[offset..)` (and their flags into `flagsOut`),
	 * zeros past the end; removes what it copied. Returns the samples taken from the FIFO.
	 */
	read(
		out: Int16Array,
		offset: number,
		n: number,
		flagsOut: Uint8Array | null = null,
	): number {
		const o = Math.max(0, Math.min(out.length, Math.trunc(offset) || 0))
		const want = Math.max(0, Math.min(out.length - o, Math.trunc(n) || 0))
		const take = Math.min(want, this.size)
		// Index loops, not `subarray` + `set`: no view object per block (requirement 2.4).
		const cap = this.capacity
		const ring = this.ring
		const flags = this.flagRing
		// One pass copies samples and flags and counts the qualified ones removed.
		let p = this.head
		let q = 0
		for (let j = 0; j < take; j++) {
			out[o + j] = ring[p]!
			const fl = flags[p]!
			if (fl !== FLAG_SILENT) q++
			if (flagsOut !== null) flagsOut[o + j] = fl
			p = p + 1 === cap ? 0 : p + 1
		}
		if (want > take) {
			out.fill(0, o + take, o + want)
			if (flagsOut !== null) flagsOut.fill(FLAG_SILENT, o + take, o + want)
		}
		this.qualified -= q
		this.advance(take)
		return take
	}

	/** Discards up to `maxSamples` leading silent samples; returns the count. */
	discardSilentHead(maxSamples: number): number {
		const max = Math.max(0, Math.trunc(maxSamples) || 0)
		const cap = this.capacity
		let n = 0
		let p = this.head
		while (n < max && n < this.size && this.flagRing[p] === FLAG_SILENT) {
			n++
			p = p + 1 === cap ? 0 : p + 1
		}
		this.advance(n)
		return n
	}

	/** Discards every leading silent sample; returns the count. */
	discardUntilAudible(): number {
		return this.discardSilentHead(this.size)
	}

	clear(): void {
		this.head = 0
		this.size = 0
		this.qualified = 0
		this.timeHead = 0
		this.timeCount = 0
	}

	// --- internals ---

	private dropHead(n: number): void {
		const k = Math.min(n, this.size)
		this.countRemoved(k)
		this.advance(k)
		this.dropped += k
	}

	private countRemoved(n: number): void {
		if (this.qualified === 0) return
		const cap = this.capacity
		let p = this.head
		let q = 0
		for (let j = 0; j < n; j++) {
			if (this.flagRing[p] !== FLAG_SILENT) q++
			p = p + 1 === cap ? 0 : p + 1
		}
		this.qualified -= q
	}

	/** Removes `n` samples known to be silent or already counted. */
	private advance(n: number): void {
		if (n <= 0) return
		this.head = (this.head + n) % this.capacity
		this.size -= n
		this.headPos += n
		if (this.size === 0) {
			this.head = 0
			this.timeCount = 0
			this.timeHead = 0
		}
	}

	private noteTime(time: number): void {
		const at = Number.isFinite(time) ? time : Number.NaN
		this.trimTimes()
		const n = this.timeEntries
		const end = this.headPos + this.size
		if (this.timeCount > 0) {
			const last = (this.timeHead + this.timeCount - 1) % n
			const lastAt = this.timeAt[last] ?? Number.NaN
			// Within the tolerance, earlier (clock step) or untimed: extend, keeping the minimum.
			if (
				Number.isNaN(at) ||
				(!Number.isNaN(lastAt) && at - lastAt <= AUTO_ROUTE_TIME_TOLERANCE_MS)
			) {
				this.timeEnd[last] = end
				if (!Number.isNaN(at) && at < lastAt) this.timeAt[last] = at
				return
			}
		}
		if (this.timeCount === n) {
			// Full: merge the two oldest under the earlier time (see the bound above).
			const next = (this.timeHead + 1) % n
			const a = this.timeAt[this.timeHead] ?? Number.NaN
			const b = this.timeAt[next] ?? Number.NaN
			this.timeAt[next] =
				Number.isNaN(a) || Number.isNaN(b) ? a : Math.min(a, b)
			this.timeHead = next
			this.timeCount--
		}
		const idx = (this.timeHead + this.timeCount) % n
		this.timeEnd[idx] = end
		this.timeAt[idx] = at
		this.timeCount++
	}

	private trimTimes(): void {
		while (
			this.timeCount > 0 &&
			(this.timeEnd[this.timeHead] ?? 0) <= this.headPos
		) {
			this.timeHead = (this.timeHead + 1) % this.timeEntries
			this.timeCount--
		}
	}
}
