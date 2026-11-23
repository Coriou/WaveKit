/**
 * GET /api/storage scanner split: the `scanner-evidence` area reports its folders (recordings,
 * quarantine, journal, captures, evidence, engine, other) with their real bounds, and the parts'
 * sums match a du-style walk of a synthetic tree. Synthetic files only.
 */
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { STORAGE_SCANNER_PART_IDS } from "@wavekit/api-types"
import type { StorageAreaPart } from "@wavekit/api-types"
import {
	scannerRecordingsCounted,
	scannerStorageParts,
	storageAreasFromConfig,
} from "../../../../src/core/storage-report/areas-from-config.js"
import { DISCOVERY_ID } from "../../../../src/core/scanner/store/evidence-store.js"
import { createStorageReporter } from "../../../../src/core/storage-report/reporter.js"
import type { StorageAreaSource } from "../../../../src/core/storage-report/contract.js"
import {
	NOISE_QUARANTINE_MAX_AGE_MS,
	NOISE_QUARANTINE_MAX_BYTES,
	NOISE_QUARANTINE_MAX_FILES,
} from "../../../../src/core/scanner/store/noise-quarantine.js"

const MiB = 1024 * 1024
const DAY = 86_400_000
const dirs: string[] = []

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(d => rm(d, { recursive: true, force: true })),
	)
})

const storage = {
	dir: null,
	maxRecordingsMb: 1,
	maxEvidenceMb: 2,
	maxJournalMb: 3,
	maxAgeDays: 4,
	maxCapturesMb: 5,
}

/** Files under the scanner root, by path, with sizes. */
const TREE: Record<string, number> = {
	"recordings/analog/d_1/analog-a.wav": 1000,
	"recordings/dv/d_2/call.wav": 300,
	".analog-operations/op-1/intent.json": 120,
	".analog-operations/op-1/receipt.json": 240,
	".analog-operations/op-1/facts.json": 60,
	"quarantine/noise/2026-11-20/q.wav": 700,
	"quarantine/noise/2026-11-20/q.json": 50,
	"journal/observations-20261120.jsonl": 900,
	"captures/cap_a.cu8": 4000,
	"captures/cap_a.json": 80,
	"evidence/d_1/psd.json": 222,
	"engine/occupancy/src.json": 33,
	"engine/receivers/src/rx/engine.json": 44,
	"discoveries.json": 555,
	"jobs.json": 66,
	"set-aside-unknown/x.bin": 7,
	// Excluded from the area (state backups, hard links of counted files).
	".backups/v1/discoveries.json": 9999,
}

async function fixture(): Promise<string> {
	const stateDir = await mkdtemp(join(tmpdir(), "wk-storage-parts-"))
	dirs.push(stateDir)
	for (const [rel, size] of Object.entries(TREE)) {
		const file = join(stateDir, "scanner", rel)
		await mkdir(join(file, ".."), { recursive: true })
		await writeFile(file, Buffer.alloc(size))
	}
	return stateDir
}

/** du-style: every regular file (and symlink) under `dir`, by lstat, never following links. */
async function du(dir: string): Promise<{ bytes: number; files: number }> {
	let bytes = 0
	let files = 0
	let info
	try {
		info = await lstat(dir)
	} catch {
		return { bytes, files }
	}
	if (!info.isDirectory()) return { bytes: info.size, files: 1 }
	for (const name of await readdir(dir)) {
		const sub = await du(join(dir, name))
		bytes += sub.bytes
		files += sub.files
	}
	return { bytes, files }
}

async function reportOf(stateDir: string, enabled = true) {
	const reporter = createStorageReporter({
		stateDir,
		areas: storageAreasFromConfig({
			stateDir,
			activityMaxDbBytes: null,
			scannerStorage: storage,
			scannerEnabled: enabled,
			decoders: [],
			accessDirectory: null,
		}),
		minFreeBytes: null,
	})
	const report = await reporter.report()
	const area = report.areas.find(a => a.id === "scanner-evidence")
	expect(area).toBeDefined()
	return area!
}

