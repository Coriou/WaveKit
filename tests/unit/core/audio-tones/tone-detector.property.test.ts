import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { CTCSS_HZ } from "../../../../src/core/audio-tones/ctcss.js"
import { ToneDetector } from "../../../../src/core/audio-tones/tone-detector.js"
import { dtmfString, noiseStdForSnr, sine } from "./synth.js"

const SYMBOLS = [
	"0",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"*",
	"#",
	"A",
	"B",
	"C",
	"D",
] as const

function detect(pcm: { pcm: Buffer; rate: number; format: "s16le" | "f32le" }) {
	const detector = new ToneDetector()
	detector.push(pcm.pcm, { rate: pcm.rate, format: pcm.format })
	return detector.result()
}

describe("tone detector properties", () => {
	it("reports the standard CTCSS tone at SNR >= 10 dB", () => {
		// Feature: web-gaps-2, Property 9: CTCSS detection
		// Validates: Requirements 7.2
		fc.assert(
			fc.property(
				fc.constantFrom(...CTCSS_HZ),
				fc.double({ min: 0.08, max: 0.45, noNaN: true }),
				fc.double({ min: 10, max: 30, noNaN: true }),
				fc.integer({ min: 1, max: 1_000_000 }),
				(hz, amplitude, snrDb, seed) => {
					const tone = detect(
						sine({
							hz,
							seconds: 1,
							rate: 8_000,
							amplitude,
							noiseStd: noiseStdForSnr(amplitude, snrDb),
							seed,
						}),
					)
					expect(tone.ctcssHz).toBe(hz)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("reports null CTCSS for noise or a voice-band sine", () => {
		// Feature: web-gaps-2, Property 9: CTCSS detection
		// Validates: Requirements 7.2
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 1_000_000 }),
				fc.double({ min: 300, max: 3_000, noNaN: true }),
				fc.double({ min: 0.1, max: 0.5, noNaN: true }),
				(seed, hz, amplitude) => {
					const noise = detect(
						sine({
							hz: 0,
							seconds: 1,
							rate: 8_000,
							amplitude: 0,
							noiseStd: 0.15 + (seed % 10) / 50,
							seed,
						}),
					)
					const voice = detect(sine({ hz, seconds: 1, rate: 8_000, amplitude }))
					expect(noise.ctcssHz).toBeNull()
					expect(noise.dtmf).toBeNull()
					expect(voice.ctcssHz).toBeNull()
					expect(voice.dtmf).toBeNull()
				},
			),
			{ numRuns: 100 },
		)
	})

	it("returns a DTMF string with 50 ms on and off times", () => {
		// Feature: web-gaps-2, Property 10: DTMF detection
		// Validates: Requirements 7.3
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom(...SYMBOLS), { minLength: 1, maxLength: 8 }),
				fc.double({ min: 0.12, max: 0.3, noNaN: true }),
				(symbols, amplitude) => {
					const digits = symbols.join("")
					const tone = detect(
						dtmfString({
							symbols: digits,
							rate: 8_000,
							onSeconds: 0.05,
							offSeconds: 0.05,
							amplitude,
						}),
					)
					expect(tone.dtmf).toBe(digits)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("returns null DTMF for noise or a single sine", () => {
		// Feature: web-gaps-2, Property 10: DTMF detection
		// Validates: Requirements 7.3
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 1_000_000 }),
				fc.double({ min: 300, max: 3_000, noNaN: true }),
				fc.double({ min: 0.1, max: 0.45, noNaN: true }),
				(seed, hz, amplitude) => {
					const noise = detect(
						sine({
							hz: 0,
							seconds: 0.4,
							rate: 8_000,
							amplitude: 0,
							noiseStd: 0.2,
							seed,
						}),
					)
					const lone = detect(
						sine({ hz, seconds: 0.4, rate: 8_000, amplitude }),
					)
					expect(noise.dtmf).toBeNull()
					expect(lone.dtmf).toBeNull()
				},
			),
			{ numRuns: 100 },
		)
	})
})
