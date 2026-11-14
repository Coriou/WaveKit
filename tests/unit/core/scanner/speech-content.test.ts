/**
 * The speech-content measure (speech-content.ts) on synthetic audio through WidebandNfmChain
 * (speech-content-fixtures.ts): speech-like audio, with and without pauses and down to a CNR of
 * 5 dB, is never clearly not speech; FM-demodulated 4FSK, 2FSK, GMSK-like data, an unmodulated
 * carrier and open-squelch noise are; tones are kept by design; under 3 s nothing is judged; the
 * measure is chunk-split invariant.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	clearlyNotSpeech,
	SPEECH_FRAME_SAMPLES,
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
