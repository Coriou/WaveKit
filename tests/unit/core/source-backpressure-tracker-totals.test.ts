import { afterEach, expect, it, vi } from "vitest"
import { SourceBackpressureTracker } from "../../../src/core/source-backpressure-tracker.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { SdrHostPoller } from "../../../src/core/sdr-host-poller.js"
import { createLogger } from "../../../src/utils/logger.js"

const setup = () => {
	let total = 0
	let available = true
	const poller = {
		getStatus: () => ({
			available,
			rtlmux: {
				clients: 1,
				bytesPerSec: 100,
				totalBytesSent: 1000,
				clientDetails: [{ id: 1, address: "fake:1", bytesDropped: total }],
			},
		}),
	} as unknown as SdrHostPoller
	const sources = {
		getAllStatus: () => [{ id: "s" }],
	} as unknown as SourceManager
	const tracker = new SourceBackpressureTracker(
		createLogger({ level: "error" }),
		sources,
		poller,
	)
	return {
		tracker,
		total: (n: number) => {
			total = n
		},
		unavailable: () => {
			available = false
		},
	}
}

afterEach(() => vi.useRealTimers())

it("reads current totals and rates without changing subsequent rate history", () => {
	vi.useFakeTimers()
	vi.setSystemTime(0)
	const h = setup()
	expect(h.tracker.upstreamDroppedTotal("s")).toBe(0)
	expect(h.tracker.peekDropRate("s")).toBe(0)
	h.tracker.getBackpressure("s")
	vi.setSystemTime(1000)
	h.total(100)
	for (let n = 0; n < 101; n++) {
		expect(h.tracker.upstreamDroppedTotal("s")).toBe(100)
		expect(h.tracker.peekDropRate("s")).toBe(100)
	}
	expect(h.tracker.getBackpressure("s")).toMatchObject({
		bytesDroppedUpstream: 100,
		dropRate: 100,
	})
	vi.setSystemTime(2000)
	h.total(100)
	expect(h.tracker.getBackpressure("s").dropRate).toBe(50)
})

it("reads respect the rate window at its boundary and one past", () => {
	vi.useFakeTimers()
	vi.setSystemTime(0)
	const h = setup()
	h.tracker.getBackpressure("s")
	h.total(100)
	vi.setSystemTime(5000)
	expect(h.tracker.peekDropRate("s")).toBe(20)
	vi.setSystemTime(5001)
	expect(h.tracker.peekDropRate("s")).toBe(0)
})

it("unavailable, malformed and throwing totals fail closed", () => {
	const h = setup()
	for (const n of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
		h.total(n)
		expect(h.tracker.upstreamDroppedTotal("s")).toBeNull()
		expect(h.tracker.peekDropRate("s")).toBeNull()
	}
	h.unavailable()
	expect(h.tracker.upstreamDroppedTotal("s")).toBeNull()
	expect(h.tracker.peekDropRate("s")).toBeNull()
	const tracker = new SourceBackpressureTracker(
		createLogger({ level: "error" }),
		{ getAllStatus: () => [] } as unknown as SourceManager,
		{
			getStatus() {
				throw new TypeError("unavailable")
			},
		} as unknown as SdrHostPoller,
	)
	expect(tracker.upstreamDroppedTotal("s")).toBeNull()
	expect(tracker.peekDropRate("s")).toBeNull()
})

it("projects the same bounded history at 100 records and one past", () => {
	vi.useFakeTimers()
	const h = setup()
	for (let n = 0; n <= 101; n++) {
		vi.setSystemTime(n)
		h.total(n * n)
		const projected = h.tracker.peekDropRate("s")
		expect(h.tracker.getBackpressure("s").dropRate).toBe(projected)
	}
})
