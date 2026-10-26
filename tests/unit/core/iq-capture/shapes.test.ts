import { describe, expect, it } from "vitest"
import {
	IQ_REPLAY_MIN_TRANSITION_HZ,
	probeReplayShapes,
	wholeCaptureShape,
} from "../../../../src/core/iq-capture/shapes.js"
import { captureBandwidthHz } from "../../../../src/core/iq-capture/service.js"
import { IQ_CAPTURE_RATE_HZ } from "../../../../src/core/scanner/iq-capture-contract.js"

/** `wavekit-iqcap replay` accepts bandwidth / 2 + transition ≤ 24 kHz with transition ≥ 100 Hz. */
const toolAccepts = (s: { bandwidthHz: number; transitionHz: number }) =>
	s.transitionHz >= IQ_REPLAY_MIN_TRANSITION_HZ &&
	s.bandwidthHz / 2 + s.transitionHz <= IQ_CAPTURE_RATE_HZ / 2

describe("replay shapes", () => {
	it("rtl433 replays the whole capture passband: the widest probe passband up to Nyquist", () => {
		const shapes = probeReplayShapes()
		const bw = captureBandwidthHz(shapes)
		expect(shapes.rtl433).toEqual({
			bandwidthHz: bw,
			transitionHz: (IQ_CAPTURE_RATE_HZ - bw) / 2,
		})
		expect(toolAccepts(shapes.rtl433!)).toBe(true)
		// the rtl433 shape never widens the capture itself
		expect(captureBandwidthHz(shapes)).toBe(
			Math.max(
				shapes["dsd-fme"].bandwidthHz,
				shapes["multimon-ng"].bandwidthHz,
				shapes.direwolf.bandwidthHz,
			),
		)
	})

	it("whole-capture shape at and past the minimum transition bound", () => {
		// at the bound: 47 800 Hz leaves exactly 100 Hz
		expect(wholeCaptureShape(47_800)).toEqual({
			bandwidthHz: 47_800,
			transitionHz: 100,
		})
		// past it: narrowed to keep the tool's minimum transition
		expect(wholeCaptureShape(47_801)).toEqual({
			bandwidthHz: 47_800,
			transitionHz: 100,
		})
		expect(wholeCaptureShape(1e9)).toEqual({
			bandwidthHz: 47_800,
			transitionHz: 100,
		})
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
			expect(wholeCaptureShape(bad)).toBeNull()
		for (const bw of [1, 1_000, 12_500, 47_424, 47_799, 47_800])
			expect(toolAccepts(wholeCaptureShape(bw)!)).toBe(true)
	})
})
