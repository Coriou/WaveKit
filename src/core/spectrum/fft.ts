/**
 * Radix-2 complex FFT (in place, forward, unscaled) plus the spectrum helpers
 * every scanner stage shares. Bin conventions (used by the floor, spur map,
 * detector, segmenter and tracker): power arrays are FFT-shifted, so index i is
 * baseband offset (i − N/2)·fs/N Hz and DC sits at N/2. Power is
 * tone-calibrated: a full-scale complex tone centred on a bin reads 0 dBFS
 * with the periodic Hann window (feasibility § 6: 2048-pt costs 6–8 % of one
 * Mac core at 2.048 Msps).
 */
import { WaveKitError } from "../../utils/errors.js"

/** Lowest power reported, dBFS (an all-zero block would be −∞). */
export const POWER_FLOOR_DB = -200

export class Fft {
	readonly size: number
	private readonly cos: Float64Array
	private readonly sin: Float64Array
	private readonly rev: Uint32Array

	constructor(size: number) {
		if (
			!Number.isInteger(size) ||
			size < 2 ||
			size > 1 << 20 ||
			(size & (size - 1)) !== 0
		) {
			throw new WaveKitError(
				`FFT size must be a power of two in 2..2^20, got ${size}`,
				"SCANNER_FFT_SIZE",
			)
		}
		this.size = size
		const half = size >> 1
		this.cos = new Float64Array(half)
		this.sin = new Float64Array(half)
		for (let k = 0; k < half; k++) {
			this.cos[k] = Math.cos((2 * Math.PI * k) / size)
			this.sin[k] = -Math.sin((2 * Math.PI * k) / size)
		}
		const bits = 31 - Math.clz32(size)
		this.rev = new Uint32Array(size)
		for (let i = 0; i < size; i++) {
			let r = 0
			for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b)
			this.rev[i] = r
		}
	}

	/** X[k] = Σ x[n]·e^{−j2πkn/N}, in place. */
	transform(re: Float32Array, im: Float32Array): void {
		const n = this.size
		if (re.length !== n || im.length !== n) {
			throw new WaveKitError(
				`FFT input length ${re.length}/${im.length} does not match size ${n}`,
				"SCANNER_FFT_SIZE",
			)
		}
		const rev = this.rev
		for (let i = 0; i < n; i++) {
			const j = rev[i]!
			if (j > i) {
				const tr = re[i]!
				re[i] = re[j]!
				re[j] = tr
				const ti = im[i]!
				im[i] = im[j]!
				im[j] = ti
			}
		}
		const cos = this.cos
		const sin = this.sin
		for (let len = 2; len <= n; len <<= 1) {
			const halfLen = len >> 1
			const step = n / len
			for (let start = 0; start < n; start += len) {
				for (let j = 0, k = 0; j < halfLen; j++, k += step) {
					const wr = cos[k]!
					const wi = sin[k]!
					const a = start + j
					const b = a + halfLen
					const br = re[b]!
					const bi = im[b]!
					const xr = br * wr - bi * wi
					const xi = br * wi + bi * wr
					const ar = re[a]!
					const ai = im[a]!
					re[b] = ar - xr
					im[b] = ai - xi
					re[a] = ar + xr
					im[a] = ai + xi
				}
			}
		}
	}
}

/** Periodic Hann window w[n] = 0.5 − 0.5·cos(2πn/N); Σw = N/2. */
export function hannWindow(n: number): Float32Array {
	const w = new Float32Array(n)
	for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
	return w
}

/** acc[shift(k)] += |X[k]|², with shift(k) = (k + N/2) mod N. */
export function accumulateShiftedPower(
	re: Float32Array,
	im: Float32Array,
	acc: Float64Array,
): void {
	const n = re.length
	const half = n >> 1
	for (let k = 0; k < n; k++) {
		const r = re[k]!
		const i = im[k]!
		const s = k < half ? k + half : k - half
		acc[s] = acc[s]! + r * r + i * i
	}
}

