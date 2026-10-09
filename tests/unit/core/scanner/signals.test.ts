import { describe, expect, it } from "vitest"
import {
	analogFm,
	counterRun,
	fsk4Burst,
	gaussianNoise,
	heavyTailedNoise,
	intermodPair,
	meanPower,
	mulberry32,
	narrowbandPsd,
	obwBelowPeakHz,
	ookBursts,
	packCu8,
	packF32,
	packS16,
	pager2fsk,
	sigmaForSnr,
	snrDb,
	tone,
	type Iq,
} from "../../../mocks/scanner/signals.js"

const FS = 2_048_000

/** Instantaneous frequency (Hz) between consecutive samples. */
function discriminator(iq: Iq, fs: number): Float64Array {
	const out = new Float64Array(iq.re.length - 1)
	for (let i = 1; i < iq.re.length; i++) {
		const re = iq.re[i]! * iq.re[i - 1]! + iq.im[i]! * iq.im[i - 1]!
		const im = iq.im[i]! * iq.re[i - 1]! - iq.re[i]! * iq.im[i - 1]!
		out[i - 1] = (Math.atan2(im, re) * fs) / (2 * Math.PI)
	}
	return out
}

/** Noise power in a fs/m bandwidth: mean |boxcar average of m samples|² over non-overlapping blocks. */
function boxcarPower(iq: Iq, m: number): number {
	let s = 0
	const blocks = Math.floor(iq.re.length / m)
	for (let b = 0; b < blocks; b++) {
		let r = 0
		let i = 0
		for (let k = b * m; k < (b + 1) * m; k++) {
			r += iq.re[k]!
			i += iq.im[k]!
		}
		s += (r / m) ** 2 + (i / m) ** 2
	}
	return s / blocks
}

describe("mulberry32", () => {
	it("is deterministic per seed and uniform in [0, 1)", () => {
		const a = mulberry32(42)
		const b = mulberry32(42)
		const xs = Array.from({ length: 100_000 }, () => a())
		const ys = Array.from({ length: 100_000 }, () => b())
		expect(xs).toEqual(ys)
		expect(xs.every(x => x >= 0 && x < 1)).toBe(true)
		expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeCloseTo(0.5, 2)
		expect(mulberry32(1)()).not.toBe(mulberry32(2)())
	})
})

describe("noise and SNR", () => {
	it("gaussianNoise has E|z|² = sigma² within 0.1 dB and is white", () => {
		const n = 1 << 18
		const noise = gaussianNoise(mulberry32(7), n, 0.05)
		expect(Math.abs(10 * Math.log10(meanPower(noise) / 0.0025))).toBeLessThan(
			0.1,
		)
		// White: the power in a fs/164 ≈ 12.5 kHz boxcar is sigma²/164.
		expect(
			Math.abs(10 * Math.log10(boxcarPower(noise, 164) / (0.0025 / 164))),
		).toBeLessThan(0.5)
	})

	it("sigmaForSnr puts a 4FSK burst at the requested SNR in 12.5 kHz within 0.5 dB", () => {
		const n = 1 << 18
		const amp = 0.1
		for (const target of [-2, 3, 10, 30]) {
			const sigma = sigmaForSnr(amp * amp, target, FS)
			expect(snrDb(amp * amp, sigma, FS)).toBeCloseTo(target, 9)
			const sig = fsk4Burst(mulberry32(3), n, FS, 25_000, amp)
			const noise = gaussianNoise(mulberry32(4 + target), n, sigma)
			const measured =
				10 *
				Math.log10(meanPower(sig) / boxcarPower(noise, Math.round(FS / 12_500)))
			expect(Math.abs(measured - target)).toBeLessThan(0.5)
		}
	}, 20_000)

	it("heavyTailedNoise is plain AWGN at rate 0 and adds the expected event energy otherwise", () => {
		const n = 1 << 19
		const sigma = 0.05
		const plain = heavyTailedNoise(mulberry32(9), n, sigma, {
			fs: FS,
			eventsPerMhzSec: 0,
			excessDb: 20,
		})
		expect(Array.from(plain.re.subarray(0, 64))).toEqual(
			Array.from(gaussianNoise(mulberry32(9), 64, sigma).re),
		)
		const opts = { fs: FS, eventsPerMhzSec: 200, excessDb: 20, eventMs: 50 }
		const heavy = heavyTailedNoise(mulberry32(9), n, sigma, opts)
		const eventSamples = (opts.eventMs * FS) / 1000
		const lambda = opts.eventsPerMhzSec * (FS / 1e6) * (n / FS)
		const eventPower =
			((sigma * sigma * 1000) / FS) * 10 ** (opts.excessDb / 10)
		const expectedExcess =
			(lambda * eventPower * eventSamples * (n / (n + eventSamples))) / n
		const excess = meanPower(heavy) - sigma * sigma
		expect(excess / expectedExcess).toBeGreaterThan(0.5)
		expect(excess / expectedExcess).toBeLessThan(1.5)
		const again = heavyTailedNoise(mulberry32(9), n, sigma, opts)
		expect(again.re.every((v, i) => v === heavy.re[i])).toBe(true)
	}, 20_000)
})

