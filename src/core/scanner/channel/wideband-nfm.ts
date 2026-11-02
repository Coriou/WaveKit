/**
 * NFM audio straight from the scanner's wideband CU8. Stages (textbook building blocks only):
 * 1. NCO mix of the channel to DC and a second-order CIC-equivalent decimation by K, done as a
 *    triangular-weight sum-and-dump (two accumulators, no integrator that could drift),
 * 2. a Blackman windowed-sinc FIR decimating by M to r = fs / (K · M), 48 to 96 kHz,
 * 3. a ±8 kHz channel FIR at r and a linear resampler to exactly 48 kHz,
 * 4. the existing discriminator (`FmAudioDemod`, 48 kHz cf32 to 8 kHz s16, 750 µs de-emphasis),
 * 5. a 4th-order 300 Hz Butterworth high-pass (RBJ biquads) that removes a CTCSS sub-tone from
 *    the written audio. `toneAudio()` is the same audio low-passed at 300 Hz (4th order) for a
 *    CTCSS bank, so voice energy just above the sub-audible band does not swamp its band test.
 */
import { WaveKitError } from "../../../utils/errors.js"
import { ANALOG_AUDIO_RATE_HZ, FmAudioDemod } from "./fm-audio.js"

const DEMOD_RATE_HZ = 48_000
/** Half the 16 kHz OBW bound of the recorder's trigger: a 25 kHz NFM channel's Carson band. */
export const CHANNEL_CUTOFF_HZ = 8_000
/** At r = 48 to 96 kHz a 63-tap Blackman FIR has a 5.5 · r / 63 ≈ 4.2 to 8.4 kHz transition. */
const CHANNEL_TAPS = 63
/**
 * Stage-2 taps per decimation step: N = 10 · M + 1 at M · r, cutoff r / 2. A Blackman transition
 * of 5.5 · M · r / N ≈ 0.55 · r keeps [0, 0.22 · r] flat (10.7 kHz at 48 kHz) and stops from
 * 0.78 · r, before r − 8 kHz (0.83 · r at 48 kHz), so nothing folds into the ±8 kHz channel.
 */
const STAGE2_TAPS_PER_DECIMATION = 10
/** Stage-2 factors tried, smallest first (M = 2 only when nothing else divides). */
const STAGE2_FACTORS = [3, 4, 5, 6, 7, 8, 2] as const
export const HIGH_PASS_HZ = 300
/** 4th-order Butterworth as two biquads (Q of each pole pair: 1 / (2 cos(π/8)), 1 / (2 cos(3π/8))). */
export const BUTTERWORTH4_Q = [0.541_196_1, 1.306_563] as const
/** Largest CU8 slice one `process` call accepts (128 Ki IQ pairs, 128 ms at 1.024 Msps). */
export const MAX_SLICE_SAMPLES = 131_072
const U8_TO_FLOAT = Float32Array.from(
	{ length: 256 },
	(_, v) => (v - 127.5) / 127.5,
)
/** The NCO recurrence is renormalised this often (magnitude drift stays below 1e-12). */
const RENORM_EVERY = 4096

export interface DecimationFactors {
	/** CIC-equivalent factor (stage 1). */
	readonly k: number
	/** FIR factor (stage 2). */
	readonly m: number
	/** Intermediate rate fs / (k · m), at least 48 kHz. */
	readonly rateHz: number
}

/**
 * d = floor(fs / 48 kHz) keeps r ≥ 48 kHz (the resampler only steps down). A d with a stage-2
 * factor in STAGE2_FACTORS wins; otherwise (d prime) d − 1, until r would pass 96 kHz, and then
 * stage 2 alone (k = 1). The second-order CIC response |sin(π f k / fs) / (k sin(π f / fs))|²
 * at f = fs / k − 8 kHz bounds what folds into the ±8 kHz channel: −49 dB at 1.024 Msps
 * (k 7, m 3) and −58 dB at 2.4 Msps (k 10, m 5).
 */
