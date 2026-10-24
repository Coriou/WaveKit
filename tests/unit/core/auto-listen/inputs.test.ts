import { describe, expect, it } from "vitest"
import {
	AnalogInput,
	resamplerInputRate,
} from "../../../../src/core/auto-listen/inputs.js"
import { FLAG_AUDIBLE } from "../../../../src/core/auto-listen/source-fifo.js"

/** Pushes 0.1 s of a loud s16le square at `rate`; returns push's result and the queued audio. */
function pushAt(rate: number): { accepted: boolean; qualified: number } {
	const input = new AnalogInput({ droppedSamples: 0 }, undefined)
	const samples = Number.isFinite(rate) ? Math.floor(rate / 10) : 1_000
	const pcm = Buffer.alloc(samples * 2)
	for (let i = 0; i < samples; i++)
		pcm.writeInt16LE(i % 20 < 10 ? 8_000 : -8_000, i * 2)
	const accepted = input.push(
		pcm,
		0,
		pcm.length,
		FLAG_AUDIBLE,
		{ rate, format: "s16le" },
		0,
	)
	return { accepted, qualified: input.out.queuedQualified }
}

describe("AnalogInput pipeline rates (requirement 2.2)", () => {
	it("accepts the fractional csdr rate 1 024 000 / 41 Hz and queues qualified audio", () => {
		const { accepted, qualified } = pushAt(1_024_000 / 41)
		expect(accepted).toBe(true)
		// 0.1 s in, about 4 800 samples at 48 kHz less the resampler's group delay.
		expect(qualified).toBeGreaterThan(4_000)
	})

	it("accepts the bounds 8 000 and 200 000 Hz and fractional rates just inside them", () => {
		for (const rate of [8_000, 8_000.4, 199_999.6, 200_000])
			expect(pushAt(rate).accepted).toBe(true)
	})

	it("rejects rates past the bounds and non-finite rates (nothing queued)", () => {
		for (const rate of [
			7_999.9,
			200_000.1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			const { accepted, qualified } = pushAt(rate)
			expect(accepted).toBe(false)
			expect(qualified).toBe(0)
		}
	})

	it("rounds the resampler input rate to the nearest integer (error at most 0.5 Hz)", () => {
		expect(resamplerInputRate(1_024_000 / 41)).toBe(24_976)
		expect(resamplerInputRate(8_000.4)).toBe(8_000)
		expect(resamplerInputRate(199_999.6)).toBe(200_000)
		for (const rate of [8_000.5, 12_345.678, 24_975.61, 199_999.5])
			expect(Math.abs(resamplerInputRate(rate) - rate)).toBeLessThanOrEqual(0.5)
	})
})
