/**
 * Seeded synthetic IQ for scanner tests (spec § 15). Every generator is
 * deterministic for a given `rng` (mulberry32) and returns complex baseband
 * samples as two Float32Arrays at sample rate `fs`, full scale |z| = 1.
 * Amplitudes are complex amplitudes: a tone of `amp` has power amp².
 * SNR follows feasibility § 3: signal power over the noise power in a
 * bandwidth (12.5 kHz by default).
 */

export interface Iq {
	re: Float32Array
	im: Float32Array
}

export type Rng = () => number

export interface Burst {
	startMs: number
	durationMs: number
}

const TWO_PI = 2 * Math.PI

/** Small, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): Rng {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/** Standard normal deviate (Box–Muller). */
export function gaussian(rng: Rng): number {
	let u = rng()
	while (u <= 0) u = rng()
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * rng())
}

function poisson(rng: Rng, lambda: number): number {
	if (lambda <= 0) return 0
	if (lambda > 30)
		return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gaussian(rng)))
	const limit = Math.exp(-lambda)
	let k = 0
	let p = rng()
	while (p > limit) {
		k++
		p *= rng()
	}
	return k
}

export function zerosIq(n: number): Iq {
	return { re: new Float32Array(n), im: new Float32Array(n) }
}

/** Adds `src` into `dst` starting at sample `at` (clipped to `dst`); returns `dst`. */
export function addInto(dst: Iq, src: Iq, at = 0): Iq {
	const n = dst.re.length
	for (let i = 0; i < src.re.length; i++) {
		const j = at + i
		if (j < 0 || j >= n) continue
		dst.re[j] = dst.re[j]! + src.re[i]!
		dst.im[j] = dst.im[j]! + src.im[i]!
	}
	return dst
}

export function concatIq(parts: Iq[]): Iq {
	const n = parts.reduce((s, p) => s + p.re.length, 0)
	const out = zerosIq(n)
	let at = 0
	for (const p of parts) {
		out.re.set(p.re, at)
		out.im.set(p.im, at)
		at += p.re.length
	}
	return out
}

/** Mean |z|² over [from, to). */
export function meanPower(iq: Iq, from = 0, to: number = iq.re.length): number {
	let s = 0
	for (let i = from; i < to; i++)
		s += iq.re[i]! * iq.re[i]! + iq.im[i]! * iq.im[i]!
	return to > from ? s / (to - from) : 0
}

/** 10·log10(mean |z|²) over [from, to). */
export function powerDbfs(iq: Iq, from = 0, to: number = iq.re.length): number {
	return 10 * Math.log10(Math.max(meanPower(iq, from, to), 1e-30))
}

/** Complex amplitude whose power is `db` dBFS. */
export function dbToAmp(db: number): number {
	return 10 ** (db / 20)
}

/** SNR (dB) of a signal of mean power `signalPower` in white noise of total power sigma² over fs, measured in `bwHz`. */
export function snrDb(
	signalPower: number,
	sigma: number,
	fs: number,
	bwHz = 12_500,
): number {
	return 10 * Math.log10(signalPower / ((sigma * sigma * bwHz) / fs))
}

/** Noise sigma (E|z|² = sigma²) that puts a signal of mean power `signalPower` at `snr` dB in `bwHz`. */
export function sigmaForSnr(
	signalPower: number,
	snr: number,
	fs: number,
	bwHz = 12_500,
): number {
	return Math.sqrt((signalPower * fs) / (bwHz * 10 ** (snr / 10)))
}

/** Complex white Gaussian noise with E|z|² = sigma². */
export function gaussianNoise(rng: Rng, n: number, sigma: number): Iq {
	const out = zerosIq(n)
	const s = sigma / Math.SQRT2
	for (let i = 0; i < n; i++) {
		out.re[i] = s * gaussian(rng)
		out.im[i] = s * gaussian(rng)
	}
	return out
}

export interface HeavyTailOptions {
	fs: number
	/** Calibration knob: narrowband noise events per MHz of spectrum per second. */
	eventsPerMhzSec: number
	/** Mean event power over the noise power in 1 kHz, dB. */
	excessDb: number
	/** Event length; default 50 ms (one integration block). */
	eventMs?: number
}

