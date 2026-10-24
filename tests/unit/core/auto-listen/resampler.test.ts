import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	f32ToInt16,
	PolyphaseResampler,
	RESAMPLER_MAX_EXACT_PHASES,
	resamplerTaps,
} from "../../../../src/core/auto-listen/resampler.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import { feed, fitTone, lcg } from "./helpers.js"

const OUT = 48_000

describe("PolyphaseResampler sizing", () => {
	it("sizes taps from requirement 2.3 (design table)", () => {
		expect(resamplerTaps(8_000, OUT)).toBe(34)
		expect(resamplerTaps(25_000, OUT)).toBe(34)
		expect(resamplerTaps(25_600, OUT)).toBe(34)
		expect(resamplerTaps(48_000, OUT)).toBe(34)
		expect(resamplerTaps(96_000, OUT)).toBe(66)
		expect(resamplerTaps(200_000, OUT)).toBe(138)
	})

	it("uses exact phases up to 512 and interpolates past it", () => {
		expect(new PolyphaseResampler(8_000, OUT).phases).toBe(6)
		expect(new PolyphaseResampler(25_000, OUT).phases).toBe(48)
		expect(new PolyphaseResampler(25_600, OUT).phases).toBe(15)
		// 48 000 / gcd(48 000, 48 001) = 48 000 phases > 512: interpolated table.
		const r = new PolyphaseResampler(48_001, OUT)
		expect(r.interpolated).toBe(true)
		expect(r.phases).toBe(RESAMPLER_MAX_EXACT_PHASES)
		// 44 100: up = 160 ≤ 512, exact.
		expect(new PolyphaseResampler(44_100, OUT).interpolated).toBe(false)
	})

	it("rejects malformed rates", () => {
		for (const rate of [0, -8_000, Number.NaN, 8_000.5, 999, 400_001])
			expect(() => new PolyphaseResampler(rate, OUT)).toThrow(WaveKitError)
		expect(() => new PolyphaseResampler(1_000, OUT)).not.toThrow()
		expect(() => new PolyphaseResampler(400_000, OUT)).not.toThrow()
	})
})

