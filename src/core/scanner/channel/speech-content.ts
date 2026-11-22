/**
 * Does a finished analog file's audio (8 kHz s16, what the recorder wrote) clearly measure as
 * something other than speech: a steady buzz (FM-demodulated 4FSK, TDMA, 2FSK or GMSK data, the
 * noise of an open squelch)? clearlyNotSpeech discards a file only where recording-verdict.ts
 * contentChecked applies (a strong prior from a dedicated decode, a TDMA channel or verified
 * digital evidence, or backed digital evidence of the owner); under any other digital prior (a
 * spectral class alone, a digital-unknown candidate or unchecked sync hints alone, an ism or LoRa
 * decode, a co-channel decode) only the stricter clearlyNoise does (finishVerdict,
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
 * Clear noise (clearlyNoise): the same with the strict bounds SPEECH_NOISE_MAX_RANGE_DB and
 * SPEECH_NOISE_MAX_PERIODIC_SHARE, at least SPEECH_NOISE_MIN_FRAMES frames (8 s), and no burst
 * (3. below) of SPEECH_NOISE_MAX_BURST_FRAMES frames or more, the only content check a weak
 * (`suspect`) prior gets.
 * 3. Longest burst (clearlyNoise only): the longest run of consecutive frames whose band level is
 *    SPEECH_NOISE_BURST_DB or more over its window's median, the largest over the file's windows.
 *    A short word on a quiet carrier fills too few of a window's frames to move its 90th
 *    percentile (the range), but it is one run of loud frames; noise and data have none.
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
 * (Fft, shared tables), a few hundred multiply-adds, and per 47 frames one sort of 94 numbers and
 * one walk of them (the burst); all
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

/**
 * The strict bound (clearlyNoise): every window's envelope range must be under this (dB) for a
 * file to be clear noise or buzz, the content check under a WEAK prior (recording-verdict.ts
 * finishVerdict's `clearNoise`). The hardest synthetic speech at a CNR of 6 dB or more measures
 * at least 10.16 dB (HARD_SPEECH_CASES, 12 s), a 4.16 dB margin; synthetic data and noise at most
 * 3.5 dB; real open-squelch noise a listener confirmed as such (one channel, 150 files) 3.8 to
 * 6.8 dB, its 120 s files 5.3 to 5.6 dB (a margin of about 0.4 dB): of its files of 8 s or more
 * (SPEECH_NOISE_MIN_FRAMES) 92 of 108 are caught, of all its files 92 of 151 (the bench, after
 * the burst veto too). Never borderline audio: a file between this and SPEECH_STEADY_MAX_RANGE_DB
 * is judged only under a strong or backed prior.
 */
export const SPEECH_NOISE_MAX_RANGE_DB = 6
/**
 * The strict bound's periodic share (clearlyNoise): under 0.1. Synthetic 4FSK, GMSK-like data and
 * noise measure at most 0.03 and the confirmed real noise at most 0.044; synthetic 2FSK at
 * 1 200 Bd (0.15) and speech (0.24 or more at a CNR of 9 dB or more) are over it.
 */
