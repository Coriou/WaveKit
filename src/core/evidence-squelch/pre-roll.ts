/**
 * Evidence squelch pre-roll (docs/specs/evidence-squelch/design.md, PreRoll): a preallocated FIFO
 * of PCM bytes with run-length tags that rewrites each chunk in place with its delayed output,
 * one output byte per input byte.
 *
 * Model: the FIFO holds samples in input order in a byte ring of `capacity + 1` samples (slot =
 * position modulo the ring). Every removal is at the head (catch-up discards a leading `drop`
 * run; overflow only happens while the whole FIFO is `pending`), so the FIFO is always one
 * contiguous slot range. `pass` and `guard` behave identically here and share one code.
 *
 * Split samples (plan A3): a sample's output is decided when its first byte arrives, with the tag
 * of that call; its remaining bytes are carried by `partial` (bytes done) and the chosen source
 * slot. A sample's own slot is always written before its output byte is read, so a sample that
 * plays at delay 0 reads back its own bytes.
 */
import { WaveKitError } from "../../utils/errors.js"
import type { PreRollOptions, PreRollPort, PreRollTag } from "./contract.js"
import {
	pcmSampleBytes,
	preRollBytes,
	preRollCapacitySamples,
} from "./contract.js"

const PENDING = 0
const PLAY = 1
const DROP = 2

/**
 * Tag runs. Adjacent runs of one code merge (pass and guard share a code), so runs alternate.
 * Tags change at most once per stage-1 transition, latch, guard expiry or overflow, and stage 1
 * decides per 10 ms block, so every interior run spans at least one whole block: a full 1 500 ms
 * FIFO holds at most ceil(1 500 / 10) = 150 block runs + a partial head run + a partial tail block
 * + the pending suffix = 153 runs (design, Pre-roll sizing). 160 leaves margin; past it (not
 * reachable from the wiring, see `runOverflows`) the oldest run is discarded.
 */
const MAX_RUNS = 160

/** Below this many free slots the steady copy uses a byte loop instead of many tiny copies. */
const MIN_COPY_SAMPLES = 16

function tagCode(tag: PreRollTag): number {
	switch (tag) {
		case "pending":
			return PENDING
		case "pass":
		case "guard":
			return PLAY
		default:
			// "drop" and any unknown tag: never play (fail closed).
			return DROP
	}
}

export class PreRoll implements PreRollPort {
	readonly capacitySamples: number
	private readonly width: number
	/** Ring size in samples: capacity plus one sample for the sample in flight. */
	private readonly slots: number
	private readonly ring: Buffer
	/** Run ring: [2 × i] length in samples, [2 × i + 1] tag code. */
	private readonly runs = new Int32Array(2 * MAX_RUNS)
	private runHead = 0
	private runCount = 0
	/** Slot of the FIFO head. */
	private headSlot = 0
	/** Samples in the FIFO (including a started, retained sample in flight). */
	private size = 0
	/** Bytes of the sample in flight already processed; 0 when on a sample boundary. */
	private partial = 0
	/** Byte offset of the in-flight sample's own slot. */
	private curSlotByte = 0
	/** Byte offset of the in-flight output sample's source slot, or -1 for zero. */
	private curSrcByte = -1
	private overflowCount = 0

	constructor(options: PreRollOptions) {
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
		this.slots = this.capacitySamples + 1
		this.ring = Buffer.alloc(preRollBytes(rate, format))
	}

	/** Tag runs held now (diagnostic; bounded by 160). */
	get tagRuns(): number {
		return this.runCount
	}

	/** Runs discarded because the run ring was full (diagnostic; 0 under the wiring). */
	get runOverflows(): number {
		return this.overflowCount
	}

	get delaySamples(): number {
		return this.size
	}