describe("PolyphaseResampler conversion and delay", () => {
	it("converts f32 by clamp, × 32 767 and round half away (requirement 2.2)", () => {
		expect(f32ToInt16(1)).toBe(32_767)
		expect(f32ToInt16(2)).toBe(32_767)
		expect(f32ToInt16(-1)).toBe(-32_767)
		expect(f32ToInt16(-5)).toBe(-32_767)
		expect(f32ToInt16(Number.NaN)).toBe(0)
		expect(f32ToInt16(0.5 / 32_767)).toBe(1)
		expect(f32ToInt16(-0.5 / 32_767)).toBe(-1)
		expect(f32ToInt16(Number.POSITIVE_INFINITY)).toBe(32_767)
	})

	it("has unity DC gain and outputs at input time", () => {
		const r = new PolyphaseResampler(8_000, OUT)
		const input = new Int16Array(800).fill(1_000)
		const { samples } = feed(r, input, [], 4_096)
		// 800 inputs, delay 17: outputs with floor(j / 6) ≤ 782 → 4 698 outputs.
		expect(samples.length).toBe(r.pendingOutput(0) + samples.length)
		expect(samples.length).toBe((800 - r.delayInputSamples) * 6)
		for (let j = 600; j < samples.length; j++) expect(samples[j]).toBe(1_000)
	})

	it("matches f32 and s16 input of the same values", () => {
		const n = 1_000
		const ints = new Int16Array(n)
		const floats = new Float32Array(n)
		const rand = lcg(7)
		for (let i = 0; i < n; i++) {
			const v = Math.round((rand() * 2 - 1) * 20_000)
			ints[i] = v
			floats[i] = v / 32_767
		}
		const a = feed(new PolyphaseResampler(25_000, OUT), ints, [], 512)
		const b = feed(new PolyphaseResampler(25_000, OUT), floats, [], 512)
		expect(b.samples).toEqual(a.samples)
	})

	it("reset starts a fresh stream", () => {
		const r = new PolyphaseResampler(25_600, OUT)
		const rand = lcg(3)
		const input = Int16Array.from({ length: 700 }, () =>
			Math.round((rand() * 2 - 1) * 30_000),
		)
		const first = feed(r, input, [], 333)
		r.reset()
		const second = feed(r, input, [], 333)
		expect(second.samples).toEqual(first.samples)
	})

	it("pendingOutput predicts what consuming input produces", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 8_000, max: 200_000 }),
				fc.array(fc.integer({ min: 0, max: 400 }), { maxLength: 8 }),
				(rate, lengths) => {
					const r = new PolyphaseResampler(rate, OUT)
					const out = new Int16Array(10_000)
					for (const len of lengths) {
						const input = new Int16Array(len)
						const expected = r.pendingOutput(len)
						r.process(input, 0, len, out, 0, out.length)
						expect(r.produced).toBe(expected)
						expect(r.consumed).toBe(len)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("PolyphaseResampler properties", () => {
	// Feature: auto-listen-route, Property 1: Chunk-split invariance
	// Validates: Requirements 2.4, 2.5
	it("output and flags do not depend on input or output splits", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.constantFrom(8_000, 25_000, 25_600, 48_000, 96_000, 200_000),
					fc.integer({ min: 8_000, max: 200_000 }),
				),
				fc.integer({ min: 0, max: 3_000 }),
				fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 12 }),
				fc.integer({ min: 1, max: 2_000 }),
				fc.boolean(),
				fc.integer(),
				(rate, length, cutFractions, outWindow, asFloat, seed) => {
					const rand = lcg(seed)
					const input = asFloat
						? Float32Array.from({ length }, () => rand() * 2.2 - 1.1)
						: Int16Array.from({ length }, () =>
								Math.round((rand() * 2 - 1) * 32_767),
							)
					const cuts = [
						...new Set(cutFractions.map(f => Math.floor(f * length))),
					]
						.filter(c => c > 0 && c < length)
						.sort((a, b) => a - b)
					// Flag of a sample: deterministic by position, so spans split anywhere agree.
					const flagAt = (at: number): number =>
						(Math.floor(at / 97) % 3) as number
					const reference = feedPerSample(
						new PolyphaseResampler(rate, OUT),
						input,
						flagAt,
					)
					const split = feed(
						new PolyphaseResampler(rate, OUT),
						input,
						cutsWithFlagEdges(cuts, length),
						outWindow,
						flagAt,
					)
					expect(split.samples).toEqual(reference.samples)
					expect(split.flags).toEqual(reference.flags)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: auto-listen-route, Property 2: Resampler response
	// Validates: Requirements 2.2, 2.3
	it("passes tones up to 0.4 m within ±0.5 dB", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 8_000, max: 200_000 }),
				fc.double({ min: 0.01, max: 1, noNaN: true }),
				fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
				(rate, frac, phase) => {
					const m = Math.min(rate, OUT)
					const hz = Math.max(20, frac * 0.4 * m)
					const { y, from, to } = tone(rate, hz, phase)
					const fit = fitTone(y, from, to, hz / OUT)
					const db = 20 * Math.log10(fit.amplitude / AMPLITUDE)
					expect(Math.abs(db)).toBeLessThanOrEqual(0.5)
					// Images (upsampling) and aliases stay ≥ 50 dB down.
					const rel =
						20 * Math.log10(fit.residualRms / (AMPLITUDE / Math.SQRT2))
					expect(rel).toBeLessThanOrEqual(-50)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: auto-listen-route, Property 2: Resampler response
	// Validates: Requirements 2.2, 2.3
	it("attenuates input above 0.5 m by at least 50 dB", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 49_000, max: 200_000 }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
				(rate, frac, phase) => {
					const lo = 0.5 * OUT
					const hi = 0.49 * rate
					const hz = lo + frac * (hi - lo)
					const { y, from, to } = tone(rate, hz, phase)
					let e = 0
					for (let n = from; n < to; n++) e += (y[n] ?? 0) ** 2
					const rms = Math.sqrt(e / (to - from))
					const rel = 20 * Math.log10(rms / (AMPLITUDE / Math.SQRT2))
					expect(rel).toBeLessThanOrEqual(-50)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("attenuates at the bound (0.5 m) and passes at 0.4 m for the wiring rates", () => {
		for (const rate of [8_000, 25_000, 25_600, 96_000, 200_000]) {
			const m = Math.min(rate, OUT)
			const pass = tone(rate, 0.4 * m, 0.3)
			const fit = fitTone(pass.y, pass.from, pass.to, (0.4 * m) / OUT)
			expect(
				Math.abs(20 * Math.log10(fit.amplitude / AMPLITUDE)),
			).toBeLessThanOrEqual(0.5)
			if (rate > OUT) {
				const stop = tone(rate, 0.5 * m, 0.3)
				const s = fitTone(stop.y, stop.from, stop.to, 0.01)
				expect(
					20 * Math.log10(s.rms / (AMPLITUDE / Math.SQRT2)),
				).toBeLessThanOrEqual(-50)
			}
		}
	})
})

const AMPLITUDE = 16_000

/** Resamples a tone; returns the output and a steady window of about 4 800 samples. */
function tone(
	rate: number,
	hz: number,
	phase: number,
): { y: number[]; from: number; to: number } {
	const r = new PolyphaseResampler(rate, OUT)
	const length = Math.ceil((5_400 * rate) / OUT) + 2 * r.taps
	const input = new Int16Array(length)
	for (let n = 0; n < length; n++)
		input[n] = Math.round(
			AMPLITUDE * Math.cos((2 * Math.PI * hz * n) / rate + phase),
		)
	const { samples } = feed(r, input, [], 8_192)
	const from = Math.ceil((r.taps * OUT) / rate) + 8
	return { y: samples, from, to: Math.min(samples.length, from + 4_800) }
}

/** Reference: one input sample per call, unlimited output. */
function feedPerSample(
	r: PolyphaseResampler,
	input: Int16Array | Float32Array,
	flagAt: (at: number) => number,
): { samples: number[]; flags: number[] } {
	const samples: number[] = []
	const flags: number[] = []
	const out = new Int16Array(64)
	const outFlags = new Uint8Array(64)
	for (let i = 0; i < input.length; i++) {
		r.process(input, i, i + 1, out, 0, out.length, flagAt(i), outFlags)
		for (let k = 0; k < r.produced; k++) {
			samples.push(out[k] ?? 0)
			flags.push(outFlags[k] ?? 0)
		}
	}
	return { samples, flags }
}

/** Adds the flag boundaries (multiples of 97) so each span carries one flag. */
function cutsWithFlagEdges(cuts: readonly number[], length: number): number[] {
	const all = new Set(cuts)
	for (let c = 97; c < length; c += 97) all.add(c)
	return [...all].sort((a, b) => a - b)
}
