/**
 * Raw IQ bytes → Hann-windowed complex frames with absolute sample indices
 * (spec § 4.1, § 4.2, § 4.6).
 *
 * - Formats: U8_IQ (u/127.5 − 1, the channelizer mapping), S16_IQ (s/32768),
 *   FLOAT32LE IQ, all little-endian interleaved I, Q.
 * - Frame k of a contiguous stretch starts at stretchStart + k·hop, where hop
 *   is N, or N/2 with `overlap: 0.5` (§ 4.2). A gap, or a push whose startSample is not the next
 *   expected sample, is a seam: the partial frame before it is discarded and
 *   assembly restarts at the first sample after it.
 * - Counter runs (U8_IQ only; RTL2832 test mode, § 4.6): ≥ 256 consecutive
 *   bytes with b[n+1] = (b[n] + 1) mod 256. Run samples never appear in a frame;
 *   the partial frame before a run is discarded; `onCounterRun` fires once per
 *   finished run (end exclusive) before any frame that starts after it. A run
 *   cut by a seam ends at the last received sample. While a run is in
 *   progress, `activeCounterRun` reports it (the pipeline's stuck-test-mode
 *   check) and its bytes are released as they are scanned. To decide that a
 *   frame holds no counter bytes, U8_IQ holds back a frame that ends inside
 *   the trailing incrementing streak (in noise, the last 1–2 bytes) until the
 *   next push or a seam (a gap of 0 samples flushes it).
 * - Ownership: `push` copies `bytes`, so the caller may reuse its buffer as
 *   soon as `push` returns. The `re`/`im` arrays passed to `onFrame` are reused
 *   for every frame and are valid only during the callback; the callee may
 *   transform them in place.
 */
import { WaveKitError } from "../../utils/errors.js"
import type { IqFormat } from "./types.js"
import { hannWindow } from "./fft.js"

/** Shortest counter run accepted as a test-mode marker, in bytes (§ 4.6). */
export const MIN_COUNTER_RUN_BYTES = 256

const BYTES_PER_SAMPLE: Readonly<Record<IqFormat, number>> = {
	U8_IQ: 2,
	S16_IQ: 4,
	FLOAT32LE: 8,
}

export function bytesPerSample(format: IqFormat): number {
	return BYTES_PER_SAMPLE[format]
}

export interface Frame {
	startSample: number
	re: Float32Array
	im: Float32Array
	/** Samples in the frame with a clipped I or Q (U8 0/255, S16 |s| ≥ 32767, float |x| ≥ 1). */
	clipped: number
}

export interface CounterRun {
	startSample: number
	/** Exclusive. */
	endSample: number
}

type QueuedInput =
	| { kind: "bytes"; startSample: number; bytes: Uint8Array }
	| { kind: "gap"; startSample: number; samples: number }

type ScanResult = "run-start" | "run-end" | "end"

export class FrameSource {
	private readonly format: IqFormat
	private readonly bps: number
	private readonly fftSize: number
	private readonly frameBytes: number
	/** Frame advance: fftSize, or fftSize/2 with 50 % overlap. */
	private readonly hopSamples: number
	private readonly hopBytes: number
	private readonly window: Float32Array
	private readonly re: Float32Array
	private readonly im: Float32Array
	private readonly queue: QueuedInput[] = []
	private buf = new Uint8Array(0)
	private view = new DataView(this.buf.buffer)
	/** Unconsumed bytes are buf[head, tail); buf[head] is the first byte of sample bufStartSample. */
	private head = 0
	private tail = 0
	private bufStartSample = 0
	/** Sample index the next pushed byte must belong to; null before the first push. */
	private nextSample: number | null = null
	// Counter-run scan state (U8_IQ only); positions are buffer indices.
	private scanPos = 0
	private prevByte = -1
	private streakStart = 0
	private streakLen = 0
	private runStartSample: number | null = null

