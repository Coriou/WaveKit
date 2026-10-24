/**
 * Seeded synthetic signals for the A20 reverse-burst tests (design A20, corpus). Two models:
 * `directTone`, an 8 kHz tone with an optional phase reversal and white noise; and `fmLink`, a
 * frequency-modulated link (5 kHz deviation, 24 kHz complex baseband, optional 10 Hz Rayleigh or
 * slow fading, complex noise at a carrier-to-noise in 12.5 kHz, a 31-tap 6 kHz channel low-pass,
 * a quadrature discriminator and block averaging by 3 to 8 kHz). Both are deterministic.
 */

export const RB_RATE = 8_000
const LINK_RATE = 24_000
const LINK_DECIMATION = LINK_RATE / RB_RATE
const DEVIATION_HZ = 5_000

/** Mulberry32 in [0, 1). */
export function seeded(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
	}
}

/** Standard normal pairs from `rand` (Box-Muller). */
function gaussian(rand: () => number): () => number {
	let spare: number | null = null
	return () => {
		if (spare !== null) {
			const v = spare
			spare = null
			return v
		}
		const u = Math.max(rand(), 1e-12)
		const v = rand()
		const r = Math.sqrt(-2 * Math.log(u))
		spare = r * Math.sin(2 * Math.PI * v)
		return r * Math.cos(2 * Math.PI * v)
	}
}

export interface DirectToneOptions {
	hz: number
	samples: number
	/** Sample index of the reversal, or null. */
	reversalAt?: number | null
	reversalDeg?: number
	/** Tone frequency error in Hz. */
	errorHz?: number
	/** Starting phase in radians. */
	phase?: number
	amplitude?: number
	/** Gaussian noise RMS. */
	noise?: number
	seed?: number
	/** Per-sample amplitude multiplier (fades), default 1. */
	envelope?: (n: number) => number
	/** Extra phase in radians at sample n (flutter, slow phase moves), default 0. */
	phaseAt?: (n: number) => number
}

/** An 8 kHz tone, optionally reversed at `reversalAt`, with Gaussian noise. */
export function directTone(options: DirectToneOptions): Float64Array {
	const out = new Float64Array(options.samples)
	const w = (2 * Math.PI * (options.hz + (options.errorHz ?? 0))) / RB_RATE
	const step = ((options.reversalDeg ?? 180) * Math.PI) / 180
	const at = options.reversalAt ?? null
	const amp = options.amplitude ?? 0.15
	const noise = options.noise ?? 0
	const g = gaussian(seeded(options.seed ?? 1))
	const phase0 = options.phase ?? 0
	for (let n = 0; n < out.length; n++) {
		const extra =
			(at !== null && n >= at ? step : 0) + (options.phaseAt?.(n) ?? 0)
		out[n] =
			amp * (options.envelope?.(n) ?? 1) * Math.sin(w * n + phase0 + extra) +
			(noise > 0 ? noise * g() : 0)
	}
	return out
}

export interface FmLinkOptions {
	hz: number
	seconds: number
	seed: number
	/** Tone deviation as a fraction of 5 kHz (default 0.15). */
	toneDeviation?: number
	errorHz?: number
	/** Reversal time in seconds, or null. The voice stops there (PTT released). */
	reversalS?: number | null
	reversalDeg?: number
	fade?: "none" | "rayleigh" | "slow"
	/** Carrier-to-noise in 12.5 kHz, dB. */
	cnrDb: number
	/** Voice RMS as a fraction of deviation (0 = none). */
	voice?: number
	/** 10 Hz tone flutter: phase RMS in degrees and amplitude RMS fraction. */
	flutterDeg?: number
	flutterAm?: number
}

/** Low-pass noise with unit RMS and about 10 Hz bandwidth (Hann smoothing of white noise). */
function slowNoise(n: number, rate: number, g: () => number): Float64Array {
	const half = Math.round(rate / 10)
	const kernel = new Float64Array(2 * half)
	for (let i = 0; i < kernel.length; i++)
		kernel[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (kernel.length - 1))
	const white = new Float64Array(n + kernel.length)
	for (let i = 0; i < white.length; i++) white[i] = g()
	const out = new Float64Array(n)
	// Running sums would be faster; n is small enough here (one pass per corpus run).
	const step = 8
	for (let i = 0; i < n; i += step) {
		let acc = 0
		for (let j = 0; j < kernel.length; j += 4)
			acc += (kernel[j] ?? 0) * (white[i + j] ?? 0)
		for (let k = i; k < Math.min(n, i + step); k++) out[k] = acc
	}
	let sq = 0
	for (let i = 0; i < n; i++) sq += (out[i] ?? 0) ** 2
	const rms = Math.sqrt(sq / n) || 1
	for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) / rms
	return out
}

/** Speech-shaped message (voiced harmonics and noise, syllabic), RMS `level`. */
function voice(
	n: number,
	rate: number,
	rand: () => number,
	level: number,
): Float64Array {
	const g = gaussian(rand)
	const f0 = 100 + 120 * rand()
	const vib = 1 + 2 * rand()
	const syl = 3 + 2 * rand()
	const sylPhase = 2 * Math.PI * rand()
	const harmonics = Math.floor(3_000 / f0)
	const offsets = new Float64Array(harmonics + 1)
	for (let h = 1; h <= harmonics; h++) offsets[h] = 2 * Math.PI * rand()
	const out = new Float64Array(n)
	let phase = 0
	let prev = 0
	for (let i = 0; i < n; i++) {
		const t = i / rate
		phase +=
			(2 * Math.PI * f0 * (1 + 0.08 * Math.sin(2 * Math.PI * vib * t))) / rate
		const env = Math.sqrt(
			Math.max(0, Math.sin(2 * Math.PI * syl * t + sylPhase)),
		)
		let v = 0
		for (let h = 1; h <= harmonics; h++)
			v += Math.sin(h * phase + (offsets[h] ?? 0)) / h ** 0.7
		v = env * (v + 0.3 * g())
		// First-order transmitter pre-emphasis.
		out[i] = v - 0.95 * prev
		prev = v
	}
	let sq = 0
	for (let i = 0; i < n; i++) sq += (out[i] ?? 0) ** 2
	const scale = level / (Math.sqrt(sq / n) || 1)
	for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) * scale
	return out
}

