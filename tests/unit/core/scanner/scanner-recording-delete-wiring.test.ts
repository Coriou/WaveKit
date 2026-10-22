/**
 * WG10 RK2 seam: EvidenceStore.deleteRecording + DiscoveryStore.forgetRecording with real stores
 * in mkdtemp dirs, driven through the keep service and createScannerRecordingDeleter
 * (requirements 1.1-1.4).
 */
import * as nodeFs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import { openRecordingKeepService } from "../../../../src/core/recordings/keep-service.js"
import type { RecordingKeepServiceInternal } from "../../../../src/core/recordings/keep-service.js"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import { nodeRecordingDeleteFs } from "../../../../src/core/recordings/verified-unlink.js"
import type { RecordingDeleteFs } from "../../../../src/core/recordings/verified-unlink.js"
import { createScannerRecordingDeleter } from "../../../../src/core/scanner/recording-delete.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { Logger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"
import { lateBoundScannerDeleter } from "../../../../src/index.js"
import type { ScannerRecordingDeleter } from "../../../../src/core/recordings/contract.js"

const CH = 446_006_250
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const CAPS = {
	maxRecordingsMb: 100,
	maxEvidenceMb: 100,
	maxAgeDays: 30,
	minFreeDiskMb: 0,
}

function wav(dataBytes: number): Buffer {
	const b = Buffer.alloc(44 + dataBytes)
	b.write("RIFF", 0, "ascii")
	b.writeUInt32LE(36 + dataBytes, 4)
	b.write("WAVEfmt ", 8, "ascii")
	b.writeUInt32LE(16, 16)
	b.writeUInt16LE(1, 20)
	b.writeUInt16LE(1, 22)
	b.writeUInt32LE(8000, 24)
	b.writeUInt32LE(16000, 28)
	b.writeUInt16LE(2, 32)
	b.writeUInt16LE(16, 34)
	b.write("data", 36, "ascii")
	b.writeUInt32LE(dataBytes, 40)
	return b
}

const roots: string[] = []
afterEach(async () => {
	for (const r of roots.splice(0))
		await nodeFs.rm(r, { recursive: true, force: true })
})

