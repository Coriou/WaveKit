/**
 * Merge aliases past the 64 bound: an alias that owns an evidence or recording folder on disk is
 * never released, so its files keep their owner (listing, Keep, retention). Folders released
 * before this rule are re-attached at load from the journal's alias listings, then from the
 * observations listing their recordings; a folder nothing traces is kept and counted, and no
 * retention pass deletes a folder whose owner it cannot resolve.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DISCOVERY_RECORDING_ALIASES_MAX } from "../../../../src/core/recordings/contract.js"
import { RecordingAliasTable } from "../../../../src/core/scanner/recording-aliases.js"
import { readAliasHistory } from "../../../../src/core/scanner/store/alias-history.js"
import type { AnalogMetadataAdapter } from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	JournalEntry,
	StoreSnapshot,
} from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { StorageCaps } from "../../../../src/core/scanner/store/evidence-store.js"
import { FolderIndex } from "../../../../src/core/scanner/store/folder-index.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const logger = createLogger({ level: "fatal" })
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const DAY = 86_400_000
const BASE_HZ = 430_000_000
const MAX = DISCOVERY_RECORDING_ALIASES_MAX
const CAPS: StorageCaps = {
	maxRecordingsMb: 20,
	maxEvidenceMb: 20,
	maxAgeDays: 30,
	minFreeDiskMb: 0,
}
const dirs: string[] = []

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(d => rm(d, { recursive: true, force: true })),
	)
})

async function tempRoot(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "wavekit-orphan-")))
	dirs.push(root)
	return root
}

const ids = (n: number, prefix = "d_X"): string[] =>
	Array.from(
		{ length: n },
		(_, i) => `${prefix}${i.toString().padStart(3, "0")}`,
	)

describe("RecordingAliasTable.adopt at and past the bound", () => {
	/** Owner `d_K` gains `n` aliases one merge at a time, oldest first. */
	function fill(table: RecordingAliasTable, n: number): number {
		let released = 0
		for (const id of ids(n)) released += table.adopt("d_K", id)
		return released
	}

	it("at the bound nothing is released", () => {
		const table = new RecordingAliasTable()
		table.setFolderLookup(() => false)
		expect(fill(table, MAX)).toBe(0)
		expect(table.aliasesOf("d_K")).toHaveLength(MAX)
	})

	it("one past the bound: a folderless oldest is released", () => {
		const table = new RecordingAliasTable()
		table.setFolderLookup(() => false)
		expect(fill(table, MAX + 1)).toBe(1)
		expect(table.aliasesOf("d_K")).toHaveLength(MAX)
		expect(table.aliasOwner("d_X000")).toBeUndefined()
	})

	it("past the bound an alias with a folder is never released; the oldest folderless goes", () => {
		const table = new RecordingAliasTable()
		const withFolder = new Set(ids(10))
		table.setFolderLookup(id => withFolder.has(id))
		expect(fill(table, MAX + 1)).toBe(1)
		const list = table.aliasesOf("d_K")
		expect(list).toHaveLength(MAX)
		for (const id of withFolder) expect(table.aliasOwner(id)).toBe("d_K")
		// d_X010 is the oldest without a folder.
		expect(table.aliasOwner("d_X010")).toBeUndefined()
	})

	it("every alias with a folder: the list grows past the bound, nothing released", () => {
		const table = new RecordingAliasTable()
		table.setFolderLookup(() => true)
		expect(fill(table, 3 * MAX)).toBe(0)
		expect(table.aliasesOf("d_K")).toHaveLength(3 * MAX)
	})

	it("a throwing lookup answers 'owns a folder' (nothing released)", () => {
		const table = new RecordingAliasTable()
		table.setFolderLookup(() => {
			throw new Error("lookup failed")
		})
		expect(fill(table, MAX + 5)).toBe(0)
	})

	it("the folder index fails closed until its first listing", () => {
		const index = new FolderIndex()
		expect(index.holds("d_A")).toBe(true)
		const token = index.beginListing()
		index.mark("d_B")
		index.finishListing(token, ["d_A"])
		expect(index.holds("d_A")).toBe(true)
		expect(index.holds("d_B")).toBe(true)
		expect(index.holds("d_C")).toBe(false)
	})

	it("persisted lists past 64 restore and replay whole", () => {
		const table = new RecordingAliasTable()
		const list = ids(MAX + 30)
		table.restore([{ id: "d_K", aliases: list }], id => id === "d_K")
		expect(table.aliasesOf("d_K")).toEqual(list)
		table.set("d_K", list, id => id === "d_K")
		expect(table.aliasesOf("d_K")).toEqual(list)
	})
})

