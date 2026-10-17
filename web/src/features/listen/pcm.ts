// Low-latency live audio, the pure parts: raw PCM bytes to Float32 samples, and the jitter ring the
// AudioWorklet plays from (prime to a target, drop to catch up, silence on underrun, linear resampling).
// Shared by the worklet (pcm-worklet.ts) and the main-thread player (pcm-player.ts); no DOM.

export type PcmFormat = "s16le" | "f32le"

/** The X-Audio-Format header, else null. */
export function parsePcmFormat(
	raw: string | null | undefined,
): PcmFormat | null {
	const v = raw?.trim().toLowerCase()
	return v === "s16le" || v === "f32le" ? v : null
}

/** A positive integer header value (X-Sample-Rate, X-Channels), else null. */
export function parsePositiveInt(
	raw: string | null | undefined,
): number | null {
	if (raw === null || raw === undefined || raw.trim() === "") return null
	const v = Number(raw)
	return Number.isInteger(v) && v > 0 ? v : null
}

/**
 * A positive sample rate header. The core sends the effective rate unrounded
 * (`X-Sample-Rate: 24975.60975609756` for 2.048 MS/s ÷ 82), so fractions are kept.
 */
export function parsePositiveRate(
	raw: string | null | undefined,
): number | null {
	if (raw === null || raw === undefined || raw.trim() === "") return null
	const v = Number(raw)
	return Number.isFinite(v) && v > 0 ? v : null
}

/**
 * Turns a byte stream into mono Float32 samples. Chunks may split a sample (or a frame of several
 * channels): the remainder is carried into the next push. Channels are averaged to mono.
 */
export class PcmDecoder {
	readonly format: PcmFormat
	readonly channels: number
	private carry = new Uint8Array(0)

	constructor(format: PcmFormat, channels = 1) {
		this.format = format
		this.channels = Math.max(1, Math.floor(channels))
	}

	get frameBytes(): number {
		return (this.format === "s16le" ? 2 : 4) * this.channels
	}

	push(chunk: Uint8Array): Float32Array {
		let bytes = chunk
		if (this.carry.length > 0) {
			bytes = new Uint8Array(this.carry.length + chunk.length)
			bytes.set(this.carry, 0)
			bytes.set(chunk, this.carry.length)
		}
		const frame = this.frameBytes
		const frames = Math.floor(bytes.length / frame)
		const used = frames * frame
		this.carry = bytes.slice(used)
		const out = new Float32Array(frames)
		const view = new DataView(bytes.buffer, bytes.byteOffset, used)
		const ch = this.channels
		if (this.format === "s16le") {
			for (let i = 0; i < frames; i++) {
				let sum = 0
				for (let c = 0; c < ch; c++)
					sum += view.getInt16((i * ch + c) * 2, true)
				out[i] = sum / ch / 32768
			}
		} else {
			for (let i = 0; i < frames; i++) {
				let sum = 0
				for (let c = 0; c < ch; c++)
					sum += view.getFloat32((i * ch + c) * 4, true)
				const v = sum / ch
				out[i] = Number.isFinite(v) ? v : 0
			}
		}
		return out
	}
}

export interface RingOptions {
	/** Stream sample rate in Hz. */
	rate: number
	/** Buffer to build before playing (and after an underrun). */
	targetMs?: number
	/** Above this much buffered audio, the oldest is dropped back to the target. */
	maxMs?: number
}

export const RING_TARGET_MS = 200
export const RING_MAX_MS = 500

export interface RingStats {
	playing: boolean
	bufferedMs: number
	underruns: number
	droppedSamples: number
}

/**
 * The jitter buffer the worklet renders from. Indices are absolute sample counts (read ≤ write);
 * storage wraps. Rendering resamples linearly: `step` stream samples per output sample.
 */
export class PcmRing {
	private rate: number
	private targetMs: number
	private maxMs: number
	private buf: Float32Array
	private readIdx = 0
	private writeIdx = 0
	private frac = 0
	private primed = false
	underruns = 0
	droppedSamples = 0

