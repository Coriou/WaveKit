/**
 * Shared modulator for the synthetic digital-voice, paging and APRS frame
 * generators (scripts/fixtures/dv-frames.mjs). No side effects on import.
 *
 * Two steps, so a frame builder only produces symbols:
 *
 * 1. shapeFrequency: symbols -> instantaneous frequency deviation (Hz) at an
 *    audio-like rate (48 kHz by default), with raised-cosine (4FSK C4FM
 *    family), Gaussian (GMSK) or rectangular (2FSK pager) pulse shaping.
 *    afskFrequency does the same for Bell 202 AFSK (APRS): the tones are the
 *    modulating audio and the frequency is that audio times the deviation.
 * 2. fmCu8: the deviation, linearly interpolated to the capture rate, is
 *    integrated into the phase of a carrier at `offsetHz` from the capture
 *    centre and written as cu8 IQ (interleaved unsigned 8-bit I/Q, 127.5 is
 *    zero) with seeded Gaussian noise and leading/trailing noise only.
 *
 * fmAudioS16 is the audio the core's FM discriminator chain would produce
 * from the same deviation (csdr fmdemod, gain, limit, s16), for tests that
 * check a frame builder against a decoder without IQ.
 */

/** Seeded uniform PRNG (mulberry32). */
export function rng(seed) {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/** Raised-cosine pulse (1 at t = 0, zero at every other symbol centre). */
function raisedCosine(t, alpha) {
	if (Math.abs(t) < 1e-12) return 1
	const den = 1 - (2 * alpha * t) ** 2
	const sinc = Math.sin(Math.PI * t) / (Math.PI * t)
	if (Math.abs(den) < 1e-9) return (Math.PI / 4) * sinc
	return (sinc * Math.cos(Math.PI * alpha * t)) / den
}

/**
 * Instantaneous frequency (Hz) at `rateHz` for `symbols`, each mapped to a
 * deviation by `deviationHz(symbol)`. `shaping`: "rc" (raised cosine, roll-off
 * `alpha`), "gauss" (rectangular NRZ through a Gaussian of bandwidth-time
 * `bt`, GMSK) or "rect". `padSymbols` of zero deviation (an unmodulated
 * carrier) frame the burst so the pulse tails are not cut.
 */
export function shapeFrequency(
	symbols,
	{
		symbolRate,
		deviationHz,
		rateHz = 48_000,
		shaping = "rc",
		alpha = 0.2,
		bt = 0.5,
		padSymbols = 8,
	},
) {
	const sps = rateHz / symbolRate
	const total = symbols.length + 2 * padSymbols
	const n = Math.ceil(total * sps)
	const out = new Float64Array(n)
	const values = symbols.map(deviationHz)
	if (shaping === "rect") {
		for (let i = 0; i < n; i++) {
			const k = Math.floor(i / sps) - padSymbols
			out[i] = k >= 0 && k < values.length ? values[k] : 0
		}
		return out
	}
	if (shaping === "rc") {
		const span = 8
		for (let k = 0; k < values.length; k++) {
			const centre = (k + padSymbols + 0.5) * sps
			const lo = Math.max(0, Math.floor(centre - span * sps))
			const hi = Math.min(n - 1, Math.ceil(centre + span * sps))
			for (let i = lo; i <= hi; i++)
				out[i] += values[k] * raisedCosine((i - centre) / sps, alpha)
		}
		return out
	}
	// Gaussian: NRZ convolved with a unit-area Gaussian, sigma in symbols
	// sqrt(ln 2) / (2 pi BT).
	const nrz = new Float64Array(n)
	for (let i = 0; i < n; i++) {
		const k = Math.floor(i / sps) - padSymbols
		nrz[i] = k >= 0 && k < values.length ? values[k] : 0
	}
	const sigma = (Math.sqrt(Math.log(2)) / (2 * Math.PI * bt)) * sps
	const half = Math.ceil(4 * sigma)
	const kernel = []
	let sum = 0
	for (let j = -half; j <= half; j++) {
		const v = Math.exp(-(j * j) / (2 * sigma * sigma))
		kernel.push(v)
		sum += v
	}
	for (let i = 0; i < n; i++) {
		let acc = 0
		for (let j = -half; j <= half; j++) {
			const x = i + j
			if (x >= 0 && x < n) acc += nrz[x] * kernel[j + half]
		}
		out[i] = acc / sum
	}
	return out
}

/**
 * Bell 202 AFSK (1200 Hz mark = bit 1, 2200 Hz space = bit 0, phase
 * continuous) as FM deviation: the tone times `deviationHz`. `bits` are line
 * bits after NRZI.
 */
export function afskFrequency(
	bits,
	{
		baud = 1200,
		markHz = 1200,
		spaceHz = 2200,
		deviationHz = 3000,
		rateHz = 48_000,
		padSeconds = 0.05,
	} = {},
) {
	const pad = Math.round(padSeconds * rateHz)
	const body = Math.ceil((bits.length / baud) * rateHz)
	const out = new Float64Array(pad + body + pad)
	let phase = 0
	for (let i = 0; i < body; i++) {
		const bit = bits[Math.min(bits.length - 1, Math.floor((i * baud) / rateHz))]
		phase += (2 * Math.PI * (bit ? markHz : spaceHz)) / rateHz
		out[pad + i] = deviationHz * Math.sin(phase)
	}
	return out
}

/**
 * cu8 IQ for a frequency trace `freqHz` sampled at `freqRateHz`, on a carrier
 * at `offsetHz` from the capture centre. Amplitude `amplitude` of full scale,
 * complex noise sigma `noise` (of full scale per rail), `leadSeconds` of
 * noise only before and after. `gapSeconds` > 0 repeats the burst `repeat`
 * times with that much noise in between.
 */
export function fmCu8(
	freqHz,
	{
		freqRateHz = 48_000,
		sampleRateHz = 1_024_000,
		offsetHz = 0,
		amplitude = 0.5,
		noise = 0.02,
		seed = 1,
		leadSeconds = 0.1,
	} = {},
) {
	const lead = Math.round(leadSeconds * sampleRateHz)
	const burst = Math.floor(((freqHz.length - 1) / freqRateHz) * sampleRateHz)
	const n = lead + burst + lead
	const out = Buffer.alloc(2 * n)
	const random = rng(seed)
	const gauss = () =>
		Math.sqrt(-2 * Math.log(random() || 1e-12)) *
		Math.cos(2 * Math.PI * random())
	const step = freqRateHz / sampleRateHz
	let phase = 0
	for (let i = 0; i < n; i++) {
		let I = 0
		let Q = 0
		const k = i - lead
		if (k >= 0 && k < burst) {
			const x = k * step
			const j = Math.floor(x)
			const f0 = freqHz[j]
			const f1 = freqHz[Math.min(freqHz.length - 1, j + 1)]
			const f = offsetHz + f0 + (f1 - f0) * (x - j)
			phase += (2 * Math.PI * f) / sampleRateHz
			if (phase > Math.PI) phase -= 2 * Math.PI
			else if (phase < -Math.PI) phase += 2 * Math.PI
			I = amplitude * Math.cos(phase)
			Q = amplitude * Math.sin(phase)
		}
		I += noise * gauss()
		Q += noise * gauss()
		out[2 * i] = Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * I)))
		out[2 * i + 1] = Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * Q)))
	}
	return out
}

