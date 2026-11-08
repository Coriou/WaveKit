/**
 * Recording ownership at its bounds, and the storage rules around it.
 *
 * - The ownership table (65,536 entries) fails closed when full: a refused entry marks its folder,
 *   and every recording there counts as held by an unknown live discovery, so no delete path of
 *   the folder's own discovery reaches it and retention keeps it (counted). Persisted and replayed.
 * - One journal entry never carries more held-recording changes than its schema accepts: a larger
 *   change set is split over several entries, each valid, and a replay reaches the same table.
 * - A folder mark lasts a write's whole pending lifetime: a listing that finishes meanwhile keeps
 *   it, so the alias owning that folder is never released.
 * - The load-time migration follows merge chains through ids that own no folder.
 * - A held file follows its holder's policy (kept while the holder is kept, aged and
 *   quota-removed like the holder's own files) and nothing done to its folder's discovery
 *   reaches it.
 * - A recordings quota left exceeded with nothing removable is visible: status, one log line
 *   when it starts and one when it clears, and analog admission refuses with storage-cap.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
	appendFile,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import pino from "pino"
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
import {
	HELD_OVERFLOW_FOLDERS_MAX,
	HELD_RECORDING_CHANGES_MAX,
	HELD_RECORDINGS_MAX,
	HeldRecordingTable,
	heldPayloadWithinBounds,
} from "../../../../src/core/scanner/store/held-recordings.js"
import type { HeldRecordingEntry } from "../../../../src/core/scanner/store/held-recordings.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import { StoreMutationSchema } from "../../../../src/core/scanner/store/schemas.js"
import type { StoreMutation } from "../../../../src/core/scanner/store/schemas.js"
import { createLogger } from "../../../../src/utils/logger.js"
import type { Logger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const logger = createLogger({ level: "fatal" })
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const DAY = 86_400_000
const MIB = 1024 * 1024
const BASE_HZ = 430_000_000
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
	const root = await realpath(await mkdtemp(join(tmpdir(), "wavekit-held-")))
	dirs.push(root)
	return root
}

function newStore(): DiscoveryStore {
	return new DiscoveryStore({
		maxDiscoveries: 1_000,
		now: () => T0,
		newId: counterIds(),
		logger,
	})
}

/** An evidence store wired to `current()` as the service wires it. */
function evidenceFor(
	root: string,
	current: () => DiscoveryStore,
	opts: {
		clock?: { now: number }
		statfs?: () => Promise<{ freeBytes: number }>
		log?: Logger
	} = {},
): EvidenceStore {
	const ev = new EvidenceStore({
		dir: root,
		caps: CAPS,
		logger: opts.log ?? logger,
		now: () => opts.clock?.now ?? T0,
		statfs: opts.statfs ?? (async () => ({ freeBytes: 1e12 })),
		isDiscoveryLive: id => current().get(id) !== undefined,
		aliases: {
			aliasOwner: id => current().aliasOwner(id),
			aliasesOf: id => current().aliasesOf(id),
			releaseAliases: id => current().releaseAliases(id),
			heldFileNames: (id, removing) => current().heldFileNames(id, removing),
			heldRecordingOwner: id => current().heldRecordingOwner(id),
			heldFolderUnknown: id => current().heldFolderUnknown(id),
		},
	})
	current().setFolderLookup(id => ev.folders.holds(id))
	return ev
}

/** A discovery with one dv recording `call.wav` of its own, listed by its observation. */
async function discovery(
	store: DiscoveryStore,
	root: string,
	n: number,
): Promise<string> {
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
	await writeWav(root, id, "call.wav")
	store.attachRecordings(`o${n}`, [`${id}~call.wav`], "linked")
	return id
}

async function writeWav(
	root: string,
	folderId: string,
	name: string,
	bytes = 4096,
): Promise<string> {
	const dir = join(root, "recordings", "dv", folderId)
	await mkdir(dir, { recursive: true })
	const path = join(dir, name)
	await writeFile(path, Buffer.alloc(bytes))
	return path
}

async function age(...paths: string[]): Promise<void> {
	const old = new Date(T0 - 60 * DAY)
	for (const p of paths) await utimes(p, old, old)
}

/** `count` entries owned by `ownerId`, in folders `d_F<i>` (or in `folderId` when given). */
function heldEntries(
	count: number,
	ownerId: string,
	folderId?: string,
): HeldRecordingEntry[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `${folderId ?? `d_F${i}`}~f${i}.wav`,
		ownerId,
		observationId: `oh${i}`,
	}))
}

const payloadOf = (e: JournalEntry | undefined): StoreMutation | undefined =>
	e?.payload as StoreMutation | undefined

function restored(snapshot: StoreSnapshot): DiscoveryStore {
	const store = newStore()
	store.restore(snapshot)
	return store
}