export const SPEECH_NOISE_MAX_PERIODIC_SHARE = 0.1
/**
 * The strict bound's own length floor (clearlyNoise): 250 frames, 250 × 32 ms = 8 s. Its margins
 * were measured on 12 s files; a short file holds one or two windows, so its largest range is a
 * single-window figure. Measured (scripts/bench/scanner-quality/speech-content.ts, the short-file
 * table: every 0.5 s cut of a 16 s synthetic run, the smallest of the cuts' largest-window range)
 * for every voice case at a CNR of 5 dB or more (HARD_SPEECH_CASES' talkers, plain speech, 500 Hz
 * peak deviation at 5 and 6 dB, a 0.3 to 0.5 s single word at 5 and 6 dB): at 94 frames (3 s)
 * 6.96 dB, 125 (4 s) 7.94, 188 (6 s) 8.09, 250 (8 s) 8.99, 375 (12 s) 8.99, each time the
 * shallow (30 or 50 %) talker at 5 dB. The target, 3 dB over the 6 dB bound (9 dB), is met at no
 * length up to 8 s, so the floor is the 8 s cap: 8.99 − 6 = 2.99 dB of margin. Below a CNR of
 * 5 dB (under the FM threshold) the strict bounds call some cuts of 3 to 6 s noise; none at 8 s.
 * A single word under 0.5 s on a clean carrier at 10 to 30 dB (fewer than a tenth of a window's
 * frames, so the 90th percentile misses it) is not fixed by any length either; the burst veto
 * (SPEECH_NOISE_MAX_BURST_FRAMES) keeps it. THE ONE ACCEPTED EXCEPTION: voice at only 500 Hz
 * peak deviation at a CNR of 8 to 10 dB (2 to 4 of 8 cuts called noise at 12 s, more when
 * shorter). Physically its audio SNR is about 0 dB: FM's demodulated SNR grows with the square of
 * the deviation ratio, and 500 Hz is a fifth of the 2 400 Hz the voice cases use (about 14 dB
 * less audio SNR), so near the FM threshold the voice sits at the level of the demodulator's own
 * noise: no syllable range, no pitched frames and no burst over the median (its longest burst
 * measures 2 frames, under the veto). No measure of the audio can tell it from noise; such a
 * talker is rare (a misset radio), and it is only at risk under a weak prior.
 */
export const SPEECH_NOISE_MIN_FRAMES = 250
/**
 * A burst frame's band level over its window's median (dB): 6 dB, four times the power. Steady
 * noise or data spreads little frame to frame (the band's 39 bins hold at most 78 degrees of
 * freedom, so a frame's level varies by roughly 4.34·√(2/78) ≈ 0.7 dB rms, somewhat more with the
 * Hann window's correlated bins): 6 dB is several standard deviations, and a lone noise spike
 * fills one frame, not a run. A word on a quiet carrier at a CNR of 10 dB or more stays over it
 * for 4 to 7 frames (SPEECH_NOISE_MAX_BURST_FRAMES).
 */
export const SPEECH_NOISE_BURST_DB = 6
/**
 * The burst veto (clearlyNoise only, not clearlyNotSpeech): a file with a burst of this many
 * frames or more (3 × 32 ms = 96 ms) is never clear noise. Measured (the bench, `--burst`: a
 * 0.3, 0.4 or 0.5 s word at the start, middle or tail of an 8 or 12 s file, and three or four
 * words of 0.3 to 0.4 s over 10 s, at a CNR of 5 to 30 dB): every voice the other strict bounds
 * call noise (11 words at 10 dB, 11 at 12, 8 at 20, 6 at 30, the sparse speech at 10) has a
 * longest burst of 4 to 7 frames, the shortest the 0.3 s word at 10 to 12 dB (a 0.3 s word is
 * 9.4 frames, but its raised-cosine syllable stays 6 dB over the carrier for only about 4 of
 * them); every synthetic data and noise case the other bounds catch (4FSK, GMSK-like data,
 * open-squelch noise, an unmodulated carrier at 10 dB or more) at most 1, the confirmed real
 * noise (151 files) 0. So 3 leaves one frame each way and leans to keeping: a carrier near the
 * FM threshold (6 to 8 dB) clicks in bursts of 2 to 4 frames, but its range keeps it anyway.
 */
export const SPEECH_NOISE_MAX_BURST_FRAMES = 3

/**
 * A short file's partial window (SpeechContentMeter.result under SPEECH_WINDOW_FRAMES): measured
 * from 16 frames (0.512 s) on; shorter, nothing (0, 0: speechHeard fails it).
 */
export const SPEECH_SHORT_MIN_FRAMES = 16

