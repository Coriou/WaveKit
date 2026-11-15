/**
 * The synthetic 4FSK generators' arithmetic (scripts/fixtures): the CNR noise
 * level, the standard transmit filters and the DMR codes. Whether dsd-fme
 * decodes them is tests/integration/synthetic-frames.test.ts.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	bptc19696,
	dmrCallDibits,
	dmrGroupVoiceLc,
	embeddedLcFragments,
	golay208,
	hamming74,
	qr167,
	rs129Parity,
} from "../../../scripts/fixtures/dmr-4fsk.mjs"
import {
	AIR_SHAPES,
	bitsOf,
	noiseForCnr,
	pulseResponse,
	pulseSpectrum,
	receiveSpectrum,
} from "../../../scripts/fixtures/fsk-iq.mjs"

/** Minimum Hamming distance of a systematic code over every k-bit message. */
function minimumDistance(encode: (d: number[]) => number[], k: number): number {
	const words = Array.from({ length: 2 ** k }, (_, m) => encode(bitsOf(m, k)))
	let min = Infinity
	for (let a = 0; a < words.length; a++)
		for (let b = a + 1; b < words.length; b++) {
			let d = 0
			words[a]!.forEach((bit, i) => (d += bit ^ words[b]![i]!))
			min = Math.min(min, d)
		}
	return min
}

/** GF(256) (0x11d) polynomial value at alpha^r, highest degree first. */
function evaluate(bytes: number[], r: number): number {
	const exp: number[] = []
	const log: number[] = []
	let x = 1
	for (let i = 0; i < 255; i++) {
		exp[i] = x
		log[x] = i
		x <<= 1
		if (x & 0x100) x ^= 0x11d
	}
	const mul = (a: number, b: number) =>
		a === 0 || b === 0 ? 0 : exp[(log[a]! + log[b]!) % 255]!
	return bytes.reduce((acc, byte) => mul(acc, exp[r]!) ^ byte, 0)
}

describe("synthetic 4FSK generators", () => {
	// Feature: dsd-fme decode margin, Property 2: noise at the stated CNR
	// Validates: the CNR in the noise bandwidth and the fixed total level
	it("sets the noise so the CNR in the bandwidth is the one asked", () => {
		fc.assert(
			fc.property(
				fc.double({ min: -5, max: 50, noNaN: true }),
				fc.constantFrom(1_024_000, 2_048_000, 2_400_000),
				(cnrDb, sampleRateHz) => {
					const { amplitude, noise } = noiseForCnr({ cnrDb, sampleRateHz })
					const inBand = (2 * noise * noise * 12_500) / sampleRateHz
					expect(10 * Math.log10((amplitude * amplitude) / inBand)).toBeCloseTo(
						cnrDb,
						9,
					)
					expect(amplitude * amplitude + 2 * noise * noise).toBeCloseTo(
						2 * 0.25 * 0.25,
						12,
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("shapes each air interface so its receive filter leaves no intersymbol interference", () => {
		for (const shape of Object.values(AIR_SHAPES)) {
			const overall = (x: number) =>
				pulseSpectrum(x, shape) * receiveSpectrum(x, shape)
			expect(pulseResponse(0, overall, shape.alpha)).toBeCloseTo(1, 6)
			for (const t of [1, 2, 3, 4])
				expect(Math.abs(pulseResponse(t, overall, shape.alpha))).toBeLessThan(
					1e-6,
				)
		}
	})

	it("encodes the DMR block codes at their design distances", () => {
		expect(minimumDistance(hamming74, 4)).toBe(3)
		expect(minimumDistance(qr167, 7)).toBe(6)
		// Shortened from the extended Golay(24,12,8): at least the (20,8,7) the
		// standard names.
		expect(minimumDistance(golay208, 8)).toBe(8)
	})

	it("appends RS(12,9) parity whose syndromes at alpha^1..alpha^3 are zero", () => {
		const lc = dmrGroupVoiceLc({ talkgroup: 4321, source: 1_234_567 })
		const codeword = [...lc, ...rs129Parity(lc)]
		expect(codeword).toHaveLength(12)
		for (const r of [1, 2, 3]) expect(evaluate(codeword, r)).toBe(0)
	})

	it("encodes BPTC(196,96) codewords and splits the embedded LC in four", () => {
		// Each info bit, sent alone, lands on its own set of transmitted bits.
		const zero = bptc19696(new Array(96).fill(0))
		expect(zero.every(b => b === 0)).toBe(true)
		const seen = new Set<string>()
		for (let i = 0; i < 96; i++) {
			const one = new Array(96).fill(0)
			one[i] = 1
			const word = bptc19696(one)
			expect(word).toHaveLength(196)
			// Row and column Hamming parity: a single data bit sets at least 4 bits.
			expect(word.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(4)
			seen.add(word.join(""))
		}
		expect(seen.size).toBe(96)
		const fragments = embeddedLcFragments(
			dmrGroupVoiceLc({ talkgroup: 4321, source: 1_234_567 }),
		)
		expect(fragments.map(f => f.length)).toEqual([32, 32, 32, 32])
	})

	it("builds whole 30 ms bursts (144 symbols with the CACH) after a 480-symbol pre-roll", () => {
		const call = { talkgroup: 4321, source: 1_234_567, superframes: 2 }
		// Per slot-1 burst one slot-2 burst: 3 settle, 2 headers, 12 voice,
		// 2 terminators, 2 idle.
		expect(dmrCallDibits(call)).toHaveLength(480 + 2 * 21 * 144)
	})
})
