/**
 * Recording ownership with several listers per file (HeldRecordingTable keeps every listing).
 *
 * - A deleted lister removes only its own listing: B and C list A~call.wav, C then A are deleted,
 *   and B's listing still keeps the file.
 * - No recording folder is removed recursively: a nested file of a folder marked while the
 *   removal runs (a real full table refuses a listing after readdir) is kept.
 * - A listed file follows its listers' policy, never its physical folder's discovery unless that
 *   discovery lists it too: with only A kept, B's file in A's folder ages out with B's own files.
 * - State written by the single-holder format loads (snapshot entries, journaled changes,
 *   format marker 2) and fails closed.
 * - Every listing counts against the bound; at it the refused listing marks its folder.
 * - The folder's own listing outlives the observation window: A lists its file, 270 later
 *   observations push that listing out of the window, B then lists the file; A kept keeps it.
 *   A file A never listed still follows B alone.
 * - A probe publication never replaces a file already in the folder (same device: link; another
 *   device: copy with COPYFILE_EXCL): a taken name publishes under a fresh one.
 */
import { existsSync } from "node:fs"
import type * as FsPromisesModule from "node:fs/promises"
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	JournalEntry,
	StoreSnapshot,
} from "../../../../src/core/scanner/store/discovery-store.js"
import {
	EvidenceStore,
	PUBLISH_NAME_TRIES,
} from "../../../../src/core/scanner/store/evidence-store.js"
import type { StorageCaps } from "../../../../src/core/scanner/store/evidence-store.js"
import {
	HELD_JOURNAL_FORMAT,
	HELD_JOURNAL_FORMAT_SINGLE,
	HELD_RECORDINGS_MAX,
	HeldRecordingTable,
} from "../../../../src/core/scanner/store/held-recordings.js"
import type { HeldRecordingEntry } from "../../../../src/core/scanner/store/held-recordings.js"
import { StoreMutationSchema } from "../../../../src/core/scanner/store/schemas.js"
import type { StoreMutation } from "../../../../src/core/scanner/store/schemas.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

type FsPromises = typeof FsPromisesModule

/** Armed: after `dir`'s readdir settles, `step` runs when the next lstat settles. */
const hook = vi.hoisted(() => ({
	dir: null as string | null,
	listed: false,
	step: null as (() => void) | null,
	/** link() fails with EXDEV (another device: the copy fallback publishes). */
	exdev: false,
}))

vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<FsPromises>()
	const readdir = (async (...args: Parameters<FsPromises["readdir"]>) => {
		const result = await actual.readdir(...args)
		if (hook.dir !== null && String(args[0]) === hook.dir) hook.listed = true
		return result
	}) as FsPromises["readdir"]
	const lstat = (async (...args: Parameters<FsPromises["lstat"]>) => {
		const result = await actual.lstat(...args)
		const step = hook.step
		if (hook.listed && step !== null) {
			hook.step = null
			step()
		}
		return result
	}) as FsPromises["lstat"]
	const link = (async (...args: Parameters<FsPromises["link"]>) => {
		if (hook.exdev)
			throw Object.assign(new Error("EXDEV: cross-device link"), {
				code: "EXDEV",
			})
		return actual.link(...args)
	}) as FsPromises["link"]
	const wrapped = { readdir, lstat, link }
	return { ...actual, ...wrapped, default: { ...actual, ...wrapped } }
})

const logger = createLogger({ level: "fatal" })
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const DAY = 86_400_000
const BASE_HZ = 430_000_000
const CAPS: StorageCaps = {
	maxRecordingsMb: 20,
	maxEvidenceMb: 20,
	maxAgeDays: 30,
	minFreeDiskMb: 0,
}
const keepsNothing: RecordingProtection = {
	isProtected: () => false,
	isDsdFmeFileProtected: () => false,
	isScannerFileProtected: () => false,
	discoveryHoldsKept: () => false,
}
const MODES = [
	["without a protection port", undefined],
	["with a protection port", keepsNothing],
] as const
const dirs: string[] = []

