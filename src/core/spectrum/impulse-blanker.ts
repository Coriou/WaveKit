/**
 * Broadband impulse blanking (spec § 4.9). A frame whose power rises ≥ BLANK_RISE_DB over the
 * per-bin reference on ≥ BLANK_BIN_FRACTION of the usable bins is blanked: left out of
 * integration, counted and timed. ≥ RFI_MIN_EVENTS impulses at a stable interval (± 10 %) are
 * reported as broadband RFI with the period.
 *
 * The reference is the previous block's integrated mean power per bin: the per-bin floor where
 * there is only noise, the occupant's level where a steady emitter sits, so a steady wideband
 * occupant is never blanked. The first block after reset() has no reference: its frames are held
 * ("pending") and judged at endBlock() against the per-bin median of the block's own frames.
 * A block with more than half its frames blanked is `excluded` (the caller keeps it out of floor,
 * spur and FA learning); the next reference is then its raw mean, so a lasting level change is
 * accepted after one block.
 *
 * Powers are the linear shifted |X|² sums of accumulateShiftedPower (one frame each). Pure and
 * synchronous; the pipeline (Task 10) owns one per source.
 */
import { WaveKitError } from "../../utils/errors.js"
export const BLANK_RISE_DB = 6
export const BLANK_BIN_FRACTION = 0.5
export const RFI_MIN_EVENTS = 3
export const RFI_INTERVAL_TOLERANCE = 0.1
export const RFI_HOLD_MS = 2000
const MAX_EVENTS = 8
const MIN_PENDING_FRAMES = 3
/** The rise factor and the reference floor of `rises`; the wasm frame kernel takes these values. */
export const BLANK_RISE = 10 ** (BLANK_RISE_DB / 10)
export const BLANK_TINY = 1e-30
const RISE = BLANK_RISE
const MEDIAN_TO_MEAN = 1 / Math.LN2 // one frame's bin power is exponential: median = ln 2 × mean
const TINY = BLANK_TINY

export type FrameVerdict = "keep" | "blank" | "pending"

/** The usable span [lo, hi) `rises` counts over, and the rising-bin count that blanks a frame. */
export function blankSpan(opts: {
	fftSize: number
	usableStartBin: number
	usableEndBin: number
}): { lo: number; hi: number; need: number } {
	const lo = Math.max(0, opts.usableStartBin)
	const hi = Math.min(opts.fftSize, opts.usableEndBin)
	return {
		lo,
		hi,
		need: Math.max(1, Math.ceil(BLANK_BIN_FRACTION * (hi - lo))),
	}
}

export interface BlockBlanking {
	/** Frames offered in the block. */
	frames: number
	/** Frames now summed in the caller's accumulator (all of them when every frame was blanked). */
	integrated: number
	blanked: number
	/** More than half the frames were blanked: no floor, spur or FA learning from this block. */
	excluded: boolean
}

export interface RfiReport {
	/** A stable period exists and the last impulse is at most max(RFI_HOLD_MS, 3 periods) old. */
	active: boolean
	periodMs: number | null
	/** Impulses remembered (≤ 8). */
	events: number
}

export interface ImpulseBlankerOptions {
	fftSize: number
	/** Usable span [usableStartBin, usableEndBin) in FFT-shifted bins (the detector's edge mask). */
	usableStartBin: number
	usableEndBin: number
	sampleRateHz: number
	/**
	 * The raw sum and the reference in memory the caller owns (the wasm frame kernel's linear
	 * memory): the kernel adds each frame to `raw` and reads `ref`; this class keeps the rest.
	 */
	storage?: { raw: Float64Array; ref: Float64Array }
}

interface PendingFrame {
	startSample: number
	power: Float64Array
	/** From `pool` (returned there); false for a kernel slot the caller owns. */
	pooled: boolean
}

export class ImpulseBlanker {
	private readonly n: number
	private readonly lo: number
	private readonly hi: number
	private readonly need: number
	private readonly fs: number
	private readonly ref: Float64Array
	private readonly median: Float64Array
	private readonly raw: Float64Array
	private readonly column: number[] = []
	private readonly pool: Float64Array[] = []
	private hasRef = false
	private pending: PendingFrame[] = []
	private frames = 0
	private blankedInBlock = 0
	private total = 0
	private events: number[] = []
	private lastBlank: number | null = null
	private latest = 0

	constructor(opts: ImpulseBlankerOptions) {
		this.n = opts.fftSize
		const span = blankSpan(opts)
		this.lo = span.lo
		this.hi = span.hi
		this.need = span.need
		this.fs = opts.sampleRateHz
		this.ref = opts.storage?.ref ?? new Float64Array(this.n)
		this.median = new Float64Array(this.n)
		this.raw = opts.storage?.raw ?? new Float64Array(this.n)
	}

	/** A reference exists: frames are judged on offer, not held. */
	get hasReference(): boolean {
		return this.hasRef
	}

	/** Frames held for endBlock in this block. */
	get pendingCount(): number {
		return this.pending.length
	}

	/** Frames blanked since construction. */
	get blankedFrames(): number {
		return this.total
	}

