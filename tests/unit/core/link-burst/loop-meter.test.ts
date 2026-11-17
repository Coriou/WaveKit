import { describe, it, expect, vi } from "vitest"
import { ELU_BASE_STALE_MS } from "../../../../src/core/link-burst/contract.js"
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

describe("window reads", () => {
	function windowed() {
		let now = 0
		let reading = { idle: 0, active: 0 }
		const histogram = {
			max: 0,
			count: 0,
			percentile: vi.fn(() => 0),
			reset: vi.fn(),
			enable: vi.fn(),
			disable: vi.fn(),
		}
		const meter = createEventLoopMeter({
			histogram,
			monoNow: () => now,
			elu: () => reading,
		})
		return {
			histogram,
			meter,
			/** Advance `ms` with `busy` of it active, then take the interval. */
			take(ms: number, busy: number, maxMs: number) {
				now += ms
				reading = {
					idle: reading.idle + ms - busy,
					active: reading.active + busy,
				}
				histogram.max = maxMs * 1e6
				histogram.count = 1
				meter.takeInterval()
				histogram.max = 0
				histogram.count = 0
			},
			live(ms: number, busy: number, maxMs: number) {
				now += ms
				reading = {
					idle: reading.idle + ms - busy,
					active: reading.active + busy,
				}
				histogram.max = maxMs * 1e6
				histogram.count = 1
			},
			get now() {
				return now
			},
		}
	}
	it("maxSince covers taken intervals at or after the start and the live histogram", () => {
		const w = windowed()
		w.take(2000, 0, 300)
		const start = w.now
		w.take(2000, 0, 40)
		expect(w.meter.maxSince(start)).toBe(300)
		expect(w.meter.maxSince(start + 1)).toBe(40)
		w.live(1000, 0, 2400)
		expect(w.meter.maxSince(start + 1)).toBe(2400)
		// Reading never resets the in-progress interval.
		expect(w.histogram.reset).toHaveBeenCalledTimes(2)
		expect(w.meter.maxSince(w.now + 1)).toBe(2400)
	})
	it("maxSince is null with no sample", () => {
		const w = windowed()
		expect(w.meter.maxSince(0)).toBeNull()
	})
	it("utilizationSince measures from the newest reading at or before the start", () => {
		const w = windowed()
		w.take(2000, 2000, 0) // fully busy before the window
		const start = w.now
		for (let i = 0; i < 4; i++) w.take(2000, 1800, 0)
		w.live(2000, 1800, 0)
		expect(w.meter.utilizationSince(start)).toBeCloseTo(0.9, 9)
		expect(w.meter.utilizationSince(start - 1)).toBeNull()
	})
	it("utilizationSince is null before history covers the start, or past the stale bound", () => {
		const w = windowed()
		expect(w.meter.utilizationSince(0)).toBeNull()
		w.take(2000, 1000, 0)
		w.live(1000, 500, 0)
		expect(w.meter.utilizationSince(1999)).toBeNull()
		expect(w.meter.utilizationSince(2000)).not.toBeNull()
		// ELU_BASE_STALE_MS = 6000: a base exactly 6 s before the start is used, older is not.
		expect(w.meter.utilizationSince(2000 + ELU_BASE_STALE_MS)).not.toBeNull()
		expect(w.meter.utilizationSince(2001 + ELU_BASE_STALE_MS)).toBeNull()
	})
	it("utilizationMaxSince reads the worst take in the window and the guard take before it", () => {
		const w = windowed()
		w.take(2000, 0, 0) // first reading: no base, so no take
		w.take(2000, 1960, 0) // 0.98, ends at 4000: the guard take of a window from 4001
		w.take(2000, 600, 0) // 0.30, straddles the window start
		w.take(2000, 800, 0) // 0.40
		expect(w.meter.utilizationMaxSince(4001)).toEqual({
			max: expect.closeTo(0.98, 9) as number,
			complete: true,
			live: null,
		})
		// From 6001 the guard take is the 0.30 one.
		expect(w.meter.utilizationMaxSince(6001).max).toBeCloseTo(0.4, 9)
		// The in-progress take is read only once at least 500 ms long.
		w.live(499, 499, 0)
		expect(w.meter.utilizationMaxSince(6001).live).toBeNull()
		w.live(1, 1, 0)
		expect(w.meter.utilizationMaxSince(6001).live).toBe(1)
		// It never raises the worst take.
		expect(w.meter.utilizationMaxSince(6001).max).toBeCloseTo(0.4, 9)
	})
	it("utilizationMaxSince has no take for the first reading, and no guard without a base", () => {
		const w = windowed()
		w.take(2000, 2000, 0)
		expect(w.meter.utilizationMaxSince(0)).toEqual({
			max: null,
			complete: false,
			live: null,
		})
		w.take(2000, 1000, 0)
		// The guard take (the first reading) has no base: read, but incomplete.
		expect(w.meter.utilizationMaxSince(2001)).toEqual({
			max: 0.5,
			complete: false,
			live: null,
		})
		w.take(2000, 1000, 0)
		expect(w.meter.utilizationMaxSince(4001).complete).toBe(true)
	})
	it("utilizationMaxSince is incomplete across a reading gap or a stopped monitor, and drops old takes", () => {
		const w = windowed()
		for (let i = 0; i < 4; i++) w.take(2000, 1000, 0)
		w.take(ELU_BASE_STALE_MS + 1, 0, 0)
		w.take(2000, 0, 0)
		expect(w.meter.utilizationMaxSince(w.now - 2000).complete).toBe(false)
		const s = windowed()
		for (let i = 0; i < 4; i++) s.take(2000, 1960, 0)
		s.live(ELU_BASE_STALE_MS, 0, 0)
		expect(s.meter.utilizationMaxSince(s.now - 7000).complete).toBe(true)
		s.live(1, 0, 0)
		expect(s.meter.utilizationMaxSince(s.now - 7000).complete).toBe(false)
		// With no take ending in the window, no take (not even the guard) is evidence.
		expect(s.meter.utilizationMaxSince(s.now - 5000).max).toBeNull()
	})
	it("maxSince reads null once no interval was taken for longer than the stale bound", () => {
		const w = windowed()
		w.take(2000, 0, 300)
		w.live(ELU_BASE_STALE_MS, 0, 40)
		expect(w.meter.maxSince(0)).toBe(300)
		w.live(1, 0, 40)
		expect(w.meter.maxSince(0)).toBeNull()
	})
	it("a throwing ELU source records nothing and reads null", () => {
		const meter = createEventLoopMeter({
			histogram: {
				max: 0,
				count: 0,
				percentile: () => 0,
				reset: () => undefined,
				enable: () => undefined,
				disable: () => undefined,
			},
			monoNow: () => 0,
			elu: () => {
				throw new Error("unavailable")
			},
		})
		meter.takeInterval()
		expect(meter.utilizationSince(0)).toBeNull()
	})
})
