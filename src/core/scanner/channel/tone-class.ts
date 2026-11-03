/**
 * The evidence a shadow recording's own audio must hold before the wideband recorder classes it
 * analog FM without a snapshot saying so (WidebandAnalogRecorder.classByTone). The class is the
 * recorder's own (it admits the files); it never becomes discovery evidence (no analog-tone
 * proof, no label), and a later verified digital class still cancels it.
 *
 * The voice gate (VoiceActivityGate) measures level and spectral tilt, and the CTCSS bank finds a
 * periodic sub-audible component: digital audio can fake both. Alternating 2FSK at 200 baud is a
 * 100 Hz square wave in the discriminator, whose fundamental qualifies as the 100 Hz tone and
 * whose harmonics pass the gate. So the class needs, over one file's in-track audio, read from
 * the CTCSS bank's 500 ms blocks (one every 250 ms; a block's winner is a standard tone holding
 * at least 65 % of the 50–300 Hz band and 3× the next tone):
 *
 * 1. A stable standard tone: the tone that won the most blocks won at least TONE_CLASS_MIN_WINS
 *    of them, at least TONE_CLASS_MIN_PURITY of every block any tone won (one tone, not a
 *    wandering line), at least TONE_CLASS_MIN_SHARE of all blocks, and never missed more than
 *    TONE_CLASS_MAX_GAP_BLOCKS blocks in a row. Speech over the tone can take blocks from it
 *    (its energy under 300 Hz breaks the band test), so the tone need not win most blocks; the
 *    synthetic voices of the tests have no energy under 300 Hz and their tone wins every block,
 *    so 40 % and the 8-block gap are design margins for real speech, not measurements. (The
 *    bank's own `result()`, 60 % of all blocks, is not used for the same reason.)
 * 2. A tone not stronger than any CTCSS encoder's: the tone band's RMS over the blocks the tone
 *    won (where the line holds most of the band), read as deviation at the tone's frequency
 *    through the chain's calibration, at most TONE_CLASS_MAX_DEVIATION_HZ. This only rejects a
 *    strong data fundamental (alternating 2FSK at ±2.4 kHz reads past it); it cannot tell a
 *    weaker one from a sinusoidal tone.
 * 3. Speech, not data: of at least SPEECH_MIN_FRAMES counted frames, at least SPEECH_MIN_SHARE
 *    over the syllabic index of `VoiceFrameMeter` (the analog trial's voice statistic,
 *    `ANALOG_TRIAL_VOICE_INDEX`), and at least PITCH_MIN_SHARE both over it and periodic: the
 *    frame's normalised autocorrelation peaks at PITCH_MIN_CORRELATION or more at a pitch lag
 *    of an 80 to 400 Hz fundamental (framePeriodicity). Speech rises and falls with its
 *    syllables, and its voiced sounds repeat at the speaker's pitch; 2FSK, 4FSK and POCSAG-like
 *    data keep a steady envelope, and FM noise (a fading or weak carrier, noise modulation) may
 *    rise and fall but never repeats.
 *
 * Measured through WidebandNfmChain at 96 kS/s on synthetic signals, 8 s each (the tests use the
 * same generators): voice with syllables over 67, 100 or 254.1 Hz CTCSS at 350 Hz deviation puts
 * 98 % of its frames over the index and 83 to 100 % over it and periodic; alternating 2FSK at
 * 200 baud (±2400, ±600 Hz), at 134 baud, random 2FSK at 200 baud, random 4FSK at 4800 baud and
 * POCSAG-like 512 and 1200 baud data put 0 % over the index (median 0.00 to 0.19). A carrier
 * with only a CTCSS tone fading at 4 Hz (0.04 to 0.32 of full scale, IQ noise) and 5 kHz of
 * noise deviation keyed at 4 Hz over a tone put 100 % over the index but 0 % periodic. A weak
 * synthetic voice (the tests' WeakSpeechSource: one pitched syllable in six, the rest
 * fricative-like noise, at 11.9 dB in 12.5 kHz) puts 100 % over the index and 16 to 20 % over it
 * and periodic. The speech test is what rejects data and
 * noise; the tone tests reject keyed or wandering lines and very strong fundamentals. Limits: a
 * voice with no syllabic rise and fall (a steady test tone) is not classed, and a periodic
 * waveform keyed at a syllabic rate over a steady standard sub-audible tone still is (a square
 * wave switched on and off at 4 Hz, DTMF digits, a five-tone selcall, a CW ID, AFSK keyed at
 * 3 Hz): such a class keeps the lowest slot priority (WidebandAnalogRecorder.evict). Nothing
 * here proves the audio is analog FM: it is enough to keep the recording, not to label the
 * discovery.
 *
 * Whole file: the recorder classes a session as soon as `result()` holds over the file so far,
 * and checks it again over the whole file when the file finishes; a file of a session classed
 * only by its audio that fails then is discarded (`discarded:unclassed`), e.g. 5 s of speech
 * followed by 11 s of a bare carrier.
 *
 * Cost: one VoiceFrameMeter per file while its session is unclassed or classed by its audio only
 * (three biquads per frame and one histogram k-means per 50 ms frame), one autocorrelation
 * (framePeriodicity, at most 31 000 products, stopped once periodic enough) per frame over the
 * syllabic index, and a few counters per bank block; nothing allocated after construction.
 * Measured over 60 s at load average 41 to 51: 1.3 to 2.0 ms of a core per second of speech,
 * 2.7 to 4.2 ms per second of syllabically keyed noise (every lag searched).
 */
