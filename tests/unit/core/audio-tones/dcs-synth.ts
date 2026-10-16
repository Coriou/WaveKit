/**
 * Test-only DCS synthesis and no-DCS corpora. Every sample is computed from a seed; nothing is
 * stored. Rates are free, but the decoder expects 8 kHz (the tone detector's rate).
 */
import { DCS_BIT_RATE_BPS } from "@wavekit/api-types"
import { dtmfFreqs, gaussian, mulberry32 } from "./synth.js"

export const DCS_RATE_HZ = 8_000
export const MASK23 = 0x7fffff

export type BitOrder = "lsb" | "msb"

/** Golay(23,12) word: data = code | 0b100 << 9, word = data << 11 | parity (0xC75). */
export function dcsWord(code: number): number {
	const data = (code & 0x1ff) | (0b100 << 9)
	let r = data << 11
	for (let i = 22; i >= 11; i--) if (r & (1 << i)) r ^= 0xc75 << (i - 11)
	return ((data << 11) | r) & MASK23
}

/**
 * One word's 23 bits in transmission order. "lsb": data first, LSB first (bits 11..22 then
 * 0..10), the order the decoder expects. "msb": the reverse.
 */
export function wordBits(code: number, order: BitOrder = "lsb"): number[] {
	const word = dcsWord(code)
	const bits: number[] = []
	for (let i = 0; i < 23; i++) bits.push((word >>> ((11 + i) % 23)) & 1)
	return order === "lsb" ? bits : bits.reverse()
}

/** `words` repeated words starting `startBit` bits into the cycle, optionally inverted. */
export function dcsBitStream(options: {
	code: number
	bits: number
	startBit?: number
	inverted?: boolean
	order?: BitOrder
}): Uint8Array {
	const word = wordBits(options.code, options.order ?? "lsb")
	const out = new Uint8Array(options.bits)
	const start = options.startBit ?? 0
	for (let i = 0; i < options.bits; i++) {
		const bit = word[(start + i) % 23] ?? 0
		out[i] = options.inverted === true ? bit ^ 1 : bit
	}
	return out
}

/** Clean NRZ at 134.4 bit/s: bit 1 = +amplitude. `offset` samples of the first bit are skipped. */
export function nrz(
	bits: ArrayLike<number>,
	options: {
		amplitude?: number
		rate?: number
		offset?: number
		dc?: number
	} = {},
): Float64Array {
	const rate = options.rate ?? DCS_RATE_HZ
	const spb = rate / DCS_BIT_RATE_BPS
	const offset = options.offset ?? 0
	const amplitude = options.amplitude ?? 0.2
	const n = Math.max(0, Math.floor(bits.length * spb - offset))
	const out = new Float64Array(n)
	for (let i = 0; i < n; i++) {
		const bit = bits[Math.floor((i + offset) / spb)] ?? 0
		out[i] = (bit === 1 ? amplitude : -amplitude) + (options.dc ?? 0)
	}
	return out
}

/** In-place 2nd-order Butterworth low-pass (transmitter shaping). */
export function lowpassInPlace(
	x: Float64Array,
	hz: number,
	rate: number,
): Float64Array {
	const w0 = (2 * Math.PI * hz) / rate
	const cos = Math.cos(w0)
	const alpha = Math.sin(w0) / Math.SQRT2
	const a0 = 1 + alpha
	const b0 = (1 - cos) / 2 / a0
	const b1 = (1 - cos) / a0
	const a1 = (-2 * cos) / a0
	const a2 = (1 - alpha) / a0
	let s1 = 0
	let s2 = 0
	for (let i = 0; i < x.length; i++) {
		const v = x[i] ?? 0
		const y = b0 * v + s1
		s1 = b1 * v - a1 * y + s2
		s2 = b0 * v - a2 * y
		x[i] = y
	}
	return x
}

/** Shaped DCS audio: random start bit and sub-bit phase, low-pass at 250 Hz. */
export function dcsAudio(options: {
	code: number
	seconds: number
	seed: number
	inverted?: boolean
	amplitude?: number
	rate?: number
	order?: BitOrder
}): Float64Array {
	const rand = mulberry32(options.seed)
	const rate = options.rate ?? DCS_RATE_HZ
	const bits = Math.ceil(options.seconds * DCS_BIT_RATE_BPS) + 2
	const stream = dcsBitStream({
		code: options.code,
		bits,
		startBit: Math.floor(rand() * 23),
		inverted: options.inverted ?? false,
		order: options.order ?? "lsb",
	})
	const audio = nrz(stream, {
		amplitude: options.amplitude ?? 0.15,
		rate,
		offset: rand() * (rate / DCS_BIT_RATE_BPS),
	})
	return lowpassInPlace(audio, 250, rate).subarray(
		0,
		Math.round(options.seconds * rate),
	)
}