describe("the ownership table at and past its bound fails closed", () => {
	/**
	 * A has a folder with its own call.wav and `held.wav`; B is live. The restored table holds
	 * `preloaded` entries owned by B elsewhere; then B's observation lists A~held.wav.
	 */
	async function full(preloaded: number) {
		const root = await tempRoot()
		const first = newStore()
		const a = await discovery(first, root, 1)
		const b = await discovery(first, root, 2)
		const heldPath = await writeWav(root, a, "held.wav")
		const snapshot: StoreSnapshot = {
			...first.snapshot(),
			heldRecordings: heldEntries(preloaded, b),
		}
		const store = restored(snapshot)
		const ev = evidenceFor(root, () => store)
		await ev.loadFolderIndex()
		const emitted: JournalEntry[] = []
		store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
			emitted.push({ ...e, seq: emitted.length + 1 }),
		)
		expect(store.attachRecordings("o2", [`${a}~held.wav`], "linked")).toBe(true)
		return { root, snapshot, store, ev, a, b, heldPath, emitted }
	}

	it("one below the bound: the entry is held, A's delete removes only A's own file", async () => {
		const s = await full(HELD_RECORDINGS_MAX - 1)
		expect(s.store.heldRecordingOwner(`${s.a}~held.wav`)).toBe(s.b)
		expect(s.store.heldRecordingCounts.overflowFolders).toBe(0)
		expect(s.store.delete(s.a)).toBe(true)
		await s.ev.removeDiscovery(s.a)
		expect(existsSync(s.heldPath)).toBe(true)
		expect(existsSync(join(s.root, "recordings", "dv", s.a, "call.wav"))).toBe(
			false,
		)
	})

	it("at the bound: the refused entry still protects the file (unknown owner, kept and counted)", async () => {
		const s = await full(HELD_RECORDINGS_MAX)
		// B lists it, the table could not record it: the owner is unknown, never "nobody".
		expect(s.store.heldRecordingOwner(`${s.a}~held.wav`)).toBeNull()
		expect(s.store.heldFolderUnknown(s.a)).toBe(true)
		expect(s.store.heldRecordingCounts).toEqual({
			entries: HELD_RECORDINGS_MAX,
			overflowFolders: 1,
			overflowAll: false,
		})
		// The mark is journaled with the listing.
		expect(payloadOf(s.emitted.at(-1))?.heldOverflow).toEqual({
			folders: [s.a],
			all: false,
		})
		expect(s.store.delete(s.a)).toBe(true)
		await s.ev.removeDiscovery(s.a)
		expect(existsSync(s.heldPath)).toBe(true)
		// Fail closed: every recording of the marked folder stays (A's own too).
		expect(existsSync(join(s.root, "recordings", "dv", s.a, "call.wav"))).toBe(
			true,
		)
	})

	it("past the bound: retention keeps the folder's recordings by age and by quota, counted", async () => {
		const s = await full(HELD_RECORDINGS_MAX)
		await age(s.heldPath, join(s.root, "recordings", "dv", s.a, "call.wav"))
		s.ev.setCaps({ ...CAPS, maxRecordingsMb: 0 })
		const { deleted } = await s.ev.retention(new Set())
		expect(deleted).not.toContain(`recordings/dv/${s.a}/held.wav`)
		expect(deleted).not.toContain(`recordings/dv/${s.a}/call.wav`)
		expect(s.ev.unknownHeldFileCount).toBe(2)
	})

	it("the marks survive a snapshot and a replay, and end when the folder is gone", async () => {
		const s = await full(HELD_RECORDINGS_MAX)
		const again = restored(s.store.snapshot())
		expect(again.heldRecordingOwner(`${s.a}~held.wav`)).toBeNull()
		const replayed = restored(s.snapshot)
		for (const e of s.emitted) replayed.replay(e)
		expect(replayed.heldFolderUnknown(s.a)).toBe(true)
		// Every journaled entry parses with the reader's schema.
		for (const e of s.emitted)
			expect(StoreMutationSchema.safeParse(e.payload).success).toBe(true)
		// The folder still on disk keeps its mark; once gone, the mark ends (journaled).
		expect(
			s.store.pruneHeldRecordings(
				() => true,
				() => true,
			),
		).toBe(0)
		expect(s.store.heldFolderUnknown(s.a)).toBe(true)
		s.store.pruneHeldRecordings(
			() => true,
			id => id !== s.a,
		)
		expect(s.store.heldFolderUnknown(s.a)).toBe(false)
		expect(payloadOf(s.emitted.at(-1))?.heldOverflow).toEqual({
			folders: [],
			all: false,
		})
	})

	it("past the folder-mark bound every folder counts as marked", () => {
		const table = new HeldRecordingTable()
		table.restore(heldEntries(HELD_RECORDINGS_MAX, "d_B"))
		for (let i = 0; i <= HELD_OVERFLOW_FOLDERS_MAX; i++)
			expect(table.hold(`d_M${i}~x.wav`, "d_B", "o")).toBe(false)
		expect(table.overflowCount).toEqual({ folders: 0, all: true })
		expect(table.overflowed("d_ANY")).toBe(true)
		expect(table.takeOverflowChange()).toEqual({ folders: [], all: true })
	})

	it("an analog file of a marked folder is kept by A's delete and by retention", async () => {
		const root = await tempRoot()
		const store = newStore()
		const ev = evidenceFor(root, () => store)
		ev.configureAnalog(adapterOf(store))
		await ev.recoverAnalog()
		const a =
			store.ingest(
				makeObs({
					id: "va",
					centreHz: BASE_HZ,
					startedAt: T0,
					cls: "analog-fm",
					open: true,
					gate: "passed",
				}),
			).discoveryId ?? ""
		const receipt = await recordAnalog(ev, a, "va")
		const path = join(root, receipt.artifact ?? "")
		expect(existsSync(path)).toBe(true)
		// The observation leaves the record (no listing names the file any more) while the
		// table is full and A's folder is marked.
		const snap = store.snapshot()
		const marked: StoreSnapshot = {
			...snap,
			observations: snap.observations.filter(o => o.id !== "va"),
			heldOverflow: { folders: [a], all: false },
		}
		await ev.stopAnalog()
		const next = restored(marked)
		const ev2 = evidenceFor(root, () => next)
		ev2.configureAnalog(adapterOf(next))
		await ev2.recoverAnalog()
		ev2.setCaps({ ...CAPS, maxRecordingsMb: 0, maxAgeDays: 0 })
		await ev2.retention(new Set())
		expect(existsSync(path)).toBe(true)
		expect(ev2.unknownHeldFileCount).toBe(1)
		expect(next.delete(a)).toBe(true)
		await ev2.removeDiscovery(a)
		expect(existsSync(path)).toBe(true)
		await ev2.stopAnalog()
	})
})

