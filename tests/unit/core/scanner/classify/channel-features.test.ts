import { describe, expect, it } from "vitest"
import {
	extractChannelFeatures,
	MAX_CHANNEL_FEATURE_BYTES,
	MAX_CHANNEL_FEATURE_SAMPLES,
} from "../../../../../src/core/scanner/classify/channel-features.js"
import type { ChannelFeatureInput } from "../../../../../src/core/scanner/classify/channel-features.js"

const input: ChannelFeatureInput = { outputRateHz: 48_000, format: "cf32", snrDb: 20 }

/** Continuous phase FM; every index denotes one complex sample at the actual rate. */
function fm(frequency: (sample: number) => number, count = 24_000): Float32Array {
	const samples = new Float32Array(count * 2)
	let phase = 0
	for (let i = 0; i < count; i++) {
		phase += 2 * Math.PI * frequency(i) / 48_000
		samples[2 * i] = Math.cos(phase)
		samples[2 * i + 1] = Math.sin(phase)
	}
	return samples
}

describe("bounded actual channel features", () => {
	it("counts complex samples and requires 500 ms even when the monitor minimum is 300 ms", () => {
		expect(extractChannelFeatures(fm(() => 0, 23_999), { ...input, minMs: 300 }))
			.toEqual({ kind: "unknown", reason: "insufficient-on-samples" })
		expect(extractChannelFeatures(fm(() => 0), { ...input, minMs: 300 }))
			.toMatchObject({ kind: "evidence", sampleCount: 24_000, onSamples: 24_000, durationMs: 500, onDurationMs: 500 })
		expect(extractChannelFeatures(fm(() => 0), { ...input, minMs: 1000 }))
			.toEqual({ kind: "unknown", reason: "insufficient-on-samples" })
	})

	it("includes the exact 96000-complex / 768000-byte limit but rejects the next sample", () => {
		const samples = fm(() => 0, MAX_CHANNEL_FEATURE_SAMPLES)
		expect(samples.byteLength).toBe(MAX_CHANNEL_FEATURE_BYTES)
		expect(extractChannelFeatures(samples, { ...input, minMs: 2000 })).toMatchObject({ kind: "evidence", durationMs: 2000 })
		expect(extractChannelFeatures(fm(() => 0, MAX_CHANNEL_FEATURE_SAMPLES + 1), input))
			.toEqual({ kind: "unknown", reason: "sample-bound" })
	})

	it("removes a residual carrier offset without inventing modulation", () => {
		const result = extractChannelFeatures(fm(() => 1300), input)
		expect(result.kind).toBe("evidence")
		if (result.kind !== "evidence") return
		expect(result.discriminator.centerOffsetHz).toBeCloseTo(1300, 2)
		expect(result.discriminator.stdHz).toBeLessThan(0.01)
		expect(result.discriminator.deviationHz).toBeLessThan(0.01)
		expect(result.discriminator.histogram.reduce((a, b) => a + b, 0)).toBe(23_999)
	})

	it("finds four separate discriminator clusters and their spacing", () => {
		let seed = 19
		let frequency = -1800
		const result = extractChannelFeatures(fm(i => {
			if (i % 40 === 0) {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
				frequency = [-1800, -600, 600, 1800][seed >>> 30]!
			}
			return frequency
		}), input)
		expect(result.kind).toBe("evidence")
		if (result.kind !== "evidence") return
		expect(result.discriminator.peaksHz).toHaveLength(4)
		for (const spacing of result.discriminator.peakSpacingHz)
			expect(spacing).toBeGreaterThan(1000)
		expect(result.discriminator.stdHz).toBeLessThan(2000)
		expect(result.discriminator.peakStdHz.every(std => std < 500)).toBe(true)
	})

	it("recognises alternating 1200/2200 tone evidence but rejects a simultaneous tone mixture", () => {
		let phase = 0
		const alternating = extractChannelFeatures(fm(i => {
			phase += 2 * Math.PI * (Math.floor(i / 960) % 2 === 0 ? 1200 : 2200) / 48_000
			return 3000 * Math.sin(phase)
		}), input)
		expect(alternating).toMatchObject({ kind: "evidence", afsk: { kind: "pair" } })
		const mixed = extractChannelFeatures(fm(i => 1500 * (
			Math.sin(2 * Math.PI * 1200 * i / 48_000) + Math.sin(2 * Math.PI * 2200 * i / 48_000)
		)), input)
		expect(mixed).toMatchObject({ kind: "evidence", afsk: { kind: "ambiguous" } })
	})

	it("reports supported CTCSS tone evidence without DCS or decoded identity", () => {
		const result = extractChannelFeatures(fm(i => 1000 * Math.sin(2 * Math.PI * 100 * i / 48_000)), input)
		expect(result).toMatchObject({ kind: "evidence", ctcss: { kind: "tone", hz: 100 } })
		expect(result).not.toHaveProperty("dcs")
		expect(result).not.toHaveProperty("protocol")
	})

	it("keeps two simultaneous subaudible tones ambiguous", () => {
		const result = extractChannelFeatures(fm(i => 700 * (
			Math.sin(2 * Math.PI * 100 * i / 48_000) + Math.sin(2 * Math.PI * 110.9 * i / 48_000)
		)), input)
		expect(result).toMatchObject({ kind: "evidence", ctcss: { kind: "ambiguous" } })
	})

	it("reports the supported change-envelope line rather than claiming a protocol or recovered clock", () => {
		const result = extractChannelFeatures(fm(i => 1800 * Math.sin(2 * Math.PI * 2400 * i / 48_000)), input)
		expect(result).toMatchObject({ kind: "evidence", symbolRate: { kind: "supported", baud: 4800 } })
	})

	it("gives identical pure results after arbitrarily split interleaved float collection", () => {
		const original = fm(i => 1000 * Math.sin(2 * Math.PI * 100 * i / 48_000))
		const split = [original.subarray(0, 1), original.subarray(1, 997), original.subarray(997, 15_001), original.subarray(15_001)]
		const collected = new Float32Array(original.length)
		let offset = 0
		for (const chunk of split) {
			collected.set(chunk, offset)
			offset += chunk.length
		}
		expect(extractChannelFeatures(collected, input)).toEqual(extractChannelFeatures(original, input))
		expect(extractChannelFeatures(split[0]!, input)).toEqual({ kind: "unknown", reason: "incomplete-sample" })
	})

	it.each([
		[{ outputRateHz: 44_100 }, "unsupported-realisation"],
		[{ format: "cu8" }, "unsupported-realisation"],
		[{ snrDb: 9 }, "insufficient-snr"],
		[{ snrDb: Number.NaN }, "insufficient-snr"],
		[{ gaps: true }, "gaps"],
		[{ ambiguous: true }, "ambiguous"],
		[{ minMs: 299 }, "invalid-window"],
		[{ minMs: 2001 }, "invalid-window"],
		[{ minMs: 500.5 }, "invalid-window"],
		[{ onPowerThreshold: -1 }, "nonfinite"],
	] as const)("falls back for unsupported or unsafe input %j", (override, reason) => {
		expect(extractChannelFeatures(fm(() => 0), { ...input, ...override })).toEqual({ kind: "unknown", reason })
	})

	it("rejects nonfinite samples anywhere, missing SNR, and too few on-samples", () => {
		const samples = fm(() => 0)
		samples[samples.length - 1] = Number.NaN
		expect(extractChannelFeatures(samples, input)).toEqual({ kind: "unknown", reason: "nonfinite" })
		const missingSnr = { ...input }
		Reflect.deleteProperty(missingSnr, "snrDb")
		expect(extractChannelFeatures(fm(() => 0), missingSnr))
			.toEqual({ kind: "unknown", reason: "insufficient-snr" })
		const off = fm(() => 0)
		off.fill(0, 0, 2000)
		expect(extractChannelFeatures(off, input)).toEqual({ kind: "unknown", reason: "insufficient-on-samples" })
		expect(extractChannelFeatures(fm(i => 13_000 * Math.sin(2 * Math.PI * 1000 * i / 48_000)), input))
			.toEqual({ kind: "unknown", reason: "unsupported-deviation" })
	})
})
