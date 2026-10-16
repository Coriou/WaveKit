/**
 * Noise Squelch - FM quieting squelch on channel IQ (WG7 req 2.2).
 *
 * Without a carrier the FM discriminator outputs broadband noise; a carrier
 * "quiets" it. This class measures the high-frequency part of the
 * discriminator output (above voice) per block and compares it with the
 * noise-only reference of the same chain.
 *
 * Metric per complex sample z[n]:
 *   d[n] = Im(z[n]·conj(z[n−1])) / max(|z[n]|·|z[n−1]|, ε)   (≈ sin Δφ, no atan2)
 * then a second-order (RBJ) high-pass at 0.6 × the channel's audio Nyquist
 * (0.3 × sample rate, Q = 1/√2), and the mean square of its output per block.
 *
 * Reference R(rate, bandwidth): the block mean square of the same chain on
 * unit complex Gaussian noise band-limited like the channel (the channel
 * filter of `channelFilterPlan`, mode "channel"). The metric is scale free
 * (d is normalised), so R only depends on the filter cutoff relative to the
 * rate. It is computed once per cutoff by a fixed-seed simulation of
 * REFERENCE_SAMPLES samples (a deterministic table entry, about 10 ms of CPU)
 * and cached for the process.
 *
 * Gate: quieting q = 10·log10(R / ms). Opens on a block with q ≥ quietingDb;
 * while open a block with q ≥ quietingDb − hysteresisDb refreshes the hang;
 * closes once `hangMs` of stream time (sample counts) passed since the last
 * such block. A block with a non-finite sample, or with fewer than half of its
 * samples usable (zero magnitude), has no quieting (closed side): NaN or
 * silent IQ never opens the gate.
 *
 * Hot path: no allocation and no closures per block; state is carried across
 * blocks (previous sample, high-pass state).
 */

import { WaveKitError } from "../utils/errors.js"
import { channelFilterPlan } from "../decoders/csdr-stages.js"

/** Inclusive range of the quieting threshold (mirrors LIVE_AUDIO_NOISE_QUIETING_DB). */
export const NOISE_QUIETING_DB_MIN = 1
export const NOISE_QUIETING_DB_MAX = 30
export const NOISE_QUIETING_DB_DEFAULT = 6

/** High-pass corner relative to the channel's audio Nyquist (rate / 2). */
export const NOISE_HIGH_PASS_NYQUIST_FRACTION = 0.6

export interface NoiseSquelchOptions {
	/** Channel IQ sample rate in Hz (complex samples per second). */
	sampleRate: number
	/** Channel bandwidth in Hz (as configured; drives the reference). */
	bandwidthHz: number
	/** Quieting threshold in dB (default 6, range 1–30). */
	quietingDb?: number
	/** Hang in ms (default 250). */
	hangMs?: number
	/** Hysteresis in dB (default 2). */
	hysteresisDb?: number
}

const BYTES_PER_COMPLEX_SAMPLE = 8
/** Floor of |z[n]|·|z[n−1]| below which a sample is not usable. */
const MAGNITUDE_EPSILON = 1e-20
const REFERENCE_SAMPLES = 65_536
const REFERENCE_WARMUP = 256
const REFERENCE_TAPS = 63
const REFERENCE_SEED = 0x5eed_2b07
const REFERENCE_CACHE_LIMIT = 64
const referenceCache = new Map<string, number>()
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

interface Biquad {
	b0: number
	b1: number
	b2: number
	a1: number
	a2: number
}

/** RBJ high-pass at `cornerFraction` × sample rate (normalised by a0). */
function highPassCoefficients(cornerFraction: number): Biquad {
	const w0 = 2 * Math.PI * cornerFraction
	const cos = Math.cos(w0)
	const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
	const a0 = 1 + alpha
	return {
		b0: (1 + cos) / 2 / a0,
		b1: -(1 + cos) / a0,
		b2: (1 + cos) / 2 / a0,
		a1: (-2 * cos) / a0,
		a2: (1 - alpha) / a0,
	}
}

const HIGH_PASS = highPassCoefficients(NOISE_HIGH_PASS_NYQUIST_FRACTION / 2)

/** Normalised (cycles per sample) cutoff of the channel filter at this rate. */
export function noiseReferenceCutoff(
	sampleRate: number,
	bandwidthHz: number,
): number {
	return channelFilterPlan(sampleRate, 1, bandwidthHz, "channel").cutoff
}

/**
 * Noise-only reference mean square R for a channel of this rate and
 * bandwidth (see the module comment). Cached per cutoff.
 */
export function noiseReferenceMeanSquare(
	sampleRate: number,
	bandwidthHz: number,
): number {
	const cutoff = noiseReferenceCutoff(sampleRate, bandwidthHz)
	const key = cutoff.toFixed(4)
	const cached = referenceCache.get(key)
	if (cached !== undefined) return cached
	const value = simulateReference(cutoff)
	if (referenceCache.size >= REFERENCE_CACHE_LIMIT) referenceCache.clear()
	referenceCache.set(key, value)
	return value
}