describe("a journal entry never exceeds its own schema", () => {
	it("a group dropping 65,536 entries and adding one is split into valid entries that replay whole", async () => {
		const root = await tempRoot()
		const first = newStore()
		const a = await discovery(first, root, 1)
		const b = await discovery(first, root, 2)
		const c = await discovery(first, root, 3)
		// B lists 65,536 recordings in A's folder.
		const snapshot: StoreSnapshot = {
			...first.snapshot(),
			heldRecordings: heldEntries(HELD_RECORDINGS_MAX, b, a),
		}
		const store = restored(snapshot)
		const emitted: JournalEntry[] = []
		store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
			emitted.push({ ...e, seq: emitted.length + 1 }),
		)
		// One group: B into A drops them all (A owns that folder); C into A adds C's recording.
		const r = store.applyConsolidation({
			groups: [{ survivor: a, members: [b, c] }],
		})
		expect(r.absorbed).toBe(2)
		const changes = emitted.reduce(
			(n, e) => n + (payloadOf(e)?.heldRecordings?.length ?? 0),
			0,
		)
		expect(changes).toBe(HELD_RECORDINGS_MAX + 1)
		expect(emitted.length).toBeGreaterThan(1)
		for (const e of emitted) {
			expect(payloadOf(e)?.heldRecordings?.length ?? 0).toBeLessThanOrEqual(
				HELD_RECORDING_CHANGES_MAX,
			)
			expect(StoreMutationSchema.safeParse(e.payload).success).toBe(true)
			expect(heldPayloadWithinBounds(e.payload)).toBe(true)
		}
		expect(store.heldRecordingOwner(`${c}~call.wav`)).toBe(a)
		expect(store.heldRecordingCounts.entries).toBe(1)
		const replayed = restored(snapshot)
		for (const e of emitted) replayed.replay(e)
		expect(replayed.heldRecordingOwner(`${c}~call.wav`)).toBe(a)
		expect(replayed.heldRecordingCounts).toEqual(store.heldRecordingCounts)
		expect(replayed.heldFolderUnknown(a)).toBe(false)
	})

	it("chunks are ordered re-points, drops, adds, so a replay never passes the bound", () => {
		const table = new HeldRecordingTable()
		table.restore(heldEntries(HELD_RECORDINGS_MAX, "d_B"))
		// Drop all, add as many new ones, re-point none.
		for (const e of heldEntries(HELD_RECORDINGS_MAX, "d_B")) table.drop(e.id)
		for (let i = 0; i < HELD_RECORDINGS_MAX; i++)
			table.hold(`d_N${i}~n.wav`, "d_C", "o")
		const chunks = table.takeChangeChunks()
		expect(chunks).toHaveLength(2)
		expect(chunks[0]?.every(c => c.ownerId === null)).toBe(true)
		expect(chunks[1]?.every(c => c.ownerId === "d_C")).toBe(true)
		const replay = new HeldRecordingTable()
		replay.restore(heldEntries(HELD_RECORDINGS_MAX, "d_B"))
		for (const chunk of chunks) replay.apply(chunk)
		expect(replay.size).toBe(HELD_RECORDINGS_MAX)
		expect(replay.overflowCount).toEqual({ folders: 0, all: false })
		expect(replay.get("d_N0~n.wav")?.ownerId).toBe("d_C")
	})

	it("an id added and dropped since the last take is no change", () => {
		const table = new HeldRecordingTable()
		table.hold("d_A~x.wav", "d_B", "o")
		table.drop("d_A~x.wav")
		expect(table.takeChangeChunks()).toEqual([])
	})

	it("the writer's bound check refuses an oversized payload", () => {
		const changes = Array.from(
			{ length: HELD_RECORDING_CHANGES_MAX + 1 },
			(_, i) => ({
				id: `d_A~f${i}.wav`,
				ownerId: null,
			}),
		)
		expect(heldPayloadWithinBounds({ heldRecordings: changes })).toBe(false)
		expect(heldPayloadWithinBounds({ heldRecordings: changes.slice(1) })).toBe(
			true,
		)
	})
})

