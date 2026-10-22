/**
 * Deterministic cf32 captures for the analog replay trial.
 *
 * 48 kHz interleaved little-endian float32, the capture file layout. Every
 * sample comes from `seed` (taken as a uint32) and the kind. Channel SNR is
 * `A² / (2 σ²)` with carrier amplitude 1, the same definition as the
 * `wavekit-iqcap` analyze noise test. `noise` is complex gaussian σ = 1 and
 * does not use `snrDb`.
 *
 * NFM voice is a 4 Hz syllabic envelope over a multitone from 1.8 kHz.
 * Those tones sit above the CTCSS detector band. DCS 023 (normal,
 * LSB-first Golay) is the same waveform the detector decodes once analyze
 * keeps the sub-audible band. 4FSK uses four tones. `gfsk-bt1` is gaussian
 * 2FSK at 4 800 symbols/s, BT 1, deviation ±Rs/2. `gmsk` is BT 0.3 and
 * h = 0.5 (deviation ±Rs/4). `am-voice` is a 4 Hz syllabic envelope over
 * tones from 800 Hz, amplitude-modulated on a 0 Hz carrier.
 */
import { DCS_BIT_RATE_BPS } from "@wavekit/api-types"

export const ANALOG_SYNTH_RATE_HZ = 48_000
/** One capture, the WG11 maximum. */
export const ANALOG_SYNTH_MAX_SECONDS = 4

export type AnalogSynthKind =
	| "nfm-voice"
	| "nfm-ctcss"
	| "nfm-dcs"
	| "fsk4-4800"
	| "fsk4-2400"
	| "gfsk-bt1"
	| "gmsk"
	| "am-voice"
	| "carrier"
	| "noise"

export interface AnalogSynthRequest {
	kind: AnalogSynthKind
	/** Complex-baseband SNR in dB. Unused by `noise`. */
	snrDb: number
	seconds: number
	seed: number
}

const KINDS: ReadonlySet<string> = new Set<AnalogSynthKind>([
	"nfm-voice",
	"nfm-ctcss",
	"nfm-dcs",
	"fsk4-4800",
	"fsk4-2400",
	"gfsk-bt1",
	"gmsk",
	"am-voice",
	"carrier",
	"noise",
])

const DCS_CODE_023 = 0o023
const DCS_WORD_BITS = 23
const MASK23 = 0x7fffff

/** Interleaved I,Q. Same request → same bytes. */
export function synthesizeAnalogIq(request: AnalogSynthRequest): Float32Array {
	if (!KINDS.has(request.kind)) throw new RangeError("analog synth kind")
	if (!Number.isFinite(request.snrDb)) throw new RangeError("analog synth snr")
	if (
		!Number.isFinite(request.seconds) ||
		request.seconds <= 0 ||
		request.seconds > ANALOG_SYNTH_MAX_SECONDS
	)
		throw new RangeError("analog synth seconds")
	if (!Number.isFinite(request.seed)) throw new RangeError("analog synth seed")
	const rate = ANALOG_SYNTH_RATE_HZ
	const n = Math.round(request.seconds * rate)
	const rng = mulberry32(mixSeed(request.seed, request.kind))
	const iq = new Float32Array(n * 2)
	if (request.kind === "noise") {
		for (let k = 0; k < n; k++) {
			const [i, q] = gauss(rng)
			iq[k * 2] = i
			iq[k * 2 + 1] = q
		}
		return iq
	}
	const snr = 10 ** (request.snrDb / 10)
	const sigma = Math.sqrt(1 / (2 * snr))
	if (request.kind === "am-voice") {
		writeAmVoice(iq, n, rate, sigma, rng)
		return iq
	}
	const mod = modulator(request.kind, n, rate, rng)
	let phase = 0
	for (let k = 0; k < n; k++) {
		phase += (2 * Math.PI * (mod[k] ?? 0)) / rate
		const [ni, nq] = gauss(rng)
		iq[k * 2] = Math.cos(phase) + sigma * ni
		iq[k * 2 + 1] = Math.sin(phase) + sigma * nq
	}
	return iq
}