/** A store, an evidence store wired as the service wires them, and a folder per discovery. */
async function scene(opts: { folderAware: boolean }) {
	const root = await tempRoot()
	const clock = { now: T0 }
	const entries: JournalEntry[] = []
	const store = new DiscoveryStore({
		maxDiscoveries: 1_000,
		now: () => T0,
		newId: counterIds(),
		logger,
	})
	store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
		entries.push({ ...e, seq: entries.length + 1 }),
	)
	const ev = new EvidenceStore({
		dir: root,
		caps: CAPS,
		logger,
		now: () => clock.now,
		statfs: async () => ({ freeBytes: 1e12 }),
		isDiscoveryLive: id => store.get(id) !== undefined,
		aliases: {
			aliasOwner: id => store.aliasOwner(id),
			aliasesOf: id => store.aliasesOf(id),
			releaseAliases: id => store.releaseAliases(id),
			heldFileNames: (id, removing) => store.heldFileNames(id, removing),
			heldRecordingOwner: id => store.heldRecordingOwner(id),
		},
	})
	if (opts.folderAware) store.setFolderLookup(id => ev.folders.holds(id))
	let n = 0
	/** A new discovery with a dv recording and an evidence file of its own. */
	const discovery = async (): Promise<string> => {
		n++
		const id =
			store.ingest(
				makeObs({
					id: `o${n}`,
					centreHz: BASE_HZ + n * 100_000,
					startedAt: T0 + n * 1_000,
					cls: "analog-fm",
					open: false,
					gate: "passed",
				}),
			).discoveryId ?? ""
		expect(id).not.toBe("")
		const dv = join(root, "recordings", "dv", id)
		await mkdir(dv, { recursive: true })
		await writeFile(join(dv, "call.wav"), Buffer.alloc(4096))
		const evd = join(root, "evidence", id)
		await mkdir(evd, { recursive: true })
		await writeFile(join(evd, "psd.json"), "{}")
		store.attachRecordings(`o${n}`, [`${id}~call.wav`], "linked")
		return id
	}
	const merge = (survivor: string, member: string): void => {
		const r = store.applyConsolidation({
			groups: [{ survivor, members: [member] }],
		})
		expect(r.absorbed).toBe(1)
	}
	return { root, clock, store, ev, entries, discovery, merge }
}

type Scene = Awaited<ReturnType<typeof scene>>

/** The survivor absorbs `count` discoveries, each with its own folders. */
async function absorbMany(
	s: Scene,
	count: number,
): Promise<{
	survivor: string
	merged: string[]
}> {
	const survivor = await s.discovery()
	await s.ev.loadFolderIndex()
	const merged: string[] = []
	for (let i = 0; i < count; i++) {
		const id = await s.discovery()
		await s.ev.loadFolderIndex()
		s.merge(survivor, id)
		merged.push(id)
	}
	return { survivor, merged }
}

async function ageAll(root: string, merged: readonly string[]): Promise<void> {
	const old = new Date(T0 - 60 * DAY)
	for (const id of merged) {
		await utimes(join(root, "recordings", "dv", id, "call.wav"), old, old)
		await utimes(join(root, "evidence", id, "psd.json"), old, old)
	}
}