function simulateReference(cutoff: number): number {
	const taps = blackmanLowPass(cutoff, REFERENCE_TAPS)
	const total = REFERENCE_SAMPLES + REFERENCE_TAPS
	const wi = new Float64Array(total)
	const wq = new Float64Array(total)
	let state = REFERENCE_SEED >>> 0
	const rand = (): number => {
		state = (state + 0x6d2b79f5) | 0
		let t = Math.imul(state ^ (state >>> 15), 1 | state)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
	for (let n = 0; n < total; n++) {
		const r = Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-300)))
		const a = 2 * Math.PI * rand()
		wi[n] = r * Math.cos(a)
		wq[n] = r * Math.sin(a)
	}
	const chain = new DiscriminatorChain()
	let sum = 0
	let count = 0
	for (let n = 0; n < REFERENCE_SAMPLES; n++) {
		let i = 0
		let q = 0
		for (let k = 0; k < REFERENCE_TAPS; k++) {
			const h = taps[k] ?? 0
			i += h * (wi[n + k] ?? 0)
			q += h * (wq[n + k] ?? 0)
		}
		const y = chain.step(i, q)
		if (n >= REFERENCE_WARMUP) {
			sum += y * y
			count++
		}
	}
	return sum / count
}

/** Windowed-sinc (Blackman) low-pass, unity DC gain. */
function blackmanLowPass(cutoff: number, length: number): Float64Array {
	const taps = new Float64Array(length)
	const mid = (length - 1) / 2
	let sum = 0
	for (let k = 0; k < length; k++) {
		const x = k - mid
		const sinc =
			x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
		const w =
			0.42 -
			0.5 * Math.cos((2 * Math.PI * k) / (length - 1)) +
			0.08 * Math.cos((4 * Math.PI * k) / (length - 1))
		taps[k] = sinc * w
		sum += sinc * w
	}
	for (let k = 0; k < length; k++) taps[k] = (taps[k] ?? 0) / sum
	return taps
}

/** Discriminator + high-pass state (used for the reference only). */
class DiscriminatorChain {
	private pi = 0
	private pq = 0
	private pm = 0
	private x1 = 0
	private x2 = 0
	private y1 = 0
	private y2 = 0

	step(i: number, q: number): number {
		const m = Math.sqrt(i * i + q * q)
		const den = m * this.pm
		const d = den > MAGNITUDE_EPSILON ? (q * this.pi - i * this.pq) / den : 0
		this.pi = i
		this.pq = q
		this.pm = m
		const h = HIGH_PASS
		const y =
			h.b0 * d +
			h.b1 * this.x1 +
			h.b2 * this.x2 -
			h.a1 * this.y1 -
			h.a2 * this.y2
		this.x2 = this.x1
		this.x1 = d
		this.y2 = this.y1
		this.y1 = y
		return y
	}
}

/** Throws unless `db` is a finite quieting threshold in range. */
export function validateNoiseQuietingDb(db: number): number {
	if (
		typeof db !== "number" ||
		!Number.isFinite(db) ||
		db < NOISE_QUIETING_DB_MIN ||
		db > NOISE_QUIETING_DB_MAX
	) {
		throw new WaveKitError(
			`noiseQuietingDb must be between ${NOISE_QUIETING_DB_MIN} and ${NOISE_QUIETING_DB_MAX} dB`,
			"NOISE_QUIETING_OUT_OF_RANGE",
		)
	}
	return db
}

export class NoiseSquelch {
	/** Noise-only reference mean square R of this channel. */
	readonly referenceMeanSquare: number
	readonly sampleRate: number
	private readonly hangMs: number
	private readonly hysteresisDb: number
	private readonly b0 = HIGH_PASS.b0
	private readonly b1 = HIGH_PASS.b1
	private readonly b2 = HIGH_PASS.b2
	private readonly a1 = HIGH_PASS.a1
	private readonly a2 = HIGH_PASS.a2
	private threshold: number
	private gateOpen = false
	private streamMs = 0
	private lastAboveMs = Number.NEGATIVE_INFINITY
	private lastQuieting: number | null = null
	private lastMeanSquare: number | null = null
	private pi = 0
	private pq = 0
	private pm = 0
	private x1 = 0
	private x2 = 0
	private y1 = 0
	private y2 = 0
	/**
	 * Every block is copied, in tiles, into this scratch (one 10 ms block,
	 * allocated at construction and never replaced), so neither a fresh
	 * process buffer nor a longer block costs an allocation.
	 */
	private readonly scratch: Float32Array
	private readonly scratchBytes: Buffer

	constructor(options: NoiseSquelchOptions) {
		if (!(options.sampleRate > 0) || !Number.isFinite(options.sampleRate)) {
			throw new WaveKitError(
				"NoiseSquelch sampleRate must be a positive number",
				"NOISE_SQUELCH_INVALID_RATE",
			)
		}
		this.sampleRate = options.sampleRate
		this.scratch = new Float32Array(
			Math.max(1, Math.round(options.sampleRate * 0.01)) * 2,
		)
		this.scratchBytes = Buffer.from(this.scratch.buffer)
		this.threshold = validateNoiseQuietingDb(
			options.quietingDb ?? NOISE_QUIETING_DB_DEFAULT,
		)
		this.hangMs = options.hangMs ?? 250
		this.hysteresisDb = options.hysteresisDb ?? 2
		const bandwidth =
			Number.isFinite(options.bandwidthHz) && options.bandwidthHz > 0
				? options.bandwidthHz
				: options.sampleRate / 2
		this.referenceMeanSquare = noiseReferenceMeanSquare(
			options.sampleRate,
			bandwidth,
		)
	}

