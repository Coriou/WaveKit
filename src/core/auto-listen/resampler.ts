/**
 * Arbitrary-ratio polyphase windowed-sinc resampler (docs/specs/auto-listen-route/design.md,
 * PolyphaseResampler), Kaiser window, sized from requirement 2.3.
 *
 * Output sample j is the band-limited input signal at input time t_j = j × in / out, kept as the
 * exact integer pair (input index, phase numerator) so long runs never drift. Output j needs the
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
	private readonly table: Float32Array
	/** History double ring: sample i stored at pos and pos + taps, so a window is contiguous. */
	private readonly hist: Float32Array
	private readonly flags: Uint8Array
	private pos = 0
	/** Input samples received since the last reset. */
	private inCount = 0
	/** Next output's input index (floor of its time) and phase numerator in [0, up). */
	private idx = 0
	private ph = 0
	private lastConsumed = 0
	private lastProduced = 0

	constructor(inRate: number, outRate: number) {
		if (!validRate(inRate) || !validRate(outRate))
			throw new WaveKitError(
				"Resampler rates must be integers in range",
				"RESAMPLER_RATE",
			)
		this.inRate = inRate
		this.outRate = outRate
		const g = gcd(outRate, inRate)
		this.up = outRate / g
		this.down = inRate / g
		const n = resamplerTaps(inRate, outRate)
		this.taps = n
		this.interpolated = this.up > RESAMPLER_MAX_EXACT_PHASES
		this.phases = this.interpolated ? RESAMPLER_MAX_EXACT_PHASES : this.up
		const rows = this.interpolated ? this.phases + 1 : this.phases
		this.table = new Float32Array(rows * n)
		const fc = (CUTOFF * Math.min(inRate, outRate)) / inRate
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
		this.hist = new Float32Array(2 * n)
		this.flags = new Uint8Array(2 * n)
	}

	/** Input samples consumed by the last `process` call. */
	get consumed(): number {
		return this.lastConsumed
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
		for (;;) {
			if (this.inCount - 1 >= this.idx + half) {
				if (o >= oEnd) break
				// Window = the last N inputs, oldest first, at hist[pos .. pos + N).
				const w = this.pos
				let acc = 0
				if (!this.interpolated) {
					const base = this.ph * n
					for (let k = 0; k < n; k++)
						acc += (hist[w + k] ?? 0) * (table[base + k] ?? 0)
				} else {
					const at = (this.ph * this.phases) / up
					const p0 = Math.floor(at)
					const t = at - p0
					const b0 = p0 * n
					const b1 = b0 + n
					let a0 = 0
					let a1 = 0
					for (let k = 0; k < n; k++) {
						const x = hist[w + k] ?? 0
						a0 += x * (table[b0 + k] ?? 0)
						a1 += x * (table[b1 + k] ?? 0)
					}
					acc = a0 + (a1 - a0) * t
				}
				out[o] = toInt16(acc)
				if (outFlags !== null) outFlags[o] = flags[w + half - 1] ?? 0
				o++
				this.ph += down
				if (this.ph >= up) {
					const q = Math.floor(this.ph / up)
					this.idx += q
					this.ph -= q * up
				}
				continue
			}
			if (i >= iEnd) break
			const raw = input[i] ?? 0
			const v = isFloat ? f32ToInt16(raw) : raw
			const p = this.pos
			hist[p] = v
			hist[p + n] = v
			flags[p] = f
			flags[p + n] = f
			this.pos = p + 1 === n ? 0 : p + 1
			this.inCount++
			i++
		}
		this.lastConsumed = i - i0
		this.lastProduced = o - o0
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
	}
}
