// Band inspection UX req 3.3: the store revision on every discovery read, answer and event.
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ScannerDiscoveryEventData } from "@wavekit/api-types"
import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import { createLogger } from "../../../../src/utils/logger.js"
import {
	CENTRE,
	feedTone,
	serviceHarness,
	tick,
} from "../../../mocks/scanner/service-fakes.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"
import { T0, legacySnapshot, storeOf } from "./consolidation-fixtures.js"

const CH = 446_006_250

/** Checks every change and eviction the store publishes; returns the record of what it saw. */
function watch(store: DiscoveryStore) {
	const last = new Map<string, number>()
	let high = store.currentRevision()
	const seen: { id: string; change: string; revision: number }[] = []
	const check = (id: string, change: string, revision: number) => {
		expect(revision).toBeGreaterThan(last.get(id) ?? 0)
		expect(revision).toBeGreaterThanOrEqual(high)
		high = revision
		last.set(id, revision)
		seen.push({ id, change, revision })
	}
	store.on("change", (id: string, change: string) => {
		const d = store.get(id)
		// a removed record's revision is the store's at its removal
		const revision = d?.revision ?? store.currentRevision()
		if (d) expect(d.revision).toBe(store.currentRevision())
		check(id, change, revision)
	})
	store.on("evicted", (list: { id: string; revision?: number }[]) => {
		// the same removal as the `deleted` change just seen, at the same revision
		for (const d of list) {
			expect(d.revision).toBe(store.currentRevision())
			expect(last.get(d.id)).toBe(d.revision)
			seen.push({ id: d.id, change: "evicted", revision: d.revision! })
		}
	})
	return { seen, last }
}

describe("discovery store revision (band inspection UX req 3.3)", () => {
	it("strictly increases per record over ingest, operator edit, evidence flags, delete and eviction", () => {
		const store = new DiscoveryStore({
			maxDiscoveries: 3,
			now: () => T0,
			newId: counterIds(),
		})
		const { seen } = watch(store)
		const ids: string[] = []
		for (let i = 0; i < 4; i++) {
			const r = store.ingest(
				makeObs({
					id: `o${i}`,
					centreHz: CH + i * 100_000,
					startedAt: T0 + i * 1_000,
					blocks: 3,
				}),
			)
			if (r.discoveryId) ids.push(r.discoveryId)
		}
		// the fourth record evicted the oldest (maxDiscoveries 3)
		expect(seen.some(s => s.change === "evicted")).toBe(true)
		const live = ids.filter(id => store.get(id) !== undefined)
		expect(live.length).toBeGreaterThanOrEqual(2)
		const [a, b] = live as [string, string]
		const before = store.get(a)!.revision!
		const edited = store.setOperator(a, { label: "x" })
		expect(edited.revision).toBeGreaterThan(before)
		expect(store.get(a)!.revision).toBe(edited.revision)
		// a read changes nothing
		expect(store.get(a)!.revision).toBe(edited.revision)
		store.setEvidenceFlags(a, { psd: true })
		expect(store.get(a)!.revision).toBeGreaterThan(edited.revision!)
		store.setUndecodedReason(a, "timeout")
		const again = store.ingest(
			makeObs({
				id: "o-again",
				centreHz: CH + 100_000,
				startedAt: T0 + 9_000,
				blocks: 3,
			}),
		)
		expect(again.discoveryId).not.toBeNull()
		const atDelete = store.currentRevision()
		expect(store.delete(b)).toBe(true)
		expect(store.currentRevision()).toBeGreaterThan(atDelete)
		expect(store.get(b)).toBeUndefined()
		expect(seen.length).toBeGreaterThan(6)
	})

	it("a merge gives the survivor a new revision and removes the absorbed ids at the same one", () => {
		const F = 446_042_000
		const { store } = storeOf([
			{ id: "d_a", centreHz: F, count: 40, peakDbfs: -52 },
			{ id: "d_b", centreHz: F + 270, count: 40, peakDbfs: -52 },
		])
		const before = store.get("d_a")!.revision!
		const changes: [string, string, number][] = []
		store.on("change", (id: string, change: string) =>
			changes.push([id, change, store.currentRevision()]),
		)
		store.applyConsolidation(store.consolidationPlan())
		const after = store.get("d_a")!.revision!
		expect(after).toBeGreaterThan(before)
		expect(after).toBe(store.currentRevision())
		expect(changes).toContainEqual(["d_a", "merged", after])
		expect(changes).toContainEqual(["d_b", "deleted", after])
	})

	it("never journals or snapshots the revision; a restore starts a new epoch at revision 1", () => {
		const store = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => T0,
			newId: counterIds(),
		})
		const lines: string[] = []
		store.on("mutation", (e: unknown) => lines.push(JSON.stringify(e)))
		const id = store.ingest(
			makeObs({ id: "o1", centreHz: CH, startedAt: T0, blocks: 3 }),
		).discoveryId!
		store.setOperator(id, { label: "kept" })
		expect(store.get(id)!.revision).toBeGreaterThan(1)
		const snapshot = store.snapshot()
		for (const line of [...lines, JSON.stringify(snapshot)])
			expect(line).not.toMatch(/"(revision|storeEpoch|storeRevision)"/)
		const epoch = store.storeEpoch
		const reader = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => T0,
			newId: counterIds(),
		})
		const readerEpoch = reader.storeEpoch
		reader.restore(snapshot)
		expect(reader.storeEpoch).not.toBe(readerEpoch)
		expect(reader.storeEpoch).not.toBe(epoch)
		expect(reader.get(id)!.revision).toBe(1)
		expect(reader.currentRevision()).toBe(1)
	})
})