	get open(): boolean {
		return this.gateOpen
	}

	get quietingDb(): number {
		return this.threshold
	}

	/** Quieting of the last block in dB, or null (no block yet, or unusable). */
	get lastQuietingDb(): number | null {
		return this.lastQuieting
	}

	/** High-passed discriminator mean square of the last block, or null. */
	get lastBlockMeanSquare(): number | null {
		return this.lastMeanSquare
	}

	/** Changes the threshold (validated, 1–30 dB) without resetting timing. */
	setQuietingDb(db: number): void {
		this.threshold = validateNoiseQuietingDb(db)
	}

	/** Closes the gate and clears the discriminator and filter state. */
	reset(): void {
		this.gateOpen = false
		this.lastAboveMs = Number.NEGATIVE_INFINITY
		this.lastQuieting = null
		this.lastMeanSquare = null
		this.pi = 0
		this.pq = 0
		this.pm = 0
		this.x1 = 0
		this.x2 = 0
		this.y1 = 0
		this.y2 = 0
	}

	/**
	 * Measures one block of complex float32 LE IQ (`byteLength` from
	 * `byteOffset`, default the whole buffer) and updates the gate.
	 * Returns the gate state after the block.
	 */
	processBlock(
		block: Buffer,
		byteOffset = 0,
		byteLength = block.length - byteOffset,
	): boolean {
		const samples = Math.floor(byteLength / BYTES_PER_COMPLEX_SAMPLE)
		if (samples <= 0) return this.gateOpen
		const b0 = this.b0
		const b1 = this.b1
		const b2 = this.b2
		const a1 = this.a1
		const a2 = this.a2
		let pi = this.pi
		let pq = this.pq
		let pm = this.pm
		let x1 = this.x1
		let x2 = this.x2
		let y1 = this.y1
		let y2 = this.y2
		let sum = 0
		let usable = 0
		let finite = true
		// Fixed scratch tiles: filter state carries across them, one mean
		// square accumulates over the whole block, nothing is allocated.
		const view = this.scratch
		const tileSamples = view.length / 2
		for (let done = 0; done < samples; done += tileSamples) {
			const count = Math.min(tileSamples, samples - done)
			this.fillScratch(
				block,
				byteOffset + done * BYTES_PER_COMPLEX_SAMPLE,
				count,
			)
			const end = count * 2
			for (let k = 0; k < end; k += 2) {
				let i = view[k] ?? 0
				let q = view[k + 1] ?? 0
				if (!(Math.abs(i) < Infinity && Math.abs(q) < Infinity)) {
					finite = false
					i = 0
					q = 0
				}
				const m = Math.sqrt(i * i + q * q)
				const den = m * pm
				let d = 0
				if (den > MAGNITUDE_EPSILON) {
					d = (q * pi - i * pq) / den
					usable++
				}
				pi = i
				pq = q
				pm = m
				const y = b0 * d + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
				x2 = x1
				x1 = d
				y2 = y1
				y1 = y
				sum += y * y
			}
		}
		this.pi = pi
		this.pq = pq
		this.pm = pm
		this.x1 = x1
		this.x2 = x2
		this.y1 = y1
		this.y2 = y2
		this.streamMs += (samples / this.sampleRate) * 1000

		let quieting = Number.NEGATIVE_INFINITY
		if (finite && usable * 2 >= samples) {
			const ms = sum / usable
			this.lastMeanSquare = ms
			quieting =
				ms > 0
					? 10 * Math.log10(this.referenceMeanSquare / ms)
					: Number.POSITIVE_INFINITY
			this.lastQuieting = quieting
		} else {
			this.lastMeanSquare = null
			this.lastQuieting = null
		}

		if (quieting >= this.threshold) {
			this.gateOpen = true
			this.lastAboveMs = this.streamMs
		} else if (this.gateOpen) {
			if (quieting >= this.threshold - this.hysteresisDb) {
				this.lastAboveMs = this.streamMs
			} else if (this.streamMs - this.lastAboveMs >= this.hangMs) {
				this.gateOpen = false
			}
		}
		return this.gateOpen
	}

	/** Copies `samples` complex samples at `byteOffset` into the scratch tile. */
	private fillScratch(
		block: Buffer,
		byteOffset: number,
		samples: number,
	): void {
		if (LITTLE_ENDIAN) {
			block.copy(
				this.scratchBytes,
				0,
				byteOffset,
				byteOffset + samples * BYTES_PER_COMPLEX_SAMPLE,
			)
		} else {
			for (let k = 0; k < samples * 2; k++)
				this.scratch[k] = block.readFloatLE(byteOffset + k * 4)
		}
	}
}