export function chooseFactors(inputRateHz: number): DecimationFactors {
	const maxD = Math.floor(inputRateHz / DEMOD_RATE_HZ)
	if (maxD < 1)
		throw new WaveKitError(
			"Input rate below the 48 kHz demodulator rate",
			"SCANNER_AUDIO_OPTIONS",
		)
	for (let d = maxD; d >= 1 && inputRateHz / d < 2 * DEMOD_RATE_HZ; d--) {
		for (const m of STAGE2_FACTORS) {
			if (d % m !== 0) continue
			return { k: d / m, m, rateHz: inputRateHz / d }
		}
	}
	return { k: 1, m: maxD, rateHz: inputRateHz / maxD }
}

function blackmanSinc(taps: number, fc: number): Float32Array {
	const h = new Float64Array(taps)
	const mid = (taps - 1) / 2
	let sum = 0
	for (let k = 0; k < taps; k++) {
		const x = k - mid
		const sinc =
			x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)
		const w =
			taps === 1
				? 1
				: 0.42 -
					0.5 * Math.cos((2 * Math.PI * k) / (taps - 1)) +
					0.08 * Math.cos((4 * Math.PI * k) / (taps - 1))
		h[k] = sinc * w
		sum += h[k]!
	}
	const out = new Float32Array(taps)
	for (let k = 0; k < taps; k++) out[k] = h[k]! / sum
	return out
}

/** RBJ cookbook high- or low-pass biquad, direct form I, state kept across calls. */
export class Biquad {
	private readonly b0: number
	private readonly b1: number
	private readonly b2: number
	private readonly a1: number
	private readonly a2: number
	private x1 = 0
	private x2 = 0
	private y1 = 0
	private y2 = 0
	constructor(
		kind: "high" | "low",
		cutoffHz: number,
		rateHz: number,
		q: number,
	) {
		const w0 = (2 * Math.PI * cutoffHz) / rateHz
		const cos = Math.cos(w0)
		const alpha = Math.sin(w0) / (2 * q)
		const a0 = 1 + alpha
		const edge = kind === "high" ? (1 + cos) / 2 : (1 - cos) / 2
		this.b0 = edge / a0
		this.b1 = ((kind === "high" ? -2 : 2) * edge) / a0
		this.b2 = edge / a0
		this.a1 = (-2 * cos) / a0
		this.a2 = (1 - alpha) / a0
	}
	step(x: number): number {
		const y =
			this.b0 * x +
			this.b1 * this.x1 +
			this.b2 * this.x2 -
			this.a1 * this.y1 -
			this.a2 * this.y2
		this.x2 = this.x1
		this.x1 = x
		this.y2 = this.y1
		this.y1 = y
		return y
	}
}

function butterworth4(kind: "high" | "low"): readonly Biquad[] {
	return BUTTERWORTH4_Q.map(
		q => new Biquad(kind, HIGH_PASS_HZ, ANALOG_AUDIO_RATE_HZ, q),
	)
}

/** A complex FIR with its delay line; `step` returns nothing, the result is in `re`/`im`. */
class ComplexFir {
	re = 0
	im = 0
	private readonly hre: Float32Array
	private readonly him: Float32Array
	private head = 0
	constructor(private readonly taps: Float32Array) {
		this.hre = new Float32Array(taps.length)
		this.him = new Float32Array(taps.length)
	}
	push(xr: number, xi: number): void {
		this.hre[this.head] = xr
		this.him[this.head] = xi
		this.head = this.head + 1 === this.taps.length ? 0 : this.head + 1
	}
	/** The filter output for the newest pushed sample (two linear runs, no per-tap wrap test). */
	compute(): void {
		const taps = this.taps
		const len = taps.length
		const hre = this.hre
		const him = this.him
		const newest = this.head === 0 ? len - 1 : this.head - 1
		let yr = 0
		let yi = 0
		let k = 0
		for (let idx = newest; idx >= 0; idx--, k++) {
			yr += taps[k]! * hre[idx]!
			yi += taps[k]! * him[idx]!
		}
		for (let idx = len - 1; k < len; idx--, k++) {
			yr += taps[k]! * hre[idx]!
			yi += taps[k]! * him[idx]!
		}
		this.re = yr
		this.im = yi
	}
}

