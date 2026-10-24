/**
 * Arbitrary-ratio polyphase windowed-sinc resampler (docs/specs/auto-listen-route/design.md,
 * PolyphaseResampler), Kaiser window, sized from requirement 2.3.
 *
 * Output sample j is the band-limited input signal at input time t_j = j × in / out, kept as the
 * exact integer pair (input index, phase numerator) so long runs never drift. The input rate may
 * be a fraction `num / den` (csdr: IQ rate / decimation, 1 024 000 / 41 Hz); the ratio stays
 * exact (there: up / down = 123 / 64). Output j needs the
 * inputs up to floor(t_j) + N / 2, so its production lags its input by N / 2 samples
 * (`delayInputSamples`). Every call is a pure function of the per-sample state, so any split of
 * the input into calls yields identical output (requirement 2.5).
 *
 * All storage (phase table, history and flag rings) is allocated in the constructor only
 * (requirement 2.4); `process` and `reset` allocate nothing.
 */
import { WaveKitError } from "../../utils/errors.js"

/** Stopband attenuation in dB: 5 dB margin over the 50 dB of requirement 2.3. */
const ATTENUATION_DB = 55
/** Passband edge, stop edge and cutoff as fractions of min(in, out). */
const TRANSITION = 0.1
const CUTOFF = 0.45
/**
 * Reduced ratios with at most this many phases use an exact table; others use 512 phases with
 * linear interpolation, error (π × 0.5 / 512)² / 8 ≈ 1.2e-6 (about -118 dB).
 */
export const RESAMPLER_MAX_EXACT_PHASES = 512
/** Supported input and output rates (requirement 2.2: 8 000 to 200 000 Hz in). */
export const RESAMPLER_MIN_RATE = 1_000
export const RESAMPLER_MAX_RATE = 400_000
/**
 * Largest input-rate denominator. A csdr rate is IQ rate / decimation with a rate ≥ 8 000 Hz, so
 * 4 096 covers any IQ rate up to 8 000 × 4 096 = 32.768 MHz. Bounds the ratio terms: up ≤ 48 000
 * × 4 096 ≈ 1.97e8 and down ≤ 400 000 × 4 096 ≈ 1.64e9, so `ph + down` < 2^31 and the
 * interpolated `ph × 512` < 2^53 stay exact.
 */
export const RESAMPLER_MAX_RATE_DEN = 4_096

/** An input rate of exactly `num / den` Hz (both integers, `den` ≥ 1). */
export interface RationalRate {
	num: number
	den: number
}

/**
 * The fraction with denominator ≤ `maxDen` closest to `rate` (continued fraction, then the best
 * semiconvergent), reduced, or null for a non-finite or non-positive rate. A rate computed in
 * double as p / q with q ≤ `maxDen` is recovered exactly: the double's error (≤ rate × 2^-52, at
 * most 200 000 × 2.2e-16 ≈ 4.4e-11 Hz) is far below the 1 / maxDen² ≈ 6e-8 gap between distinct
 * such fractions. Otherwise the residual is below 1 / maxDen Hz (≤ 2.4e-4 Hz, ≤ 3.1e-8 relative at
 * 8 000 Hz: one 48 kHz sample per 1 / (48 000 × 3.1e-8) ≈ 670 s, the 3 s FIFO after ~3.3 years).
 */
