import { describe, expect, it } from "vitest"
import {
	concatIq,
	impulseTrain,
	meanPower,
	mulberry32,
	toneComb,
} from "../../../mocks/scanner/signals.js"

const FS = 256_000

describe("artefact generators", () => {
	it("impulseTrain repeats one multitone burst of widthMs every periodMs from phaseMs", () => {
		const amp = 0.01
		const iq = impulseTrain(mulberry32(1), FS / 2, FS, {
			periodMs: 100,
			widthMs: 2,
			toneSpacingHz: 1000,
			occupiedFraction: 0.9,
			toneAmp: amp,
			phaseMs: 10,
		})
		const tones = 2 * Math.floor((0.9 * FS) / (2 * 1000)) + 1 // 231 tones, one per 1 kHz bin over 90 % of the band
		const w = (2 * FS) / 1000
		for (let k = 0; k < 5; k++) {
			const start = ((10 + 100 * k) * FS) / 1000
			expect(meanPower(iq, start, start + w) / (tones * amp * amp)).toBeCloseTo(
				1,
				2,
			) // orthogonal tones over the burst
			expect(meanPower(iq, start + w, start + w + 1000)).toBe(0)
		}
		expect(meanPower(iq, 0, (10 * FS) / 1000)).toBe(0)
	})

	it("toneComb is phase-continuous across calls at absolute sample indices", () => {
		const teeth = [-30_000, 5_250, 41_700]
		const amps = [0.1, 0.05, 0.2]
		const whole = toneComb(10_000, FS, teeth, amps)
		const parts = concatIq([
			toneComb(4_000, FS, teeth, amps, 0),
			toneComb(6_000, FS, teeth, amps, 4_000),
		])
		for (let i = 0; i < 10_000; i += 97) {
			expect(parts.re[i]).toBeCloseTo(whole.re[i] ?? Number.NaN, 6)
			expect(parts.im[i]).toBeCloseTo(whole.im[i] ?? Number.NaN, 6)
		}
		expect(meanPower(whole)).toBeCloseTo(0.01 + 0.0025 + 0.04, 2)
	})
})
