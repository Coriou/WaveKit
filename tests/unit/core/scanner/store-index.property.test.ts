import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	FAMILIES,
	freshMedian,
	internals,
	linearAtKey,
	linearSticky,
	newCtx,
	probe,
	SOURCES,
	step,
} from "./store-index-ops.js"
import type { Ctx } from "./store-index-ops.js"

function check(ctx: Ctx, round: number): void {
	const s = ctx.store
	const i = internals(s)
	for (let k = 0; k < 3; k++) {
		const obs = probe(ctx, round * 10 + k)
		for (const family of FAMILIES)
			expect(i.stickyMatch(obs, family)?.id).toBe(
				linearSticky(s, obs, family)?.id,
			)
	}
	for (const d of i.discoveries.values()) {
		// the cached median the index sorts by equals a fresh one
		expect(
			(s as unknown as { medianCentre(x: typeof d): number }).medianCentre(d),
		).toBe(freshMedian(s, d))
		for (const source of SOURCES)
			expect(i.atKey(source, d.frequencyKey).map(x => x.id)).toEqual(
				linearAtKey(s, source, d.frequencyKey),
			)
	}
}

describe("discovery store frequency index (WG11 SC)", () => {
	// Feature: web-gaps-11, Property 6: Store index equals a linear scan
	// Validates: Requirements 3.1, 3.2
	it("sticky association and key lookup through the index equal today's linear scan with fresh medians", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 2 ** 31 - 1 }),
				fc.integer({ min: 20, max: 90 }),
				(seed, steps) => {
					const ctx = newCtx(seed)
					for (let n = 0; n < steps; n++) {
						step(ctx)
						if (n % 15 === 0) check(ctx, n)
					}
					check(ctx, steps)
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)

	it("holds one index entry per (indexed source, discovery): removals leave nothing behind", () => {
		const ctx = newCtx(4242)
		for (let n = 0; n < 600; n++) step(ctx)
		const s = ctx.store as unknown as {
			centres: { size(): number }
			indexed: Map<string, { sources: string[] }>
			byKey: Map<string, Set<string>>
			discoveries: Map<string, unknown>
			medians: Map<string, unknown>
			indexDirty: Set<string>
			countsDirty: Set<string>
		}
		let entries = 0
		for (const [id, e] of s.indexed) {
			expect(s.discoveries.has(id)).toBe(true)
			entries += e.sources.length
		}
		expect(s.centres.size()).toBe(entries)
		let keyed = 0
		for (const set of s.byKey.values()) keyed += set.size
		expect(keyed).toBe(entries)
		for (const id of s.medians.keys()) expect(s.discoveries.has(id)).toBe(true)
		// dirty sets are drained at the end of every journal entry
		expect(s.indexDirty.size).toBe(0)
		expect(s.countsDirty.size).toBe(0)
	})
})