describe("ScannerService revision on answers and events (band inspection UX req 3.3)", () => {
	const inWindow = {
		sourceId: "rtl",
		mode: "in-window" as const,
		ranges: [{ startHz: 446_000_000, endHz: 446_300_000 }],
	}

	it("list, detail, PATCH and every discovery event carry the epoch and an increasing revision", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		try {
			await h.service.start()
			const events: ScannerDiscoveryEventData[] = []
			h.service.on("discovery", (e: ScannerDiscoveryEventData) =>
				events.push(e),
			)
			await h.service.createJob(inWindow)
			feedTone(h.fanout, 2, 93_750)
			await tick(1500)
			const page = h.service.listDiscoveries({})
			const d = page.items.find(
				x => Math.abs(x.frequencyHz - (CENTRE + 93_750)) < 2_000,
			)!
			expect(d).toBeDefined()
			const epoch = page.storeEpoch
			expect(typeof epoch).toBe("string")
			for (const item of page.items)
				expect(item.revision).toBeLessThanOrEqual(page.storeRevision)
			const detail = h.service.getDiscovery(d.id)!
			expect(detail).toMatchObject({ storeEpoch: epoch, revision: d.revision })
			const patched = await h.service.patchDiscovery(d.id, { label: "x" })
			expect(patched.revision).toBeGreaterThan(d.revision!)
			expect(patched.storeEpoch).toBe(epoch)
			expect(patched.storeRevision).toBeGreaterThanOrEqual(patched.revision!)
			expect(await h.service.deleteDiscovery(d.id)).toBe(true)
			expect(events.length).toBeGreaterThan(0)
			const last = new Map<string, number>()
			for (const e of events) {
				expect(e.storeEpoch).toBe(epoch)
				expect(typeof e.revision).toBe("number")
				if (e.change !== "deleted")
					expect(e.revision).toBe(e.discovery.revision)
				expect(e.revision!).toBeGreaterThan(last.get(e.discovery.id) ?? 0)
				last.set(e.discovery.id, e.revision!)
			}
			const mine = events.filter(e => e.discovery.id === d.id)
			const edit = mine.find(e => e.discovery.operator?.label === "x")
			expect(edit?.revision).toBe(patched.revision)
			const gone = mine.at(-1)!
			expect(gone.change).toBe("deleted")
			expect(gone.revision!).toBeGreaterThan(patched.revision!)
		} finally {
			await h.service.stop()
		}
	})

	it("a startup merge event carries the survivor's revision and the store's epoch", async () => {
		const F = 446_042_000
		const dir = mkdtempSync(join(tmpdir(), "rev-svc-"))
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
			try {
				await h.service.start()
				const events: ScannerDiscoveryEventData[] = []
				h.service.on("discovery", (e: ScannerDiscoveryEventData) =>
					events.push(e),
				)
				await new Promise(r => setImmediate(r))
				const merged = events.find(e => e.change === "merged")
				expect(merged).toBeDefined()
				const survivor = h.service.getDiscovery("d_a")!
				expect(merged!.mergedIds).toEqual(["d_b"])
				expect(merged!.revision).toBe(survivor.revision)
				expect(merged!.storeEpoch).toBe(survivor.storeEpoch)
			} finally {
				await h.service.stop()
			}
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