const CHANNEL_TAPS = (() => {
	const taps = 31
	const h = new Float64Array(taps)
	const cut = 6_000 / LINK_RATE
	let sum = 0
	for (let i = 0; i < taps; i++) {
		const m = i - (taps - 1) / 2
		const sinc =
			m === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * m) / (Math.PI * m)
		const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / taps)
		h[i] = sinc * win
		sum += h[i] ?? 0
	}
	for (let i = 0; i < taps; i++) h[i] = (h[i] ?? 0) / sum
	return h
})()

/** The FM link's 8 kHz discriminator output (normalised to 5 kHz deviation = 1). */
export function fmLink(options: FmLinkOptions): Float64Array {
	const rand = seeded(options.seed)
	const g = gaussian(rand)
	const n = Math.round(options.seconds * LINK_RATE)
	const toneDev = options.toneDeviation ?? 0.15
	const w = (2 * Math.PI * (options.hz + (options.errorHz ?? 0))) / LINK_RATE
	const start = 2 * Math.PI * rand()
	const revAt =
		options.reversalS === undefined || options.reversalS === null
			? n
			: Math.round(options.reversalS * LINK_RATE)
	const step = ((options.reversalDeg ?? 180) * Math.PI) / 180
	const speech =
		(options.voice ?? 0) > 0
			? voice(n, LINK_RATE, rand, options.voice ?? 0)
			: null
	const flutter =
		(options.flutterDeg ?? 0) > 0 || (options.flutterAm ?? 0) > 0
			? [slowNoise(n, LINK_RATE, g), slowNoise(n, LINK_RATE, g)]
			: null
	// Rayleigh: 16 paths, 10 Hz Doppler.
	const paths = 16
	const doppler = new Float64Array(paths)
	const pathPhase = new Float64Array(paths)
	for (let p = 0; p < paths; p++) {
		doppler[p] = (2 * Math.PI * 10 * Math.cos(2 * Math.PI * rand())) / LINK_RATE
		pathPhase[p] = 2 * Math.PI * rand()
	}
	const re = new Float64Array(n)
	const im = new Float64Array(n)
	let phi = 0
	let power = 0
	for (let i = 0; i < n; i++) {
		let tonePhase = w * i + start + (i >= revAt ? step : 0)
		let amp = 1
		if (flutter !== null) {
			tonePhase +=
				(((options.flutterDeg ?? 0) * Math.PI) / 180) * (flutter[0]?.[i] ?? 0)
			amp = Math.max(
				0.05,
				1 + (options.flutterAm ?? 0) * (flutter[1]?.[i] ?? 0),
			)
		}
		let m = toneDev * amp * Math.sin(tonePhase)
		if (speech !== null && i < revAt) m += speech[i] ?? 0
		phi += (2 * Math.PI * DEVIATION_HZ * m) / LINK_RATE
		let gr = 1
		let gi = 0
		if (options.fade === "rayleigh") {
			gr = 0
			for (let p = 0; p < paths; p++) {
				const a = (doppler[p] ?? 0) * i + (pathPhase[p] ?? 0)
				gr += Math.cos(a)
				gi += Math.sin(a)
			}
			gr /= Math.sqrt(paths)
			gi /= Math.sqrt(paths)
		} else if (options.fade === "slow") {
			const s = Math.max(0, Math.sin((Math.PI * i * 3) / n)) ** 8
			gr = 10 ** (-(20 * s) / 20)
		}
		const c = Math.cos(phi)
		const s = Math.sin(phi)
		re[i] = c * gr - s * gi
		im[i] = c * gi + s * gr
		power += (re[i] ?? 0) ** 2 + (im[i] ?? 0) ** 2
	}
	const sigma =
		Math.sqrt(power / n) *
		10 ** (-options.cnrDb / 20) *
		Math.sqrt(LINK_RATE / 12_500) *
		Math.SQRT1_2
	for (let i = 0; i < n; i++) {
		re[i] = (re[i] ?? 0) + sigma * g()
		im[i] = (im[i] ?? 0) + sigma * g()
	}
	const taps = CHANNEL_TAPS.length
	const half = (taps - 1) / 2
	const out = new Float64Array(Math.floor(n / LINK_DECIMATION))
	let prevRe = 0
	let prevIm = 0
	let acc = 0
	let filled = 0
	let k = 0
	for (let i = 0; i < n; i++) {
		let yr = 0
		let yi = 0
		for (let t = 0; t < taps; t++) {
			const j = i + half - t
			if (j < 0 || j >= n) continue
			const h = CHANNEL_TAPS[t] ?? 0
			yr += h * (re[j] ?? 0)
			yi += h * (im[j] ?? 0)
		}
		// x[n] · conj(x[n-1])
		const dr = yr * prevRe + yi * prevIm
		const di = yi * prevRe - yr * prevIm
		prevRe = yr
		prevIm = yi
		const f =
			i === 0
				? 0
				: (Math.atan2(di, dr) * LINK_RATE) / (2 * Math.PI) / DEVIATION_HZ
		acc += f
		filled += 1
		if (filled === LINK_DECIMATION) {
			out[k++] = acc / LINK_DECIMATION
			acc = 0
			filled = 0
		}
	}
	return out
}