describe("persistence of the ownership bounds", () => {
	it("a snapshot and a journal entry carry the overflow marks across a load", async () => {
		const dir = await tempRoot()
		const p = new ScannerPersistence({ dir, logger, now: () => T0 })
		await p.load()
		const heldOverflow = { folders: ["d_A"], all: false }
		await p.writeSnapshot({
			discoveries: [],
			observations: [],
			corrections: [],
			heldRecordings: heldEntries(2, "d_B"),
			heldOverflow,
		})
		const marks = { folders: ["d_A", "d_C"], all: false }
		await p.append({
			at: new Date(T0).toISOString(),
			op: "evidence",
			payload: {
				discoveries: [],
				observations: [],
				deleted: [],
				heldOverflow: marks,
			} satisfies StoreMutation,
		})
		const loaded = await new ScannerPersistence({
			dir,
			logger,
			now: () => T0,
		}).load()
		expect(loaded.heldOverflow).toEqual(heldOverflow)
		expect(loaded.heldRecordings).toHaveLength(2)
		expect(loaded.entries).toHaveLength(1)
		expect(payloadOf(loaded.entries[0])?.heldOverflow).toEqual(marks)
	})

	it("an append past the held-recording bound is refused, never written", async () => {
		const dir = await tempRoot()
		const p = new ScannerPersistence({ dir, logger, now: () => T0 })
		await p.load()
		const heldRecordings = Array.from(
			{ length: HELD_RECORDING_CHANGES_MAX + 1 },
			(_, i) => ({ id: `d_A~f${i}.wav`, ownerId: null }),
		)
		await expect(
			p.append({
				at: new Date(T0).toISOString(),
				op: "evidence",
				payload: {
					discoveries: [],
					observations: [],
					deleted: [],
					heldRecordings,
				} satisfies StoreMutation,
			}),
		).rejects.toMatchObject({ code: "SCANNER_JOURNAL_BACKLOG" })
		const loaded = await new ScannerPersistence({
			dir,
			logger,
			now: () => T0,
		}).load()
		expect(loaded.entries).toHaveLength(0)
		expect(loaded.droppedLines).toBe(0)
	})
})

describe("a pending write keeps its folder mark through a listing", () => {
	it("the index keeps a pending id, and drops it at the next listing once settled and absent", () => {
		const index = new FolderIndex()
		const settled = index.mark("d_A")
		const token = index.beginListing()
		index.finishListing(token, [])
		expect(index.holds("d_A")).toBe(true)
		// A listing that ran while the write was pending keeps it after it settled too.
		const during = index.beginListing()
		settled()
		index.finishListing(during, [])
		expect(index.holds("d_A")).toBe(true)
		expect(index.pendingWrites).toBe(0)
		// Settled and absent from the next listing: gone (the write failed).
		const after = index.beginListing()
		index.finishListing(after, [])
		expect(index.holds("d_A")).toBe(false)
		settled()
		expect(index.pendingWrites).toBe(0)
	})

	it("a PSD write paused across a listing keeps the folder; the alias is never released", async () => {
		const root = await tempRoot()
		const store = newStore()
		const a =
			store.ingest(
				makeObs({
					id: "o1",
					centreHz: BASE_HZ,
					startedAt: T0,
					cls: "analog-fm",
					open: false,
					gate: "passed",
				}),
			).discoveryId ?? ""
		const gate: { open?: () => void } = {}
		let entered!: () => void
		const inStatfs = new Promise<void>(resolve => {
			entered = resolve
		})
		const ev = evidenceFor(root, () => store, {
			statfs: () =>
				new Promise(resolve => {
					gate.open = () => resolve({ freeBytes: 1e12 })
					entered()
				}),
		})
		const write = ev.writePsd(a, {
			startHz: BASE_HZ,
			binHz: 10,
			bins: [1, 2],
			snrDb: 10,
		})
		await inStatfs
		await ev.loadFolderIndex()
		expect(existsSync(join(root, "evidence", a))).toBe(false)
		expect(gate.open).toBeDefined()
		gate.open?.()
		expect(await write).toBe(true)
		expect(existsSync(join(root, "evidence", a, "psd.json"))).toBe(true)
		expect(ev.folders.holds(a)).toBe(true)
		// 65 adoptions past A: A owns a folder, so it is never released.
		const table = new RecordingAliasTable()
		table.setFolderLookup(id => ev.folders.holds(id))
		table.adopt("d_K", a)
		for (let i = 0; i < DISCOVERY_RECORDING_ALIASES_MAX; i++)
			table.adopt("d_K", `d_Q${i}`)
		expect(table.aliasOwner(a)).toBe("d_K")
	})
})

