// WG15 DQ requirement 7: legacy consolidation fixtures (7.10) through the real DiscoveryStore.
// Register directory teardown before a test dynamically imports the scanner fixtures.
import "../../../helpers/tmp-dir.js"
import { describe, expect, it } from "vitest"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import {
	DQ_CONSOLIDATE_GROUP_MAX,
	DQ_CONSOLIDATE_SCAN_MAX,
} from "../../../../src/core/scanner/detection-quality-contract.js"
import {
	joinable,
	nearest,
	planConsolidation,
} from "../../../../src/core/scanner/store/consolidation.js"
import type { ConsolidationRecord } from "../../../../src/core/scanner/store/consolidation.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"
import { T0, legacySnapshot, shape, storeOf } from "./consolidation-fixtures.js"
import type { LegacySpec } from "./consolidation-fixtures.js"

const F = 446_042_000

describe("legacy consolidation (DQ 7.10)", () => {
	it("legacy pair: one record, summed, aliased; later observations update only the survivor", () => {
		const { store } = storeOf([
			{ id: "d_a", centreHz: F, count: 40, peakDbfs: -52, family: "unknown" },
			{
				id: "d_b",
				centreHz: F + 270,
				count: 40,
				peakDbfs: -52,
				family: "analog",
				protocol: "analog-fm",
				firstSeenMs: T0 + 1,
			},
		])
		const plan = store.consolidationPlan()
		expect(plan.groups).toEqual([{ survivor: "d_a", members: ["d_b"] }])
		expect(store.applyConsolidation(plan)).toEqual({
			groups: 1,
			absorbed: 1,
			merges: [{ survivor: "d_a", mergedIds: ["d_b"] }],
		})
		const a = store.get("d_a")
		expect(store.get("d_b")).toBeUndefined()
		expect(a?.observationCount).toBe(80)
		expect(a?.airtimeMs).toBe(80_000)
		expect(store.aliasOwner("d_b")).toBe("d_a")
		for (let i = 0; i < 50; i++) {
			const r = store.ingest(
				makeObs({
					id: `late-${i}`,
					centreHz: F + 135 + ((i * 37) % 881) - 440,
					startedAt: T0 + 100_000 + i * 2000,
					obwHz: 8000,
					snrDb: 20,
				}),
			)
			expect(r.discoveryId).toBe("d_a")
		}
		expect(store.consolidationPlan().groups).toEqual([])
	})

	it("grid split: 11 kHz and 14 kHz records 400 Hz apart join", () => {
		const { store } = storeOf([
			{ id: "d_a", centreHz: F, obwHz: 11_000 },
			{ id: "d_b", centreHz: F + 400, obwHz: 14_000, firstSeenMs: T0 + 1 },
		])
		store.applyConsolidation(store.consolidationPlan())
		expect(Object.keys(shape(store))).toEqual(["d_a"])
	})

	it.each<[string, LegacySpec[]]>([
		[
			"colour codes 11 and 15",
			[
				{
					id: "d_a",
					centreHz: F,
					family: "digital-voice",
					protocol: "dmr",
					identity: { kind: "dmr-cc", value: "11" },
				},
				{
					id: "d_b",
					centreHz: F + 220,
					family: "digital-voice",
					protocol: "dmr",
					identity: { kind: "dmr-cc", value: "15" },
				},
			],
		],
		[
			"an operator lockout",
			[
				{ id: "d_a", centreHz: F, operator: { lockout: true } },
				{ id: "d_b", centreHz: F + 100 },
			],
		],
		[
			"0 dBFS beside -45 dBFS at OBW ratio 1.5",
			[
				{ id: "d_a", centreHz: F, peakDbfs: 0, obwHz: 9000 },
				{ id: "d_b", centreHz: F + 300, peakDbfs: -45, obwHz: 6000 },
			],
		],
		[
			"1 200 Hz apart",
			[
				{ id: "d_a", centreHz: F },
				{ id: "d_b", centreHz: F + 1200 },
			],
		],
		[
			"another source",
			[
				{ id: "d_a", centreHz: F },
				{ id: "d_b", centreHz: F + 10, sourceId: "src-2" },
			],
		],
	])("kept apart: %s", (_name, specs) => {
		const { store } = storeOf(specs)
		const plan = store.consolidationPlan()
		expect(plan.groups).toEqual([])
		store.applyConsolidation(plan)
		expect(Object.keys(shape(store))).toEqual(["d_a", "d_b"])
	})

	it("kept apart: analog (proven by heard audio) beside its decoded digital twin", () => {
		const { store } = storeOf([
			{ id: "d_a", centreHz: F, family: "analog", protocol: "analog-fm" },
			{
				id: "d_b",
				centreHz: F + 100,
				family: "digital-voice",
				protocol: "dmr",
				confidence: "decoded",
			},
		])
		// DQ 9.1: a stored analog guess alone is a weak label; the heard tone proves the family.
		expect(
			store.recordAnalog("d_a-o0", {
				outcome: "decoded",
				mode: "nfm",
				voice: true,
				tone: { ctcssHz: 88.5, dcs: null },
				transport: "live",
				at: T0,
			}),
		).toBe(true)
		const plan = store.consolidationPlan()
		expect(plan.groups).toEqual([])
		store.applyConsolidation(plan)
		expect(Object.keys(shape(store))).toEqual(["d_a", "d_b"])
	})

	it("no chaining: f, f + 900 and f + 1 800 give one group of two", () => {
		const { store } = storeOf([
			{ id: "d_a", centreHz: F },
			{ id: "d_b", centreHz: F + 900, firstSeenMs: T0 + 1 },
			{ id: "d_c", centreHz: F + 1800, firstSeenMs: T0 + 2 },
		])
		const plan = store.consolidationPlan()
		expect(plan.groups).toEqual([{ survivor: "d_a", members: ["d_b"] }])
		store.applyConsolidation(plan)
		expect(Object.keys(shape(store))).toEqual(["d_a", "d_c"])
	})

	it("over cap: 18 joinable records give a group of 16 and leave 2; the survivor is never absorbed", () => {
		const specs: LegacySpec[] = Array.from({ length: 18 }, (_, i) => ({
			id: `d_${String(i).padStart(2, "0")}`,
			centreHz: F + i * 25,
			firstSeenMs: T0 + i,
		}))
		const { store } = storeOf(specs)
		const plan = store.consolidationPlan()
		expect(plan.groups[0]?.survivor).toBe("d_00")
		expect(plan.groups[0]?.members).toHaveLength(DQ_CONSOLIDATE_GROUP_MAX - 1)
		expect(plan.truncated).toBeGreaterThanOrEqual(1)
		const owned = new Set(plan.groups.flatMap(g => [g.survivor, ...g.members]))
		expect(owned.size).toBe(
			plan.groups.reduce((n, g) => n + 1 + g.members.length, 0),
		)
		for (const g of plan.groups.slice(1))
			expect([g.survivor, ...g.members]).not.toContain("d_00")
		store.applyConsolidation(plan)
		const left = Object.keys(shape(store))
		expect(left).toContain("d_00")
		expect(left.length).toBe(
			18 - plan.groups.reduce((n, g) => n + g.members.length, 0),
		)
		// the next load may fold the leftovers into the survivor
		store.applyConsolidation(store.consolidationPlan())
		expect(Object.keys(shape(store)).length).toBeLessThan(left.length + 1)
	})

	it("dense, not joinable: 10 000 colocated identity-conflicting records cost at most 32 checks each", () => {
		const records: ConsolidationRecord[] = Array.from(
			{ length: 10_000 },
			(_, i) => ({
				id: `d_${String(i).padStart(5, "0")}`,
				sourceId: "src-1",
				centreHz: F + (i % 1000),
				obwHz: 8000,
				obwMin: 8000,
				obwMax: 8000,
				bandFactor: 2,
				peakDbfs: -50,
				count: 10,
				young: [],
				identity: { kind: "dmr-cc", value: String(i) },
				family: "digital-voice",
				decoded: false,
				protocol: "dmr",
				firstSeenAt: new Date(T0 + i).toISOString(),
				hasOperator: false,
			}),
		)
		const probe = { checks: 0 }
		const plan = planConsolidation(records, probe)
		expect(plan.groups).toEqual([])
		expect(probe.checks).toBeLessThanOrEqual(10_000 * DQ_CONSOLIDATE_SCAN_MAX)
		expect(plan.truncated).toBe(10_000)
	})

	it("at and past the scan bound: the 32nd nearest is scanned, the 33rd is not", () => {
		const mk = (
			i: number,
			centreHz: number,
			conflict: boolean,
		): ConsolidationRecord => ({
			id: `d_${String(i).padStart(3, "0")}`,
			sourceId: "src-1",
			centreHz,
			obwHz: 8000,
			obwMin: 8000,
			obwMax: 8000,
			bandFactor: conflict ? 2 : 3,
			peakDbfs: -50,
			count: 10,
			young: [],
			identity: conflict ? { kind: "dmr-cc", value: String(i) } : undefined,
			family: "unknown",
			decoded: false,
			protocol: "unknown",
			firstSeenAt: new Date(T0 + i).toISOString(),
			hasOperator: false,
		})
		const base = (n: number) => [
			mk(0, F, true),
			...Array.from({ length: n - 1 }, (_, i) => mk(i + 1, F + 10 + i, true)),
		]
		// joinable record exactly 32nd nearest: one conflicting survivor plus 31 conflicting neighbours
		const at = [...base(32), mk(500, F + 600, false)]
		expect(planConsolidation(at).groups).toEqual([
			{ survivor: "d_000", members: ["d_500"] },
		])
		const past = [...base(33), mk(500, F + 600, false)]
		expect(planConsolidation(past).groups).toEqual([])
		expect(joinable(mk(1, F, false), mk(2, F + 1000, false))).toBe(true)
		expect(joinable(mk(1, F, false), mk(2, F + 1001, false))).toBe(false)
	})

	it("old reader: the plan's journal lines replayed by plain restore + replay give the consolidated store", () => {
		const specs: LegacySpec[] = [
			{ id: "d_a", centreHz: F },
			{ id: "d_b", centreHz: F + 200, firstSeenMs: T0 + 1 },
			{ id: "d_c", centreHz: F + 5000 },
			{ id: "d_d", centreHz: F + 5300, firstSeenMs: T0 + 5 },
		]
		const { store, entries } = storeOf(specs)
		store.applyConsolidation(store.consolidationPlan())
		expect(entries.map(e => e.op)).toEqual(["rekey", "rekey"])
		const reader = new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => T0,
			newId: counterIds(),
		})
		reader.restore(legacySnapshot(specs))
		for (const e of entries) reader.replay(e)
		expect(shape(reader)).toEqual(shape(store))
	})
})

