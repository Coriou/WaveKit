import { describe, expect, it } from "vitest"
import {
	CTCSS_HZ,
	selectCtcssTone,
} from "../../../../src/core/audio-tones/ctcss.js"
import {
	ToneDetector,
	boxcarDecimationGain,
} from "../../../../src/core/audio-tones/tone-detector.js"
import { dtmfString, noiseStdForSnr, sine } from "./synth.js"

const formatOf = (pcm: { rate: number; format: "s16le" | "f32le" }) => ({
	rate: pcm.rate,
	format: pcm.format,
})

describe("ctcss table", () => {
	it("lists the 50 EIA tones from 67 to 254.1 with no duplicates", () => {
		expect(CTCSS_HZ).toHaveLength(50)
		expect(new Set(CTCSS_HZ).size).toBe(50)
		expect(CTCSS_HZ[0]).toBe(67)
		expect(CTCSS_HZ[49]).toBe(254.1)
		for (let i = 1; i < CTCSS_HZ.length; i++) {
			expect(CTCSS_HZ[i] ?? 0).toBeGreaterThan(CTCSS_HZ[i - 1] ?? 0)
		}
	})

	it("breaks a vote tie toward the earliest win", () => {
		const votes = new Array<number>(50).fill(0)
		const qualified = new Array<number>(50).fill(0)
		const first = new Array<number>(50).fill(-1)
		votes[3] = 2
		votes[10] = 2
		qualified[3] = 1
		qualified[10] = 1
		first[3] = 4
		first[10] = 1
		expect(selectCtcssTone(votes, qualified, first)).toBe(CTCSS_HZ[10])
		votes[1] = 5
		qualified[1] = 0
		expect(selectCtcssTone(votes, qualified, first)).toBe(CTCSS_HZ[10])
		qualified[1] = 1
		first[1] = 0
		expect(selectCtcssTone(votes, qualified, first)).toBe(CTCSS_HZ[1])
	})
})