describe("migration follows merge chains through folderless ids", () => {
	async function journal(root: string, lines: object[]) {
		const dir = join(root, "journal")
		await mkdir(dir, { recursive: true })
		const name = "observations-20261009.jsonl"
		await writeFile(
			join(dir, name),
			lines.map(l => JSON.stringify(l)).join("\n") + "\n",
		)
		return { dir, names: [name] }
	}

	it("A into B, then B into live C: A re-attaches to C though B is no orphan", async () => {
		const root = await tempRoot()
		const store = newStore()
		const c =
			store.ingest(
				makeObs({
					id: "oc",
					centreHz: BASE_HZ,
					startedAt: T0,
					cls: "analog-fm",
					open: false,
					gate: "passed",
				}),
			).discoveryId ?? ""
		// A's last listing is under B (later released from it); C lists B, later released too.
		const j = await journal(root, [
			{ seq: 1, payload: { aliases: [{ id: "d_B", aliases: ["d_A"] }] } },
			{
				seq: 2,
				payload: {
					aliases: [
						{ id: c, aliases: ["d_B"] },
						{ id: "d_B", aliases: [] },
					],
				},
			},
		])
		const history = await readAliasHistory({ ...j, wanted: new Set(["d_A"]) })
		expect(history.owners.get("d_A")).toBe("d_B")
		expect(history.owners.get("d_B")).toBe(c)
		expect(store.reattachOrphanFolders(["d_A"], history.owners)).toEqual({
			reattached: 1,
			unresolved: 0,
		})
		expect(store.aliasOwner("d_A")).toBe(c)
	})

	it("only chains from wanted ids are returned; past the edge bound ids are skipped and counted", async () => {
		const root = await tempRoot()
		const j = await journal(root, [
			{
				seq: 1,
				payload: {
					aliases: [
						{ id: "d_B", aliases: ["d_A"] },
						{ id: "d_Y", aliases: ["d_X"] },
					],
				},
			},
			{ seq: 2, payload: { aliases: [{ id: "d_C", aliases: ["d_B"] }] } },
		])
		const all = await readAliasHistory({ ...j, wanted: new Set(["d_A"]) })
		expect([...all.owners.keys()].sort()).toEqual(["d_A", "d_B"])
		expect(all.truncated).toBe(0)
		const bounded = await readAliasHistory({
			...j,
			wanted: new Set(["d_A"]),
			maxEdges: 2,
		})
		expect(bounded.truncated).toBe(1)
		// The chain's second edge was skipped: it stops at B (the folder then stays unresolved).
		expect(bounded.owners.get("d_A")).toBe("d_B")
		expect(bounded.owners.has("d_B")).toBe(false)
	})
})

describe("a held file follows its holder's policy; nothing done to its folder's discovery reaches it", () => {
	/** A's folder holds A's call.wav and B's held.wav; B has call.wav of its own. All aged. */
	async function split() {
		const root = await tempRoot()
		const store = newStore()
		const ev = evidenceFor(root, () => store)
		const a = await discovery(store, root, 1)
		const b = await discovery(store, root, 2)
		const heldPath = await writeWav(root, a, "held.wav")
		store.attachRecordings("o2", [`${a}~held.wav`], "linked")
		const aOwn = join(root, "recordings", "dv", a, "call.wav")
		const bOwn = join(root, "recordings", "dv", b, "call.wav")
		await age(heldPath, aOwn, bOwn)
		await ev.loadFolderIndex()
		return { root, store, ev, a, b, heldPath, aOwn, bOwn }
	}

	it("kept while B is kept, by age and by quota (A's own files go)", async () => {
		const s = await split()
		s.ev.setCaps({ ...CAPS, maxRecordingsMb: 0 })
		const { deleted } = await s.ev.retention(new Set([s.b]))
		expect(existsSync(s.heldPath)).toBe(true)
		expect(existsSync(s.bOwn)).toBe(true)
		expect(deleted).toContain(`recordings/dv/${s.a}/call.wav`)
	})

	it("aged out together with B's own files when B is not kept", async () => {
		const s = await split()
		const { deleted } = await s.ev.retention(new Set())
		expect(existsSync(s.heldPath)).toBe(false)
		expect(existsSync(s.bOwn)).toBe(false)
		expect(deleted).toContain(`recordings/dv/${s.a}/held.wav`)
	})

	it("quota-removed like B's own files when B is not kept", async () => {
		const s = await split()
		// Recent files (no age removal); the quota alone removes the oldest first.
		const recent = new Date(T0 - 2 * DAY)
		for (const p of [s.heldPath, s.aOwn, s.bOwn])
			await utimes(p, recent, recent)
		s.ev.setCaps({ ...CAPS, maxRecordingsMb: 0 })
		const { deleted } = await s.ev.retention(new Set())
		expect(deleted).toContain(`recordings/dv/${s.a}/held.wav`)
		expect(deleted).toContain(`recordings/dv/${s.b}/call.wav`)
	})

	it("never removed by A's delete, A's prune, or a fold of A into a discovery that is then deleted", async () => {
		for (const path of ["delete", "prune", "fold"] as const) {
			const s = await split()
			if (path === "delete") {
				expect(s.store.delete(s.a)).toBe(true)
				await s.ev.removeDiscovery(s.a)
			} else if (path === "prune") {
				s.store.setOperator(s.b, { keep: true })
				const removed = s.store.pruneInactive(-1)
				expect(removed).toContain(s.a)
				for (const id of removed) await s.ev.removeDiscovery(id)
			} else {
				const d = await discovery(s.store, s.root, 3)
				expect(
					s.store.applyConsolidation({
						groups: [{ survivor: d, members: [s.a] }],
					}).absorbed,
				).toBe(1)
				expect(s.store.delete(d)).toBe(true)
				await s.ev.removeDiscovery(d)
			}
			expect(existsSync(s.heldPath)).toBe(true)
			expect(existsSync(s.aOwn)).toBe(false)
		}
	})
})