describe("scanner-evidence split", () => {
	it("part sums match a du-style walk of each folder and add up to the area", async () => {
		const stateDir = await fixture()
		const area = await reportOf(stateDir)
		const root = join(stateDir, "scanner")
		const parts = new Map(area.parts?.map(p => [p.id, p]))
		expect(area.parts?.map(p => p.id)).toEqual(STORAGE_SCANNER_PART_IDS)
		const sum = async (...names: string[]) => {
			let bytes = 0
			let files = 0
			for (const n of names) {
				const d = await du(join(root, n))
				bytes += d.bytes
				files += d.files
			}
			return { bytes, files }
		}
		const pick = (p: StorageAreaPart | undefined) => ({
			bytes: p?.bytes,
			files: p?.files,
		})
		expect(pick(parts.get("recordings"))).toEqual(
			await sum("recordings", ".analog-operations"),
		)
		expect(pick(parts.get("quarantine"))).toEqual(await sum("quarantine"))
		expect(pick(parts.get("journal"))).toEqual(await sum("journal"))
		expect(pick(parts.get("captures"))).toEqual(await sum("captures"))
		expect(pick(parts.get("evidence"))).toEqual(await sum("evidence"))
		expect(pick(parts.get("engine"))).toEqual(await sum("engine"))
		expect(pick(parts.get("other"))).toEqual(
			await sum("discoveries.json", "jobs.json", "set-aside-unknown"),
		)
		// The area is the whole root but the excluded backups.
		const whole = await du(root)
		const backups = await du(join(root, ".backups"))
		expect(area.bytes).toBe(whole.bytes - backups.bytes)
		expect(area.files).toBe(whole.files - backups.files)
		const total = (area.parts ?? []).reduce(
			(acc, p) => ({ bytes: acc.bytes + p.bytes, files: acc.files + p.files }),
			{ bytes: 0, files: 0 },
		)
		expect(total).toEqual({ bytes: area.bytes, files: area.files })
		expect(area.partial).toBe(false)
		expect(area.parts?.every(p => p.exists)).toBe(true)
	})

	it("reports each folder's bounds from the scanner caps and the quarantine constants", async () => {
		const area = await reportOf(await fixture())
		const bounds = Object.fromEntries(
			(area.parts ?? []).map(p => [p.id, p.bounds]),
		)
		expect(bounds).toEqual({
			recordings: { maxBytes: 1 * MiB, maxAgeMs: 4 * DAY, maxFiles: null },
			quarantine: {
				maxBytes: NOISE_QUARANTINE_MAX_BYTES,
				maxAgeMs: NOISE_QUARANTINE_MAX_AGE_MS,
				maxFiles: NOISE_QUARANTINE_MAX_FILES,
			},
			journal: { maxBytes: 3 * MiB, maxAgeMs: 4 * DAY, maxFiles: null },
			captures: { maxBytes: 5 * MiB, maxAgeMs: null, maxFiles: null },
			evidence: { maxBytes: 2 * MiB, maxAgeMs: 4 * DAY, maxFiles: null },
			engine: { maxBytes: null, maxAgeMs: null, maxFiles: null },
			other: { maxBytes: null, maxAgeMs: null, maxFiles: null },
		})
		// The fixture is within every bound.
		expect(
			area.parts?.filter(p => p.overBound !== null).map(p => p.overBound),
		).toEqual([false, false, false, false, false])
	})

	it("with the scanner off every bound is null (nothing prunes)", async () => {
		const area = await reportOf(await fixture(), false)
		expect(
			area.parts?.every(
				p =>
					p.bounds.maxBytes === null &&
					p.bounds.maxAgeMs === null &&
					p.bounds.maxFiles === null &&
					p.overBound === null,
			),
		).toBe(true)
	})

	it("a missing bound reads null, never a guess", () => {
		const parts = scannerStorageParts({ dir: null, maxRecordingsMb: 1 }, true)
		const journal = parts.parts.find(p => p.id === "journal")
		expect(journal?.bounds).toEqual({
			maxBytes: null,
			maxAgeMs: null,
			maxFiles: null,
		})
	})
})

