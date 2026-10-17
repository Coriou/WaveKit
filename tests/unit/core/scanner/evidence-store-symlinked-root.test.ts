/**
 * WG9 R2: a scanner storage root configured as a symlink is resolved once, when the store is
 * constructed (operator config is trusted): retention and discovery removal run through its
 * real directory, a symlink below it stays refused, a real root whose identity changed is
 * refused, and a non-symlinked root keeps the ecccc22e results.
 */
import { existsSync } from "node:fs"
import {
	mkdir,
	mkdtemp,
	realpath,
	rename,
	rm,
	symlink,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { StorageCaps } from "../../../../src/core/scanner/store/evidence-store.js"
import { createLogger } from "../../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const MIB = 1024 * 1024
const DAY = 86_400_000
const CAPS: StorageCaps = {
	maxRecordingsMb: 1_500 / MIB,
	maxEvidenceMb: 64,
	maxAgeDays: 1,
	minFreeDiskMb: 1,
}
const dirs: string[] = []

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(d => rm(d, { recursive: true, force: true })),
	)
})

async function tmp(): Promise<string> {
	const d = await realpath(await mkdtemp(join(tmpdir(), "wavekit-ev-root-")))
	dirs.push(d)
	return d
}

/** Kept scanner files by `<discoveryId>~<name>`. */
function protection(kept: string[]): RecordingProtection {
	const set = new Set(kept)
	return {
		isProtected: () => true,
		isDsdFmeFileProtected: () => true,
		isScannerFileProtected: (d, n) => set.has(`${d}~${n}`),
		discoveryHoldsKept: d => [...set].some(k => k.startsWith(`${d}~`)),
	}
}

async function put(root: string, rel: string, ageMs: number, now: number) {
	const path = join(root, rel)
	await mkdir(join(path, ".."), { recursive: true })
	await writeFile(path, Buffer.alloc(1_000))
	const t = (now - ageMs) / 1000
	await utimes(path, t, t)
}

async function populate(root: string, now: number): Promise<void> {
	await put(root, "recordings/dv/d_A/old.wav", 3 * DAY, now)
	await put(root, "recordings/dv/d_A/mid.wav", 5 * 3_600_000, now)
	await put(root, "recordings/dv/d_B/new.wav", 3_600_000, now)
	await put(root, "evidence/d_A/psd.json", 3 * DAY, now)
}

function store(dir: string, now: number, port?: RecordingProtection) {
	return new EvidenceStore({
		dir,
		caps: CAPS,
		logger,
		now: () => now,
		statfs: async () => ({ freeBytes: 1e12 }),
		...(port ? { protection: port } : {}),
	})
}

const ALL = [
	"recordings/dv/d_A/old.wav",
	"recordings/dv/d_A/mid.wav",
	"recordings/dv/d_B/new.wav",
	"evidence/d_A/psd.json",
]

/** The ecccc22e results for the scenario (recording-keep-deleters.test.ts, same caps). */
const GOLDEN = {
	"no port": {
		port: undefined,
		deleted: [
			join("evidence", "d_A", "psd.json"),
			join("recordings", "dv", "d_A", "old.wav"),
			join("recordings", "dv", "d_A", "mid.wav"),
		],
		left: ["recordings/dv/d_B/new.wav"],
	},
	port: {
		port: protection(["d_A~old.wav"]),
		deleted: [
			join("evidence", "d_A", "psd.json"),
			join("recordings", "dv", "d_A", "mid.wav"),
			join("recordings", "dv", "d_B", "new.wav"),
		],
		left: ["recordings/dv/d_A/old.wav"],
	},
} as const

function present(root: string): string[] {
	return ALL.filter(rel => existsSync(join(root, rel)))
}

for (const mode of ["no port", "port"] as const) {
	const g = GOLDEN[mode]
	describe(`EvidenceStore, configured storage root (${mode})`, () => {
		it("non-symlinked root: retention matches the ecccc22e golden", async () => {
			const root = await tmp()
			const now = Date.now()
			await populate(root, now)
			const { deleted } = await store(root, now, g.port).retention(new Set())
			expect(deleted).toEqual(g.deleted)
			expect(present(root)).toEqual(g.left)
		})

		it("symlinked root: retention runs through the real directory", async () => {
			const base = await tmp()
			const real = join(base, "real")
			const now = Date.now()
			await populate(real, now)
			const configured = join(base, "configured")
			await symlink(real, configured)
			const { deleted } = await store(configured, now, g.port).retention(
				new Set(),
			)
			expect(deleted).toEqual(g.deleted)
			expect(present(real)).toEqual(g.left)
		})

		it("symlinked root: discovery removal runs through the real directory", async () => {
			const base = await tmp()
			const real = join(base, "real")
			const now = Date.now()
			await populate(real, now)
			const configured = join(base, "configured")
			await symlink(real, configured)
			await store(configured, now, g.port).removeDiscovery("d_B")
			expect(existsSync(join(real, "recordings/dv/d_B"))).toBe(false)
			expect(existsSync(join(real, "recordings/dv/d_A/old.wav"))).toBe(true)
		})

		it("symlinked root whose real directory is replaced after construction: refused", async () => {
			const base = await tmp()
			const real = join(base, "real")
			const now = Date.now()
			await populate(real, now)
			const configured = join(base, "configured")
			await symlink(real, configured)
			const s = store(configured, now, g.port)
			await rename(real, join(base, "moved"))
			await populate(real, now)
			expect(await s.retention(new Set())).toEqual({ deleted: [] })
			await expect(s.removeDiscovery("d_B")).rejects.toMatchObject({
				code: "SCANNER_EVIDENCE_CLEANUP_PENDING",
			})
			expect(present(real)).toEqual(ALL)
			expect(present(join(base, "moved"))).toEqual(ALL)
		})

		it("symlinked root re-pointed after construction: the pinned real directory stays the base", async () => {
			const base = await tmp()
			const real = join(base, "real")
			const other = join(base, "other")
			const now = Date.now()
			await populate(real, now)
			await populate(other, now)
			const configured = join(base, "configured")
			await symlink(real, configured)
			const s = store(configured, now, g.port)
			await unlink(configured)
			await symlink(other, configured)
			const { deleted } = await s.retention(new Set())
			expect(deleted).toEqual(g.deleted)
			expect(present(real)).toEqual(g.left)
			expect(present(other)).toEqual(ALL)
		})
	})
}

describe("EvidenceStore, symlink below a symlinked configured root (port)", () => {
	it("never descends a symlinked recordings folder under the real root", async () => {
		const base = await tmp()
		const real = join(base, "real")
		const outside = join(base, "outside")
		const now = Date.now()
		await populate(outside, now)
		await mkdir(join(real, "recordings"), { recursive: true })
		await symlink(
			join(outside, "recordings", "dv"),
			join(real, "recordings", "dv"),
		)
		const configured = join(base, "configured")
		await symlink(real, configured)
		const { deleted } = await store(configured, now, protection([])).retention(
			new Set(),
		)
		expect(deleted).toEqual([])
		expect(present(outside)).toEqual(ALL)
	})
})
