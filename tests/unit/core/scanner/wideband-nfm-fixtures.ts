/**
 * Synthetic NFM voice stand-in for the wideband recorder tests: phase-continuous FM at an
 * offset inside a wideband CU8 stream. Audio is tone bursts (300 to 3000 Hz, up to 2.5 kHz
 * peak deviation with a 6 dB/octave pre-emphasis below 1 kHz, a new tone every 150 ms) plus a 67 Hz CTCSS sub-tone (350 Hz deviation). Streaming:
 * `next(n)` continues the carrier phase, so chunks join without a discontinuity.
 */
import { mulberry32 } from "../../../mocks/scanner/signals.js"

const TWO_PI = 2 * Math.PI
export const VOICE_TONES_HZ = [400, 750, 1100, 1600, 2200, 2800] as const
export const CTCSS_TEST_HZ = 67

export interface NfmSourceOptions {
	fs: number
	offsetHz: number
	/** Carrier amplitude (full scale 1). */
	amp?: number
	noiseSigma?: number
	peakDeviationHz?: number
	ctcssHz?: number | null
	ctcssDeviationHz?: number
	/** Default true; false keys a carrier with only the CTCSS sub-tone (or nothing). */
	voice?: boolean
	/**
	 * Speech-like syllables (default false: the tone bursts keep a steady level): the voice
	 * deviation follows a 4 Hz raised-cosine envelope with a 300 ms pause every 1.7 s, so the
	 * envelope rises and falls like speech (VoiceFrameMeter's syllabic index about 0.77).
	 */
	syllables?: boolean
	seed?: number
}

/** One synthetic receiver input: noise always, the NFM carrier only while `on`. */
export class NfmSource {
	private carrierPhase = 0
	private sample = 0
	private readonly rng: () => number
	private readonly o: Required<Omit<NfmSourceOptions, "ctcssHz">> & {
		ctcssHz: number | null
	}
	constructor(opts: NfmSourceOptions) {
		this.o = {
			amp: 0.4,
			noiseSigma: 0.02,
			peakDeviationHz: 2500,
			ctcssDeviationHz: 350,
			voice: true,
			syllables: false,
			seed: 7,
			...opts,
			ctcssHz: opts.ctcssHz === undefined ? CTCSS_TEST_HZ : opts.ctcssHz,
		}
		this.rng = mulberry32(this.o.seed)
	}

	/** Absolute index of the next sample. */
	get position(): number {
		return this.sample
	}

	/** Keys the voice tones on or off from the next sample (the carrier stays continuous). */
	setVoice(voice: boolean): void {
		this.o.voice = voice
	}

	/** The CTCSS sub-tone from the next sample (null: none; the carrier stays continuous). */
	setCtcss(hz: number | null): void {
		this.o.ctcssHz = hz
	}

	/** `n` CU8 IQ pairs; the carrier is keyed when `on`. */
	next(n: number, on: boolean): Uint8Array {
		const { fs, offsetHz, amp, noiseSigma, peakDeviationHz } = this.o
		const out = new Uint8Array(2 * n)
		const ctcss = this.o.ctcssHz
		for (let i = 0; i < n; i++) {
			const t = this.sample / fs
			let re = noiseSigma * this.gauss()
			let im = noiseSigma * this.gauss()
			if (on) {
				const tone =
					VOICE_TONES_HZ[Math.floor(t / 0.15) % VOICE_TONES_HZ.length]!
				// Pre-emphasised like a transmitter: deviation rises 6 dB/octave up to 1 kHz.
				const emphasis = Math.min(1, tone / 1000)
				const envelope = this.o.syllables
					? t % 1.7 > 1.4
						? 0
						: 0.5 - 0.5 * Math.cos(TWO_PI * 4 * t)
					: 1
				let dev = this.o.voice
					? peakDeviationHz *
						0.85 *
						emphasis *
						envelope *
						Math.sin(TWO_PI * tone * t)
					: 0
				if (ctcss !== null)
					dev += this.o.ctcssDeviationHz * Math.sin(TWO_PI * ctcss * t)
				this.carrierPhase += (TWO_PI * (offsetHz + dev)) / fs
				this.carrierPhase %= TWO_PI
				re += amp * Math.cos(this.carrierPhase)
				im += amp * Math.sin(this.carrierPhase)
			}
			out[2 * i] = clampU8(re * 127.5 + 127.5)
			out[2 * i + 1] = clampU8(im * 127.5 + 127.5)
			this.sample++
		}
		return out
	}

