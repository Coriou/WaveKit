/**
 * Does a finished analog file's audio (8 kHz s16, what the recorder wrote) clearly measure as
 * something other than speech: a steady buzz (FM-demodulated 4FSK, TDMA, 2FSK or GMSK data, the
 * noise of an open squelch)? Its answer discards a file only where recording-verdict.ts
 * contentChecked applies (a `tone-required` prior, or backed digital evidence of the owner: never a
 * spectral class alone, an ism or LoRa decode, or a co-channel decode; finishVerdict,
 * `discarded:not-speech`); a file with its own CTCSS tone, classed by its own tone, a classed
 * session's roll-over file, or a file of a channel with analog proof is never discarded by it.
 *
 * Two measures, over 32 ms frames (SPEECH_FRAME_SAMPLES = 256):
 * 1. Envelope range: the spread between the 90th and the 10th percentile of the frames' log level in
 *    the 312.5 to 1 500 Hz band (where speech has most of its energy and FM noise little; 10·log10
 *    of the band's mean square, s16 units, + 1) over each 3 s window (SPEECH_WINDOW_FRAMES = 94, hop
 *    47, plus one window ending at the file's last frame), the largest over the file. Speech rises
 *    and falls with its syllables and pauses (a carrier between words is quiet audio); data and
 *    noise keep a steady level. A file with speech anywhere has one window that is not steady.
 * 2. Periodic share: the share of frames whose autocorrelation, above 312.5 Hz (bins under
 *    SPEECH_HIGH_PASS_BIN zeroed, so a CTCSS tone does not count), peaks at
 *    SPEECH_PERIODIC_MIN_CORRELATION or more at a lag of 20 to 100 samples (an 80 to 400 Hz
 *    fundamental): voiced speech repeats at its pitch.
 * Clearly not speech (clearlyNotSpeech): at least SPEECH_WINDOW_FRAMES frames (3 s), every window
 * steady (largest range under SPEECH_STEADY_MAX_RANGE_DB) and a periodic share under
 * SPEECH_NOT_SPEECH_MAX_PERIODIC_SHARE. A shorter file, any unsteady window, or a periodic steady
 * signal (a pure or keyed tone, DTMF, a selcall) is kept: missing buzz is preferred to losing voice.
 *
 * Measured (scripts/bench/scanner-quality/speech-content.ts) on SYNTHETIC signals through
 * WidebandNfmChain, 12 s each (nothing here is a real recording): speech-like audio (pitched and
 * unvoiced syllables, with and without pauses, 2 400 Hz peak) at least 12.1 dB down to a CNR of
 * 5 dB in 12.5 kHz (8.2 to 8.4 dB at 4 dB, below the FM threshold); hard speech (1 000 or
 * 1 500 Hz peak deviation, a 30 or 50 % deep syllable envelope, no pauses, and combinations;
 * tests' HARD_SPEECH_CASES) at least 10.2 dB at a CNR of 5 to 10 dB, the lowest a 1 000 Hz,
 * 30 %, pause-free talker; 4FSK at 4 800 Bd, 2FSK at 1 200 Bd, GMSK-like 2FSK at 4 800 Bd, an
 * unmodulated carrier and open-squelch noise at most 3.5 dB. Real FM-demodulated data (DMR,
 * paging bursts with their edges) measures well above the synthetic data, so the bound leaves
 * under 2 dB to the hardest synthetic speech; it leans to keeping (missing buzz is preferred to
 * losing voice). A smoothed envelope and a syllable-rate (2 to 8 Hz) modulation measure were tried
 * and separate no better (paging bursts modulate at syllable rates). Not caught: a TDMA burst train (keyed at 16.7 Hz, an
 * unsteady envelope; recording-verdict.ts bars a TDMA channel by its class), slow 2FSK (512 Bd:
 * periodic), any tone.
 *
 * Cost: per frame one 256-point complex FFT of the windowed frame and one of its power spectrum
 * (Fft, shared tables), a few hundred multiply-adds, and per 47 frames one sort of 94 numbers; all
 * buffers allocated in the constructor (about 5 KB per file), nothing after. 0.5 to 2.4 ms of a
 * core per second of audio (the bench, one Mac core), off the IQ path (the recorder feeds it what
 * it writes).
 */
import { Fft } from "../../spectrum/fft.js"

/** Frame length: 256 samples, 32 ms at 8 kHz. */
export const SPEECH_FRAME_SAMPLES = 256
/** Frames per envelope window: 94 × 32 ms = 3.008 s. */
export const SPEECH_WINDOW_FRAMES = 94
/** Frames between window starts (half a window). */
export const SPEECH_WINDOW_HOP = 47
/** Lowest bin kept for the periodicity: 10 × 31.25 Hz = 312.5 Hz (under it: CTCSS and hum). */
export const SPEECH_HIGH_PASS_BIN = 10
/** Highest bin of the envelope band: 48 × 31.25 Hz = 1 500 Hz (it starts at SPEECH_HIGH_PASS_BIN). */
export const SPEECH_BAND_TOP_BIN = 48
/** Pitch lags searched: 20 to 100 samples, a 400 to 80 Hz fundamental. */
export const SPEECH_PITCH_MIN_LAG = 20
export const SPEECH_PITCH_MAX_LAG = 100
/** A frame's normalised autocorrelation peak that makes it periodic. */
export const SPEECH_PERIODIC_MIN_CORRELATION = 0.5
/**
 * Every window's envelope range must be under this (dB) for a steady file: synthetic data and
 * noise through the chain measured at most 3.5 (real data more); synthetic speech at
 * least 12.1 down to a CNR of 5 dB (33.2 and more at 30 dB), hard synthetic speech (low
 * deviation, shallow syllables, no pauses) at least 10.2 at a CNR of 5 to 10 dB.
 */