	constructor(opts: { format: IqFormat; fftSize: number; overlap?: 0 | 0.5 }) {
		const n = opts.fftSize
		if (!Number.isInteger(n) || n < 2 || n > 1 << 20 || (n & (n - 1)) !== 0) {
			throw new WaveKitError(
				`Frame size must be a power of two in 2..2^20, got ${n}`,
				"SCANNER_FRAME_CONFIG",
			)
		}
		this.format = opts.format
		this.bps = bytesPerSample(opts.format)
		this.fftSize = n
		this.frameBytes = n * this.bps
		this.hopSamples = opts.overlap === 0.5 ? n / 2 : n
		this.hopBytes = this.hopSamples * this.bps
		this.window = hannWindow(n)
		this.re = new Float32Array(n)
		this.im = new Float32Array(n)
	}

	/** The counter run currently being received, if any (samples so far). */
	get activeCounterRun(): { startSample: number; samples: number } | null {
		if (this.runStartSample === null) return null
		const scannedSamples = Math.floor((this.scanPos - this.head) / this.bps)
		return {
			startSample: this.runStartSample,
			samples: this.bufStartSample + scannedSamples - this.runStartSample,
		}
	}

	/** Queues a copy of `bytes`; `startSample` is the index of the sample containing bytes[0]. */
	push(startSample: number, bytes: Uint8Array): void {
		if (!Number.isSafeInteger(startSample) || startSample < 0) {
			throw new WaveKitError(
				`Invalid start sample ${startSample}`,
				"SCANNER_FRAME_INPUT",
			)
		}
		if (bytes.length > 0)
			this.queue.push({ kind: "bytes", startSample, bytes: bytes.slice() })
	}

	/** Queues a gap of `samples` samples starting at `startSample` (a seam, § 4.1). */
	gap(startSample: number, samples: number): void {
		if (
			!Number.isSafeInteger(startSample) ||
			startSample < 0 ||
			!Number.isSafeInteger(samples) ||
			samples < 0
		) {
			throw new WaveKitError(
				`Invalid gap ${startSample}+${samples}`,
				"SCANNER_FRAME_INPUT",
			)
		}
		this.queue.push({ kind: "gap", startSample, samples })
	}

	/** Processes everything queued, in order. */
	drain(
		onFrame: (frame: Frame) => void,
		onCounterRun: (run: CounterRun) => void,
	): void {
		for (const item of this.queue.splice(0)) {
			if (item.kind === "gap") {
				this.seam(this.nextSample ?? item.startSample, onFrame, onCounterRun)
				this.nextSample = item.startSample + item.samples
				this.bufStartSample = this.nextSample
				continue
			}
			if (this.nextSample !== null && item.startSample !== this.nextSample) {
				this.seam(this.nextSample, onFrame, onCounterRun)
			}
			if (this.tail === this.head) this.bufStartSample = item.startSample
			this.append(item.bytes)
			this.nextSample =
				this.bufStartSample + Math.floor((this.tail - this.head) / this.bps)
			this.process(onFrame, onCounterRun)
		}
		this.compact()
	}

	private process(
		onFrame: (frame: Frame) => void,
		onCounterRun: (run: CounterRun) => void,
	): void {
		const u8 = this.format === "U8_IQ"
		for (;;) {
			const result: ScanResult = u8 ? this.scan() : "end"
			if (this.runStartSample === null || result === "run-start") {
				// A frame is safe once no streak that started inside it can still grow into a run.
				this.emitFrames(u8 ? this.streakStart : this.tail, onFrame)
			}
			if (result === "run-start") {
				const runStartRel = Math.floor(
					(this.streakStart - this.head) / this.bps,
				)
				this.runStartSample = this.bufStartSample + runStartRel
				this.dropSamples(runStartRel)
				continue
			}
			if (result === "run-end") {
				const endRel = Math.ceil((this.scanPos - this.head) / this.bps)
				onCounterRun({
					startSample: this.runStartSample!,
					endSample: this.bufStartSample + endRel,
				})
				this.runStartSample = null
				this.dropSamples(endRel)
				this.resetScan()
				continue
			}
			if (this.runStartSample !== null) {
				// Release counter bytes as they are scanned; a stuck test mode must not grow the buffer.
				this.dropSamples(Math.floor((this.scanPos - this.head) / this.bps))
			}
			return
		}
	}