describe("overBound at and past each bound", () => {
	const source: StorageAreaSource = {
		id: "scanner-evidence",
		paths: ["/fake/scanner"],
		capBytes: null,
		parts: scannerStorageParts(storage, true),
	}
	const order = [...source.parts!.parts, source.parts!.fallback].map(p => p.id)

	async function overOf(
		id: string,
		bytes: number,
		files: number,
		partialReason: "entry-limit" | null = null,
		boundedFiles: number = files,
	) {
		const reporter = createStorageReporter(
			{ stateDir: "/fake", areas: [source], minFreeBytes: null },
			{
				statfs: async () => ({ blocks: 1, bfree: 1, bavail: 1, bsize: 1 }),
				scan: async () => [
					{
						id: "scanner-evidence",
						bytes,
						files,
						exists: true,
						partialReason,
						parts: order.map(p => ({
							id: p,
							bytes: p === id ? bytes : 0,
							files: p === id ? files : 0,
							boundedFiles: p === id ? boundedFiles : 0,
							exists: p === id,
						})),
					},
				],
			},
		)
		const area = (await reporter.report()).areas[0]
		return area?.parts?.find(p => p.id === id)?.overBound
	}

	it.each([
		["recordings", 1 * MiB],
		["journal", 3 * MiB],
		["captures", 5 * MiB],
		["evidence", 2 * MiB],
		["quarantine", NOISE_QUARANTINE_MAX_BYTES],
	])(
		"%s: exactly maxBytes is within, one byte more is over",
		async (id, max) => {
			expect(await overOf(id, max, 1)).toBe(false)
			expect(await overOf(id, max + 1, 1)).toBe(true)
		},
	)

	it("quarantine: exactly maxFiles entries is within, one entry more is over (the prune's unit)", async () => {
		// Each entry is a WAV and its JSON sidecar: 2 × maxFiles files at the bound.
		const max = NOISE_QUARANTINE_MAX_FILES
		expect(await overOf("quarantine", 1, 2 * max, null, max)).toBe(false)
		expect(await overOf("quarantine", 1, 2 * max + 2, null, max + 1)).toBe(true)
		// Raw files past the bound alone are not over: the prune would remove nothing.
		expect(await overOf("quarantine", 1, max + 1, null, max / 2)).toBe(false)
	})

	it("unbounded parts and a partial area read null", async () => {
		expect(await overOf("engine", 10 * MiB, 1)).toBeNull()
		expect(await overOf("other", 10 * MiB, 1)).toBeNull()
		expect(await overOf("recordings", 2 * MiB, 1, "entry-limit")).toBeNull()
	})
})

describe("the quarantine counts its prune's entries", () => {
	it("a real walk counts quarantined WAVs, not their sidecars or foreign files", async () => {
		const root = await mkdtemp(join(tmpdir(), "wk-parts-q-"))
		dirs.push(root)
		const day = join(root, "quarantine", "noise", "2026-11-20")
		await mkdir(day, { recursive: true })
		const ids = [
			"0b8c2c7e-1f3a-4b5c-8d9e-0a1b2c3d4e5f",
			"1c9d3d8f-2a4b-4c6d-9e0f-1b2c3d4e5f60",
		]
		for (const id of ids) {
			await writeFile(join(day, `${id}.wav`), Buffer.alloc(10))
			await writeFile(join(day, `${id}.json`), "{}")
		}
		// A sidecar without its WAV and a foreign file: files, not entries.
		await writeFile(
			join(day, "2d0e4e9a-3b5c-4d7e-8f10-2c3d4e5f6071.json"),
			"{}",
		)
		await writeFile(join(day, "notes.wav"), "x")
		const reporter = createStorageReporter({
			stateDir: root,
			areas: [
				{
					id: "scanner-evidence",
					paths: [root],
					capBytes: null,
					parts: scannerStorageParts(storage, true),
				},
			],
			minFreeBytes: null,
		})
		const area = (await reporter.report()).areas[0]
		const quarantine = area?.parts?.find(p => p.id === "quarantine")
		expect(quarantine?.files).toBe(6)
		expect(quarantine?.boundedFiles).toBe(2)
		// Every other part counts every file.
		for (const p of area?.parts ?? [])
			if (p.id !== "quarantine") expect(p.boundedFiles).toBe(p.files)
	})
})

