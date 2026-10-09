import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import {
	accumulateShiftedPower,
	defaultFftSize,
	Fft,
	hannWindow,
	POWER_FLOOR_DB,
	powerToDb,
} from "../../../../src/core/spectrum/fft.js"
import {
	gaussianNoise,
	mulberry32,
	tone,
} from "../../../mocks/scanner/signals.js"

function naiveDft(
	re: Float32Array,
	im: Float32Array,
): { re: Float64Array; im: Float64Array } {
	const n = re.length
	const outRe = new Float64Array(n)
	const outIm = new Float64Array(n)
	for (let k = 0; k < n; k++) {
		let sr = 0
		let si = 0
		for (let t = 0; t < n; t++) {
			const a = (-2 * Math.PI * ((k * t) % n)) / n
			sr += re[t]! * Math.cos(a) - im[t]! * Math.sin(a)
			si += re[t]! * Math.sin(a) + im[t]! * Math.cos(a)
		}
		outRe[k] = sr
		outIm[k] = si
	}
	return { re: outRe, im: outIm }
}

function randomVector(
	seed: number,
	n: number,
): { re: Float32Array; im: Float32Array } {
	const rng = mulberry32(seed)
	const re = new Float32Array(n)
	const im = new Float32Array(n)
	for (let i = 0; i < n; i++) {
		re[i] = 2 * rng() - 1
		im[i] = 2 * rng() - 1
	}
	return { re, im }
}

describe("Fft", () => {
	it("matches a naive DFT on random vectors of every size 2..512", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 9 }),
				fc.integer({ min: 0, max: 2 ** 31 - 1 }),
				(bits, seed) => {
					const n = 1 << bits
					const x = randomVector(seed, n)
					const ref = naiveDft(x.re, x.im)
					new Fft(n).transform(x.re, x.im)
					const tol = 2e-6 * n + 1e-5
					for (let k = 0; k < n; k++) {
						expect(Math.abs(x.re[k]! - ref.re[k]!)).toBeLessThan(tol)
						expect(Math.abs(x.im[k]! - ref.im[k]!)).toBeLessThan(tol)
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 30_000)

	it("satisfies Parseval: Σ|X|² = N·Σ|x|²", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 14 }),
				fc.integer({ min: 0, max: 2 ** 31 - 1 }),
				(bits, seed) => {
					const n = 1 << bits
					const x = randomVector(seed, n)
					let timeEnergy = 0
					for (let i = 0; i < n; i++)
						timeEnergy += x.re[i]! ** 2 + x.im[i]! ** 2
					new Fft(n).transform(x.re, x.im)
					let freqEnergy = 0
					for (let k = 0; k < n; k++)
						freqEnergy += x.re[k]! ** 2 + x.im[k]! ** 2
					expect(Math.abs(freqEnergy / (n * timeEnergy) - 1)).toBeLessThan(1e-4)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("puts a complex tone in its bin with the sign convention e^{−j2πkn/N}", () => {
		const n = 64
		const t = tone(n, n, 5, 1)
		new Fft(n).transform(t.re, t.im)
		expect(t.re[5]).toBeCloseTo(n, 3)
		for (let k = 0; k < n; k++)
			if (k !== 5) expect(Math.hypot(t.re[k]!, t.im[k]!)).toBeLessThan(1e-3)
	})

	it("rejects sizes that are not powers of two and mismatched inputs", () => {
		for (const bad of [0, 1, 3, 1000, 2 ** 21, 2.5])
			expect(() => new Fft(bad)).toThrow()
		expect(() =>
			new Fft(8).transform(new Float32Array(4), new Float32Array(8)),
		).toThrow()
	})
})

describe("spectrum helpers", () => {
	it("hannWindow is periodic with Σw = N/2", () => {
		const w = hannWindow(2048)
		expect(w[0]).toBe(0)
		expect(w[1024]).toBeCloseTo(1, 6)
		expect(w.reduce((s, v) => s + v, 0)).toBeCloseTo(1024, 2)
	})

	it("reads a bin-centred full-scale tone at 0 dBFS in the shifted bin of its offset", () => {
		const n = 2048
		const fs = 2_048_000
		const w = hannWindow(n)
		const t = tone(n, fs, 6_000, 1)
		for (let i = 0; i < n; i++) {
			t.re[i]! *= w[i]!
			t.im[i]! *= w[i]!
		}
		new Fft(n).transform(t.re, t.im)
		const acc = new Float64Array(n)
		accumulateShiftedPower(t.re, t.im, acc)
		const db = new Float32Array(n)
		powerToDb(acc, 1, db)
		expect(db[n / 2 + 6]).toBeCloseTo(0, 3)
		expect(db[n / 2 + 5]).toBeCloseTo(-6.02, 1)
		expect(db[n / 2 + 100]).toBeLessThan(-100)
	})

	it("reads white noise of total power P at P·1.5/N per bin", () => {
		const n = 1024
		const frames = 200
		const sigma = 0.1
		const noise = gaussianNoise(mulberry32(5), n * frames, sigma)
		const w = hannWindow(n)
		const fft = new Fft(n)
		const acc = new Float64Array(n)
		const re = new Float32Array(n)
		const im = new Float32Array(n)
		for (let f = 0; f < frames; f++) {
			for (let i = 0; i < n; i++) {
				re[i] = noise.re[f * n + i]! * w[i]!
				im[i] = noise.im[f * n + i]! * w[i]!
			}
			fft.transform(re, im)
			accumulateShiftedPower(re, im, acc)
		}
		const db = new Float32Array(n)
		powerToDb(acc, frames, db)
		const mean = db.reduce((s, v) => s + 10 ** (v / 10), 0) / n
		expect(10 * Math.log10(mean)).toBeCloseTo(
			10 * Math.log10((sigma * sigma * 1.5) / n),
			0,
		)
		expect(
			Math.abs(10 * Math.log10(mean / ((sigma * sigma * 1.5) / n))),
		).toBeLessThan(0.2)
	})

	it("floors empty bins", () => {
		const db = new Float32Array(4)
		powerToDb(new Float64Array(4), 3, db)
		expect(Array.from(db)).toEqual([
			POWER_FLOOR_DB,
			POWER_FLOOR_DB,
			POWER_FLOOR_DB,
			POWER_FLOOR_DB,
		])
	})

	it("derives fftSize for RBW 0.8–1.6 kHz (§ 4.2)", () => {
		expect(
			[2_048_000, 2_400_000, 250_000, 10_000_000, 40_000_000].map(
				defaultFftSize,
			),
		).toEqual([2048, 2048, 512, 8192, 16_384])
	})
})