const P10 = Math.floor(0.1 * (SPEECH_WINDOW_FRAMES - 1))
const P90 = Math.ceil(0.9 * (SPEECH_WINDOW_FRAMES - 1))
const MEDIAN_LO = Math.floor((SPEECH_WINDOW_FRAMES - 1) / 2)
const MEDIAN_HI = Math.ceil((SPEECH_WINDOW_FRAMES - 1) / 2)

let sharedFft: Fft | null = null
const HANN = new Float32Array(SPEECH_FRAME_SAMPLES)
for (let i = 0; i < SPEECH_FRAME_SAMPLES; i++)
	HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SPEECH_FRAME_SAMPLES)

/** What SpeechContentMeter measured over a file. */
export interface SpeechContent {
	/** Whole frames heard. */
	readonly frames: number
	/**
	 * The largest envelope range of a window (dB); a file shorter than one window: that of its one
	 * partial window from SPEECH_SHORT_MIN_FRAMES on (speechHeard only), 0 under it.
	 */
	readonly maxRangeDb: number
	/** Periodic frames over all frames (0 with none). */
	readonly periodicShare: number
	/**
	 * The longest run of consecutive frames at least SPEECH_NOISE_BURST_DB over its window's
	 * median band level, the largest over the file's windows (a shorter file: its partial window,
	 * as maxRangeDb): a word.
	 */
	readonly maxBurstFrames: number
	/**
	 * Frames that fed the admission level ring: whole frames with at most half their samples exact
	 * zeros (a gap the recorder filled with silence is not audio heard).
	 */
	readonly levelFrames: number
	/**
	 * The largest level spread (90th minus 10th percentile of the frames' SPEECH_HIGH_PASS_BIN to
	 * 127 level, dBFS, see `frameLevelDbfs`) of a level window (SPEECH_WINDOW_FRAMES level frames,
	 * hop SPEECH_WINDOW_HOP, plus one ending at the last level frame); under one window: that of
	 * its one partial window from SPEECH_SHORT_MIN_FRAMES level frames on, 0 under it.
	 */
	readonly maxWindowSpreadDb: number
	/**
	 * The lowest 10th percentile level (dBFS) of a level window, windows as maxWindowSpreadDb (a
	 * partial window under one window, 0 under SPEECH_SHORT_MIN_FRAMES level frames). Carrier
	 * quieting between words drives it down; open-squelch noise and data never quiet.
	 */
	readonly minWindowP10Dbfs: number
}

/**
 * A frame's admission level (dBFS): 10·log10 of the frame's estimated mean square in FFT bins
 * SPEECH_HIGH_PASS_BIN (312.5 Hz) to 127 (3 968.75 Hz, the last bin under Nyquist) over
 * 32 768², plus 1e-10 (a floor of −100 dBFS). Bins under 312.5 Hz (CTCSS, hum) are left out. The
 * Hann-windowed band power Σ|X_k|² over the positive bins, doubled for the mirrored half, over n²
 * (Parseval) and over the Hann window's mean square 3/8: a full-scale square wave would read
 * about 0 dBFS, a full-scale sine inside the band −3 dBFS.
 */
const LEVEL_TOP_BIN = SPEECH_FRAME_SAMPLES / 2 - 1
const LEVEL_SCALE =
	2 / (SPEECH_FRAME_SAMPLES * SPEECH_FRAME_SAMPLES * 0.375 * 32_768 * 32_768)
const LEVEL_FLOOR = 1e-10
/** A frame with more exact-zero samples than this (half the frame) is skipped by the level ring. */
const LEVEL_MAX_ZEROS = SPEECH_FRAME_SAMPLES / 2

/**
 * Streaming measure of one file's audio (SpeechContent); `push` allocates nothing and costs O(1)
 * amortised per frame (one sort of SPEECH_WINDOW_FRAMES numbers per SPEECH_WINDOW_HOP frames for
 * each of the envelope and the admission level rings).
 */