const bindingOf = (targetHz: number): RecordingBinding => ({
	sourceId: "src-1",
	engineInstanceId: randomUUID(),
	stream: 1,
	epoch: 1,
	channelId: "opaque",
	channelGeneration: 1,
	inputFormat: "cf32",
	inputSampleRateHz: 48000,
	groupDelayInputSamples: null,
	targetHz,
	captureCentreHz: null,
	tuningTrust: "commanded",
})

function adapterOf(store: DiscoveryStore): AnalogMetadataAdapter {
	return {
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
	}
}

async function recordAnalog(
	ev: EvidenceStore,
	discoveryId: string,
	obs: string,
) {
	const op = ev.beginAnalog({
		discoveryId,
		observationId: obs,
		binding: bindingOf(BASE_HZ),
	})
	await op.ready
	await op.push(new Int16Array([1, -2, 3, -4]))
	const receipt = await op.finish()
	expect(receipt.outcome).toBe("finalized")
	return receipt
}

describe("a recordings quota exceeded with nothing removable is visible", () => {
	function capture(): { log: Logger; lines: Record<string, unknown>[] } {
		const lines: Record<string, unknown>[] = []
		const sink = new Writable({
			write(chunk: Buffer, _enc, done) {
				for (const text of chunk.toString("utf8").split("\n"))
					if (text.trim() !== "")
						lines.push(JSON.parse(text) as Record<string, unknown>)
				done()
			},
		})
		return { log: pino({ level: "info" }, sink) as unknown as Logger, lines }
	}

	it("status, one log line on entry and one on clearing, and analog admission refuses with storage-cap", async () => {
		const root = await tempRoot()
		const store = newStore()
		const { log, lines } = capture()
		const ev = evidenceFor(root, () => store, { log })
		ev.configureAnalog(adapterOf(store))
		await ev.recoverAnalog()
		const b = await discovery(store, root, 1)
		// 8 KiB kept by B against a 4 KiB quota: nothing is removable.
		await writeWav(root, b, "big.wav", 8192)
		ev.setCaps({ ...CAPS, maxRecordingsMb: 4096 / MIB })
		await ev.retention(new Set([b]))
		const used = 4096 + 8192
		expect(ev.recordingsQuotaExceeded).toEqual({
			capBytes: 4096,
			usedBytes: used,
			overBytes: used - 4096,
		})
		await ev.retention(new Set([b]))
		await new Promise(resolve => setImmediate(resolve))
		const entered = lines.filter(
			l =>
				l["reason"] === "storage-cap" && String(l["msg"]).includes("exceeded"),
		)
		expect(entered).toHaveLength(1)
		expect(entered[0]).toMatchObject({
			capBytes: 4096,
			usedBytes: used,
			overBytes: used - 4096,
		})
		// The refusal the recorder sees.
		const op = ev.beginAnalog({
			discoveryId: b,
			observationId: "o1",
			binding: bindingOf(BASE_HZ),
		})
		await expect(op.ready).rejects.toThrow()
		const receipt = await op.settled
		expect(receipt.errorCode).toBe("storage-cap")
		// Clears once the quota fits: one line.
		ev.setCaps({ ...CAPS, maxRecordingsMb: 1 })
		await ev.retention(new Set([b]))
		await new Promise(resolve => setImmediate(resolve))
		expect(ev.recordingsQuotaExceeded).toBeNull()
		const cleared = lines.filter(
			l =>
				l["reason"] === "storage-cap" && String(l["msg"]).includes("no longer"),
		)
		expect(cleared).toHaveLength(1)
		// Trusted values only: no ids or paths in either line.
		for (const l of [...entered, ...cleared])
			expect(JSON.stringify(l)).not.toContain(b)
		await ev.stopAnalog()
	})

	it("the scanner status reports it from the last retention pass", async () => {
		const h = serviceHarness({
			patch: settings => {
				settings.passive.enabled = false
			},
		})
		await h.service.start()
		try {
			const ev = (h.service as unknown as { evidence: EvidenceStore }).evidence
			expect(h.service.status()).not.toHaveProperty("recordingsQuota")
			const root = (ev as unknown as { root: string }).root
			// A folder no live discovery owns: kept by retention, so nothing is removable.
			await writeWav(root, "d_Q1", "x.wav", 8192)
			ev.setCaps({ ...CAPS, maxRecordingsMb: 4096 / MIB })
			await ev.retention(new Set())
			const quota = h.service.status().recordingsQuota
			expect(quota).toMatchObject({
				state: "exceeded",
				reason: "storage-cap",
				capBytes: 4096,
			})
			expect(quota?.usedBytes).toBeGreaterThanOrEqual(8192)
			expect(quota?.overBytes).toBe((quota?.usedBytes ?? 0) - 4096)
		} finally {
			await h.service.stop()
		}
	})
})