import { CTCSS_HZ, type CtcssBank } from "../../audio-tones/ctcss.js"
import {
	VOICE_METER_FRAME_SAMPLES,
	VoiceFrameMeter,
} from "../../evidence-squelch/voice-meter.js"
import { ANALOG_TRIAL_VOICE_INDEX } from "../scanner-redesign-contract.js"

/**
 * Blocks the tone must have won: 8 blocks of 500 ms, at least 0.5 + 7 × 0.25 = 2.25 s of audio
 * in which the tone dominated the sub-audible band.
 */
export const TONE_CLASS_MIN_WINS = 8
/** Share of the blocks any tone won that this tone won (another tone winning is not CTCSS). */
export const TONE_CLASS_MIN_PURITY = 0.9
/** Share of all the file's blocks the tone won (speech may take the others: a design margin). */
export const TONE_CLASS_MIN_SHARE = 0.4
/**
 * Most blocks in a row without the tone (before its first win, between wins, or since its last):
 * 8 blocks = 2 s of hops, so a tone that left 2 s of audio no longer holds.
 */
export const TONE_CLASS_MAX_GAP_BLOCKS = 8
/**
 * Highest tone deviation accepted, as read from the won blocks' tone-band RMS. That reading
 * includes the band's other energy (the winner holds at least 65 % of the 50–300 Hz band, so up
 * to 1 / √0.65 = 1.24× high) and the tone filter's skirt above 300 Hz, so real speech over the
 * tone reads higher than the tone alone: synthetic 350 Hz CTCSS reads 351 to 364 Hz under the
 * synthetic voices (the weak one's noise adds the most). 2.5 kHz rejects only a strong data
 * fundamental (alternating 2FSK at ±1.96 kHz or more: 4/π · 1.96 = 2.5 kHz); weaker data is left
 * to the speech test.
 */
export const TONE_CLASS_MAX_DEVIATION_HZ = 2_500
/** Frames (50 ms) of in-track audio the speech test needs: 40 = 2 s. */
export const SPEECH_MIN_FRAMES = 40
/**
 * Frames after a break in the fed audio before one counts: the meter's envelope ring holds 20
 * frames (1 s), so its index settles over the first 10 (500 ms).
 */
export const SPEECH_WARMUP_FRAMES = 10
/** Share of counted frames over the syllabic index (measured: voice 90 to 98 %, data 0 %). */
export const SPEECH_MIN_SHARE = 0.5
/**
 * Pitch lags searched (8 kHz samples): 20 to 100, a fundamental of 400 Hz down to 80 Hz (the
 * span of adult voices). The audio is already high-passed at 300 Hz (WidebandNfmChain), so a
 * CTCSS tone does not reach it; a voice's harmonics above 300 Hz repeat at its fundamental's
 * period.
 */
