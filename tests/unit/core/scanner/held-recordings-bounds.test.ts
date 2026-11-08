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
	HELD_JOURNAL_FORMAT,
	HELD_OPEN_GUARDS_MAX,
	HELD_OVERFLOW_FOLDERS_MAX,
	HELD_RECORDING_CHANGES_MAX,
	HELD_RECORDINGS_MAX,
	HeldRecordingTable,
	heldPayloadWithinBounds,
} from "../../../../src/core/scanner/store/held-recordings.js"
import type {
	HeldJournalPart,
	HeldRecordingEntry,
} from "../../../../src/core/scanner/store/held-recordings.js"
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

/**
 * `count` entries owned by `ownerId`, in folders `d_F<i>` (or in `folderId` when given), each
 * listed by an observation `oh<i>` outside the window, or by `observationId` when given (one in
 * the window: a merge into the folder's own discovery may collapse those, never aged ones).
 */
function heldEntries(
	count: number,
	ownerId: string,
	folderId?: string,
	observationId?: string,
): HeldRecordingEntry[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `${folderId ?? `d_F${i}`}~f${i}.wav`,
		ownerId,
		observationId: observationId ?? `oh${i}`,
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

	it("a refusal while a restore derives listings again is a safety mark: a later replacement of the marks does not clear it", async () => {
		const s = await full(HELD_RECORDINGS_MAX)
		// A snapshot whose table is full and whose B observation lists A~held.wav, with no mark saved.
		const { heldOverflow: _dropped, ...unmarked } = s.store.snapshot()
		const store = restored(unmarked)
		expect(store.heldFolderUnknown(s.a)).toBe(true)
		const template = s.emitted.at(-1)!
		store.replay({
			...template,
			seq: Number.MAX_SAFE_INTEGER - 1,
			payload: {
				...payloadOf(template)!,
				heldFormat: 2,
				heldOverflow: { folders: [], all: false },
			},
		})
		expect(store.heldFolderUnknown(s.a)).toBe(true)
		const ev = evidenceFor(s.root, () => store)
		await ev.loadFolderIndex()
		expect(store.delete(s.a)).toBe(true)
		await ev.removeDiscovery(s.a)
		expect(existsSync(s.heldPath)).toBe(true)
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
		// B's observation in the window lists 65,536 recordings in A's folder.
		const snapshot: StoreSnapshot = {
			...first.snapshot(),
			heldRecordings: heldEntries(HELD_RECORDINGS_MAX, b, a, "o2"),
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
		expect(replay.holders("d_N0~n.wav")).toEqual(["d_C"])
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
			heldRecordings: heldEntries(HELD_RECORDINGS_MAX, b, a, "o2"),
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
		// The first entry opens a guard of the folders the later entries add to; the last one adds
		// the marks the live table holds (B's, refused while the table was still full mid-group)
		// and closes that guard, under the same sequence id. Neither replaces the marks.
		const opened = payloadOf(s.emitted[0])?.heldGuard
		expect(opened).toMatchObject({ folders: [s.b, s.c].sort(), all: false })
		expect(s.store.heldFolderUnknown(s.b)).toBe(true)
		const closed = payloadOf(s.emitted.at(-1))?.heldGuardEnd
		expect(closed).toMatchObject({ folders: [s.b], all: false })
		expect(closed?.id).toBe(opened?.id)
		for (const e of s.emitted)
			expect(payloadOf(e)?.heldOverflow).toBeUndefined()
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
		expect(parts[0]?.heldGuard).toMatchObject({ folders: [], all: true })
		expect(parts[1]?.heldGuardEnd).toMatchObject({ folders: [], all: false })
		expect(parts[1]?.heldGuardEnd?.id).toBe(parts[0]?.heldGuard?.id)
		// At the bound exactly the folders are listed one by one.
		const exact = new HeldRecordingTable()
		exact.restore(heldEntries(HELD_RECORDINGS_MAX, "d_B", "d_A"))
		for (const e of heldEntries(HELD_RECORDINGS_MAX, "d_B", "d_A"))
			exact.drop(e.id)
		for (let i = 0; i < HELD_OVERFLOW_FOLDERS_MAX; i++)
			exact.hold(`d_N${i}~n.wav`, "d_C", "o")
		const first = exact.takeJournalParts()[0]?.heldGuard
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

	for (const crash of ["torn", "cut at its newline", "refused"] as const)
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
					if (crash !== "refused") {
						// One batch holds every line; the process dies after the first line is
						// durable, and half the second one when torn.
						const first = data.indexOf("\n") + 1
						const second = data.indexOf("\n", first)
						expect(first).toBeGreaterThan(0)
						expect(second).toBeGreaterThan(first)
						const cut =
							crash === "torn"
								? first + Math.floor((second - first) / 2)
								: first
						if (crash === "torn") {
							const tail = data.slice(first, cut)
							expect(tail.length).toBeGreaterThan(1)
							expect(tail).not.toContain("\n")
						}
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
			if (crash !== "refused") {
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
			expect(loaded.droppedLines).toBe(crash === "torn" ? 1 : 0)
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

// Each case restores and replays a 65,536-entry table once per prefix (several seconds on a
// loaded host): an explicit budget, not the 5 s default.
describe(
	"interleaved split sequences never undo each other's protection",
	{ timeout: 60_000 },
	() => {
		/**
		 * Two split sequences taken one after the other from one full table: A re-points 65,533
		 * entries, drops two and adds X1 and X2 (its second part adds X2, its first guards X2's
		 * folder); B re-points the same 65,533, drops two others (E and X1) and adds Y1 and Y2.
		 */
		async function sequences() {
			const root = await tempRoot()
			const first = newStore()
			const p = await discovery(first, root, 1)
			const q = await discovery(first, root, 2)
			const r = await discovery(first, root, 3)
			const repointed = heldEntries(HELD_RECORDINGS_MAX - 3, p)
			const others = ["d_GD~d1.wav", "d_GD~d2.wav", "d_GE~e.wav"].map(id => ({
				id,
				ownerId: p,
				observationId: "og",
			}))
			const initial = [...repointed, ...others]
			const snapshot: StoreSnapshot = {
				...first.snapshot(),
				heldRecordings: initial,
			}
			const table = new HeldRecordingTable()
			table.restore(initial)
			// A re-point: the listing observation moved to q (its key is unchanged).
			for (const e of repointed) table.hold(e.id, q, e.observationId)
			table.drop("d_GD~d1.wav")
			table.drop("d_GD~d2.wav")
			expect(table.hold("d_X1~x1.wav", q, "oq")).toBe(true)
			expect(table.hold("d_X2~x2.wav", q, "oq")).toBe(true)
			const a = table.takeJournalParts()
			for (const e of repointed) table.hold(e.id, r, e.observationId)
			table.drop("d_GE~e.wav")
			table.drop("d_X1~x1.wav")
			expect(table.hold("d_Y1~y1.wav", r, "or")).toBe(true)
			expect(table.hold("d_Y2~y2.wav", r, "or")).toBe(true)
			const b = table.takeJournalParts()
			expect(a).toHaveLength(2)
			expect(b).toHaveLength(2)
			expect(a[1]?.heldRecordings).toEqual([
				{ id: "d_X2~x2.wav", ownerId: q, observationId: "oq" },
			])
			expect(a[0]?.heldGuard?.folders).toEqual(["d_X2"])
			expect(b[0]?.heldGuard?.folders).toEqual(["d_Y2"])
			expect(a[0]?.heldGuard?.id).not.toBe(b[0]?.heldGuard?.id)
			const entry = (part: HeldJournalPart): Omit<JournalEntry, "seq"> => ({
				at: new Date(T0).toISOString(),
				op: "evidence",
				payload: {
					discoveries: [],
					observations: [],
					deleted: [],
					heldFormat: HELD_JOURNAL_FORMAT,
					...part,
				} satisfies StoreMutation,
			})
			const parts = {
				A0: entry(a[0] as HeldJournalPart),
				A1: entry(a[1] as HeldJournalPart),
				B0: entry(b[0] as HeldJournalPart),
				B1: entry(b[1] as HeldJournalPart),
			}
			return { root, snapshot, parts, repointed, table }
		}

		type Name = "A0" | "A1" | "B0" | "B1"
		/** Every order of the four parts that keeps each sequence's own order. */
		const ORDERS: Name[][] = [
			["A0", "A1", "B0", "B1"],
			["A0", "B0", "A1", "B1"],
			["A0", "B0", "B1", "A1"],
			["B0", "A0", "A1", "B1"],
			["B0", "A0", "B1", "A1"],
			["B0", "B1", "A0", "A1"],
		]

		/**
		 * After replaying `names`: every file a replayed sequence lists is protected (its entry or a
		 * mark answers for it, never "nobody"), whatever the other sequence's progress.
		 */
		function checkPrefix(
			store: DiscoveryStore,
			names: readonly Name[],
			repointed: readonly HeldRecordingEntry[],
		): void {
			const listed: string[] = []
			if (names.includes("A0")) {
				listed.push("d_X2~x2.wav")
				// X1 is A's until B drops it.
				if (!names.includes("B0")) listed.push("d_X1~x1.wav")
			}
			if (names.includes("B0")) listed.push("d_Y1~y1.wav", "d_Y2~y2.wav")
			for (const id of listed)
				expect(
					store.heldRecordingOwner(id),
					`${id} after ${names.join(",")}`,
				).not.toBeUndefined()
			for (const e of [repointed[0], repointed.at(-1)])
				if (e !== undefined)
					expect(store.heldRecordingOwner(e.id)).not.toBeUndefined()
		}

		it("one real persistence batch A0,B0,B1,A1: every prefix keeps X2, and the whole leaves no temporary mark", async () => {
			const s = await sequences()
			const dir = await tempRoot()
			const p = new ScannerPersistence({ dir, logger, now: () => T0 })
			await p.load()
			await p.writeSnapshot(s.snapshot)
			const order: Name[] = ["A0", "B0", "B1", "A1"]
			await Promise.all(order.map(n => p.append(s.parts[n])))
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			expect(loaded.entries).toHaveLength(4)
			for (let k = 1; k <= order.length; k++) {
				const replayed = restored(s.snapshot)
				for (const e of loaded.entries.slice(0, k)) replayed.replay(e)
				checkPrefix(replayed, order.slice(0, k), s.repointed)
				if (k === 2) {
					// The bug this guards against: B0 replacing the marks dropped X2's guard.
					expect(replayed.heldFolderUnknown("d_X2")).toBe(true)
					expect(replayed.heldFolderUnknown("d_Y2")).toBe(true)
				}
			}
			const whole = restored(s.snapshot)
			for (const e of loaded.entries) whole.replay(e)
			for (const f of ["d_X1", "d_X2", "d_Y1", "d_Y2", "d_GD", "d_GE"])
				expect(whole.heldFolderUnknown(f)).toBe(false)
			expect(whole.heldRecordingCounts.entries).toBe(s.table.size)
			expect(whole.heldRecordingCounts.overflowFolders).toBe(0)
		})

		for (const order of ORDERS)
			it(`replay order ${order.join(",")}: every prefix keeps every listed file; the whole closes both guards`, async () => {
				const s = await sequences()
				const entries = order.map((n, i) => ({ ...s.parts[n], seq: i + 1 }))
				for (let k = 1; k <= order.length; k++) {
					const replayed = restored(s.snapshot)
					for (const e of entries.slice(0, k)) replayed.replay(e)
					checkPrefix(replayed, order.slice(0, k), s.repointed)
				}
				const whole = restored(s.snapshot)
				for (const e of entries) whole.replay(e)
				for (const id of ["d_X2~x2.wav", "d_Y1~y1.wav", "d_Y2~y2.wav"])
					expect(whole.heldRecordingOwner(id)).not.toBeUndefined()
				// In the order the runtime took them (A's first part first) both guards close and no
				// mark is left. B's drop of X1 replayed before A adds it leaves X1 held, so a later
				// hold meets the full table and marks its folder: fail closed, never a lost file.
				if (order[0] === "A0")
					for (const f of ["d_X1", "d_X2", "d_Y1", "d_Y2", "d_GD", "d_GE"])
						expect(whole.heldFolderUnknown(f)).toBe(false)
			})

		it("B0,B1,A0,A1 then an unrelated replace of the marks: the replay-time refusal's mark stays", async () => {
			const s = await sequences()
			const order: Name[] = ["B0", "B1", "A0", "A1"]
			const whole = restored(s.snapshot)
			order.forEach((n, i) => whole.replay({ ...s.parts[n], seq: i + 1 }))
			// B1's Y2 met the full table on replay: its folder carries a replay safety mark.
			expect(whole.heldRecordingOwner("d_Y2~y2.wav")).toBeNull()
			whole.replay({
				seq: order.length + 1,
				at: new Date(T0).toISOString(),
				op: "evidence",
				payload: {
					discoveries: [],
					observations: [],
					deleted: [],
					heldOverflow: { folders: ["d_L"], all: false },
				} satisfies StoreMutation,
			})
			expect(whole.heldRecordingOwner("d_Y2~y2.wav")).not.toBeUndefined()
			expect(whole.heldFolderUnknown("d_Y2")).toBe(true)
			expect(whole.heldFolderUnknown("d_L")).toBe(true)
			// Persisted with the marks: a snapshot of the replayed store keeps it.
			expect(restored(whole.snapshot()).heldFolderUnknown("d_Y2")).toBe(true)
			// It ends only when its folder is gone from disk.
			whole.pruneHeldRecordings(
				() => true,
				id => id !== "d_Y2",
			)
			expect(whole.heldFolderUnknown("d_Y2")).toBe(false)
		})
	},
)

describe("temporary guards at their bounds", () => {
	const guard = (id: string, folders: string[], all = false) => ({
		id,
		folders,
		all,
	})

	it("a replace of the marks keeps every open guard; closing one keeps the others and adds its marks", () => {
		const table = new HeldRecordingTable()
		table.openGuard(guard("a-1", ["d_X"]))
		table.openGuard(guard("b-1", ["d_X", "d_Y"]))
		table.setOverflow({ folders: ["d_L"], all: false })
		expect(table.overflowed("d_X")).toBe(true)
		expect(table.overflowed("d_Y")).toBe(true)
		expect(table.overflowed("d_L")).toBe(true)
		table.closeGuard(guard("a-1", ["d_M"]))
		// B's guard still holds X though A, which also guarded X, closed.
		expect(table.overflowed("d_X")).toBe(true)
		expect(table.overflowed("d_M")).toBe(true)
		expect(table.overflowed("d_L")).toBe(true)
		table.closeGuard(guard("b-1", []))
		expect(table.overflowed("d_X")).toBe(false)
		expect(table.overflowed("d_Y")).toBe(false)
		expect(table.overflowState()).toEqual({
			folders: ["d_L", "d_M"],
			all: false,
		})
		// Replay marks are already journaled: nothing to write again.
		expect(table.takeOverflowChange()).toBeUndefined()
	})

	it("a guard never closed counts as marks, is persisted as marks, and ends when its folder is gone", () => {
		const table = new HeldRecordingTable()
		table.openGuard(guard("a-1", ["d_X"]))
		expect(table.overflowCount).toEqual({ folders: 1, all: false })
		expect(table.overflowState()).toEqual({ folders: ["d_X"], all: false })
		expect(table.overflowFolders()).toEqual(["d_X"])
		expect(table.releaseOverflow("d_X")).toBe(true)
		expect(table.overflowed("d_X")).toBe(false)
		const all = new HeldRecordingTable()
		all.openGuard(guard("a-2", [], true))
		expect(all.overflowed("d_ANY")).toBe(true)
		expect(all.overflowState()).toEqual({ folders: [], all: true })
		all.closeGuard(guard("a-2", []))
		expect(all.overflowed("d_ANY")).toBe(false)
	})

	it(`a guard promoted past ${HELD_OPEN_GUARDS_MAX} survives a replace of the marks until its folder is gone`, () => {
		const table = new HeldRecordingTable()
		for (let i = 0; i < HELD_OPEN_GUARDS_MAX; i++)
			table.openGuard(guard(`g-${i}`, [`d_G${i}`]))
		table.openGuard(guard("g-past", ["d_P"]))
		table.setOverflow({ folders: [], all: false })
		expect(table.overflowed("d_P")).toBe(true)
		expect(table.overflowState()?.folders).toContain("d_P")
		for (let i = 0; i < HELD_OPEN_GUARDS_MAX; i++)
			table.closeGuard(guard(`g-${i}`, []))
		table.closeGuard(guard("g-past", []))
		table.setOverflow(undefined)
		expect(table.overflowed("d_P")).toBe(true)
		expect(table.overflowFolders()).toEqual(["d_P"])
		expect(table.releaseOverflow("d_P")).toBe(true)
		expect(table.overflowed("d_P")).toBe(false)
		// A repeated guard id is promoted the same way; `all` never ends by itself.
		const again = new HeldRecordingTable()
		again.openGuard(guard("r-1", ["d_R"]))
		again.openGuard(guard("r-1", [], true))
		again.closeGuard(guard("r-1", []))
		again.setOverflow({ folders: [], all: false })
		expect(again.overflowed("d_ANY")).toBe(true)
		expect(again.overflowCount).toEqual({ folders: 0, all: true })
	})

	it(`replay safety marks: ${HELD_OVERFLOW_FOLDERS_MAX} kept one by one, one more marks every folder`, () => {
		const table = new HeldRecordingTable()
		table.restore(heldEntries(HELD_RECORDINGS_MAX, "d_B"))
		table.apply(
			Array.from({ length: HELD_OVERFLOW_FOLDERS_MAX }, (_, i) => ({
				id: `d_S${i}~s.wav`,
				ownerId: "d_B",
				observationId: "os",
			})),
		)
		table.setOverflow({ folders: [], all: false })
		expect(table.overflowCount).toEqual({
			folders: HELD_OVERFLOW_FOLDERS_MAX,
			all: false,
		})
		expect(table.overflowed("d_S0")).toBe(true)
		expect(table.overflowed("d_OTHER")).toBe(false)
		table.apply([{ id: "d_SX~s.wav", ownerId: "d_B", observationId: "os" }])
		table.setOverflow({ folders: [], all: false })
		expect(table.overflowCount).toEqual({ folders: 0, all: true })
		expect(table.overflowed("d_OTHER")).toBe(true)
		// Replay marks are never journaled by themselves.
		expect(table.takeOverflowChange()).toBeUndefined()
	})

	it(`at ${HELD_OPEN_GUARDS_MAX} open guards each still closes; one more is a mark at once`, () => {
		const table = new HeldRecordingTable()
		for (let i = 0; i < HELD_OPEN_GUARDS_MAX; i++)
			table.openGuard(guard(`g-${i}`, [`d_G${i}`]))
		table.openGuard(guard("g-past", ["d_P"]))
		for (let i = 0; i < HELD_OPEN_GUARDS_MAX; i++)
			table.closeGuard(guard(`g-${i}`, []))
		for (let i = 0; i < HELD_OPEN_GUARDS_MAX; i++)
			expect(table.overflowed(`d_G${i}`)).toBe(false)
		// Past the bound: kept, its close no longer ends it (fail closed).
		table.closeGuard(guard("g-past", []))
		expect(table.overflowed("d_P")).toBe(true)
	})

	it("a restore clears open guards; the guard schema and the writer's bound check hold the folder bound", () => {
		const table = new HeldRecordingTable()
		table.openGuard(guard("a-1", ["d_X"]))
		table.restore([])
		expect(table.overflowed("d_X")).toBe(false)
		const folders = Array.from(
			{ length: HELD_OVERFLOW_FOLDERS_MAX + 1 },
			(_, i) => `d_F${i}`,
		)
		for (const key of ["heldGuard", "heldGuardEnd"] as const) {
			expect(heldPayloadWithinBounds({ [key]: guard("a-1", folders) })).toBe(
				false,
			)
			expect(
				heldPayloadWithinBounds({ [key]: guard("a-1", folders.slice(1)) }),
			).toBe(true)
			const base = { discoveries: [], observations: [], deleted: [] }
			expect(
				StoreMutationSchema.safeParse({
					...base,
					[key]: guard("a-1", folders.slice(1)),
				}).success,
			).toBe(true)
			expect(
				StoreMutationSchema.safeParse({
					...base,
					[key]: guard("a-1", folders),
				}).success,
			).toBe(false)
		}
	})
})

describe("an analog failure cleanup never removes a file in a marked folder", () => {
	/** A's analog recording whose metadata step throws once the final WAV exists. */
	async function failedRecording(mark: boolean) {
		const root = await tempRoot()
		const first = newStore()
		const a =
			first.ingest(
				makeObs({
					id: "va",
					centreHz: BASE_HZ,
					startedAt: T0,
					cls: "analog-fm",
					open: true,
					gate: "passed",
				}),
			).discoveryId ?? ""
		expect(a).not.toBe("")
		const store = restored({
			...first.snapshot(),
			...(mark ? { heldOverflow: { folders: [a], all: false } } : {}),
		})
		expect(store.heldFolderUnknown(a)).toBe(mark)
		const ev = evidenceFor(root, () => store)
		let finalPath = ""
		ev.configureAnalog({
			...adapterOf(store),
			prepare: async metadata => {
				finalPath = join(root, metadata.artifact)
				expect(existsSync(finalPath)).toBe(true)
				throw new Error("synthetic metadata failure")
			},
		})
		await ev.recoverAnalog()
		const op = ev.beginAnalog({
			discoveryId: a,
			observationId: "va",
			binding: bindingOf(BASE_HZ),
		})
		await op.ready
		await op.push(new Int16Array([1, -2, 3, -4]))
		const receipt = await op.finish()
		expect(receipt.outcome).toBe("failed")
		expect(finalPath).not.toBe("")
		return { root, store, ev, a, finalPath, receipt }
	}

	it("marked: the WAV stays, cleanup pending; a restart quarantines it and retention keeps it", async () => {
		const s = await failedRecording(true)
		expect(existsSync(s.finalPath)).toBe(true)
		expect(s.receipt.cleanup).toBe("pending")
		await s.ev.stopAnalog()
		const next = restored(s.store.snapshot())
		const ev2 = evidenceFor(s.root, () => next)
		ev2.configureAnalog(adapterOf(next))
		await ev2.recoverAnalog()
		ev2.setCaps({ ...CAPS, maxRecordingsMb: 0, maxAgeDays: 0 })
		await ev2.retention(new Set())
		expect(existsSync(s.finalPath)).toBe(true)
		expect(next.delete(s.a)).toBe(true)
		await ev2.removeDiscovery(s.a)
		expect(existsSync(s.finalPath)).toBe(true)
		await ev2.stopAnalog()
	})

	it("unmarked: the same failure removes its own WAV (the path the mark guards)", async () => {
		const s = await failedRecording(false)
		expect(existsSync(s.finalPath)).toBe(false)
		expect(s.receipt.cleanup).toBe("complete")
		await s.ev.stopAnalog()
	})

	it("a folder marked while retention retires the file: the media unlink checks the mark itself", async () => {
		const root = await tempRoot()
		const store = newStore()
		let current = store
		const ev = evidenceFor(root, () => current)
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
		let markOnInverse = false
		ev.configureAnalog({
			...adapterOf(store),
			inverse: async id => {
				store.removePreparedRecording(id)
				// The mark lands after retention's own checks, before the media unlink.
				if (markOnInverse)
					current = restored({
						...store.snapshot(),
						heldOverflow: { folders: [a], all: false },
					})
			},
		})
		await ev.recoverAnalog()
		const receipt = await recordAnalog(ev, a, "va")
		const path = join(root, receipt.artifact ?? "")
		markOnInverse = true
		ev.setCaps({ ...CAPS, maxRecordingsMb: 0, maxAgeDays: 0 })
		await ev.retention(new Set())
		expect(current.heldFolderUnknown(a)).toBe(true)
		expect(existsSync(path)).toBe(true)
		await ev.stopAnalog()
	})
})

describe("only an entry of this writer's format is trusted with its refusal outcomes", () => {
	/**
	 * The table is full (65,536 entries: B's, and C's old.wav listed by B's observation o2 but
	 * recorded under A, stale). o2 lists C's old.wav and A~held.wav: the runtime re-points the
	 * first listing to B, refuses the second and marks A's folder.
	 */
	async function listing() {
		const root = await tempRoot()
		const first = newStore()
		const a = await discovery(first, root, 1)
		const b = await discovery(first, root, 2)
		const c = await discovery(first, root, 3)
		const heldPath = await writeWav(root, a, "held.wav")
		await writeWav(root, c, "old.wav")
		const snapshot: StoreSnapshot = {
			...first.snapshot(),
			heldRecordings: [
				...heldEntries(HELD_RECORDINGS_MAX - 1, b),
				{ id: `${c}~old.wav`, ownerId: a, observationId: "o2" },
			],
		}
		const store = restored(snapshot)
		const emitted: JournalEntry[] = []
		store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
			emitted.push({ ...e, seq: emitted.length + 1 }),
		)
		expect(
			store.attachRecordings("o2", [`${c}~old.wav`, `${a}~held.wav`], "linked"),
		).toBe(true)
		const entry = emitted.at(-1)
		const payload = payloadOf(entry)
		expect(payload?.heldRecordings).toEqual([
			{ id: `${c}~old.wav`, ownerId: b, observationId: "o2" },
		])
		expect(payload?.heldOverflow).toEqual({ folders: [a], all: false })
		return { root, snapshot, a, heldPath, entry: entry as JournalEntry }
	}

	/** The entry as an earlier format wrote it: held changes, no marks, no format marker. */
	function earlier(entry: JournalEntry, marks?: StoreMutation["heldOverflow"]) {
		const {
			heldOverflow: _marks,
			heldFormat: _format,
			...rest
		} = entry.payload as StoreMutation
		return {
			...entry,
			payload: {
				...rest,
				...(marks !== undefined ? { heldOverflow: marks } : {}),
			} satisfies StoreMutation,
		}
	}

	it("every entry this writer emits carries the format marker and parses", async () => {
		const s = await listing()
		expect(payloadOf(s.entry)?.heldFormat).toBe(HELD_JOURNAL_FORMAT)
		expect(StoreMutationSchema.safeParse(s.entry.payload).success).toBe(true)
		const store = newStore()
		const emitted: JournalEntry[] = []
		store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
			emitted.push({ ...e, seq: emitted.length + 1 }),
		)
		store.ingest(
			makeObs({
				id: "o9",
				centreHz: BASE_HZ,
				startedAt: T0,
				cls: "analog-fm",
				open: false,
				gate: "passed",
			}),
		)
		expect(emitted.length).toBeGreaterThan(0)
		for (const e of emitted)
			expect(payloadOf(e)?.heldFormat).toBe(HELD_JOURNAL_FORMAT)
		expect(
			StoreMutationSchema.safeParse({
				discoveries: [],
				observations: [],
				deleted: [],
				heldFormat: 1,
			}).success,
		).toBe(false)
	})

	it("this writer's entry replays to the runtime's marks", async () => {
		const s = await listing()
		const replayed = restored(s.snapshot)
		replayed.replay(s.entry)
		expect(replayed.heldFolderUnknown(s.a)).toBe(true)
		expect(replayed.heldRecordingCounts.overflowFolders).toBe(1)
	})

	for (const marks of [undefined, { folders: [], all: false }])
		it(`an earlier-format entry ${marks === undefined ? "without marks" : "replacing the marks with none"}: the re-derived refusal marks A's folder, and A's delete keeps B's WAV`, async () => {
			const s = await listing()
			const replayed = restored(s.snapshot)
			replayed.replay(earlier(s.entry, marks))
			expect(replayed.heldRecordingOwner(`${s.a}~held.wav`)).toBeNull()
			expect(replayed.heldFolderUnknown(s.a)).toBe(true)
			const ev = evidenceFor(s.root, () => replayed)
			await ev.loadFolderIndex()
			expect(replayed.delete(s.a)).toBe(true)
			await ev.removeDiscovery(s.a)
			expect(existsSync(s.heldPath)).toBe(true)
		})
})
