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
 *
 * `createWidebandNfmChain` runs the same stages in a wasm kernel (native/wavekit-nfm,
 * wideband-nfm-wasm.ts) when it loads, else in this JS chain, which stays the reference and the
 * fallback: pcm and tone within ±1 LSB of it, the same voice gate, tone class and CTCSS verdicts
 * (tests/unit/core/scanner/channel/wideband-nfm-wasm*.test.ts).
 */
import process from "node:process"
import { WaveKitError } from "../../../utils/errors.js"
import { createComponentLogger, createLogger } from "../../../utils/logger.js"
import { ANALOG_AUDIO_RATE_HZ, FmAudioDemod } from "./fm-audio.js"
import {
	NFM_WASM_FILE,
	NfmKernel,
	loadNfmWasm,
	recorderDspChoice,
} from "./wideband-nfm-wasm.js"
import type {
	NfmChainState,
	NfmKernelDims,
	NfmWasmLoad,
	NfmWasmModule,
	RecorderDspChoice,
} from "./wideband-nfm-wasm.js"

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
/** fm-audio.ts `FmAudioDemod`: 48 kHz to 8 kHz. */
const DEMOD_DECIMATION = 6

/**
 * `FmAudioDemod`'s stream fields (fm-audio.ts keeps them private; the wasm handover writes them).
 * Checked on each use, so a renamed field throws instead of being written as a new property.
 */
interface DemodFields {
	history: Float64Array
	head: number
	phase: number
	lastI: number
	lastQ: number
	deemph: number
	pendingI: number | null
}

