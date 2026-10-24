/**
 * Tag-only replay of the evidence pre-roll's run model (docs/specs/auto-listen-route/design.md,
 * Analog qualification at sample resolution; the model is the PreRoll of
 * docs/specs/evidence-squelch/design.md). It holds no audio: each `process` call returns the
 * output byte runs of the matching real `PreRoll.process` call as `play` (the byte comes from a
 * queued or current sample) or `mute` (the pre-roll writes zero), so `/auto` qualifies exactly the
 * samples `/stream` plays (requirement 3.6).
 *
 * The live demodulator calls `process`, `latch`, `abandon`, `muteTail` and `clear` next to each call on the
 * real pre-roll for the life of the run (requirement 3.7), then `sync(preRoll.delaySamples)`. A
 * mismatch (a defect) mutes every output until the real pre-roll holds no sample, at which point
 * the empty shadow is exact again.
 *
 * Cost: O(1) run appends and head trims per call on fixed Int32Array rings; no allocation after
 * construction.
 */
import type {
	EvidencePcmFormat,
	PreRollTag,
} from "../evidence-squelch/contract.js"
import {
	pcmSampleBytes,
	preRollCapacitySamples,
} from "../evidence-squelch/contract.js"
import { WaveKitError } from "../../utils/errors.js"

const PENDING = 0
const PLAY = 1
const DROP = 2

/** Same run bound as the pre-roll (at most 153 runs reachable, 160 with margin). */
const MAX_RUNS = 160
/**
 * Output runs per call: the batch loop emits at most one run per FIFO run it consumes plus the
 * split-sample lead, the begin of a trailing split sample and the final batch, so
 * 160 + 8 is enough; 2 × 160 + 8 leaves margin. Past it the last run absorbs the rest as mute
 * (fail closed).
 */
const MAX_OUT_RUNS = 2 * MAX_RUNS + 8

function tagCode(tag: PreRollTag): number {
	switch (tag) {
		case "pending":
			return PENDING
		case "pass":
		case "guard":
			return PLAY
		default:
			return DROP
	}
}

export interface PreRollShadowOptions {
	rate: number
	format: EvidencePcmFormat
}

export class PreRollShadow {
	readonly capacitySamples: number
	private readonly width: number
	private readonly runs = new Int32Array(2 * MAX_RUNS)
	private runHead = 0
	private runCount = 0
	private size = 0
	/** Bytes of the sample in flight already processed (0 on a sample boundary). */
	private partial = 0
	/** The in-flight output sample comes from a slot (plays). */
	private curPlays = false
	/** The in-flight output sample is the in-flight input sample itself (delay 0). */
	private curSelf = false
	private readonly out = new Int32Array(2 * MAX_OUT_RUNS)
	private outCount = 0
	private failedState = false
	private mismatchCount = 0