export interface WidebandNfmOptions {
	inputRateHz: number
	/** Channel centre minus capture centre. */
	offsetHz: number
	/** Default true. */
	highPass?: boolean
}

/**
 * Whether the chain can run at `inputRateHz` with the channel `offsetHz` from the centre: a
 * finite rate of at least 48 kHz (the demodulation rate) and an offset inside ±rate/2. The
 * constructor throws otherwise; callers check first so nothing is reserved for an impossible
 * engine.
 */
export function widebandNfmSupported(
	inputRateHz: number,
	offsetHz: number,
): boolean {
	return (
		Number.isFinite(inputRateHz) &&
		inputRateHz >= DEMOD_RATE_HZ &&
		Number.isFinite(offsetHz) &&
		Math.abs(offsetHz) < inputRateHz / 2
	)
}

/** One streaming chain per recording; `process` is chunk-split invariant. */
export class WidebandNfmChain {
	readonly factors: DecimationFactors
	// Stage 1: NCO and triangular sum-and-dump.
	private phRe = 1
	private phIm = 0
	private readonly rotRe: number
	private readonly rotIm: number
	private sinceRenorm = 0
	private phase = 0
	private curRe = 0
	private curIm = 0
	private nxtRe = 0
	private nxtIm = 0
	private readonly cicScale: number
	// Stage 2 and the channel filter.
	private readonly stage2: ComplexFir
	private stage2Phase = 0
	private readonly channel: ComplexFir
	// Resampler to 48 kHz: position of the next output between prev (0) and the newest (1).
	private readonly step: number
	private frac = 0
	private prevRe = 0
	private prevIm = 0
	private readonly demod = new FmAudioDemod()
	private readonly hp: readonly Biquad[]
	private readonly toneLp = butterworth4("low")
	private tone = new Int16Array(0)
	private toneLength = 0
	private readonly demodIn: Float32Array

	constructor(opts: WidebandNfmOptions) {
		if (!widebandNfmSupported(opts.inputRateHz, opts.offsetHz))
			throw new WaveKitError(
				"Invalid wideband NFM options",
				"SCANNER_AUDIO_OPTIONS",
			)
		this.factors = chooseFactors(opts.inputRateHz)
		const { k, m, rateHz } = this.factors
		const w = (-2 * Math.PI * opts.offsetHz) / opts.inputRateHz
		this.rotRe = Math.cos(w)
		this.rotIm = Math.sin(w)
		this.cicScale = 1 / (k * k)
		this.stage2 = new ComplexFir(
			blackmanSinc(STAGE2_TAPS_PER_DECIMATION * m + 1, 0.5 / m),
		)
		this.channel = new ComplexFir(
			blackmanSinc(CHANNEL_TAPS, CHANNEL_CUTOFF_HZ / rateHz),
		)
		this.step = rateHz / DEMOD_RATE_HZ
		this.hp = opts.highPass === false ? [] : butterworth4("high")
		// r / 48 kHz ≥ 1, so the 48 kHz stream never outnumbers the r stream (+1 for a carry).
		this.demodIn = new Float32Array(
			2 * (Math.ceil(MAX_SLICE_SAMPLES / (k * m)) + 2),
		)
	}