/**
 * White noise plus Poisson-distributed narrowband events: each event is a
 * constant-frequency complex Gaussian component (random frequency, start and
 * phase) lasting `eventMs`. A bin's power is therefore a Gaussian scale
 * mixture (plain noise, or noise plus an event), the heavy tail real receiver
 * noise shows at detector thresholds (feasibility § 3a).
 */
export function heavyTailedNoise(
	rng: Rng,
	n: number,
	sigma: number,
	opts: HeavyTailOptions,
): Iq {
	const out = gaussianNoise(rng, n, sigma)
	const eventSamples = Math.max(
		1,
		Math.round(((opts.eventMs ?? 50) * opts.fs) / 1000),
	)
	const durationS = n / opts.fs
	const count = poisson(rng, opts.eventsPerMhzSec * (opts.fs / 1e6) * durationS)
	const eventPower =
		((sigma * sigma * 1000) / opts.fs) * 10 ** (opts.excessDb / 10)
	for (let e = 0; e < count; e++) {
		const f = (rng() - 0.5) * opts.fs
		const start = Math.floor(rng() * (n + eventSamples)) - eventSamples
		const ar = Math.sqrt(eventPower / 2) * gaussian(rng)
		const ai = Math.sqrt(eventPower / 2) * gaussian(rng)
		const w = (TWO_PI * f) / opts.fs
		for (
			let i = Math.max(0, start);
			i < Math.min(n, start + eventSamples);
			i++
		) {
			const c = Math.cos(w * i)
			const s = Math.sin(w * i)
			out.re[i] = out.re[i]! + ar * c - ai * s
			out.im[i] = out.im[i]! + ar * s + ai * c
		}
	}
	return out
}

/** Complex tone amp·e^{j(2π f t + phase)}. */
export function tone(
	n: number,
	fs: number,
	offsetHz: number,
	amp: number,
	phase = 0,
): Iq {
	const out = zerosIq(n)
	const w = (TWO_PI * offsetHz) / fs
	for (let i = 0; i < n; i++) {
		out.re[i] = amp * Math.cos(w * i + phase)
		out.im[i] = amp * Math.sin(w * i + phase)
	}
	return out
}

/** Writes amp·e^{jφ} into `out` from an instantaneous-frequency track (Hz). */
function fmFromFrequency(
	freqHz: Float64Array,
	fs: number,
	amp: number,
	gate: Float32Array | null,
): Iq {
	const n = freqHz.length
	const out = zerosIq(n)
	let phase = 0
	for (let i = 0; i < n; i++) {
		const a = gate === null ? amp : amp * gate[i]!
		out.re[i] = a * Math.cos(phase)
		out.im[i] = a * Math.sin(phase)
		phase += (TWO_PI * freqHz[i]!) / fs
		if (phase > Math.PI) phase -= TWO_PI
		else if (phase < -Math.PI) phase += TWO_PI
	}
	return out
}

/**
 * TDMA gate in [0, 1]: on for `onMs` of every `periodMs`, starting at
 * `phaseMs`, with 0.25 ms raised-sine edges centred on the nominal edges (the
 * half-amplitude points sit exactly on them).
 */
export function tdmaGate(
	n: number,
	fs: number,
	onMs = 27.5,
	periodMs = 60,
	phaseMs = 0,
): Float32Array {
	const rampMs = 0.25
	const gate = new Float32Array(n)
	for (let i = 0; i < n; i++) {
		const t = (i * 1000) / fs - phaseMs
		let u = ((t % periodMs) + periodMs) % periodMs
		if (u > periodMs - rampMs / 2) u -= periodMs
		const rise =
			0.5 + 0.5 * Math.sin(Math.PI * Math.min(0.5, Math.max(-0.5, u / rampMs)))
		const fall =
			0.5 -
			0.5 *
				Math.sin(Math.PI * Math.min(0.5, Math.max(-0.5, (u - onMs) / rampMs)))
		gate[i] = Math.min(rise, fall)
	}
	return gate
}

export interface Fsk4Options {
	symbolRate?: number
	deviationHz?: readonly number[]
	tdma?: boolean
	tdmaOnMs?: number
	tdmaPeriodMs?: number
	tdmaPhaseMs?: number
}

/**
 * Instantaneous-frequency track (Hz) of random symbols on `levels`, shaped by a
 * Gaussian frequency pulse of bandwidth-time product `bt`. Built at 16 samples
 * per symbol and linearly interpolated to fs, so cost stays O(n).
 */