afterEach(async () => {
	hook.dir = null
	hook.listed = false
	hook.step = null
	hook.exdev = false
	await Promise.all(
		dirs.splice(0).map(d => rm(d, { recursive: true, force: true })),
	)
})

async function tempRoot(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "wavekit-multi-")))
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

function evidenceFor(
	root: string,
	current: () => DiscoveryStore,
	protection: RecordingProtection | undefined,
	clock: { now: number } = { now: T0 },
): EvidenceStore {
	const ev = new EvidenceStore({
		dir: root,
		caps: CAPS,
		logger,
		now: () => clock.now,
		statfs: async () => ({ freeBytes: 1e12 }),
		isDiscoveryLive: id => current().get(id) !== undefined,
		aliases: {
			aliasOwner: id => current().aliasOwner(id),
			aliasesOf: id => current().aliasesOf(id),
			releaseAliases: id => current().releaseAliases(id),
			heldFileNames: (id, removing) => current().heldFileNames(id, removing),
			heldRecordingListers: id => current().heldRecordingListers(id),
			heldRecordingHolders: id => current().heldRecordingHolders(id),
			heldFolderUnknown: id => current().heldFolderUnknown(id),
		},
		...(protection ? { protection } : {}),
	})
	current().setFolderLookup(id => ev.folders.holds(id))
	return ev
}

async function writeWav(
	root: string,
	folderId: string,
	name: string,
): Promise<string> {
	const path = join(root, "recordings", "dv", folderId, name)
	await mkdir(join(path, ".."), { recursive: true })
	await writeFile(path, Buffer.alloc(4096))
	return path
}

/** Discovery n with observation `o<n>` and its own `call.wav`, listed by that observation. */
async function discovery(
	store: DiscoveryStore,
	root: string,
	n: number,
): Promise<{ id: string; own: string }> {
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
	const own = await writeWav(root, id, "call.wav")
	store.attachRecordings(`o${n}`, [`${id}~call.wav`], "linked")
	return { id, own }
}

async function age(...paths: string[]): Promise<void> {
	const old = new Date(T0 - 60 * DAY)
	for (const p of paths) await utimes(p, old, old)
}

/** `count` further observations of discovery n, pushing its earliest out of the window. */
function pushOutOfWindow(
	store: DiscoveryStore,
	n: number,
	id: string,
	count: number,
): void {
	for (let i = 0; i < count; i++)
		expect(
			store.ingest(
				makeObs({
					id: `o${n}w${i}`,
					centreHz: BASE_HZ + n * 100_000,
					startedAt: T0 + n * 1_000 + (i + 1) * 10_000,
					cls: "analog-fm",
					open: false,
					gate: "passed",
				}),
			).discoveryId,
		).toBe(id)
}

/** `count` listings held by `ownerId` of files in folders `d_F<i>` (no file on disk). */
function filler(count: number, ownerId: string): HeldRecordingEntry[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `d_F${i}~f${i}.wav`,
		ownerId,
		observationId: `oh${i}`,
	}))
}