function demodFields(demod: FmAudioDemod): DemodFields {
	const f = demod as unknown as Partial<DemodFields>
	if (
		!(f.history instanceof Float64Array) ||
		typeof f.head !== "number" ||
		typeof f.phase !== "number" ||
		typeof f.lastI !== "number" ||
		typeof f.lastQ !== "number" ||
		typeof f.deemph !== "number" ||
		!("pendingI" in f)
	)
		throw new WaveKitError(
			"FmAudioDemod fields changed: the NFM handover no longer maps them",
			"SCANNER_NFM_KERNEL",
		)
	return f as DemodFields
}

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
	/** (b0, b1, b2, a1, a2), for the wasm chain (it takes them instead of recomputing them). */
	get coefficients(): readonly number[] {
		return [this.b0, this.b1, this.b2, this.a1, this.a2]
	}
	/** (x1, x2, y1, y2): the stream state (the wasm handover writes it). */
	get state(): readonly [number, number, number, number] {
		return [this.x1, this.x2, this.y1, this.y2]
	}
	set state(s: readonly [number, number, number, number]) {
		this.x1 = s[0]
		this.x2 = s[1]
		this.y1 = s[2]
		this.y2 = s[3]
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
	get length(): number {
		return this.taps.length
	}
	/** The delay line as (re, im) per slot, and the next slot written (the handover's terms). */
	get line(): { pairs: Float64Array; head: number } {
		const pairs = new Float64Array(2 * this.taps.length)
		for (let j = 0; j < this.taps.length; j++) {
			pairs[2 * j] = this.hre[j]!
			pairs[2 * j + 1] = this.him[j]!
		}
		return { pairs, head: this.head }
	}
	/** Writes the line (the caller checked its length and the head's range). */
	load(pairs: Float64Array, head: number): void {
		for (let j = 0; j < this.taps.length; j++) {
			this.hre[j] = pairs[2 * j]!
			this.him[j] = pairs[2 * j + 1]!
		}
		this.head = head
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
	/** The 48 kHz slice buffer, made on the first JS `process` (a wasm chain never needs it). */
	private demodIn: Float32Array | null = null

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
	}

	/** Bytes of the JS chain's slice buffers now (the 48 kHz buffer once made, the tone copy). */
	get jsBufferBytes(): number {
		return (this.demodIn?.byteLength ?? 0) + this.tone.byteLength
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
		// r / 48 kHz ≥ 1, so the 48 kHz stream never outnumbers the r stream (+1 for a carry).
		const out = (this.demodIn ??= new Float32Array(
			2 * (Math.ceil(MAX_SLICE_SAMPLES / (k * m)) + 2),
		))
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
	 * This JS chain's stream state in the kernel's terms (`NfmChainState`): the inverse of
	 * `adoptHandoverState`, for tests that compare it field by field with a kernel's. On a chain
	 * still running its kernel these are the idle inherited fields; the kernel's own state is
	 * `NfmKernel.state`.
	 */
	handoverState(): NfmChainState {
		const d = demodFields(this.demod)
		const s2 = this.stage2.line
		const ch = this.channel.line
		const biquads = new Float64Array(16)
		this.hp.forEach((b, q) => biquads.set(b.state, 4 * q))
		this.toneLp.forEach((b, q) => biquads.set(b.state, 8 + 4 * q))
		return {
			phase: this.phase,
			sinceRenorm: this.sinceRenorm,
			phRe: this.phRe,
			phIm: this.phIm,
			curRe: this.curRe,
			curIm: this.curIm,
			nxtRe: this.nxtRe,
			nxtIm: this.nxtIm,
			s2Phase: this.stage2Phase,
			s2Line: s2.pairs,
			s2Head: s2.head,
			chLine: ch.pairs,
			chHead: ch.head,
			frac: this.frac,
			prevRe: this.prevRe,
			prevIm: this.prevIm,
			lastI: d.lastI,
			lastQ: d.lastQ,
			deemph: d.deemph,
			dmHist: d.history.slice(),
			dmHead: d.head,
			dmPhase: d.phase,
			biquads,
		}
	}

	/**
	 * Continues from `s` (a kernel's state at the start of a slice): every stream field of this
	 * chain is overwritten, so the next `process` runs as a chain that saw the kernel's input. A
	 * state out of range (a phase, head or count past its bound, a line of the wrong length, a
	 * non-finite value) is refused before anything is written: false, this chain unchanged.
	 */
	adoptHandoverState(s: NfmChainState): boolean {
		const { k, m } = this.factors
		const d = demodFields(this.demod)
		const below = (v: number, bound: number): boolean =>
			Number.isInteger(v) && v >= 0 && v < bound
		const finite = (a: ArrayLike<number>): boolean => {
			for (let i = 0; i < a.length; i++)
				if (!Number.isFinite(a[i])) return false
			return true
		}
		const scalars = [
			s.phRe,
			s.phIm,
			s.curRe,
			s.curIm,
			s.nxtRe,
			s.nxtIm,
			s.frac,
			s.prevRe,
			s.prevIm,
			s.lastI,
			s.lastQ,
			s.deemph,
		]
		if (
			!below(s.phase, k) ||
			!below(s.sinceRenorm, RENORM_EVERY) ||
			!below(s.s2Phase, m) ||
			!below(s.s2Head, this.stage2.length) ||
			!below(s.chHead, this.channel.length) ||
			!below(s.dmHead, d.history.length) ||
			!below(s.dmPhase, DEMOD_DECIMATION) ||
			s.s2Line.length !== 2 * this.stage2.length ||
			s.chLine.length !== 2 * this.channel.length ||
			s.dmHist.length !== d.history.length ||
			s.biquads.length !== 16 ||
			!finite(scalars) ||
			!finite(s.s2Line) ||
			!finite(s.chLine) ||
			!finite(s.dmHist) ||
			!finite(s.biquads) ||
			// The resampler keeps frac in [0, step) between calls (exact path: 0).
			!(s.frac >= 0 && s.frac < this.step)
		)
			return false
		this.phase = s.phase
		this.sinceRenorm = s.sinceRenorm
		this.phRe = s.phRe
		this.phIm = s.phIm
		this.curRe = s.curRe
		this.curIm = s.curIm
		this.nxtRe = s.nxtRe
		this.nxtIm = s.nxtIm
		this.stage2Phase = s.s2Phase
		this.stage2.load(s.s2Line, s.s2Head)
		this.channel.load(s.chLine, s.chHead)
		this.frac = s.frac
		this.prevRe = s.prevRe
		this.prevIm = s.prevIm
		d.lastI = s.lastI
		d.lastQ = s.lastQ
		d.deemph = s.deemph
		d.history.set(s.dmHist)
		d.head = s.dmHead
		d.phase = s.dmPhase
		d.pendingI = null
		const quad = (q: number): [number, number, number, number] => [
			s.biquads[4 * q]!,
			s.biquads[4 * q + 1]!,
			s.biquads[4 * q + 2]!,
			s.biquads[4 * q + 3]!,
		]
		this.hp.forEach((b, q) => (b.state = quad(q)))
		this.toneLp.forEach((b, q) => (b.state = quad(2 + q)))
		return true
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

// ---- the wasm-backed chain ----

/** fm-audio.ts `lowpass()`, the discriminator's 127-tap 3 kHz FIR at 48 kHz (the same arithmetic). */
const DISCRIMINATOR_TAPS = 127
function discriminatorTaps(): Float64Array {
	const h = new Float64Array(DISCRIMINATOR_TAPS)
	let sum = 0
	for (let k = 0; k < DISCRIMINATOR_TAPS; k++) {
		const t = k - (DISCRIMINATOR_TAPS - 1) / 2
		const x = ((2 * 3000) / DEMOD_RATE_HZ) * t
		const sinc = t === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
		const window =
			0.42 -
			0.5 * Math.cos((2 * Math.PI * k) / (DISCRIMINATOR_TAPS - 1)) +
			0.08 * Math.cos((4 * Math.PI * k) / (DISCRIMINATOR_TAPS - 1))
		h[k] = sinc * window
		sum += h[k]!
	}
	return h.map(value => value / sum)
}

/** fm-audio.ts `FmAudioDemod` defaults (5 kHz deviation, 750 µs de-emphasis), the same arithmetic. */
export function discriminatorTables(): {
	taps: Float64Array
	scale: number
	alpha: number
} {
	return {
		taps: discriminatorTaps(),
		scale: DEMOD_RATE_HZ / (2 * Math.PI * 5000),
		alpha: 1 - Math.exp(-1 / (DEMOD_RATE_HZ * 750 * 1e-6)),
	}
}

/** Wasm faults (traps, kernel errors, failed instances) after which a process stops trying wasm. */
export const NFM_WASM_MAX_FAULTS = 3

/** The log lines the runtime writes (a component logger; tests pass a recorder of calls). */
export interface WidebandNfmLog {
	info(obj: object, msg: string): void
	warn(obj: object, msg: string): void
}

export interface WidebandNfmRuntimeOptions {
	choice: RecorderDspChoice
	/** The artefact (read once, on the first chain). */
	location: string | URL
	/** Default: a "WidebandNfm" component logger at info, created on the first line. */
	log?: WidebandNfmLog
}

/**
 * Chooses and builds chains for one process: compiles the artefact once, logs the path once,
 * counts wasm faults and stops trying wasm after NFM_WASM_MAX_FAULTS of them (logged once).
 */
export class WidebandNfmRuntime {
	/** Wasm faults so far (each logged, at most NFM_WASM_MAX_FAULTS lines). */
	faults = 0
	private load: NfmWasmLoad | null = null
	private pathLogged = false
	private disabledLogged = false
	private log: WidebandNfmLog | null

	constructor(private readonly opts: WidebandNfmRuntimeOptions) {
		this.log = opts.log ?? null
	}

	/** The compiled module, or why not (compiled on the first call). */
	wasm(): NfmWasmLoad {
		if (this.opts.choice === "js")
			return { ok: false, reason: "WAVEKIT_RECORDER_DSP=js" }
		this.load ??= loadNfmWasm(this.opts.location)
		return this.load
	}

	/** True once faults reached the bound: new chains are JS. */
	get disabled(): boolean {
		return this.faults >= NFM_WASM_MAX_FAULTS
	}

	chain(opts: WidebandNfmOptions): WidebandNfmChain {
		const js = (reason: string): WidebandNfmChain => {
			const chain = new WidebandNfmChain(opts)
			this.logPath("js", reason)
			return chain
		}
		if (this.disabled) return js(`wasm disabled after ${this.faults} faults`)
		const load = this.wasm()
		if (!load.ok) return js(load.reason)
		// Throws for options the JS chain refuses, before any memory is made.
		const chain = new WasmWidebandNfmChain(opts, this)
		const made = chain.attach(load.module)
		if (!made.ok) {
			this.fault("instance", made.reason, chain.factors)
			return js(made.reason)
		}
		this.logPath("wasm", "the kernel validated and instantiated")
		return chain
	}

	/** One wasm fault (no IQ, no audio, no frequency in the line). */
	fault(
		cause: "trap" | "status" | "instance",
		error: string,
		factors: DecimationFactors,
		handover?: "state" | "reset",
	): void {
		this.faults++
		const log = this.logger()
		if (this.faults <= NFM_WASM_MAX_FAULTS)
			log.warn(
				{
					cause,
					error,
					k: factors.k,
					m: factors.m,
					...(handover === undefined ? {} : { handover }),
					faults: this.faults,
					maxFaults: NFM_WASM_MAX_FAULTS,
				},
				"wideband NFM wasm fault: the chain continues in JS",
			)
		if (this.disabled && !this.disabledLogged) {
			this.disabledLogged = true
			log.warn(
				{ faults: this.faults },
				"wideband NFM wasm disabled for this process: new chains run in JS",
			)
		}
	}

	private logPath(path: "js" | "wasm", reason: string): void {
		if (this.pathLogged) return
		this.pathLogged = true
		if (this.opts.choice === "wasm" && path !== "wasm")
			this.logger().warn(
				{ path, reason },
				"wideband NFM chain path (wasm unavailable)",
			)
		else this.logger().info({ path, reason }, "wideband NFM chain path")
	}

	private logger(): WidebandNfmLog {
		this.log ??= createComponentLogger(
			createLogger({ level: "info" }),
			"WidebandNfm",
		)
		return this.log
	}
}

/**
 * The JS chain's stages in the wasm kernel. Constructed by WidebandNfmRuntime. The JS fields it
 * inherits are idle while the kernel runs; on a fault the kernel's state at the start of the
 * faulted slice is written into them and the slice runs again in JS, so the stream continues as
 * if JS had run it all along.
 */
class WasmWidebandNfmChain extends WidebandNfmChain {
	private kernel: NfmKernel | null = null

	constructor(
		private readonly opts: WidebandNfmOptions,
		private readonly runtime: WidebandNfmRuntime,
	) {
		super(opts)
	}

	/** Builds the kernel from this chain's own tables (computed as the JS chain computes them). */
	attach(module: NfmWasmModule): { ok: true } | { ok: false; reason: string } {
		const { k, m, rateHz } = this.factors
		const w = (-2 * Math.PI * this.opts.offsetHz) / this.opts.inputRateHz
		const stage2Taps = blackmanSinc(STAGE2_TAPS_PER_DECIMATION * m + 1, 0.5 / m)
		const channelTaps = blackmanSinc(CHANNEL_TAPS, CHANNEL_CUTOFF_HZ / rateHz)
		const demod = discriminatorTables()
		const dims: NfmKernelDims = {
			k,
			m,
			stage2Taps: stage2Taps.length,
			channelTaps: channelTaps.length,
			demodTaps: demod.taps.length,
			maxIn: MAX_SLICE_SAMPLES,
		}
		const made = NfmKernel.create(module, dims, {
			lut: U8_TO_FLOAT,
			rotRe: Math.cos(w),
			rotIm: Math.sin(w),
			cicScale: 1 / (k * k),
			step: rateHz / DEMOD_RATE_HZ,
			stage2Taps,
			channelTaps,
			demodTaps: demod.taps,
			demodScale: demod.scale,
			demodAlpha: demod.alpha,
			highPass:
				this.opts.highPass === false
					? []
					: butterworth4("high").map(b => b.coefficients),
			lowPass: butterworth4("low").map(b => b.coefficients),
		})
		if (!made.ok) return made
		this.kernel = made.kernel
		return { ok: true }
	}

	/** Which stages run this chain now ("js" from the start, or after a fault). */
	get path(): "js" | "wasm" {
		return this.kernel === null ? "js" : "wasm"
	}

	/** The kernel (tests: memory size, trap hooks); null on the JS path. */
	get kernelForTest(): NfmKernel | null {
		return this.kernel
	}

	override process(cu8: Uint8Array): Int16Array {
		const kernel = this.kernel
		if (kernel === null) return super.process(cu8)
		if (cu8.length % 2 !== 0 || cu8.length / 2 > MAX_SLICE_SAMPLES)
			throw new WaveKitError(
				"Invalid wideband NFM slice",
				"SCANNER_AUDIO_INPUT",
			)
		try {
			return kernel.process(cu8)
		} catch (err) {
			// A trap or a kernel error: drop the kernel (its memory is suspect) and continue in the
			// inherited JS chain from the state the kernel copied aside before this slice, then run
			// this slice and every later one in JS. A state out of range is refused (the JS fields
			// stay initial: the transient of a new chain) and the fault line says which.
			this.kernel = null
			let handover = false
			try {
				// Throws only if fm-audio.ts renamed a field (checked before anything is written).
				handover = this.adoptHandoverState(kernel.state("slice-start"))
			} catch {
				handover = false
			}
			const trap = !(err instanceof WaveKitError)
			this.runtime.fault(
				trap ? "trap" : "status",
				err instanceof Error ? (trap ? err.name : err.message) : "unknown",
				this.factors,
				handover ? "state" : "reset",
			)
			return super.process(cu8)
		}
	}

	override toneAudio(): Int16Array {
		return this.kernel === null ? super.toneAudio() : this.kernel.toneAudio()
	}
}

let defaultRuntime: WidebandNfmRuntime | null = null

/** The process's runtime: `WAVEKIT_RECORDER_DSP` and `WAVEKIT_RECORDER_DSP_WASM` (read once). */
export function widebandNfmRuntime(): WidebandNfmRuntime {
	defaultRuntime ??= new WidebandNfmRuntime({
		choice: recorderDspChoice(process.env["WAVEKIT_RECORDER_DSP"]),
		location:
			process.env["WAVEKIT_RECORDER_DSP_WASM"] ??
			new URL(`./${NFM_WASM_FILE}`, import.meta.url),
	})
	return defaultRuntime
}

/**
 * A recording chain: the wasm kernel when it loads and instantiates, else the JS chain (the path
 * and its reason logged once per process). Same interface and options as `new WidebandNfmChain`;
 * throws for the same options. A wasm fault never reaches the caller: the chain continues in JS.
 */
export function createWidebandNfmChain(
	opts: WidebandNfmOptions,
	runtime: WidebandNfmRuntime = widebandNfmRuntime(),
): WidebandNfmChain {
	return runtime.chain(opts)
}

/** The path a chain from `createWidebandNfmChain` runs on now. */
export function widebandNfmChainPath(chain: WidebandNfmChain): "js" | "wasm" {
	return chain instanceof WasmWidebandNfmChain ? chain.path : "js"
}

/** Test access to a chain's kernel (null: JS). */
export function widebandNfmKernelForTest(
	chain: WidebandNfmChain,
): NfmKernel | null {
	return chain instanceof WasmWidebandNfmChain ? chain.kernelForTest : null
}