function gaussianFskTrack(
	rng: Rng,
	n: number,
	fs: number,
	offsetHz: number,
	levels: readonly number[],
	symbolRate: number,
	bt: number,
): Float64Array {
	const sps = 16
	const rate = symbolRate * sps
	const coarseLen = Math.ceil((n * rate) / fs) + 2
	const symbols = Math.ceil(coarseLen / sps) + 1
	const raw = new Float64Array(coarseLen)
	for (let s = 0; s < symbols; s++) {
		const level = levels[Math.floor(rng() * levels.length)]!
		for (let k = s * sps; k < Math.min(coarseLen, (s + 1) * sps); k++)
			raw[k] = level
	}
	const sigma = (Math.sqrt(Math.LN2) / (TWO_PI * bt)) * sps
	const half = Math.ceil(3 * sigma)
	const taps = new Float64Array(2 * half + 1)
	let sum = 0
	for (let k = -half; k <= half; k++) {
		taps[k + half] = Math.exp(-(k * k) / (2 * sigma * sigma))
		sum += taps[k + half]!
	}
	const shaped = new Float64Array(coarseLen)
	for (let i = 0; i < coarseLen; i++) {
		let v = 0
		for (let k = -half; k <= half; k++) {
			const j = Math.min(coarseLen - 1, Math.max(0, i + k))
			v += taps[k + half]! * raw[j]!
		}
		shaped[i] = v / sum
	}
	const out = new Float64Array(n)
	for (let i = 0; i < n; i++) {
		const x = (i * rate) / fs
		const a = Math.floor(x)
		const frac = x - a
		out[i] = offsetHz + shaped[a]! * (1 - frac) + shaped[a + 1]! * frac
	}
	return out
}

/**
 * 4FSK-like emission: random symbols at `symbolRate` (4800) on the DMR
 * deviations (±648 / ±1944 Hz) with a Gaussian frequency pulse (BT 3): the
 * −20 dB OBW is 8.75–9.4 kHz over seeds, like run8's DMR (8.75–9.0 kHz,
 * feasibility § 2). Optionally TDMA-gated 27.5 ms per 60 ms. `amp` is the
 * on-burst amplitude.
 */
export function fsk4Burst(
	rng: Rng,
	n: number,
	fs: number,
	offsetHz: number,
	amp: number,
	opts: Fsk4Options = {},
): Iq {
	const levels = opts.deviationHz ?? [-1944, -648, 648, 1944]
	const freq = gaussianFskTrack(
		rng,
		n,
		fs,
		offsetHz,
		levels,
		opts.symbolRate ?? 4800,
		3,
	)
	const gate =
		opts.tdma === true
			? tdmaGate(
					n,
					fs,
					opts.tdmaOnMs ?? 27.5,
					opts.tdmaPeriodMs ?? 60,
					opts.tdmaPhaseMs ?? 0,
				)
			: null
	return fmFromFrequency(freq, fs, amp, gate)
}

/** Amplitude gate for a list of bursts with 0.5 ms raised-sine edges. */
function burstGate(
	n: number,
	fs: number,
	bursts: readonly Burst[],
): Float32Array {
	const gate = new Float32Array(n)
	const rampMs = 0.5
	for (const b of bursts) {
		const from = Math.max(0, Math.floor(((b.startMs - rampMs / 2) * fs) / 1000))
		const to = Math.min(
			n,
			Math.ceil(((b.startMs + b.durationMs + rampMs / 2) * fs) / 1000),
		)
		for (let i = from; i < to; i++) {
			const t = (i * 1000) / fs
			const rise =
				0.5 +
				0.5 *
					Math.sin(
						Math.PI * Math.min(0.5, Math.max(-0.5, (t - b.startMs) / rampMs)),
					)
			const fall =
				0.5 -
				0.5 *
					Math.sin(
						Math.PI *
							Math.min(
								0.5,
								Math.max(-0.5, (t - b.startMs - b.durationMs) / rampMs),
							),
					)
			gate[i] = Math.max(gate[i]!, Math.min(rise, fall))
		}
	}
	return gate
}

export interface PagerOptions {
	bursts: Burst[]
	baud?: number
	deviationHz?: number
}

