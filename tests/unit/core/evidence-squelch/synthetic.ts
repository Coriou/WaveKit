/**
 * Test-only synthetic PCM for the evidence squelch lanes. Every generator is deterministic from
 * its options (a seed where randomness is involved) and returns `round(rate × seconds)` samples
 * as a `Float32Array` in PCM full-scale units (1.0 = full scale, the f32le range).
 */
import { ctcssTone, dcsAudio } from "../audio-tones/dcs-synth.js"
import { mulberry32 } from "../audio-tones/synth.js"
import type { EvidencePcmFormat } from "../../../../src/core/evidence-squelch/contract.js"

function sampleCount(rate: number, seconds: number): number {
	return Math.round(rate * seconds)
}

/**
 * Speech-shaped audio: a harmonic series (seeded f0 100-220 Hz, gentle glide, falling harmonic
 * weights up to 3.4 kHz) under a 4 Hz syllabic envelope, with seeded 150-350 ms pauses every
 * 0.6-1.2 s. Peak about `level` (default 0.5).
 */
export function voiceLike(options: {
	rate: number
	seconds: number
	seed: number
	level?: number
}): Float32Array {
	const { rate } = options
	const rand = mulberry32(options.seed)
	const n = sampleCount(rate, options.seconds)
	const out = new Float32Array(n)
	const level = options.level ?? 0.5
	const f0 = 100 + rand() * 120
	const harmonics = Math.max(
		1,
		Math.min(20, Math.floor(Math.min(3400, rate / 2) / f0)),
	)
	const weights: number[] = []
	let weightSum = 0
	for (let h = 1; h <= harmonics; h++) {
		const w = 1 / h
		weights.push(w)
		weightSum += w
	}
	const syllablePhase = rand() * 2 * Math.PI
	let phase = 0
	let nextPause = Math.round((0.6 + rand() * 0.6) * rate)
	let pauseEnd = -1
	for (let i = 0; i < n; i++) {
		if (i === nextPause) {
			pauseEnd = i + Math.round((0.15 + rand() * 0.2) * rate)
			nextPause = pauseEnd + Math.round((0.6 + rand() * 0.6) * rate)
		}
		const t = i / rate
		phase +=
			(2 * Math.PI * f0 * (1 + 0.05 * Math.sin(2 * Math.PI * 0.7 * t))) / rate
		if (i < pauseEnd) continue
		const env = 0.5 * (1 - Math.cos(2 * Math.PI * 4 * t + syllablePhase))
		let v = 0
		for (let h = 0; h < weights.length; h++)
			v += (weights[h] ?? 0) * Math.sin((h + 1) * phase)
		out[i] = (level * env * v) / weightSum
	}
	return out
}

/** A CTCSS tone at `hz` (amplitude 0.15, fixed phase). */
export function ctcssMix(options: {
	rate: number
	seconds: number
	hz: number
}): Float32Array {
	return Float32Array.from(
		ctcssTone({
			hz: options.hz,
			seconds: options.seconds,
			seed: 0,
			rate: options.rate,
		}),
	)
}

/** A DCS NRZ stream for `code` (octal value, e.g. `0o23`), amplitude 0.15, fixed start. */
export function dcsMix(options: {
	rate: number
	seconds: number
	code: number
	polarity: "normal" | "inverted"
}): Float32Array {
	return Float32Array.from(
		dcsAudio({
			code: options.code,
			seconds: options.seconds,
			seed: 0,
			inverted: options.polarity === "inverted",
			rate: options.rate,
		}),
	)
}

/** A quieted carrier: low uniform residual noise of peak `noiseLevel` (default 0.001). */
export function carrierSilence(options: {
	rate: number
	seconds: number
	noiseLevel?: number
}): Float32Array {
	return whiteNoise({
		rate: options.rate,
		seconds: options.seconds,
		seed: 0,
		level: options.noiseLevel ?? 0.001,
	})
}

/**
 * Continuous-phase FSK bursts (`levels` tones spaced 600 Hz from 1 200 Hz, seeded symbols at
 * `baud`, amplitude 0.3) of `burstMs`, separated by `gapMs` of silence.
 */