export class SpeechContentMeter {
	private readonly frame = new Float32Array(SPEECH_FRAME_SAMPLES)
	private fill = 0
	private readonly re = new Float32Array(SPEECH_FRAME_SAMPLES)
	private readonly im = new Float32Array(SPEECH_FRAME_SAMPLES)
	private readonly ring = new Float64Array(SPEECH_WINDOW_FRAMES)
	private readonly sorted = new Float64Array(SPEECH_WINDOW_FRAMES)
	private heard = 0
	private periodic = 0
	/** The largest range and burst of the whole windows measured (never a partial one). */
	private maxRange = 0
	private maxBurst = 0
	/**
	 * A short file's one partial window (under SPEECH_WINDOW_FRAMES frames), measured apart: it is
	 * reported only while the file is shorter than a window and never folds into `maxRange` or
	 * `maxBurst`, so a meter read on every step (the recorder's judged audio) never reads a
	 * partial window once it has a whole one (below SPEECH_WINDOW_FRAMES it reads what a meter
	 * read once at the end reads; past it, whole windows only, possibly more of them).
	 */
	private partialRange = 0
	private partialBurst = 0
	/** Frame count at the last window measured (−1: none). */
	private measuredAt = -1
	/** The admission level ring: one level per frame that is not mostly exact zeros. */
	private readonly levelRing = new Float64Array(SPEECH_WINDOW_FRAMES)
	private readonly levelSorted = new Float64Array(SPEECH_WINDOW_FRAMES)
	private levelHeard = 0
	/** The last analysed frame's level (dBFS) and whether it was mostly exact zeros. */
	private frameLevel = 0
	private frameZeroHeavy = false
	/** Whole level windows' largest spread and lowest p10 (never a partial one). */
	private maxSpread = 0
	private minP10 = Infinity
	/** A short file's one partial level window (as partialRange). */
	private partialSpread = 0
	private partialP10 = 0
	/** Level frame count at the last level window measured (−1: none). */
	private levelMeasuredAt = -1