describe("a survivor at and past the alias bound keeps every merged folder", () => {
	for (const count of [MAX, MAX + 1, 2 * MAX + 7]) {
		it(`${count} merges: every recording still lists under the survivor`, async () => {
			const s = await scene({ folderAware: true })
			const { survivor, merged } = await absorbMany(s, count)
			expect(s.store.aliasesOf(survivor)).toHaveLength(count)
			for (const id of merged) {
				expect(s.store.aliasOwner(id)).toBe(survivor)
				expect(s.ev.recordingPath(`${id}~call.wav`)).not.toBeNull()
				expect(s.ev.evidencePath(id, "psd.json")).not.toBeNull()
			}
		})
	}

	it("folderless aliases are still released past the bound", async () => {
		const s = await scene({ folderAware: true })
		const survivor = await s.discovery()
		await s.ev.loadFolderIndex()
		for (let i = 0; i < MAX + 3; i++) {
			const id = await s.discovery()
			await rm(join(s.root, "recordings", "dv", id), { recursive: true })
			await rm(join(s.root, "evidence", id), { recursive: true })
			await s.ev.loadFolderIndex()
			s.merge(survivor, id)
		}
		expect(s.store.aliasesOf(survivor)).toHaveLength(MAX)
	})

	for (const [label, caps] of [
		["by age", CAPS],
		["by quota", { ...CAPS, maxRecordingsMb: 0, maxEvidenceMb: 0 }],
	] as const) {
		it(`a Keep on the survivor protects every released-era folder ${label}`, async () => {
			const s = await scene({ folderAware: true })
			const { survivor, merged } = await absorbMany(s, MAX + 6)
			for (const id of merged) expect(s.store.aliasOwner(id)).toBe(survivor)
			s.store.setOperator(survivor, { keep: true })
			await ageAll(s.root, merged)
			s.ev.setCaps(caps)
			const { deleted } = await s.ev.retention(new Set([survivor]))
			expect(deleted).toEqual([])
			expect(s.ev.unresolvedFolderCount).toBe(0)
			for (const id of merged) {
				expect(
					existsSync(join(s.root, "recordings", "dv", id, "call.wav")),
				).toBe(true)
				expect(existsSync(join(s.root, "evidence", id, "psd.json"))).toBe(true)
			}
		})
	}

	it("without folder awareness (the old rule) the released folders lose their owner", async () => {
		const s = await scene({ folderAware: false })
		const { survivor, merged } = await absorbMany(s, MAX + 6)
		const released = merged.filter(id => s.store.aliasOwner(id) === undefined)
		expect(released).toHaveLength(6)
		// Even then retention keeps them: their owner is unresolved, never treated as unkept.
		s.store.setOperator(survivor, { keep: true })
		await ageAll(s.root, merged)
		s.ev.setCaps({ ...CAPS, maxRecordingsMb: 0, maxEvidenceMb: 0 })
		const { deleted } = await s.ev.retention(new Set([survivor]))
		expect(deleted).toEqual([])
		expect(s.ev.unresolvedFolderCount).toBe(6)
	})
})

describe("retention never deletes a folder it cannot resolve", () => {
	it("a folder of no live discovery is kept and counted, by age and by quota", async () => {
		const s = await scene({ folderAware: true })
		const live = await s.discovery()
		for (const id of ["d_GONE1", "d_GONE2"]) {
			const dir = join(s.root, "recordings", "dv", id)
			await mkdir(dir, { recursive: true })
			await writeFile(join(dir, "x.wav"), Buffer.alloc(4096))
			const old = new Date(T0 - 60 * DAY)
			await utimes(join(dir, "x.wav"), old, old)
		}
		await ageAll(s.root, [live])
		s.ev.setCaps({ ...CAPS, maxRecordingsMb: 0, maxEvidenceMb: 0 })
		const { deleted } = await s.ev.retention(new Set())
		expect([...deleted].sort()).toEqual([
			`evidence/${live}/psd.json`,
			`recordings/dv/${live}/call.wav`,
		])
		expect(
			existsSync(join(s.root, "recordings", "dv", "d_GONE1", "x.wav")),
		).toBe(true)
		expect(s.ev.unresolvedFolderCount).toBe(2)
	})
})

/** Writes the captured journal as a day file under `<root>/journal/`. */
async function writeJournal(
	root: string,
	entries: readonly JournalEntry[],
): Promise<{ dir: string; names: string[] }> {
	const dir = join(root, "journal")
	await mkdir(dir, { recursive: true })
	const name = "observations-20261009.jsonl"
	await writeFile(
		join(dir, name),
		entries.map(e => JSON.stringify(e)).join("\n") + "\n",
	)
	return { dir, names: [name] }
}

