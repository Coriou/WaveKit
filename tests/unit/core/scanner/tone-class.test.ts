/**
 * ToneClassEvidence (the recorder's own-audio class, classByTone): each bound at and past its
 * limit, and the separation of speech from steady data audio.
 */
import { describe, expect, it } from "vitest"
import { CTCSS_HZ } from "../../../../src/core/audio-tones/ctcss.js"
import { mulberry32 } from "../../../mocks/scanner/signals.js"
import {
	PITCH_MAX_LAG,
	PITCH_MIN_CORRELATION,
	PITCH_MIN_LAG,
	PITCH_MIN_SHARE,
	SPEECH_MIN_FRAMES,
	SPEECH_MIN_SHARE,
	SPEECH_WARMUP_FRAMES,
	TONE_BANK_BLOCK,
	TONE_BANK_HOP,
	TONE_CLASS_MAX_DEVIATION_HZ,
	TONE_CLASS_MAX_GAP_BLOCKS,
	TONE_CLASS_MIN_PURITY,
	TONE_CLASS_MIN_SHARE,
	TONE_CLASS_MIN_WINS,
	ToneClassEvidence,
	atLeast,
	framePeriodicity,
	speechHolds,
	toneDeviationHz,
} from "../../../../src/core/scanner/channel/tone-class.js"

const HZ = 100
const T = CTCSS_HZ.indexOf(HZ)
const OTHER = T + 1
const NONE = -1
/** VoiceFrameMeter frame: 50 ms at 8 kHz. */
const FRAME = 400

/** Speech-like audio: a 1 kHz tone under a 4 Hz raised-cosine envelope (s16). */
function speech(frames: number): Int16Array {
	const pcm = new Int16Array(frames)
	for (let i = 0; i < frames; i++) {
		const t = i / 8000
		pcm[i] = Math.round(
			8000 *
				(0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t)) *
				Math.sin(2 * Math.PI * 1000 * t),
		)
	}
	return pcm
}

/** Steady data-like audio: a constant-level 1 kHz square wave (s16). */
function steady(frames: number): Int16Array {
	const pcm = new Int16Array(frames)
	for (let i = 0; i < frames; i++) pcm[i] = (i >> 2) % 2 === 0 ? 6000 : -6000
	return pcm
}

/** Amplitude (s16) whose RMS reads `deviation` Hz at HZ. */
const rmsFor = (deviation: number): number => deviation / toneDeviationHz(1, HZ)

const ENOUGH_SPEECH = (SPEECH_WARMUP_FRAMES + SPEECH_MIN_FRAMES) * FRAME

/**
 * Evidence fed like the recorder feeds it: tone-band samples of amplitude `rms` (alternating
 * sign) with a stand-in for the bank whose block k (one per TONE_BANK_HOP samples from
 * TONE_BANK_BLOCK on, as CtcssBank) is won by `winners[k]`, and `speechFrames` of speech.
 */
function evidence(
	winners: readonly number[],
	rms = rmsFor(350),
	speechFrames = ENOUGH_SPEECH,
): ToneClassEvidence {
	const e = new ToneClassEvidence()
	let blocks = 0
	const bank = {
		blockCount: () => blocks,
		lastBlockToneIndex: () => winners[blocks - 1] ?? NONE,
	}
	const samples = TONE_BANK_BLOCK + (winners.length - 1) * TONE_BANK_HOP
	for (let n = 1; n <= samples; n++) {
		if (n >= TONE_BANK_BLOCK && (n - TONE_BANK_BLOCK) % TONE_BANK_HOP === 0)
			blocks++
		e.tone(bank, n % 2 === 0 ? rms : -rms)
	}
	e.speechRun(speech(speechFrames), 0, speechFrames, true)
	return e
}

const all = (n: number, w = T): number[] => Array.from({ length: n }, () => w)

