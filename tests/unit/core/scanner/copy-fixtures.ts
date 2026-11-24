/**
 * MODELLED fixtures for copy (ghost) detection: nothing here is a recording of a real signal, and
 * every frequency is a made-up offset inside a synthetic 96 kS/s capture.
 *
 * - talker(seed): a seeded speech-like modulator at 8 kHz: syllables of 80 to 350 ms (raised
 *   cosine edges, a plateau between), pauses of 0 to 600 ms, a pitch of 90 to 250 Hz gliding per syllable,
 *   voiced syllables (harmonics with formant-like weighting) with a share of 0.6 to 0.8, the rest
 *   unvoiced (noise).
 * - mixedStream(spec): ONE shared IQ stream: FM voices and unmodulated carriers at chosen offsets,
 *   an optional bursty strong blocker (an unmodulated carrier keyed on and off at seeded 0.2 to
 *   2 s), one common Gaussian noise floor, and one front-end nonlinearity y = x + a3·x·|x|²
 *   (third order: the 2·f1 − f2 products of every pair land in the stream), as CU8.
 * - channelAudio(stream, offsetHz): that offset demodulated by WidebandNfmChain (the recorder's
 *   chain) to 8 kHz audio; channelEnvelope: SpeechContentMeter's copy fingerprint of it, so every
 *   channel's frames share one sample clock (frame k = IQ sample k·256·12).
 */
import { mulberry32 } from "../../../mocks/scanner/signals.js"
import { WidebandNfmChain } from "../../../../src/core/scanner/channel/wideband-nfm.js"
import { SpeechContentMeter } from "../../../../src/core/scanner/channel/speech-content.js"
import {
	COPY_FRAME_SAMPLES,
	COPY_MAX_FRAMES,
	type CopyEnvelope,
} from "../../../../src/core/scanner/channel/copy-fingerprint.js"

export const MIX_FS = 96_000
/** IQ samples per 8 kHz audio sample. */
export const MIX_DECIMATION = MIX_FS / 8_000
/** IQ samples per copy frame: 256 · 12 = 3 072. */
export const MIX_SAMPLES_PER_FRAME = COPY_FRAME_SAMPLES * MIX_DECIMATION
const TWO_PI = 2 * Math.PI
const AUDIO_FS = 8_000

export interface TalkerOptions {
	readonly seed: number
	readonly seconds: number
	/** Peak deviation (Hz); default 2 400 (a 12.5 kHz channel); 5 000 for 25 kHz. */
	readonly peakHz?: number
	/** Transmitter pre-emphasis (first order, 6 dB/octave over about 300 Hz); default off. */
	readonly preEmphasis?: boolean
}

/** A seeded speech-like deviation waveform (Hz) at 8 kHz. */
export function talker(o: TalkerOptions): Float32Array {
	const rng = mulberry32(o.seed)
	const n = Math.round(o.seconds * AUDIO_FS)
	const out = new Float32Array(n)
	const pitchBase = 90 + rng() * 160
	const voicedShare = 0.6 + rng() * 0.2
	let at = Math.floor(rng() * 0.3 * AUDIO_FS)
	while (at < n) {
		const len = Math.round((0.08 + rng() * 0.27) * AUDIO_FS)
		const voiced = rng() < voicedShare
		const pitch = pitchBase * (0.9 + rng() * 0.2)
		const glide = (rng() - 0.5) * 0.15
		const f1 = 400 + rng() * 500
		const f2 = 1_100 + rng() * 900
		const gain = 0.5 + rng() * 0.5
		const phases = new Float64Array(26)
		for (let i = 0; i < len && at + i < n; i++) {
			const t = i / len
			// A plateau with 20 % raised-cosine edges (voicing holds through the syllable).
			const edge = Math.min(1, t / 0.2, (1 - t) / 0.2)
			const e = gain * 0.5 * (1 - Math.cos(Math.PI * edge))
			let v = 0
			if (voiced) {
				const f0 = pitch * (1 + glide * t)
				let norm = 0
				for (let h = 1; h <= 25; h++) {
					const f = f0 * h
					if (f > 3_400) break
					const a =
						0.1 +
						Math.exp(-(((f - f1) / 250) ** 2)) +
						0.6 * Math.exp(-(((f - f2) / 400) ** 2))
					phases[h] = (phases[h]! + (TWO_PI * f) / AUDIO_FS) % TWO_PI
					v += a * Math.sin(phases[h]!)
					norm += a
				}
				v /= Math.max(1, norm / 2)
			} else v = 0.7 * (2 * rng() - 1)
			out[at + i] = e * v
		}
		at += len
		// A pause of 0 to 600 ms after the syllable, about one in three.
		if (rng() < 0.35) at += Math.round(rng() * 0.6 * AUDIO_FS)
	}
	const peak = o.peakHz ?? 2_400
	if (o.preEmphasis === true) {
		let prev = 0
		for (let i = 0; i < n; i++) {
			const x = out[i]!
			out[i] = (x - 0.8 * prev) * 2.5
			prev = x
		}
	}
	let max = 0
	for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(out[i]!))
	const scale = max > 0 ? peak / max : 0
	for (let i = 0; i < n; i++) out[i] = out[i]! * scale
	return out
}

