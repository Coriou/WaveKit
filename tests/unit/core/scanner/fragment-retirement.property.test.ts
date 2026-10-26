import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	FRAGMENT_RETIRE_AGE_MS,
	FRAGMENT_RETIRE_MAX_SIGHTINGS,
} from "../../../../src/core/scanner/store/fragment-retirement.js"
import {
	HOUR,
	T0,
	ch,
	fragmentStore,
	sightings,
} from "./fragment-retirement-fixtures.js"
import type { FragmentSpec } from "./fragment-retirement-fixtures.js"

const specArb = (i: number): fc.Arbitrary<FragmentSpec> =>
	fc
		.record({
			channel: fc.integer({ min: 0, max: 3 }),
			offset: fc.integer({ min: -6_000, max: 6_000 }),
			count: fc.integer({ min: 1, max: 6 }),
			obwHz: fc.constantFrom(4000, 8000, 12_000),
			peakDbfs: fc.constantFrom(-50, -45, 0),
			protection: fc.constantFrom(
				"none",
				"none",
				"none",
				"label",
				"lockout",
				"decoded",
				"recording",
			),
			ageHours: fc.integer({ min: 0, max: 200 }),
		})
		.map(r => {
			const lastSeenMs = T0 - r.ageHours * HOUR
			const spec: FragmentSpec = {
				id: `d_${String(i).padStart(3, "0")}`,
				centreHz: ch(r.channel) + r.offset,
				count: r.count,
				obwHz: r.obwHz,
				peakDbfs: r.peakDbfs,
				firstSeenMs: lastSeenMs - r.count * 1000,
				lastSeenMs,
			}
			if (r.protection === "label") spec.operator = { label: "x" }
			if (r.protection === "lockout") spec.operator = { lockout: true }
			if (r.protection === "decoded") spec.decoded = true
			if (r.protection === "recording") spec.recordings = 1
			return spec
		})

const storeArb = fc
	.integer({ min: 1, max: 24 })
	.chain(n => fc.tuple(...Array.from({ length: n }, (_, i) => specArb(i))))

const isProtected = (s: FragmentSpec): boolean =>
	s.operator !== undefined || s.decoded === true || (s.recordings ?? 0) > 0

describe("fragment retirement properties", () => {
	// Feature: detection-quality, Property 28: Fragment retirement keeps protected records and sightings
	// Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5
	it("labelled and decoded records always survive; sightings are preserved; passes reach a fixpoint", () => {
		fc.assert(
			fc.property(storeArb, specs => {
				const { store } = fragmentStore(specs, { nowMs: T0 })
				const total = sightings(store)
				let retiredSightings = 0
				for (let pass = 0; pass < 4; pass++) {
					const counts = new Map(
						store
							.snapshot()
							.discoveries.map(d => [d.id, d.observationCount] as const),
					)
					const r = store.retireFragments()
					for (const id of r.retired) {
						const n = counts.get(id) ?? 0
						expect(n).toBeLessThanOrEqual(FRAGMENT_RETIRE_MAX_SIGHTINGS)
						retiredSightings += n
					}
					for (const m of r.merges)
						for (const id of m.mergedIds)
							expect(store.survivorOf(id)).toBe(m.survivor)
				}
				for (const s of specs) {
					if (isProtected(s)) expect(store.get(s.id), s.id).toBeDefined()
				}
				expect(sightings(store) + retiredSightings).toBe(total)
				// Idempotent at the fixpoint.
				const snap = store.snapshot()
				const again = store.retireFragments()
				expect(again.groups + again.retired.length).toBe(0)
				expect(store.snapshot()).toEqual(snap)
				// Nothing retired before the stated age.
				for (const s of specs)
					if (
						s.lastSeenMs !== undefined &&
						T0 - s.lastSeenMs < FRAGMENT_RETIRE_AGE_MS
					)
						expect(store.get(s.id) ?? store.survivorOf(s.id)).toBeDefined()
			}),
			{ numRuns: 100 },
		)
	})
})