	private scan(): ScanResult {
		const b = this.buf
		for (; this.scanPos < this.tail; this.scanPos++) {
			const v = b[this.scanPos]!
			const increments = this.prevByte >= 0 && v === ((this.prevByte + 1) & 255)
			if (this.runStartSample !== null) {
				if (!increments) return "run-end"
				this.prevByte = v
				continue
			}
			if (increments) {
				this.streakLen++
			} else {
				this.streakLen = 1
				this.streakStart = this.scanPos
			}
			this.prevByte = v
			if (this.streakLen >= MIN_COUNTER_RUN_BYTES) {
				this.scanPos++
				return "run-start"
			}
		}
		return "end"
	}

	private emitFrames(limit: number, onFrame: (frame: Frame) => void): void {
		while (limit - this.head >= this.frameBytes) {
			const clipped = this.convert(this.head)
			onFrame({
				startSample: this.bufStartSample,
				re: this.re,
				im: this.im,
				clipped,
			})
			this.head += this.hopBytes
			this.bufStartSample += this.hopSamples
		}
	}

	private convert(at: number): number {
		const n = this.fftSize
		const w = this.window
		const re = this.re
		const im = this.im
		let clipped = 0
		if (this.format === "U8_IQ") {
			const b = this.buf
			for (let i = 0; i < n; i++) {
				const iv = b[at + 2 * i]!
				const qv = b[at + 2 * i + 1]!
				if (iv === 0 || iv === 255 || qv === 0 || qv === 255) clipped++
				re[i] = (iv / 127.5 - 1) * w[i]!
				im[i] = (qv / 127.5 - 1) * w[i]!
			}
		} else if (this.format === "S16_IQ") {
			const v = this.view
			for (let i = 0; i < n; i++) {
				const iv = v.getInt16(at + 4 * i, true)
				const qv = v.getInt16(at + 4 * i + 2, true)
				if (iv >= 32767 || iv <= -32767 || qv >= 32767 || qv <= -32767)
					clipped++
				re[i] = (iv / 32768) * w[i]!
				im[i] = (qv / 32768) * w[i]!
			}
		} else {
			const v = this.view
			for (let i = 0; i < n; i++) {
				const iv = v.getFloat32(at + 8 * i, true)
				const qv = v.getFloat32(at + 8 * i + 4, true)
				if (Math.abs(iv) >= 1 || Math.abs(qv) >= 1) clipped++
				re[i] = iv * w[i]!
				im[i] = qv * w[i]!
			}
		}
		return clipped
	}

	/**
	 * A seam ends every streak: emits the whole frames held back for a possible
	 * run, or ends the run at `endSample`; then discards the partial frame and
	 * partial sample and restarts the scan.
	 */
	private seam(
		endSample: number,
		onFrame: (frame: Frame) => void,
		onCounterRun: (run: CounterRun) => void,
	): void {
		if (this.runStartSample !== null) {
			onCounterRun({ startSample: this.runStartSample, endSample })
			this.runStartSample = null
		} else {
			this.emitFrames(this.tail, onFrame)
		}
		this.head = 0
		this.tail = 0
		this.resetScan()
	}

	private resetScan(): void {
		this.scanPos = this.head
		this.prevByte = -1
		this.streakStart = this.head
		this.streakLen = 0
	}

	private dropSamples(samples: number): void {
		this.head += samples * this.bps
		this.bufStartSample += samples
	}

	private append(bytes: Uint8Array): void {
		if (this.tail + bytes.length > this.buf.length) {
			this.compact()
			if (this.tail + bytes.length > this.buf.length) {
				const grown = new Uint8Array(
					Math.max(
						this.buf.length * 2,
						this.tail + bytes.length,
						this.frameBytes * 2,
					),
				)
				grown.set(this.buf.subarray(0, this.tail))
				this.buf = grown
				this.view = new DataView(grown.buffer)
			}
		}
		this.buf.set(bytes, this.tail)
		this.tail += bytes.length
	}

	/** Moves buf[head, tail) to the front. */
	private compact(): void {
		if (this.head === 0) return
		const shift = this.head
		this.buf.copyWithin(0, shift, this.tail)
		this.tail -= shift
		this.head = 0
		this.scanPos -= shift
		this.streakStart -= shift
	}
}
