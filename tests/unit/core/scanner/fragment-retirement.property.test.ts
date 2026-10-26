import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { FragmentPlan } from "../../../../src/core/scanner/store/fragment-retirement.js"
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
	it("labelled and decoded records always survive; sightings are preserved; one bound-free pass reaches the fixpoint", () => {
		fc.assert(
			fc.property(storeArb, specs => {
				const { store, entries } = fragmentStore(specs, { nowMs: T0 })
				const total = sightings(store)
				const counts = new Map(
					store
						.snapshot()
						.discoveries.map(d => [d.id, d.observationCount] as const),
				)
				const probe: { plan?: FragmentPlan } = {}
				const r = store.retireFragments(probe)
				// Replay the merges in order (a later round may absorb an earlier survivor).
				const cur = new Map(counts)
				for (const m of r.merges) {
					let n = cur.get(m.survivor) ?? 0
					for (const id of m.mergedIds) {
						n += cur.get(id) ?? 0
						cur.delete(id)
					}
					cur.set(m.survivor, n)
				}
				// Each absorbed id resolves to its final owner while that owner is live; an owner
				// retired in this pass takes its absorbed ids with it (like any delete).
				const owner = new Map<string, string>()
				for (const m of r.merges)
					for (const id of m.mergedIds) owner.set(id, m.survivor)
				const final = (id: string): string => {
					let x = id
					for (let o = owner.get(x); o !== undefined; o = owner.get(x)) x = o
					return x
				}
				for (const id of owner.keys()) {
					const f = final(id)
					if (store.get(f) !== undefined) expect(store.survivorOf(id)).toBe(f)
					else expect(r.retired).toContain(f)
				}
				let retiredSightings = 0
				for (const id of r.retired) {
					const n = cur.get(id) ?? 0
					expect(n).toBeLessThanOrEqual(FRAGMENT_RETIRE_MAX_SIGHTINGS)
					retiredSightings += n
				}
				for (const s of specs) {
					if (isProtected(s)) expect(store.get(s.id), s.id).toBeDefined()
				}
				expect(sightings(store) + retiredSightings).toBe(total)
				// 10.5: a pass that hit no bound is the fixpoint: the next one changes and journals nothing.
				// (At most 24 records: only the 16-record group cap can be reached; then run to it.)
				while ((probe.plan?.truncated ?? 0) > 0) store.retireFragments(probe)
				const snap = store.snapshot()
				const journaled = entries.length
				const again = store.retireFragments()
				expect(again.groups + again.retired.length).toBe(0)
				expect(store.snapshot()).toEqual(snap)
				expect(entries.length).toBe(journaled)
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
	}, 60_000)
})
