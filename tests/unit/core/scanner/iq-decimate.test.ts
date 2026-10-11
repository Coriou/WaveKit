import { describe, expect, it } from "vitest"
import {
	ChannelDecimator,
	chooseDecimation,
	decimateToChannel,
	designLowpass,
} from "../../../../src/core/scanner/evidence/iq-decimate.js"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	packCu8,
	tone,
} from "../../../mocks/scanner/signals.js"

function powerOfCu8(bytes: Uint8Array): number {
	let p = 0
	for (let i = 0; i < bytes.length; i += 2) {
		const re = (bytes[i]! - 127.5) / 127.5
		const im = (bytes[i + 1]! - 127.5) / 127.5
		p += re * re + im * im
	}
	return p / (bytes.length / 2)
}

describe("iq-decimate", () => {
	it("chooses an integer output rate near 48 kHz", () => {
		expect(chooseDecimation(2_048_000)).toEqual({
			decimation: 40,
			outputRateHz: 51_200,
			exact: true,
		})
		expect(chooseDecimation(2_400_000)).toEqual({
			decimation: 50,
			outputRateHz: 48_000,
			exact: true,
		})
		expect(chooseDecimation(1_024_000)).toEqual({
			decimation: 20,
			outputRateHz: 51_200,
			exact: true,
		})
		expect(chooseDecimation(48_000)).toEqual({
			decimation: 1,
			outputRateHz: 48_000,
			exact: true,
		})
		expect(() => chooseDecimation(10_000)).toThrow()
	})

	it("designs a unity-gain symmetric lowpass", () => {
		const h = designLowpass(20)
		expect(h.length % 2).toBe(1)
		expect(h.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5)
		for (let i = 0; i < h.length; i++)
			expect(h[i]).toBeCloseTo(h[h.length - 1 - i]!, 7)
	})

	it("keeps the target channel and rejects a carrier 200 kHz away", () => {
		const fs = 1_024_000
		const n = fs / 4
		const a1 = tone(n, fs, 105_000, 0.9)
		const b1 = tone(n, fs, 305_000, 0.9)
		const inBand = packCu8(a1.re, a1.im)
		const outBand = packCu8(b1.re, b1.im)
		const a = decimateToChannel(inBand, { inputRateHz: fs, offsetHz: 100_000 })
		const b = decimateToChannel(outBand, { inputRateHz: fs, offsetHz: 100_000 })
		expect(a.sampleRateHz).toBe(51_200)
		expect(a.bytes.length).toBe(2 * Math.floor(n / 20))
		const skip = 400 // filter warm-up
		const pa = powerOfCu8(a.bytes.subarray(skip))
		const pb = powerOfCu8(b.bytes.subarray(skip))
		expect(10 * Math.log10(pa)).toBeGreaterThan(-3)
		expect(10 * Math.log10(pa / pb)).toBeGreaterThan(30)
	})

	it("streams identically to the one-shot call across arbitrary chunking", () => {
		const fs = 1_024_000
		const rng = mulberry32(5)
		const iq = addInto(
			gaussianNoise(rng, 40_000, 0.1),
			tone(40_000, fs, 30_000, 0.5),
		)
		const bytes = packCu8(iq.re, iq.im)
		const whole = decimateToChannel(bytes, {
			inputRateHz: fs,
			offsetHz: 25_000,
		}).bytes
		const d = new ChannelDecimator({ inputRateHz: fs, offsetHz: 25_000 })
		const parts: number[] = []
		let off = 0
		for (const size of [2, 1000, 3334, 50_000, 26_000]) {
			for (const b of d.push(bytes.subarray(off, off + size))) parts.push(b)
			off += size
		}
		for (const b of d.push(bytes.subarray(off))) parts.push(b)
		expect(Uint8Array.from(parts)).toEqual(whole)
	})
})
