import { describe, expect, it } from "vitest"
import {
	dutyFromEnvelope,
	envelopeAcf,
	obwAtDb,
	spectralShape,
	twoTone,
} from "../../../../../src/core/spectrum/emissions/spectral-features.js"
import {
	gaussian,
	mulberry32,
	tdmaGate,
} from "../../../../mocks/scanner/signals.js"

function envelopeFromGate(
	ms: number,
	onMs: number,
	periodMs: number,
): Float32Array {
	// tdmaGate at 1 kHz sample rate is exactly a 1 ms envelope
	const gate = tdmaGate(ms, 1000, onMs, periodMs, 0)
	return Float32Array.from(gate, g => 0.01 + g)
}

describe("envelopeAcf", () => {
	it("shows the DMR MS signature on a 27.5/60 ms gate", () => {
		const env = envelopeFromGate(600, 27.5, 60)
		expect(envelopeAcf(env, 30)).toBeLessThanOrEqual(-0.5)
		expect(envelopeAcf(env, 60)).toBeGreaterThanOrEqual(0.5)
	})
	it("is near zero for a white envelope and zero for a constant one", () => {
		const rng = mulberry32(7)
		const env = Float32Array.from(
			{ length: 1000 },
			() => 1 + 0.1 * gaussian(rng),
		)
		expect(Math.abs(envelopeAcf(env, 30))).toBeLessThan(0.15)
		expect(envelopeAcf(new Float32Array(500).fill(3), 30)).toBe(0)
	})
	it("returns 0 when the lag is not shorter than the envelope", () => {
		expect(envelopeAcf(new Float32Array(20).fill(1), 30)).toBe(0)
	})
})

describe("obwAtDb", () => {
	it("measures the outermost bins within the given distance below the peak", () => {
		const p = new Float32Array(64).fill(-80)
		for (let i = 20; i < 29; i++) p[i] = 0
		p[19] = -25
		p[29] = -25
		expect(obwAtDb(p, 0, 64, 1000, 20)).toBe(9000)
		expect(obwAtDb(p, 0, 64, 1000, 30)).toBe(11000)
		expect(obwAtDb(p, 22, 26, 1000, 20)).toBe(4000)
	})
})

describe("dutyFromEnvelope", () => {
	it("measures a TDMA duty cycle and reports continuous signals as 1", () => {
		expect(dutyFromEnvelope(envelopeFromGate(600, 27.5, 60))).toBeCloseTo(
			27.5 / 60,
			1,
		)
		expect(dutyFromEnvelope(new Float32Array(200).fill(2))).toBe(1)
	})
	it("returns null below 50 ms", () => {
		expect(dutyFromEnvelope(new Float32Array(49).fill(1))).toBeNull()
	})
})

describe("spectralShape", () => {
	it("classifies a Hann tone as narrow", () => {
		const p = new Float32Array(32).fill(-80)
		p[15] = -1.4
		p[16] = -1.4
		p[14] = -10
		p[17] = -10
		expect(spectralShape(p, 10, 22, 1000)).toBe("narrow")
	})
	it("classifies a flat top as flat and a Gaussian as peaked", () => {
		const flat = new Float32Array(32).fill(-80)
		for (let i = 10; i < 19; i++) flat[i] = i === 10 || i === 18 ? -3 : 0
		expect(spectralShape(flat, 8, 21, 1000)).toBe("flat")
		const gauss = new Float32Array(32).fill(-80)
		for (let i = 8; i <= 24; i++) gauss[i] = -4.34 * ((i - 16) / 1.5) ** 2
		expect(spectralShape(gauss, 8, 25, 1000)).toBe("peaked")
	})
})

describe("twoTone", () => {
	/** A floor at -60 dB with humps (centre bin, dB over the floor), each 3 bins wide. */
	const psd = (humps: [number, number][]): Float32Array => {
		const p = new Float32Array(40).fill(-60)
		for (const [c, db] of humps)
			for (let i = c - 1; i <= c + 1; i++) p[i] = -60 + db - (i === c ? 0 : 3)
		return p
	}

	it("two equal tones 9 bins apart with the floor between them", () => {
		expect(
			twoTone(
				psd([
					[15, 12],
					[24, 12],
				]),
				0,
				40,
				6,
				6,
				6,
			),
		).toBe(true)
	})

	it("spacing, level and valley bounds", () => {
		// peaks 6 bins apart: at the minimum spacing; 4 apart (even the far shoulder is 5): no
		expect(
			twoTone(
				psd([
					[15, 12],
					[21, 12],
				]),
				0,
				40,
				6,
				6,
				6,
			),
		).toBe(true)
		expect(
			twoTone(
				psd([
					[15, 12],
					[19, 12],
				]),
				0,
				40,
				6,
				6,
				6,
			),
		).toBe(false)
		// 6 dB apart joins, 7 dB does not
		expect(
			twoTone(
				psd([
					[15, 18],
					[24, 12],
				]),
				0,
				40,
				6,
				6,
				6,
			),
		).toBe(true)
		expect(
			twoTone(
				psd([
					[15, 19],
					[24, 12],
				]),
				0,
				40,
				6,
				6,
				6,
			),
		).toBe(false)
		// a valley filled to 5 dB under the weaker tone is one hump
		const filled = psd([
			[15, 12],
			[24, 12],
		])
		for (let i = 17; i < 23; i++) filled[i] = -60 + 7
		expect(twoTone(filled, 0, 40, 6, 6, 6)).toBe(false)
	})

	it("a single FM-like hump is not two tones", () => {
		const p = new Float32Array(40).fill(-60)
		for (let i = 10; i < 30; i++) p[i] = -60 + 20 - Math.abs(i - 20)
		expect(twoTone(p, 0, 40, 6, 6, 6)).toBe(false)
	})
})