describe("tone detector", () => {
	it("reports each standard CTCSS tone after one second at 8 kHz", () => {
		for (const hz of CTCSS_HZ) {
			const detector = new ToneDetector()
			const pcm = sine({
				hz,
				seconds: 1,
				rate: 8_000,
				amplitude: 0.25,
			})
			detector.push(pcm.pcm, formatOf(pcm))
			expect(detector.result().ctcssHz, `tone ${hz}`).toBe(hz)
		}
	})

	it("reports a tone in 10 dB noise and rejects a shorter burst", () => {
		const detector = new ToneDetector()
		const pcm = sine({
			hz: 100,
			seconds: 1,
			rate: 8_000,
			amplitude: 0.2,
			noiseStd: noiseStdForSnr(0.2, 10),
			seed: 7,
		})
		detector.push(pcm.pcm, formatOf(pcm))
		expect(detector.result()).toEqual({ ctcssHz: 100, dtmf: null, dcs: null })

		const short = new ToneDetector()
		const brief = sine({
			hz: 100,
			seconds: 0.74,
			rate: 8_000,
			amplitude: 0.4,
		})
		short.push(brief.pcm, formatOf(brief))
		expect(short.result().ctcssHz).toBeNull()
		expect(short.durationSeconds()).toBeLessThan(0.75)
	})

	it("keeps CTCSS null for noise and for a voice-band sine", () => {
		const noise = sine({
			hz: 0,
			seconds: 1,
			rate: 8_000,
			amplitude: 0,
			noiseStd: 0.2,
			seed: 3,
		})
		const voice = sine({
			hz: 1_000,
			seconds: 1,
			rate: 8_000,
			amplitude: 0.4,
		})
		const edge = sine({
			hz: 300,
			seconds: 1,
			rate: 8_000,
			amplitude: 0.4,
		})
		for (const pcm of [noise, voice, edge]) {
			const detector = new ToneDetector()
			detector.push(pcm.pcm, formatOf(pcm))
			expect(detector.result().ctcssHz).toBeNull()
		}
	})

	it("decodes a DTMF string and drops symbols past 32", () => {
		const symbols = "123A456B789C*0#D"
		const detector = new ToneDetector()
		const pcm = dtmfString({
			symbols,
			rate: 8_000,
			onSeconds: 0.05,
			offSeconds: 0.05,
			amplitude: 0.2,
		})
		detector.push(pcm.pcm, formatOf(pcm))
		expect(detector.result().dtmf).toBe(symbols)
		expect(detector.result().ctcssHz).toBeNull()

		const long = "1234567890*#ABCD1234567890*#ABCDX".replaceAll("X", "5")
		expect(long).toHaveLength(33)
		const capped = new ToneDetector()
		const more = dtmfString({
			symbols: long,
			rate: 8_000,
			onSeconds: 0.05,
			offSeconds: 0.05,
			amplitude: 0.2,
		})
		capped.push(more.pcm, formatOf(more))
		expect(capped.result().dtmf).toBe(long.slice(0, 32))
	})

	it("accepts twist of +4 and -8 dB and rejects a single sine", () => {
		for (const twistDb of [4, -8, 0]) {
			const detector = new ToneDetector()
			const pcm = dtmfString({
				symbols: "5",
				rate: 8_000,
				onSeconds: 0.08,
				offSeconds: 0.05,
				amplitude: 0.15,
				twistDb,
			})
			detector.push(pcm.pcm, formatOf(pcm))
			expect(detector.result().dtmf, `twist ${twistDb}`).toBe("5")
		}
		for (const twistDb of [5, -9]) {
			const detector = new ToneDetector()
			const pcm = dtmfString({
				symbols: "5",
				rate: 8_000,
				onSeconds: 0.08,
				offSeconds: 0.05,
				amplitude: 0.15,
				twistDb,
			})
			detector.push(pcm.pcm, formatOf(pcm))
			expect(detector.result().dtmf, `twist ${twistDb}`).toBeNull()
		}
		const lone = new ToneDetector()
		const sineOnly = sine({
			hz: 697,
			seconds: 0.5,
			rate: 8_000,
			amplitude: 0.4,
		})
		lone.push(sineOnly.pcm, formatOf(sineOnly))
		expect(lone.result().dtmf).toBeNull()
	})

	it("accepts every digit at both twist limits, at 8 kHz and 48 kHz", () => {
		const grid = "123A456B789C*0#D"
		for (const rate of [8_000, 48_000]) {
			for (const symbol of grid) {
				for (const twistDb of [4, -8, 0]) {
					const detector = new ToneDetector()
					const pcm = dtmfString({
						symbols: symbol,
						rate,
						onSeconds: 0.08,
						offSeconds: 0.05,
						amplitude: 0.15,
						twistDb,
					})
					detector.push(pcm.pcm, formatOf(pcm))
					expect(
						detector.result().dtmf,
						`${rate} ${symbol} twist ${twistDb}`,
					).toBe(symbol)
				}
			}
		}
		for (const rate of [8_000, 48_000]) {
			for (const symbol of ["5", "C"]) {
				for (const twistDb of [5, -9]) {
					const detector = new ToneDetector()
					const pcm = dtmfString({
						symbols: symbol,
						rate,
						onSeconds: 0.2,
						offSeconds: 0.05,
						amplitude: 0.15,
						twistDb,
					})
					detector.push(pcm.pcm, formatOf(pcm))
					expect(
						detector.result().dtmf,
						`${rate} ${symbol} twist ${twistDb}`,
					).toBeNull()
				}
			}
		}
	})

	it("does not credit a new digit with the previous digit's average", () => {
		const first = dtmfString({
			symbols: "1",
			rate: 8_000,
			onSeconds: 0.03,
			offSeconds: 0,
			amplitude: 0.2,
		})
		const second = dtmfString({
			symbols: "2",
			rate: 8_000,
			onSeconds: 0.015,
			offSeconds: 0,
			amplitude: 0.2,
		})
		const detector = new ToneDetector()
		detector.push(Buffer.concat([first.pcm, second.pcm]), formatOf(first))
		expect(detector.result().dtmf).toBeNull()
	})

	it("does not join bursts shorter than 40 ms across a real gap", () => {
		const detector = new ToneDetector()
		const pcm = dtmfString({
			symbols: "55555",
			rate: 8_000,
			onSeconds: 0.015,
			offSeconds: 0.01,
			amplitude: 0.25,
		})
		detector.push(pcm.pcm, formatOf(pcm))
		expect(detector.result().dtmf).toBeNull()
	})

	it("rejects a CTCSS tone that is under 0.65 of the in-band power", () => {
		const detector = new ToneDetector()
		const pcm = sine({
			hz: 100,
			seconds: 1,
			rate: 8_000,
			amplitude: 0.3,
			extraHz: 290,
			extraAmplitude: 0.3,
		})
		detector.push(pcm.pcm, formatOf(pcm))
		expect(detector.result().ctcssHz).toBeNull()
		expect(detector.result().dtmf).toBeNull()
	})

	it("survives 48 kHz block averaging, including the 1633 Hz column", () => {
		const gain = boxcarDecimationGain(1633, 48_000)
		expect(gain).toBeGreaterThan(10 ** (-3 / 20))
		expect(gain).toBeCloseTo(0.935, 2)

		const ctcss = new ToneDetector()
		const tone = sine({
			hz: 100,
			seconds: 1,
			rate: 48_000,
			amplitude: 0.25,
			noiseStd: noiseStdForSnr(0.25, 12),
			seed: 11,
			format: "s16le",
		})
		ctcss.push(tone.pcm, formatOf(tone))
		expect(ctcss.result().ctcssHz).toBe(100)

		const dtmf = new ToneDetector()
		const digits = dtmfString({
			symbols: "A0",
			rate: 48_000,
			onSeconds: 0.06,
			offSeconds: 0.06,
			amplitude: 0.2,
			format: "s16le",
		})
		dtmf.push(digits.pcm, formatOf(digits))
		expect(dtmf.result().dtmf).toBe("A0")
	})

	it("joins odd-length s16le chunks and ignores NaN float samples", () => {
		const whole = sine({
			hz: 123,
			seconds: 1,
			rate: 8_000,
			amplitude: 0.3,
			format: "s16le",
		})
		const split = new ToneDetector()
		let offset = 0
		while (offset < whole.pcm.length) {
			const size = offset % 2 === 0 ? 3 : 1
			split.push(whole.pcm.subarray(offset, offset + size), formatOf(whole))
			offset += size
		}
		expect(split.result().ctcssHz).toBe(123)

		const hostile = new ToneDetector()
		const nan = Buffer.alloc(8_000 * 4)
		for (let i = 0; i < 8_000; i++) nan.writeFloatLE(Number.NaN, i * 4)
		expect(() =>
			hostile.push(nan, { rate: 8_000, format: "f32le" }),
		).not.toThrow()
		expect(hostile.result()).toEqual({ ctcssHz: null, dtmf: null, dcs: null })

		const mixed = sine({
			hz: 100,
			seconds: 1,
			rate: 8_000,
			amplitude: 0.3,
		})
		for (let i = 0; i < mixed.samples.length; i += 50) {
			mixed.pcm.writeFloatLE(Number.NaN, i * 4)
		}
		const mixedDetector = new ToneDetector()
		mixedDetector.push(mixed.pcm, formatOf(mixed))
		expect(mixedDetector.result().ctcssHz).toBe(100)
	})

	it("does not repeat a digit without a 40 ms gap", () => {
		const held = new ToneDetector()
		const pcm = dtmfString({
			symbols: "1",
			rate: 8_000,
			onSeconds: 0.2,
			offSeconds: 0,
			amplitude: 0.2,
		})
		held.push(pcm.pcm, formatOf(pcm))
		expect(held.result().dtmf).toBe("1")
	})

	it("resets and rejects a non-positive sample rate without throwing", () => {
		const detector = new ToneDetector()
		const pcm = sine({
			hz: 100,
			seconds: 1,
			rate: 8_000,
			amplitude: 0.3,
		})
		detector.push(pcm.pcm, formatOf(pcm))
		expect(detector.result().ctcssHz).toBe(100)
		detector.reset()
		expect(detector.result()).toEqual({ ctcssHz: null, dtmf: null, dcs: null })
		expect(() =>
			detector.push(pcm.pcm, { rate: 0, format: "f32le" }),
		).not.toThrow()
		expect(detector.result().ctcssHz).toBeNull()
	})

	it("finishes one second of 48 kHz audio well under a second of CPU", () => {
		const detector = new ToneDetector()
		const pcm = sine({
			hz: 100,
			seconds: 1,
			rate: 48_000,
			amplitude: 0.2,
			format: "s16le",
		})
		const started = performance.now()
		detector.push(pcm.pcm, formatOf(pcm))
		const tone = detector.result()
		const elapsed = performance.now() - started
		expect(tone.ctcssHz).toBe(100)
		// Loose ceiling only. The report records the measured time.
		expect(elapsed).toBeLessThan(1_000)
	})
})