describe("emission generators", () => {
	it("narrowbandPsd reads a bin-centred tone at its power", () => {
		const psd = narrowbandPsd(tone(1 << 17, FS, 10_000, 0.25), FS, 10_000)
		expect(Math.max(...psd.db)).toBeCloseTo(20 * Math.log10(0.25), 1)
		expect(obwBelowPeakHz(psd, 20)).toBeLessThanOrEqual(3 * psd.binHz)
	})

	it("fsk4Burst has a −20 dB OBW of about 9 kHz, continuous or TDMA", () => {
		const cont = obwBelowPeakHz(
			narrowbandPsd(fsk4Burst(mulberry32(11), FS / 2, FS, 0, 0.5), FS, 0),
			20,
		)
		expect(cont).toBeGreaterThanOrEqual(8_000)
		expect(cont).toBeLessThanOrEqual(10_000)
		const tdma = obwBelowPeakHz(
			narrowbandPsd(
				fsk4Burst(mulberry32(12), FS / 2, FS, 0, 0.5, { tdma: true }),
				FS,
				0,
			),
			20,
		)
		expect(tdma).toBeGreaterThanOrEqual(8_000)
		expect(tdma).toBeLessThanOrEqual(10_000)
	}, 20_000)

	it("fsk4Burst stays on the four DMR deviations at 4800 Bd", () => {
		const iq = fsk4Burst(mulberry32(13), 1 << 17, FS, 0, 0.5)
		const f = discriminator(iq, FS)
		let near = 0
		for (const v of f)
			if ([-1944, -648, 648, 1944].some(d => Math.abs(v - d) < 150)) near++
		expect(near / f.length).toBeGreaterThan(0.6)
		expect(f.every(v => Math.abs(v) < 2_100)).toBe(true)
	})

	it("TDMA gating keeps a 27.5/60 duty within 2 % and puts bursts where the phase says", () => {
		const n = Math.round(1.2 * FS)
		const amp = 0.3
		const iq = fsk4Burst(mulberry32(14), n, FS, 6_000, amp, {
			tdma: true,
			tdmaPhaseMs: 10,
		})
		let on = 0
		for (let i = 0; i < n; i++)
			if (iq.re[i]! ** 2 + iq.im[i]! ** 2 > (amp * amp) / 2) on++
		expect(Math.abs(on / n - 27.5 / 60)).toBeLessThan(0.02)
		const at = (ms: number): number =>
			meanPower(
				iq,
				Math.round((ms * FS) / 1000),
				Math.round(((ms + 1) * FS) / 1000),
			)
		expect(at(12)).toBeCloseTo(amp * amp, 4) // inside the first burst (10–37.5 ms)
		expect(at(45)).toBeLessThan(1e-12) // in the gap (37.5–70 ms)
		expect(at(72)).toBeCloseTo(amp * amp, 4) // second burst from 70 ms
	}, 20_000)

	it("pager2fsk sits on ±4.5 kHz inside bursts and is silent outside", () => {
		const n = FS / 2
		const iq = pager2fsk(mulberry32(15), n, FS, 0, 0.4, {
			bursts: [{ startMs: 100, durationMs: 200 }],
		})
		const from = Math.round((0.11 * FS) / 1)
		const f = discriminator(
			{
				re: iq.re.subarray(from, from + FS / 10),
				im: iq.im.subarray(from, from + FS / 10),
			},
			FS,
		)
		let near = 0
		for (const v of f) if (Math.abs(Math.abs(v) - 4_500) < 600) near++
		expect(near / f.length).toBeGreaterThan(0.95)
		expect(meanPower(iq, 0, Math.round(0.09 * FS))).toBe(0)
		expect(meanPower(iq, Math.round(0.31 * FS), n)).toBe(0)
		expect(
			meanPower(iq, Math.round(0.11 * FS), Math.round(0.29 * FS)),
		).toBeCloseTo(0.16, 6)
	})

	it("analogFm has the requested RMS deviation and a CTCSS line only when asked", () => {
		const n = FS
		const ctcssAmplitude = (iq: Iq): number => {
			const f = discriminator(iq, FS)
			let re = 0
			let im = 0
			for (let i = 0; i < f.length; i++) {
				const w = (2 * Math.PI * 88.5 * i) / FS
				re += f[i]! * Math.cos(w)
				im += f[i]! * Math.sin(w)
			}
			return (2 * Math.hypot(re, im)) / f.length
		}
		const withTone = analogFm(mulberry32(16), n, FS, 0, 0.3)
		const f = discriminator(withTone, FS)
		let mean = 0
		for (const v of f) mean += v
		mean /= f.length
		let sq = 0
		for (const v of f) sq += (v - mean) ** 2
		const rms = Math.sqrt(sq / f.length)
		expect(
			Math.abs(rms - Math.sqrt(1500 ** 2 + 300 ** 2 / 2)) / 1500,
		).toBeLessThan(0.1)
		expect(ctcssAmplitude(withTone)).toBeGreaterThan(250)
		expect(ctcssAmplitude(withTone)).toBeLessThan(350)
		expect(
			ctcssAmplitude(
				analogFm(mulberry32(16), n, FS, 0, 0.3, { ctcssHz: null }),
			),
		).toBeLessThan(40)
		expect(meanPower(withTone)).toBeCloseTo(0.09, 6)
	}, 20_000)

	it("ookBursts keys about half the bits inside bursts and nothing outside", () => {
		const n = FS / 2
		const amp = 0.5
		const iq = ookBursts(mulberry32(17), n, FS, -30_000, amp, {
			bursts: [
				{ startMs: 50, durationMs: 100 },
				{ startMs: 300, durationMs: 50 },
			],
		})
		const inside =
			meanPower(iq, Math.round(0.051 * FS), Math.round(0.149 * FS)) /
			(amp * amp)
		expect(inside).toBeGreaterThan(0.35)
		expect(inside).toBeLessThan(0.65)
		expect(meanPower(iq, Math.round(0.16 * FS), Math.round(0.29 * FS))).toBe(0)
		expect(
			meanPower(iq, Math.round(0.301 * FS), Math.round(0.349 * FS)),
		).toBeGreaterThan(0)
	})

	it("intermodPair places third-order products at 2f1−f2 and 2f2−f1 at the requested level", () => {
		const f1 = 100_000
		const f2 = 110_000
		const iq = intermodPair(1 << 17, FS, f1, f2, 0.2, -30)
		const psd = narrowbandPsd(iq, FS, 105_000, { decimation: 16, nfft: 1024 })
		const at = (hz: number): number =>
			psd.db[Math.round((hz - 105_000) / psd.binHz) + 512]!
		expect(at(f1) - at(2 * f1 - f2)).toBeCloseTo(30, 0)
		expect(at(f2) - at(2 * f2 - f1)).toBeCloseTo(30, 0)
		expect(at(f1)).toBeCloseTo(20 * Math.log10(0.2), 0)
	}, 20_000)
})

