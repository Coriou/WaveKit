/**
 * Carrier quieting of a scanner analog file (QuietingMeter, fed by the file's SpeechContentMeter
 * when asked: `quieting: true`). Read by the recording admission on a channel with proven analog
 * voice (recording-verdict.ts noiseRuleJudges: the quieted periodic share): open-squelch static is rich in high frequencies, a
 * quieted FM carrier (voice or silence on it) is not. The measure is onset-trim.ts's: the second
 * difference of the 8 kHz audio (x[i] − 2·x[i−1] + x[i−2], a 12 dB/octave high-pass), its mean
 * energy per block in dB (+1: an all-zero block reads 0 dB).
 *
 * - The static level: the QUIET_STATIC_PERCENTILE (90th) percentile of the file's 20 ms block
 *   levels (ONSET_BLOCK_SAMPLES). Measured on live files: open-squelch static reads 77 to 83 dB
 *   per file (the noise emitter's files mostly 80 to 82 dB), about ±1.5 dB per block.
 * - A quieted block or frame: at least QUIET_DROP_DB (8 dB) under that level.
 * - The quieted periodic share: the periodic frames (SpeechContentMeter's own pitch test) over
 *   the quieted level frames (32 ms, SPEECH_FRAME_SAMPLES; a frame's level over its own 256
 *   samples), null under QUIET_MIN_FRAMES of them (16 frames = 0.512 s, the meter's own floor for
 *   a partial reading, SPEECH_SHORT_MIN_FRAMES): one pitched frame of a few is chance, both ways
 *   (measured: emitter static read 1 of 2 to 2 of 16 pitched, voice files 0 of 1 or 2).
 * - A quieted run: QUIET_RUN_BLOCKS blocks (15 × 20 ms = 300 ms) in a row all quieted (the lowest
 *   15-block window maximum at or under the threshold).
 *
 * A block or frame with more than half its samples exact zeros (a gap the recorder filled with
 * silence) is not audio heard: it is left out of the level and breaks a run. Bounded work: a few
 * operations per sample, a 15-value maximum per block, one walk of QUIET_BINS bins per reading;
 * about 3 KB of counters per meter whatever the file's length.
 */
import { ONSET_BLOCK_SAMPLES } from "./onset-trim.js"

/**
 * A quieted block or frame is at least 8 dB under the static level (5 times the static's ±1.5 dB
 * per block). Measured on the live recall corpus (every channel taken as proven): against 10 dB
 * (onset-trim.ts ONSET_DROP_DB) it keeps 11 more of a weak, partly quieted carrier's files of
 * voice discoveries, and keeps 1 more of the noise emitter's 517 files (4 in all, each one with a
 * carrier visible in its spectrogram).
 */
export const QUIET_DROP_DB = 8
/** The static level is the 90th percentile of the file's block levels. */
export const QUIET_STATIC_PERCENTILE = 0.9
/**
 * The quieted run: 15 blocks of 20 ms = 300 ms. It no longer keeps a file on its own (finishPath:
 * on a discovery at the noise gate, DISCOVERY_NOISE_GATE, a file kept only by it spends the
 * evidence budget like noise); it is read for the file's readings. Measured on
 * the live recall corpus: the shortest longest-quieted-run of a real over (182 files kept for
 * their own CTCSS tone) is 500 ms (25 blocks; 5th percentile 820 ms), so 300 ms leaves 200 ms of
 * margin under it; on pure static the noise emitter's runs reach 280 ms (14 blocks), and its 4 of
 * 517 files with a longer run each hold a carrier on the air (a weak over, a short quieted key-up,
 * a co-channel over with a tone line).
 */
export const QUIET_RUN_BLOCKS = 15
/**
 * Quieted level frames the quieted periodic share needs: 16 (0.512 s), speech-content.ts
 * SPEECH_SHORT_MIN_FRAMES (a literal here: speech-content.ts imports this module).
 */
export const QUIET_MIN_FRAMES = 16
/** Histogram bins: 0.5 dB wide over 0 to 120 dB (a full-scale int16 second difference reads 102 dB). */
export const QUIET_BIN_DB = 0.5
export const QUIET_BINS = 240

