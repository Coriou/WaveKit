/**
 * Fractional analog rates (requirement 2.2): csdr's PCM runs at IQ rate / decimation, e.g.
 * 1 024 000 / 41 = 24 975.61 Hz. The ratio to 48 kHz stays exact, so /auto never drifts.
 */
import { EventEmitter } from "node:events"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { AUTO_ROUTE_STREAM } from "../../../../src/core/auto-listen/contract.js"
import type { AutoRouteClock } from "../../../../src/core/auto-listen/contract.js"
import {
	PolyphaseResampler,
	RESAMPLER_MAX_RATE_DEN,
	rationalRate,
} from "../../../../src/core/auto-listen/resampler.js"
import { AutoListenRouter } from "../../../../src/core/auto-listen/router.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import { createLogger } from "../../../../src/utils/logger.js"

const OUT = 48_000

function gcd(a: number, b: number): number {
	return b === 0 ? a : gcd(b, a % b)
}

describe("rationalRate", () => {
	it("recovers the live csdr rate and integers exactly", () => {
		expect(rationalRate(1_024_000 / 41)).toEqual({ num: 1_024_000, den: 41 })
		expect(rationalRate(2_400_000 / 96)).toEqual({ num: 25_000, den: 1 })
		expect(rationalRate(48_000)).toEqual({ num: 48_000, den: 1 })
	})

	// Requirement 2.2 (not a numbered design property): exact recovery of IQ rate / decimation.
	it("recovers any IQ rate / decimation with decimation ≤ 4 096 exactly", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: RESAMPLER_MAX_RATE_DEN }),
				fc.integer({ min: 8_000, max: 200_000 }),
				fc.integer({ min: 0, max: 1_000_000 }),
				(decimation, base, jitter) => {
					const iq = Math.min(
						200_000 * decimation,
						base * decimation + (jitter % decimation),
					)
					const g = gcd(iq, decimation)
					expect(rationalRate(iq / decimation)).toEqual({
						num: iq / g,
						den: decimation / g,
					})
				},
			),
			{ numRuns: 300 },
		)
	})

	it("bounds the denominator at 4 096; a rate needing more gets the nearest within the bound", () => {
		expect(rationalRate(8_000_001 / 4_096)?.den).toBe(4_096)
		const r = rationalRate(10_000_001 / 4_097)
		expect(r).not.toBeNull()
		expect(r?.den ?? 0).toBeLessThanOrEqual(RESAMPLER_MAX_RATE_DEN)
		// Residual below 1 / 4 096 Hz.
		expect(
			Math.abs((r?.num ?? 0) / (r?.den ?? 1) - 10_000_001 / 4_097),
		).toBeLessThan(1 / RESAMPLER_MAX_RATE_DEN)
	})

	it("returns null for non-finite or non-positive rates", () => {
		for (const rate of [Number.NaN, Number.POSITIVE_INFINITY, 0, -25_000])
			expect(rationalRate(rate)).toBeNull()
	})
})

describe("PolyphaseResampler at a rational input rate", () => {
	it("1 024 000 / 41 Hz is the exact 123 / 64 ratio on 123 exact phases", () => {
		const r = new PolyphaseResampler({ num: 1_024_000, den: 41 }, OUT)
		expect(r.up).toBe(123)
		expect(r.down).toBe(64)
		expect(r.interpolated).toBe(false)
		expect(r.phases).toBe(123)
		expect(r.inRate).toBeCloseTo(24_975.609_756, 5)
	})

	it("accepts den 4 096, rejects 0, 4 097, non-integers and an effective rate out of range", () => {
		expect(
			() => new PolyphaseResampler({ num: 40_960_001, den: 4_096 }, OUT),
		).not.toThrow()
		for (const bad of [
			{ num: 1_024_000, den: 0 },
			{ num: 41_000_000, den: 4_097 },
			{ num: 1_024_000.5, den: 41 },
			{ num: 1_024_000, den: 41.5 },
			{ num: 999, den: 1 },
			{ num: 400_001 * 3, den: 3 },
		])
			expect(() => new PolyphaseResampler(bad, OUT)).toThrow(WaveKitError)
		// The interpolated path (up > 512) keeps the exact step: 48 000 × 4 096 / 40 960 001.
		const r = new PolyphaseResampler({ num: 40_960_001, den: 4_096 }, OUT)
		expect(r.interpolated).toBe(true)
		expect(r.up).toBe(OUT * 4_096)
		expect(r.down).toBe(40_960_001)
	})

	const RATES: Array<[string, { num: number; den: number }]> = [
		["24 975.61 Hz (1 024 000 / 41)", { num: 1_024_000, den: 41 }],
		["24 999.975 Hz (just below 25 000)", { num: 999_999, den: 40 }],
		["25 000.025 Hz (just above 25 000)", { num: 1_000_001, den: 40 }],
		["8 000.4 Hz (40 002 / 5)", { num: 40_002, den: 5 }],
	]
	for (const [name, rate] of RATES)
		it(`${name}: after 6 h the output is input × 48 000 / rate within one sample`, () => {
			const r = new PolyphaseResampler(rate, OUT)
			const inRate = rate.num / rate.den
			const input = Math.floor(6 * 3_600 * inRate)
			const expected = ((input - r.delayInputSamples) * OUT) / inRate
			expect(Math.abs(r.pendingOutput(input) - expected)).toBeLessThanOrEqual(1)
		})
})