	/** CU8 (whole IQ pairs, at most MAX_SLICE_SAMPLES) in, 8 kHz s16 out (after the high-pass). */
	process(cu8: Uint8Array): Int16Array {
		if (cu8.length % 2 !== 0 || cu8.length / 2 > MAX_SLICE_SAMPLES)
			throw new WaveKitError(
				"Invalid wideband NFM slice",
				"SCANNER_AUDIO_INPUT",
			)
		const k = this.factors.k
		const m = this.factors.m
		const lut = U8_TO_FLOAT
		const exact = this.step === 1
		const out = this.demodIn
		let o = 0
		let phRe = this.phRe
		let phIm = this.phIm
		let curRe = this.curRe
		let curIm = this.curIm
		let nxtRe = this.nxtRe
		let nxtIm = this.nxtIm
		let phase = this.phase
		const n = cu8.length >> 1
		for (let i = 0; i < n; i++) {
			const xr = lut[cu8[2 * i]!]!
			const xi = lut[cu8[2 * i + 1]!]!
			const mr = xr * phRe - xi * phIm
			const mi = xr * phIm + xi * phRe
			const nr = phRe * this.rotRe - phIm * this.rotIm
			phIm = phRe * this.rotIm + phIm * this.rotRe
			phRe = nr
			if (++this.sinceRenorm === RENORM_EVERY) {
				const mag = Math.hypot(phRe, phIm)
				phRe /= mag
				phIm /= mag
				this.sinceRenorm = 0
			}
			// Triangular weights: K − p into this block's output, p into the next one's.
			const wa = k - phase
			curRe += wa * mr
			curIm += wa * mi
			nxtRe += phase * mr
			nxtIm += phase * mi
			if (++phase < k) continue
			phase = 0
			const s1r = curRe * this.cicScale
			const s1i = curIm * this.cicScale
			curRe = nxtRe
			curIm = nxtIm
			nxtRe = 0
			nxtIm = 0
			this.stage2.push(s1r, s1i)
			if (++this.stage2Phase < m) continue
			this.stage2Phase = 0
			this.stage2.compute()
			this.channel.push(this.stage2.re, this.stage2.im)
			this.channel.compute()
			const yr = this.channel.re
			const yi = this.channel.im
			if (exact) {
				out[o++] = yr
				out[o++] = yi
				continue
			}
			while (this.frac < 1) {
				out[o++] = this.prevRe + (yr - this.prevRe) * this.frac
				out[o++] = this.prevIm + (yi - this.prevIm) * this.frac
				this.frac += this.step
			}
			this.frac -= 1
			this.prevRe = yr
			this.prevIm = yi
		}
		this.phRe = phRe
		this.phIm = phIm
		this.curRe = curRe
		this.curIm = curIm
		this.nxtRe = nxtRe
		this.nxtIm = nxtIm
		this.phase = phase
		const pcm = this.demod.process(out.subarray(0, o))
		if (this.tone.length < pcm.length) this.tone = new Int16Array(pcm.length)
		this.toneLength = pcm.length
		const tone = this.tone
		for (let i = 0; i < pcm.length; i++) {
			const x = pcm[i]!
			let t = x
			for (const stage of this.toneLp) t = stage.step(t)
			tone[i] = t > 32767 ? 32767 : t < -32768 ? -32768 : Math.round(t)
			if (this.hp.length === 0) continue
			let y = x
			for (const stage of this.hp) y = stage.step(y)
			pcm[i] = y > 32767 ? 32767 : y < -32768 ? -32768 : Math.round(y)
		}
		return pcm
	}

	/**
	 * Delay from the CU8 input to the 48 kHz demodulator input, in seconds: the triangle's
	 * k − 1 input samples, stage 2's 5 · m samples at fs / k and the channel FIR's 31 at r.
	 */
	groupDelaySeconds(inputRateHz: number): number {
		const { k, m, rateHz } = this.factors
		return (k - 1 + 5 * m * k) / inputRateHz + (CHANNEL_TAPS - 1) / 2 / rateHz
	}

	/** Tone-band audio of the last `process` call, frame for frame (reused: copy to keep). */
	toneAudio(): Int16Array {
		return this.tone.subarray(0, this.toneLength)
	}
}