export function rationalRate(
	rate: number,
	maxDen = RESAMPLER_MAX_RATE_DEN,
): RationalRate | null {
	if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0)
		return null
	const dMax = Math.max(1, Math.floor(maxDen))
	if (Number.isInteger(rate)) return { num: rate, den: 1 }
	// Convergents p/q: (p0, q0) the previous, (p1, q1) the current.
	let p0 = 0
	let q0 = 1
	let p1 = 1
	let q1 = 0
	let x = rate
	for (let step = 0; step < 64; step++) {
		const a = Math.floor(x)
		const q2 = q0 + a * q1
		if (q2 > dMax) {
			// Best semiconvergent within the bound, against the last convergent.
			const k = Math.floor((dMax - q0) / q1)
			const ps = p0 + k * p1
			const qs = q0 + k * q1
			if (k >= 1 && Math.abs(rate - ps / qs) < Math.abs(rate - p1 / q1)) {
				p1 = ps
				q1 = qs
			}
			break
		}
		const p2 = p0 + a * p1
		p0 = p1
		q0 = q1
		p1 = p2
		q1 = q2
		const r = x - a
		// Exact (to the double's precision): p1 / q1 is the rate.
		if (r < 1e-9 || Math.abs(rate - p1 / q1) <= rate * 1e-15) break
		x = 1 / r
	}
	const g = gcd(p1, q1)
	return { num: p1 / g, den: q1 / g }
}

function gcd(a: number, b: number): number {
	let x = a
	let y = b
	while (y !== 0) {
		const t = x % y
		x = y
		y = t
	}
	return x
}

/** Modified Bessel function of the first kind, order 0 (series; converges fast for β ≈ 5). */
function besselI0(x: number): number {
	let sum = 1
	let term = 1
	const q = (x * x) / 4
	for (let k = 1; k < 64; k++) {
		term *= q / (k * k)
		sum += term
		if (term < sum * 1e-17) break
	}
	return sum
}

/** Kaiser β for the attenuation: 0.1102 × (55 − 8.7) ≈ 5.10. */
export const KAISER_BETA = 0.1102 * (ATTENUATION_DB - 8.7)

/**
 * Input taps per output sample: N ≈ (A − 8) / (2.285 Δω), Δω = 2π × 0.1 × min(in, out) / in,
 * rounded up to even (8 k → 48 k: 34; 96 k: 66; 200 k: 138).
 */
export function resamplerTaps(inRate: number, outRate: number): number {
	const m = Math.min(inRate, outRate)
	const dw = (2 * Math.PI * TRANSITION * m) / inRate
	const n = Math.ceil((ATTENUATION_DB - 8) / (2.285 * dw))
	return n % 2 === 0 ? n : n + 1
}

/** Rounds half away from zero and clamps to Int16. */
function toInt16(v: number): number {
	const r = v < 0 ? -Math.round(-v) : Math.round(v)
	return r > 32767 ? 32767 : r < -32768 ? -32768 : r
}

/** f32 sample to the Int16 scale: NaN → 0, clamp to [-1, 1], × 32 767, round half away. */
export function f32ToInt16(x: number): number {
	if (!(x === x)) return 0
	const c = x > 1 ? 1 : x < -1 ? -1 : x
	const v = c * 32767
	return v < 0 ? -Math.round(-v) : Math.round(v)
}

function validRate(rate: number): boolean {
	return (
		Number.isInteger(rate) &&
		rate >= RESAMPLER_MIN_RATE &&
		rate <= RESAMPLER_MAX_RATE
	)
}

export class PolyphaseResampler {
	readonly inRate: number
	readonly outRate: number
	/** Input taps per output sample (even). */
	readonly taps: number
	/** Reduced ratio out / in = up / down. */
	readonly up: number
	readonly down: number
	/** Table phases: `up` when exact, else 512 (plus one row for interpolation). */
	readonly phases: number
	readonly interpolated: boolean
	private readonly table: Float64Array
	/** History double ring: sample i stored at pos and pos + taps, so a window is contiguous. */
	private readonly hist: Float64Array
	private readonly flags: Uint8Array
	private pos = 0
	/** Input samples received since the last reset. */
	private inCount = 0
	/** Next output's input index (floor of its time) and phase numerator in [0, up). */
	private idx = 0
	private ph = 0
	private lastConsumed = 0
	private lastProduced = 0
	private lastFlagged = 0

	/** Input rate as the exact fraction `inRateNum / inRateDen` (reduced). */
	readonly inRateNum: number
	readonly inRateDen: number