export const PITCH_MIN_LAG = 20
export const PITCH_MAX_LAG = 100
/**
 * Normalised autocorrelation a frame's best pitch lag must reach to count as voiced speech.
 * Measured per 50 ms frame through WidebandNfmChain: FM noise (a CTCSS-only carrier fading at
 * 4 Hz at 0.04 to 0.32 of full scale, or 5 kHz of noise deviation keyed at 4 Hz over a tone)
 * peaked under 0.5 in all of 750 frames (most under 0.2); the synthetic voice's tones reach
 * 0.9 in 75 to 96 % of frames.
 */
export const PITCH_MIN_CORRELATION = 0.5
/**
 * Share of counted frames that must be both over the syllabic index and periodic
 * (PITCH_MIN_CORRELATION): 0.1. Measured through the recorder at 96 kS/s on the tests' synthetic
 * sources: the weak voice with one pitched syllable in six puts 8 of its first 40 counted frames
 * over both (20 %, when it is classed, 3.6 s after its onset) and 33 of 208 by 12 s (15.9 %);
 * one pitched syllable in twenty puts 10 of 208 (4.8 %, never classed); FM noise (a fading
 * CTCSS-only carrier, syllabic noise) 0 %; the data signals that pass the syllabic index put
 * fewer than 10 % in the synthetic checks (POCSAG-like 1200 baud keyed at 2 Hz about 6 %, 4FSK,
 * FFSK and AFSK1200 keyed at 4 Hz under 1 %). A square wave keyed at a syllabic rate puts 100 %
 * (the disclosed limit above). 0.1 lies 1.59× under the weak voice at 12 s (15.9 / 10) and over
 * the one in twenty (10 / 4.8 = 2.1×); counted frames a·n with atLeast: 4 of 40, 21 of 208.
 */
export const PITCH_MIN_SHARE = 0.1

/**
 * Peak normalised autocorrelation of `frame[0, n)` over lags PITCH_MIN_LAG to PITCH_MAX_LAG:
 * r(L) = Σ x[i]·x[i+L] / √(Σ x[i]² · Σ x[i+L]²) over the n − L overlapping samples, so 1 for a
 * waveform repeating at L and near 0 for noise (a 400-sample frame's estimate of an uncorrelated
 * lag has a spread of about 1 / √300 = 0.06). 0 for a frame shorter than PITCH_MAX_LAG + 1 or
 * silent. `enough`: stop at the first lag that reaches it (the result is then at least
 * `enough`, not the peak). Cost: 81 lags × at most 380 products, 31 000 per 50 ms frame, fewer
 * when `enough` is reached early.
 */
export function framePeriodicity(
	frame: Float32Array,
	n: number,
	enough = Number.POSITIVE_INFINITY,
): number {
	if (n <= PITCH_MAX_LAG) return 0
	let head = 0
	for (let i = 0; i < n - PITCH_MIN_LAG; i++) head += frame[i]! * frame[i]!
	let tail = 0
	for (let i = PITCH_MIN_LAG; i < n; i++) tail += frame[i]! * frame[i]!
	let best = 0
	for (let lag = PITCH_MIN_LAG; lag <= PITCH_MAX_LAG; lag++) {
		if (lag > PITCH_MIN_LAG) {
			// Shrink both windows by one sample: head loses x[n − lag], tail loses x[lag − 1].
			const a = frame[n - lag]!
			const b = frame[lag - 1]!
			head -= a * a
			tail -= b * b
		}
		const energy = head * tail
		if (!(energy > 1e-18)) continue
		let acc = 0
		for (let i = 0; i + lag < n; i++) acc += frame[i]! * frame[i + lag]!
		const r = acc / Math.sqrt(energy)
		if (r > best) best = r
		if (best >= enough) break
	}
	return best
}