type Counted = RecordingDeleteFs & { calls: string[] }
function counted(over: Partial<RecordingDeleteFs> = {}): Counted {
	const calls: string[] = []
	const base = { ...nodeRecordingDeleteFs, ...over }
	const out = { calls } as Counted
	for (const k of Object.keys(
		nodeRecordingDeleteFs,
	) as (keyof RecordingDeleteFs)[]) {
		const fn = base[k] as (...a: unknown[]) => Promise<unknown>
		;(out as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => {
			calls.push(k)
			return fn(...a)
		}
	}
	return out
}

interface World {
	root: string
	stateDir: string
	dv: string
	discoveryId: string
	fileA: string
	fileB: string
	idA: string
	idB: string
	scanA: string
	scanB: string
	store: DiscoveryStore
	evidence: EvidenceStore
	svc: RecordingKeepServiceInternal
	entries: Omit<JournalEntry, "seq">[]
	changes: [string, string][]
	logs: unknown[][]
	deleteFs: Counted
}

async function world(
	opts: {
		deleteFs?: Partial<RecordingDeleteFs>
		badStore?: boolean
		/** Main wiring: the deleter as src/index.ts binds it (late, through the scanner getter). */
		lateBound?: { bound: boolean }
	} = {},
): Promise<World> {
	const root = await nodeFs.mkdtemp(join(tmpdir(), "wk-scandelw-"))
	roots.push(root)
	const now = Date.now() + 60_000
	const logs: unknown[][] = []
	const l: Record<string, unknown> = {}
	for (const level of ["warn", "info", "debug", "error", "trace", "fatal"])
		l[level] = vi.fn((...args: unknown[]) => {
			logs.push([level, ...args])
		})
	l["child"] = () => l
	const logger = l as unknown as Logger
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
	})
	const entries: Omit<JournalEntry, "seq">[] = []
	const changes: [string, string][] = []
	store.on("mutation", (e: Omit<JournalEntry, "seq">) => entries.push(e))
	store.on("change", (id: string, change: string) => changes.push([id, change]))
	const discoveryId =
		store.ingest(
			makeObs({
				id: "o1",
				centreHz: CH,
				startedAt: T0,
				cls: "fsk4-12k5",
				hypotheses: [["dmr", 0.8]],
			}),
		).discoveryId ?? ""
	const stateDir = join(root, "state")
	const storage = join(root, "scanner")
	const dv = join(storage, "recordings", "dv")
	await nodeFs.mkdir(stateDir)
	await nodeFs.mkdir(join(dv, discoveryId), { recursive: true, mode: 0o755 })
	const fileA = join(dv, discoveryId, "a.wav")
	const fileB = join(dv, discoveryId, "b.wav")
	for (const f of [fileA, fileB]) {
		await nodeFs.writeFile(f, wav(16_000))
		const t = (now - 30_000) / 1000
		await nodeFs.utimes(f, t, t)
	}
	const idA = `${discoveryId}~a.wav`
	const idB = `${discoveryId}~b.wav`
	store.attachRecordings("o1", [idA, idB], "linked")
	if (opts.badStore)
		await nodeFs.writeFile(join(stateDir, "recording-keeps.json"), "{bad")
	let svc: RecordingKeepServiceInternal | null = null
	const protection: RecordingProtection = {
		isProtected: k => svc?.isProtected(k) ?? true,
		isDsdFmeFileProtected: n => svc?.isDsdFmeFileProtected(n) ?? true,
		isScannerFileProtected: (d, n) => svc?.isScannerFileProtected(d, n) ?? true,
		discoveryHoldsKept: d => svc?.discoveryHoldsKept(d) ?? true,
	}
	const deleteFs = counted(opts.deleteFs)
	const evidence = new EvidenceStore({
		dir: storage,
		caps: CAPS,
		logger,
		now: () => now,
		statfs: async () => ({ freeBytes: 1e12 }),
		isDiscoveryLive: id => store.get(id) !== undefined,
		protection,
		recordingDeleteFs: deleteFs,
	})
	const inventory = createRecordingInventory({
		dsdFmeDirs: () => [],
		scannerRecordingsDir: () => join(storage, "recordings"),
		now: () => now,
		logger,
	})
	svc = (await openRecordingKeepService({
		stateDir,
		inventory,
		logger,
		now: () => now,
		scannerDeleter: ((): ScannerRecordingDeleter => {
			const real = createScannerRecordingDeleter({
				evidence,
				discovery: store,
				logger,
			})
			const late = opts.lateBound
			if (!late) return real
			return lateBoundScannerDeleter(() =>
				late.bound ? { scannerRecordingDeleter: () => real } : null,
			)
		})(),
	})) as RecordingKeepServiceInternal
	entries.length = 0
	changes.length = 0
	return {
		root,
		stateDir,
		dv,
		discoveryId,
		fileA,
		fileB,
		idA,
		idB,
		scanA: `scan:${idA}`,
		scanB: `scan:${idB}`,
		store,
		evidence,
		svc,
		entries,
		changes,
		logs,
		deleteFs,
	}
}

const gone = (p: string) =>
	expect(nodeFs.lstat(p)).rejects.toMatchObject({ code: "ENOENT" })

function noSecrets(w: World): void {
	const text = JSON.stringify(w.logs)
	for (const s of [w.discoveryId, "a.wav", "b.wav", w.root])
		expect(text).not.toContain(s)
}

async function privateLeft(dir: string): Promise<string[]> {
	return (await nodeFs.readdir(dir)).filter(n =>
		n.startsWith(".wavekit-delete-"),
	)
}

