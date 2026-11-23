/**
 * A retention pass removes empty discovery folders without walking the trees twice: only the
 * folders its own walk listed empty, and those holding a file it deleted, are rmdir'd. Every
 * readdir is counted through a node:fs/promises seam.
 */
import { existsSync } from "node:fs"
import type * as FsPromisesModule from "node:fs/promises"
import {
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { StorageCaps } from "../../../../src/core/scanner/store/evidence-store.js"
import { createLogger } from "../../../../src/utils/logger.js"

type FsPromises = typeof FsPromisesModule

/** Every readdir path the store asks for; `beforeRmdir` runs once before the first rmdir. */
const seam = vi.hoisted(() => ({
	readdirs: [] as string[],
	beforeRmdir: null as (() => Promise<void>) | null,
}))

vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<FsPromises>()
	const readdirCounted = ((...args: Parameters<FsPromises["readdir"]>) => {
		const path = args[0]
		if (typeof path === "string") seam.readdirs.push(path)
		return actual.readdir(...args)
	}) as FsPromises["readdir"]
	const rmdirHooked = async (
		...args: Parameters<FsPromises["rmdir"]>
	): Promise<void> => {
		const step = seam.beforeRmdir
		seam.beforeRmdir = null
		if (step) await step()
		return actual.rmdir(...args)
	}
	const wrapped = { readdir: readdirCounted, rmdir: rmdirHooked }
	return { ...actual, ...wrapped, default: { ...actual, ...wrapped } }
})

const logger = createLogger({ level: "fatal" })
const DAY = 86_400_000
const CAPS: StorageCaps = {
	maxRecordingsMb: 512,
	maxEvidenceMb: 64,
	maxAgeDays: 1,
	minFreeDiskMb: 0,
}
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)
const dirs: string[] = []

afterEach(async () => {
	seam.readdirs = []
	seam.beforeRmdir = null
	await Promise.all(
		dirs.splice(0).map(d => rm(d, { recursive: true, force: true })),
	)
})

const keepsNothing: RecordingProtection = {
	isProtected: () => false,
	isDsdFmeFileProtected: () => false,
	isScannerFileProtected: () => false,
	discoveryHoldsKept: () => false,
}

async function tempRoot(): Promise<string> {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "wavekit-empty-dirs-")),
	)
	dirs.push(root)
	return root
}

function storeAt(root: string, guarded: boolean): EvidenceStore {
	return new EvidenceStore({
		dir: root,
		caps: CAPS,
		logger,
		now: () => NOW,
		statfs: async () => ({ freeBytes: 1e12 }),
		...(guarded ? { protection: keepsNothing } : {}),
	})
}

async function put(root: string, rel: string, ageMs: number): Promise<void> {
	const path = join(root, rel)
	await mkdir(join(path, ".."), { recursive: true })
	await writeFile(path, Buffer.alloc(1_000))
	const t = (NOW - ageMs) / 1000
	await utimes(path, t, t)
}

