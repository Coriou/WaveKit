/**
 * Shared modulator for the synthetic digital-voice, paging and APRS frame
 * generators (scripts/fixtures/dv-frames.mjs). No side effects on import.
 *
 * Two steps, so a frame builder only produces symbols:
 *
 * 1. shapeFrequency: symbols -> instantaneous frequency deviation (Hz) at an
 *    audio-like rate (48 kHz by default), with raised-cosine, the standard
 *    4FSK transmit filters ("rrc", "c4fm", see pulseSpectrum), Gaussian
 *    (GMSK) or rectangular (2FSK pager) pulse shaping.
 *    afskFrequency does the same for Bell 202 AFSK (APRS): the tones are the
 *    modulating audio and the frequency is that audio times the deviation.
 * 2. fmCu8: the deviation, linearly interpolated to the capture rate, is
 *    integrated into the phase of a carrier at `offsetHz` from the capture
 *    centre and written as cu8 IQ (interleaved unsigned 8-bit I/Q, 127.5 is
 *    zero) with seeded Gaussian noise and leading/trailing noise only. With
 *    `cnrDb` the noise is set from a carrier-to-noise ratio instead
 *    (noiseForCnr).
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
 * One-sided amplitude spectrum of a 4FSK transmit filter at `x` = f / symbol
 * rate, for the shapes the air interfaces specify:
 *
 * - "rc": raised cosine, roll-off `alpha` (zero ISI at the symbol centres of
 *   the frequency trace itself);
 * - "rrc": root raised cosine (DMR, ETSI TS 102 361-1 10.2.2; dPMR, ETSI TS
 *   102 490; the MMDVM YSF transmitter), its receive filter is the same RRC;
 * - "c4fm": raised cosine times the inverse sinc x / sin x, x = pi f / Rs
 *   (P25 phase 1, TIA-102.BAAA 5.2: the Nyquist filter and the shaping
 *   filter), its receiver is an integrate-and-dump over one symbol, whose
 *   sinc response cancels the shaping filter.
 *
 * `isinc` multiplies any of them by x / sin x (NXDN, whose transmit filter is
 * a root raised cosine times x / sin x; its receive filter is a root raised
 * cosine times sin x / x).
 */
export function pulseSpectrum(x, { shaping, alpha, isinc = false }) {
	const a = Math.abs(x)
	const lo = (1 - alpha) / 2
	const hi = (1 + alpha) / 2
	let rc = 0
	if (a <= lo) rc = 1
	else if (a <= hi) rc = 0.5 * (1 + Math.cos((Math.PI / alpha) * (a - lo)))
	let v = shaping === "rrc" ? Math.sqrt(rc) : rc
	if (shaping === "c4fm" || isinc)
		v *= a < 1e-9 ? 1 : (Math.PI * a) / Math.sin(Math.PI * a)
	return v
}

/** Receive-filter spectrum that, with pulseSpectrum, gives a raised cosine. */
export function receiveSpectrum(x, { shaping, alpha, isinc = false }) {
	const a = Math.abs(x)
	let v = 1
	if (shaping === "rrc")
		v = Math.sqrt(pulseSpectrum(a, { shaping: "rc", alpha }))
	if (shaping === "c4fm" || isinc)
		v *= a < 1e-9 ? 1 : Math.sin(Math.PI * a) / (Math.PI * a)
	return v
}

/**
 * The transmit filter each air interface specifies (pulseSpectrum). YSF has
 * no public filter specification: "rrc" is the MMDVM transmitter's, and a
 * radio may use the P25 C4FM filter instead, so a margin test runs both. The
 * MMDVM P25 transmitter uses a plain raised cosine 0.2 (p25Rc).
 */
