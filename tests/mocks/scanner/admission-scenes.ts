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