	/** Whole frames heard so far (result().frames, without measuring a window). */
	get frames(): number {
		return this.heard
	}

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
		const frames = this.heard
		const whole = frames >= SPEECH_WINDOW_FRAMES
		if (this.measuredAt !== frames) {
			if (whole) this.measureWindow()
			else if (frames >= SPEECH_SHORT_MIN_FRAMES) this.measureWindow(frames)
		}
		const levelFrames = this.levelHeard
		const levelWhole = levelFrames >= SPEECH_WINDOW_FRAMES
		if (this.levelMeasuredAt !== levelFrames) {
			if (levelWhole) this.measureLevelWindow()
			else if (levelFrames >= SPEECH_SHORT_MIN_FRAMES)
				this.measureLevelWindow(levelFrames)
		}
		return {
			frames,
			maxRangeDb: whole ? this.maxRange : this.partialRange,
			periodicShare: frames === 0 ? 0 : this.periodic / frames,
			maxBurstFrames: whole ? this.maxBurst : this.partialBurst,
			levelFrames,
			maxWindowSpreadDb: levelWhole ? this.maxSpread : this.partialSpread,
			minWindowP10Dbfs: levelWhole ? this.minP10 : this.partialP10,
		}
	}

	private measureFrame(): void {
		if (this.analyse() >= SPEECH_PERIODIC_MIN_CORRELATION) this.periodic++
		this.heard++
		if (
			this.heard >= SPEECH_WINDOW_FRAMES &&
			(this.heard - SPEECH_WINDOW_FRAMES) % SPEECH_WINDOW_HOP === 0
		)
			this.measureWindow()
		if (this.frameZeroHeavy) return
		this.levelRing[this.levelHeard % SPEECH_WINDOW_FRAMES] = this.frameLevel
		this.levelHeard++
		if (
			this.levelHeard >= SPEECH_WINDOW_FRAMES &&
			(this.levelHeard - SPEECH_WINDOW_FRAMES) % SPEECH_WINDOW_HOP === 0
		)
			this.measureLevelWindow()
	}

	/**
	 * The level spread (p90 − p10) and p10 of the last SPEECH_WINDOW_FRAMES level frames (one sort
	 * per hop); `n` under it: a short file's one partial window, its level frames 0 to n − 1, kept
	 * apart as measureWindow's partial figures.
	 */
	private measureLevelWindow(n: number = SPEECH_WINDOW_FRAMES): void {
		const sorted = this.levelSorted.subarray(0, n)
		sorted.set(this.levelRing.subarray(0, n))
		sorted.sort()
		const full = n === SPEECH_WINDOW_FRAMES
		const p10 = sorted[full ? P10 : Math.floor(0.1 * (n - 1))]!
		const spread = sorted[full ? P90 : Math.ceil(0.9 * (n - 1))]! - p10
		if (full) {
			if (spread > this.maxSpread) this.maxSpread = spread
			if (p10 < this.minP10) this.minP10 = p10
		} else {
			this.partialSpread = spread
			this.partialP10 = p10
		}
		this.levelMeasuredAt = this.levelHeard
	}

	/**
	 * Notes the frame's band level in the envelope ring; returns its normalised autocorrelation
	 * peak over the pitch lags, above the high-pass bin.
	 */
	private analyse(): number {
		const n = SPEECH_FRAME_SAMPLES
		const { re, im } = this
		let zeros = 0
		for (let i = 0; i < n; i++) {
			const x = this.frame[i]!
			if (x === 0) zeros++
			re[i] = x * HANN[i]!
			im[i] = 0
		}
		this.frameZeroHeavy = zeros > LEVEL_MAX_ZEROS
		sharedFft ??= new Fft(n)
		sharedFft.transform(re, im)
		let band = 0
		let level = 0
		for (let k = SPEECH_HIGH_PASS_BIN; k <= LEVEL_TOP_BIN; k++) {
			const p = re[k]! * re[k]! + im[k]! * im[k]!
			level += p
			if (k <= SPEECH_BAND_TOP_BIN) band += p
		}
		this.ring[this.heard % SPEECH_WINDOW_FRAMES] =
			10 * Math.log10((4 * band) / (n * n) + 1)
		this.frameLevel = 10 * Math.log10(level * LEVEL_SCALE + LEVEL_FLOOR)
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

	/**
	 * The envelope range of the last SPEECH_WINDOW_FRAMES frames, and their longest burst over the
	 * window's median (walked in time order: the oldest frame sits at `frames % SPEECH_WINDOW_FRAMES`).
	 * `n` under SPEECH_WINDOW_FRAMES: a short file's one partial window, its frames 0 to n − 1 (the
	 * ring has not wrapped), with the same percentiles of n, kept apart (`partialRange`,
	 * `partialBurst`: the latest, not the largest, since each partial window holds every frame so far).
	 */
	private measureWindow(n: number = SPEECH_WINDOW_FRAMES): void {
		const { ring } = this
		const sorted = this.sorted.subarray(0, n)
		sorted.set(ring.subarray(0, n))
		sorted.sort()
		const full = n === SPEECH_WINDOW_FRAMES
		const range =
			sorted[full ? P90 : Math.ceil(0.9 * (n - 1))]! -
			sorted[full ? P10 : Math.floor(0.1 * (n - 1))]!
		if (full) {
			if (range > this.maxRange) this.maxRange = range
		} else this.partialRange = range
		const lo = full ? MEDIAN_LO : Math.floor((n - 1) / 2)
		const hi = full ? MEDIAN_HI : Math.ceil((n - 1) / 2)
		const floor = (sorted[lo]! + sorted[hi]!) / 2 + SPEECH_NOISE_BURST_DB
		const oldest = full ? this.heard % SPEECH_WINDOW_FRAMES : 0
		let run = 0
		let longest = 0
		for (let i = 0; i < n; i++) {
			if (ring[(oldest + i) % SPEECH_WINDOW_FRAMES]! >= floor) {
				if (++run > longest) longest = run
			} else run = 0
		}
		if (!full) this.partialBurst = longest
		else if (longest > this.maxBurst) this.maxBurst = longest
		this.measuredAt = this.heard
	}
}