describe("consolidation at load through ScannerPersistence (DQ 7.6)", () => {
	it("crash after the first group: resume of the plan file gives the uninterrupted result", async () => {
		const specs: LegacySpec[] = [
			{ id: "d_a", centreHz: F },
			{ id: "d_b", centreHz: F + 200, firstSeenMs: T0 + 1 },
			{ id: "d_c", centreHz: F + 5000 },
			{ id: "d_d", centreHz: F + 5300, firstSeenMs: T0 + 5 },
		]
		const reference = storeOf(specs).store
		reference.applyConsolidation(reference.consolidationPlan())
		const dir = await mkdtemp(join(tmpdir(), "dq7-"))
		try {
			const logger = createLogger({ level: "fatal" })
			const p = new ScannerPersistence({ dir, logger, now: () => T0 })
			await p.load()
			const { store } = storeOf(specs)
			await p.writeSnapshot({ ...store.snapshot() })
			const plan = store.consolidationPlan()
			await p.writeConsolidationPlan({ createdAt: "x", groups: plan.groups })
			let appended = 0
			store.on("mutation", e => {
				// crash after the first group's line: later lines never reach the disk
				if (appended++ === 0) void p.append(e)
			})
			store.applyConsolidation(plan)
			await new Promise(r => setTimeout(r, 50))
			const q = new ScannerPersistence({ dir, logger, now: () => T0 })
			const loaded = await q.load()
			const again = new DiscoveryStore({
				maxDiscoveries: 100,
				now: () => T0,
				newId: counterIds(),
			})
			again.restore(loaded)
			for (const e of loaded.entries) again.replay(e)
			expect(Object.keys(shape(again))).toHaveLength(3)
			const read = await q.readConsolidationPlan()
			expect(read.kind).toBe("ok")
			if (read.kind === "ok") again.applyConsolidation(read.plan)
			expect(shape(again)).toEqual(shape(reference))
			// applying the plan again is a no-op
			expect(again.applyConsolidation(plan)).toEqual({
				groups: 0,
				absorbed: 0,
				merges: [],
			})
			await q.writeSnapshotOf(again)
			await q.removeConsolidationPlan()
			expect(await readdir(dir)).not.toContain("consolidation-plan.json")
			expect((await q.readConsolidationPlan()).kind).toBe("missing")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("an invalid plan file is moved aside and reported invalid", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dq7-"))
		try {
			const { writeFile } = await import("node:fs/promises")
			await writeFile(join(dir, "consolidation-plan.json"), "{not json")
			const p = new ScannerPersistence({
				dir,
				logger: createLogger({ level: "fatal" }),
				now: () => T0,
			})
			expect((await p.readConsolidationPlan()).kind).toBe("invalid")
			expect((await p.readConsolidationPlan()).kind).toBe("missing")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe("consolidation at service start (DQ 7.6)", () => {
	it("plans, applies, snapshots and removes the plan file before any ingest", async () => {
		const { serviceHarness } =
			await import("../../../mocks/scanner/service-fakes.js")
		const { mkdtempSync } = await import("node:fs")
		const dir = mkdtempSync(join(tmpdir(), "dq7-svc-"))
		try {
			const p = new ScannerPersistence({
				dir,
				logger: createLogger({ level: "fatal" }),
				now: () => T0,
			})
			await p.load()
			await p.writeSnapshot(
				legacySnapshot([
					{ id: "d_a", centreHz: F, sourceId: "rtl" },
					{
						id: "d_b",
						centreHz: F + 200,
						firstSeenMs: T0 + 1,
						sourceId: "rtl",
					},
				]),
			)
			const h = serviceHarness({ dir })
			await h.service.start()
			expect(h.service.getDiscovery("d_a")).toBeDefined()
			expect(h.service.getDiscovery("d_b")).toBeUndefined()
			expect(await readdir(dir)).not.toContain("consolidation-plan.json")
			await h.service.stop()
			const reread = await new ScannerPersistence({
				dir,
				logger: createLogger({ level: "fatal" }),
				now: () => T0,
			}).load()
			expect(reread.discoveries.map(d => d.id)).toEqual(["d_a"])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe("nearest tie order (review regression, DQ 7.3)", () => {
	it("equal centres on the left resolve to the smaller id", () => {
		const list = [
			{ id: "a", centreHz: 100 },
			{ id: "b", centreHz: 100 },
		]
		expect(nearest(list, 200, 1000, 1).map(e => e.id)).toEqual(["a"])
		expect(nearest(list, 0, 1000, 1).map(e => e.id)).toEqual(["a"])
		const both = [
			{ id: "c", centreHz: 100 },
			{ id: "d", centreHz: 100 },
			{ id: "a", centreHz: 300 },
			{ id: "b", centreHz: 300 },
		].sort((x, y) => x.centreHz - y.centreHz || (x.id < y.id ? -1 : 1))
		expect(nearest(both, 200, 1000, 4).map(e => e.id)).toEqual([
			"a",
			"b",
			"c",
			"d",
		])
	})
})