/** POCSAG-like 2FSK: random NRZ bits at `baud` (1200), ±`deviationHz` (4500), only inside `bursts`. */
export function pager2fsk(
	rng: Rng,
	n: number,
	fs: number,
	offsetHz: number,
	amp: number,
	opts: PagerOptions,
): Iq {
	const dev = opts.deviationHz ?? 4500
	const sps = fs / (opts.baud ?? 1200)
	const freq = new Float64Array(n)
	let bit = -1
	let level = 0
	for (let i = 0; i < n; i++) {
		const b = Math.floor(i / sps)
		if (b !== bit) {
			bit = b
			level = rng() < 0.5 ? -dev : dev
		}
		freq[i] = offsetHz + level
	}
	return fmFromFrequency(freq, fs, amp, burstGate(n, fs, opts.bursts))
}

export interface AnalogFmOptions {
	rmsDeviationHz?: number
	audioLowHz?: number
	audioHighHz?: number
	ctcssHz?: number | null
	ctcssDeviationHz?: number
}

/**
 * Analog FM voice stand-in: band-limited noise modulation (40 random tones in
 * 300–3000 Hz, RMS deviation 1.5 kHz) plus a CTCSS sub-tone (88.5 Hz, 300 Hz
 * deviation; `ctcssHz: null` disables it). Continuous carrier.
 */
export function analogFm(
	rng: Rng,
	n: number,
	fs: number,
	offsetHz: number,
	amp: number,
	opts: AnalogFmOptions = {},
): Iq {
	const rms = opts.rmsDeviationHz ?? 1500
	const lo = opts.audioLowHz ?? 300
	const hi = opts.audioHighHz ?? 3000
	const ctcss = opts.ctcssHz === undefined ? 88.5 : opts.ctcssHz
	const ctcssDev = opts.ctcssDeviationHz ?? 300
	const toneCount = 40
	const toneAmp = rms * Math.sqrt(2 / toneCount)
	const tones: { w: number; phase: number }[] = []
	for (let k = 0; k < toneCount; k++)
		tones.push({ w: TWO_PI * (lo + rng() * (hi - lo)), phase: TWO_PI * rng() })
	// Audio is generated at ~16 kHz and linearly interpolated to fs.
	const step = Math.max(1, Math.floor(fs / 16_000))
	const audioRate = fs / step
	const audioLen = Math.ceil(n / step) + 2
	const audio = new Float64Array(audioLen)
	for (let a = 0; a < audioLen; a++) {
		const t = a / audioRate
		let v = 0
		for (const tn of tones) v += toneAmp * Math.sin(tn.w * t + tn.phase)
		if (ctcss !== null) v += ctcssDev * Math.sin(TWO_PI * ctcss * t)
		audio[a] = v
	}
	const freq = new Float64Array(n)
	for (let i = 0; i < n; i++) {
		const a = Math.floor(i / step)
		const frac = i / step - a
		freq[i] = offsetHz + audio[a]! * (1 - frac) + audio[a + 1]! * frac
	}
	return fmFromFrequency(freq, fs, amp, null)
}

export interface OokOptions {
	bursts: Burst[]
	bitRate?: number
}

/** ISM-like OOK: a carrier keyed by random bits at `bitRate` (4000), only inside `bursts`. */
export function ookBursts(
	rng: Rng,
	n: number,
	fs: number,
	offsetHz: number,
	amp: number,
	opts: OokOptions,
): Iq {
	const sps = fs / (opts.bitRate ?? 4000)
	const gate = burstGate(n, fs, opts.bursts)
	let bit = -1
	let on = 0
	for (let i = 0; i < n; i++) {
		const b = Math.floor(i / sps)
		if (b !== bit) {
			bit = b
			on = rng() < 0.5 ? 0 : 1
		}
		gate[i] = gate[i]! * on
	}
	const freq = new Float64Array(n).fill(offsetHz)
	return fmFromFrequency(freq, fs, amp, gate)
}

/**
 * Two carriers f1, f2 of amplitude `amp` plus their third-order products
 * 2f1 − f2 and 2f2 − f1 at `productDbc` relative to the carriers.
 */
