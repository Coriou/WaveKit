import { describe, expect, it } from "vitest"
import {
	DiscoveryStore,
	OBSERVATIONS_PER_DISCOVERY,
} from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import type { StoreMirrorRemoval } from "../../../../src/core/scanner/store/mirror-sink.js"
import type { StoreMutation } from "../../../../src/core/scanner/store/schemas.js"
import {
	classification,
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"
import { newCtx, step } from "./store-index-ops.js"

const CH = 446_100_000

function setup(max = 50) {
	const store = new DiscoveryStore({
		maxDiscoveries: max,
		now: () => 5_000_000,
		newId: counterIds(),
	})
	const entries: Omit<JournalEntry, "seq">[] = []
	const removals: StoreMirrorRemoval[] = []
	store.on("mutation", (e: Omit<JournalEntry, "seq">) => entries.push(e))
	store.on("mirror-removal", (r: StoreMirrorRemoval) => removals.push(r))
	return { store, entries, removals }
}

const fm = (id: string, startedAt: number, extra = {}) =>
	makeObs({
		id,
		centreHz: CH,
		startedAt,
		cls: "analog-fm",
		hypotheses: [["analog-fm", 0.9]],
		...extra,
	})

describe("discovery store change detection (WG11 SC, req 3.4)", () => {
	it("reports no change (and journals nothing) for a repeated classification, evidence or re-ingest", () => {
		const { store, entries } = setup()
		const obs = fm("o1", 1_000)
		const id = store.ingest(obs).discoveryId ?? ""
		const c = classification("analog-fm", [["analog-fm", 0.9]])
		store.applyClassification(id, c)
		const before = entries.length
		expect(store.applyClassification(id, c)).toBeNull()
		expect(store.ingest(obs)).toEqual({ discoveryId: id, change: "updated" })
		const ev = evidence("analog-fm", 2_000, { talkgroups: ["1"] })
		store.applyEvidence(id, ev)
		const afterEv = entries.length
		expect(store.applyEvidence(id, ev)).toBeNull()
		expect(store.appendObservationEvidence("o1", ev)).toBe(true)
		expect(store.appendObservationEvidence("o1", { ...ev })).toBe(false)
		expect(entries.length).toBe(afterEv + 1)
		expect(before).toBeLessThanOrEqual(afterEv)
	})

	it("a hypothesis does not raise confidence, and a repeated classification is no change", () => {
		const { store, entries } = setup()
		const id =
			store.ingest(fm("o1", 1_000, { cap: "adjacent-leak", tier: "channel" }))
				.discoveryId ?? ""
		expect(store.get(id)?.protocol).toBe("unknown")
		expect(store.get(id)?.confidence).toBe("activity")
		expect(store.get(id)?.confidenceCap).toBe("adjacent-leak")
		const n = entries.length
		expect(
			store.applyClassification(
				id,
				classification("analog-fm", [["analog-fm", 0.9]], undefined, "channel"),
			),
		).toBeNull()
		expect(entries.length).toBe(n)
		expect(store.get(id)?.confidence).toBe("activity")
	})

	it("still journals a real change: a new talkgroup order, a moved centre, a joined job", () => {
		const { store, entries } = setup()
		const obs = fm("o1", 1_000)
		const id = store.ingest(obs).discoveryId ?? ""
		const dmr = evidence("dmr", 2_000, {
			identity: dmrCc(1),
			talkgroups: ["1", "2"],
		})
		store.applyEvidence(id, dmr)
		let n = entries.length
		// same members, new LRU order
		expect(
			store.applyEvidence(id, { ...dmr, metadata: { talkgroups: ["1"] } }),
		).toBe("updated")
		expect(entries.length).toBe(n + 1)
		expect(store.get(id)?.metadata.talkgroups).toEqual(["2", "1"])
		n = entries.length
		store.ingest({ ...obs, jobIds: ["job-1", "job-2"] })
		expect(entries.length).toBe(n + 1)
		n = entries.length
		store.ingest({
			...obs,
			jobIds: ["job-1", "job-2"],
			track: { ...obs.track, centreHz: CH + 40 },
		})
		expect(entries.length).toBe(n + 1)
	})
})

describe("discovery store copies (WG11 SC, req 3.4)", () => {
	it("get, list, observations, events and journal payloads never alias internal state", () => {
		const { store, entries } = setup(3)
		const evicted: unknown[] = []
		store.on("evicted", (l: unknown[]) => evicted.push(...l))
		const id = store.ingest(fm("o1", 1_000)).discoveryId ?? ""
		const ev = evidence("analog-fm", 1_500, { talkgroups: ["7"] })
		store.appendObservationEvidence("o1", ev)
		const snap = JSON.stringify(store.snapshot())
		// mutate everything handed out
		const got = store.get(id)
		if (got !== undefined) {
			got.jobIds.push("x")
			got.signal.best.snrDb = 999
		}
		const listed = store.list({}).items[0]
		if (listed !== undefined) listed.metadata.talkgroups.push("x")
		const o = store.observations(id, null, 10).items[0]
		if (o !== undefined) {
			o.jobIds.push("x")
			o.decode?.push(ev)
		}
		ev.metadata.talkgroups?.push("x")
		for (const e of entries) {
			const p = e.payload as StoreMutation
			for (const d of p.discoveries) d.jobIds.push("x")
			for (const x of p.observations) x.recordingIds.push("x")
		}
		const s = store.snapshot()
		s.discoveries[0]?.jobIds.push("x")
		expect(JSON.stringify(store.snapshot())).toBe(snap)
		// later payloads are fresh copies too
		store.ingest(fm("o2", 3_000))
		const last = entries.at(-1)?.payload as StoreMutation
		expect(last.discoveries[0]?.jobIds).toEqual(["job-1"])
		// an evicted list is a copy
		for (let i = 0; i < 4; i++)
			store.ingest(
				fm(`e${i}`, 10_000 + i, { centreHz: CH + 100_000 * (i + 1) }),
			)
		expect(evicted.length).toBeGreaterThan(0)
		const victim = evicted[0] as { jobIds: string[] }
		victim.jobIds.push("x")
		expect(JSON.stringify(store.snapshot())).not.toContain('"x"')
	})
})

describe("mirror removal and record counts (WG11 SC, req 3.5)", () => {
	it("reports observations trimmed from the 256 window and those of a deleted discovery", () => {
		const { store, removals, entries } = setup()
		let id = ""
		for (let i = 0; i < 260; i++)
			id =
				store.ingest(fm(`o${String(i).padStart(3, "0")}`, 1_000 + i * 2_000))
					.discoveryId ?? id
		const trimmed = removals.flatMap(r => r.observations)
		expect(trimmed).toEqual(["o000", "o001", "o002", "o003"])
		expect(store.recordCounts()).toEqual({ discoveries: 1, observations: 256 })
		const n = entries.length
		store.delete(id)
		expect(entries.length).toBe(n + 1)
		expect(removals.at(-1)?.observations.length).toBe(256)
		expect(removals.at(-1)?.discoveries).toEqual([])
		expect(store.recordCounts()).toEqual({ discoveries: 0, observations: 0 })
	})

	it("a mirror fed by journal payloads plus mirror removals always holds snapshot()'s ids and recordCounts", () => {
		for (const seed of [3, 11, 29]) {
			const ctx = newCtx(seed)
			let mirrorD = new Set<string>()
			let mirrorO = new Set<string>()
			let attached: unknown = null
			const reset = (): void => {
				const snap = ctx.store.snapshot()
				mirrorD = new Set(snap.discoveries.map(d => d.id))
				mirrorO = new Set(snap.observations.map(o => o.id))
			}
			const attach = (): void => {
				attached = ctx.store
				ctx.store.on("mutation", (e: Omit<JournalEntry, "seq">) => {
					const p = e.payload as StoreMutation
					for (const d of p.discoveries) mirrorD.add(d.id)
					for (const o of p.observations) mirrorO.add(o.id)
					for (const id of p.removedObservations ?? []) mirrorO.delete(id)
					for (const id of p.deleted) mirrorD.delete(id)
				})
				ctx.store.on("mirror-removal", (r: StoreMirrorRemoval) => {
					for (const id of r.discoveries) mirrorD.delete(id)
					for (const id of r.observations) mirrorO.delete(id)
				})
			}
			reset()
			attach()
			for (let n = 0; n < 250; n++) {
				step(ctx)
				if (ctx.store !== attached) {
					// restore/replay replaced the store: a mirror resets from a full snapshot
					reset()
					attach()
				}
				const snap = ctx.store.snapshot()
				expect([...mirrorD].sort()).toEqual(snap.discoveries.map(d => d.id))
				expect([...mirrorO].sort()).toEqual(
					snap.observations.map(o => o.id).sort(),
				)
				expect(ctx.store.recordCounts()).toEqual({
					discoveries: snap.discoveries.length,
					observations: snap.observations.length,
				})
			}
		}
	}, 60_000)
})

describe("snapshot parts (WG11 SC, req 3.5)", () => {
	it("snapshotParts equals snapshot()'s non-record fields, presence included, and is a copy", () => {
		for (const seed of [5, 17]) {
			const ctx = newCtx(seed)
			for (let n = 0; n < 150; n++) {
				step(ctx)
				const { discoveries, observations, ...rest } = ctx.store.snapshot()
				void discoveries
				void observations
				const parts = ctx.store.snapshotParts()
				expect(JSON.stringify(parts)).toBe(JSON.stringify(rest))
				expect(Object.keys(parts)).toEqual(Object.keys(rest))
				parts.corrections.push({ sourceId: "x", hz: 1 })
				parts.aliases?.[0]?.aliases.push("x")
				expect(JSON.stringify(ctx.store.snapshotParts())).toBe(
					JSON.stringify(rest),
				)
			}
		}
	})

	it("exports the per-discovery observation window", () => {
		expect(OBSERVATIONS_PER_DISCOVERY).toBe(256)
	})
})
