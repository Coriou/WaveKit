import { describe, expect, it } from "vitest"

import {
	RETUNE_SWEEP_BOOKMARK,
	RETUNE_SWEEP_DISCOVERY_SPECS,
	RETUNE_SWEEP_PARK,
	RETUNE_SWEEP_PARKED_SIGNALS,
	RETUNE_SWEEP_SIGNALS,
	RETUNE_SWEEP_STEPS,
} from "../../mock/retune-sweep.ts"
import { synthFrame } from "../../mock/spectrum.ts"

describe("retune sweep scenario", () => {
	const park = synthFrame({
		sourceId: "s",
		centerHz: RETUNE_SWEEP_PARK.hz,
		bins: 1024,
		hz: 10,
		epoch: 1,
		nowMs: 0,
		sampleRateHz: RETUNE_SWEEP_PARK.sampleRateHz,
		signals: RETUNE_SWEEP_SIGNALS,
		random: () => 0.5,
	})
	const lo = park.startHz
	const hi = park.startHz + park.binCount * park.binHz

	it("parks at 431.078 MHz, 1.024 MS/s, after the multi-band sequence", () => {
		expect(RETUNE_SWEEP_STEPS.length).toBeGreaterThan(10)
		expect(RETUNE_SWEEP_PARK).toEqual({
			hz: 431_078_000,
			sampleRateHz: 1_024_000,
		})
		expect(park.sampleRateHz).toBe(1_024_000)
		expect(hi - lo).toBeLessThan(1_024_000)
	})

	it("has only the four parked signals, and no discovery or bookmark, in the parked span", () => {
		expect(park.tracks).toHaveLength(RETUNE_SWEEP_PARKED_SIGNALS.length)
		const others = RETUNE_SWEEP_SIGNALS.filter(
			s => !RETUNE_SWEEP_PARKED_SIGNALS.includes(s),
		)
		expect(others.some(s => s.hz >= lo && s.hz <= hi)).toBe(false)
		expect(
			RETUNE_SWEEP_DISCOVERY_SPECS.some(
				d => d.mhz * 1e6 >= lo && d.mhz * 1e6 <= hi,
			),
		).toBe(false)
		expect(RETUNE_SWEEP_BOOKMARK.frequencyHz < lo).toBe(true)
	})
})