/** What QuietingMeter.reading() reports. */
export interface QuietingReading {
	/** The static level (dB, second-difference energy): the 90th percentile block level. */
	readonly staticDb: number
	/** Level frames at least QUIET_DROP_DB under it. */
	readonly quietedFrames: number
	/** Their periodic share; null under QUIET_MIN_FRAMES of them. */
	readonly quietedPeriodicShare: number | null
	/** A run of QUIET_RUN_BLOCKS quieted blocks (300 ms) was heard. */
	readonly quietedRun: boolean
}

const binOf = (db: number): number =>
	Math.max(0, Math.min(QUIET_BINS - 1, Math.floor(db / QUIET_BIN_DB)))
const FRAME_ZERO_LIMIT_BLOCK = ONSET_BLOCK_SAMPLES / 2

export class QuietingMeter {
	private p1 = 0
	private p2 = 0
	private started = false
	private blockE = 0
	private blockN = 0
	private blockZeros = 0
	private frameE = 0
	private frameN = 0
	private blocks = 0
	private readonly blockHist = new Uint32Array(QUIET_BINS)
	private readonly frameTotal = new Uint32Array(QUIET_BINS)
	private readonly framePitched = new Uint32Array(QUIET_BINS)
	/** The last QUIET_RUN_BLOCKS block levels, and how many heard in a row (no gap block). */
	private readonly ring = new Float64Array(QUIET_RUN_BLOCKS)
	private inRow = 0
	/** The lowest maximum of QUIET_RUN_BLOCKS blocks in a row. */
	private minRunMax = Number.POSITIVE_INFINITY

	/** One sample, in order. */
	sample(x: number): void {
		if (!this.started) {
			// The first sample has no history: it repeats itself (no step), as onset-trim.ts.
			this.p1 = x
			this.p2 = x
			this.started = true
		}
		const d = x - 2 * this.p1 + this.p2
		this.p2 = this.p1
		this.p1 = x
		const e = d * d
		this.blockE += e
		this.frameE += e
		this.frameN++
		if (x === 0) this.blockZeros++
		if (++this.blockN === ONSET_BLOCK_SAMPLES) this.endBlock()
	}

	/**
	 * The speech meter's frame ended (its samples were all given to `sample`): `pitched` its pitch
	 * test, `zeroHeavy` a gap frame (left out).
	 */
	frame(pitched: boolean, zeroHeavy: boolean): void {
		if (!zeroHeavy && this.frameN > 0) {
			const bin = binOf(10 * Math.log10(this.frameE / this.frameN + 1))
			this.frameTotal[bin]!++
			if (pitched) this.framePitched[bin]!++
		}
		this.frameE = 0
		this.frameN = 0
	}

	/** The reading so far; null before a whole block was heard. */
	reading(): QuietingReading | null {
		if (this.blocks === 0) return null
		const rank = Math.ceil(QUIET_STATIC_PERCENTILE * this.blocks)
		let seen = 0
		let bin = 0
		for (; bin < QUIET_BINS; bin++) {
			seen += this.blockHist[bin]!
			if (seen >= rank) break
		}
		const staticDb = (bin + 0.5) * QUIET_BIN_DB
		const threshold = staticDb - QUIET_DROP_DB
		let frames = 0
		let pitched = 0
		for (
			let b = 0;
			b < QUIET_BINS && (b + 0.5) * QUIET_BIN_DB <= threshold;
			b++
		) {
			frames += this.frameTotal[b]!
			pitched += this.framePitched[b]!
		}
		return {
			staticDb,
			quietedFrames: frames,
			quietedPeriodicShare: frames < QUIET_MIN_FRAMES ? null : pitched / frames,
			quietedRun: this.minRunMax <= threshold,
		}
	}

	private endBlock(): void {
		const gap = this.blockZeros > FRAME_ZERO_LIMIT_BLOCK
		const db = 10 * Math.log10(this.blockE / ONSET_BLOCK_SAMPLES + 1)
		this.blockE = 0
		this.blockN = 0
		this.blockZeros = 0
		if (gap) {
			this.inRow = 0
			return
		}
		this.blockHist[binOf(db)]!++
		this.ring[this.blocks % QUIET_RUN_BLOCKS] = db
		this.blocks++
		if (++this.inRow < QUIET_RUN_BLOCKS) return
		let max = Number.NEGATIVE_INFINITY
		for (let i = 0; i < QUIET_RUN_BLOCKS; i++)
			if (this.ring[i]! > max) max = this.ring[i]!
		if (max < this.minRunMax) this.minRunMax = max
	}
}
