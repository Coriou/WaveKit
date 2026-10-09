/**
 * Shared CSDR stage builders: channel-matched decimation filter, frequency
 * shift and crash-free de-emphasis.
 */

import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import {
	channelDecimationStage,
	channelFilterPlan,
	deemphasisStage,
	shiftStage,
	validateChannelOffset,
} from "../../../src/decoders/csdr-stages.js"
import { firDecimateMinimumElements } from "../../../src/decoders/csdr-buffers.js"

describe("channelFilterPlan", () => {
	it("matches a 12.5 kHz channel at 2.048 Msps / 82", () => {
		const plan = channelFilterPlan(2_048_000, 82, 12_500)
		expect(plan.passbandHz).toBe(6250)
		expect(plan.stopbandHz).toBeCloseTo(2_048_000 / 82 / 2, 6)
		// About 6.2 kHz wide instead of the old 102 kHz (0.05 x 2.048 Msps).
		expect(plan.transition * 2_048_000).toBeCloseTo(6238, 0)
		expect(plan.taps).toBeGreaterThan(1200)
		expect(plan.taps).toBeLessThan(1400)
	})

	it("rejects the adjacent channel for dsd-fme at 48 kHz demod", () => {
		const plan = channelFilterPlan(2_048_000, 43, 12_500)
		expect(plan.passbandHz).toBe(6250)
		expect(plan.stopbandHz).toBe(12_500)
		expect(plan.cutoff).toBeCloseTo(9375 / (2_048_000 / 43), 4)
	})

	it("keeps nearly the whole output band in nyquist mode (SSB, raw)", () => {
		const plan = channelFilterPlan(2_048_000, 427, 2400, "nyquist")
		const nyquist = 2_048_000 / 427 / 2
		expect(plan.cutoff).toBeCloseTo(0.5, 6)
		expect(plan.passbandHz).toBeCloseTo(nyquist * 0.85, 6)
		expect(channelDecimationStage(2_048_000, 427, 2400, "nyquist")).toBe(
			"csdr firdecimate 427 0.000351 --cutoff 0.5000",
		)
	})

	it("builds the exact firdecimate stage", () => {
		expect(channelDecimationStage(2_048_000, 82, 12_500)).toBe(
			"csdr firdecimate 82 0.003046 --cutoff 0.3751",
		)
		expect(channelDecimationStage(2_400_000, 96, 12_500)).toBe(
			"csdr firdecimate 96 0.002604 --cutoff 0.3750",
		)
	})

	it("keeps the ring minimum within the default bounded ring for any channel", () => {
		// Feature: live-analog-fixes, Property 1: matched filters fit bounded rings
		fc.assert(
			fc.property(
				fc.integer({ min: 900_000, max: 3_200_000 }),
				fc.oneof(fc.constant(0), fc.integer({ min: 500, max: 200_000 })),
				fc.constantFrom("channel" as const, "nyquist" as const),
				(inputRate, configured, mode) => {
					// Same rate plan as the live demodulator (0 = raw, half the capture).
					const bandwidth = configured > 0 ? configured : inputRate / 2
					const nyquistRate = Math.max(1, bandwidth * 2)
					const decimation = Math.max(1, Math.round(inputRate / nyquistRate))
					const plan = channelFilterPlan(inputRate, decimation, bandwidth, mode)
					const minimum = firDecimateMinimumElements(
						decimation,
						plan.transition,
					)
					expect(minimum).not.toBeNull()
					expect(minimum!).toBeLessThanOrEqual(65_536)
					expect(plan.passbandHz).toBeLessThan(plan.stopbandHz)
					expect(plan.cutoff).toBeGreaterThan(0)
					expect(plan.cutoff).toBeLessThanOrEqual(0.5)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("shiftStage", () => {
	it("is omitted at zero offset", () => {
		expect(shiftStage(0, 2_048_000)).toBeNull()
	})

	it("moves a carrier at +offset down to DC", () => {
		expect(shiftStage(6000, 2_048_000)).toBe("csdr shift -0.0029296875")
		expect(shiftStage(-12_000, 2_400_000)).toBe("csdr shift 0.0050000000")
	})

	it("validates that the channel stays inside the capture", () => {
		expect(() => validateChannelOffset(6000, 2_048_000, 12_500)).not.toThrow()
		expect(() => validateChannelOffset(1_020_000, 2_048_000, 12_500)).toThrow(
			/offsetHz/,
		)
		expect(() => validateChannelOffset(Number.NaN, 2_048_000, 12_500)).toThrow(
			/offsetHz/,
		)
	})
})

describe("deemphasisStage", () => {
	it("uses the predefined NFM filter only at supported integer rates", () => {
		expect(deemphasisStage("nfm", 48_000)).toEqual({
			stage: "csdr deemphasis --nfm 48000",
			approximated: false,
		})
		expect(deemphasisStage("nfm", 12_000)).toEqual({
			stage: "csdr deemphasis --nfm 12000",
			approximated: false,
		})
	})

	it("never passes a non-integer or unsupported rate to the NFM filter", () => {
		expect(deemphasisStage("nfm", 2_048_000 / 82)).toEqual({
			stage: "csdr deemphasis --wfm 24976 0.00075",
			approximated: true,
		})
		expect(deemphasisStage("nfm", 25_000)).toEqual({
			stage: "csdr deemphasis --wfm 25000 0.00075",
			approximated: true,
		})
	})

	it("rounds the WFM rate and keeps the configured tau", () => {
		expect(deemphasisStage("wfm", 2_048_000 / 7, 50)).toEqual({
			stage: "csdr deemphasis --wfm 292571 0.00005",
			approximated: false,
		})
		expect(deemphasisStage("wfm", 240_000, 75).stage).toBe(
			"csdr deemphasis --wfm 240000 0.000075",
		)
	})

	it("only ever emits integer sample rates", () => {
		// Feature: live-analog-fixes, Property 2: de-emphasis never gets a fractional rate
		fc.assert(
			fc.property(
				fc.constantFrom("nfm" as const, "wfm" as const),
				fc.double({ min: 1000, max: 3_200_000, noNaN: true }),
				(kind, rate) => {
					const { stage } = deemphasisStage(kind, rate, 50)
					const rateToken = stage.split(" ")[3]
					expect(rateToken).toMatch(/^[0-9]+$/)
					if (stage.includes("--nfm")) {
						expect([8000, 11025, 12000, 44100, 48000]).toContain(
							Number(rateToken),
						)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
