import { it, expect } from "vitest"
import fc from "fast-check"
import { createIngestRecorder } from "../../../../src/core/link-burst/recorder.js"

// Feature: link-burst-resilience, Property 12: Report bounds (recorder half)
// Validates: Requirements 2.1, 6.3
it("reports only retained slots, bounded percentiles and distinct burst seconds", () => {
	fc.assert(
		fc.property(
			fc.array(
				fc.record({
					delta: fc.integer({ min: 0, max: 90000 }),
					bytes: fc.integer({ min: 1, max: 70000 }),
					holding: fc.boolean(),
				}),
				{ minLength: 1, maxLength: 200 },
			),
			arrivals => {
				const r = createIngestRecorder()
				let now = 0
				const gaps: { time: number; gap: number }[] = []
				const seconds = new Set<number>()
				for (const [i, a] of arrivals.entries()) {
					now += a.delta
					r.observeChunk(a.bytes, now)
					if (i > 0) gaps.push({ time: now, gap: a.delta })
					if ((i > 0 && a.delta >= 80) || a.holding)
						seconds.add(Math.floor(now / 1000))
					if (a.holding) r.noteHolding(now)
				}
				const retained = gaps
					.filter(
						g => Math.floor(g.time / 10000) > Math.floor(now / 10000) - 60,
					)
					.map(g => g.gap)
					.sort((a, b) => a - b)
				const w = r.window(now)
				expect(w.worstStallMs).toBe(
					retained.length ? retained[retained.length - 1] : null,
				)
				if (retained.length) {
					const p = retained[Math.ceil(retained.length * 0.99) - 1] ?? 0
					expect(w.gapP99Ms).toBeGreaterThanOrEqual(p)
					expect(w.gapP99Ms).toBeLessThanOrEqual(
						Math.max(1, p * 1.25, p >= 1.25 ** 46 ? (w.worstStallMs ?? 0) : 0),
					)
				}
				expect(w.burstSeconds).toBe(
					[...seconds].filter(s => s > Math.floor(now / 1000) - 600).length,
				)
			},
		),
		{ numRuns: 100 },
	)
})