export const SPEECH_STEADY_MAX_RANGE_DB = 8.5
/**
 * A steady file's periodic share must be under this to be clearly not speech: synthetic 2FSK at
 * 1 200 Bd measured 0.15, 4FSK, GMSK-like data and noise at most 0.03, synthetic speech 0.24 to
 * 0.61 at a CNR of 9 dB or more. A steady periodic file (a tone, a whistle) is kept.
 */
export const SPEECH_NOT_SPEECH_MAX_PERIODIC_SHARE = 0.2

const P10 = Math.floor(0.1 * (SPEECH_WINDOW_FRAMES - 1))
const P90 = Math.ceil(0.9 * (SPEECH_WINDOW_FRAMES - 1))

let sharedFft: Fft | null = null
const HANN = new Float32Array(SPEECH_FRAME_SAMPLES)
for (let i = 0; i < SPEECH_FRAME_SAMPLES; i++)
	HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SPEECH_FRAME_SAMPLES)

/** What SpeechContentMeter measured over a file. */
export interface SpeechContent {
	/** Whole frames heard. */
	readonly frames: number
	/** The largest envelope range of a window (dB); 0 under one window. */
	readonly maxRangeDb: number
	/** Periodic frames over all frames (0 with none). */
	readonly periodicShare: number
}

/** Streaming measure of one file's audio (SpeechContent); `push` allocates nothing. */
export class SpeechContentMeter {
	private readonly frame = new Float32Array(SPEECH_FRAME_SAMPLES)
	private fill = 0
	private readonly re = new Float32Array(SPEECH_FRAME_SAMPLES)
	private readonly im = new Float32Array(SPEECH_FRAME_SAMPLES)
	private readonly ring = new Float64Array(SPEECH_WINDOW_FRAMES)
	private readonly sorted = new Float64Array(SPEECH_WINDOW_FRAMES)
	private frames = 0
	private periodic = 0
	private maxRange = 0
	/** Frame count at the last window measured (−1: none). */
	private measuredAt = -1

	push(pcm: Int16Array): void {
		for (let i = 0; i < pcm.length; i++) {
			this.frame[this.fill++] = pcm[i]!
			if (this.fill === SPEECH_FRAME_SAMPLES) {
				this.fill = 0
				this.measureFrame()
			}
		}
	}

	result(): SpeechContent {
		if (this.frames >= SPEECH_WINDOW_FRAMES && this.measuredAt !== this.frames)
			this.measureWindow()
		return {
			frames: this.frames,
			maxRangeDb: this.maxRange,
			periodicShare: this.frames === 0 ? 0 : this.periodic / this.frames,
		}
	}

	private measureFrame(): void {
		if (this.analyse() >= SPEECH_PERIODIC_MIN_CORRELATION) this.periodic++
		this.frames++
		if (
			this.frames >= SPEECH_WINDOW_FRAMES &&
			(this.frames - SPEECH_WINDOW_FRAMES) % SPEECH_WINDOW_HOP === 0
		)
			this.measureWindow()
	}

	/**
	 * Notes the frame's band level in the envelope ring; returns its normalised autocorrelation
	 * peak over the pitch lags, above the high-pass bin.
	 */
	private analyse(): number {
		const n = SPEECH_FRAME_SAMPLES
		const { re, im } = this
		for (let i = 0; i < n; i++) {
			re[i] = this.frame[i]! * HANN[i]!
			im[i] = 0
		}
		sharedFft ??= new Fft(n)
		sharedFft.transform(re, im)
		let band = 0
		for (let k = SPEECH_HIGH_PASS_BIN; k <= SPEECH_BAND_TOP_BIN; k++)
			band += re[k]! * re[k]! + im[k]! * im[k]!
		this.ring[this.frames % SPEECH_WINDOW_FRAMES] =
			10 * Math.log10((4 * band) / (n * n) + 1)
		for (let k = 0; k < n; k++) {
			const low = k < SPEECH_HIGH_PASS_BIN || n - k < SPEECH_HIGH_PASS_BIN
			re[k] = low ? 0 : re[k]! * re[k]! + im[k]! * im[k]!
			im[k] = 0
		}
		// The power spectrum is real and even: its forward transform is the autocorrelation (× n).
		sharedFft.transform(re, im)
		const r0 = re[0]!
		if (!(r0 > 0)) return 0
		let peak = -Infinity
		for (let lag = SPEECH_PITCH_MIN_LAG; lag <= SPEECH_PITCH_MAX_LAG; lag++)
			if (re[lag]! > peak) peak = re[lag]!
		return peak / r0
	}

	/** The envelope range of the last SPEECH_WINDOW_FRAMES frames. */
	private measureWindow(): void {
		this.sorted.set(this.ring)
		this.sorted.sort()
		const range = this.sorted[P90]! - this.sorted[P10]!
		if (range > this.maxRange) this.maxRange = range
		this.measuredAt = this.frames
	}
}

/** The file clearly measures as not speech (see the module comment); never on under 3 s. */
export function clearlyNotSpeech(c: SpeechContent): boolean {
	return (
		c.frames >= SPEECH_WINDOW_FRAMES &&
		c.maxRangeDb < SPEECH_STEADY_MAX_RANGE_DB &&
		c.periodicShare < SPEECH_NOT_SPEECH_MAX_PERIODIC_SHARE
	)
}