	/** `inRate`: integer Hz, or an exact fraction (`rationalRate`); `outRate`: integer Hz. */
	constructor(inRate: number | RationalRate, outRate: number) {
		const num = typeof inRate === "number" ? inRate : inRate.num
		const den = typeof inRate === "number" ? 1 : inRate.den
		if (
			!Number.isInteger(num) ||
			!Number.isInteger(den) ||
			den < 1 ||
			den > RESAMPLER_MAX_RATE_DEN ||
			!validRate(outRate)
		)
			throw new WaveKitError(
				"Resampler rates must be integers in range",
				"RESAMPLER_RATE",
			)
		const rate = num / den
		if (!(rate >= RESAMPLER_MIN_RATE && rate <= RESAMPLER_MAX_RATE))
			throw new WaveKitError(
				"Resampler rates must be integers in range",
				"RESAMPLER_RATE",
			)
		const r = gcd(num, den)
		this.inRateNum = num / r
		this.inRateDen = den / r
		this.inRate = rate
		this.outRate = outRate
		// out / in = outRate × den / num, reduced.
		const top = outRate * this.inRateDen
		const g = gcd(top, this.inRateNum)
		this.up = top / g
		this.down = this.inRateNum / g
		const n = resamplerTaps(rate, outRate)
		this.taps = n
		this.interpolated = this.up > RESAMPLER_MAX_EXACT_PHASES
		this.phases = this.interpolated ? RESAMPLER_MAX_EXACT_PHASES : this.up
		const rows = this.interpolated ? this.phases + 1 : this.phases
		this.table = new Float64Array(rows * n)
		const fc = (CUTOFF * Math.min(rate, outRate)) / rate
		const i0b = besselI0(KAISER_BETA)
		const half = n / 2
		for (let p = 0; p < rows; p++) {
			const frac = p / this.phases
			let sum = 0
			const base = p * n
			for (let i = 0; i < n; i++) {
				const tau = frac + half - 1 - i
				const r = tau / half
				const w =
					r * r >= 1 ? 0 : besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / i0b
				const x = 2 * fc * tau
				const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
				const h = 2 * fc * sinc * w
				this.table[base + i] = h
				sum += h
			}
			// Unity DC gain per phase.
			for (let i = 0; i < n; i++)
				this.table[base + i] = (this.table[base + i] ?? 0) / sum
		}
		this.hist = new Float64Array(2 * n)
		this.flags = new Uint8Array(2 * n)
	}

	/** Input samples consumed by the last `process` call. */
	get consumed(): number {
		return this.lastConsumed
	}

	/** Output samples of the last `process` call with a non-zero flag (when `outFlags` given). */
	get producedFlagged(): number {
		return this.lastFlagged
	}

	/** Output samples written by the last `process` call. */
	get produced(): number {
		return this.lastProduced
	}

	/** Input samples whose effect has not yet reached the output (group delay, N / 2). */
	get delayInputSamples(): number {
		return this.taps / 2
	}

	/** Output samples that consuming `inputSamples` more input would make available. */
	pendingOutput(inputSamples: number): number {
		const n = Math.max(0, Math.trunc(inputSamples) || 0)
		const lim = this.inCount + n - 1 - this.taps / 2
		if (lim < this.idx) return 0
		return (
			Math.floor(((lim - this.idx + 1) * this.up - this.ph - 1) / this.down) + 1
		)
	}