	private gauss(): number {
		// Irwin–Hall approximation: cheap and deterministic.
		return this.rng() + this.rng() + this.rng() + this.rng() - 2
	}
}

export interface FskSourceOptions {
	fs: number
	offsetHz: number
	/** Symbols per second (default 4800). */
	baud?: number
	/** Deviation of the four levels in Hz (default ±600 and ±1800). */
	levelsHz?: readonly number[]
	amp?: number
	noiseSigma?: number
	seed?: number
	/** Symbols step through `levelsHz` in order (an alternating 1010 pattern) instead of at random. */
	alternate?: boolean
	/** The first symbols alternate (a POCSAG-like preamble), then random ones follow. */
	preambleSymbols?: number
}

/**
 * Synthetic narrow FSK data signal (a digital-voice-like channel): symbols at `baud`, each a
 * constant deviation of one of `levelsHz` (random, alternating, or an alternating preamble then
 * random), phase-continuous FM at an offset.
 */
export class FskSource {
	private carrierPhase = 0
	private sample = 0
	private symbol = 0
	private dev = 0
	private readonly rng: () => number
	private readonly noise: () => number
	private readonly o: Required<FskSourceOptions>
	constructor(opts: FskSourceOptions) {
		this.o = {
			baud: 4800,
			levelsHz: [-1800, -600, 600, 1800],
			amp: 0.4,
			noiseSigma: 0.02,
			seed: 11,
			alternate: false,
			preambleSymbols: 0,
			...opts,
		}
		this.rng = mulberry32(this.o.seed)
		this.noise = mulberry32(this.o.seed + 1)
	}

	/** `n` CU8 IQ pairs; the carrier is keyed when `on`. */
	next(n: number, on: boolean): Uint8Array {
		const { fs, offsetHz, amp, noiseSigma, baud, levelsHz } = this.o
		const out = new Uint8Array(2 * n)
		for (let i = 0; i < n; i++) {
			const sym = Math.floor((this.sample * baud) / fs)
			if (sym !== this.symbol || this.sample === 0) {
				this.symbol = sym
				this.dev =
					this.o.alternate || sym < this.o.preambleSymbols
						? levelsHz[sym % levelsHz.length]!
						: (levelsHz[Math.floor(this.rng() * levelsHz.length)] ??
							levelsHz[0]!)
			}
			let re = noiseSigma * this.gauss()
			let im = noiseSigma * this.gauss()
			if (on) {
				this.carrierPhase += (TWO_PI * (offsetHz + this.dev)) / fs
				this.carrierPhase %= TWO_PI
				re += amp * Math.cos(this.carrierPhase)
				im += amp * Math.sin(this.carrierPhase)
			}
			out[2 * i] = clampU8(re * 127.5 + 127.5)
			out[2 * i + 1] = clampU8(im * 127.5 + 127.5)
			this.sample++
		}
		return out
	}

	private gauss(): number {
		return this.noise() + this.noise() + this.noise() + this.noise() - 2
	}
}

function clampU8(v: number): number {
	return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

/** Goertzel power of `hz` over `pcm` (s16 at `rate`), normalised per sample. */
export function goertzel(
	pcm: ArrayLike<number>,
	rate: number,
	hz: number,
	from = 0,
	to = pcm.length,
): number {
	const w = (TWO_PI * hz) / rate
	const c = 2 * Math.cos(w)
	let s1 = 0
	let s2 = 0
	for (let i = from; i < to; i++) {
		const s = pcm[i]! + c * s1 - s2
		s2 = s1
		s1 = s
	}
	const n = Math.max(1, to - from)
	return (s1 * s1 + s2 * s2 - c * s1 * s2) / (n * n)
}

/** Duration in ms of a mono 16-bit PCM WAV from its header. */
export function wavDurationMs(file: Buffer): number {
	const rate = file.readUInt32LE(24)
	const dataBytes = file.readUInt32LE(40)
	return (dataBytes / 2 / rate) * 1000
}