for (const [mode, protection] of MODES)
	describe(`a deleted lister releases only its own listing (${mode})`, () => {
		it("B and C list A~call.wav; deleting C, then A, leaves the file B lists", async () => {
			const root = await tempRoot()
			const store = newStore()
			const ev = evidenceFor(root, () => store, protection)
			const a = await discovery(store, root, 1)
			const b = await discovery(store, root, 2)
			const c = await discovery(store, root, 3)
			const rid = `${a.id}~call.wav`
			expect(store.attachRecordings("o2", [rid], "linked")).toBe(true)
			expect(store.attachRecordings("o3", [rid], "linked")).toBe(true)
			await ev.loadFolderIndex()
			// Every lister, the folder's own discovery included once the file has another.
			expect(store.heldRecordingListers(rid)).toEqual([a.id, b.id, c.id].sort())
			expect(store.delete(c.id)).toBe(true)
			await ev.removeDiscovery(c.id)
			expect(store.heldRecordingListers(rid)).toEqual([a.id, b.id].sort())
			expect(store.delete(a.id)).toBe(true)
			await ev.removeDiscovery(a.id)
			expect(store.heldRecordingListers(rid)).toEqual([b.id])
			expect(existsSync(a.own)).toBe(true)
			expect(ev.recordingPath(rid)).toBe(a.own)
			// A's folder has no live owner now: retention keeps every file in it.
			await age(a.own)
			ev.setCaps({ ...CAPS, maxRecordingsMb: 0 })
			await ev.retention(new Set())
			expect(existsSync(a.own)).toBe(true)
			expect(ev.unresolvedFolderCount).toBe(1)
		})

		it("the listing survives a snapshot and a journal replay of the deletes", async () => {
			const root = await tempRoot()
			const store = newStore()
			const a = await discovery(store, root, 1)
			const b = await discovery(store, root, 2)
			const c = await discovery(store, root, 3)
			const rid = `${a.id}~call.wav`
			store.attachRecordings("o2", [rid], "linked")
			store.attachRecordings("o3", [rid], "linked")
			const base = store.snapshot()
			const entries: JournalEntry[] = []
			store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
				entries.push({ ...e, seq: entries.length + 1 }),
			)
			store.delete(c.id)
			store.delete(a.id)
			const fromSnapshot = newStore()
			fromSnapshot.restore(store.snapshot())
			const replayed = newStore()
			replayed.restore(base)
			for (const e of entries) replayed.replay(e)
			for (const s of [fromSnapshot, replayed]) {
				expect(s.heldRecordingListers(rid)).toEqual([b.id])
				const ev = evidenceFor(root, () => s, protection)
				await ev.loadFolderIndex()
				await ev.removeDiscovery(a.id)
				expect(existsSync(a.own)).toBe(true)
			}
		})
	})

for (const [mode, protection] of MODES)
	describe(`no recording folder is removed recursively (${mode})`, () => {
		it("a real full table refusing B's listing after readdir(A) marks A: the nested file stays too", async () => {
			const root = await tempRoot()
			const first = newStore()
			const a = await discovery(first, root, 1)
			const b = await discovery(first, root, 2)
			const nested = await writeWav(root, a.id, join("aaa", "precious.wav"))
			const store = newStore()
			store.restore({
				...first.snapshot(),
				heldRecordings: filler(HELD_RECORDINGS_MAX, b.id),
			})
			const ev = evidenceFor(root, () => store, protection)
			await ev.loadFolderIndex()
			expect(store.heldRecordingCounts.entries).toBe(HELD_RECORDINGS_MAX)
			expect(store.delete(a.id)).toBe(true)
			hook.dir = join(root, "recordings", "dv", a.id)
			hook.step = () => {
				// The table is full: the listing is refused and A's folder is marked.
				store.attachRecordings("o2", [`${a.id}~call.wav`], "linked")
			}
			await ev.removeDiscovery(a.id)
			expect(hook.step).toBeNull()
			expect(store.heldFolderUnknown(a.id)).toBe(true)
			expect(existsSync(a.own)).toBe(true)
			expect(existsSync(nested)).toBe(true)
		})

		it("without the interleave the nested file and its directories go with the folder", async () => {
			const root = await tempRoot()
			const store = newStore()
			const ev = evidenceFor(root, () => store, protection)
			const a = await discovery(store, root, 1)
			const nested = await writeWav(
				root,
				a.id,
				join("aaa", "bbb", "precious.wav"),
			)
			await ev.loadFolderIndex()
			expect(store.delete(a.id)).toBe(true)
			await ev.removeDiscovery(a.id)
			expect(existsSync(nested)).toBe(false)
			expect(existsSync(join(root, "recordings", "dv", a.id))).toBe(false)
		})

		it("a marked folder keeps its nested files at every depth; the empty directories stay only above them", async () => {
			const root = await tempRoot()
			const first = newStore()
			const a = await discovery(first, root, 1)
			const b = await discovery(first, root, 2)
			const deep = await writeWav(root, a.id, join("x", "y", "deep.wav"))
			const store = newStore()
			store.restore({
				...first.snapshot(),
				heldRecordings: filler(HELD_RECORDINGS_MAX, b.id),
			})
			store.attachRecordings("o2", [`${a.id}~call.wav`], "linked")
			expect(store.heldFolderUnknown(a.id)).toBe(true)
			const ev = evidenceFor(root, () => store, protection)
			await ev.loadFolderIndex()
			expect(store.delete(a.id)).toBe(true)
			await ev.removeDiscovery(a.id)
			expect(existsSync(deep)).toBe(true)
			expect(existsSync(a.own)).toBe(true)
		})
	})

