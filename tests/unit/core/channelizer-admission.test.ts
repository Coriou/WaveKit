import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { WaveKitError } from "../../../src/utils/errors.js"
import {
	ADMISSION_EPSILON_HZ,
	admitChannel,
} from "../../../src/core/channelizer/admission.js"
import {
	CHANNEL_ADMISSION_REASONS,
	isChannelAdmissionReason,
} from "../../../src/core/channelizer/types.js"

const capture = { sampleRateHz: 2_048_000, centerHz: 162_000_000 }
const base = {
	centerHz: 162e6,
	bandwidthHz: 45_600,
	transitionHz: 1_200,
	outputRateHz: 48_000,
	format: "cf32" as const,
}

describe("admitChannel", () => {
	it("admits the default request exactly on the out/2 boundary", () => {
		// Review Focus 1
		const out = 48_000
		const t = 0.05
		const v = admitChannel(
			{
				centerHz: 162e6,
				bandwidthHz: out * (1 - t),
				transitionHz: (out * t) / 2,
				outputRateHz: out,
				format: "cf32",
			},
			capture,
			0.8,
		)
		expect(v).toEqual({ admitted: true, offsetHz: 0 })
	})

	it("admits the §2 default passband that rounds one ulp past out/2 (native admission.rs)", () => {
		const out = 250_000
		const t = 0.18
		const req = {
			centerHz: 162e6,
			bandwidthHz: out * (1 - t),
			transitionHz: (out * t) / 2,
			outputRateHz: out,
			format: "cu8" as const,
		}
		expect(req.bandwidthHz / 2 + req.transitionHz).toBeGreaterThan(out / 2)
		expect(admitChannel(req, capture, 0.8)).toEqual({
			admitted: true,
			offsetHz: 0,
		})
		expect(
			admitChannel({ ...req, bandwidthHz: 250_000 * 0.82 }, capture, 0.8),
		).toEqual({ admitted: true, offsetHz: 0 })
	})

	it("uses the native planner's epsilon, and nothing beyond it", () => {
		expect(ADMISSION_EPSILON_HZ).toBe(1e-6)
		const v = admitChannel(
			{
				...base,
				bandwidthHz: 230_000,
				transitionHz: 10_001,
				outputRateHz: 250_000,
				format: "cu8",
			},
			capture,
			0.8,
		)
		expect(v.admitted ? "admitted" : v.reasonCode).toBe(
			"channel-request-invalid",
		)
		// Pins the slack itself on both inequalities: +0.5 µHz is admitted, +2 µHz is not.
		const over = (extra: number) => ({
			...base,
			bandwidthHz: 2 * (24_000 - 1_200 + extra),
		})
		expect(over(0.5e-6).bandwidthHz / 2 + 1_200).toBeGreaterThan(24_000)
		expect(admitChannel(over(0.5e-6), capture, 0.8).admitted).toBe(true)
		const rate = admitChannel(over(2e-6), capture, 0.8)
		expect(rate.admitted ? "admitted" : rate.reasonCode).toBe(
			"channel-request-invalid",
		)
		const edge = 819_200 - 24_000
		expect(
			admitChannel({ ...base, centerHz: 162e6 + edge + 0.5e-6 }, capture, 0.8)
				.admitted,
		).toBe(true)
		const span = admitChannel(
			{ ...base, centerHz: 162e6 + edge + 2e-6 },
			capture,
			0.8,
		)
		expect(span.admitted ? "admitted" : span.reasonCode).toBe(
			"channel-outside-capture",
		)
	})

	it("throws on a usable fraction outside (0, 1]: a programming error, not a verdict", () => {
		for (const f of [Number.NaN, 0, -0.5, 1.01, Number.POSITIVE_INFINITY])
			expect(() => admitChannel(base, capture, f)).toThrow(WaveKitError)
		expect(admitChannel(base, capture, 1).admitted).toBe(true)
	})

	it("classifies invalid requests", () => {
		for (const bad of [
			{ bandwidthHz: Number.NaN },
			{ centerHz: Number.POSITIVE_INFINITY },
			{ transitionHz: 0 },
			{ transitionHz: -1 },
			{ bandwidthHz: 0 },
			{ outputRateHz: 0 },
			{ outputRateHz: 48_000.5 },
			{ outputRateHz: 3_000_000 },
			{ bandwidthHz: 50_000 },
			{ gain: 2 },
		]) {
			const v = admitChannel({ ...base, ...bad }, capture, 0.8)
			expect(v.admitted ? "admitted" : v.reasonCode).toBe(
				"channel-request-invalid",
			)
		}
		const nonFiniteCapture = admitChannel(
			base,
			{ ...capture, centerHz: Number.NEGATIVE_INFINITY },
			0.8,
		)
		expect(
			nonFiniteCapture.admitted ? "admitted" : nonFiniteCapture.reasonCode,
		).toBe("channel-request-invalid")
	})

	it("mirrors the process's gain rule: cu8 only, finite and > 0", () => {
		const cu8 = { ...base, format: "cu8" as const }
		expect(admitChannel({ ...cu8, gain: 2.5 }, capture, 0.8).admitted).toBe(
			true,
		)
		for (const gain of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const v = admitChannel({ ...cu8, gain }, capture, 0.8)
			expect(v.admitted ? "admitted" : v.reasonCode).toBe(
				"channel-request-invalid",
			)
		}
	})

	it("checks in the process's order: finite, then rates, then out/2, then the capture span", () => {
		const both = admitChannel(
			{ ...base, centerHz: Number.NaN, outputRateHz: 3_000_000 },
			capture,
			0.8,
		)
		expect(both).toEqual({
			admitted: false,
			reasonCode: "channel-request-invalid",
			detail: "non-finite request",
		})
		const rate = admitChannel(
			{ ...base, outputRateHz: 3_000_000, centerHz: 170e6 },
			capture,
			0.8,
		)
		expect(rate).toEqual({
			admitted: false,
			reasonCode: "channel-request-invalid",
			detail:
				"bandwidth/transition must be > 0 and output rate within 1..=2048000",
		})
		const wide = admitChannel(
			{ ...base, bandwidthHz: 50_000, centerHz: 170e6 },
			capture,
			0.8,
		)
		expect(wide.admitted ? "admitted" : wide.reasonCode).toBe(
			"channel-request-invalid",
		)
	})

	it("treats the capture edge as inclusive and returns a signed offset", () => {
		// usable half-span = 2 048 000 × 0.8 / 2 = 819 200 Hz; h = 22 800 + 1 200 = 24 000 Hz.
		const edge = 819_200 - 24_000
		expect(
			admitChannel({ ...base, centerHz: 162e6 + edge }, capture, 0.8),
		).toEqual({ admitted: true, offsetHz: edge })
		expect(
			admitChannel({ ...base, centerHz: 162e6 - edge }, capture, 0.8),
		).toEqual({ admitted: true, offsetHz: -edge })
		const out = admitChannel(
			{ ...base, centerHz: 162e6 - edge - 1 },
			capture,
			0.8,
		)
		expect(out.admitted ? "admitted" : out.reasonCode).toBe(
			"channel-outside-capture",
		)
	})

	// Feature: core-channelizer, Property 2: Admission rule
	// Validates: addendum §6, §12.2
	it("admits iff both inequalities hold", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.constant(2_048_000),
					fc.constant(2_400_000),
					fc.integer({ min: 250_000, max: 3_200_000 }),
				),
				fc.double({ min: -1.5e6, max: 1.5e6, noNaN: true }),
				fc.integer({ min: 1_000, max: 1_050_000 }),
				fc.double({ min: 0.5, max: 0.99, noNaN: true }),
				fc.double({ min: 0.001, max: 0.2, noNaN: true }),
				(fs, offset, out, bwFrac, trFrac) => {
					fc.pre(out <= fs)
					const req = {
						centerHz: 100e6 + offset,
						bandwidthHz: out * bwFrac,
						transitionHz: out * trFrac,
						outputRateHz: out,
						format: "cu8" as const,
					}
					const v = admitChannel(
						req,
						{ sampleRateHz: fs, centerHz: 100e6 },
						0.8,
					)
					const half = req.bandwidthHz / 2 + req.transitionHz
					const fitsRate = half <= out / 2 + 1e-6
					const fits =
						fitsRate &&
						Math.abs(req.centerHz - 100e6) + half <= (fs * 0.8) / 2 + 1e-6
					expect(v.admitted).toBe(fits)
					if (v.admitted) expect(v.offsetHz).toBe(req.centerHz - 100e6)
					else
						expect(v.reasonCode).toBe(
							fitsRate ? "channel-outside-capture" : "channel-request-invalid",
						)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("channel admission reasons", () => {
	it("recognises exactly the three channel reasons", () => {
		expect(CHANNEL_ADMISSION_REASONS).toEqual([
			"channel-outside-capture",
			"channel-request-invalid",
			"channelizer-unavailable",
		])
		for (const r of CHANNEL_ADMISSION_REASONS)
			expect(isChannelAdmissionReason(r)).toBe(true)
		for (const r of ["insufficient-sample-rate", "frequency-out-of-band", ""])
			expect(isChannelAdmissionReason(r)).toBe(false)
	})
})
