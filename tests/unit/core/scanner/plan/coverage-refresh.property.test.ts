// Feature: web-gaps-7, Property 12: Refresh bounds
// Validates: Requirements 7.1, 7.2
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { createCoverageRefresh } from "../../../../../src/core/scanner/plan/coverage-refresh.js"

function fakeClock() {
	let t = 0
	let seq = 0
	const timers = new Map<number, { at: number; fn: () => void }>()
	return {
		now: () => t,
		setTimer: (fn: () => void, ms: number): unknown => {
			const id = ++seq
			timers.set(id, { at: t + ms, fn })
			return id
		},
		clearTimer: (h: unknown): void => {
			timers.delete(h as number)
		},
		advance(ms: number): void {
			const end = t + ms
			for (;;) {
				let next: [number, { at: number; fn: () => void }] | undefined
				for (const e of timers) if (!next || e[1].at < next[1].at) next = e
				if (!next || next[1].at > end) break
				timers.delete(next[0])
				t = Math.max(t, next[1].at)
				next[1].fn()
			}
			t = end
		},
	}
}

describe("coverage refresh bounds (property 12)", () => {
	it("bounds refreshes and debounces every fire", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						gap: fc.integer({ min: 0, max: 5000 }),
						change: fc.boolean(),
					}),
					{ maxLength: 300 },
				),
				events => {
					const clock = fakeClock()
					let fp = 0
					let refreshes = 0
					let lastNotify = -Infinity
					let lastRefreshed = "none"
					const fires: number[] = []
					const refresh = createCoverageRefresh({
						...clock,
						fingerprint: () => {
							fires.push(clock.now())
							expect(clock.now() - lastNotify).toBeGreaterThanOrEqual(2000)
							return String(fp)
						},
						onRefresh: () => {
							refreshes++
							expect(String(fp)).not.toBe(lastRefreshed)
							lastRefreshed = String(fp)
						},
					})
					for (const e of events) {
						clock.advance(e.gap)
						if (e.change) fp++
						lastNotify = clock.now()
						refresh.notify()
					}
					const total = clock.now()
					clock.advance(100000)
					expect(refreshes).toBeLessThanOrEqual(Math.ceil(total / 30000) + 1)
					for (let i = 1; i < fires.length; i++)
						expect(
							(fires[i] ?? 0) - (fires[i - 1] ?? 0),
						).toBeGreaterThanOrEqual(30000)
				},
			),
			{ numRuns: 200 },
		)
	})
})