class StepClock implements AutoRouteClock {
	t = 0
	fn: (() => void) | null = null
	now(): number {
		return this.t
	}
	setInterval(fn: () => void): unknown {
		this.fn = fn
		return 1
	}
	clearInterval(): void {
		this.fn = null
	}
}

class SinkResponse extends EventEmitter {
	bytes = 0
	writableEnded = false
	destroyed = false
	write(chunk: Buffer): boolean {
		this.bytes += chunk.length
		return true
	}
	end(): void {
		this.writableEnded = true
		this.emit("close")
	}
	destroy(): void {
		this.destroyed = true
		this.emit("close")
	}
}

// The rounded-rate resampler this replaces drifts 15.6 ppm at 1 024 000 / 41 (about 90 samples in
// these 120 s) and 1 ppm at ±0.025 Hz from 25 000 (about 6), both past the 4-sample bound.
describe("AutoListenRouter: a long stuck-open over at a fractional rate", () => {
	const SIM_S = 150
	for (const [name, num, den] of [
		["1 024 000 / 41 Hz", 1_024_000, 41],
		["24 999.975 Hz", 999_999, 40],
		["25 000.025 Hz", 1_000_001, 40],
	] as const)
		it(`${name}: ${SIM_S} s of continuous audible analog keeps a flat backlog, no drops or underrun growth`, () => {
			const clock = new StepClock()
			const router = new AutoListenRouter(createLogger({ level: "fatal" }), {
				clock,
			})
			const sink = new SinkResponse()
			router.registry.register(sink as never, "auto", AUTO_ROUTE_STREAM)
			const inner = router as unknown as { analog: { out: { queued: number } } }
			const stream = { rate: num / den, format: "s16le" as const }
			// A tone well inside the passband (never silent, so catch-up can never discard).
			const chunk = Buffer.alloc(2 * Math.ceil((num / den) * 0.01) + 4)
			let sent = 0
			let phase = 0
			let underrunsAt30 = 0
			let queuedAt30 = 0
			for (let ms = 10; ms <= SIM_S * 1_000; ms += 10) {
				// Samples due by `ms`, from exact integer arithmetic: floor(ms × num / (1 000 den)).
				const due = Math.floor((ms * num) / (1_000 * den))
				const n = due - sent
				sent = due
				for (let i = 0; i < n; i++) {
					chunk.writeInt16LE(Math.round(8_000 * Math.sin(phase)), 2 * i)
					phase += (2 * Math.PI * 1_000 * den) / num
				}
				router.pushAnalog(chunk, 0, 2 * n, true, stream)
				clock.t = ms
				clock.fn?.()
				if (ms === 30_000) {
					underrunsAt30 = router.underruns
					queuedAt30 = inner.analog.out.queued
				}
			}
			expect(router.droppedSamples).toBe(0)
			expect(router.underruns).toBe(underrunsAt30)
			expect(router.clockRebases).toBe(0)
			// Same tick phase as at 30 s: the backlog moved by at most a few samples (no drift).
			expect(
				Math.abs(inner.analog.out.queued - queuedAt30),
			).toBeLessThanOrEqual(4)
			expect(sink.bytes).toBe(SIM_S * OUT * 2 - ((SIM_S * OUT * 2) % 1_920))
			router.destroy()
		}, 60_000)
})