	constructor(options: PreRollShadowOptions) {
		const { rate, format } = options
		if (format !== "s16le" && format !== "f32le")
			throw new WaveKitError("Unknown pre-roll PCM format", "PRE_ROLL_FORMAT")
		if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0)
			throw new WaveKitError(
				"Pre-roll rate must be finite and positive",
				"PRE_ROLL_RATE",
			)
		this.width = pcmSampleBytes(format)
		this.capacitySamples = preRollCapacitySamples(rate)
	}

	/** Samples the matching pre-roll holds (including a sample in flight). */
	get delaySamples(): number {
		return this.size
	}

	/** True after a mismatch until the next resync. */
	get failed(): boolean {
		return this.failedState
	}

	/** Mismatches seen (diagnostic). */
	get mismatches(): number {
		return this.mismatchCount
	}

	/** Output runs of the last `process` call. */
	get runCountOut(): number {
		return this.outCount
	}

	/** Byte length of output run `i` of the last `process` call. */
	runBytes(i: number): number {
		return i >= 0 && i < this.outCount ? (this.out[2 * i] ?? 0) : 0
	}

	/** True when output run `i` of the last `process` call plays. */
	runPlays(i: number): boolean {
		return i >= 0 && i < this.outCount && this.out[2 * i + 1] === 1
	}

	/**
	 * Mirrors `PreRoll.process(chunk, start, start + bytes, tag)`; returns the output run count.
	 * While failed every run is mute.
	 */
	process(bytes: number, tag: PreRollTag): number {
		this.outCount = 0
		let left = Math.max(0, Math.trunc(bytes) || 0)
		if (left === 0) return 0
		const code = tagCode(tag)
		const width = this.width
		if (this.partial > 0) {
			const n = Math.min(left, width - this.partial)
			this.emit(n, this.curPlays)
			this.partial = (this.partial + n) % width
			left -= n
			if (this.partial > 0) return this.finish()
		}
		let whole = Math.floor(left / width)
		left -= whole * width
		while (whole > 0) whole -= this.batch(whole, code)
		if (left > 0) {
			this.begin(code)
			this.emit(left, this.curPlays)
			this.partial = left
		}
		return this.finish()
	}

	latch(): void {
		this.retagPending(PLAY)
	}

	abandon(): void {
		this.retagPending(DROP)
	}

	/**
	 * Mirrors `PreRoll.muteTail(samples, fade)` (evidence squelch A17): the newest `samples`
	 * queued samples, not the one in flight, are retagged `drop`. The fade only scales audio the
	 * pre-roll still plays, so it changes no tag. O(runs), no allocation.
	 */
	muteTail(samples: number): void {
		const inFlight = this.partial > 0 ? 1 : 0
		const n = Math.min(
			Math.max(0, Math.floor(samples) || 0),
			this.size - inFlight,
		)
		if (n <= 0) return
		const flightCode =
			inFlight > 0 ? (this.runs[2 * this.lastIndex() + 1] ?? DROP) : DROP
		this.popTail(n + inFlight)
		this.pushRun(DROP, n)
		if (inFlight > 0) this.pushRun(flightCode, 1)
	}

	clear(): void {
		this.runHead = 0
		this.runCount = 0
		this.size = 0
		if (this.partial > 0 && !this.curSelf) this.curPlays = false
	}

	/**
	 * Compares with the real pre-roll's `delaySamples` after a `process`. Returns true while in
	 * sync. On a mismatch the shadow fails closed; once the real pre-roll holds no sample it is
	 * reset to the empty state (exact again), with a sample in flight treated as mute.
	 */
	sync(realDelaySamples: number): boolean {
		if (this.failedState) {
			if (realDelaySamples === 0) {
				this.runHead = 0
				this.runCount = 0
				this.size = 0
				this.curPlays = false
				this.curSelf = false
				this.failedState = false
			}
			return false
		}
		if (realDelaySamples !== this.size) {
			this.failedState = true
			this.mismatchCount++
			return this.sync(realDelaySamples)
		}
		return true
	}

	// --- output runs ---

	private emit(bytes: number, plays: boolean): void {
		if (bytes <= 0) return
		const flag = plays && !this.failedState ? 1 : 0
		if (this.outCount > 0) {
			const last = this.outCount - 1
			if (this.out[2 * last + 1] === flag) {
				this.out[2 * last] = (this.out[2 * last] ?? 0) + bytes
				return
			}
			if (this.outCount === MAX_OUT_RUNS) {
				this.out[2 * last] = (this.out[2 * last] ?? 0) + bytes
				this.out[2 * last + 1] = 0
				return
			}
		}
		this.out[2 * this.outCount] = bytes
		this.out[2 * this.outCount + 1] = flag
		this.outCount++
	}

	private finish(): number {
		return this.outCount
	}

	// --- the pre-roll's per-sample rule and batch, on runs only ---

	private begin(code: number): void {
		if (code !== PENDING && this.hasPending()) this.retagPending(DROP)
		if (this.size > 0) this.discardLeadingDrop()
		const self = this.size === 0
		this.pushRun(code, 1)
		this.size++
		const head = this.headCode()
		let plays = false
		if (head === PLAY) {
			plays = true
			this.popHead(1)
		} else if (head === DROP) {
			this.popHead(1)
		} else if (this.size > this.capacitySamples) {
			this.popHead(1)
		}
		this.curPlays = plays
		this.curSelf = plays && self
		this.partial = 0
	}

	private batch(count: number, code: number): number {
		const width = this.width
		if (code !== PENDING && this.hasPending()) this.retagPending(DROP)
		if (this.size > 0) this.discardLeadingDrop()
		if (this.size === 0) {
			if (code === DROP) {
				this.emit(count * width, false)
				return count
			}
			if (code === PLAY) {
				this.emit(count * width, true)
				return count
			}
			const keep = Math.min(count, this.capacitySamples)
			this.size = keep
			this.pushRun(PENDING, keep)
			this.emit(count * width, false)
			return count
		}
		if (this.headCode() === PENDING) {
			const kept = Math.min(this.size + count, this.capacitySamples)
			this.size = kept
			this.runs[2 * this.runHead] = kept
			this.emit(count * width, false)
			return count
		}
		const playable = this.runs[2 * this.runHead] ?? 0
		if (code === PLAY && playable === this.size) {
			// One play run holds the whole FIFO: one out per in, the runs do not change.
			this.emit(count * width, true)
			return count
		}
		const m = Math.min(count, playable)
		this.emit(m * width, true)
		this.popRuns(m)
		this.pushRun(code, m)
		return m
	}

	// --- run ring (as the pre-roll) ---

	private headCode(): number {
		return this.runs[2 * this.runHead + 1] ?? DROP
	}

	private lastIndex(): number {
		return (this.runHead + this.runCount - 1) % MAX_RUNS
	}

	private hasPending(): boolean {
		return this.runCount > 0 && this.runs[2 * this.lastIndex() + 1] === PENDING
	}

	private retagPending(code: number): void {
		if (!this.hasPending()) return
		const last = this.lastIndex()
		this.runs[2 * last + 1] = code
		if (this.runCount > 1) {
			const prev = (last + MAX_RUNS - 1) % MAX_RUNS
			if (this.runs[2 * prev + 1] === code) {
				this.runs[2 * prev] =
					(this.runs[2 * prev] ?? 0) + (this.runs[2 * last] ?? 0)
				this.runCount--
			}
		}
	}

	private pushRun(code: number, len: number): void {
		if (this.runCount > 0) {
			const last = this.lastIndex()
			if (this.runs[2 * last + 1] === code) {
				this.runs[2 * last] = (this.runs[2 * last] ?? 0) + len
				return
			}
		}
		if (this.runCount === MAX_RUNS) this.dropHeadRun()
		const idx = (this.runHead + this.runCount) % MAX_RUNS
		this.runs[2 * idx] = len
		this.runs[2 * idx + 1] = code
		this.runCount++
	}

	private dropHeadRun(): void {
		this.size -= this.runs[2 * this.runHead] ?? 0
		this.runHead = (this.runHead + 1) % MAX_RUNS
		this.runCount--
	}

	private discardLeadingDrop(): void {
		while (this.runCount > 0 && this.headCode() === DROP) this.dropHeadRun()
	}

	private popRuns(n: number): void {
		let left = n
		while (left > 0 && this.runCount > 0) {
			const len = this.runs[2 * this.runHead] ?? 0
			if (len <= left) {
				left -= len
				this.runHead = (this.runHead + 1) % MAX_RUNS
				this.runCount--
			} else {
				this.runs[2 * this.runHead] = len - left
				left = 0
			}
		}
	}

	/** Removes `n` samples from the tail runs (the caller re-adds runs; `size` is unchanged). */
	private popTail(n: number): void {
		let left = n
		while (left > 0 && this.runCount > 0) {
			const last = this.lastIndex()
			const len = this.runs[2 * last] ?? 0
			if (len <= left) {
				left -= len
				this.runCount--
			} else {
				this.runs[2 * last] = len - left
				left = 0
			}
		}
	}

	private popHead(n: number): void {
		this.popRuns(n)
		this.size -= n
	}
}