	process(chunk: Buffer, start: number, end: number, tag: PreRollTag): void {
		// Malformed ranges are clamped to the chunk; an empty range is a no-op.
		let i = Math.max(0, Math.min(chunk.length, Math.trunc(start) || 0))
		const stop = Math.max(0, Math.min(chunk.length, Math.trunc(end) || 0))
		if (stop <= i) return
		const code = tagCode(tag)
		if (this.partial > 0) {
			i = this.stepBytes(chunk, i, stop)
			if (this.partial > 0) return
		}
		const width = this.width
		let whole = Math.floor((stop - i) / width)
		while (whole > 0) {
			const done = this.batch(chunk, i, whole, code)
			i += done * width
			whole -= done
		}
		if (i < stop) {
			this.begin(code)
			this.stepBytes(chunk, i, stop)
		}
	}

	latch(): void {
		this.retagPending(PLAY)
	}

	abandon(): void {
		this.retagPending(DROP)
	}

	clear(): void {
		this.runHead = 0
		this.runCount = 0
		this.headSlot = 0
		this.size = 0
		// An output sample in flight from a queued sample stops; one playing itself finishes.
		if (this.partial > 0 && this.curSrcByte !== this.curSlotByte)
			this.curSrcByte = -1
	}

	// --- per-sample rule (design steps 1-3) for a sample whose first byte is arriving ---

	private begin(code: number): void {
		if (code !== PENDING && this.hasPending()) this.retagPending(DROP)
		if (this.size > 0) this.discardLeadingDrop()
		const slot = (this.headSlot + this.size) % this.slots
		this.pushRun(code, 1)
		this.size++
		const head = this.headCode()
		let src = -1
		if (head === PLAY) {
			src = this.headSlot
			this.popHead(1)
		} else if (head === DROP) {
			this.popHead(1)
		} else if (this.size > this.capacitySamples) {
			this.popHead(1)
		}
		this.curSlotByte = slot * this.width
		this.curSrcByte = src < 0 ? -1 : src * this.width
		this.partial = 0
	}

	private stepBytes(chunk: Buffer, from: number, stop: number): number {
		const ring = this.ring
		const width = this.width
		let i = from
		let p = this.partial
		while (p < width && i < stop) {
			ring[this.curSlotByte + p] = chunk[i] ?? 0
			chunk[i] = this.curSrcByte < 0 ? 0 : (ring[this.curSrcByte + p] ?? 0)
			p++
			i++
		}
		this.partial = p === width ? 0 : p
		return i
	}

	// --- whole samples; equivalent to `count` calls of the per-sample rule. Returns samples done. ---