	/**
	 * One frame's shifted linear bin powers. "keep": the caller integrates it; "blank": it is left
	 * out; "pending": the first block after reset() holds a copy and endBlock() decides.
	 */
	offer(power: Float64Array, startSample: number): FrameVerdict {
		this.latest = startSample
		if (this.lastBlank !== null && startSample < this.lastBlank) {
			// a new stream restarted the sample index: the old impulse timing says nothing about it
			this.events = []
			this.lastBlank = null
		}
		for (let i = 0; i < this.n; i++)
			this.raw[i] = (this.raw[i] ?? 0) + (power[i] ?? 0)
		this.frames++
		if (!this.hasRef) {
			const copy = this.pool.pop() ?? new Float64Array(this.n)
			copy.set(power)
			this.pending.push({ startSample, power: copy, pooled: true })
			return "pending"
		}
		if (!this.rises(power, this.ref)) return "keep"
		this.blank(startSample)
		return "blank"
	}

	/**
	 * `offer` for a frame the wasm kernel judged: it already added the frame to `raw` and, for
	 * "pending", copied it to `power` (a kernel slot, valid until this block ends). This keeps the
	 * timing, counts and the pending list exactly as `offer` would.
	 */
	noteOffer(
		startSample: number,
		verdict: FrameVerdict,
		power: Float64Array | null,
	): void {
		this.latest = startSample
		if (this.lastBlank !== null && startSample < this.lastBlank) {
			this.events = []
			this.lastBlank = null
		}
		this.frames++
		if (verdict === "pending") {
			if (!power)
				throw new WaveKitError(
					"a pending frame needs its power",
					"SCANNER_FRAME_KERNEL",
				)
			this.pending.push({ startSample, power, pooled: false })
		} else if (verdict === "blank") this.blank(startSample)
	}

	/**
	 * Closes the block: adds the kept pending frames to `acc`, substitutes the raw sum when every
	 * frame was blanked, and takes the next reference (the integrated mean, or the raw mean of an
	 * excluded block).
	 */
	endBlock(acc: Float64Array): BlockBlanking {
		if (this.pending.length > 0) this.resolvePending(acc)
		const frames = this.frames
		const blanked = this.blankedInBlock
		const excluded = 2 * blanked > frames
		let integrated = frames - blanked
		if (integrated === 0 && frames > 0) {
			acc.set(this.raw)
			integrated = frames
		}
		if (frames > 0) {
			const src = excluded ? this.raw : acc
			const div = excluded ? frames : integrated
			for (let i = 0; i < this.n; i++) this.ref[i] = (src[i] ?? 0) / div
			this.hasRef = true
		}
		this.clearBlock()
		return { frames, integrated, blanked, excluded }
	}

	/** Forgets the open block (discarded, stale or never closed). */
	dropBlock(): void {
		for (const f of this.pending) if (f.pooled) this.pool.push(f.power)
		this.pending = []
		this.clearBlock()
	}

	/** Epoch start: the reference no longer describes the window. Impulse timing survives (RFI belongs to the place, not the tuning). */
	reset(): void {
		this.hasRef = false
		this.dropBlock()
	}

	rfi(): RfiReport {
		const period = this.periodSamples()
		const last = this.lastBlank
		const hold = Math.max((RFI_HOLD_MS * this.fs) / 1000, 3 * (period ?? 0))
		const active =
			period !== null && last !== null && this.latest - last <= hold
		return {
			active,
			periodMs: active && period !== null ? (period * 1000) / this.fs : null,
			events: this.events.length,
		}
	}

	private rises(power: Float64Array, ref: Float64Array): boolean {
		let rising = 0
		for (let i = this.lo; i < this.hi; i++)
			if ((power[i] ?? 0) >= RISE * Math.max(ref[i] ?? 0, TINY)) rising++
		return rising >= this.need
	}

	private blank(startSample: number): void {
		this.blankedInBlock++
		this.total++
		const last = this.lastBlank
		if (last !== null && startSample < last) this.events = [] // a new stream restarted the sample index
		if (
			last === null ||
			startSample < last ||
			startSample - last > 2 * this.n
		) {
			this.events.push(startSample)
			if (this.events.length > MAX_EVENTS) this.events.shift()
		}
		this.lastBlank = startSample
	}

	private resolvePending(acc: Float64Array): void {
		const frames = this.pending
		const judge = frames.length >= MIN_PENDING_FRAMES
		if (judge) {
			const col = this.column
			for (let i = this.lo; i < this.hi; i++) {
				col.length = 0
				for (const f of frames) col.push(f.power[i] ?? 0)
				col.sort((a, b) => a - b)
				const mid = Math.floor(col.length / 2)
				const median =
					col.length % 2 === 1
						? (col[mid] ?? 0)
						: ((col[mid - 1] ?? 0) + (col[mid] ?? 0)) / 2
				this.median[i] = median * MEDIAN_TO_MEAN
			}
		}
		for (const f of frames) {
			if (judge && this.rises(f.power, this.median)) this.blank(f.startSample)
			else
				for (let i = 0; i < this.n; i++)
					acc[i] = (acc[i] ?? 0) + (f.power[i] ?? 0)
			if (f.pooled) this.pool.push(f.power)
		}
		this.pending = []
	}

	private periodSamples(): number | null {
		const e = this.events
		if (e.length < RFI_MIN_EVENTS) return null
		const intervals: number[] = []
		for (let i = e.length - RFI_MIN_EVENTS + 1; i < e.length; i++)
			intervals.push((e[i] ?? 0) - (e[i - 1] ?? 0))
		const mean = intervals.reduce((s, d) => s + d, 0) / intervals.length
		return mean > 0 &&
			intervals.every(d => Math.abs(d - mean) <= RFI_INTERVAL_TOLERANCE * mean)
			? mean
			: null
	}

	private clearBlock(): void {
		this.raw.fill(0)
		this.frames = 0
		this.blankedInBlock = 0
	}
}