describe("scanner recording delete through real stores (WG10 req 1.1-1.4)", () => {
	it("unlinks the file, forgets the id, updates the count, journals and emits updated, within budget", async () => {
		const w = await world()
		await expect(w.svc.remove(w.scanA)).resolves.toEqual({
			id: w.scanA,
			deleted: true,
		})
		await gone(w.fileA)
		await nodeFs.lstat(w.fileB)
		const obs = w.store.snapshot().observations.find(o => o.id === "o1")
		expect(obs?.recordingIds).toEqual([w.idB])
		expect(w.store.get(w.discoveryId)?.evidence.recordings).toBe(1)
		expect(w.changes).toEqual([[w.discoveryId, "updated"]])
		expect(w.entries).toHaveLength(1)
		expect(w.entries[0]?.op).toBe("evidence")
		expect(w.evidence.recordingPath(w.idA)).toBeNull()
		const n = (op: string) => w.deleteFs.calls.filter(c => c === op).length
		expect(n("lstat")).toBeLessThanOrEqual(6)
		expect(n("rename")).toBe(2)
		expect(n("unlink")).toBe(1)
		expect(await privateLeft(join(w.dv, w.discoveryId))).toEqual([])
		noSecrets(w)
	})

	it("a second delete of the same id answers 404 and changes nothing", async () => {
		const w = await world()
		await w.svc.remove(w.scanA)
		w.changes.length = 0
		await expect(w.svc.remove(w.scanA)).rejects.toMatchObject({ status: 404 })
		expect(w.changes).toEqual([])
		expect(w.store.get(w.discoveryId)?.evidence.recordings).toBe(1)
	})

	it("the count never drops below zero", () => {
		const { store } = (() => {
			const s = new DiscoveryStore({
				maxDiscoveries: 10,
				now: () => T0,
				newId: counterIds(),
			})
			return { store: s }
		})()
		const id =
			store.ingest(
				makeObs({
					id: "o9",
					centreHz: CH,
					startedAt: T0,
					cls: "fsk4-12k5",
					hypotheses: [["dmr", 0.8]],
				}),
			).discoveryId ?? ""
		store.attachRecordings("o9", [`${id}~x.wav`], "linked")
		store.setEvidenceFlags(id, { recordings: 0 })
		expect(store.forgetRecording(`${id}~x.wav`)).toBe(true)
		expect(store.get(id)?.evidence.recordings).toBe(0)
		expect(store.forgetRecording(`${id}~x.wav`)).toBe(false)
	})

	it("kept answers 409 and leaves the file and the bookkeeping", async () => {
		const w = await world()
		await w.svc.keep(w.scanA)
		w.changes.length = 0
		await expect(w.svc.remove(w.scanA)).rejects.toMatchObject({
			code: "RECORDING_KEPT",
			status: 409,
		})
		await nodeFs.lstat(w.fileA)
		expect(w.changes).toEqual([])
		expect(w.deleteFs.calls).toEqual([])
	})

	it("a Keep during the delete answers 409 RECORDING_BUSY and the delete completes", async () => {
		let w: World | null = null
		let keepResult: unknown = null
		let fired = false
		w = await world({
			deleteFs: {
				lstat: async p => {
					if (!fired && w) {
						fired = true
						keepResult = await w.svc.keep(w.scanA).catch((e: unknown) => e)
					}
					return nodeFs.lstat(p)
				},
			},
		})
		await expect(w.svc.remove(w.scanA)).resolves.toMatchObject({
			deleted: true,
		})
		expect(keepResult).toMatchObject({ code: "RECORDING_BUSY", status: 409 })
		await gone(w.fileA)
	})

	it("a discovery being removed answers 409 RECORDING_BUSY with nothing touched", async () => {
		const w = await world()
		const removal = w.evidence.removeDiscovery(w.discoveryId)
		await expect(w.svc.remove(w.scanA)).rejects.toMatchObject({
			code: "RECORDING_BUSY",
			status: 409,
		})
		await removal.catch(() => undefined)
		expect(w.deleteFs.calls).toEqual([])
		expect(w.changes).toEqual([])
	})

	it("an analog recording answers 409 RECORDING_DELETE_UNSUPPORTED", async () => {
		const w = await world()
		const id = `scan:${w.discoveryId}~analog-0123abcd-0123-4567-89ab-0123456789ab.wav`
		await expect(w.svc.remove(id)).rejects.toMatchObject({
			code: "RECORDING_DELETE_UNSUPPORTED",
			status: 409,
		})
		expect(w.deleteFs.calls).toEqual([])
	})

	it("a vanished file answers 404 and changes no bookkeeping", async () => {
		const w = await world()
		await nodeFs.unlink(w.fileA)
		await expect(w.svc.remove(w.scanA)).rejects.toMatchObject({
			code: "RECORDING_NOT_FOUND",
			status: 404,
		})
		expect(w.changes).toEqual([])
		expect(w.store.get(w.discoveryId)?.evidence.recordings).toBe(2)
	})

	it("an unknown discovery answers 404", async () => {
		const w = await world()
		await expect(w.svc.remove("scan:d_NOPE~a.wav")).rejects.toMatchObject({
			status: 404,
		})
	})

	it("a file swapped after the verified open is not unlinked (404)", async () => {
		const other = "OTHER"
		let w: World | null = null
		let swapped = false
		w = await world({
			deleteFs: {
				lstat: async p => {
					if (!swapped && w && p === w.fileA) {
						swapped = true
						await nodeFs.rename(w.fileA, join(w.root, "moved.wav"))
						await nodeFs.writeFile(w.fileA, other)
					}
					return nodeFs.lstat(p)
				},
			},
		})
		await expect(w.svc.remove(w.scanA)).rejects.toMatchObject({ status: 404 })
		expect(await nodeFs.readFile(w.fileA, "utf8")).toBe(other)
		await nodeFs.lstat(join(w.root, "moved.wav"))
		expect(w.deleteFs.calls.filter(c => c === "unlink")).toEqual([])
		expect(w.changes).toEqual([])
	})

	it("a discovery folder swapped between verification and unlink deletes nothing (404)", async () => {
		let w: World | null = null
		let movedDir = ""
		w = await world({
			deleteFs: {
				lstat: async p => {
					const st = await nodeFs.lstat(p)
					if (w && movedDir === "" && p.endsWith("/verified")) {
						const dir = join(w.dv, w.discoveryId)
						movedDir = `${dir}-moved`
						await nodeFs.rename(dir, movedDir)
						await nodeFs.mkdir(dir)
						await nodeFs.writeFile(join(dir, "a.wav"), "DECOY")
					}
					return st
				},
			},
		})
		await expect(w.svc.remove(w.scanA)).rejects.toMatchObject({ status: 404 })
		expect(w.deleteFs.calls.filter(c => c === "unlink")).toEqual([])
		expect(
			await nodeFs.readFile(join(w.dv, w.discoveryId, "a.wav"), "utf8"),
		).toBe("DECOY")
		// The verified file was never unlinked: it is still in the moved folder's private dir.
		const left = await privateLeft(movedDir)
		expect(left).toHaveLength(1)
		expect(await nodeFs.readdir(join(movedDir, left[0] ?? ""))).toEqual([
			"verified",
		])
		expect(w.changes).toEqual([])
	})

	it("a discovery folder replaced by a symlink before the delete answers 404 with nothing touched", async () => {
		const w = await world()
		const dir = join(w.dv, w.discoveryId)
		const real = join(w.root, "elsewhere")
		await nodeFs.rename(dir, real)
		await nodeFs.symlink(real, dir)
		await expect(w.svc.remove(w.scanA)).rejects.toMatchObject({ status: 404 })
		await nodeFs.lstat(join(real, "a.wav"))
		expect(w.deleteFs.calls).toEqual([])
	})

	it("a symlinked ancestor (recordings/dv) answers 404 with nothing touched", async () => {
		const w = await world()
		const real = join(w.root, "dv-real")
		await nodeFs.rename(w.dv, real)
		await nodeFs.symlink(real, w.dv)
		await expect(w.svc.remove(w.scanA)).rejects.toMatchObject({ status: 404 })
		await nodeFs.lstat(join(real, w.discoveryId, "a.wav"))
		expect(w.deleteFs.calls).toEqual([])
	})

	it("a symlink at the recording's name is never followed (404)", async () => {
		const w = await world()
		const target = join(w.root, "target.wav")
		await nodeFs.writeFile(target, "T")
		await nodeFs.unlink(w.fileA)
		await nodeFs.symlink(target, w.fileA)
		await expect(w.svc.remove(w.scanA)).rejects.toMatchObject({ status: 404 })
		expect(await nodeFs.readFile(target, "utf8")).toBe("T")
		expect((await nodeFs.lstat(w.fileA)).isSymbolicLink()).toBe(true)
	})

	it("a bookkeeping failure after the unlink answers 200 and logs a count", async () => {
		const w = await world()
		w.store.once("mutation", () => {
			throw new Error(`journal down at ${w.root}`)
		})
		await expect(w.svc.remove(w.scanA)).resolves.toMatchObject({
			deleted: true,
		})
		await gone(w.fileA)
		expect(JSON.stringify(w.logs)).toContain(
			"Scanner recording deleted; its bookkeeping could not be updated",
		)
		expect(JSON.stringify(w.logs)).toContain('"dangling":1')
		noSecrets(w)
	})

	it("store not ready answers 503 and touches nothing", async () => {
		const w = await world({ badStore: true })
		await expect(w.svc.remove(w.scanA)).rejects.toMatchObject({
			code: "RECORDING_KEEPS_UNAVAILABLE",
			status: 503,
		})
		await nodeFs.lstat(w.fileA)
		expect(w.deleteFs.calls).toEqual([])
	})
})

describe("Main wiring: the late-bound scanner deleter (WG10)", () => {
	it("answers 409 RECORDING_DELETE_UNSUPPORTED with nothing touched until the scanner exists, then deletes", async () => {
		const late = { bound: false }
		const w = await world({ lateBound: late })
		await expect(w.svc.remove(w.scanA)).rejects.toMatchObject({
			code: "RECORDING_DELETE_UNSUPPORTED",
			status: 409,
		})
		await nodeFs.lstat(w.fileA)
		expect(w.deleteFs.calls).toEqual([])
		expect(w.store.get(w.discoveryId)?.evidence.recordings).toBe(2)
		late.bound = true
		await expect(w.svc.remove(w.scanA)).resolves.toEqual({
			id: w.scanA,
			deleted: true,
		})
		await gone(w.fileA)
		expect(w.store.get(w.discoveryId)?.evidence.recordings).toBe(1)
	})
})