export const AIR_SHAPES = {
	p25: { shaping: "c4fm", alpha: 0.2 },
	// The MMDVM P25 transmitter: raised cosine 0.2 without the shaping filter.
	p25Rc: { shaping: "rc", alpha: 0.2 },
	dmr: { shaping: "rrc", alpha: 0.2 },
	dpmr: { shaping: "rrc", alpha: 0.2 },
	nxdn: { shaping: "rrc", alpha: 0.2, isinc: true },
	ysf: { shaping: "rrc", alpha: 0.2 },
	ysfC4fm: { shaping: "c4fm", alpha: 0.2 },
}

/** The shaping the existing chain tests use: raised cosine, roll-off 0.5. */
export const EASY_SHAPE = { shaping: "rc", alpha: 0.5 }

/**
 * Impulse response h(t), t in symbols, of a real even spectrum S(x) that is
 * zero above x = (1 + alpha) / 2: h(t) = 2 * integral of S(x) cos(2 pi x t)
 * over [0, (1 + alpha) / 2] (Simpson's rule). With S(0) = 1 the response
 * through the matching receiver (pulse times receive spectrum = raised
 * cosine) is 1 at t = 0 and 0 at every other symbol centre.
 */
export function pulseResponse(t, spectrum, alpha, steps = 600) {
	const top = (1 + alpha) / 2
	const h = top / steps
	let sum = 0
	for (let i = 0; i <= steps; i++) {
		const x = i * h
		const w = i === 0 || i === steps ? 1 : i % 2 === 1 ? 4 : 2
		sum += w * spectrum(x) * Math.cos(2 * Math.PI * x * t)
	}
	return (2 * sum * h) / 3
}

/**
 * Pulse h(t) of a numeric shaping, tabulated at 1/64 symbol over +-`span`
 * symbols and linearly interpolated (zero outside).
 */
function tabulatedPulse(shape, span) {
	const res = 64
	const table = new Float64Array(2 * span * res + 1)
	for (let i = 0; i < table.length; i++)
		table[i] = pulseResponse(
			i / res - span,
			x => pulseSpectrum(x, shape),
			shape.alpha,
		)
	return t => {
		const u = (t + span) * res
		if (u < 0 || u >= table.length - 1) return 0
		const j = Math.floor(u)
		return table[j] + (table[j + 1] - table[j]) * (u - j)
	}
}

/**
 * Instantaneous frequency (Hz) at `rateHz` for `symbols`, each mapped to a
 * deviation by `deviationHz(symbol)`. `shaping`: "rc" (raised cosine, roll-off
 * `alpha`), "rrc" or "c4fm" (pulseSpectrum, with `isinc`; the deviation is
 * the one at the symbol centres after the matching receive filter, as the
 * standards define it), "gauss" (rectangular NRZ through a Gaussian of
 * bandwidth-time `bt`, GMSK) or "rect". `padSymbols` of zero deviation (an
 * unmodulated carrier) frame the burst so the pulse tails are not cut.
 * `delaySymbols` (0 to 1, "rc"/"rrc"/"c4fm"/"gauss") delays every symbol by
 * that fraction of a symbol: a transmitter's symbol clock has no fixed phase
 * to the receiver's samples, and dsd-fme's decisions depend on that phase.
 * At 0 every shaping is the output it had before the option existed.
 */
