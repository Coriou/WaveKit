import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { JobHits } from "../../../../src/core/scanner/job-hits.js"

const T0 = Date.parse("2026-10-13T12:00:00.000Z")

describe("JobHits.ended (WG6 req 2)", () => {
	it("view emits lastDurationMs null until an observation ended", () => {
		const h = new JobHits("j_1")
		h.record("o1", "d_a", T0, true)
		expect(h.entry("d_a")?.lastDurationMs).toBeNull()
		expect(h.list(5)[0]).toHaveProperty("lastDurationMs", null)
	})

	it("sets the rounded duration for the entry's latest credit", () => {
		const h = new JobHits("j_1")
		h.record("o1", "d_a", T0, true)
		h.ended("o1", "d_a", 1234.6)
		expect(h.entry("d_a")?.lastDurationMs).toBe(1235)
		h.record("o2", "d_a", T0 + 1, false)
		h.ended("o2", "d_a", 0)
		expect(h.entry("d_a")?.lastDurationMs).toBe(0)
	})

	it("keeps the previous duration after a newer credit until it ends", () => {
		const h = new JobHits("j_1")
		h.record("o1", "d_a", T0, true)
		h.ended("o1", "d_a", 500)
		h.record("o2", "d_a", T0 + 1, false)
		expect(h.entry("d_a")?.lastDurationMs).toBe(500)
		h.ended("o1", "d_a", 900)
		expect(h.entry("d_a")?.lastDurationMs).toBe(500)
		h.ended("o2", "d_a", 700)
		expect(h.entry("d_a")?.lastDurationMs).toBe(700)
	})

	it("ignores unknown entries and invalid durations", () => {
		const h = new JobHits("j_1")
		h.ended("o1", "d_x", 100)
		expect(h.entry("d_x")).toBeUndefined()
		h.record("o1", "d_a", T0, true)
		for (const bad of [-1, Number.NaN, Infinity, -Infinity])
			h.ended("o1", "d_a", bad)
		expect(h.entry("d_a")?.lastDurationMs).toBeNull()
	})

	it("ignores ended for an evicted entry", () => {
		const h = new JobHits("j_1", 1)
		h.record("o1", "d_a", T0, true)
		h.record("o2", "d_b", T0, true)
		h.ended("o2", "d_b", 10)
		expect(h.entry("d_b")).toBeUndefined()
		expect(h.entry("d_a")?.lastDurationMs).toBeNull()
	})

	// Feature: web-gaps-6, Property 5: Hit duration
	// Validates: Requirements 2.1, 2.2
	it("matches a simple model over random record/ended sequences", () => {
		const op = fc.oneof(
			fc.record({
				k: fc.constant("r" as const),
				d: fc.integer({ min: 0, max: 3 }),
			}),
			fc.record({
				k: fc.constant("e" as const),
				o: fc.integer({ min: 0, max: 30 }),
				d: fc.integer({ min: 0, max: 3 }),
				ms: fc.oneof(
					fc.double({ min: -50, max: 5000, noNaN: true }),
					fc.constant(Number.NaN),
					fc.constant(Infinity),
				),
			}),
		)
		fc.assert(
			fc.property(fc.array(op, { maxLength: 60 }), ops => {
				const h = new JobHits("j_1")
				const last = new Map<number, number>()
				const dur = new Map<number, number | null>()
				let seq = 0
				for (const o of ops) {
					if (o.k === "r") {
						const id = seq++
						h.record(`o${id}`, `d${o.d}`, T0 + id, false)
						last.set(o.d, id)
						if (!dur.has(o.d)) dur.set(o.d, null)
					} else {
						h.ended(`o${o.o}`, `d${o.d}`, o.ms)
						if (last.get(o.d) === o.o && Number.isFinite(o.ms) && o.ms >= 0)
							dur.set(o.d, Math.round(o.ms))
					}
				}
				for (const [d, v] of dur)
					expect(h.entry(`d${d}`)?.lastDurationMs).toBe(v)
			}),
			{ numRuns: 200 },
		)
	})
})
