/**
 * Seeded synthetic FM channel IQ for squelch tests (test-only; every sample is
 * computed here, no fixture files).
 *
 * Exports:
 * - `channelNoiseVariance(cnrDb, sampleRate, bandwidthHz): number`
 *   Complex white-noise variance (E|w|², before the channel filter) giving a
 *   carrier of amplitude 1 the carrier-to-noise ratio `cnrDb` measured in
 *   `bandwidthHz`: σ² = rate / (bandwidth · 10^(cnrDb/10)).
 * - `channelFilterTaps(sampleRate, bandwidthHz, taps = 31): Float64Array`
 *   Hamming windowed-sinc low-pass at the live demodulator's channel cutoff
 *   (`channelFilterPlan`, mode "channel"), unity DC gain.
 * - `randomOffsetHz(rand): number`  uniform in ±1000 Hz.
 * - `carrierWindows(windowsMs: [startMs, endMs][], sampleRate): (n) => boolean`
 *   On/off envelope by sample index (carrier on in [start, end)).
 * - `class SpeechLikeSource(sampleRate, rand)` `.next(): number` in [-1, 1]:
 *   three drifting "formant" tones (300–3000 Hz) under a 3–6 Hz syllabic
 *   envelope with pauses.
 * - `class FmChannelSynth(options: FmChannelOptions)`
 *   `.blockSamples`, `.sampleIndex`, `.next(): Buffer` fills and returns a
 *   REUSED buffer of one block (default 10 ms) of complex float32 LE
 *   interleaved IQ (I, Q per sample); copy it (`Buffer.from`) to keep it.
 *   `.render(blocks): Buffer[]` returns copies. Carrier: amplitude 1, FM of the
 *   audio (`audio`: "speech" | "silence") at `deviationHz`, plus an optional
 *   CTCSS sub-tone (`ctcssHz`, `ctcssDeviationHz`), at `offsetHz` with initial
 *   `phase`; gated by `carrier(n)`. Noise: complex Gaussian at `cnrDb`
 *   (null = none) through `channelFilterTaps(…, noiseTaps)`.
 * - `class FastChannelNoise(sampleRate, bandwidthHz, seed, taps = 15)`
 *   `.fill(out: Float32Array, samples = out.length / 2): Float32Array`
 *   Fast unit-variance complex Gaussian noise through `channelFilterTaps`
 *   (Gaussian table lookup, interleaved I/Q), for long runs (≥ 10 min).
 * - `mulberry32` re-exported from ./audio-tones/synth.js.
 */

import { channelFilterPlan } from "../../../src/decoders/csdr-stages.js"
import { mulberry32 } from "./audio-tones/synth.js"

export { mulberry32 }

export function channelNoiseVariance(
	cnrDb: number,
	sampleRate: number,
	bandwidthHz: number,
): number {
	return sampleRate / (bandwidthHz * 10 ** (cnrDb / 10))
}

export function channelFilterTaps(
	sampleRate: number,
	bandwidthHz: number,
	taps = 31,
): Float64Array {
	const cutoff = channelFilterPlan(sampleRate, 1, bandwidthHz, "channel").cutoff
	const h = new Float64Array(taps)
	const mid = (taps - 1) / 2
	let sum = 0
	for (let k = 0; k < taps; k++) {
		const x = k - mid
		const sinc =
			x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
		const w =
			taps > 1 ? 0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (taps - 1)) : 1
		h[k] = sinc * w
		sum += sinc * w
	}
	for (let k = 0; k < taps; k++) h[k] = (h[k] ?? 0) / sum
	return h
}

export function randomOffsetHz(rand: () => number): number {
	return (rand() * 2 - 1) * 1000
}

export function carrierWindows(
	windowsMs: readonly (readonly [number, number])[],
	sampleRate: number,
): (n: number) => boolean {
	const ranges = windowsMs.map(
		([start, end]) =>
			[(start * sampleRate) / 1000, (end * sampleRate) / 1000] as const,
	)
	return n => ranges.some(([start, end]) => n >= start && n < end)
}

export class SpeechLikeSource {
	private readonly rate: number
	private readonly rand: () => number
	private readonly freq = [500, 1500, 2500]
	private readonly phase = [0, 0, 0]
	private readonly gain = [0.5, 0.3, 0.2]
	private envPhase = 0
	private envRate = 4
	private n = 0

	constructor(sampleRate: number, rand: () => number) {
		this.rate = sampleRate
		this.rand = rand
	}

