/**
 * Synthetic scenes for admission and segment-split tests. Deterministic for a given
 * seed (mulberry32); synthetic only, no captured RF. Complex baseband at `fs`, full scale 1.
 */
import {
	addInto,
	analogFm,
	gaussianNoise,
	mulberry32,
	type Iq,
	type Rng,
} from "./signals.js"

const TWO_PI = 2 * Math.PI

/**
 * AM voice stand-in: carrier `amp` with modulation index `m` by band-limited audio (24 random
 * tones in 300 to 3 000 Hz, normalised to unit peak), so the occupied width is about 6 kHz.
 */
export function amVoice(
	rng: Rng,
	n: number,
	fs: number,
	offsetHz: number,
	amp: number,
	m = 0.5,
): Iq {
	const tones: { w: number; phase: number }[] = []
	for (let k = 0; k < 24; k++)
		tones.push({
			w: (TWO_PI * (300 + rng() * 2_700)) / fs,
			phase: TWO_PI * rng(),
		})
	const out = { re: new Float32Array(n), im: new Float32Array(n) }
	const w0 = (TWO_PI * offsetHz) / fs
	const norm = 1 / tones.length
	for (let i = 0; i < n; i++) {
		let a = 0
		for (const t of tones) a += Math.sin(t.w * i + t.phase)
		const env = amp * (1 + m * a * norm)
		out.re[i] = env * Math.cos(w0 * i)
		out.im[i] = env * Math.sin(w0 * i)
	}
	return out
}

/**
 * Wide FM broadcast stand-in: `analogFm` with `rmsDeviationHz` (default 25 kHz) over 30 Hz to
 * 15 kHz audio, so Carson's width is about 2 × (2 × rms + 15 kHz): 130 kHz at the default.
 */
export function wideFm(
	rng: Rng,
	n: number,
	fs: number,
	offsetHz: number,
	amp: number,
	rmsDeviationHz = 25_000,
): Iq {
	return analogFm(rng, n, fs, offsetHz, amp, {
		rmsDeviationHz,
		audioLowHz: 30,
		audioHighHz: 15_000,
		ctcssHz: null,
	})
}

/** Narrow FM voice carriers (1.5 kHz RMS deviation) at each offset, equal amplitude. */
export function nfmCarriers(
	rng: Rng,
	n: number,
	fs: number,
	offsetsHz: readonly number[],
	amp: number,
): Iq {
	const out = { re: new Float32Array(n), im: new Float32Array(n) }
	for (const off of offsetsHz)
		addInto(out, analogFm(rng, n, fs, off, amp, { ctcssHz: null }))
	return out
}

/** Seeded scene: complex Gaussian noise of `sigma` plus each emitter. */
export function scene(
	seed: number,
	n: number,
	sigma: number,
	emitters: readonly ((rng: Rng) => Iq)[],
): Iq {
	const rng = mulberry32(seed)
	const iq = gaussianNoise(rng, n, sigma)
	for (const e of emitters) addInto(iq, e(rng))
	return iq
}

/** One push-to-talk transmission in seconds from the start of the scene. */
export interface PttBurst {
	startS: number
	endS: number
}

/**
 * Push-to-talk AM voice stand-in: the carrier `amp` is keyed only inside each burst, and its
 * audio is band-limited (12 random tones in 300 to 3 000 Hz) under a syllabic envelope (random
 * 120 to 400 ms syllables with 30 to 200 ms pauses), modulation index `m` at the syllable peak.
 * A pause keeps the carrier (AM transmitters key the carrier for the whole transmission).
 */
export function amVoicePtt(
	rng: Rng,
	n: number,
	fs: number,
	offsetHz: number,
	amp: number,
	bursts: readonly PttBurst[],
	m = 0.7,
): Iq {
	const tones: { w: number; phase: number }[] = []
	for (let k = 0; k < 12; k++)
		tones.push({
			w: (TWO_PI * (300 + rng() * 2_700)) / fs,
			phase: TWO_PI * rng(),
		})
	const out = { re: new Float32Array(n), im: new Float32Array(n) }
	const w0 = (TWO_PI * offsetHz) / fs
	const norm = 1 / Math.sqrt(tones.length * 2)
	for (const b of bursts) {
		const from = Math.max(0, Math.round(b.startS * fs))
		const to = Math.min(n, Math.round(b.endS * fs))
		let i = from
		while (i < to) {
			const syl = Math.round((0.12 + rng() * 0.28) * fs)
			const gap = Math.round((0.03 + rng() * 0.17) * fs)
			const sylEnd = Math.min(to, i + syl)
			for (let j = i; j < sylEnd; j++) {
				const env = Math.sin((Math.PI * (j - i)) / syl)
				let a = 0
				for (const t of tones) a += Math.sin(t.w * j + t.phase)
				const s = Math.max(-1, Math.min(1, a * norm))
				const e = amp * (1 + m * env * s)
				out.re[j] = e * Math.cos(w0 * j)
				out.im[j] = e * Math.sin(w0 * j)
			}
			const gapEnd = Math.min(to, sylEnd + gap)
			for (let j = sylEnd; j < gapEnd; j++) {
				out.re[j] = amp * Math.cos(w0 * j)
				out.im[j] = amp * Math.sin(w0 * j)
			}
			i = gapEnd
		}
	}
	return out
}