	private batch(
		chunk: Buffer,
		at: number,
		count: number,
		code: number,
	): number {
		const width = this.width
		if (code !== PENDING && this.hasPending()) this.retagPending(DROP)
		if (this.size > 0) this.discardLeadingDrop()
		if (this.size === 0) {
			if (code === DROP) {
				// Fast path: nothing queued, stage 1 closed.
				chunk.fill(0, at, at + count * width)
				return count
			}
			// Each sample plays itself at delay 0.
			if (code === PLAY) return count
			// Waiting from empty: keep the newest up to capacity, emit zeros.
			const keep = Math.min(count, this.capacitySamples)
			const first = (this.headSlot + count - keep) % this.slots
			this.writeIn(chunk, at + (count - keep) * width, keep, first)
			chunk.fill(0, at, at + count * width)
			this.headSlot = first
			this.size = keep
			this.pushRun(PENDING, keep)
			return count
		}
		const head = this.headCode()
		if (head === PENDING) {
			// The whole FIFO is pending (pending is always the newest suffix) and so is the input.
			const total = this.size + count
			const kept = Math.min(total, this.capacitySamples)
			const keepIn = Math.min(count, kept)
			const inSlot = (this.headSlot + this.size + count - keepIn) % this.slots
			this.writeIn(chunk, at + (count - keepIn) * width, keepIn, inSlot)
			chunk.fill(0, at, at + count * width)
			this.headSlot = (this.headSlot + total - kept) % this.slots
			this.size = kept
			this.runs[2 * this.runHead] = kept
			return count
		}
		// Head plays: one queued sample leaves for each that enters; the delay is constant.
		const playable = this.runs[2 * this.runHead] ?? 0
		const size = this.size
		const free = this.slots - size
		if (code === PLAY && playable === size && count > size && size <= free) {
			// Steady over: output = queue then the input's head; the input's tail is the new queue.
			const tail = (this.headSlot + size) % this.slots
			this.writeIn(chunk, at + (count - size) * width, size, tail)
			chunk.copyWithin(at + size * width, at, at + (count - size) * width)
			this.readOut(chunk, at, size, this.headSlot)
			this.headSlot = tail
			return count
		}
		const m = Math.min(count, playable)
		if (free >= MIN_COPY_SAMPLES) {
			let done = 0
			while (done < m) {
				const n = Math.min(m - done, free)
				const pos = at + done * width
				this.writeIn(chunk, pos, n, (this.headSlot + size) % this.slots)
				this.readOut(chunk, pos, n, this.headSlot)
				this.headSlot = (this.headSlot + n) % this.slots
				done += n
			}
		} else {
			const ring = this.ring
			for (let j = 0; j < m; j++) {
				const pos = at + j * width
				const inByte = ((this.headSlot + size) % this.slots) * width
				const outByte = this.headSlot * width
				for (let b = 0; b < width; b++) {
					ring[inByte + b] = chunk[pos + b] ?? 0
					chunk[pos + b] = ring[outByte + b] ?? 0
				}
				this.headSlot = (this.headSlot + 1) % this.slots
			}
		}
		this.popRuns(m)
		this.pushRun(code, m)
		return m
	}

	// --- ring copies with wrap ---

	private writeIn(chunk: Buffer, pos: number, n: number, slot: number): void {
		const width = this.width
		const first = Math.min(n, this.slots - slot)
		chunk.copy(this.ring, slot * width, pos, pos + first * width)
		if (first < n)
			chunk.copy(this.ring, 0, pos + first * width, pos + n * width)
	}

	private readOut(chunk: Buffer, pos: number, n: number, slot: number): void {
		const width = this.width
		const first = Math.min(n, this.slots - slot)
		this.ring.copy(chunk, pos, slot * width, (slot + first) * width)
		if (first < n)
			this.ring.copy(chunk, pos + first * width, 0, (n - first) * width)
	}

	// --- run ring ---

	private headCode(): number {
		return this.runs[2 * this.runHead + 1] ?? DROP
	}

	private lastIndex(): number {
		return (this.runHead + this.runCount - 1) % MAX_RUNS
	}

	private hasPending(): boolean {
		return this.runCount > 0 && this.runs[2 * this.lastIndex() + 1] === PENDING
	}

	/** Retags the pending suffix (one run) and merges it into an equal predecessor. */
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
		if (this.runCount === MAX_RUNS) {
			// Unreachable from the wiring (at most 153 runs, see MAX_RUNS). The head is never
			// `drop` here (leading drop runs are discarded before every append), so this loses
			// the oldest queued audio; it keeps the ring and the delay bounded instead of throwing.
			this.overflowCount++
			this.dropHeadRun()
		}
		const idx = (this.runHead + this.runCount) % MAX_RUNS
		this.runs[2 * idx] = len
		this.runs[2 * idx + 1] = code
		this.runCount++
	}

	private dropHeadRun(): void {
		const len = this.runs[2 * this.runHead] ?? 0
		this.headSlot = (this.headSlot + len) % this.slots
		this.size -= len
		this.runHead = (this.runHead + 1) % MAX_RUNS
		this.runCount--
	}

	private discardLeadingDrop(): void {
		while (this.runCount > 0 && this.headCode() === DROP) this.dropHeadRun()
	}

	/** Removes `n` samples from the head runs only (slots are advanced by the caller). */
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

	private popHead(n: number): void {
		this.popRuns(n)
		this.headSlot = (this.headSlot + n) % this.slots
		this.size -= n
	}
}