	/**
	 * Reads input samples from `input[inStart..inEnd)` and writes into `out[outStart..outEnd)`,
	 * stopping when the input is used up or the output is full. Int16Array input is taken as is;
	 * Float32Array input is converted by `f32ToInt16`. `flag` tags every input sample of this
	 * call; when `outFlags` is given, each output sample gets the flag of the input sample its
	 * filter centre falls on (`outFlags[k]` for `out[k]`).
	 */
	process(
		input: Int16Array | Float32Array,
		inStart: number,
		inEnd: number,
		out: Int16Array,
		outStart: number,
		outEnd: number,
		flag = 0,
		outFlags: Uint8Array | null = null,
	): void {
		let i = Math.max(0, Math.min(input.length, Math.trunc(inStart) || 0))
		const iEnd = Math.max(0, Math.min(input.length, Math.trunc(inEnd) || 0))
		let o = Math.max(0, Math.min(out.length, Math.trunc(outStart) || 0))
		const oEnd = Math.max(0, Math.min(out.length, Math.trunc(outEnd) || 0))
		const i0 = i
		const o0 = o
		const n = this.taps
		const half = n / 2
		const isFloat = input instanceof Float32Array
		const f = flag & 0xff
		const hist = this.hist
		const flags = this.flags
		const table = this.table
		const up = this.up
		const down = this.down
		const interpolated = this.interpolated
		const phases = this.phases
		// Hot state in locals (written back below); the window hist[w .. w + n) is contiguous
		// (double ring), so the dot product has no modulo, branch or bounds fallback.
		let pos = this.pos
		let inCount = this.inCount
		let idx = this.idx
		let ph = this.ph
		let flagged = 0
		// n is even (resamplerTaps): the exact path unrolls by 4 with a final pair.
		for (;;) {
			if (inCount - 1 >= idx + half) {
				if (o >= oEnd) break
				const w = pos
				let acc: number
				if (!interpolated) {
					const base = ph * n
					let a0 = 0
					let a1 = 0
					let a2 = 0
					let a3 = 0
					let k = 0
					for (; k + 4 <= n; k += 4) {
						const h = w + k
						const c = base + k
						a0 += hist[h]! * table[c]!
						a1 += hist[h + 1]! * table[c + 1]!
						a2 += hist[h + 2]! * table[c + 2]!
						a3 += hist[h + 3]! * table[c + 3]!
					}
					// n is even: at most one pair is left.
					if (k < n) {
						a0 += hist[w + k]! * table[base + k]!
						a1 += hist[w + k + 1]! * table[base + k + 1]!
					}
					acc = a0 + a1 + (a2 + a3)
				} else {
					const at = (ph * phases) / up
					const p0 = Math.floor(at)
					const t = at - p0
					const b0 = p0 * n
					const b1 = b0 + n
					let a0 = 0
					let a1 = 0
					for (let k = 0; k < n; k++) {
						const x = hist[w + k]!
						a0 += x * table[b0 + k]!
						a1 += x * table[b1 + k]!
					}
					acc = a0 + (a1 - a0) * t
				}
				out[o] = toInt16(acc)
				if (outFlags !== null) {
					const of = flags[w + half - 1]!
					outFlags[o] = of
					if (of !== 0) flagged++
				}
				o++
				ph += down
				if (ph >= up) {
					const q = Math.floor(ph / up)
					idx += q
					ph -= q * up
				}
				continue
			}
			if (i >= iEnd) break
			const raw = input[i]!
			const v = isFloat ? f32ToInt16(raw) : raw
			hist[pos] = v
			hist[pos + n] = v
			flags[pos] = f
			flags[pos + n] = f
			pos = pos + 1 === n ? 0 : pos + 1
			inCount++
			i++
		}
		this.pos = pos
		this.inCount = inCount
		this.idx = idx
		this.ph = ph
		this.lastConsumed = i - i0
		this.lastProduced = o - o0
		this.lastFlagged = flagged
		// Keep counters small: shift the input origin once the index passes a large bound.
		if (this.idx > 1_000_000_000) {
			this.inCount -= this.idx
			this.idx = 0
		}
	}

	/** Empties the history; the next input starts a fresh stream at output time 0. */
	reset(): void {
		this.hist.fill(0)
		this.flags.fill(0)
		this.pos = 0
		this.inCount = 0
		this.idx = 0
		this.ph = 0
		this.lastConsumed = 0
		this.lastProduced = 0
		this.lastFlagged = 0
	}
}