for (const guarded of [false, true])
	describe(`retention's empty-folder sweep (${guarded ? "guarded" : "unguarded"})`, () => {
		it("removes folders the walk listed empty and folders this pass emptied, nothing else", async () => {
			const root = await tempRoot()
			// already empty (emptied by someone else since the last pass)
			await mkdir(join(root, "recordings", "dv", "d_EMPTY"), {
				recursive: true,
			})
			await mkdir(join(root, "evidence", "d_EVEMPTY"), { recursive: true })
			// emptied by this pass's age expiry
			await put(root, "recordings/analog/d_OLD/a.wav", 3 * DAY)
			await put(root, "evidence/d_EVOLD/e.json", 3 * DAY)
			// partly emptied: one fresh file stays
			await put(root, "recordings/dv/d_HALF/old.wav", 3 * DAY)
			await put(root, "recordings/dv/d_HALF/new.wav", 3_600_000)
			// excluded: an empty probe folder, a non-discovery folder, a nested folder
			await mkdir(join(root, "recordings", "dv", "probe-scn-1", "WAV"), {
				recursive: true,
			})
			await mkdir(join(root, "recordings", "dv", "notes"), {
				recursive: true,
			})
			await mkdir(join(root, "recordings", "dv", "d_NEST", "sub"), {
				recursive: true,
			})
			const { deleted } = await storeAt(root, guarded).retention(new Set())
			expect(deleted.sort()).toEqual(
				[
					join("evidence", "d_EVOLD", "e.json"),
					join("recordings", "analog", "d_OLD", "a.wav"),
					join("recordings", "dv", "d_HALF", "old.wav"),
				].sort(),
			)
			expect((await readdir(join(root, "recordings", "dv"))).sort()).toEqual([
				"d_HALF",
				"d_NEST",
				"notes",
				"probe-scn-1",
			])
			expect(await readdir(join(root, "recordings", "analog"))).toEqual([])
			expect(await readdir(join(root, "evidence"))).toEqual([])
			expect(
				existsSync(join(root, "recordings", "dv", "probe-scn-1", "WAV")),
			).toBe(true)
			expect(existsSync(join(root, "recordings", "dv", "d_NEST", "sub"))).toBe(
				true,
			)
			// the category roots themselves stay
			expect(existsSync(join(root, "recordings", "analog"))).toBe(true)
			expect(existsSync(join(root, "evidence"))).toBe(true)
		})

		it("an unchanged store lists every folder once per pass, not twice", async () => {
			const root = await tempRoot()
			const folders = 20
			for (let i = 0; i < folders; i++)
				await put(root, `recordings/dv/d_F${i}/call.wav`, 3_600_000)
			const store = storeAt(root, guarded)
			await store.retention(new Set())
			seam.readdirs = []
			const { deleted } = await store.retention(new Set())
			expect(deleted).toEqual([])
			const listedFolder = seam.readdirs.filter(p =>
				/\/recordings\/dv\/d_F\d+$/.test(p),
			)
			// the walk lists each folder once; the sweep lists none of them again
			expect(listedFolder.length).toBe(folders)
			expect(new Set(listedFolder).size).toBe(folders)
			for (let i = 0; i < folders; i++)
				expect(existsSync(join(root, "recordings", "dv", `d_F${i}`))).toBe(true)
		})

		it("a folder written to between the walk and the sweep stays", async () => {
			const root = await tempRoot()
			await mkdir(join(root, "recordings", "dv", "d_RACE"), {
				recursive: true,
			})
			seam.beforeRmdir = async () => {
				await writeFile(
					join(root, "recordings", "dv", "d_RACE", "fresh.wav"),
					Buffer.alloc(10),
				)
			}
			await storeAt(root, guarded).retention(new Set())
			expect(
				existsSync(join(root, "recordings", "dv", "d_RACE", "fresh.wav")),
			).toBe(true)
		})

		it("a folder emptied after the walk is removed by the next pass", async () => {
			const root = await tempRoot()
			await put(root, "recordings/dv/d_LATE/kept.wav", 3_600_000)
			const store = storeAt(root, guarded)
			await store.retention(new Set())
			expect(existsSync(join(root, "recordings", "dv", "d_LATE"))).toBe(true)
			await rm(join(root, "recordings", "dv", "d_LATE", "kept.wav"))
			await store.retention(new Set())
			expect(existsSync(join(root, "recordings", "dv", "d_LATE"))).toBe(false)
		})

		it("never removes through a symlinked discovery folder", async () => {
			const root = await tempRoot()
			const outside = await tempRoot()
			await mkdir(join(outside, "target"), { recursive: true })
			await mkdir(join(root, "recordings", "dv"), { recursive: true })
			await symlink(
				join(outside, "target"),
				join(root, "recordings", "dv", "d_LINK"),
			)
			await storeAt(root, guarded).retention(new Set())
			expect(existsSync(join(outside, "target"))).toBe(true)
			expect(existsSync(join(root, "recordings", "dv", "d_LINK"))).toBe(true)
		})
	})