/**
 * The file measures as clear noise or buzz by the strict bounds (SPEECH_NOISE_MAX_RANGE_DB,
 * SPEECH_NOISE_MAX_PERIODIC_SHARE) with no burst of SPEECH_NOISE_MAX_BURST_FRAMES frames (a word):
 * the content check under a weak prior. Never on under SPEECH_NOISE_MIN_FRAMES (8 s); always
 * implies clearlyNotSpeech.
 */
export function clearlyNoise(c: SpeechContent): boolean {
	return (
		c.frames >= SPEECH_NOISE_MIN_FRAMES &&
		c.maxRangeDb < SPEECH_NOISE_MAX_RANGE_DB &&
		c.periodicShare < SPEECH_NOISE_MAX_PERIODIC_SHARE &&
		c.maxBurstFrames < SPEECH_NOISE_MAX_BURST_FRAMES
	)
}

/** The file clearly measures as not speech (see the module comment); never on under 3 s. */
export function clearlyNotSpeech(c: SpeechContent): boolean {
	return (
		c.frames >= SPEECH_WINDOW_FRAMES &&
		c.maxRangeDb < SPEECH_STEADY_MAX_RANGE_DB &&
		c.periodicShare < SPEECH_NOT_SPEECH_MAX_PERIODIC_SHARE
	)
}

/**
 * The range a file of SPEECH_NOISE_MIN_FRAMES (8 s) or more must reach for speechHeard to pass by
 * its range alone (neither pitched nor a burst): 8 dB. Measured (SYNTHETIC, the 8 and 12 s cuts of
 * a 12 s run through WidebandNfmChain): of the voice cases no pitch or burst keeps, the lowest is
 * 9.96 dB (HARD_SPEECH_CASES' 1 500 Hz, 50 %, pause-free talker at 5 dB), 1.96 dB over it; real
 * noise a listener confirmed measures at most 6.8 dB and two live noise files kept by the 6 dB
 * bound (9.8 and 13.5 s, a periodic share at most 0.023, bursts at most 2 frames) 6.52 and
 * 6.69 dB, 1.2 dB or more under it. Under it fall only voice at 500 Hz peak deviation at a CNR
 * of 8 to 10 dB (7.25 to 7.71 dB, no pitch, bursts of 1 or 2 frames): clearlyNoise's accepted
 * exception, whose audio SNR is about 0 dB. A pitched share or a burst still keeps such a file
 * (periodic share or burst alone is not enough on noise of this kind: hard speech at a CNR of
 * 5 dB measures 0.011 to 0.021 pitched with bursts of 1, inside the live noise's 0.005 to 0.023
 * and 0 to 2).
 */
export const SPEECH_NO_VOICE_LONG_MIN_RANGE_DB = 8

