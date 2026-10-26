// Detection quality requirement 10: legacy fragment retirement.
import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	FRAGMENT_GROUPS_MAX,
	FRAGMENT_GROUP_MAX,
	FRAGMENT_PEER_SCAN_MAX,
	FRAGMENT_RETIRE_AGE_MS,
	FRAGMENT_RETIRE_MAX,
	FRAGMENT_SCAN_MAX,
	planFragments,
} from "../../../../src/core/scanner/store/fragment-retirement.js"
import type {
	FragmentPlan,
	FragmentRecord,
} from "../../../../src/core/scanner/store/fragment-retirement.js"
import { counterIds } from "../../../mocks/scanner/observations.js"
import { shape } from "./consolidation-fixtures.js"
import {
	HOUR,
	RASTER,
	T0,
	ch,
	fragmentStore,
	sightings,
} from "./fragment-retirement-fixtures.js"
import type { FragmentSpec } from "./fragment-retirement-fixtures.js"

const id = (n: number): string => `d_${String(n).padStart(4, "0")}`

/** Three fragments of channel 8, 2 to 4 kHz apart (outside the 1 kHz consolidation reach). */
const CHANNEL_8: FragmentSpec[] = [
	{
		id: "d_main",
		centreHz: ch(8) + 300,
		count: 40,
		firstSeenMs: T0 - 5 * HOUR,
	},
	{
		id: "d_fragA",
		centreHz: ch(8) - 2_500,
		count: 4,
		firstSeenMs: T0 - 9 * HOUR,
	},
	{ id: "d_fragB", centreHz: ch(8) + 4_000, count: 2, firstSeenMs: T0 - HOUR },
]

describe("fragment merge (DQ 10.2)", () => {
	it("merges fragments on one channel into the channel record, keeping their history", () => {
		const { store } = fragmentStore(CHANNEL_8)
		const total = sightings(store)
		const r = store.retireFragments()
		expect(r.merges).toEqual([
			{ survivor: "d_main", mergedIds: ["d_fragA", "d_fragB"] },
		])
		const main = store.get("d_main")
		expect(main?.observationCount).toBe(46)
		expect(sightings(store)).toBe(total)
		// First seen widened to the oldest fragment, last seen to the newest.
		expect(main?.firstSeenAt).toBe(new Date(T0 - 9 * HOUR).toISOString())
		expect(main?.lastSeenAt).toBe(new Date(T0 - HOUR + 2000).toISOString())
		expect(Object.keys(shape(store))).toEqual(["d_main"])
		expect(shape(store)["d_main"]).toHaveLength(46)
		// The absorbed-id index resolves both fragments.
		expect(store.survivorOf("d_fragA")).toBe("d_main")
		expect(store.survivorOf("d_fragB")).toBe("d_main")
	})

	it("is idempotent: a second pass changes nothing", () => {
		const { store, entries } = fragmentStore(CHANNEL_8)
		store.retireFragments()
		const after = store.snapshot()
		const n = entries.length
		const again = store.retireFragments()
		expect(again).toEqual({ groups: 0, absorbed: 0, retired: [], merges: [] })
		expect(store.snapshot()).toEqual(after)
		// Empty operations journal nothing.
		expect(entries.length).toBe(n)
	})

	it("journals ordinary merges an old reader replays to the same store", () => {
		const { store, entries, before } = fragmentStore(CHANNEL_8)
		store.retireFragments()
		const reader = new DiscoveryStore({
			maxDiscoveries: 100_000,
			now: () => T0,
			newId: counterIds(),
		})
		reader.restore(structuredClone(before))
		for (const e of entries) reader.replay(e)
		expect(shape(reader)).toEqual(shape(store))
	})

	it("keeps the operator-labelled record as the survivor and never merges one away", () => {
		const { store } = fragmentStore([
			{ ...CHANNEL_8[0]!, operator: { label: "mine" } },
			{ id: "d_big", centreHz: ch(8) - 3_000, count: 90 },
			{
				id: "d_other",
				centreHz: ch(8) + 3_000,
				count: 5,
				operator: { notes: "x" },
			},
		])
		const r = store.retireFragments()
		expect(r.merges).toEqual([{ survivor: "d_main", mergedIds: ["d_big"] }])
		expect(store.get("d_main")?.operator?.label).toBe("mine")
		expect(store.get("d_other")).toBeDefined()
		expect(store.get("d_main")?.observationCount).toBe(130)
	})

	it("keeps decoded and evidence-holding records (the decoded one survives)", () => {
		const { store } = fragmentStore([
			{ id: "d_dec", centreHz: ch(8), count: 3, decoded: true },
			{ id: "d_rec", centreHz: ch(8) + 2_000, count: 50, recordings: 1 },
			{ id: "d_frag", centreHz: ch(8) - 4_000, count: 60 },
		])
		const r = store.retireFragments()
		expect(r.merges.map(m => m.mergedIds).flat()).toEqual(["d_frag"])
		expect(store.get("d_dec")).toBeDefined()
		expect(store.get("d_rec")).toBeDefined()
	})

	it("leaves fragments on other channels, off any grid, or wider than two channels", () => {
		const specs: FragmentSpec[] = [
			{ id: "d_a", centreHz: ch(8) + 6_000, count: 10 },
			{ id: "d_b", centreHz: ch(9) - 6_000, count: 10 },
			{ id: "d_wide", centreHz: ch(8), count: 10, obwHz: 30_000 },
		]
		expect(fragmentStore(specs).store.retireFragments().groups).toBe(0)
		const noGrid = fragmentStore(CHANNEL_8, { rasters: [] }).store
		expect(noGrid.retireFragments().groups).toBe(0)
	})

	it("keeps a level-split fragment apart (DQ 3.1)", () => {
		const { store } = fragmentStore([
			{ id: "d_main", centreHz: ch(8), count: 40, peakDbfs: -45, obwHz: 6000 },
			{
				id: "d_loud",
				centreHz: ch(8) + 3_000,
				count: 40,
				peakDbfs: 0,
				obwHz: 9000,
			},
		])
		expect(store.retireFragments().groups).toBe(0)
	})
})