/**
 * Speech-like audio: syllables of 80-300 ms with random envelopes and gaps, each a pitch
 * harmonic series (f0 85-260 Hz) weighted by three formant bumps, so low harmonics sit in the
 * DCS band. `highPass300` removes content below 300 Hz as a transmitter's voice filter would.
 */
export function speechLike(options: {
	seconds: number
	seed: number
	amplitude?: number
	rate?: number
}): Float64Array {
	const rand = mulberry32(options.seed)
	const rate = options.rate ?? DCS_RATE_HZ
	const n = Math.round(options.seconds * rate)
	const out = new Float64Array(n)
	const peak = options.amplitude ?? 0.5
	let at = 0
	while (at < n) {
		const length = Math.round((0.08 + rand() * 0.22) * rate)
		const gap = Math.round(rand() * 0.15 * rate)
		const f0 = 85 + rand() * 175
		const glide = (rand() - 0.5) * 40
		const formants = [
			300 + rand() * 600,
			900 + rand() * 1500,
			2200 + rand() * 1000,
		]
		const level = peak * (0.3 + rand() * 0.7)
		const harmonics = Math.min(24, Math.floor(3400 / f0))
		const weights: number[] = []
		for (let h = 1; h <= harmonics; h++) {
			let w = 0
			for (const f of formants) w += Math.exp(-(((h * f0 - f) / 150) ** 2))
			weights.push(w / h ** 0.5 + 0.02)
		}
		const phase0 = rand() * 2 * Math.PI
		let phase = 0
		for (let i = 0; i < length && at + i < n; i++) {
			const t = i / length
			const env = Math.sin(Math.PI * t) ** 2
			phase += (2 * Math.PI * (f0 + glide * t)) / rate
			let v = 0
			for (let h = 0; h < weights.length; h++)
				v += (weights[h] ?? 0) * Math.sin((h + 1) * phase + h * phase0)
			out[at + i] = (level * env * v) / 3
		}
		at += length + gap
	}
	return out
}

export function whiteNoise(options: {
	seconds: number
	seed: number
	std: number
	rate?: number
}): Float64Array {
	const rand = mulberry32(options.seed)
	const n = Math.round(options.seconds * (options.rate ?? DCS_RATE_HZ))
	const out = new Float64Array(n)
	for (let i = 0; i < n; i++) out[i] = options.std * gaussian(rand)
	return out
}

/** Pink noise (Paul Kellet's economy filter over white noise). */
export function pinkNoise(options: {
	seconds: number
	seed: number
	std: number
	rate?: number
}): Float64Array {
	const white = whiteNoise({ ...options, std: 1 })
	let b0 = 0
	let b1 = 0
	let b2 = 0
	for (let i = 0; i < white.length; i++) {
		const w = white[i] ?? 0
		b0 = 0.99765 * b0 + w * 0.099046
		b1 = 0.963 * b1 + w * 0.2965164
		b2 = 0.57 * b2 + w * 1.0526913
		white[i] = (b0 + b1 + b2 + w * 0.1848) * options.std * 0.3
	}
	return white
}

export function ctcssTone(options: {
	hz: number
	seconds: number
	seed: number
	amplitude?: number
	rate?: number
}): Float64Array {
	const rand = mulberry32(options.seed)
	const rate = options.rate ?? DCS_RATE_HZ
	const n = Math.round(options.seconds * rate)
	const out = new Float64Array(n)
	const phase = rand() * 2 * Math.PI
	const amplitude = options.amplitude ?? 0.15
	for (let i = 0; i < n; i++)
		out[i] = amplitude * Math.sin((2 * Math.PI * options.hz * i) / rate + phase)
	return out
}

/** Random DTMF digits, 40-120 ms on, 40-120 ms off. */
export function dtmfAudio(options: {
	seconds: number
	seed: number
	amplitude?: number
	rate?: number
}): Float64Array {
	const rand = mulberry32(options.seed)
	const rate = options.rate ?? DCS_RATE_HZ
	const n = Math.round(options.seconds * rate)
	const out = new Float64Array(n)
	const amplitude = options.amplitude ?? 0.3
	const grid = "123A456B789C*0#D"
	let at = 0
	while (at < n) {
		const { row, col } = dtmfFreqs(grid[Math.floor(rand() * 16)] ?? "1")
		const on = Math.round((0.04 + rand() * 0.08) * rate)
		for (let i = 0; i < on && at + i < n; i++)
			out[at + i] =
				amplitude *
				(Math.sin((2 * Math.PI * row * i) / rate) +
					Math.sin((2 * Math.PI * col * i) / rate))
		at += on + Math.round((0.04 + rand() * 0.08) * rate)
	}
	return out
}

/** a += scale * b over the shorter length; returns a. */
export function mixInto(
	a: Float64Array,
	b: Float64Array,
	scale = 1,
): Float64Array {
	const n = Math.min(a.length, b.length)
	for (let i = 0; i < n; i++) a[i] = (a[i] ?? 0) + scale * (b[i] ?? 0)
	return a
}