/**
 * The file's audio shows speech by the strict bounds at any length (from SPEECH_SHORT_MIN_FRAMES,
 * 0.512 s; a short file's one partial window): its envelope range reaches
 * SPEECH_NOISE_MAX_RANGE_DB (6 dB; from SPEECH_NOISE_MIN_FRAMES, 8 s, on:
 * SPEECH_NO_VOICE_LONG_MIN_RANGE_DB, 8 dB), its periodic share SPEECH_NOISE_MAX_PERIODIC_SHARE
 * (0.1), or it has a burst of SPEECH_NOISE_MAX_BURST_FRAMES frames (a word): clearlyNoise without
 * its 8 s floor, inverted, with a higher range bound for a long file. What a file of a no-voice
 * channel (recording-verdict.ts noVoiceChannel) must show to be kept. Measured (SYNTHETIC, the
 * lowest of every 0.5 s cut of a 13 s run through
 * WidebandNfmChain, cuts that start in speech): plain speech at a CNR of 5 dB or more passes from
 * 1 s (lowest range 6.54 dB, the pause-free talker at 5 dB: 0.54 dB of margin);
 * HARD_SPEECH_CASES at 5 to 20 dB pass from 1.5 s (lowest 6.31 dB, the 1 000 Hz talker at 8 dB;
 * the pitched low-deviation shallow talker under 6 dB passes by its periodic share, 0.19 or
 * more), 0.85 dB or more of range margin from 3 s; a single word or sparse words on a quiet
 * carrier pass by their burst (4 frames or more). Open-squelch noise, 4FSK, GMSK-like data and an
 * unmodulated carrier at a CNR of 10 dB or more measure at most 5.26 dB with no burst: they fail;
 * a periodic signal (2FSK, a tone) passes (kept). Real noise a listener confirmed (two channels,
 * eight files of 2.9 to 35.5 s) measures 2.84 to 5.56 dB, periodic share at most 0.02, no burst:
 * all fail (0.44 dB under the bound); that receiver's real voice measures 28.6 dB or more. THE
 * ACCEPTED EXCEPTIONS: a 1 s over of hard speech (1 000 or 1 500 Hz peak deviation, or a 30 %
 * shallow envelope) at a CNR of 5 to 10 dB can fail, and so does anything under 0.512 s, and an
 * 8 s or longer over at 500 Hz peak deviation at 8 to 10 dB (SPEECH_NO_VOICE_LONG_MIN_RANGE_DB);
 * a channel is a no-voice one only after ten trials heard nothing there.
 */
export function speechHeard(c: SpeechContent): boolean {
	const minRange =
		c.frames >= SPEECH_NOISE_MIN_FRAMES
			? SPEECH_NO_VOICE_LONG_MIN_RANGE_DB
			: SPEECH_NOISE_MAX_RANGE_DB
	return (
		c.frames >= SPEECH_SHORT_MIN_FRAMES &&
		(c.maxRangeDb >= minRange ||
			c.periodicShare >= SPEECH_NOISE_MAX_PERIODIC_SHARE ||
			c.maxBurstFrames >= SPEECH_NOISE_MAX_BURST_FRAMES)
	)
}

/**
 * The envelope range strongSpeech needs (dB): 15. Measured on kept files: real voice at least
 * 31.1 dB (p10), every digital voice, flat carrier and noise file at most 10.1 dB (p90); 15 leaves
 * 4.9 dB over the highest non-voice file and 16.1 dB under the lowest voice one.
 */
export const SPEECH_STRONG_MIN_RANGE_DB = 15
/**
 * The periodic share strongSpeech needs: 0.05. Measured on kept files: real voice at least 0.05
 * (p10 of a voice channel with its own tone; others 0.30), digital and noise files 0.01 to 0.05;
 * the share alone does not separate them, the range does, and this keeps a file with no pitched
 * frame (a bare carrier with noise bursts) out.
 */
export const SPEECH_STRONG_MIN_PERIODIC_SHARE = 0.05

/**
 * Strong speech (the recorder's class by speech alone, wideband-analog-recorder.ts
 * classBySpeech): at least SPEECH_WINDOW_FRAMES frames (94 × 32 ms = 3.008 s, the first whole
 * window: "3 s or more"), an envelope range of SPEECH_STRONG_MIN_RANGE_DB or more and a periodic
 * share of SPEECH_STRONG_MIN_PERIODIC_SHARE or more. Paging audio passes it too: the class also
 * needs a channel whose trials heard voice (recording-verdict.ts trialsVoiceChannel).
 */
export function strongSpeech(c: SpeechContent): boolean {
	return (
		c.frames >= SPEECH_WINDOW_FRAMES &&
		c.maxRangeDb >= SPEECH_STRONG_MIN_RANGE_DB &&
		c.periodicShare >= SPEECH_STRONG_MIN_PERIODIC_SHARE
	)
}

/**
 * finishVerdict's three content readings of a file's measure (`c` null: not measured, so none
 * discards it, and `speechHeard` is null, logged as not measured): clearlyNotSpeech,
 * clearlyNoise, speechHeard.
 */