describe("finest grid and one-pass fixpoint (DQ 10.2, 10.5)", () => {
	it("never merges records on adjacent 8.33 kHz channels through a 25 kHz key", () => {
		const airband = [
			{ spacingHz: 25_000, firstChannelHz: 118_000_000 },
			{ spacingHz: 25_000 / 3, firstChannelHz: 118_000_000 },
		]
		const { store } = fragmentStore(
			[
				{ id: "d_wide", centreHz: 118_025_000, obwHz: 20_000, count: 40 },
				{ id: "d_fine", centreHz: 118_016_667, obwHz: 8_000, count: 5 },
			],
			{ rasters: airband },
		)
		expect(store.retireFragments().absorbed).toBe(0)
		expect(store.get("d_fine")).toBeDefined()
	})

	it("retires a stale merge survivor in the same pass; the next pass journals nothing", () => {
		const nowMs = T0 + 100 * HOUR
		const { store, entries } = fragmentStore(
			[
				{
					id: "d_a",
					centreHz: ch(8),
					count: 1,
					firstSeenMs: T0,
					lastSeenMs: T0,
				},
				{
					id: "d_b",
					centreHz: ch(8) + 3_000,
					count: 1,
					firstSeenMs: T0,
					lastSeenMs: T0,
				},
			],
			{ nowMs },
		)
		const first = store.retireFragments()
		expect(first.absorbed).toBe(1)
		expect(first.retired).toHaveLength(1)
		expect(store.snapshot().discoveries).toEqual([])
		const n = entries.length
		const second = store.retireFragments()
		expect(second).toEqual({ groups: 0, absorbed: 0, retired: [], merges: [] })
		expect(entries.length).toBe(n)
	})
})