function modulator(
	kind: AnalogSynthKind,
	n: number,
	rate: number,
	rng: () => number,
): Float64Array {
	if (kind === "carrier") return filled(n, 1_000)
	if (kind === "fsk4-4800") return fsk4(n, rate, 4_800, rng)
	if (kind === "fsk4-2400") return fsk4(n, rate, 2_400, rng)
	if (kind === "gfsk-bt1") return gfskBt1(n, rate, rng)
	if (kind === "gmsk") return gmsk(n, rate, rng)
	const voice = voiceHz(n, rate)
	if (kind === "nfm-voice") return voice
	if (kind === "nfm-ctcss") {
		for (let k = 0; k < n; k++) {
			const t = k / rate
			voice[k] = (voice[k] ?? 0) + 700 * Math.sin(2 * Math.PI * 88.5 * t)
		}
		return voice
	}
	const dcs = dcsHz(n, rate, rng)
	for (let k = 0; k < n; k++) voice[k] = (voice[k] ?? 0) * 0.85 + (dcs[k] ?? 0)
	return voice
}

/**
 * 4 Hz envelope over tones from 1.8 kHz. Peak deviation stays under 3 kHz.
 * A component near 500 Hz leaks through the CTCSS detector's 400 Hz
 * high-pass subtract and hides 88.5 Hz; these tones do not.
 */
function voiceHz(n: number, rate: number): Float64Array {
	const out = new Float64Array(n)
	for (let k = 0; k < n; k++) {
		const t = k / rate
		const env = 0.4 + 0.6 * Math.sin(2 * Math.PI * 4 * t)
		const shape =
			0.5 * Math.sin(2 * Math.PI * 1_800 * t) +
			0.35 * Math.sin(2 * Math.PI * 2_300 * t) +
			0.25 * Math.sin(2 * Math.PI * 2_700 * t) +
			0.15 * Math.sin(2 * Math.PI * 3_100 * t)
		out[k] = 2_200 * env * shape
	}
	return out
}

function fsk4(
	n: number,
	rate: number,
	symbolsPerSec: number,
	rng: () => number,
): Float64Array {
	// 4 800 sym/s at ±3 600 Hz clusters at 0.5 when SNR is 10 dB (threshold
	// 0.6). ±4 500 / ±1 500 keeps the same ratio and clears 0.6. 2 400 sym/s
	// already clears it at ±1 800 / ±600, inside the 2 400 Hz discriminator
	// low-pass.
	const levels =
		symbolsPerSec === 4_800
			? [-4_500, -1_500, 1_500, 4_500]
			: [-1_800, -600, 600, 1_800]
	const sps = Math.max(1, Math.round(rate / symbolsPerSec))
	const out = new Float64Array(n)
	let tone = levels[0] ?? 0
	for (let k = 0; k < n; k++) {
		if (k % sps === 0) tone = levels[Math.floor(rng() * levels.length)] ?? tone
		out[k] = tone
	}
	return out
}

/**
 * Gaussian 2FSK at 4 800 symbols/s, BT 1, deviation ±Rs/2. The wide BT
 * opens the eye (cluster about 0.7 at 10 dB) without moving the 0.6
 * threshold. This is not GMSK.
 */
function gfskBt1(n: number, rate: number, rng: () => number): Float64Array {
	return gaussian2fsk(n, rate, rng, 1, 4, 2)
}

/**
 * GMSK: BT 0.3, modulation index h = 0.5, so the deviation is ±Rs/4 at
 * 4 800 symbols/s.
 */
function gmsk(n: number, rate: number, rng: () => number): Float64Array {
	return gaussian2fsk(n, rate, rng, 0.3, 3, 4)
}

function gaussian2fsk(
	n: number,
	rate: number,
	rng: () => number,
	bt: number,
	span: number,
	deviationDivisor: number,
): Float64Array {
	const rs = 4_800
	const sps = Math.round(rate / rs)
	const taps = gaussianTaps(bt, sps, span)
	const held = new Float64Array(n)
	let symbol = 1
	for (let k = 0; k < n; k++) {
		if (k % sps === 0) symbol = rng() < 0.5 ? -1 : 1
		held[k] = symbol
	}
	const shaped = new Float64Array(n)
	const mid = (taps.length - 1) >> 1
	for (let k = 0; k < n; k++) {
		let acc = 0
		for (let t = 0; t < taps.length; t++) {
			const i = k - mid + t
			const x = i >= 0 && i < n ? (held[i] ?? 0) : 0
			acc += (taps[t] ?? 0) * x
		}
		shaped[k] = acc * (rs / deviationDivisor)
	}
	return shaped
}

/**
 * Continuous AM voice. The carrier is 0 Hz at mean amplitude 1 (about
 * 0 dBFS). A 4 Hz syllabic envelope multiplies tones from 800 Hz, inside
 * the 300–3 000 Hz voice band, and the envelope stays positive. Channel
 * SNR uses the same `A² / (2 σ²)` definition with A = 1.
 */