export function speechReadings(c: SpeechContent | null): {
	readonly notSpeech: boolean
	readonly clearNoise: boolean
	readonly speechHeard: boolean | null
} {
	return c === null
		? { notSpeech: false, clearNoise: false, speechHeard: null }
		: {
				notSpeech: clearlyNotSpeech(c),
				clearNoise: clearlyNoise(c),
				speechHeard: speechHeard(c),
			}
}

/**
 * Recording admission (candidate rule RA-2, PROVISIONAL: the bounds below are set from synthetic
 * signals and a few listened files and await calibration on a labelled corpus). A finished file of
 * a channel with no digital evidence is discarded as noise (recording-verdict.ts finishPath,
 * `discarded:noise`) only when EVERY level window looks like open-squelch noise or data buzz: real
 * FM voice shows carrier quieting between words (frame levels down to −30 to −50 dBFS), noise and
 * data never fall under about −15 dBFS and keep a narrow level spread.
 */
export interface AdmissionThresholds {
	/** Level frames needed to judge at all; fewer: not measured (null, kept). */
	readonly minFrames: number
	/** Every window's level spread (p90 − p10, dB) must be under this. */
	readonly maxSpreadDb: number
	/** Every window's p10 level (dBFS) must be over this (no quieting anywhere). */
	readonly minFloorDbfs: number
	/** The longest burst (SpeechContent.maxBurstFrames) must be under this. */
	readonly maxBurstFrames: number
	/** The periodic share must be under this. */
	readonly maxPeriodicShare: number
}
/** 94 level frames × 32 ms = 3.008 s: one whole level window. */
export const ADMISSION_MIN_FRAMES = SPEECH_WINDOW_FRAMES
/**
 * 10 dB: synthetic open-squelch noise and 4FSK/GMSK-like buzz spread a few dB per window (a frame's
 * 118 bins hold about 236 degrees of freedom, 4.34·√(2/236) ≈ 0.4 dB rms); speech with quieting
 * spreads tens of dB.
 */
export const ADMISSION_MAX_SPREAD_DB = 10
/**
 * −25 dBFS: noise and data hold at or over about −15 dBFS (a 10 dB margin); a quieted carrier
 * between words falls to −30 to −50 dBFS.
 */
export const ADMISSION_MIN_FLOOR_DBFS = -25
/** 4 frames (128 ms): a word on a quiet carrier stays 6 dB over its window's median 4 to 7 frames. */
export const ADMISSION_MAX_BURST_FRAMES = 4
/** 0.25: voiced speech (pitched frames) at a CNR of 9 dB or more measures 0.24 to 0.61. */
export const ADMISSION_MAX_PERIODIC = 0.25
export const ADMISSION_DEFAULTS: AdmissionThresholds = Object.freeze({
	minFrames: ADMISSION_MIN_FRAMES,
	maxSpreadDb: ADMISSION_MAX_SPREAD_DB,
	minFloorDbfs: ADMISSION_MIN_FLOOR_DBFS,
	maxBurstFrames: ADMISSION_MAX_BURST_FRAMES,
	maxPeriodicShare: ADMISSION_MAX_PERIODIC,
})

/**
 * The file measures as noise by the admission rule (AdmissionThresholds): true noise, false not
 * noise (kept), null not measured (fewer than `minFrames` level frames: kept).
 */
export function admissionNoise(
	c: SpeechContent,
	thresholds: AdmissionThresholds = ADMISSION_DEFAULTS,
): boolean | null {
	if (c.levelFrames < thresholds.minFrames) return null
	return (
		c.maxWindowSpreadDb < thresholds.maxSpreadDb &&
		c.minWindowP10Dbfs > thresholds.minFloorDbfs &&
		c.maxBurstFrames < thresholds.maxBurstFrames &&
		c.periodicShare < thresholds.maxPeriodicShare
	)
}
