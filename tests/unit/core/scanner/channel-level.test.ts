import { describe, it, expect } from "vitest"
import {
	ChannelNoiseTracker,
	meanPowerDbfs,
	noiseFromActiveDbfs,
	squelchThresholdDbfs,
} from "../../../../src/core/scanner/channel/channel-level.js"

describe("channel levels", () => {
	it("measures complex power and floors empty or silent input", () => {
		expect(meanPowerDbfs(new Float32Array([1, 0, 0, 1]))).toBe(0)
		expect(meanPowerDbfs(new Float32Array([0.5, 0]))).toBeCloseTo(-6.0206)
		expect(Number.isFinite(meanPowerDbfs(new Float32Array()))).toBe(true)
		expect(meanPowerDbfs(new Float32Array([0, 0]))).toBe(
			meanPowerDbfs(new Float32Array()),
		)
	})
	it("converts total power and SNR to noise and threshold", () => {
		expect(noiseFromActiveDbfs(-20, 0)).toBeCloseTo(-23.0103)
		expect(noiseFromActiveDbfs(-20, 10)).toBeCloseTo(-30.4139)
		expect(noiseFromActiveDbfs(-20, 10000)).toBe(-10020)
		expect(noiseFromActiveDbfs(-20, -10000)).toBe(-20)
		expect(squelchThresholdDbfs(-40, 6)).toBe(-34)
	})
	it("tracks closed noise, rejecting signal onset and open gates; resets", () => {
		const tracker = new ChannelNoiseTracker({ alpha: 0.5 })
		expect(tracker.noiseDbfs).toBeNull()
		tracker.update(-40, true)
		expect(tracker.noiseDbfs).toBeNull()
		tracker.update(-40, false)
		tracker.update(-30, false)
		tracker.update(-50, true)
		expect(tracker.noiseDbfs).toBe(-40)
		tracker.update(-42, false)
		expect(tracker.noiseDbfs).toBe(-41)
		tracker.seed(-60)
		expect(tracker.noiseDbfs).toBe(-60)
		tracker.reset()
		expect(tracker.noiseDbfs).toBeNull()
	})
	it("rejects nonfinite input and invalid alpha", () => {
		for (const alpha of [0, -1, 1.1, NaN])
			expect(() => new ChannelNoiseTracker({ alpha })).toThrow()
		const tracker = new ChannelNoiseTracker()
		expect(() => tracker.seed(NaN)).toThrow()
		expect(() => tracker.update(Infinity, true)).toThrow()
		expect(() => meanPowerDbfs(new Float32Array([1]))).toThrow()
		expect(() => meanPowerDbfs(new Float32Array([NaN, 0]))).toThrow()
		expect(() => noiseFromActiveDbfs(0, NaN)).toThrow()
		expect(() => squelchThresholdDbfs(0, Infinity)).toThrow()
	})
})