/** The bank's block (500 ms) and hop (250 ms) at 8 kHz (audio-tones/ctcss.ts). */
export const TONE_BANK_BLOCK = 4_000
export const TONE_BANK_HOP = 2_000
/** Discriminator full scale (FmAudioDemod: 5 kHz deviation is 1.0 before the ×4 makeup). */
const FULL_SCALE_DEVIATION_HZ = 5_000
const MAKEUP = 4
/** 750 µs de-emphasis corner: 1 / (2π · 750 µs) = 212.2 Hz. */
const DEEMPHASIS_CORNER_HZ = 1 / (2 * Math.PI * 750e-6)

/**
 * Peak deviation (Hz) of a sine at `hz` whose tone-band audio has `rms` (s16 units): the chain
 * maps deviation d to an amplitude of d / 5000 · 4 · g(f), g the de-emphasis gain
 * 1 / √(1 + (f / 212.2)²). Measured: 350 Hz at 67 Hz reads 354 Hz.
 */
export function toneDeviationHz(rms: number, hz: number): number {
	const g = 1 / Math.sqrt(1 + (hz / DEEMPHASIS_CORNER_HZ) ** 2)
	return (
		((rms * Math.SQRT2) / 32_768) * (FULL_SCALE_DEVIATION_HZ / (MAKEUP * g))
	)
}

/**
 * The smallest count that is at least `share` of `n`: ⌈share · n⌉, less a 1e-9 guard so a product
 * that floating point puts just over an integer (0.28 · 25 = 7.000000000000001) is not rounded up.
 */
export function atLeast(share: number, n: number): number {
	return Math.ceil(share * n - 1e-9)
}

/**
 * Test 3 (speech) over the counted frames: at least SPEECH_MIN_FRAMES, at least SPEECH_MIN_SHARE
 * of them over the syllabic index and at least PITCH_MIN_SHARE over it and periodic.
 */
export function speechHolds(counts: {
	frames: number
	syllabic: number
	voiced: number
}): boolean {
	return (
		counts.frames >= SPEECH_MIN_FRAMES &&
		counts.syllabic >= atLeast(SPEECH_MIN_SHARE, counts.frames) &&
		counts.voiced >= atLeast(PITCH_MIN_SHARE, counts.frames)
	)
}

export class ToneClassEvidence {
	/** Blocks each tone won since the file started (bank.lastBlockToneIndex per new block). */
	private readonly wins = new Uint32Array(CTCSS_HZ.length)
	/** Tone-band energy (s16²) over the blocks each tone won. */
	private readonly wonEnergy = new Float64Array(CTCSS_HZ.length)
	/** Index of the block each tone last won (-1: none yet). */
	private readonly lastWin = new Int32Array(CTCSS_HZ.length).fill(-1)
	/** Longest run of blocks each tone missed between its wins (and before its first). */
	private readonly maxGap = new Uint32Array(CTCSS_HZ.length)
	private blocks = 0
	private wonAny = 0
	private seenBlocks = 0
	/** Samples the bank took (its hops end every TONE_BANK_HOP of them). */
	private samples = 0
	private hopEnergy = 0
	private prevHopEnergy = 0
	private readonly speech = new VoiceFrameMeter({ gain: 2 })
	/** The meter's current frame (its samples, in step with its own fill). */
	private readonly frame = new Float32Array(VOICE_METER_FRAME_SAMPLES)
	private frameFill = 0
	private speechFrames = 0
	/** Counted frames over the syllabic index. */
	private speechSyllabic = 0
	/** Counted frames over the syllabic index and periodic (a pitch). */
	private speechVoiced = 0
	/** Sample past the last frame the speech meter heard (a run that does not join resets it). */
	speechTo = Number.NEGATIVE_INFINITY

	/** One in-track tone-band frame (s16), after `bank` took it (every frame the bank takes). */
	tone(
		bank: Pick<CtcssBank, "blockCount" | "lastBlockToneIndex">,
		sample: number,
	): void {
		this.hopEnergy += sample * sample
		this.samples++
		const n = bank.blockCount()
		if (n !== this.seenBlocks) {
			this.seenBlocks = n
			// The block is the bank's last TONE_BANK_BLOCK samples: this hop and the one before.
			this.block(bank.lastBlockToneIndex(), this.prevHopEnergy + this.hopEnergy)
		}
		if (this.samples % TONE_BANK_HOP !== 0) return
		this.prevHopEnergy = this.hopEnergy
		this.hopEnergy = 0
	}