for (const [mode, protection] of MODES)
	describe(`a listed file follows its listers, not its folder's discovery (${mode})`, () => {
		/** A's folder holds A's call.wav and held.wav, which B lists; B has its own. All aged. */
		async function scene(aListsHeld: boolean) {
			const root = await tempRoot()
			const store = newStore()
			const clock = { now: T0 }
			const ev = evidenceFor(root, () => store, protection, clock)
			const a = await discovery(store, root, 1)
			const b = await discovery(store, root, 2)
			const held = await writeWav(root, a.id, "held.wav")
			store.attachRecordings("o2", [`${a.id}~held.wav`], "linked")
			if (aListsHeld)
				store.attachRecordings("o1", [`${a.id}~held.wav`], "linked")
			await age(held, a.own, b.own)
			await ev.loadFolderIndex()
			return { root, store, ev, a, b, held }
		}

		it("only A kept: the file B lists ages out with B's own; A's own stays", async () => {
			const s = await scene(false)
			expect(s.store.heldRecordingListers(`${s.a.id}~held.wav`)).toEqual([
				s.b.id,
			])
			await s.ev.retention(new Set([s.a.id]))
			expect(existsSync(s.b.own)).toBe(false)
			expect(existsSync(s.held)).toBe(false)
			expect(existsSync(s.a.own)).toBe(true)
		})

		it("only A kept, by quota: the file B lists goes like B's own", async () => {
			const s = await scene(false)
			const recent = new Date(T0 - 2 * DAY)
			for (const p of [s.held, s.a.own, s.b.own])
				await utimes(p, recent, recent)
			s.ev.setCaps({ ...CAPS, maxRecordingsMb: 0 })
			await s.ev.retention(new Set([s.a.id]))
			expect(existsSync(s.held)).toBe(false)
			expect(existsSync(s.b.own)).toBe(false)
			expect(existsSync(s.a.own)).toBe(true)
		})

		it("A lists it too: kept while A is kept, though B is not", async () => {
			const s = await scene(true)
			expect(s.store.heldRecordingListers(`${s.a.id}~held.wav`)).toEqual(
				[s.a.id, s.b.id].sort(),
			)
			await s.ev.retention(new Set([s.a.id]))
			expect(existsSync(s.held)).toBe(true)
			expect(existsSync(s.b.own)).toBe(false)
		})

		it("only B kept: kept with B's own; A's own goes", async () => {
			const s = await scene(false)
			await s.ev.retention(new Set([s.b.id]))
			expect(existsSync(s.held)).toBe(true)
			expect(existsSync(s.b.own)).toBe(true)
			expect(existsSync(s.a.own)).toBe(false)
		})

		it("nobody kept: every listed file ages out", async () => {
			const s = await scene(true)
			await s.ev.retention(new Set())
			expect(existsSync(s.held)).toBe(false)
		})
	})