export function intermodPair(
	n: number,
	fs: number,
	f1Hz: number,
	f2Hz: number,
	amp: number,
	productDbc: number,
): Iq {
	const out = tone(n, fs, f1Hz, amp)
	addInto(out, tone(n, fs, f2Hz, amp, 1.3))
	const pAmp = amp * 10 ** (productDbc / 20)
	addInto(out, tone(n, fs, 2 * f1Hz - f2Hz, pAmp, 0.4))
	addInto(out, tone(n, fs, 2 * f2Hz - f1Hz, pAmp, 2.1))
	return out
}

/** RTL2832 test-mode bytes: an 8-bit counter, b[i] = (startByte + i) mod 256. */
export function counterRun(len: number, startByte = 0): Uint8Array {
	const out = new Uint8Array(len)
	for (let i = 0; i < len; i++) out[i] = (startByte + i) & 255
	return out
}

/** Interleaved CU8 (rtl_tcp): u = round(127.5·x + 127.5), clamped to 0..255. */
export function packCu8(re: Float32Array, im: Float32Array): Uint8Array {
	const out = new Uint8Array(re.length * 2)
	for (let i = 0; i < re.length; i++) {
		out[2 * i] = Math.min(255, Math.max(0, Math.round(re[i]! * 127.5 + 127.5)))
		out[2 * i + 1] = Math.min(
			255,
			Math.max(0, Math.round(im[i]! * 127.5 + 127.5)),
		)
	}
	return out
}

/** Interleaved little-endian int16: s = round(32768·x), clamped to −32768..32767. */
export function packS16(re: Float32Array, im: Float32Array): Uint8Array {
	const out = new Uint8Array(re.length * 4)
	const view = new DataView(out.buffer)
	for (let i = 0; i < re.length; i++) {
		view.setInt16(
			4 * i,
			Math.min(32767, Math.max(-32768, Math.round(re[i]! * 32768))),
			true,
		)
		view.setInt16(
			4 * i + 2,
			Math.min(32767, Math.max(-32768, Math.round(im[i]! * 32768))),
			true,
		)
	}
	return out
}

/** Interleaved little-endian float32. */
export function packF32(re: Float32Array, im: Float32Array): Uint8Array {
	const out = new Uint8Array(re.length * 8)
	const view = new DataView(out.buffer)
	for (let i = 0; i < re.length; i++) {
		view.setFloat32(8 * i, re[i]!, true)
		view.setFloat32(8 * i + 4, im[i]!, true)
	}
	return out
}

export interface NarrowbandPsd {
	binHz: number
	/** fftshifted, dB, tone-calibrated (a bin-centred tone of amp a reads 20·log10(a)). */
	db: Float64Array
}

/**
 * Ground-truth PSD around `offsetHz`: mix to baseband, boxcar-decimate by
 * `decimation` (32), then average Hann-windowed `nfft` (512) DFTs. Independent
 * of the scanner FFT so tests can check it.
 */
export function narrowbandPsd(
	iq: Iq,
	fs: number,
	offsetHz: number,
	opts: { decimation?: number; nfft?: number } = {},
): NarrowbandPsd {
	const dec = opts.decimation ?? 32
	const nfft = opts.nfft ?? 512
	const w = (-TWO_PI * offsetHz) / fs
	const m = Math.floor(iq.re.length / dec)
	const dr = new Float64Array(m)
	const di = new Float64Array(m)
	for (let k = 0; k < m; k++) {
		let sr = 0
		let si = 0
		for (let j = 0; j < dec; j++) {
			const i = k * dec + j
			const c = Math.cos(w * i)
			const s = Math.sin(w * i)
			sr += iq.re[i]! * c - iq.im[i]! * s
			si += iq.re[i]! * s + iq.im[i]! * c
		}
		dr[k] = sr / dec
		di[k] = si / dec
	}
	const win = new Float64Array(nfft)
	let wsum = 0
	for (let i = 0; i < nfft; i++) {
		win[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / nfft)
		wsum += win[i]!
	}
	const cosT = new Float64Array(nfft)
	const sinT = new Float64Array(nfft)
	for (let i = 0; i < nfft; i++) {
		cosT[i] = Math.cos((TWO_PI * i) / nfft)
		sinT[i] = -Math.sin((TWO_PI * i) / nfft)
	}
	const acc = new Float64Array(nfft)
	const segments = Math.floor(m / nfft)
	const xr = new Float64Array(nfft)
	const xi = new Float64Array(nfft)
	for (let s = 0; s < segments; s++) {
		for (let i = 0; i < nfft; i++) {
			xr[i] = dr[s * nfft + i]! * win[i]!
			xi[i] = di[s * nfft + i]! * win[i]!
		}
		for (let k = 0; k < nfft; k++) {
			let ar = 0
			let ai = 0
			for (let i = 0; i < nfft; i++) {
				const t = (k * i) % nfft
				ar += xr[i]! * cosT[t]! - xi[i]! * sinT[t]!
				ai += xr[i]! * sinT[t]! + xi[i]! * cosT[t]!
			}
			acc[(k + nfft / 2) % nfft] =
				acc[(k + nfft / 2) % nfft]! + ar * ar + ai * ai
		}
	}
	const db = new Float64Array(nfft)
	for (let k = 0; k < nfft; k++)
		db[k] =
			10 *
			Math.log10(
				Math.max(acc[k]! / (Math.max(1, segments) * wsum * wsum), 1e-30),
			)
	return { binHz: fs / dec / nfft, db }
}

