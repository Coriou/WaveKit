// WG10 req 1.5: merge aliases through the real DiscoveryStore, EvidenceStore and ScannerPersistence.
import { DISCOVERY_MERGED_IDS_MAX } from "@wavekit/api-types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	JournalEntry,
	StoreSnapshot,
} from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import { DISCOVERY_RECORDING_ALIASES_MAX } from "../../../../src/core/recordings/contract.js"
import { aliasAwareProtection } from "../../../../src/core/scanner/recording-aliases.js"
import { createLogger } from "../../../../src/utils/logger.js"
import type { Logger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const PMR = [{ spacingHz: 12_500, firstChannelHz: CH }]
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const DAY = 86_400_000
const quiet = createLogger({ level: "fatal" })

function fakeLogger(): { logger: Logger; logs: unknown[][] } {
	const logs: unknown[][] = []
	const l: Record<string, unknown> = {}
	for (const level of ["warn", "info", "debug", "error", "trace", "fatal"])
		l[level] = vi.fn((...args: unknown[]) => {
			logs.push([level, ...args])
		})
	l["child"] = () => l
	return { logger: l as unknown as Logger, logs }
}

const dmrObs = (id: string, centreHz: number, startedAt: number) =>
	makeObs({
		id,
		centreHz,
		startedAt,
		cls: "fsk4-12k5",
		hypotheses: [["dmr", 0.8]],
	})

interface Built {
	store: DiscoveryStore
	entries: JournalEntry[]
	logs: unknown[][]
}

function newStore(holdsKept?: (id: string) => boolean): Built {
	const { logger, logs } = fakeLogger()
	const entries: JournalEntry[] = []
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
		rasters: () => PMR,
		logger,
		...(holdsKept ? { discoveryHoldsKept: holdsKept } : {}),
	})
	store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
		entries.push({ ...e, seq: entries.length + 1 }),
	)
	return { store, entries, logs }
}

/** S (first heard) and D (later, 3.5 kHz up) merge once a 3 kHz correction lands: D into S. */
function mergedPair(b: Built): { survivor: string; dropped: string } {
	const survivor = b.store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
	const dropped =
		b.store.ingest(dmrObs("o2", CH + 3_500, T0 + 1_000)).discoveryId ?? ""
	expect(b.store.rekey("src-1", 3_000)).toEqual({
		merged: [[survivor, dropped]],
	})
	return { survivor, dropped }
}

/** A copy of discovery `from` (and its observations) under a new id, first heard at `firstSeen`. */
function cloneInto(
	s: StoreSnapshot,
	from: string,
	id: string,
	firstSeen: number,
): StoreSnapshot {
	const d = s.discoveries.find(x => x.id === from)
	if (!d) throw new Error("no source discovery")
	const at = new Date(firstSeen).toISOString()
	const obs = s.observations
		.filter(o => o.discoveryId === from)
		.map((o, i) => ({
			...structuredClone(o),
			id: `${id}-o${i}`,
			discoveryId: id,
		}))
	return {
		...s,
		discoveries: [
			...s.discoveries,
			{ ...structuredClone(d), id, firstSeenAt: at, lastSeenAt: at },
		],
		observations: [...s.observations, ...obs],
	}
}

