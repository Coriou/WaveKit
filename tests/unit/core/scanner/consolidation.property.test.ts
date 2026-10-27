import { setImmediate as yieldToRpc } from "node:timers/promises"
// WG15 DQ requirement 7: consolidation properties (design Properties 12 to 16).
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DQ_CONSOLIDATE_GROUP_MAX,
	DQ_CONSOLIDATE_SCAN_MAX,
	DQ_CROSS_FAMILY_HZ,
} from "../../../../src/core/scanner/detection-quality-contract.js"
import {
	joinable,
	nearest,
	planConsolidation,
	rankCompare,
} from "../../../../src/core/scanner/store/consolidation.js"
import type { ConsolidationRecord } from "../../../../src/core/scanner/store/consolidation.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { ProtocolFamily } from "../../../../src/core/scanner/types.js"
import { counterIds } from "../../../mocks/scanner/observations.js"
import { T0, legacySnapshot, shape, storeOf } from "./consolidation-fixtures.js"
import type { LegacySpec } from "./consolidation-fixtures.js"

// Keep the full generated stores (including over-cap groups) and 100 runs per
// property; repeated restore/replay/snapshot work dominates these CPU-only cases.
// The crash property restores up to 100 × 3 stores × 22 records × 6
// observations = 39,600 observations, then replays/clones/compares snapshots.
// Allow 1 ms per observation under CPU contention (39.6 s), plus 20 s overhead.
const STORE_PROPERTY_TIMEOUT_MS = 60_000
const F = 446_500_000
const FAMILIES: ProtocolFamily[] = [
	"unknown",
	"carrier",
	"analog",
	"digital-voice",
	"pager",
]

const recordArb = (i: number): fc.Arbitrary<ConsolidationRecord> =>
	fc
		.record({
			id: fc.constant(`d_${String(i).padStart(3, "0")}`),
			sourceId: fc.constantFrom("s1", "s2"),
			centreHz: fc.integer({ min: 0, max: 4000 }).map(x => F + x),
			obwHz: fc.constantFrom(4000, 8000, 12_000, 20_000),
			peakDbfs: fc.constantFrom(-50, -45, -20),
			count: fc.integer({ min: 1, max: 10 }),
			young: fc.constant([{ peakDbfs: -50, obwHz: 8000 }]),
			identity: fc.option(
				fc.record({
					kind: fc.constant("dmr-cc"),
					value: fc.constantFrom("1", "2"),
				}),
				{ nil: undefined },
			),
			family: fc.constantFrom(...FAMILIES),
			decoded: fc.boolean(),
			protocol: fc.constantFrom("dmr", "pocsag", "unknown"),
			firstSeenAt: fc
				.integer({ min: 0, max: 20 })
				.map(x => new Date(T0 + x * 1000).toISOString()),
			hasOperator: fc.boolean(),
		})
		.map(r => ({
			...r,
			obwMin: r.obwHz,
			obwMax: r.obwHz,
			bandFactor: r.decoded || r.identity !== undefined ? 2 : 3,
		}))

const recordsArb = fc
	.integer({ min: 0, max: 40 })
	.chain(n => fc.tuple(...Array.from({ length: n }, (_, i) => recordArb(i))))

const specArb = (i: number): fc.Arbitrary<LegacySpec> =>
	fc.record({
		id: fc.constant(`d_${String(i).padStart(3, "0")}`),
		centreHz: fc.integer({ min: 0, max: 3000 }).map(x => F + x),
		obwHz: fc.constantFrom(6000, 8000, 12_000),
		peakDbfs: fc.constantFrom(-50, -48, -20),
		count: fc.integer({ min: 1, max: 6 }),
		family: fc.constantFrom<ProtocolFamily>("unknown", "analog", "carrier"),
		firstSeenMs: fc.integer({ min: 0, max: 10 }).map(x => T0 + x * 1000),
	})

const specsArb = fc
	.integer({ min: 0, max: 22 })
	.chain(n => fc.tuple(...Array.from({ length: n }, (_, i) => specArb(i))))