describe("stale fragment retirement (DQ 10.4)", () => {
	const stale = (over: Partial<FragmentSpec> = {}): FragmentSpec => ({
		id: "d_stale",
		centreHz: ch(3),
		count: 2,
		firstSeenMs: T0,
		lastSeenMs: T0,
		...over,
	})

	it("retires at the stated age and not one millisecond before", () => {
		const early = fragmentStore([stale()], {
			nowMs: T0 + FRAGMENT_RETIRE_AGE_MS - 1,
		})
		expect(early.store.retireFragments().retired).toEqual([])
		const due = fragmentStore([stale()], { nowMs: T0 + FRAGMENT_RETIRE_AGE_MS })
		expect(due.store.retireFragments().retired).toEqual(["d_stale"])
		expect(due.store.get("d_stale")).toBeUndefined()
	})

	it("never retires a record with three sightings, evidence, a decode, a label or a class", () => {
		const nowMs = T0 + 10 * FRAGMENT_RETIRE_AGE_MS
		for (const over of [
			{ count: 3 },
			{ recordings: 1 },
			{ decoded: true },
			{ operator: { label: "x" } },
			{ operator: { lockout: true } },
			{ confidence: "classified" as const },
			{ identity: { kind: "dmr-cc" as const, value: "1" } },
		]) {
			const { store } = fragmentStore([stale(over)], { nowMs })
			expect(store.retireFragments().retired, JSON.stringify(over)).toEqual([])
			expect(store.get("d_stale")).toBeDefined()
		}
	})

	it("is reported by the maintenance prune", () => {
		const { store } = fragmentStore([stale()], {
			nowMs: T0 + FRAGMENT_RETIRE_AGE_MS,
		})
		expect(store.pruneInactive(180)).toEqual(["d_stale"])
	})
})

describe("per-pass bounds (DQ 10.6)", () => {
	it("merges at most FRAGMENT_GROUPS_MAX channel groups per pass", () => {
		const specs = (channels: number): FragmentSpec[] =>
			Array.from({ length: channels }, (_, c) => [
				{ id: `d_${c}_a`, centreHz: ch(c), count: 10 },
				{ id: `d_${c}_b`, centreHz: ch(c) + 3_000, count: 5 },
			]).flat()
		const at = fragmentStore(specs(FRAGMENT_GROUPS_MAX)).store
		expect(at.retireFragments().groups).toBe(FRAGMENT_GROUPS_MAX)
		const past = fragmentStore(specs(FRAGMENT_GROUPS_MAX + 1)).store
		expect(past.retireFragments().groups).toBe(FRAGMENT_GROUPS_MAX)
		// The next pass resumes and finishes.
		expect(past.retireFragments().groups).toBe(1)
		expect(past.retireFragments().groups).toBe(0)
	})

	it("holds at most FRAGMENT_GROUP_MAX records in a group", () => {
		const specs = (n: number): FragmentSpec[] =>
			Array.from({ length: n }, (_, i) => ({
				id: id(i),
				centreHz: ch(8) - 5_000 + i * 300,
				count: 100 - i,
			}))
		const at = fragmentStore(specs(FRAGMENT_GROUP_MAX)).store
		const atProbe: { plan?: FragmentPlan } = {}
		const one = at.retireFragments(atProbe)
		expect(one.merges.map(m => m.mergedIds.length)).toEqual([
			FRAGMENT_GROUP_MAX - 1,
		])
		expect(atProbe.plan?.truncated).toBe(0)
		// One past: the first group is capped at 16 records; the leftover is folded into the
		// survivor by the pass's next round (10.5), never into a group above the cap.
		const past = fragmentStore(specs(FRAGMENT_GROUP_MAX + 1)).store
		const probe: { plan?: FragmentPlan } = {}
		const r = past.retireFragments(probe)
		expect(r.merges.map(m => m.mergedIds.length)).toEqual([
			FRAGMENT_GROUP_MAX - 1,
			1,
		])
		expect(probe.plan?.truncated).toBe(1)
		expect(past.retireFragments().absorbed).toBe(0)
	})

	it("retires at most FRAGMENT_RETIRE_MAX records per pass, oldest first", () => {
		const specs = (n: number): FragmentSpec[] =>
			Array.from({ length: n }, (_, i) => ({
				id: id(i),
				centreHz: ch(i),
				count: 1,
				firstSeenMs: T0 + i,
				lastSeenMs: T0 + i,
			}))
		const nowMs = T0 + 2 * FRAGMENT_RETIRE_AGE_MS
		const at = fragmentStore(specs(FRAGMENT_RETIRE_MAX), { nowMs }).store
		expect(at.retireFragments().retired).toHaveLength(FRAGMENT_RETIRE_MAX)
		const past = fragmentStore(specs(FRAGMENT_RETIRE_MAX + 1), { nowMs }).store
		const first = past.retireFragments().retired
		expect(first).toHaveLength(FRAGMENT_RETIRE_MAX)
		expect(first).not.toContain(id(FRAGMENT_RETIRE_MAX))
		expect(past.retireFragments().retired).toEqual([id(FRAGMENT_RETIRE_MAX)])
	})
})