describe("ToneClassEvidence", () => {
	it("reads a tone's deviation from its tone-band RMS through the chain's calibration", () => {
		// 350 Hz at 67 Hz measured RMS 6262 through WidebandNfmChain (tone-class.ts).
		expect(toneDeviationHz(6262, 67)).toBeGreaterThan(340)
		expect(toneDeviationHz(6262, 67)).toBeLessThan(365)
	})

	it(`needs ${TONE_CLASS_MIN_WINS} blocks won (2.25 s of tone-dominated audio)`, () => {
		expect(evidence(all(TONE_CLASS_MIN_WINS - 1)).result()).toBeNull()
		expect(evidence(all(TONE_CLASS_MIN_WINS)).result()).toBe(HZ)
	})

	it(`needs ${TONE_CLASS_MIN_SHARE * 100} % of all blocks: speech may take the others`, () => {
		// 8 of 20 blocks (40 %) passes, 8 of 21 does not; gaps stay at most 2 blocks.
		const spread = (n: number) =>
			Array.from({ length: n }, (_, k) =>
				k % 5 === 0 || k % 5 === 3 ? T : NONE,
			)
		expect(spread(20).filter(w => w === T)).toHaveLength(8)
		expect(evidence(spread(20)).result()).toBe(HZ)
		const thin = [...spread(20), NONE]
		expect(evidence(thin).result()).toBeNull()
	})

	it(`needs ${TONE_CLASS_MIN_PURITY * 100} % of the won blocks: another tone winning is not one CTCSS tone`, () => {
		// 9 of 10 won blocks: passes; 9 of 11: does not.
		expect(evidence([...all(9), OTHER]).result()).toBe(HZ)
		expect(evidence([...all(9), OTHER, OTHER]).result()).toBeNull()
	})

	it(`a run of more than ${TONE_CLASS_MAX_GAP_BLOCKS} blocks without the tone (before, between or after its wins) bars it`, () => {
		const gap = (n: number) => all(n, NONE)
		expect(evidence([...all(4), ...gap(8), ...all(4)]).result()).toBe(HZ)
		expect(evidence([...all(4), ...gap(9), ...all(5)]).result()).toBeNull()
		expect(evidence([...gap(9), ...all(10)]).result()).toBeNull()
		expect(evidence([...all(12), ...gap(8)]).result()).toBe(HZ)
		expect(evidence([...all(12), ...gap(9)]).result()).toBeNull()
	})

	it(`refuses a sub-audible line above ${TONE_CLASS_MAX_DEVIATION_HZ} Hz deviation (a data fundamental)`, () => {
		expect(
			evidence(
				all(TONE_CLASS_MIN_WINS),
				rmsFor(TONE_CLASS_MAX_DEVIATION_HZ - 1),
			).result(),
		).toBe(HZ)
		expect(
			evidence(
				all(TONE_CLASS_MIN_WINS),
				rmsFor(TONE_CLASS_MAX_DEVIATION_HZ + 5),
			).result(),
		).toBeNull()
	})

	it(`needs ${SPEECH_MIN_FRAMES} speech frames after a ${SPEECH_WARMUP_FRAMES}-frame warm-up (2.5 s of in-track audio)`, () => {
		const blocks = all(TONE_CLASS_MIN_WINS)
		expect(
			evidence(blocks, rmsFor(350), ENOUGH_SPEECH - FRAME).result(),
		).toBeNull()
		expect(evidence(blocks, rmsFor(350), ENOUGH_SPEECH).result()).toBe(HZ)
	})

	it("steady (data-like) audio never passes the speech test, however long", () => {
		const e = evidence(all(20), rmsFor(350), 0)
		const pcm = steady(20 * 8000)
		e.speechRun(pcm, 0, pcm.length, true)
		expect(e.result()).toBeNull()
	})

	it("no won block: no tone", () => {
		expect(evidence(all(20, NONE)).result()).toBeNull()
	})
})

/** White noise (s16) under a 4 Hz raised-cosine envelope: rises and falls, never repeats. */
function envelopedNoise(frames: number, seed = 5): Int16Array {
	const rng = mulberry32(seed)
	const pcm = new Int16Array(frames)
	for (let i = 0; i < frames; i++) {
		const t = i / 8000
		pcm[i] = Math.round(
			8000 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t)) * (2 * rng() - 1),
		)
	}
	return pcm
}