describe("state written by the single-holder format loads and fails closed", () => {
	it("a snapshot's single entries load as listings", async () => {
		const root = await tempRoot()
		const first = newStore()
		const a = await discovery(first, root, 1)
		const b = await discovery(first, root, 2)
		const store = newStore()
		store.restore({
			...first.snapshot(),
			heldRecordings: [
				{ id: `${a.id}~call.wav`, ownerId: b.id, observationId: "oX" },
			],
		})
		// A's own observation lists it too, so A is one of its listers once B is.
		expect(store.heldRecordingListers(`${a.id}~call.wav`)).toEqual(
			[a.id, b.id].sort(),
		)
		const ev = evidenceFor(root, () => store, undefined)
		await ev.loadFolderIndex()
		store.delete(a.id)
		await ev.removeDiscovery(a.id)
		expect(existsSync(a.own)).toBe(true)
	})

	/** A journal entry as the single-holder writer wrote it (format 2, or none). */
	function earlier(
		changes: StoreMutation["heldRecordings"],
		format: typeof HELD_JOURNAL_FORMAT_SINGLE | undefined,
	): JournalEntry {
		return {
			seq: 1,
			at: new Date(T0).toISOString(),
			op: "evidence",
			payload: {
				discoveries: [],
				observations: [],
				deleted: [],
				heldRecordings: changes ?? [],
				...(format !== undefined ? { heldFormat: format } : {}),
			} satisfies StoreMutation,
		}
	}

	for (const format of [HELD_JOURNAL_FORMAT_SINGLE, undefined] as const)
		it(`a format ${format ?? "unmarked"} entry parses; its re-point adds a listing and its drop removes none`, async () => {
			const root = await tempRoot()
			const first = newStore()
			const a = await discovery(first, root, 1)
			const b = await discovery(first, root, 2)
			const c = await discovery(first, root, 3)
			const rid = `${a.id}~call.wav`
			const store = newStore()
			store.restore({
				...first.snapshot(),
				heldRecordings: [{ id: rid, ownerId: b.id, observationId: "oB" }],
			})
			// The single holder moved from B to C (a re-point), then dropped the file's entry.
			const repoint = earlier(
				[{ id: rid, ownerId: c.id, observationId: "oC" }],
				format,
			)
			const drop = earlier([{ id: rid, ownerId: null }], format)
			for (const e of [repoint, drop])
				expect(StoreMutationSchema.safeParse(e.payload).success).toBe(true)
			const all = [a.id, b.id, c.id].sort()
			store.replay(repoint)
			expect(store.heldRecordingListers(rid)).toEqual(all)
			store.replay({ ...drop, seq: 2 })
			// Fail closed: the drop named no listing, so every listing stays until the prune.
			expect(store.heldRecordingListers(rid)).toEqual(all)
			const ev = evidenceFor(root, () => store, undefined)
			await ev.loadFolderIndex()
			store.delete(a.id)
			await ev.removeDiscovery(a.id)
			expect(existsSync(a.own)).toBe(true)
			// The prune drops listings whose file is gone (here: none are).
			expect(store.pruneHeldRecordings(() => true)).toBe(0)
			// A's own listing went with A; B's and C's remain until their file is gone.
			expect(store.pruneHeldRecordings(() => false)).toBe(2)
			expect(store.heldRecordingListers(rid)).toEqual([])
		})

	it("this writer's drop names one listing and leaves the file's others", () => {
		const table = new HeldRecordingTable()
		table.hold("d_A~x.wav", "d_B", "oB")
		table.hold("d_A~x.wav", "d_C", "oC")
		table.takeChangeChunks()
		table.dropOwner("d_C")
		const [chunk] = table.takeChangeChunks()
		expect(chunk).toEqual([
			{ id: "d_A~x.wav", ownerId: null, observationId: "oC" },
		])
		const replay = new HeldRecordingTable()
		replay.restore([
			{ id: "d_A~x.wav", ownerId: "d_B", observationId: "oB" },
			{ id: "d_A~x.wav", ownerId: "d_C", observationId: "oC" },
		])
		replay.apply(chunk ?? [], HELD_JOURNAL_FORMAT)
		expect(replay.holders("d_A~x.wav")).toEqual(["d_B"])
	})

	it("an unknown format marker is refused", () => {
		expect(
			StoreMutationSchema.safeParse({
				discoveries: [],
				observations: [],
				deleted: [],
				heldFormat: HELD_JOURNAL_FORMAT + 1,
			}).success,
		).toBe(false)
	})
})

