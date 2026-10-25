// Band inspection UX req 3.1: absorbed id -> survivor index and its store wiring.
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	ABSORBED_ID_INDEX_MAX,
	AbsorbedIdIndex,
} from "../../../../src/core/scanner/store/absorbed-id-index.js"
import { storeOf } from "./consolidation-fixtures.js"

describe("AbsorbedIdIndex", () => {
	it("resolves a merged id; unknown ids and self merges resolve to nothing", () => {
		const index = new AbsorbedIdIndex()
		index.record("d_b", "d_a")
		index.record("d_a", "d_a")
		index.record("", "d_a")
		expect(index.resolve("d_b")).toBe("d_a")
		expect(index.resolve("d_a")).toBeUndefined()
		expect(index.resolve("d_x")).toBeUndefined()
		expect(index.size).toBe(1)
	})

	it("resolves chains at write time, re-pointing in place", () => {
		const index = new AbsorbedIdIndex()
		index.record("d_c", "d_b")
		index.record("d_b", "d_a")
		expect(index.resolve("d_c")).toBe("d_a")
		expect(index.resolve("d_b")).toBe("d_a")
		expect(index.size).toBe(2)
		// d_a merged back into d_c (d_c live again): no self entry for d_c.
		index.record("d_a", "d_c")
		expect(index.resolve("d_c")).toBeUndefined()
		expect(index.resolve("d_b")).toBe("d_c")
		expect(index.resolve("d_a")).toBe("d_c")
	})

	it("holds 16 384 entries and evicts the oldest at 16 385", () => {
		expect(ABSORBED_ID_INDEX_MAX).toBe(16_384)
		const index = new AbsorbedIdIndex()
		for (let i = 0; i < 16_384; i++) index.record(`d_${i}`, "d_keep")
		expect(index.size).toBe(16_384)
		expect(index.resolve("d_0")).toBe("d_keep")
		index.record("d_16384", "d_keep")
		expect(index.size).toBe(16_384)
		expect(index.resolve("d_0")).toBeUndefined()
		expect(index.resolve("d_1")).toBe("d_keep")
		expect(index.resolve("d_16384")).toBe("d_keep")
	})

	it("a re-point keeps the entry's age (an update, not a new entry)", () => {
		const index = new AbsorbedIdIndex(2)
		index.record("d_1", "d_b")
		index.record("d_2", "d_c")
		// d_b absorbed into d_c: d_1 re-pointed (still oldest), d_b is the newest entry.
		index.record("d_b", "d_c")
		expect(index.size).toBe(2)
		expect(index.resolve("d_1")).toBeUndefined()
		expect(index.resolve("d_2")).toBe("d_c")
		expect(index.resolve("d_b")).toBe("d_c")
	})

	it("property: a merged id resolves to its current survivor while indexed; size bounded", () => {
		// Feature: band-inspection-ux, Property 7: absorbed ids resolve to the current survivor
		// Validates: Requirements 3.1
		const max = 8
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.nat(15), fc.nat(15)), { maxLength: 60 }),
				merges => {
					const index = new AbsorbedIdIndex(max)
					const live = new Set(Array.from({ length: 16 }, (_, i) => `d_${i}`))
					// Reference: full union-find without eviction.
					const parent = new Map<string, string>()
					const root = (id: string): string => {
						let at = id
						while (parent.has(at)) at = parent.get(at)!
						return at
					}
					for (const [a, b] of merges) {
						const drop = `d_${a}`
						const keep = `d_${b}`
						if (drop === keep || !live.has(drop) || !live.has(keep)) continue
						live.delete(drop)
						parent.set(drop, keep)
						index.record(drop, keep)
						expect(index.size).toBeLessThanOrEqual(max)
					}
					for (const id of parent.keys()) {
						const got = index.resolve(id)
						if (got !== undefined) {
							expect(got).toBe(root(id))
							expect(live.has(got)).toBe(true)
						}
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("DiscoveryStore.survivorOf", () => {
	const F = 446_042_000
	it("resolves an id absorbed by consolidation; live and unknown ids resolve to nothing", () => {
		const { store } = storeOf([
			{ id: "d_a", centreHz: F, count: 40, peakDbfs: -52 },
			{ id: "d_b", centreHz: F + 270, count: 40, peakDbfs: -52 },
		])
		store.applyConsolidation(store.consolidationPlan())
		expect(store.survivorOf("d_b")).toBe("d_a")
		expect(store.survivorOf("d_a")).toBeUndefined()
		expect(store.survivorOf("d_nope")).toBeUndefined()
	})
})