export interface StreamVoice {
	readonly offsetHz: number
	/** Carrier amplitude (full scale 1). */
	readonly amp: number
	/** Deviation at 8 kHz (talker), or null for an unmodulated carrier. */
	readonly deviation: Float32Array | null
	/** A sub-tone (Hz) added at 350 Hz deviation. */
	readonly ctcssHz?: number
	/** Carrier on only inside these [from s, to s) spans; default always on. */
	readonly keyed?: readonly (readonly [number, number])[]
}

export interface StreamSpec {
	readonly seconds: number
	readonly seed: number
	readonly voices: readonly StreamVoice[]
	/** Per-dimension Gaussian noise sigma (full scale 1). */
	readonly noiseSigma: number
	/** The front end's third-order coefficient (y = x + a3·x·|x|²). */
	readonly a3: number
	/**
	 * A strong unmodulated blocker keyed on and off at seeded 0.2 to 2 s, or, with `burstMs`, pulsed:
	 * on for `burstMs` (a 30 ms burst), off for a seeded 0.1 to 0.6 s between bursts (a pulsed
	 * transmitter's common-mode desense of every channel through the front end).
	 */
	readonly blocker?: {
		readonly offsetHz: number
		readonly amp: number
		readonly burstMs?: number
	}
}

/** The noise sigma that gives a carrier of `amp` a CNR of `cnrDb` in 12.5 kHz at MIX_FS. */
export function sigmaFor(amp: number, cnrDb: number): number {
	return amp / Math.sqrt(2 * (12_500 / MIX_FS) * 10 ** (cnrDb / 10))
}

/** The shared stream as CU8 IQ (one byte I, one byte Q). */
export function mixedStream(spec: StreamSpec): Uint8Array {
	const n = Math.round(spec.seconds * MIX_FS)
	const noise = mulberry32(spec.seed)
	const keyRng = mulberry32(spec.seed + 7)
	const out = new Uint8Array(2 * n)
	const phase = new Float64Array(spec.voices.length)
	const tone = new Float64Array(spec.voices.length)
	let blockerPhase = 0
	let blockerOn = false
	let blockerUntil = 0
	const gauss = (): number => {
		const u = Math.max(1e-12, noise())
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * noise())
	}
	for (let i = 0; i < n; i++) {
		const t = i / MIX_FS
		let re = 0
		let im = 0
		for (let v = 0; v < spec.voices.length; v++) {
			const voice = spec.voices[v]!
			let dev = 0
			if (voice.deviation !== null) {
				// Linear interpolation of the 8 kHz deviation.
				const x = (i / MIX_DECIMATION) | 0
				const f = i / MIX_DECIMATION - x
				const a = voice.deviation[x] ?? 0
				const b = voice.deviation[x + 1] ?? a
				dev = a + (b - a) * f
			}
			if (voice.ctcssHz !== undefined) {
				tone[v] = tone[v]! + (TWO_PI * voice.ctcssHz) / MIX_FS
				dev += 350 * Math.sin(tone[v]!)
			}
			phase[v] =
				(phase[v]! + (TWO_PI * (voice.offsetHz + dev)) / MIX_FS) % TWO_PI
			if (
				voice.keyed !== undefined &&
				!voice.keyed.some(([from, to]) => t >= from && t < to)
			)
				continue
			re += voice.amp * Math.cos(phase[v]!)
			im += voice.amp * Math.sin(phase[v]!)
		}
		if (spec.blocker) {
			if (i >= blockerUntil) {
				blockerOn = !blockerOn
				const burstMs = spec.blocker.burstMs
				blockerUntil =
					i +
					Math.round(
						burstMs === undefined
							? (0.2 + keyRng() * 1.8) * MIX_FS
							: blockerOn
								? (burstMs / 1000) * MIX_FS
								: (0.1 + keyRng() * 0.5) * MIX_FS,
					)
			}
			blockerPhase =
				(blockerPhase + (TWO_PI * spec.blocker.offsetHz) / MIX_FS) % TWO_PI
			if (blockerOn) {
				re += spec.blocker.amp * Math.cos(blockerPhase)
				im += spec.blocker.amp * Math.sin(blockerPhase)
			}
		}
		// The front end: y = x + a3·x·|x|², then the noise floor.
		const p = re * re + im * im
		let yr = re + spec.a3 * re * p + spec.noiseSigma * gauss()
		let yi = im + spec.a3 * im * p + spec.noiseSigma * gauss()
		yr = Math.max(-1, Math.min(1, yr))
		yi = Math.max(-1, Math.min(1, yi))
		out[2 * i] = Math.round(127.5 + 127.5 * yr)
		out[2 * i + 1] = Math.round(127.5 + 127.5 * yi)
	}
	return out
}

