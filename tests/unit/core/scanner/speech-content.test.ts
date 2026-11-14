/**
 * The speech-content measure (speech-content.ts) on synthetic audio through WidebandNfmChain
 * (speech-content-fixtures.ts): speech-like audio, with and without pauses and down to a CNR of
 * 5 dB, is never clearly not speech; FM-demodulated 4FSK, 2FSK, GMSK-like data, an unmodulated
 * carrier and open-squelch noise are; tones are kept by design; under 3 s nothing is judged; the
 * measure is chunk-split invariant.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { mulberry32 } from "../../../mocks/scanner/signals.js"
import {
	clearlyNoise,
	clearlyNotSpeech,
	SPEECH_FRAME_SAMPLES,
	SPEECH_NOISE_BURST_DB,
	SPEECH_NOISE_MAX_BURST_FRAMES,
	SPEECH_NOISE_MIN_FRAMES,
	SPEECH_NOT_SPEECH_MAX_PERIODIC_SHARE,
	SPEECH_STEADY_MAX_RANGE_DB,
	SPEECH_WINDOW_FRAMES,
	SpeechContentMeter,
	type SpeechContent,
} from "../../../../src/core/scanner/channel/speech-content.js"
import {
	CONTENT_CASES,
	HARD_SPEECH_CASES,
	contentAudio,
	type ContentSignal,
} from "./speech-content-fixtures.js"

const SECONDS = 8

function measure(pcm: Int16Array, chunk = 4_000): SpeechContent {
	const m = new SpeechContentMeter()
	for (let at = 0; at < pcm.length; at += chunk)
		m.push(pcm.subarray(at, at + chunk))
	return m.result()
}

describe("speech-content: synthetic signals through the NFM chain", () => {
	// Feature: speech content check, synthetic validation table.
	for (const c of CONTENT_CASES)
		it(`${c.name}: ${c.speech ? "speech (kept)" : c.kept === true ? "not speech, kept (a disclosed limit)" : "clearly not speech"}`, () => {
			const r = measure(contentAudio(c.signal, SECONDS))
			expect(r.frames).toBe(
				Math.floor((SECONDS * 8_000) / SPEECH_FRAME_SAMPLES),
			)
			expect(clearlyNotSpeech(r)).toBe(!c.speech && c.kept !== true)
			if (c.kept === true) return
			if (c.speech)
				// Margin: speech stays well clear of the steady bound.
				expect(r.maxRangeDb).toBeGreaterThan(SPEECH_STEADY_MAX_RANGE_DB + 3)
			else expect(r.maxRangeDb).toBeLessThan(SPEECH_STEADY_MAX_RANGE_DB - 4)
		}, 60_000)

	for (const pauses of ["short", "none"] as const)
		it(`speech at a CNR of 5 dB (${pauses} pauses) is kept`, () => {
			const r = measure(
				contentAudio(
					{ waveform: { kind: "speech", pauses }, cnrDb: 5 },
					SECONDS,
				),
			)
			expect(clearlyNotSpeech(r)).toBe(false)
			expect(r.maxRangeDb).toBeGreaterThan(SPEECH_STEADY_MAX_RANGE_DB + 2)
		}, 60_000)

	// Feature: speech content check, hard speech (low deviation, shallow syllables, no pauses).
	for (const c of HARD_SPEECH_CASES)
		it(`hard speech ${c.name}: kept, with a margin over the steady bound`, () => {
			const r = measure(contentAudio(c.signal, SECONDS))
			expect(clearlyNotSpeech(r)).toBe(false)
			// The hardest synthetic talkers sit 1.4 dB over the bound at 8 s (1.66 dB at the bench's 12 s).
			expect(r.maxRangeDb).toBeGreaterThan(SPEECH_STEADY_MAX_RANGE_DB + 1.25)
		}, 60_000)

	it("a steady tone is kept (periodic), and so is a speech burst after 6 s of data", () => {
		const tone = measure(
			contentAudio(
				{ waveform: { kind: "tone", hz: 1_000 }, cnrDb: 30 },
				SECONDS,
			),
		)
		expect(tone.maxRangeDb).toBeLessThan(SPEECH_STEADY_MAX_RANGE_DB)
		expect(tone.periodicShare).toBeGreaterThan(
			SPEECH_NOT_SPEECH_MAX_PERIODIC_SHARE,
		)
		expect(clearlyNotSpeech(tone)).toBe(false)
		const data: ContentSignal = {
			waveform: {
				kind: "fsk",
				baud: 4_800,
				levelsHz: [-1_944, -648, 648, 1_944],
			},
			cnrDb: 30,
		}
		const speech: ContentSignal = {
			waveform: { kind: "speech", pauses: "short" },
			cnrDb: 30,
		}
		const a = contentAudio(data, 6)
		const b = contentAudio(speech, 3)
		const both = new Int16Array(a.length + b.length)
		both.set(a)
		both.set(b, a.length)
		expect(clearlyNotSpeech(measure(a))).toBe(true)
		expect(clearlyNotSpeech(measure(both))).toBe(false)
	}, 60_000)
})

describe("speech-content: bounds", () => {
	it("under 3 s (SPEECH_WINDOW_FRAMES frames) nothing is judged, however steady", () => {
		const n = SPEECH_WINDOW_FRAMES * SPEECH_FRAME_SAMPLES
		const steady = new Int16Array(n).fill(1_000)
		expect(clearlyNotSpeech(measure(steady.subarray(0, n - 1)))).toBe(false)
		expect(measure(steady.subarray(0, n - 1)).maxRangeDb).toBe(0)
		expect(measure(steady).frames).toBe(SPEECH_WINDOW_FRAMES)
		expect(clearlyNotSpeech(measure(steady))).toBe(true)
		expect(measure(new Int16Array(0))).toEqual({
			frames: 0,
			maxRangeDb: 0,
			periodicShare: 0,
			maxBurstFrames: 0,
		})
	})

	it("result() may be read twice (finish, then the end of a hold): same answer", () => {
		const m = new SpeechContentMeter()
		m.push(
			contentAudio(
				{ waveform: { kind: "speech", pauses: "short" }, cnrDb: 30 },
				4,
			),
		)
		expect(m.result()).toEqual(m.result())
	}, 60_000)

	it("is chunk-split invariant (property)", () => {
		const pcm = contentAudio(
			{ waveform: { kind: "speech", pauses: "long" }, cnrDb: 12 },
			5,
		)
		const whole = measure(pcm, pcm.length)
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 9_000 }), chunk => {
				expect(measure(pcm, chunk)).toEqual(whole)
			}),
			{ numRuns: 100 },
		)
	}, 120_000)
})

describe("speech-content: the burst veto (clearlyNoise only)", () => {
	// Feature: speech content check, the burst veto (SPEECH_NOISE_MAX_BURST_FRAMES).
	// Validates: docs/SCANNER.md, "Analog voice recordings" (the content check).
	/**
	 * 8 s of band noise at a steady level with `burst` consecutive frames 12 dB louder (four times
	 * the amplitude) from frame 120: frame-aligned, so the meter sees exactly `burst` loud frames.
	 */
	function steadyWithBurst(burst: number): Int16Array {
		const rng = mulberry32(3)
		const pcm = new Int16Array(SPEECH_NOISE_MIN_FRAMES * SPEECH_FRAME_SAMPLES)
		for (let i = 0; i < pcm.length; i++) {
			const f = Math.floor(i / SPEECH_FRAME_SAMPLES)
			const amp = f >= 120 && f < 120 + burst ? 4_000 : 1_000
			pcm[i] = Math.round(amp * (2 * rng() - 1))
		}
		return pcm
	}

	it("the veto's figures: 6 dB over the median, 3 frames (96 ms)", () => {
		expect(SPEECH_NOISE_BURST_DB).toBe(6)
		expect(SPEECH_NOISE_MAX_BURST_FRAMES).toBe(3)
		expect((SPEECH_NOISE_MAX_BURST_FRAMES * SPEECH_FRAME_SAMPLES) / 8).toBe(96)
	})

	for (const burst of [
		0,
		1,
		SPEECH_NOISE_MAX_BURST_FRAMES - 1,
		SPEECH_NOISE_MAX_BURST_FRAMES,
		SPEECH_NOISE_MAX_BURST_FRAMES + 1,
		7,
	])
		it(`a ${burst}-frame burst on steady noise: clear noise ${burst < SPEECH_NOISE_MAX_BURST_FRAMES}, not speech either way`, () => {
			const r = measure(steadyWithBurst(burst))
			expect(r.maxBurstFrames).toBe(burst)
			// Too few loud frames to move the 90th percentile: the range alone calls it noise.
			expect(r.maxRangeDb).toBeLessThan(3)
			expect(clearlyNotSpeech(r)).toBe(true)
			expect(clearlyNoise(r)).toBe(burst < SPEECH_NOISE_MAX_BURST_FRAMES)
		})

	it("a burst is measured in time order across the ring's wrap (property)", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: SPEECH_NOISE_MIN_FRAMES - 8 }),
				fc.integer({ min: 1, max: 8 }),
				(start, burst) => {
					const rng = mulberry32(start + 1)
					const pcm = new Int16Array(
						SPEECH_NOISE_MIN_FRAMES * SPEECH_FRAME_SAMPLES,
					)
					for (let i = 0; i < pcm.length; i++) {
						const f = Math.floor(i / SPEECH_FRAME_SAMPLES)
						const amp = f >= start && f < start + burst ? 4_000 : 1_000
						pcm[i] = Math.round(amp * (2 * rng() - 1))
					}
					expect(measure(pcm).maxBurstFrames).toBe(burst)
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)

	// Synthetic words on a quiet carrier the range and periodic bounds alone call noise (the bench's
	// `--burst` table): each is kept by its burst.
	for (const cnrDb of [10, 20])
		for (const wordS of [0.3, 0.4, 0.5])
			it(`a ${wordS} s word in 8 s of quiet carrier at a CNR of ${cnrDb} dB is never clear noise`, () => {
				const r = measure(
					contentAudio(
						{
							waveform: { kind: "speech", pauses: "none", wordAtS: 4, wordS },
							cnrDb,
						},
						8,
					),
				)
				expect(r.frames).toBeGreaterThanOrEqual(SPEECH_NOISE_MIN_FRAMES)
				expect(r.maxBurstFrames).toBeGreaterThanOrEqual(
					SPEECH_NOISE_MAX_BURST_FRAMES + 1,
				)
				expect(clearlyNoise(r)).toBe(false)
			}, 60_000)

	it("sparse speech (four 0.3 to 0.4 s words over 10 s) at a CNR of 10 dB is never clear noise", () => {
		const r = measure(
			contentAudio(
				{
					waveform: {
						kind: "speech",
						pauses: "none",
						words: [
							[1, 0.35],
							[4, 0.3],
							[7.5, 0.4],
							[10.6, 0.3],
						],
					},
					cnrDb: 10,
				},
				12,
			),
		)
		expect(r.maxBurstFrames).toBeGreaterThanOrEqual(
			SPEECH_NOISE_MAX_BURST_FRAMES + 1,
		)
		expect(clearlyNoise(r)).toBe(false)
	}, 60_000)

	// Data and noise the strict bounds catch stay caught: no burst.
	for (const c of CONTENT_CASES.filter(
		c => !c.speech && c.kept !== true && c.name !== "pager-2fsk-1200",
	))
		it(`${c.name}: still clear noise (no burst)`, () => {
			const r = measure(contentAudio(c.signal, 8))
			expect(r.maxBurstFrames).toBeLessThan(SPEECH_NOISE_MAX_BURST_FRAMES)
			expect(clearlyNoise(r)).toBe(true)
		}, 60_000)
	it("an unmodulated carrier at a CNR of 10 dB: still clear noise", () => {
		const r = measure(
			contentAudio({ waveform: { kind: "silent" }, cnrDb: 10 }, 8),
		)
		expect(r.maxBurstFrames).toBeLessThan(SPEECH_NOISE_MAX_BURST_FRAMES)
		expect(clearlyNoise(r)).toBe(true)
	}, 60_000)
})