describe("consolidation properties", () => {
	it("plan ownership and bounds", () => {
		// Feature: detection-quality, Property 12: Plan ownership and bound
		// Validates: Requirements 7.3, 7.4, 7.8
		fc.assert(
			fc.property(recordsArb, records => {
				const probe = { checks: 0 }
				const plan = planConsolidation(records, probe)
				const byId = new Map(records.map(r => [r.id, r]))
				const seen = new Set<string>()
				for (const g of plan.groups) {
					expect(g.members.length + 1).toBeLessThanOrEqual(
						DQ_CONSOLIDATE_GROUP_MAX,
					)
					const s = byId.get(g.survivor)!
					for (const id of [g.survivor, ...g.members]) {
						expect(seen.has(id)).toBe(false)
						seen.add(id)
					}
					for (const id of g.members) {
						const m = byId.get(id)!
						expect(joinable(s, m)).toBe(true)
						expect(rankCompare(s, m)).toBeLessThan(0)
						expect(Math.abs(m.centreHz - s.centreHz)).toBeLessThanOrEqual(
							DQ_CROSS_FAMILY_HZ,
						)
					}
				}
				expect(probe.checks).toBeLessThanOrEqual(
					records.length * DQ_CONSOLIDATE_SCAN_MAX,
				)
			}),
			{ numRuns: 100 },
		)
	})

	it("the plan does not depend on input order", () => {
		// Feature: detection-quality, Property 13: Order independence
		// Validates: Requirements 7.2, 7.3
		fc.assert(
			fc.property(
				recordsArb.chain(rs =>
					fc.tuple(
						fc.constant(rs),
						fc.shuffledSubarray(rs, {
							minLength: rs.length,
							maxLength: rs.length,
						}),
					),
				),
				([a, b]) => {
					expect(planConsolidation(b)).toEqual(planConsolidation(a))
				},
			),
			{ numRuns: 100 },
		)
	})

	it(
		"stores restored in different orders consolidate to the same shape",
		async () => {
			// Feature: detection-quality, Property 13: Order independence
			// Validates: Requirements 7.2, 7.3
			await fc.assert(
				fc.asyncProperty(
					specsArb.chain(ss =>
						fc.tuple(
							fc.constant(ss),
							fc.shuffledSubarray(ss, {
								minLength: ss.length,
								maxLength: ss.length,
							}),
						),
					),
					async ([a, b]) => {
						await yieldToRpc()
						const x = storeOf(a).store
						const y = storeOf(b).store
						x.applyConsolidation(x.consolidationPlan())
						y.applyConsolidation(y.consolidationPlan())
						expect(shape(y)).toEqual(shape(x))
					},
				),
				{ numRuns: 100 },
			)
		},
		STORE_PROPERTY_TIMEOUT_MS,
	)

	it(
		"applying or resuming a plan twice equals once",
		async () => {
			// Feature: detection-quality, Property 14: Idempotence
			// Validates: Requirements 7.6
			await fc.assert(
				fc.asyncProperty(specsArb, async specs => {
					await yieldToRpc()
					const { store } = storeOf(specs)
					const plan = store.consolidationPlan()
					store.applyConsolidation(plan)
					const once = shape(store)
					expect(store.applyConsolidation(plan)).toEqual({
						groups: 0,
						absorbed: 0,
						merges: [],
					})
					expect(shape(store)).toEqual(once)
				}),
				{ numRuns: 100 },
			)
		},
		STORE_PROPERTY_TIMEOUT_MS,
	)

	it(
		"a crash after any group, then replay and resume, equals the uninterrupted run",
		async () => {
			// Feature: detection-quality, Property 15: Crash equivalence
			// Validates: Requirements 7.5, 7.6
			const overCap: LegacySpec[] = Array.from({ length: 18 }, (_, i) => ({
				id: `d_${String(i).padStart(3, "0")}`,
				centreHz: F + i * 20,
				firstSeenMs: T0 + i,
			}))
			await fc.assert(
				fc.asyncProperty(
					fc.oneof(specsArb, fc.constant(overCap)),
					fc.nat(),
					async (specs, k) => {
						await yieldToRpc()
						const reference = storeOf(specs).store
						const plan = reference.consolidationPlan()
						reference.applyConsolidation(plan)
						const crashAt =
							plan.groups.length === 0 ? 0 : k % (plan.groups.length + 1)
						const { store, entries } = storeOf(specs)
						store.applyConsolidation({ groups: plan.groups.slice(0, crashAt) })
						const reader = new DiscoveryStore({
							maxDiscoveries: 100_000,
							now: () => T0,
							newId: counterIds(),
						})
						reader.restore(legacySnapshot(specs))
						for (const e of entries) reader.replay(e)
						reader.applyConsolidation(plan)
						expect(shape(reader)).toEqual(shape(reference))
					},
				),
				{ numRuns: 100 },
			)
		},
		STORE_PROPERTY_TIMEOUT_MS,
	)

	it(
		"conserves observations and airtime and resolves every absorbed id",
		async () => {
			// Feature: detection-quality, Property 16: Conservation and safety
			// Validates: Requirements 7.1, 7.5
			await fc.assert(
				fc.asyncProperty(specsArb, async specs => {
					await yieldToRpc()
					const { store } = storeOf(specs)
					const before = store.snapshot()
					const plan = store.consolidationPlan()
					store.applyConsolidation(plan)
					const after = store.snapshot()
					expect(after.observations.length).toBe(before.observations.length)
					const sum = (
						ds: typeof before.discoveries,
						k: "airtimeMs" | "observationCount",
					) => ds.reduce((n, d) => n + (d[k] ?? 0), 0)
					expect(sum(after.discoveries, "airtimeMs")).toBe(
						sum(before.discoveries, "airtimeMs"),
					)
					expect(sum(after.discoveries, "observationCount")).toBe(
						sum(before.discoveries, "observationCount"),
					)
					const live = new Set(after.discoveries.map(d => d.id))
					for (const d of before.discoveries)
						if (!live.has(d.id))
							expect(live.has(store.aliasOwner(d.id) ?? "")).toBe(true)
				}),
				{ numRuns: 100 },
			)
		},
		STORE_PROPERTY_TIMEOUT_MS,
	)

	it("nearest equals the brute-force (distance, id) order", () => {
		// Feature: detection-quality, Property 12: Plan ownership and bound
		// Validates: Requirements 7.3
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 30 }), { maxLength: 60 }),
				fc.integer({ min: -5, max: 35 }),
				fc.integer({ min: 0, max: 20 }),
				fc.integer({ min: 0, max: 10 }),
				(centres, at, radius, k) => {
					const list = centres
						.map((c, i) => ({
							id: `e${String(i).padStart(2, "0")}`,
							centreHz: c,
						}))
						.sort((x, y) => x.centreHz - y.centreHz || (x.id < y.id ? -1 : 1))
					const want = list
						.filter(e => Math.abs(e.centreHz - at) <= radius)
						.sort(
							(x, y) =>
								Math.abs(x.centreHz - at) - Math.abs(y.centreHz - at) ||
								(x.id < y.id ? -1 : 1),
						)
						.slice(0, k)
					expect(nearest(list, at, radius, k)).toEqual(want)
				},
			),
			{ numRuns: 100 },
		)
	})
})