/** The state an older core left: aliases released past the bound (no folder check). */
async function releasedState() {
	const s = await scene({ folderAware: false })
	const { survivor, merged } = await absorbMany(s, MAX + 6)
	const released = merged.filter(id => s.store.aliasOwner(id) === undefined)
	expect(released).toHaveLength(6)
	// An old folder of a discovery nothing ever listed (untraceable).
	const stray = join(s.root, "evidence", "d_STRAY")
	await mkdir(stray, { recursive: true })
	await writeFile(join(stray, "psd.json"), "{}")
	const journal = await writeJournal(s.root, s.entries)
	return {
		s,
		survivor,
		merged,
		released,
		journal,
		snapshot: s.store.snapshot(),
	}
}

function freshStore(snapshot: StoreSnapshot): DiscoveryStore {
	const store = new DiscoveryStore({
		maxDiscoveries: 1_000,
		now: () => T0,
		newId: counterIds(),
		logger,
	})
	store.restore(snapshot)
	return store
}

describe("load-time migration of released folders", () => {
	it("re-attaches each released folder from the journal; an untraceable one stays, counted", async () => {
		const r = await releasedState()
		const store = freshStore(r.snapshot)
		const folders = await r.s.ev.loadFolderIndex()
		const orphans = folders.filter(id => store.folderOwner(id) === undefined)
		expect([...orphans].sort()).toEqual([...r.released, "d_STRAY"].sort())
		const history = await readAliasHistory({
			...r.journal,
			wanted: new Set(orphans),
		})
		expect(history.invalid).toBe(0)
		const result = store.reattachOrphanFolders(orphans, history.owners)
		expect(result).toEqual({ reattached: 6, unresolved: 1 })
		for (const id of r.released) expect(store.aliasOwner(id)).toBe(r.survivor)
		expect(store.aliasesOf(r.survivor)).toHaveLength(MAX + 6)
		// Repeating it attaches nothing more.
		expect(store.reattachOrphanFolders(orphans, history.owners)).toEqual({
			reattached: 0,
			unresolved: 1,
		})
	})

	it("is journaled: a crash after it replays to the same owners", async () => {
		const r = await releasedState()
		const store = freshStore(r.snapshot)
		const emitted: JournalEntry[] = []
		store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
			emitted.push({ ...e, seq: emitted.length + 1 }),
		)
		const history = await readAliasHistory({
			...r.journal,
			wanted: new Set(r.released),
		})
		store.reattachOrphanFolders(r.released, history.owners)
		expect(emitted).toHaveLength(1)
		const replayed = freshStore(r.snapshot)
		for (const e of emitted) replayed.replay(e)
		for (const id of r.released)
			expect(replayed.aliasOwner(id)).toBe(r.survivor)
		const again = freshStore(replayed.snapshot())
		for (const id of r.released) expect(again.aliasOwner(id)).toBe(r.survivor)
	})

	it("falls back to the observations listing a folder's recordings", async () => {
		const r = await releasedState()
		const store = freshStore(r.snapshot)
		const result = store.reattachOrphanFolders(r.released, new Map())
		expect(result).toEqual({ reattached: 6, unresolved: 0 })
		for (const id of r.released) expect(store.aliasOwner(id)).toBe(r.survivor)
	})

	it("moves and deletes nothing", async () => {
		const r = await releasedState()
		const store = freshStore(r.snapshot)
		const history = await readAliasHistory({
			...r.journal,
			wanted: new Set([...r.released, "d_STRAY"]),
		})
		store.reattachOrphanFolders([...r.released, "d_STRAY"], history.owners)
		for (const id of r.merged)
			expect(
				existsSync(join(r.s.root, "recordings", "dv", id, "call.wav")),
			).toBe(true)
		expect(existsSync(join(r.s.root, "evidence", "d_STRAY", "psd.json"))).toBe(
			true,
		)
	})
})