	/** In-track voice-band frames `start` to `end` of `pcm` (s16); `reset`: a break before them. */
	speechRun(pcm: Int16Array, start: number, end: number, reset: boolean): void {
		if (reset) {
			this.speech.reset()
			this.frameFill = 0
		}
		const frame = this.frame
		for (let i = start; i < end; i++) {
			const x = pcm[i]! / 32_768
			if (this.frameFill < frame.length) frame[this.frameFill++] = x
			if (!this.speech.push(x)) continue
			const n = this.frameFill
			this.frameFill = 0
			if (this.speech.frameCount <= SPEECH_WARMUP_FRAMES) continue
			this.speechFrames++
			const f = this.speech.frame
			if (!f.finite || f.syllabic < ANALOG_TRIAL_VOICE_INDEX) continue
			this.speechSyllabic++
			if (
				framePeriodicity(frame, n, PITCH_MIN_CORRELATION) >=
				PITCH_MIN_CORRELATION
			)
				this.speechVoiced++
		}
	}

	/** Counted frames, those over the syllabic index, and those also periodic (tests, diagnostics). */
	get speechCounts(): { frames: number; syllabic: number; voiced: number } {
		return {
			frames: this.speechFrames,
			syllabic: this.speechSyllabic,
			voiced: this.speechVoiced,
		}
	}

	/** The tone (Hz) when all three tests above hold; otherwise null. */
	result(): number | null {
		let best = -1
		let won = 0
		for (let i = 0; i < CTCSS_HZ.length; i++)
			if ((this.wins[i] ?? 0) > won) {
				best = i
				won = this.wins[i] ?? 0
			}
		if (best < 0) return null
		const trailing = this.blocks - 1 - (this.lastWin[best] ?? -1)
		if (
			won < TONE_CLASS_MIN_WINS ||
			won < atLeast(TONE_CLASS_MIN_PURITY, this.wonAny) ||
			won < atLeast(TONE_CLASS_MIN_SHARE, this.blocks) ||
			Math.max(this.maxGap[best] ?? 0, trailing) > TONE_CLASS_MAX_GAP_BLOCKS
		)
			return null
		const hz = CTCSS_HZ[best]!
		const rms = Math.sqrt((this.wonEnergy[best] ?? 0) / (won * TONE_BANK_BLOCK))
		if (toneDeviationHz(rms, hz) > TONE_CLASS_MAX_DEVIATION_HZ) return null
		if (!speechHolds(this.speechCounts)) return null
		return hz
	}

	/**
	 * Whether test 1's gap rule can still hold for some tone over this file: false once every
	 * tone missed more than TONE_CLASS_MAX_GAP_BLOCKS blocks in a row, counting a run still open
	 * (a later win ends it at least that long) and, for a tone that never won, every block so far
	 * (its first win would come after them). False is final for this file: `result()` stays null
	 * whatever audio follows. With no tone winning, that is block 9, 0.5 + 8 × 0.25 = 2.5 s of
	 * in-track audio.
	 */
	toneCanHold(): boolean {
		for (let i = 0; i < CTCSS_HZ.length; i++) {
			const last = this.lastWin[i] ?? -1
			const run = this.blocks - 1 - last
			const gap = last < 0 ? this.blocks : Math.max(this.maxGap[i] ?? 0, run)
			if (gap <= TONE_CLASS_MAX_GAP_BLOCKS) return true
		}
		return false
	}

	private block(winner: number, energy: number): void {
		const k = this.blocks++
		if (winner < 0 || winner >= CTCSS_HZ.length) return
		this.wonAny++
		this.wins[winner] = (this.wins[winner] ?? 0) + 1
		this.wonEnergy[winner] = (this.wonEnergy[winner] ?? 0) + energy
		const gap = k - (this.lastWin[winner] ?? -1) - 1
		if (gap > (this.maxGap[winner] ?? 0)) this.maxGap[winner] = gap
		this.lastWin[winner] = k
	}
}