/** Width between the outermost bins within `belowPeakDb` of the peak. */
export function obwBelowPeakHz(psd: NarrowbandPsd, belowPeakDb = 20): number {
	let peak = -Infinity
	for (const v of psd.db) peak = Math.max(peak, v)
	let lo = -1
	let hi = -1
	for (let k = 0; k < psd.db.length; k++) {
		if (psd.db[k]! >= peak - belowPeakDb) {
			if (lo < 0) lo = k
			hi = k
		}
	}
	return (hi - lo + 1) * psd.binHz
}

export interface ImpulseTrainOptions {
	periodMs: number
	widthMs: number
	/** Tones every toneSpacingHz across ±occupiedFraction·fs/2, each of amplitude toneAmp (power toneAmp²). */
	toneSpacingHz: number
	occupiedFraction: number
	toneAmp: number
	phaseMs?: number
}

/**
 * Periodic broadband impulses (switching-supply RFI, spec § 4.9): one random-phase multitone burst
 * of widthMs, rectangular-gated, repeated every periodMs from phaseMs. With toneSpacingHz equal to
 * the scanner RBW, a frame inside a burst reads toneAmp² in every covered bin (tone-calibrated).
 */
export function impulseTrain(
	rng: Rng,
	n: number,
	fs: number,
	opts: ImpulseTrainOptions,
): Iq {
	const out = zerosIq(n)
	const w = Math.max(1, Math.round((opts.widthMs * fs) / 1000))
	const maxK = Math.floor(
		(opts.occupiedFraction * fs) / (2 * opts.toneSpacingHz),
	)
	const shape = zerosIq(w)
	for (let k = -maxK; k <= maxK; k++) {
		const step = (TWO_PI * k * opts.toneSpacingHz) / fs
		const phase = TWO_PI * rng()
		for (let i = 0; i < w; i++) {
			shape.re[i] =
				(shape.re[i] ?? 0) + opts.toneAmp * Math.cos(step * i + phase)
			shape.im[i] =
				(shape.im[i] ?? 0) + opts.toneAmp * Math.sin(step * i + phase)
		}
	}
	const period = (opts.periodMs * fs) / 1000
	for (
		let start = ((opts.phaseMs ?? 0) * fs) / 1000;
		start < n;
		start += period
	)
		addInto(out, shape, Math.round(start))
	return out
}

/**
 * Sum of complex tones at `teethHz` with amplitudes `amps` for absolute samples [at, at + n), so
 * successive calls are phase-continuous (a spur comb streamed in chunks). Each tone runs as a
 * recursive oscillator started from its exact phase at `at`.
 */
export function toneComb(
	n: number,
	fs: number,
	teethHz: readonly number[],
	amps: readonly number[],
	at = 0,
): Iq {
	const out = zerosIq(n)
	teethHz.forEach((hz, t) => {
		const amp = amps[t] ?? 0
		const w = (TWO_PI * hz) / fs
		const start = (w * at) % TWO_PI
		let re = amp * Math.cos(start)
		let im = amp * Math.sin(start)
		const cr = Math.cos(w)
		const ci = Math.sin(w)
		for (let i = 0; i < n; i++) {
			out.re[i] = (out.re[i] ?? 0) + re
			out.im[i] = (out.im[i] ?? 0) + im
			const nextRe = re * cr - im * ci
			im = re * ci + im * cr
			re = nextRe
		}
	})
	return out
}