describe("every listing counts against the bound", () => {
	it("two listings of one file are two entries; a merge moves both, a deleted holder drops its own", () => {
		const table = new HeldRecordingTable()
		expect(table.hold("d_A~x.wav", "d_B", "o1")).toBe(true)
		expect(table.hold("d_A~x.wav", "d_B", "o2")).toBe(true)
		expect(table.hold("d_A~x.wav", "d_C", "o3")).toBe(true)
		expect(table.size).toBe(3)
		expect(table.holders("d_A~x.wav")).toEqual(["d_B", "d_C"])
		table.moveOwner("d_B", "d_D")
		expect(table.holders("d_A~x.wav")).toEqual(["d_C", "d_D"])
		table.dropOwner("d_C")
		expect(table.holders("d_A~x.wav")).toEqual(["d_D"])
		expect(table.size).toBe(2)
	})

	it("a merge into the folder's own discovery collapses a file only it lists, never one another lists", () => {
		const table = new HeldRecordingTable()
		table.hold("d_A~only.wav", "d_B", "o1")
		table.hold("d_A~shared.wav", "d_B", "o1")
		table.hold("d_A~shared.wav", "d_C", "o2")
		table.moveOwner("d_B", "d_A")
		expect(table.has("d_A~only.wav")).toBe(false)
		expect(table.holders("d_A~shared.wav")).toEqual(["d_A", "d_C"])
	})

	it("one below the bound a second listing is held; at it the refused listing marks its folder", () => {
		const table = new HeldRecordingTable()
		table.restore(filler(HELD_RECORDINGS_MAX - 1, "d_B"))
		expect(table.hold("d_A~x.wav", "d_B", "o1")).toBe(true)
		expect(table.size).toBe(HELD_RECORDINGS_MAX)
		expect(table.overflowed("d_A")).toBe(false)
		// A re-point at the bound is no new entry: held.
		expect(table.hold("d_A~x.wav", "d_C", "o1")).toBe(true)
		// A second listing of the same file is: refused, its folder marked (fail closed).
		expect(table.hold("d_A~x.wav", "d_D", "o2")).toBe(false)
		expect(table.overflowed("d_A")).toBe(true)
		expect(table.takeRefused()).toBe(1)
	})

	it("the store's listers fail closed on a marked folder and list the folder's own discovery only when it lists the file", async () => {
		const root = await tempRoot()
		const first = newStore()
		const a = await discovery(first, root, 1)
		const b = await discovery(first, root, 2)
		const store = newStore()
		store.restore({
			...first.snapshot(),
			heldRecordings: filler(HELD_RECORDINGS_MAX - 1, b.id),
		})
		// B lists A's own call.wav: the one free entry; A's own listing then meets the bound.
		store.attachRecordings("o2", [`${a.id}~call.wav`], "linked")
		expect(store.heldRecordingListers(`${a.id}~call.wav`)).toBeNull()
		expect(store.heldFolderUnknown(a.id)).toBe(true)
		const snapshot: StoreSnapshot = store.snapshot()
		expect(snapshot.heldOverflow?.folders).toContain(a.id)
	})
})