describe("a folder mark comes before any ownership answer, at every deleter", () => {
	it("a digital file B lists in a marked folder: kept by retention (B unkept, aged, zero quota) and by A's delete", async () => {
		const root = await tempRoot()
		const first = newStore()
		const a = await discovery(first, root, 1)
		const b = await discovery(first, root, 2)
		const heldPath = await writeWav(root, a, "held.wav")
		first.attachRecordings("o2", [`${a}~held.wav`], "linked")
		const aOwn = join(root, "recordings", "dv", a, "call.wav")
		await age(heldPath, aOwn)
		const store = restored({
			...first.snapshot(),
			heldOverflow: { folders: [a], all: false },
		})
		// The table still names B; the mark wins for every deleter.
		expect(store.heldRecordingOwner(`${a}~held.wav`)).toBeNull()
		// Playback still goes through the listing holder.
		expect(store.heldRecordingHolder(`${a}~held.wav`)).toBe(b)
		const ev = evidenceFor(root, () => store)
		await ev.loadFolderIndex()
		ev.setCaps({ ...CAPS, maxRecordingsMb: 0 })
		const { deleted } = await ev.retention(new Set())
		expect(deleted).not.toContain(`recordings/dv/${a}/held.wav`)
		expect(deleted).not.toContain(`recordings/dv/${a}/call.wav`)
		expect(existsSync(heldPath)).toBe(true)
		expect(ev.unknownHeldFileCount).toBe(2)
		expect(store.delete(a)).toBe(true)
		await ev.removeDiscovery(a)
		expect(existsSync(heldPath)).toBe(true)
		expect(existsSync(aOwn)).toBe(true)
		// B's own folder is not marked: B's own aged file goes as before.
		const bOwn = join(root, "recordings", "dv", b, "call.wav")
		await age(bOwn)
		await ev.retention(new Set())
		expect(existsSync(bOwn)).toBe(false)
		expect(existsSync(heldPath)).toBe(true)
	})

	it("an analog file whose observation A still holds, in a marked folder: kept by retention (aged, zero quota) and by A's delete", async () => {
		const root = await tempRoot()
		const store = newStore()
		const ev = evidenceFor(root, () => store)
		ev.configureAnalog(adapterOf(store))
		await ev.recoverAnalog()
		const a =
			store.ingest(
				makeObs({
					id: "va",
					centreHz: BASE_HZ,
					startedAt: T0,
					cls: "analog-fm",
					open: true,
					gate: "passed",
				}),
			).discoveryId ?? ""
		const receipt = await recordAnalog(ev, a, "va")
		const path = join(root, receipt.artifact ?? "")
		expect(existsSync(path)).toBe(true)
		await ev.stopAnalog()
		// The observation stays: the association names A itself, the mark still wins.
		const next = restored({
			...store.snapshot(),
			heldOverflow: { folders: [a], all: false },
		})
		const ev2 = evidenceFor(root, () => next)
		ev2.configureAnalog(adapterOf(next))
		await ev2.recoverAnalog()
		ev2.setCaps({ ...CAPS, maxRecordingsMb: 0, maxAgeDays: 0 })
		await ev2.retention(new Set())
		expect(existsSync(path)).toBe(true)
		expect(ev2.unknownHeldFileCount).toBe(1)
		expect(next.delete(a)).toBe(true)
		await ev2.removeDiscovery(a)
		expect(existsSync(path)).toBe(true)
		await ev2.stopAnalog()
	})

	it("without a mark the same analog file follows A's policy (zero quota removes it)", async () => {
		const root = await tempRoot()
		const store = newStore()
		const ev = evidenceFor(root, () => store)
		ev.configureAnalog(adapterOf(store))
		await ev.recoverAnalog()
		const a =
			store.ingest(
				makeObs({
					id: "va",
					centreHz: BASE_HZ,
					startedAt: T0,
					cls: "analog-fm",
					open: true,
					gate: "passed",
				}),
			).discoveryId ?? ""
		const receipt = await recordAnalog(ev, a, "va")
		const path = join(root, receipt.artifact ?? "")
		ev.setCaps({ ...CAPS, maxRecordingsMb: 0, maxAgeDays: 0 })
		await ev.retention(new Set())
		expect(existsSync(path)).toBe(false)
		await ev.stopAnalog()
	})
})