describe("restart path: analog recovery of a migrated folder's WAV", () => {
	function bindingOf(): RecordingBinding {
		return {
			sourceId: "src-1",
			engineInstanceId: randomUUID(),
			stream: 1,
			epoch: 1,
			channelId: "opaque",
			channelGeneration: 1,
			inputFormat: "cf32",
			inputSampleRateHz: 48000,
			groupDelayInputSamples: null,
			targetHz: BASE_HZ,
			captureCentreHz: null,
			tuningTrust: "commanded",
		}
	}
	const adapterOf = (store: DiscoveryStore): AnalogMetadataAdapter => ({
		authorityHealthy: () => true,
		bindingLive: () => true,
		association: (d, o, b) => store.recordingAssociation(d, o, b),
		prepare: async metadata => {
			store.prepareRecording(metadata)
		},
		inverse: async id => {
			store.removePreparedRecording(id)
		},
		buildCommitPlan: id => store.buildRecordingCommitPlan(id),
		commitPlanCurrent: plan => store.recordingCommitPlanCurrent(plan),
		publishCommit: plan => store.publishRecordingCommit(plan),
	})
	const evidenceFor = async (root: string, store: DiscoveryStore) => {
		const ev = new EvidenceStore({
			dir: root,
			caps: CAPS,
			logger,
			now: () => T0,
			statfs: async () => ({ freeBytes: 1e12 }),
			isDiscoveryLive: id => store.get(id) !== undefined,
			aliases: {
				aliasOwner: id => store.aliasOwner(id),
				aliasesOf: id => store.aliasesOf(id),
				releaseAliases: id => store.releaseAliases(id),
				heldFileNames: (id, removing) => store.heldFileNames(id, removing),
				heldRecordingOwner: id => store.heldRecordingOwner(id),
			},
		})
		store.setFolderLookup(id => ev.folders.holds(id))
		ev.configureAnalog(adapterOf(store))
		return ev
	}

	it("re-attaches (available, playable), not quarantines", async () => {
		const root = await tempRoot()
		const store = new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => T0,
			newId: counterIds(),
			logger,
		})
		const ev = await evidenceFor(root, store)
		await ev.recoverAnalog()
		const obs = (id: string, hz: number) =>
			makeObs({
				id,
				centreHz: hz,
				startedAt: T0,
				cls: "analog-fm",
				open: true,
				gate: "passed",
			})
		const survivor = store.ingest(obs("s", BASE_HZ)).discoveryId ?? ""
		const d = store.ingest(obs("v", BASE_HZ + 2_000_000)).discoveryId ?? ""
		const op = ev.beginAnalog({
			discoveryId: d,
			observationId: "v",
			binding: { ...bindingOf(), targetHz: BASE_HZ + 2_000_000 },
		})
		await op.ready
		await op.push(new Int16Array([1, -2, 3, -4]))
		const receipt = await op.finish()
		expect(receipt.outcome).toBe("finalized")
		const alias = `${d}~${receipt.artifact?.split("/").at(-1) ?? ""}`
		expect(
			store.applyConsolidation({ groups: [{ survivor, members: [d] }] })
				.absorbed,
		).toBe(1)
		await ev.stopAnalog()
		// The state an older core persisted: the alias released, so the snapshot omits it.
		const snapshot = store.snapshot()
		const released: StoreSnapshot = {
			...snapshot,
			aliases: (snapshot.aliases ?? [])
				.map(e => ({ ...e, aliases: e.aliases.filter(a => a !== d) }))
				.filter(e => e.aliases.length > 0),
		}
		delete released.heldRecordings
		const restarted = freshStore(released)
		expect(restarted.aliasOwner(d)).toBeUndefined()
		const next = await evidenceFor(root, restarted)
		const folders = await next.loadFolderIndex()
		const orphans = folders.filter(
			id => restarted.folderOwner(id) === undefined,
		)
		expect(orphans).toEqual([d])
		expect(restarted.reattachOrphanFolders(orphans, new Map())).toEqual({
			reattached: 1,
			unresolved: 0,
		})
		const results = await next.recoverAnalog()
		expect(results.map(x => x.status)).toEqual(["available"])
		expect(next.recordingPath(alias)).toBe(join(root, receipt.artifact ?? ""))
		await next.stopAnalog()
	})
})