function writeAmVoice(
	iq: Float32Array,
	n: number,
	rate: number,
	sigma: number,
	rng: () => number,
): void {
	for (let k = 0; k < n; k++) {
		const t = k / rate
		const syllabic = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t))
		const voice =
			0.45 * Math.sin(2 * Math.PI * 800 * t) +
			0.35 * Math.sin(2 * Math.PI * 1_300 * t) +
			0.25 * Math.sin(2 * Math.PI * 1_900 * t)
		const envelope = 1 + 0.8 * syllabic * (voice / 1.05)
		const [ni, nq] = gauss(rng)
		iq[k * 2] = envelope + sigma * ni
		iq[k * 2 + 1] = sigma * nq
	}
}

function gaussianTaps(bt: number, sps: number, span: number): Float64Array {
	const n = span * sps + 1
	const taps = new Float64Array(n)
	const sigma = (sps * Math.sqrt(Math.LN2)) / (2 * Math.PI * bt)
	const mid = (n - 1) / 2
	let sum = 0
	for (let i = 0; i < n; i++) {
		const x = sigma === 0 ? 0 : (i - mid) / sigma
		const y = Math.exp(-0.5 * x * x)
		taps[i] = y
		sum += y
	}
	if (sum > 0) for (let i = 0; i < n; i++) taps[i] = (taps[i] ?? 0) / sum
	return taps
}

/** DCS 023 normal, LSB first, ±750 Hz, low-passed near 250 Hz. */
function dcsHz(n: number, rate: number, rng: () => number): Float64Array {
	const bits = dcsBits(
		Math.ceil((n / rate) * DCS_BIT_RATE_BPS) + DCS_WORD_BITS,
		rng,
	)
	const spb = rate / DCS_BIT_RATE_BPS
	const raw = new Float64Array(n)
	for (let k = 0; k < n; k++) {
		const bit = bits[Math.floor(k / spb) % bits.length] ?? 0
		raw[k] = bit === 1 ? 750 : -750
	}
	return lowpass(raw, 250, rate)
}

function dcsBits(n: number, rng: () => number): Uint8Array {
	const word = wordBits(DCS_CODE_023)
	const start = Math.floor(rng() * DCS_WORD_BITS)
	const out = new Uint8Array(n)
	for (let i = 0; i < n; i++) out[i] = word[(start + i) % DCS_WORD_BITS] ?? 0
	return out
}

/** Data bits first, LSB first: bits 11..22 of the Golay word, then 0..10. */
function wordBits(code: number): Uint8Array {
	const word = golayWord(code)
	const bits = new Uint8Array(DCS_WORD_BITS)
	for (let i = 0; i < DCS_WORD_BITS; i++)
		bits[i] = (word >>> ((11 + i) % DCS_WORD_BITS)) & 1
	return bits
}

function golayWord(code: number): number {
	const data = (code & 0x1ff) | (0b100 << 9)
	let r = data << 11
	for (let i = 22; i >= 11; i--) if (r & (1 << i)) r ^= 0xc75 << (i - 11)
	return ((data << 11) | r) & MASK23
}

function lowpass(x: Float64Array, hz: number, rate: number): Float64Array {
	const w0 = (2 * Math.PI * hz) / rate
	const cos = Math.cos(w0)
	const alpha = Math.sin(w0) / Math.SQRT2
	const a0 = 1 + alpha
	const b0 = (1 - cos) / 2 / a0
	const b1 = (1 - cos) / a0
	const a1 = (-2 * cos) / a0
	const a2 = (1 - alpha) / a0
	const out = new Float64Array(x.length)
	let s1 = 0
	let s2 = 0
	for (let i = 0; i < x.length; i++) {
		const v = x[i] ?? 0
		const y = b0 * v + s1
		s1 = b1 * v - a1 * y + s2
		s2 = b0 * v - a2 * y
		out[i] = y
	}
	return out
}

function filled(n: number, hz: number): Float64Array {
	const out = new Float64Array(n)
	out.fill(hz)
	return out
}

function mixSeed(seed: number, kind: AnalogSynthKind): number {
	let h = 0
	for (let i = 0; i < kind.length; i++)
		h = Math.imul(h ^ kind.charCodeAt(i), 0x9e3779b1)
	return (seed ^ h) >>> 0
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) | 0
		let t = Math.imul(state ^ (state >>> 15), 1 | state)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function gauss(rng: () => number): [number, number] {
	const u = Math.max(rng(), 1e-12)
	const v = rng()
	const radius = Math.sqrt(-2 * Math.log(u))
	const theta = 2 * Math.PI * v
	return [radius * Math.cos(theta), radius * Math.sin(theta)]
}