export function fskBursts(options: {
	rate: number
	seconds: number
	levels: 2 | 4
	baud: number
	burstMs: number
	gapMs: number
	seed: number
}): Float32Array {
	const { rate } = options
	const rand = mulberry32(options.seed)
	const n = sampleCount(rate, options.seconds)
	const out = new Float32Array(n)
	const burst = Math.max(1, Math.round((options.burstMs * rate) / 1000))
	const period = burst + Math.round((options.gapMs * rate) / 1000)
	const symbol = Math.max(1, Math.round(rate / options.baud))
	let phase = 0
	let hz = 1200
	for (let i = 0; i < n; i++) {
		const inBurst = i % period
		if (inBurst >= burst) continue
		if (inBurst % symbol === 0)
			hz = 1200 + 600 * Math.floor(rand() * options.levels)
		phase += (2 * Math.PI * hz) / rate
		out[i] = 0.3 * Math.sin(phase)
	}
	return out
}

/** Clicks: about `perSecond` 2 ms decaying bursts of peak 0.8 at seeded positions. */
export function clicks(options: {
	rate: number
	seconds: number
	perSecond: number
	seed: number
}): Float32Array {
	const { rate } = options
	const rand = mulberry32(options.seed)
	const n = sampleCount(rate, options.seconds)
	const out = new Float32Array(n)
	const count = Math.round(options.perSecond * options.seconds)
	const length = Math.max(1, Math.round(0.002 * rate))
	for (let c = 0; c < count; c++) {
		const at = Math.floor(rand() * n)
		const sign = rand() < 0.5 ? -1 : 1
		for (let i = 0; i < length && at + i < n; i++)
			out[at + i] =
				sign * 0.8 * Math.exp(-(5 * i) / length) * (i % 2 === 0 ? 1 : -1)
	}
	return out
}

/** Sparse single-sample impulses of random sign at `level` (default 0.5), about `perSecond` (default 50). */
export function impulseNoise(options: {
	rate: number
	seconds: number
	seed: number
	level?: number
	perSecond?: number
}): Float32Array {
	const rand = mulberry32(options.seed)
	const n = sampleCount(options.rate, options.seconds)
	const out = new Float32Array(n)
	const level = options.level ?? 0.5
	const count = Math.round((options.perSecond ?? 50) * options.seconds)
	for (let c = 0; c < count; c++) {
		const at = Math.floor(rand() * n)
		out[at] = rand() < 0.5 ? -level : level
	}
	return out
}

/** Uniform white noise in [-level, level] (default 0.1). */
export function whiteNoise(options: {
	rate: number
	seconds: number
	seed: number
	level?: number
}): Float32Array {
	const rand = mulberry32(options.seed)
	const n = sampleCount(options.rate, options.seconds)
	const out = new Float32Array(n)
	const level = options.level ?? 0.1
	for (let i = 0; i < n; i++) out[i] = level * (2 * rand() - 1)
	return out
}

/** Sample-wise sum over the shorter length (a new array). */
export function mix(a: Float32Array, b: Float32Array): Float32Array {
	const n = Math.min(a.length, b.length)
	const out = new Float32Array(n)
	for (let i = 0; i < n; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0)
	return out
}

/** Full-scale samples to PCM bytes: s16le scales by 32 767 and clips; f32le is verbatim. */
export function toPcm(
	samples: Float32Array,
	format: EvidencePcmFormat,
): Buffer {
	if (format === "f32le") {
		const out = Buffer.alloc(samples.length * 4)
		for (let i = 0; i < samples.length; i++)
			out.writeFloatLE(samples[i] ?? 0, i * 4)
		return out
	}
	const out = Buffer.alloc(samples.length * 2)
	for (let i = 0; i < samples.length; i++) {
		const v = Math.round((samples[i] ?? 0) * 32_767)
		out.writeInt16LE(Math.max(-32_768, Math.min(32_767, v)), i * 2)
	}
	return out
}
