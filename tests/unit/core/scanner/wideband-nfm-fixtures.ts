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
				let dev =
					peakDeviationHz * 0.85 * emphasis * Math.sin(TWO_PI * tone * t)
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