for (const [mode, protection] of MODES)
	describe(`the folder's own listing outlives the observation window (${mode})`, () => {
		it("A lists its file, 270 observations later B lists it too: A kept keeps it (snapshot, replay and prune too)", async () => {
			const root = await tempRoot()
			const store = newStore()
			const a = await discovery(store, root, 1)
			const base = store.snapshot()
			const entries: JournalEntry[] = []
			store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
				entries.push({ ...e, seq: entries.length + 1 }),
			)
			pushOutOfWindow(store, 1, a.id, 270)
			// A's listing left the window.
			expect(store.discoveryIdOf("o1")).toBeUndefined()
			// The maintenance prune keeps that listing: it is the only record of it.
			expect(store.pruneHeldRecordings(() => true)).toBe(0)
			const b = await discovery(store, root, 2)
			const rid = `${a.id}~call.wav`
			expect(store.attachRecordings("o2", [rid], "linked")).toBe(true)
			expect(store.heldRecordingListers(rid)).toEqual([a.id, b.id].sort())
			const fromSnapshot = newStore()
			fromSnapshot.restore(store.snapshot())
			const replayed = newStore()
			replayed.restore(base)
			for (const e of entries) replayed.replay(e)
			await age(b.own)
			for (const s of [store, fromSnapshot, replayed]) {
				expect(s.heldRecordingListers(rid)).toEqual([a.id, b.id].sort())
				const ev = evidenceFor(root, () => s, protection)
				await age(a.own)
				await ev.loadFolderIndex()
				await ev.retention(new Set([a.id]))
				expect(existsSync(a.own)).toBe(true)
				ev.setCaps({ ...CAPS, maxRecordingsMb: 0 })
				await ev.retention(new Set([a.id]))
				expect(existsSync(a.own)).toBe(true)
			}
			// B's own file went (B not kept): the pass is not trivially keeping everything.
			expect(existsSync(b.own)).toBe(false)
		})

		it("a file A never listed, past the window too, still follows B alone", async () => {
			const root = await tempRoot()
			const store = newStore()
			const ev = evidenceFor(root, () => store, protection)
			const a = await discovery(store, root, 1)
			pushOutOfWindow(store, 1, a.id, 270)
			const b = await discovery(store, root, 2)
			const held = await writeWav(root, a.id, "held.wav")
			store.attachRecordings("o2", [`${a.id}~held.wav`], "linked")
			expect(store.heldRecordingListers(`${a.id}~held.wav`)).toEqual([b.id])
			await age(held, a.own, b.own)
			await ev.loadFolderIndex()
			await ev.retention(new Set([a.id]))
			expect(existsSync(held)).toBe(false)
			expect(existsSync(a.own)).toBe(true)
		})
	})

describe("a merge keeps a listing that left the window", () => {
	it("a file only the survivor lists keeps its aged listing; one in the window collapses", () => {
		const table = new HeldRecordingTable()
		table.hold("d_A~aged.wav", "d_A", "oAged")
		table.hold("d_A~aged.wav", "d_B", "o1")
		table.hold("d_A~fresh.wav", "d_A", "o2")
		table.hold("d_A~fresh.wav", "d_B", "o3")
		table.moveOwner("d_B", "d_A", id => id !== "oAged")
		expect(table.holders("d_A~aged.wav")).toEqual(["d_A"])
		expect(table.has("d_A~fresh.wav")).toBe(false)
	})
})