describe("counter runs and packers", () => {
	it("counterRun strictly increments mod 256", () => {
		const run = counterRun(600, 250)
		expect(run[0]).toBe(250)
		for (let i = 1; i < run.length; i++)
			expect(run[i]).toBe((run[i - 1]! + 1) & 255)
	})

	it("packers round-trip within one quantisation step and clamp at full scale", () => {
		const re = new Float32Array([0, 0.5, -0.5, 0.999, -1, 1.5, -1.5])
		const im = new Float32Array([0.25, -0.25, 0.1, -0.999, 1, -2, 2])
		const u8 = packCu8(re, im)
		const s16 = new DataView(packS16(re, im).buffer)
		const f32 = new DataView(packF32(re, im).buffer)
		for (let i = 0; i < re.length; i++) {
			const r = Math.max(-1, Math.min(1, re[i]!))
			expect(Math.abs(u8[2 * i]! / 127.5 - 1 - r)).toBeLessThanOrEqual(
				1 / 127.5,
			)
			expect(
				Math.abs(s16.getInt16(4 * i, true) / 32768 - r),
			).toBeLessThanOrEqual(1 / 32768)
			expect(f32.getFloat32(8 * i, true)).toBe(re[i])
			expect(f32.getFloat32(8 * i + 4, true)).toBe(im[i])
		}
		expect(u8[10]).toBe(255)
		expect(u8[11]).toBe(0)
		expect(s16.getInt16(20, true)).toBe(32767)
		expect(s16.getInt16(22, true)).toBe(-32768)
	})
})