describe("every prefix of a split journal sequence keeps every listed file", () => {
	/** The 65,536-drop group of the split test above: B's entries in A's folder go, C's call.wav is added. */
	async function splitGroup() {
		const root = await tempRoot()
		const first = newStore()
		const a = await discovery(first, root, 1)
		const b = await discovery(first, root, 2)
		const c = await discovery(first, root, 3)
		const snapshot: StoreSnapshot = {
			...first.snapshot(),
			heldRecordings: heldEntries(HELD_RECORDINGS_MAX, b, a),
		}
		const store = restored(snapshot)
		const emitted: JournalEntry[] = []
		store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
			emitted.push({ ...e, seq: emitted.length + 1 }),
		)
		store.applyConsolidation({ groups: [{ survivor: a, members: [b, c] }] })
		expect(emitted.length).toBeGreaterThan(1)
		return { root, snapshot, store, emitted, a, b, c }
	}

	/**
	 * After a replay of `entries` on the snapshot, the folders of the merged B and C: their own
	 * delete paths keep the call.wav each that survivor A lists.
	 */
	async function mergedKept(
		root: string,
		start: StoreSnapshot,
		entries: readonly JournalEntry[],
		merged: readonly string[],
	): Promise<void> {
		const replayed = restored(start)
		for (const e of entries) replayed.replay(e)
		const ev = evidenceFor(root, () => replayed)
		for (const id of merged) {
			// A survivor lists it: the answer is that survivor or unknown, never nobody.
			expect(replayed.heldRecordingOwner(`${id}~call.wav`)).not.toBeUndefined()
			await ev.removeDiscovery(id)
			expect(existsSync(join(root, "recordings", "dv", id, "call.wav"))).toBe(
				true,
			)
		}
	}

	it("replaying emitted[0..k] for every k: C's delete never reaches the file A lists; the last entry ends the temporary marks", async () => {
		const s = await splitGroup()
		for (let k = 0; k < s.emitted.length; k++)
			await mergedKept(s.root, s.snapshot, s.emitted.slice(0, k + 1), [
				s.b,
				s.c,
			])
		// The whole sequence leaves no mark the live store does not hold.
		const whole = restored(s.snapshot)
		for (const e of s.emitted) whole.replay(e)
		expect(whole.heldRecordingCounts).toEqual(s.store.heldRecordingCounts)
		for (const id of [s.a, s.b, s.c])
			expect(whole.heldFolderUnknown(id)).toBe(s.store.heldFolderUnknown(id))
		expect(whole.heldFolderUnknown(s.c)).toBe(false)
		expect(whole.heldRecordingOwner(`${s.c}~call.wav`)).toBe(s.a)
		// The first entry marks the folders the later entries add to; the last one carries the
		// marks the live table holds (B's, refused while the table was still full mid-group).
		expect(payloadOf(s.emitted[0])?.heldOverflow).toEqual({
			folders: [s.b, s.c].sort(),
			all: false,
		})
		expect(s.store.heldFolderUnknown(s.b)).toBe(true)
		expect(payloadOf(s.emitted.at(-1))?.heldOverflow).toEqual({
			folders: [s.b],
			all: false,
		})
		for (const e of s.emitted)
			expect(StoreMutationSchema.safeParse(e.payload).success).toBe(true)
	})

	it("a split past the folder-mark bound marks every folder in the first entry", () => {
		const table = new HeldRecordingTable()
		table.restore(heldEntries(HELD_RECORDINGS_MAX, "d_B", "d_A"))
		for (const e of heldEntries(HELD_RECORDINGS_MAX, "d_B", "d_A"))
			table.drop(e.id)
		// One more folder than the mark bound receives an added entry.
		for (let i = 0; i <= HELD_OVERFLOW_FOLDERS_MAX; i++)
			table.hold(`d_N${i}~n.wav`, "d_C", "o")
		const parts = table.takeJournalParts()
		expect(parts).toHaveLength(2)
		expect(parts[0]?.heldOverflow).toEqual({ folders: [], all: true })
		expect(parts[1]?.heldOverflow).toEqual({ folders: [], all: false })
		// At the bound exactly the folders are listed one by one.
		const exact = new HeldRecordingTable()
		exact.restore(heldEntries(HELD_RECORDINGS_MAX, "d_B", "d_A"))
		for (const e of heldEntries(HELD_RECORDINGS_MAX, "d_B", "d_A"))
			exact.drop(e.id)
		for (let i = 0; i < HELD_OVERFLOW_FOLDERS_MAX; i++)
			exact.hold(`d_N${i}~n.wav`, "d_C", "o")
		const first = exact.takeJournalParts()[0]?.heldOverflow
		expect(first?.all).toBe(false)
		expect(first?.folders).toHaveLength(HELD_OVERFLOW_FOLDERS_MAX)
	})

	it("one entry needs no temporary mark", () => {
		const table = new HeldRecordingTable()
		table.hold("d_A~x.wav", "d_B", "o")
		expect(table.takeJournalParts()).toEqual([
			{
				heldRecordings: [
					{ id: "d_A~x.wav", ownerId: "d_B", observationId: "o" },
				],
			},
		])
		expect(table.takeJournalParts()).toEqual([])
	})

	for (const crash of ["torn", "refused"] as const)
		it(`a crash before the covering snapshot (${crash} second line) restarts with the file still kept`, async () => {
			const s = await splitGroup()
			const dir = await tempRoot()
			let calls = 0
			const p = new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
				appendFile: async (path, data) => {
					calls++
					if (crash === "torn") {
						// The process dies after the first line is durable.
						const cut = data.indexOf("\n") + 1
						await appendFile(path, data.slice(0, cut))
						return new Promise<void>(() => undefined)
					}
					if (calls > 1) throw new Error("synthetic write failure")
					await appendFile(path, data)
				},
			})
			await p.load()
			await p.writeSnapshot(s.snapshot)
			const [e0, ...rest] = s.emitted
			if (e0 === undefined) throw new Error("no entry")
			if (crash === "torn") {
				void p.append(e0).catch(() => undefined)
				for (const e of rest) void p.append(e).catch(() => undefined)
				await new Promise(resolve => setTimeout(resolve, 50))
			} else {
				await p.append(e0)
				for (const e of rest)
					await expect(p.append(e)).rejects.toBeInstanceOf(Error)
			}
			// No snapshot follows: the restart sees the snapshot and the first entry only.
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(loaded.entries).toHaveLength(1)
			const start: StoreSnapshot = {
				discoveries: loaded.discoveries,
				observations: loaded.observations,
				corrections: loaded.corrections,
				...(loaded.aliases ? { aliases: loaded.aliases } : {}),
				...(loaded.heldRecordings
					? { heldRecordings: loaded.heldRecordings }
					: {}),
				...(loaded.heldOverflow ? { heldOverflow: loaded.heldOverflow } : {}),
			}
			await mergedKept(s.root, start, loaded.entries, [s.b, s.c])
		})
})