	constructor(options: RingOptions) {
		this.rate = Math.max(1, options.rate)
		this.targetMs = options.targetMs ?? RING_TARGET_MS
		this.maxMs = options.maxMs ?? RING_MAX_MS
		this.buf = new Float32Array(this.capacityFor(this.rate))
	}

	get sampleRate(): number {
		return this.rate
	}

	get buffered(): number {
		return this.writeIdx - this.readIdx
	}

	get bufferedMs(): number {
		return (this.buffered / this.rate) * 1000
	}

	get playing(): boolean {
		return this.primed
	}

	private get target(): number {
		return Math.max(1, Math.round((this.targetMs / 1000) * this.rate))
	}

	private get max(): number {
		return Math.max(
			this.target + 1,
			Math.round((this.maxMs / 1000) * this.rate),
		)
	}

	private capacityFor(rate: number): number {
		// room for the max plus a burst: drops happen on push, so a push may overshoot briefly
		return Math.max(1024, Math.ceil(((this.maxMs * 2) / 1000) * rate))
	}

	/** A new stream rate: empties the buffer and primes again. */
	setRate(rate: number): void {
		const r = Math.max(1, rate)
		if (r !== this.rate) {
			this.rate = r
			this.buf = new Float32Array(this.capacityFor(r))
		}
		this.reset()
	}

	reset(): void {
		this.readIdx = 0
		this.writeIdx = 0
		this.frac = 0
		this.primed = false
	}

	push(samples: Float32Array): void {
		const cap = this.buf.length
		let src = samples
		if (src.length > cap) {
			// only the newest `cap` samples can be kept; everything buffered before them goes too
			this.droppedSamples += this.buffered + src.length - cap
			this.writeIdx += src.length - cap
			this.readIdx = this.writeIdx
			this.frac = 0
			src = src.subarray(src.length - cap)
		}
		const start = this.writeIdx % cap
		const first = Math.min(src.length, cap - start)
		this.buf.set(src.subarray(0, first), start)
		if (first < src.length) this.buf.set(src.subarray(first), 0)
		this.writeIdx += src.length
		if (this.buffered > this.max) {
			// latency beats completeness: skip to the newest audio, keeping the target
			const keep = this.target
			this.droppedSamples += this.buffered - keep
			this.readIdx = this.writeIdx - keep
			this.frac = 0
		}
	}

	/**
	 * Fills `out`. Silence while priming or after an underrun (which primes again).
	 * Returns true when any of `out` came from the stream.
	 */
	render(out: Float32Array, step = 1): boolean {
		if (!this.primed) {
			if (this.buffered < this.target) {
				out.fill(0)
				return false
			}
			this.primed = true
		}
		const cap = this.buf.length
		const buf = this.buf
		for (let i = 0; i < out.length; i++) {
			if (this.readIdx + 1 >= this.writeIdx) {
				out.fill(0, i)
				this.primed = false
				this.underruns += 1
				return i > 0
			}
			const a = buf[this.readIdx % cap] ?? 0
			const b = buf[(this.readIdx + 1) % cap] ?? 0
			out[i] = a + (b - a) * this.frac
			this.frac += step
			const whole = Math.floor(this.frac)
			this.readIdx += whole
			this.frac -= whole
		}
		return true
	}

	stats(): RingStats {
		return {
			playing: this.primed,
			bufferedMs: this.bufferedMs,
			underruns: this.underruns,
			droppedSamples: this.droppedSamples,
		}
	}
}

/** Main thread → worklet. */
export type ToWorklet =
	| { type: "format"; rate: number }
	| { type: "pcm"; samples: Float32Array }
	| { type: "reset" }

/** Worklet → main thread: on every playing change, and a few times a second while playing. */
export type FromWorklet = { type: "stats" } & RingStats

export const WORKLET_NAME = "wavekit-pcm"

/** Stats cadence while playing (and on every playing change), seconds. */
export const STATS_EVERY_S = 0.25