/**
 * out[i] = 10·log10(acc[i] / (frames·(N/2)²)), floored at POWER_FLOOR_DB:
 * the mean Hann-windowed bin power, tone-calibrated. White noise of total
 * power P reads P·1.5/N per bin (Hann ENBW 1.5 bins).
 */
export function powerToDb(
	acc: Float64Array,
	frames: number,
	out: Float32Array,
): void {
	const n = acc.length
	const scale = powerScale(n, frames)
	// inline, not binPowerDb: the bundled worker did not inline the call and the pass cost twice as much
	for (let i = 0; i < n; i++) {
		const p = acc[i]! * scale
		out[i] =
			p > 0 ? Math.max(POWER_FLOOR_DB, 10 * Math.log10(p)) : POWER_FLOOR_DB
	}
}

/** `powerToDb`'s accumulator scale for `frames` frames of an N-point FFT: 1 / (frames·(N/2)²). */
export function powerScale(n: number, frames: number): number {
	return 1 / (Math.max(1, frames) * (n / 2) * (n / 2))
}

/**
 * One bin of `powerToDb` before its Float32 store, the same expression (fft.test pins them
 * bit-identical). NaN, zero and negative sums read POWER_FLOOR_DB.
 */
export function binPowerDb(acc: number, scale: number): number {
	const p = acc * scale
	return p > 0 ? Math.max(POWER_FLOOR_DB, 10 * Math.log10(p)) : POWER_FLOOR_DB
}

/**
 * Brackets the dB threshold `t` in accumulator units so frame-rate stages compare linear power:
 * with v(a) = Math.fround(binPowerDb(a, scale)), a > hi[i] ⇒ v(a) > t and a < lo[i] ⇒ v(a) < t.
 * Only a in [lo, hi] (and NaN) must be decided in dB; then the decision equals the dB path's for
 * both `>` and `>=` (v is non-decreasing in a: a product, Math.log10, max and fround all are).
 *
 * Bounds: B = 10^(t/10)/scale, lo/hi = B·(1 ∓ δ), δ = (|t| + 4)·2⁻²⁰. At a = B·(1 ± δ) the dB value
 * moves by at least 10·log10(1 + δ) ≥ 4.34·δ/(1 + δ) ≥ 2.17·δ = 34.7·(|t| + 4)·2⁻²⁴, over ten times
 * the Float32 rounding (≤ |v|·2⁻²⁴ with |v| ≤ |t| + 3.02 for δ < 0.5) plus the double-precision
 * product, log and power errors (< 1e-12 dB for |t| < 10⁴). At −100 dB the bracket is 2·δ ≈ 2e-4
 * relative (≈ 9e-4 dB) wide, so only a power within that sliver of the threshold takes a log.
 * A threshold at or below POWER_FLOOR_DB (the clamp), non-finite, or with δ ≥ 0.5 brackets
 * nothing: lo = −∞ and hi = +∞, and every value is decided in dB.
 */
export function dbThresholdBracket(
	t: number,
	scale: number,
	lo: Float64Array,
	hi: Float64Array,
	i: number,
): void {
	const delta = (Math.abs(t) + 4) * 2 ** -20
	const b = 10 ** (t / 10) / scale
	const l = b * (1 - delta)
	const h = b * (1 + delta)
	if (t > POWER_FLOOR_DB && delta < 0.5 && l > 0 && Number.isFinite(h)) {
		lo[i] = l
		hi[i] = h
	} else {
		lo[i] = Number.NEGATIVE_INFINITY
		hi[i] = Number.POSITIVE_INFINITY
	}
}

/** § 4.2 default: N = 2^round(log2(fs / 1000)), clamped to 512–16384 (RBW 0.8–1.6 kHz). */
export function defaultFftSize(sampleRateHz: number): number {
	const n = 2 ** Math.round(Math.log2(sampleRateHz / 1000))
	return Math.min(16_384, Math.max(512, n))
}