describe("ToneClassEvidence bounds", () => {
	// Feature: wideband analog recorder, own-audio class.
	it(`the level bound is inclusive at ${TONE_CLASS_MAX_DEVIATION_HZ} Hz: 0.01 Hz under passes, 0.01 Hz over fails`, () => {
		const blocks = all(TONE_CLASS_MIN_WINS)
		expect(
			evidence(blocks, rmsFor(TONE_CLASS_MAX_DEVIATION_HZ - 0.01)).result(),
		).toBe(HZ)
		expect(
			evidence(blocks, rmsFor(TONE_CLASS_MAX_DEVIATION_HZ + 0.01)).result(),
		).toBeNull()
	})

	it(`speech needs ${SPEECH_MIN_SHARE * 100} % syllabic and ${PITCH_MIN_SHARE * 100} % syllabic and periodic frames, at and past each bound`, () => {
		const frames = SPEECH_MIN_FRAMES
		// 40 frames: 20 syllabic (50 %) and 4 periodic (10 %) is the least that passes.
		expect(atLeast(SPEECH_MIN_SHARE, frames)).toBe(20)
		expect(atLeast(PITCH_MIN_SHARE, frames)).toBe(4)
		expect(speechHolds({ frames, syllabic: 20, voiced: 4 })).toBe(true)
		expect(speechHolds({ frames, syllabic: 19, voiced: 4 })).toBe(false)
		expect(speechHolds({ frames, syllabic: 20, voiced: 3 })).toBe(false)
		expect(speechHolds({ frames: frames - 1, syllabic: 39, voiced: 39 })).toBe(
			false,
		)
		// An odd count, 121 frames: ⌈60.5⌉ = 61 and ⌈12.1⌉ = 13.
		expect(speechHolds({ frames: 121, syllabic: 61, voiced: 13 })).toBe(true)
		expect(speechHolds({ frames: 121, syllabic: 60, voiced: 13 })).toBe(false)
		expect(speechHolds({ frames: 121, syllabic: 121, voiced: 12 })).toBe(false)
		// 110 frames: exactly 11 (10 %) is enough.
		expect(atLeast(PITCH_MIN_SHARE, 110)).toBe(11)
		expect(speechHolds({ frames: 110, syllabic: 110, voiced: 11 })).toBe(true)
		expect(speechHolds({ frames: 110, syllabic: 110, voiced: 10 })).toBe(false)
	})

	it(`toneCanHold turns false, for good, once every tone missed more than ${TONE_CLASS_MAX_GAP_BLOCKS} blocks in a row`, () => {
		const gap = (n: number) => all(n, NONE)
		// No tone won: block 9 (2.5 s of audio) is the first past the bound.
		expect(evidence(gap(TONE_CLASS_MAX_GAP_BLOCKS)).toneCanHold()).toBe(true)
		expect(evidence(gap(TONE_CLASS_MAX_GAP_BLOCKS + 1)).toneCanHold()).toBe(
			false,
		)
		// A won tone: an open run counts, and a closed gap past the bound stays.
		expect(
			evidence([...all(4), ...gap(TONE_CLASS_MAX_GAP_BLOCKS)]).toneCanHold(),
		).toBe(true)
		expect(
			evidence([
				...all(4),
				...gap(TONE_CLASS_MAX_GAP_BLOCKS + 1),
			]).toneCanHold(),
		).toBe(false)
		expect(
			evidence([
				...all(4),
				...gap(TONE_CLASS_MAX_GAP_BLOCKS + 1),
				...all(20),
			]).toneCanHold(),
		).toBe(false)
		// Another tone whose first win came after more than that many blocks cannot either; one
		// that never missed that many still can.
		expect(
			evidence([
				...all(4),
				...gap(TONE_CLASS_MAX_GAP_BLOCKS + 1),
				...all(4, OTHER),
			]).toneCanHold(),
		).toBe(false)
		expect(
			evidence([...gap(4), ...all(4, OTHER), ...gap(4)]).toneCanHold(),
		).toBe(true)
		// Whenever it is false, result() is null whatever follows.
		expect(
			evidence([...gap(TONE_CLASS_MAX_GAP_BLOCKS + 1), ...all(30)]).result(),
		).toBeNull()
	})

	it("a share that floating point puts just over an integer is not rounded up", () => {
		// 0.28 · 25 = 7.000000000000001 in binary floating point.
		expect(0.28 * 25).toBeGreaterThan(7)
		expect(atLeast(0.28, 25)).toBe(7)
		expect(atLeast(0.5, 41)).toBe(21)
	})

	it(`a frame is periodic at a pitch lag of ${PITCH_MIN_LAG} to ${PITCH_MAX_LAG} samples (400 to 80 Hz)`, () => {
		const frame = new Float32Array(400)
		const pulses = (period: number) => {
			frame.fill(0)
			for (let i = 0; i < frame.length; i += period) frame[i] = 1
			return framePeriodicity(frame, frame.length)
		}
		expect(pulses(PITCH_MAX_LAG)).toBeGreaterThan(0.99)
		// A pulse every 101 samples (79 Hz) repeats at no searched lag.
		expect(pulses(PITCH_MAX_LAG + 1)).toBe(0)
		expect(pulses(PITCH_MIN_LAG)).toBeGreaterThan(0.99)
		for (let i = 0; i < frame.length; i++)
			frame[i] = Math.sin((2 * Math.PI * 1000 * i) / 8000)
		expect(framePeriodicity(frame, frame.length)).toBeGreaterThan(0.99)
		// Too short for the longest lag, or silent: 0.
		expect(framePeriodicity(frame, PITCH_MAX_LAG)).toBe(0)
		expect(framePeriodicity(new Float32Array(400), 400)).toBe(0)
	})

	it(`white noise stays under ${PITCH_MIN_CORRELATION} in every one of 500 frames`, () => {
		const rng = mulberry32(11)
		const frame = new Float32Array(400)
		let max = 0
		for (let k = 0; k < 500; k++) {
			for (let i = 0; i < frame.length; i++) frame[i] = 2 * rng() - 1
			max = Math.max(max, framePeriodicity(frame, frame.length))
		}
		expect(max).toBeLessThan(PITCH_MIN_CORRELATION)
	})

	it("noise that rises and falls like syllables is syllabic but not speech", () => {
		const e = evidence(all(20), rmsFor(350), 0)
		const pcm = envelopedNoise(8 * 8000)
		e.speechRun(pcm, 0, pcm.length, true)
		const c = e.speechCounts
		expect(c.frames).toBeGreaterThanOrEqual(SPEECH_MIN_FRAMES)
		expect(c.syllabic).toBeGreaterThanOrEqual(
			atLeast(SPEECH_MIN_SHARE, c.frames),
		)
		expect(c.voiced).toBe(0)
		expect(e.result()).toBeNull()
		// The speech-like fixture passes all three counts.
		const ok = evidence(all(20))
		expect(ok.speechCounts.voiced).toBeGreaterThanOrEqual(
			atLeast(PITCH_MIN_SHARE, ok.speechCounts.frames),
		)
		expect(ok.result()).toBe(HZ)
	})
})