	next(): number {
		// Re-draw formants and syllable rate every 20 ms.
		if (this.n % Math.max(1, Math.round(this.rate / 50)) === 0) {
			for (let k = 0; k < 3; k++) {
				const f = (this.freq[k] ?? 1000) * (1 + (this.rand() - 0.5) * 0.2)
				this.freq[k] = Math.min(3000, Math.max(300, f))
			}
			this.envRate = 3 + this.rand() * 3
		}
		this.n++
		let value = 0
		for (let k = 0; k < 3; k++) {
			const p =
				(this.phase[k] ?? 0) + (2 * Math.PI * (this.freq[k] ?? 0)) / this.rate
			this.phase[k] = p > Math.PI ? p - 2 * Math.PI : p
			value += (this.gain[k] ?? 0) * Math.sin(p)
		}
		this.envPhase += (2 * Math.PI * this.envRate) / this.rate
		if (this.envPhase > 2 * Math.PI) this.envPhase -= 2 * Math.PI
		const env = Math.max(0, Math.sin(this.envPhase))
		return value * env
	}
}

export interface FmChannelOptions {
	sampleRate: number
	bandwidthHz: number
	seed: number
	/** Carrier-to-noise ratio in the channel bandwidth; null = no noise. */
	cnrDb: number | null
	/** Peak deviation of the audio in Hz (default 2500). */
	deviationHz?: number
	/** Carrier offset in Hz (default: random in ±1000 from the seed). */
	offsetHz?: number
	/** Initial carrier phase in rad (default: random from the seed). */
	phase?: number
	audio?: "speech" | "silence"
	/** CTCSS sub-tone in Hz (default none). */
	ctcssHz?: number | null
	/** CTCSS deviation in Hz (default 300). */
	ctcssDeviationHz?: number
	/** Carrier envelope by sample index (default: always on). */
	carrier?: (n: number) => boolean
	/** Channel noise filter length (default 31). */
	noiseTaps?: number
	/** Block length in ms (default 10). */
	blockMs?: number
}

export class FmChannelSynth {
	readonly blockSamples: number
	readonly offsetHz: number
	sampleIndex = 0
	private readonly block: Buffer
	private readonly rate: number
	private readonly rand: () => number
	private readonly speech: SpeechLikeSource | null
	private readonly deviation: number
	private readonly ctcssHz: number | null
	private readonly ctcssDeviation: number
	private readonly carrier: ((n: number) => boolean) | null
	private readonly sigma: number
	private readonly taps: Float64Array
	private readonly ringI: Float64Array
	private readonly ringQ: Float64Array
	private ringPos = 0
	private carrierPhase: number
	private ctcssPhase = 0

	constructor(options: FmChannelOptions) {
		this.rate = options.sampleRate
		this.rand = mulberry32(options.seed)
		this.blockSamples = Math.max(
			1,
			Math.round((options.sampleRate * (options.blockMs ?? 10)) / 1000),
		)
		this.block = Buffer.alloc(this.blockSamples * 8)
		this.offsetHz = options.offsetHz ?? randomOffsetHz(this.rand)
		this.carrierPhase = options.phase ?? this.rand() * 2 * Math.PI
		this.speech =
			(options.audio ?? "speech") === "speech"
				? new SpeechLikeSource(options.sampleRate, this.rand)
				: null
		this.deviation = options.deviationHz ?? 2500
		this.ctcssHz = options.ctcssHz ?? null
		this.ctcssDeviation = options.ctcssDeviationHz ?? 300
		this.carrier = options.carrier ?? null
		this.sigma =
			options.cnrDb === null
				? 0
				: Math.sqrt(
						channelNoiseVariance(
							options.cnrDb,
							options.sampleRate,
							options.bandwidthHz,
						) / 2,
					)
		this.taps = channelFilterTaps(
			options.sampleRate,
			options.bandwidthHz,
			options.noiseTaps ?? 31,
		)
		this.ringI = new Float64Array(this.taps.length * 2)
		this.ringQ = new Float64Array(this.taps.length * 2)
	}