const roots: string[] = []
afterEach(async () => {
	for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

async function tmp(): Promise<string> {
	const r = await mkdtemp(join(tmpdir(), "wk-alias-"))
	roots.push(r)
	return r
}

async function put(
	root: string,
	rel: string,
	ageMs = 2 * DAY,
): Promise<string> {
	const path = join(root, rel)
	await mkdir(join(path, ".."), { recursive: true })
	await writeFile(path, "x".repeat(16))
	const t = (T0 - ageMs) / 1000
	await utimes(path, t, t)
	return path
}

/** Keys as `<folder id>/<file name>` (the keep-service key shape, one folder each). */
function keptPort(kept: Set<string>): RecordingProtection {
	return {
		isProtected: () => false,
		isDsdFmeFileProtected: () => false,
		isScannerFileProtected: (d, n) => kept.has(`${d}/${n}`),
		discoveryHoldsKept: d => [...kept].some(k => k.startsWith(`${d}/`)),
	}
}

function evidenceFor(
	root: string,
	b: Built,
	protection?: RecordingProtection,
	maxAgeDays = 30,
): EvidenceStore {
	return new EvidenceStore({
		dir: root,
		caps: {
			maxRecordingsMb: 512,
			maxEvidenceMb: 64,
			maxAgeDays,
			minFreeDiskMb: 0,
		},
		logger: quiet,
		now: () => T0,
		statfs: async () => ({ freeBytes: 1e12 }),
		isDiscoveryLive: id => b.store.get(id) !== undefined,
		aliases: {
			aliasOwner: id => b.store.aliasOwner(id),
			aliasesOf: id => b.store.aliasesOf(id),
			releaseAliases: id => b.store.releaseAliases(id),
		},
		...(protection ? { protection } : {}),
	})
}

describe("merge aliases in the discovery store (WG10 req 1.5)", () => {
	it("adopts the dropped id, persisted in the merge's journal entry and the snapshot", () => {
		const b = newStore()
		const { survivor, dropped } = mergedPair(b)
		expect(b.store.aliasesOf(survivor)).toEqual([dropped])
		expect(b.store.aliasOwner(dropped)).toBe(survivor)
		expect(b.store.aliasOwner(survivor)).toBeUndefined()
		const entry = b.entries.at(-1)
		expect(entry?.op).toBe("rekey")
		expect((entry?.payload as { aliases?: unknown }).aliases).toEqual([
			{ id: survivor, aliases: [dropped] },
			{ id: dropped, aliases: [] },
		])
		expect(b.store.snapshot().aliases).toEqual([
			{ id: survivor, aliases: [dropped] },
		])
	})

	it("a store without merges writes no alias field (snapshot and entries unchanged)", () => {
		const b = newStore()
		b.store.ingest(dmrObs("o1", CH, T0))
		expect(b.store.snapshot()).not.toHaveProperty("aliases")
		for (const e of b.entries) expect(e.payload).not.toHaveProperty("aliases")
	})

	it("a merge chain A into B, B into C leaves C with both", () => {
		const first = newStore()
		const { survivor: bId, dropped: aId } = mergedPair(first)
		const second = newStore()
		second.store.restore(
			cloneInto(first.store.snapshot(), bId, "d_C", T0 - 60_000),
		)
		expect(second.store.aliasesOf(bId)).toEqual([aId])
		expect(second.store.rekey("src-1", 3_000).merged).toEqual([["d_C", bId]])
		expect(second.store.aliasesOf("d_C")).toEqual([aId, bId])
		expect(second.store.aliasesOf(bId)).toEqual([])
		expect(second.store.aliasOwner(aId)).toBe("d_C")
		expect(second.store.aliasOwner(bId)).toBe("d_C")
		// replaying the same entries in a fresh store gives the same table
		const replayed = newStore()
		replayed.store.restore(
			cloneInto(first.store.snapshot(), bId, "d_C", T0 - 60_000),
		)
		for (const [i, e] of second.entries.entries())
			replayed.store.replay(
				JSON.parse(JSON.stringify({ ...e, seq: i + 1 })) as JournalEntry,
			)
		expect(replayed.store.aliasesOf("d_C")).toEqual([aId, bId])
		expect(replayed.store.aliasOwner(aId)).toBe("d_C")
	})

	const withAliases = (n: number): Built & { survivor: string } => {
		const first = newStore()
		const { survivor, dropped } = mergedPair(first)
		const snap = first.store.snapshot()
		const old = Array.from(
			{ length: n },
			(_, i) => `d_OLD${String(i).padStart(2, "0")}`,
		)
		const b = newStore()
		b.store.restore(
			cloneInto(
				{
					...snap,
					discoveries: snap.discoveries,
					aliases: [{ id: survivor, aliases: [...old, dropped] }],
				},
				survivor,
				"d_ZLATE",
				T0 + 5 * 60_000,
			),
		)
		return { ...b, survivor }
	}

	it("64 aliases: at the bound nothing is released and nothing warns", () => {
		const b = withAliases(DISCOVERY_RECORDING_ALIASES_MAX - 2)
		expect(b.store.aliasesOf(b.survivor)).toHaveLength(63)
		expect(b.store.rekey("src-1", 3_000).merged).toEqual([
			[b.survivor, "d_ZLATE"],
		])
		const list = b.store.aliasesOf(b.survivor)
		expect(list).toHaveLength(64)
		expect(list.at(-1)).toBe("d_ZLATE")
		expect(b.logs.filter(l => l[0] === "warn")).toEqual([])
	})

	it("65 aliases: the oldest is released (an orphan) with one counted warn naming no id", () => {
		const b = withAliases(DISCOVERY_RECORDING_ALIASES_MAX - 1)
		expect(b.store.aliasesOf(b.survivor)).toHaveLength(64)
		b.store.rekey("src-1", 3_000)
		const list = b.store.aliasesOf(b.survivor)
		expect(list).toHaveLength(64)
		expect(list[0]).toBe("d_OLD01")
		expect(list.at(-1)).toBe("d_ZLATE")
		expect(b.store.aliasOwner("d_OLD00")).toBeUndefined()
		const warns = b.logs.filter(l => l[0] === "warn")
		expect(warns).toEqual([
			[
				"warn",
				{ released: 1 },
				"Discovery merge aliases over the bound; the oldest were released",
			],
		])
		expect(JSON.stringify(warns)).not.toMatch(/d_/)
	})

	it("old state without aliases loads as no aliases; a hostile alias table is cleaned", () => {
		const first = newStore()
		mergedPair(first)
		const snap = first.store.snapshot()
		const { aliases: _drop, ...legacy } = snap
		const b = newStore()
		b.store.restore(legacy)
		expect(b.store.snapshot()).not.toHaveProperty("aliases")
		const live = snap.discoveries[0]?.id ?? ""
		b.store.restore({
			...legacy,
			aliases: [
				{ id: "d_DEAD", aliases: ["d_X"] }, // owner not live: dropped
				{ id: live, aliases: [live, "d_Y", "d_Y", "d_Z"] }, // self, repeat
			],
		})
		expect(b.store.aliasesOf(live)).toEqual(["d_Y", "d_Z"])
		expect(b.store.aliasOwner("d_X")).toBeUndefined()
	})

	it("restart restores aliases from the persisted snapshot and from the journal", async () => {
		const dir = await tmp()
		const b = newStore()
		const p = new ScannerPersistence({ dir, logger: quiet, now: () => T0 })
		await p.load()
		const { survivor, dropped } = mergedPair(b)
		// journal only (no snapshot yet)
		for (const e of b.entries) await p.append(e)
		const again = new ScannerPersistence({ dir, logger: quiet, now: () => T0 })
		const loaded = await again.load()
		const fromJournal = newStore()
		fromJournal.store.restore(loaded)
		for (const e of loaded.entries) fromJournal.store.replay(e)
		expect(fromJournal.store.aliasesOf(survivor)).toEqual([dropped])
		expect(fromJournal.store.aliasOwner(dropped)).toBe(survivor)
		// snapshot
		await again.writeSnapshot(fromJournal.store.snapshot())
		const third = new ScannerPersistence({ dir, logger: quiet, now: () => T0 })
		const fromSnapshot = await third.load()
		expect(fromSnapshot.aliases).toEqual([{ id: survivor, aliases: [dropped] }])
		const restored = newStore()
		restored.store.restore(fromSnapshot)
		expect(restored.store.aliasOwner(dropped)).toBe(survivor)
	})

	it("deleting the owner detaches its aliases (not admitted) until released", () => {
		const b = newStore()
		const { survivor, dropped } = mergedPair(b)
		expect(b.store.delete(survivor)).toBe(true)
		expect(b.store.aliasOwner(dropped)).toBeUndefined()
		expect(b.store.aliasesOf(survivor)).toEqual([dropped])
		b.store.releaseAliases(survivor)
		expect(b.store.aliasesOf(survivor)).toEqual([])
	})

	it("replaying a non-merge delete of an owner leaves the same alias table as runtime and snapshot (nothing stays detached)", () => {
		const b = newStore()
		const { survivor, dropped } = mergedPair(b)
		const other = newStore()
		const kept = mergedPair(other)
		expect(b.store.delete(survivor)).toBe(true)
		// runtime: the owner's removal settled and released its aliases
		b.store.releaseAliases(survivor)
		const table = (s: DiscoveryStore) => ({
			survivor: s.aliasesOf(survivor),
			owner: s.aliasOwner(dropped),
			persisted: s.snapshot().aliases ?? [],
		})
		const runtime = table(b.store)
		expect(runtime).toEqual({ survivor: [], owner: undefined, persisted: [] })
		const replayed = newStore()
		for (const e of b.entries)
			replayed.store.replay(JSON.parse(JSON.stringify(e)) as JournalEntry)
		expect(table(replayed.store)).toEqual(runtime)
		const restored = newStore()
		restored.store.restore(b.store.snapshot())
		expect(table(restored.store)).toEqual(runtime)
		// a live owner's aliases still replay as written
		const live = newStore()
		for (const e of other.entries)
			live.store.replay(JSON.parse(JSON.stringify(e)) as JournalEntry)
		expect(live.store.aliasesOf(kept.survivor)).toEqual([kept.dropped])
		expect(live.store.aliasOwner(kept.dropped)).toBe(kept.survivor)
	})

	it("a merged change carries the absorbed id", () => {
		const b = newStore()
		const events: {
			id: string
			change: string
			mergedIds?: readonly string[]
		}[] = []
		b.store.on(
			"change",
			(id: string, change: string, mergedIds?: readonly string[]) => {
				events.push(
					mergedIds === undefined
						? { id, change }
						: { id, change, mergedIds: [...mergedIds] },
				)
			},
		)
		const { survivor, dropped } = mergedPair(b)
		expect(events.filter(e => e.change === "merged")).toEqual([
			{ id: survivor, change: "merged", mergedIds: [dropped] },
		])
		for (const event of events)
			if (event.change !== "merged") expect(event.mergedIds).toBeUndefined()
	})

	it("caps mergedIds at 64 after sorting, and keeps 64", () => {
		for (const count of [
			DISCOVERY_MERGED_IDS_MAX,
			DISCOVERY_MERGED_IDS_MAX + 1,
		]) {
			const b = newStore()
			const survivor =
				b.store.ingest(dmrObs("o-keep", CH, T0)).discoveryId ?? ""
			expect(survivor).not.toBe("")
			let snap = b.store.snapshot()
			const absorbed: string[] = []
			for (let i = 0; i < count; i++) {
				const id = `a${String(i).padStart(2, "0")}`
				absorbed.push(id)
				const from = snap.discoveries.find(d => d.id === survivor)
				if (from === undefined) throw new Error("survivor left the snapshot")
				const at = new Date(T0 + (i + 1) * 1_000).toISOString()
				const obs = snap.observations
					.filter(o => o.discoveryId === survivor)
					.map((o, n) => ({
						...structuredClone(o),
						id: `${id}-o${n}`,
						discoveryId: id,
					}))
				snap = {
					...snap,
					discoveries: [
						...snap.discoveries,
						{
							...structuredClone(from),
							id,
							firstSeenAt: at,
							lastSeenAt: at,
							coChannel: [],
						},
					],
					observations: [...snap.observations, ...obs],
				}
			}
			b.store.restore(snap)
			const events: {
				id: string
				change: string
				mergedIds?: readonly string[]
			}[] = []
			b.store.on(
				"change",
				(id: string, change: string, mergedIds?: readonly string[]) => {
					events.push(
						mergedIds === undefined
							? { id, change }
							: { id, change, mergedIds: [...mergedIds] },
					)
				},
			)
			expect(b.store.rekey("src-1", 0).merged).toHaveLength(count)
			const merged = events.filter(e => e.change === "merged")
			const sorted = [...absorbed].sort((a, c) => (a < c ? -1 : a > c ? 1 : 0))
			expect(merged).toEqual([
				{
					id: survivor,
					change: "merged",
					mergedIds: sorted.slice(0, DISCOVERY_MERGED_IDS_MAX),
				},
			])
			for (const event of events)
				if (event.change !== "merged") expect(event.mergedIds).toBeUndefined()
		}
	})
})

describe("alias folders in the evidence store (WG10 req 1.5)", () => {
	it("retention protects an alias folder of a kept survivor and resolves alias recordingPath", async () => {
		const root = await tmp()
		const b = newStore()
		const { survivor, dropped } = mergedPair(b)
		const old = await put(root, `recordings/dv/${dropped}/old.wav`, 40 * DAY)
		const own = await put(root, `recordings/dv/${survivor}/old.wav`, 40 * DAY)
		const ev = evidenceFor(root, b)
		expect(ev.recordingPath(`${dropped}~old.wav`)).toBe(old)
		const { deleted } = await ev.retention(new Set([survivor]))
		expect(deleted).toEqual([])
		expect(existsSync(old) && existsSync(own)).toBe(true)
		// without the operator keep the alias folder ages out like the owner's
		expect((await ev.retention(new Set())).deleted.sort()).toEqual(
			[
				`recordings/dv/${dropped}/old.wav`,
				`recordings/dv/${survivor}/old.wav`,
			].sort(),
		)
	})

	it("holdsKept via an alias refuses the survivor's removal (409) and leaves every folder", async () => {
		const root = await tmp()
		const kept = new Set<string>()
		const b = newStore()
		const { survivor, dropped } = mergedPair(b)
		const port = aliasAwareProtection(keptPort(kept), id =>
			b.store.aliasesOf(id),
		)
		const own = await put(root, `recordings/dv/${survivor}/a.wav`)
		const aliasFile = await put(root, `recordings/dv/${dropped}/k.wav`)
		kept.add(`${dropped}/k.wav`)
		expect(port.discoveryHoldsKept(survivor)).toBe(true)
		const ev = evidenceFor(root, b, keptPort(kept))
		await expect(ev.removeDiscovery(survivor)).rejects.toMatchObject({
			statusCode: 409,
		})
		expect(existsSync(own) && existsSync(aliasFile)).toBe(true)
		// the keep store's discovery store also skips it on prune (WG9 2.6 via aliases)
		const pruning = newStore(id => port.discoveryHoldsKept(id))
		pruning.store.restore(b.store.snapshot())
		expect(pruning.store.pruneInactive(0)).toEqual([])
	})

	it("removing the survivor removes its own and every alias folder through the per-file decision", async () => {
		const root = await tmp()
		const kept = new Set<string>()
		const b = newStore()
		const { survivor, dropped } = mergedPair(b)
		await put(root, `recordings/dv/${survivor}/a.wav`)
		await put(root, `recordings/dv/${dropped}/b.wav`)
		await put(root, `evidence/${dropped}/psd.json`)
		const decided: string[] = []
		const port = keptPort(kept)
		const spy: RecordingProtection = {
			...port,
			isScannerFileProtected: (d, n) => {
				decided.push(`${d}/${n}`)
				return port.isScannerFileProtected(d, n)
			},
		}
		const ev = evidenceFor(root, b, spy)
		expect(b.store.delete(survivor)).toBe(true)
		await ev.removeDiscovery(survivor)
		expect(decided.sort()).toEqual(
			[`${dropped}/b.wav`, `${survivor}/a.wav`].sort(),
		)
		for (const rel of [
			`recordings/dv/${survivor}`,
			`recordings/dv/${dropped}`,
			`evidence/${dropped}`,
		])
			expect(existsSync(join(root, rel))).toBe(false)
		// released after the removal settled
		expect(b.store.aliasesOf(survivor)).toEqual([])
	})

	it("a kept alias file met during the removal (Keep after the pre-check) refuses and stays", async () => {
		const root = await tmp()
		const b = newStore()
		const { survivor, dropped } = mergedPair(b)
		const aliasFile = await put(root, `recordings/dv/${dropped}/k.wav`)
		const late: RecordingProtection = {
			...keptPort(new Set()),
			isScannerFileProtected: (d, n) => d === dropped && n === "k.wav",
		}
		const ev = evidenceFor(root, b, late)
		await expect(ev.removeDiscovery(survivor)).rejects.toMatchObject({
			statusCode: 409,
		})
		expect(existsSync(aliasFile)).toBe(true)
	})

	it("a failed owner removal keeps the aliases (no orphan); the retry removes the alias folder and then releases (Main minor 2)", async () => {
		const root = await tmp()
		const b = newStore()
		const { survivor, dropped } = mergedPair(b)
		const aliasFile = await put(root, `recordings/dv/${dropped}/k.wav`)
		let keptLate = true
		const late: RecordingProtection = {
			...keptPort(new Set()),
			isScannerFileProtected: (d, n) =>
				keptLate && d === dropped && n === "k.wav",
		}
		const ev = evidenceFor(root, b, late)
		b.store.delete(survivor)
		await expect(ev.removeDiscovery(survivor)).rejects.toMatchObject({
			statusCode: 409,
		})
		expect(existsSync(aliasFile)).toBe(true)
		expect(b.store.aliasesOf(survivor)).toEqual([dropped])
		keptLate = false
		await ev.removeDiscovery(survivor)
		expect(existsSync(join(root, `recordings/dv/${dropped}`))).toBe(false)
		expect(b.store.aliasesOf(survivor)).toEqual([])
	})

	it("legacy mode (no port) removes the alias folders too; an alias folder already gone is harmless", async () => {
		const root = await tmp()
		const b = newStore()
		const { survivor, dropped } = mergedPair(b)
		await put(root, `recordings/dv/${survivor}/a.wav`)
		const ev = evidenceFor(root, b)
		expect(existsSync(join(root, `recordings/dv/${dropped}`))).toBe(false)
		expect(ev.recordingPath(`${dropped}~x.wav`)).toBeNull()
		expect((await ev.retention(new Set([survivor]))).deleted).toEqual([])
		b.store.delete(survivor)
		await ev.removeDiscovery(survivor)
		expect(existsSync(join(root, `recordings/dv/${survivor}`))).toBe(false)
	})

	it("an alias is not admitted once its owner is gone or being removed", async () => {
		const root = await tmp()
		const b = newStore()
		const { survivor, dropped } = mergedPair(b)
		const f = await put(root, `recordings/dv/${dropped}/a.wav`)
		const ev = evidenceFor(root, b)
		expect(ev.recordingPath(`${dropped}~a.wav`)).toBe(f)
		b.store.delete(survivor)
		expect(ev.recordingPath(`${dropped}~a.wav`)).toBeNull()
	})

	it("deleteRecording resolves an alias id (the folder's own id) and deletes the verified file", async () => {
		const root = await tmp()
		const b = newStore()
		const { dropped } = mergedPair(b)
		const f = await put(root, `recordings/dv/${dropped}/a.wav`)
		const ev = evidenceFor(root, b, keptPort(new Set()))
		expect(await ev.deleteRecording(`${dropped}~a.wav`, () => true)).toBe(
			"deleted",
		)
		expect(existsSync(f)).toBe(false)
	})
})