describe("planner bounds (DQ 10.6)", () => {
	const rec = (
		i: number,
		over: Partial<FragmentRecord> = {},
	): FragmentRecord => ({
		id: id(i),
		sourceId: "s",
		centreHz: ch(i),
		obwHz: 8000,
		observationCount: 5,
		firstSeenAt: new Date(T0).toISOString(),
		lastSeenAt: new Date(T0).toISOString(),
		confidence: "activity",
		family: "unknown",
		operator: false,
		evidence: false,
		...over,
	})
	const plan = (records: FragmentRecord[], cursor?: string): FragmentPlan => {
		let checks = 0
		const p = planFragments({
			records,
			rasterOf: () => RASTER,
			compatible: () => {
				checks += 1
				return true
			},
			nowMs: T0,
			cursor,
		})
		expect(checks).toBeLessThanOrEqual(p.scanned * FRAGMENT_PEER_SCAN_MAX)
		return p
	}

	it("examines at most FRAGMENT_SCAN_MAX candidates and resumes from the cursor", () => {
		const at = plan(Array.from({ length: FRAGMENT_SCAN_MAX }, (_, i) => rec(i)))
		expect(at.scanned).toBe(FRAGMENT_SCAN_MAX)
		expect(at.nextCursor).toBeUndefined()
		const all = Array.from({ length: FRAGMENT_SCAN_MAX + 1 }, (_, i) => rec(i))
		const past = plan(all)
		expect(past.scanned).toBe(FRAGMENT_SCAN_MAX)
		expect(past.nextCursor).toBe(id(FRAGMENT_SCAN_MAX - 1))
		const next = plan(all, past.nextCursor)
		expect(next.scanned).toBe(FRAGMENT_SCAN_MAX)
		// Wrapped: the one left over first, then from the start.
		expect(next.nextCursor).toBe(id(FRAGMENT_SCAN_MAX - 2))
	})

	it("visits at most FRAGMENT_PEER_SCAN_MAX nearest records around a channel", () => {
		// Protected neighbours on one channel and one fragment: checks stay bounded.
		const dense = (neighbours: number): FragmentRecord[] => [
			rec(0, { centreHz: ch(8) + 5_000, observationCount: 1 }),
			...Array.from({ length: neighbours }, (_, i) =>
				rec(i + 1, { centreHz: ch(8) + (i % 50), evidence: true }),
			),
		]
		// 32 neighbours: every one visited, nothing left out.
		const at = plan(dense(FRAGMENT_PEER_SCAN_MAX))
		expect(at.truncated).toBe(0)
		expect(at.groups.map(g => g.members)).toEqual([[id(0)]])
		// 33 and 34 neighbours: one more than the scan holds, so the candidate counts as truncated.
		for (const n of [FRAGMENT_PEER_SCAN_MAX + 1, FRAGMENT_PEER_SCAN_MAX + 2]) {
			const past = plan(dense(n))
			expect(past.truncated, String(n)).toBe(1)
			expect(past.groups.map(g => g.members)).toEqual([[id(0)]])
		}
	})
})
