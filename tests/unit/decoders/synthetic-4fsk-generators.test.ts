/**
 * The synthetic 4FSK generators' arithmetic (scripts/fixtures): the CNR noise
 * level, the standard transmit filters and the DMR codes. Whether dsd-fme
 * decodes them is tests/integration/synthetic-frames.test.ts.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DMR_DIRECT_BURST_SYMBOLS,
	DMR_DIRECT_FRAME_SYMBOLS,
	DMR_KEYED_OFF,
	bptc19696,
	dmrCallDibits,
	dmrDirectCallDibits,
	dmrDirectEnvelope,
	dmrDirectFrequency,
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
	fmCu8,
	noiseForCnr,
	pulseResponse,
	shapeFrequency,
	pulseSpectrum,
	receiveSpectrum,
} from "../../../scripts/fixtures/fsk-iq.mjs"
import { ysfCallDibits } from "../../../scripts/fixtures/ysf-c4fm.mjs"
import { residualOffset } from "../../integration/dsd-fme-margin.js"

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

	it("delays every symbol by delaySymbols (the transmitter's clock phase)", () => {
		const symbols = [1, 3, 0, 2, 1, 1, 3, 2, 0, 0]
		const options = {
			symbolRate: 4800,
			deviationHz: (d: number) => [600, 1800, -600, -1800][d]!,
			shaping: "rrc" as const,
			alpha: 0.2,
		}
		const base = shapeFrequency(symbols, options)
		// Half a symbol is 5 samples at 48 kHz: the same trace, 5 samples later.
		const late = shapeFrequency(symbols, { ...options, delaySymbols: 0.5 })
		for (let i = 0; i + 5 < base.length; i++)
			expect(late[i + 5]).toBeCloseTo(base[i]!, 9)
	})

	it("repeats the YSF V/D2 superframe: 7 more frames of 480 symbols each", () => {
		const call = { dest: "ALL", src: "N0CALL" }
		const one = ysfCallDibits(call).length
		expect(ysfCallDibits({ ...call, superframes: 4 }).length - one).toBe(
			3 * 7 * 480,
		)
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

	it("keys a direct-mode call: one 132-symbol burst per 288-symbol frame with the MS syncs", () => {
		const call = { talkgroup: 4321, source: 1_234_567, superframes: 2 }
		const dibits = dmrDirectCallDibits(call)
		const off = DMR_DIRECT_FRAME_SYMBOLS - DMR_DIRECT_BURST_SYMBOLS
		// Off, then per burst (2 headers, 12 voice, 2 terminators) the burst and an off gap.
		expect(dibits).toHaveLength(off + 16 * DMR_DIRECT_FRAME_SYMBOLS)
		const hex = (v: number) =>
			bitsOf(v, 48)
				.join("")
				.match(/../g)!
				.map(b => parseInt(b, 2))
				.join("")
		for (let b = 0; b < 16; b++) {
			const start = off + b * DMR_DIRECT_FRAME_SYMBOLS
			const burst = dibits.slice(start, start + DMR_DIRECT_BURST_SYMBOLS)
			expect(burst).not.toContain(DMR_KEYED_OFF)
			expect(
				dibits.slice(
					start + DMR_DIRECT_BURST_SYMBOLS,
					start + DMR_DIRECT_FRAME_SYMBOLS,
				),
			).toEqual(new Array(off).fill(DMR_KEYED_OFF))
			// The sync (or EMB and embedded LC) sits in the middle 24 symbols.
			const middle = burst.slice(54, 78).join("")
			const isData = b < 2 || b >= 14
			if (isData) expect(middle).toBe(hex(0xd5d7f77fd757))
			else if ((b - 2) % 6 === 0) expect(middle).toBe(hex(0x7f7d5dd57dfd))
		}
		// The envelope is full over every burst, zero mid-gap, and ramps within 1.25 ms.
		const freq = dmrDirectFrequency(call)
		const env = dmrDirectEnvelope(call)
		expect(env).toHaveLength(freq.length)
		const sps = 10
		const pad = 8
		for (let b = 0; b < 16; b++) {
			const s = (pad + off + b * DMR_DIRECT_FRAME_SYMBOLS) * sps
			for (let i = s; i < s + DMR_DIRECT_BURST_SYMBOLS * sps; i++)
				expect(env[i]).toBe(1)
			expect(env[s - 61]).toBe(0)
			expect(env[s - 30]).toBeGreaterThan(0)
			expect(env[s + DMR_DIRECT_BURST_SYMBOLS * sps + 61]).toBe(0)
			expect(freq[s - 100]).toBeCloseTo(0, 6)
		}
	})

	it("keys the carrier of fmCu8 with an envelope", () => {
		const freq = new Float64Array(4800).fill(500)
		const envelope = new Float64Array(4800)
		envelope.fill(1, 2400)
		const iq = fmCu8(freq, {
			sampleRateHz: 48_000,
			amplitude: 0.5,
			noise: 0,
			leadSeconds: 0,
			envelope,
		})
		const mag = (k: number) =>
			Math.hypot(iq[2 * k]! - 127.5, iq[2 * k + 1]! - 127.5) / 127.5
		for (const k of [10, 1000, 2300]) expect(mag(k)).toBeLessThan(0.01)
		for (const k of [2500, 3000, 4700]) expect(mag(k)).toBeCloseTo(0.5, 1)
	})

	it("measures the residual carrier offset over the second half of the carrier-on samples", () => {
		// cf32 at 48 kHz: 0.1 s of nothing, then a carrier 300 Hz off modulated by +-1 kHz squares.
		const lead = 4800
		const n = 9600
		const freq = new Float64Array(n).map((_, j) =>
			j % 480 < 240 ? 1000 : -1000,
		)
		const run = (offsetHz: number, envelope?: Float64Array) => {
			const cf32 = Buffer.alloc(8 * (lead + n))
			let phase = 0
			for (let j = 0; j < n; j++) {
				phase += (2 * Math.PI * (offsetHz + freq[j]!)) / 48_000
				cf32.writeFloatLE(Math.cos(phase), 8 * (lead + j))
				cf32.writeFloatLE(Math.sin(phase), 8 * (lead + j) + 4)
			}
			return residualOffset(
				cf32,
				{ freq, ...(envelope ? { envelope } : {}) },
				lead,
			)
		}
		const steady = run(300)
		expect(steady.hz).toBeCloseTo(300, 1)
		expect(steady.samples).toBeGreaterThan(n / 2 - 2)
		expect(steady.samples).toBeLessThanOrEqual(n / 2)
		expect(run(0).hz).toBeCloseTo(0, 1)
		// Keyed: only the on samples count.
		const envelope = new Float64Array(n).map((_, j) => (j % 960 < 480 ? 1 : 0))
		const keyed = run(-450, envelope)
		expect(keyed.hz).toBeCloseTo(-450, 1)
		expect(keyed.samples).toBeLessThan(n / 4)
		// Nothing on: nothing weighed.
		expect(run(100, new Float64Array(n))).toEqual({ hz: 0, samples: 0 })
	})
})