	next(): Buffer {
		const len = this.taps.length
		const taps = this.taps
		const ringI = this.ringI
		const ringQ = this.ringQ
		for (let s = 0; s < this.blockSamples; s++) {
			const n = this.sampleIndex++
			let i = 0
			let q = 0
			const audio = this.speech ? this.speech.next() : 0
			let freq = this.offsetHz + this.deviation * audio
			if (this.ctcssHz !== null) {
				this.ctcssPhase += (2 * Math.PI * this.ctcssHz) / this.rate
				if (this.ctcssPhase > Math.PI) this.ctcssPhase -= 2 * Math.PI
				freq += this.ctcssDeviation * Math.sin(this.ctcssPhase)
			}
			this.carrierPhase += (2 * Math.PI * freq) / this.rate
			if (this.carrierPhase > Math.PI) this.carrierPhase -= 2 * Math.PI
			else if (this.carrierPhase < -Math.PI) this.carrierPhase += 2 * Math.PI
			if (this.carrier === null || this.carrier(n)) {
				i = Math.cos(this.carrierPhase)
				q = Math.sin(this.carrierPhase)
			}
			if (this.sigma > 0) {
				const r =
					this.sigma * Math.sqrt(-2 * Math.log(Math.max(this.rand(), 1e-300)))
				const a = 2 * Math.PI * this.rand()
				const pos = this.ringPos
				const wi = r * Math.cos(a)
				const wq = r * Math.sin(a)
				ringI[pos] = wi
				ringI[pos + len] = wi
				ringQ[pos] = wq
				ringQ[pos + len] = wq
				this.ringPos = pos + 1 === len ? 0 : pos + 1
				// Newest sample at pos; convolve over the last `len` samples.
				let fi = 0
				let fq = 0
				const base = pos + 1
				for (let k = 0; k < len; k++) {
					const h = taps[k] ?? 0
					fi += h * (ringI[base + k] ?? 0)
					fq += h * (ringQ[base + k] ?? 0)
				}
				i += fi
				q += fq
			}
			this.block.writeFloatLE(i, s * 8)
			this.block.writeFloatLE(q, s * 8 + 4)
		}
		return this.block
	}

	render(blocks: number): Buffer[] {
		const out: Buffer[] = []
		for (let b = 0; b < blocks; b++) out.push(Buffer.from(this.next()))
		return out
	}
}

const GAUSS_TABLE_BITS = 16
let gaussTable: Float64Array | null = null

/** 65536 fixed-seed standard normal values (Box-Muller), shared. */
function gaussianTable(): Float64Array {
	if (gaussTable) return gaussTable
	const size = 1 << GAUSS_TABLE_BITS
	const table = new Float64Array(size)
	const rand = mulberry32(0x9a055)
	for (let k = 0; k < size; k += 2) {
		const r = Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-300)))
		const a = 2 * Math.PI * rand()
		table[k] = r * Math.cos(a)
		table[k + 1] = r * Math.sin(a)
	}
	gaussTable = table
	return table
}

export class FastChannelNoise {
	private readonly taps: Float64Array
	private readonly ringI: Float64Array
	private readonly ringQ: Float64Array
	private readonly table: Float64Array
	private readonly scale: number
	private state: number
	private pos = 0

	constructor(
		sampleRate: number,
		bandwidthHz: number,
		seed: number,
		taps = 15,
	) {
		this.taps = channelFilterTaps(sampleRate, bandwidthHz, taps)
		this.ringI = new Float64Array(taps * 2)
		this.ringQ = new Float64Array(taps * 2)
		this.table = gaussianTable()
		this.scale = Math.SQRT1_2
		this.state = seed >>> 0
	}

	fill(out: Float32Array, samples = out.length >> 1): Float32Array {
		const len = this.taps.length
		const taps = this.taps
		const ringI = this.ringI
		const ringQ = this.ringQ
		const table = this.table
		const scale = this.scale
		let state = this.state
		let pos = this.pos
		for (let s = 0; s < samples; s++) {
			state = (state + 0x6d2b79f5) | 0
			let t = Math.imul(state ^ (state >>> 15), 1 | state)
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
			t = (t ^ (t >>> 14)) >>> 0
			const wi = (table[t & 0xffff] ?? 0) * scale
			const wq = (table[t >>> 16] ?? 0) * scale
			ringI[pos] = wi
			ringI[pos + len] = wi
			ringQ[pos] = wq
			ringQ[pos + len] = wq
			pos = pos + 1 === len ? 0 : pos + 1
			let fi = 0
			let fq = 0
			for (let k = 0; k < len; k++) {
				const h = taps[k] ?? 0
				fi += h * (ringI[pos + k] ?? 0)
				fq += h * (ringQ[pos + k] ?? 0)
			}
			out[2 * s] = fi
			out[2 * s + 1] = fq
		}
		this.state = state
		this.pos = pos
		return out
	}
}
