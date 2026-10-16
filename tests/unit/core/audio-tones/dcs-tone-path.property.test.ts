// Feature: web-gaps-6, Property 10: Tone path unchanged
// Validates: Requirements 4.6
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { CTCSS_HZ } from "../../../../src/core/audio-tones/ctcss.js"
import { ToneDetector } from "../../../../src/core/audio-tones/tone-detector.js"
import { FrozenToneDetector } from "./dcs-frozen-tone-detector.js"
import { dtmfString, noiseStdForSnr, sine } from "./synth.js"
import type { TonePcm } from "./synth.js"

const SYMBOLS = "0123456789*#ABCD".split("")
const RATES = [8_000, 16_000, 24_000, 48_000, 44_100] as const
const FORMATS = ["s16le", "f32le"] as const

function both(pcm: TonePcm, chunk: number) {
	const fresh = new ToneDetector()
	const frozen = new FrozenToneDetector()
	const format = { rate: pcm.rate, format: pcm.format }
	for (let at = 0; at < pcm.pcm.length; at += chunk) {
		const slice = pcm.pcm.subarray(at, at + chunk)
		fresh.push(slice, format)
		frozen.push(slice, format)
	}
	return { fresh: fresh.result(), frozen: frozen.result() }
}

describe("Property 10: tone path unchanged", () => {
	it("CTCSS and DTMF match the pre-DCS detector on tones", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...CTCSS_HZ),
				fc.constantFrom(...RATES),
				fc.constantFrom(...FORMATS),
				fc.double({ min: 0.08, max: 0.45, noNaN: true }),
				fc.double({ min: 5, max: 30, noNaN: true }),
				fc.integer({ min: 1, max: 1_000_000 }),
				fc.integer({ min: 100, max: 5_000 }),
				(hz, rate, format, amplitude, snrDb, seed, chunk) => {
					const pcm = sine({
						hz,
						seconds: 0.9,
						rate,
						amplitude,
						noiseStd: noiseStdForSnr(amplitude, snrDb),
						seed,
						format,
					})
					const { fresh, frozen } = both(pcm, chunk)
					expect(fresh.ctcssHz).toBe(frozen.ctcssHz)
					expect(fresh.dtmf).toBe(frozen.dtmf)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("CTCSS and DTMF match the pre-DCS detector on DTMF strings", () => {
		fc.assert(
			fc.property(
				fc
					.array(fc.constantFrom(...SYMBOLS), { minLength: 1, maxLength: 4 })
					.map(s => s.join("")),
				fc.constantFrom(...RATES),
				fc.constantFrom(...FORMATS),
				fc.double({ min: 0.1, max: 0.4, noNaN: true }),
				fc.integer({ min: 100, max: 5_000 }),
				(symbols, rate, format, amplitude, chunk) => {
					const pcm = dtmfString({
						symbols,
						rate,
						onSeconds: 0.08,
						offSeconds: 0.06,
						amplitude,
						format,
					})
					const { fresh, frozen } = both(pcm, chunk)
					expect(fresh.ctcssHz).toBe(frozen.ctcssHz)
					expect(fresh.dtmf).toBe(frozen.dtmf)
				},
			),
			{ numRuns: 100 },
		)
	})
})
