import { it, expect, vi } from "vitest"
import { createEventLoopMeter } from "../../../../src/core/link-burst/loop-meter.js"

function setup() {
	let now = 0
	const histogram = {
		max: 30e6,
		count: 1,
		percentile: vi.fn(() => 12e6),
		reset: vi.fn(),
		enable: vi.fn(),
		disable: vi.fn(),
	}
	const meter = createEventLoopMeter({ histogram, monoNow: () => now })
	return {
		histogram,
		meter,
		setNow: (value: number) => {
			now = value
		},
	}
}
it("converts nanoseconds and resets the histogram", () => {
	const { histogram, meter } = setup()
	expect(meter.takeInterval()).toEqual({ maxMs: 30, p99Ms: 12 })
	expect(histogram.reset).toHaveBeenCalledOnce()
	expect(histogram.enable).toHaveBeenCalledOnce()
	meter.dispose()
	meter.dispose()
	expect(histogram.disable).toHaveBeenCalledOnce()
})
it("count zero returns null and resets", () => {
	const { histogram, meter } = setup()
	histogram.count = 0
	expect(meter.takeInterval()).toBeNull()
	expect(histogram.reset).toHaveBeenCalledOnce()
	expect(meter.report(0).intervals10m).toBe(0)
})
it("report never resets the histogram", () => {
	const { histogram, meter, setNow } = setup()
	const first = meter.takeInterval()
	expect(meter.report(0).last).toEqual(first)
	setNow(1000)
	histogram.max = 5e6
	histogram.percentile.mockReturnValue(2e6)
	meter.takeInterval()
	expect(meter.report(600001)).toEqual({
		last: { maxMs: 5, p99Ms: 2 },
		maxMs10m: 5,
		p99MaxMs10m: 2,
		intervals10m: 1,
	})
	meter.report(700000)
	expect(histogram.reset).toHaveBeenCalledTimes(2)
})
it("retains at most 300 intervals", () => {
	const { meter, setNow } = setup()
	for (let i = 0; i < 301; i++) {
		setNow(i)
		meter.takeInterval()
	}
	expect(meter.report(301).intervals10m).toBe(300)
})