describe("the recordings part counts what the recordings cap counts", () => {
	const OP = "0b8c2c7e-1f3a-4b5c-8d9e-0a1b2c3d4e5f"
	const OP2 = "1c9d3d8f-2a4b-4c6d-9e0f-1b2c3d4e5f60"

	it("counts the legacy walk's files and every operation file, nothing else", () => {
		const counted = (rel: string) => scannerRecordingsCounted(rel.split("/"))
		// The legacy walk (evidence-store.ts collect).
		expect(counted("recordings/analog/d_1/analog-a.wav")).toBe(true)
		expect(counted("recordings/dv/d_2/call.wav")).toBe(true)
		expect(counted("recordings/dv/probe-p1/call.wav")).toBe(true)
		expect(counted("recordings/dv/probe-p1/WAV/call.wav")).toBe(true)
		expect(counted("recordings/dv/probe-p1/wav/call.wav")).toBe(true)
		expect(counted("recordings/dv/probe-p1/other/call.wav")).toBe(false)
		expect(counted("recordings/dv/d_2/sub/call.wav")).toBe(false)
		expect(counted("recordings/dv/notes.txt")).toBe(false)
		expect(counted("recordings/other/d_2/call.wav")).toBe(false)
		expect(counted("recordings/notes.txt")).toBe(false)
		expect(counted("recordings/dv/not-a-folder/call.wav")).toBe(false)
		// The operation inventory (analog-operations.ts readOperation): metadata included.
		expect(counted(`.analog-operations/${OP}/intent.json`)).toBe(true)
		expect(counted(`.analog-operations/${OP}/receipt.json`)).toBe(true)
		expect(counted(`.analog-operations/${OP}/facts.json`)).toBe(true)
		expect(counted(`.analog-operations/${OP}/payload.wav.part`)).toBe(true)
		expect(counted(`.analog-operations/.staging-${OP}/intent.tmp`)).toBe(true)
		expect(counted(`.analog-operations/${OP}.cleanup`)).toBe(true)
		// Not counted by the store.
		expect(counted(`.analog-operations/.set-aside/${OP}/intent.json`)).toBe(
			false,
		)
		expect(counted(".analog-operations/op-1/intent.json")).toBe(false)
		expect(counted(`.analog-operations/${OP}/deeper/x`)).toBe(false)
		expect(counted(".analog-operations/stray.txt")).toBe(false)
	})

	it("its copied folder rule matches the store's own", () => {
		for (const id of ["d_1", "d_aZ9", "d_", "x_1", "d_1-2"])
			expect(scannerRecordingsCounted(["recordings", "dv", id, "f.wav"])).toBe(
				DISCOVERY_ID.test(id),
			)
	})

	/** A scanner root whose counted files sum to `counted` bytes, plus uncounted files. */
	async function tree(counted: number): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "wk-parts-rec-"))
		dirs.push(root)
		const files: Record<string, number> = {
			"recordings/analog/d_1/analog-a.wav": counted - 1000,
			"recordings/dv/probe-p1/WAV/call.wav": 300,
			[`.analog-operations/${OP}/intent.json`]: 120,
			[`.analog-operations/${OP}/receipt.json`]: 240,
			[`.analog-operations/${OP}/facts.json`]: 60,
			[`.analog-operations/.staging-${OP2}/intent.tmp`]: 200,
			[`.analog-operations/${OP2}.cleanup`]: 80,
			// Uncounted by the cap: crash residue set aside, and stray files.
			[`.analog-operations/.set-aside/${OP2}/intent.json`]: 5000,
			"recordings/notes.txt": 4000,
			"recordings/dv/not-a-folder/x.wav": 3000,
		}
		for (const [rel, size] of Object.entries(files)) {
			const file = join(root, rel)
			await mkdir(join(file, ".."), { recursive: true })
			await writeFile(file, Buffer.alloc(size))
		}
		return root
	}

	async function recordingsOf(root: string): Promise<StorageAreaPart> {
		const reporter = createStorageReporter({
			stateDir: root,
			areas: [
				{
					id: "scanner-evidence",
					paths: [root],
					capBytes: null,
					parts: scannerStorageParts(storage, true),
				},
			],
			minFreeBytes: null,
		})
		const area = (await reporter.report()).areas[0]
		const part = area?.parts?.find(p => p.id === "recordings")
		expect(part).toBeDefined()
		return part!
	}

	it("exactly maxRecordingsMb of counted bytes is within, one byte more is over", async () => {
		const at = await recordingsOf(await tree(1 * MiB))
		// The part holds more than the cap (uncounted files), yet is within it as the store counts.
		expect(at.bytes).toBe(1 * MiB + 12_000)
		expect(at.overBound).toBe(false)
		const past = await recordingsOf(await tree(1 * MiB + 1))
		expect(past.overBound).toBe(true)
	})
})