describe("a probe publication never replaces a file in the folder", () => {
	const NAME = "20261009_120000_00001_x_GROUP_TGT_100_SRC_200.wav"
	for (const exdev of [false, true])
		it(`B lists A's ${NAME.slice(0, 15)}… and a probe file of that name arrives (${exdev ? "copy fallback" : "same device"})`, async () => {
			const root = await tempRoot()
			const store = newStore()
			const ev = evidenceFor(root, () => store, undefined)
			const a = await discovery(store, root, 1)
			await discovery(store, root, 2)
			const original = join(root, "recordings", "dv", a.id, NAME)
			await writeFile(original, "original")
			store.attachRecordings("o2", [`${a.id}~${NAME}`], "linked")
			// A second probe file, one name further, also taken: the next fresh name.
			const dup1 = NAME.replace("_00001_", "_00001_dup1_")
			await writeFile(join(root, "recordings", "dv", a.id, dup1), "taken")
			const probe = join(root, "recordings", "dv", "probe-1")
			await mkdir(probe, { recursive: true })
			await writeFile(join(probe, NAME), "probe")
			await ev.loadFolderIndex()
			hook.exdev = exdev
			const at = new Date(2026, 9, 9, 12, 0, 0).getTime()
			const out = await ev.linkProbeRecordings(probe, [
				{
					observationId: "o1",
					discoveryId: a.id,
					talkgroup: "100",
					source: "200",
					startedAt: at,
					endedAt: at + 5_000,
					encrypted: false,
				},
			])
			expect(await readFile(original, "utf8")).toBe("original")
			expect(
				await readFile(join(root, "recordings", "dv", a.id, dup1), "utf8"),
			).toBe("taken")
			const fresh = NAME.replace("_00001_", "_00001_dup2_")
			expect(out.linked).toEqual([
				{ observationId: "o1", recordingId: `${a.id}~${fresh}` },
			])
			expect(
				await readFile(join(root, "recordings", "dv", a.id, fresh), "utf8"),
			).toBe("probe")
			expect(existsSync(probe)).toBe(false)
			expect(
				(await readdir(join(root, "recordings", "dv", a.id))).sort(),
			).toEqual(["call.wav", NAME, dup1, fresh].sort())
		})

	it(`every one of the ${PUBLISH_NAME_TRIES} names taken: nothing is published and nothing replaced`, async () => {
		const root = await tempRoot()
		const store = newStore()
		const ev = evidenceFor(root, () => store, undefined)
		const a = await discovery(store, root, 1)
		const folder = join(root, "recordings", "dv", a.id)
		const taken = [
			NAME,
			...Array.from({ length: PUBLISH_NAME_TRIES - 1 }, (_, i) =>
				NAME.replace("_00001_", `_00001_dup${i + 1}_`),
			),
		]
		for (const n of taken) await writeFile(join(folder, n), "taken")
		const probe = join(root, "recordings", "dv", "probe-3")
		await mkdir(probe, { recursive: true })
		await writeFile(join(probe, NAME), "probe")
		const at = new Date(2026, 9, 9, 12, 0, 0).getTime()
		const out = await ev.linkProbeRecordings(probe, [
			{
				observationId: "o1",
				discoveryId: a.id,
				startedAt: at,
				endedAt: at + 5_000,
				encrypted: false,
			},
		])
		expect(out.linked).toEqual([])
		for (const n of taken)
			expect(await readFile(join(folder, n), "utf8")).toBe("taken")
		expect((await readdir(folder)).length).toBe(taken.length + 1)
		expect(existsSync(probe)).toBe(false)
	})

	it("a free name publishes as itself and the probe file goes", async () => {
		const root = await tempRoot()
		const store = newStore()
		const ev = evidenceFor(root, () => store, undefined)
		const a = await discovery(store, root, 1)
		const probe = join(root, "recordings", "dv", "probe-2")
		await mkdir(probe, { recursive: true })
		await writeFile(join(probe, NAME), "probe")
		const at = new Date(2026, 9, 9, 12, 0, 0).getTime()
		const out = await ev.linkProbeRecordings(probe, [
			{
				observationId: "o1",
				discoveryId: a.id,
				startedAt: at,
				endedAt: at + 5_000,
				encrypted: false,
			},
		])
		expect(out.linked).toEqual([
			{ observationId: "o1", recordingId: `${a.id}~${NAME}` },
		])
		expect(
			await readFile(join(root, "recordings", "dv", a.id, NAME), "utf8"),
		).toBe("probe")
	})
})
