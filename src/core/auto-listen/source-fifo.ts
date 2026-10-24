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
 * Write-time entries (end position, time), one per write; consumed entries are retired before
 * each append. Only when 256 writes are still queued does the newest entry absorb later writes
 * (keeping its earlier time). Bound: `oldestQueuedAt` is exact while fewer than 256 queued writes
 * exist and is never later than the truth; once the head reaches a coalesced entry it is early
 * by at most that entry's time span, which is under the FIFO's own span (3 s). At 50 writes/s
 * the 3 s FIFO holds at most 150 writes (< 256), so the wiring always stays exact.
 */
const TIME_ENTRIES = 256

export class SourceFifo {
	readonly capacity: number
	private readonly ring: Int16Array
	private readonly flagRing: Uint8Array
	private readonly timeEnd = new Float64Array(TIME_ENTRIES)
	private readonly timeAt = new Float64Array(TIME_ENTRIES)
	private timeHead = 0
	private timeCount = 0
	private head = 0
	private size = 0
	private qualified = 0
	/** Total samples ever removed from the head (read, discarded or dropped). */
	private headPos = 0
	private dropped = 0

	constructor(capacity: number = AUTO_ROUTE_FIFO_SAMPLES) {
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
				// Output flags follow the filter centre, so count them rather than `f`.
				this.countQualified(tail, p)
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
		let p = this.head
		for (let j = 0; j < take; j++) {
			out[o + j] = ring[p] ?? 0
			if (flagsOut !== null) flagsOut[o + j] = flags[p] ?? FLAG_SILENT
			p = p + 1 === cap ? 0 : p + 1
		}
		if (want > take) {
			out.fill(0, o + take, o + want)
			if (flagsOut !== null) flagsOut.fill(FLAG_SILENT, o + take, o + want)
		}
		this.removeHead(take)
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

	private removeHead(n: number): void {
		this.countRemoved(n)
		this.advance(n)
	}

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

	private countQualified(from: number, n: number): void {
		for (let j = from; j < from + n; j++)
			if (this.flagRing[j] !== FLAG_SILENT) this.qualified++
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

	private noteTime(at: number): void {
		// Retire consumed entries first, so the ring only coalesces while 256 writes are queued.
		this.trimTimes()
		const end = this.headPos + this.size
		if (this.timeCount === TIME_ENTRIES) {
			const last = (this.timeHead + this.timeCount - 1) % TIME_ENTRIES
			this.timeEnd[last] = end
			return
		}
		const idx = (this.timeHead + this.timeCount) % TIME_ENTRIES
		this.timeEnd[idx] = end
		this.timeAt[idx] = at
		this.timeCount++
	}

	private trimTimes(): void {
		while (
			this.timeCount > 0 &&
			(this.timeEnd[this.timeHead] ?? 0) <= this.headPos
		) {
			this.timeHead = (this.timeHead + 1) % TIME_ENTRIES
			this.timeCount--
		}
	}
}