/**
 * S16LE mono audio at `rateHz` as the core's discriminator chain makes it:
 * csdr fmdemod (2 f / rate), `gain`, csdr limit (clamp to +-1), s16.
 */
export function fmAudioS16(freqHz, { rateHz = 48_000, gain = 2 } = {}) {
	const out = Buffer.alloc(2 * freqHz.length)
	for (let i = 0; i < freqHz.length; i++) {
		const v = Math.max(-1, Math.min(1, (gain * 2 * freqHz[i]) / rateHz))
		out.writeInt16LE(Math.round(v * 32_767), 2 * i)
	}
	return out
}

/** Big-endian bits (0/1) of `value`, `width` bits wide (width <= 52). */
export function bitsOf(value, width) {
	const bits = []
	for (let b = width - 1; b >= 0; b--)
		bits.push(Math.floor(value / 2 ** b) % 2)
	return bits
}

/** Bits (MSB first) of each byte. */
export function bytesToBits(bytes) {
	const bits = []
	for (const byte of bytes) for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1)
	return bits
}

/** Dibits (0..3) of a bit array, first bit most significant. */
export function bitsToDibits(bits) {
	const out = []
	for (let i = 0; i + 1 < bits.length; i += 2) out.push((bits[i] << 1) | bits[i + 1])
	return out
}