export function shapeFrequency(
	symbols,
	{
		symbolRate,
		deviationHz,
		rateHz = 48_000,
		shaping = "rc",
		alpha = 0.2,
		isinc = false,
		bt = 0.5,
		padSymbols = 8,
		delaySymbols = 0,
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
	if (shaping === "rc" || shaping === "rrc" || shaping === "c4fm") {
		const span = 8
		const pulse =
			shaping === "rc" && !isinc
				? t => raisedCosine(t, alpha)
				: tabulatedPulse({ shaping, alpha, isinc }, span)
		for (let k = 0; k < values.length; k++) {
			const centre = (k + padSymbols + 0.5 + delaySymbols) * sps
			const lo = Math.max(0, Math.floor(centre - span * sps))
			const hi = Math.min(n - 1, Math.ceil(centre + span * sps))
			for (let i = lo; i <= hi; i++)
				out[i] += values[k] * pulse((i - centre) / sps)
		}
		return out
	}
	// Gaussian: NRZ convolved with a unit-area Gaussian, sigma in symbols
	// sqrt(ln 2) / (2 pi BT).
	// The NRZ edges move by delaySymbols; at 0 the index is the one it always was.
	const nrz = new Float64Array(n)
	const delay = delaySymbols * sps
	for (let i = 0; i < n; i++) {
		const k =
			(delay === 0 ? Math.floor(i / sps) : Math.floor((i - delay) / sps)) -
			padSymbols
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
 * Carrier amplitude and per-rail noise sigma (both of full scale) for a
 * carrier-to-noise ratio `cnrDb` measured in `noiseBandwidthHz` around the
 * carrier, at capture rate `sampleRateHz`. White complex noise of sigma s per
 * rail has power 2 s^2 over the capture rate, so 2 s^2 B / fs in the
 * bandwidth B, and CNR = A^2 / (2 s^2 B / fs). The total power
 * A^2 + 2 s^2 is held at 2 * `rms`^2 (rms per rail) so that cu8 neither
 * clips (4 sigma within full scale at the 0.25 default) nor loses the carrier
 * to quantisation at low CNR, as a receiver's gain setting would.
 */
export function noiseForCnr({
	cnrDb,
	sampleRateHz,
	noiseBandwidthHz = 12_500,
	rms = 0.25,
}) {
	const k = sampleRateHz / (2 * noiseBandwidthHz * 10 ** (cnrDb / 10))
	const amplitude = Math.sqrt((2 * rms * rms) / (1 + 2 * k))
	return { amplitude, noise: amplitude * Math.sqrt(k) }
}

/**
 * cu8 IQ for a frequency trace `freqHz` sampled at `freqRateHz`, on a carrier
 * at `offsetHz` from the capture centre. Amplitude `amplitude` of full scale,
 * complex noise sigma `noise` (of full scale per rail), `leadSeconds` of
 * noise only before and after. `cnrDb` (with `noiseBandwidthHz`) replaces
 * `amplitude` and `noise` by noiseForCnr (the CNR of the carrier while on).
 * `envelope`, at `freqRateHz` like `freqHz`, keys the carrier: its amplitude
 * times the envelope (0 to 1), as a TDMA radio's bursts.
 */
export function fmCu8(
	freqHz,
	{
		freqRateHz = 48_000,
		sampleRateHz = 1_024_000,
		offsetHz = 0,
		amplitude: carrier = 0.5,
		noise: sigma = 0.02,
		cnrDb,
		noiseBandwidthHz = 12_500,
		seed = 1,
		leadSeconds = 0.1,
		envelope,
	} = {},
) {
	const { amplitude, noise } =
		cnrDb === undefined
			? { amplitude: carrier, noise: sigma }
			: noiseForCnr({ cnrDb, sampleRateHz, noiseBandwidthHz })
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
			const a =
				envelope === undefined
					? amplitude
					: amplitude *
						(envelope[j] +
							(envelope[Math.min(envelope.length - 1, j + 1)] - envelope[j]) *
								(x - j))
			I = a * Math.cos(phase)
			Q = a * Math.sin(phase)
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
	for (let b = width - 1; b >= 0; b--) bits.push(Math.floor(value / 2 ** b) % 2)
	return bits
}

/** Bits (MSB first) of each byte. */
export function bytesToBits(bytes) {
	const bits = []
	for (const byte of bytes)
		for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1)
	return bits
}

/** Dibits (0..3) of a bit array, first bit most significant. */
export function bitsToDibits(bits) {
	const out = []
	for (let i = 0; i + 1 < bits.length; i += 2)
		out.push((bits[i] << 1) | bits[i + 1])
	return out
}
