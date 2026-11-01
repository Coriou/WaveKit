/**
 * Hot-path log helpers: LogRateLimiter (one line per key per interval, with the suppressed count)
 * and CountSummary (one info line per interval with counts per key).
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import * as fc from "fast-check"
import type { Logger } from "../../../src/utils/logger.js"
import {
	CountSummary,
	LOG_MAX_KEYS,
	LOG_SUMMARY_INTERVAL_MS,
	LogRateLimiter,
} from "../../../src/utils/logger.js"

describe("LogRateLimiter", () => {
	it("states its bounds: one minute, 1,000 keys", () => {
		expect(LOG_SUMMARY_INTERVAL_MS).toBe(60_000)
		expect(LOG_MAX_KEYS).toBe(1_000)
	})

	it("allows one line per key per interval and reports what it suppressed", () => {
		let now = 0
		const limiter = new LogRateLimiter({ intervalMs: 1000, now: () => now })
		expect(limiter.take("a")).toBe(0)
		expect(limiter.take("a")).toBeNull()
		expect(limiter.take("b")).toBe(0) // keys are independent
		now = 999 // just inside the interval
		expect(limiter.take("a")).toBeNull()
		now = 1000 // at the bound
		expect(limiter.take("a")).toBe(2)
		now = 1500
		expect(limiter.take("a")).toBeNull()
		now = 2001 // past the bound
		expect(limiter.take("a")).toBe(1)
	})

	it("remembers at most maxKeys keys and reclaims ended windows", () => {
		let now = 0
		const limiter = new LogRateLimiter({
			intervalMs: 1000,
			maxKeys: 2,
			now: () => now,
		})
		expect(limiter.take("a")).toBe(0)
		expect(limiter.take("b")).toBe(0) // at the bound
		expect(limiter.take("c")).toBeNull() // past it, every window still open
		now = 1000
		expect(limiter.take("c")).toBe(0) // ended windows are reclaimed
	})

	it("never allows more than one line per key per interval", () => {
		// Feature: wg19-longevity, Property 2: Rate-limited warnings
		// Validates: Requirement C.1 (rate-limit hot-path warnings)
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						dt: fc.integer({ min: 0, max: 400 }),
						key: fc.integer({ min: 0, max: 3 }),
					}),
					{ maxLength: 200 },
				),
				events => {
					let now = 0
					const limiter = new LogRateLimiter({
						intervalMs: 1000,
						now: () => now,
					})
					const last = new Map<number, number>()
					let offered = 0
					let reported = 0
					for (const e of events) {
						now += e.dt
						offered += 1
						const suppressed = limiter.take(String(e.key))
						if (suppressed === null) continue
						const prev = last.get(e.key)
						if (prev !== undefined)
							expect(now - prev).toBeGreaterThanOrEqual(1000)
						last.set(e.key, now)
						reported += 1 + suppressed
					}
					// every offer is either a line or counted in a later line's `suppressed`
					expect(reported).toBeLessThanOrEqual(offered)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("CountSummary", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	function fakeLog() {
		const info = vi.fn()
		return { log: { info } as unknown as Logger, info }
	}

	it("logs one info line per interval with the counts, and nothing when idle", () => {
		vi.useFakeTimers()
		const { log, info } = fakeLog()
		const summary = new CountSummary(log, "Outputs", { intervalMs: 60_000 })
		summary.add("readsb")
		summary.add("readsb")
		summary.add("ais")
		vi.advanceTimersByTime(59_999)
		expect(info).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(info).toHaveBeenCalledWith(
			{ counts: { readsb: 2, ais: 1 }, total: 3 },
			"Outputs",
		)
		vi.advanceTimersByTime(60_000)
		expect(info).toHaveBeenCalledTimes(1)
		summary.stop()
		summary.add("readsb")
		vi.advanceTimersByTime(120_000)
		expect(info).toHaveBeenCalledTimes(1)
	})

	it("counts keys past maxKeys under other", () => {
		const { log, info } = fakeLog()
		const summary = new CountSummary(log, "Outputs", { maxKeys: 2 })
		summary.add("a")
		summary.add("b") // at the bound
		summary.add("c") // past it
		summary.add("a")
		summary.flush()
		summary.stop()
		expect(info).toHaveBeenCalledWith(
			{ counts: { a: 2, b: 1 }, other: 1, total: 4 },
			"Outputs",
		)
	})
})