/** `offsetHz` of a stream demodulated to 8 kHz audio (WidebandNfmChain, JS path). */
export function channelAudio(stream: Uint8Array, offsetHz: number): Int16Array {
	const chain = new WidebandNfmChain({ inputRateHz: MIX_FS, offsetHz })
	const slice = 2 * 9_600
	const parts: Int16Array[] = []
	let total = 0
	for (let at = 0; at < stream.length; at += slice) {
		const p = chain.process(
			stream.subarray(at, Math.min(stream.length, at + slice)),
		)
		parts.push(p)
		total += p.length
	}
	const out = new Int16Array(total)
	let o = 0
	for (const p of parts) {
		out.set(p, o)
		o += p.length
	}
	return out
}

/** Source gaps as the recorder fills them: silence over [from, to) audio samples. */
export interface AudioGap {
	readonly from: number
	readonly to: number
}

/** Seeded source gaps of 25 to 200 ms, about one per `everyS` seconds, over `samples`. */
export function seededGaps(
	seed: number,
	samples: number,
	everyS = 4,
): AudioGap[] {
	const rng = mulberry32(seed)
	const gaps: AudioGap[] = []
	let at = Math.round(rng() * everyS * AUDIO_FS)
	while (at < samples) {
		const len = Math.round((0.025 + rng() * 0.175) * AUDIO_FS)
		gaps.push({ from: at, to: Math.min(samples, at + len) })
		at += len + Math.round((0.5 + rng()) * everyS * AUDIO_FS)
	}
	return gaps
}

/** The audio with the gaps' samples zeroed (the recorder's silence fill). */
export function withGaps(
	audio: Int16Array,
	gaps: readonly AudioGap[],
): Int16Array {
	const out = audio.slice()
	for (const g of gaps) out.fill(0, g.from, g.to)
	return out
}

/** The copy envelope of `audio` (a copy of the meter's views), at most COPY_MAX_FRAMES. */
export function envelopeOf(audio: Int16Array): CopyEnvelope {
	const m = new SpeechContentMeter({ envelope: true })
	for (let at = 0; at < audio.length; at += 4_000)
		m.push(audio.subarray(at, Math.min(audio.length, at + 4_000)))
	const e = m.envelope()!
	return { env: e.env.slice(), voiced: e.voiced.slice(), frames: e.frames }
}

/** Frames [from, from + n) of a long envelope, as its own file's envelope. */
export function envelopeWindow(
	e: CopyEnvelope,
	from: number,
	n: number,
): CopyEnvelope {
	const frames = Math.max(0, Math.min(n, e.frames - from, COPY_MAX_FRAMES))
	const env = new Uint8Array(COPY_MAX_FRAMES)
	const voiced = new Uint8Array(Math.ceil(COPY_MAX_FRAMES / 8))
	for (let k = 0; k < frames; k++) {
		env[k] = e.env[from + k] ?? 0
		const src = from + k
		if (((e.voiced[src >> 3] ?? 0) & (1 << (src & 7))) !== 0)
			voiced[k >> 3] = voiced[k >> 3]! | (1 << (k & 7))
	}
	return { env, voiced, frames }
}
