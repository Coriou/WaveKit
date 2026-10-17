// Feature: web-gaps-7, Property 10: Skip merge shape
// Validates: Requirements 6.3
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { BANDPLAN_SKIP_MAX_RANGES } from "@wavekit/api-types"
import { computeBandPlanSkips } from "../../../../../src/core/scanner/plan/bandplan-skips.js"
import type { NormalisedJobSpec } from "../../../../../src/core/scanner/types.js"

const edge = fc.integer({ min: 0, max: 100_000 })
const interval = fc
	.tuple(edge, edge)
	.map(([a, b]) => ({ startHz: Math.min(a, b), endHz: Math.max(a, b) }))
const sourceArb = fc
	.record({ key: fc.constantFrom("a/1", "a/2", "b/1", "c/9"), iv: interval })
	.map(s => ({ key: s.key, ...s.iv }))
const rangeArb: fc.Arbitrary<{
	startHz: number
	endHz: number
	enabled?: boolean
}> = fc
	.record({
		iv: interval,
		enabled: fc.option(fc.boolean(), { nil: undefined }),
	})
	.map(r =>
		r.enabled === undefined ? { ...r.iv } : { ...r.iv, enabled: r.enabled },
	)

describe("Property 10: skip merge shape", () => {
	it("sorted, disjoint and non-touching, inside enabled ranges, keys sorted unique, bounded", () => {
		fc.assert(
			fc.property(
				fc.array(sourceArb, { maxLength: 400 }),
				fc.array(rangeArb, { maxLength: 4 }),
				(sources, ranges) => {
					const spec = { ranges } as unknown as NormalisedJobSpec
					const { ranges: out } = computeBandPlanSkips(sources, spec)
					expect(out.length).toBeLessThanOrEqual(BANDPLAN_SKIP_MAX_RANGES)
					const enabled = ranges.filter(r => r.enabled !== false)
					for (let i = 0; i < out.length; i++) {
						const r = out[i]!
						expect(r.startHz).toBeLessThanOrEqual(r.endHz)
						expect(r.applied).toBe(false)
						if (i > 0) expect(r.startHz).toBeGreaterThan(out[i - 1]!.endHz + 1)
						expect(r.bandKeys.length).toBeGreaterThan(0)
						expect(r.bandKeys).toEqual([...new Set(r.bandKeys)].sort())
						// every Hz edge lies in an enabled range
						for (const hz of [r.startHz, r.endHz]) {
							expect(enabled.some(e => hz >= e.startHz && hz <= e.endHz)).toBe(
								true,
							)
						}
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})
