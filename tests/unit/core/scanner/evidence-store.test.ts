import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { StorageCaps } from "../../../../src/core/scanner/store/evidence-store.js"
import { createLogger } from "../../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const MIB = 1024 * 1024
const DAY = 86_400_000
const CAPS: StorageCaps = {
	maxRecordingsMb: 512,
	maxEvidenceMb: 64,
	maxAgeDays: 30,
	minFreeDiskMb: 2048,
}
const plentyOfDisk = async () => ({ freeBytes: 100 * 1024 * MIB })
const lowDisk = async () => ({ freeBytes: 100 * MIB })

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "wavekit-evidence-"))
	try {
		return await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

const pad = (n: number): string => String(n).padStart(2, "0")
function localStamp(ms: number): string {
	const d = new Date(ms)
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
const callWav = (ms: number, tg: string, src: string): string =>
	`${localStamp(ms)}_00042_DMR_CC_1_GROUP_TGT_${tg}_SRC_${src}.wav`
const tempWav = (ms: number): string => `TEMP_${localStamp(ms)}_1A2B.wav`

// 2026-10-09 12:00:00 local, whole second so file stamps are exact
const T0 = new Date(2026, 9, 9, 12, 0, 0).getTime()

async function probeDirWith(
	root: string,
	files: string[],
	sub = "",
): Promise<string> {
	const dir = join(root, "recordings", "dv", "probe-scn-abc-dmr-1")
	await mkdir(join(dir, sub), { recursive: true })
	for (const f of files)
		await writeFile(join(dir, sub, f), Buffer.alloc(1_000, 1))
	return dir
}

describe("EvidenceStore.linkProbeRecordings", () => {
	it("moves a call WAV to its discovery by TG, SRC and time, and resolves the recording id", async () => {
		await withDir(async root => {
			const store = new EvidenceStore({
				dir: root,
				caps: CAPS,
				logger,
				now: () => T0 + 60_000,
				statfs: plentyOfDisk,
			})
			const name = callWav(T0 + 1_000, "9", "2001")
			const probe = await probeDirWith(root, [name], "WAV")
			const result = await store.linkProbeRecordings(probe, [
				{
					observationId: "o-other",
					discoveryId: "d_OTHER",
					talkgroup: "9",
					source: "3003",
					startedAt: T0,
					endedAt: T0 + 5_000,
					encrypted: false,
				},
				{
					observationId: "o-1",
					discoveryId: "d_ONE",
					talkgroup: "9",
					source: "2001",
					startedAt: T0 + 500,
					endedAt: T0 + 6_000,
					encrypted: false,
				},
			])
			expect(result).toEqual({
				linked: [{ observationId: "o-1", recordingId: `d_ONE~${name}` }],
				cut: [],
				droppedEncrypted: [],
			})
			expect(store.recordingPath(`d_ONE~${name}`)).toBe(
				join(root, "recordings", "dv", "d_ONE", name),
			)
			expect(existsSync(probe)).toBe(false)
		})
	})

	it("lists a directory reached twice (WAV and wav on a case-insensitive disk) once", async () => {
		await withDir(async root => {
			const store = new EvidenceStore({
				dir: root,
				caps: CAPS,
				logger,
				now: () => T0 + 60_000,
				statfs: plentyOfDisk,
			})
			const name = callWav(T0 + 1_000, "9", "2001")
			const probe = await probeDirWith(root, [name], "WAV")
			// case-insensitive disks (APFS) already alias wav to WAV; elsewhere a symlink stands in so the test bites there too
			if (!existsSync(join(probe, "wav")))
				await symlink(join(probe, "WAV"), join(probe, "wav"))
			const result = await store.linkProbeRecordings(probe, [
				{
					observationId: "o-1",
					discoveryId: "d_ONE",
					talkgroup: "9",
					source: "2001",
					startedAt: T0,
					endedAt: T0 + 6_000,
					encrypted: false,
				},
			])
			expect(result).toEqual({
				linked: [{ observationId: "o-1", recordingId: `d_ONE~${name}` }],
				cut: [],
				droppedEncrypted: [],
			})
			expect(await readdir(join(root, "recordings", "dv", "d_ONE"))).toEqual([
				name,
			])
			expect(existsSync(probe)).toBe(false)
		})
	})

	it("drops recordings of encrypted calls and TEMP leftovers of calls cut by a hop", async () => {
		await withDir(async root => {
			const store = new EvidenceStore({
				dir: root,
				caps: CAPS,
				logger,
				now: () => T0 + 60_000,
				statfs: plentyOfDisk,
			})
			const probe = await probeDirWith(root, [
				callWav(T0, "9", "2001"),
				tempWav(T0 + 10_000),
				callWav(T0 + 30_000, "77", "5"),
			])
			const result = await store.linkProbeRecordings(probe, [
				{
					observationId: "o-enc",
					discoveryId: "d_ONE",
					talkgroup: "9",
					source: "2001",
					startedAt: T0,
					endedAt: T0 + 3_000,
					encrypted: true,
				},
				{
					observationId: "o-cut",
					discoveryId: "d_ONE",
					startedAt: T0 + 9_500,
					endedAt: T0 + 12_000,
					encrypted: false,
				},
			])
			expect(result.linked).toEqual([])
			expect(result.droppedEncrypted).toEqual(["o-enc"])
			expect(result.cut).toEqual(["o-cut"])
			expect(existsSync(join(root, "recordings", "dv", "d_ONE"))).toBe(false)
			expect(existsSync(probe)).toBe(false)
		})
	})

	it("links nothing and deletes the probe files while the disk is low", async () => {
		await withDir(async root => {
			const store = new EvidenceStore({
				dir: root,
				caps: CAPS,
				logger,
				now: () => T0,
				statfs: lowDisk,
			})
			const probe = await probeDirWith(root, [callWav(T0, "9", "2001")])
			const result = await store.linkProbeRecordings(probe, [
				{
					observationId: "o-1",
					discoveryId: "d_ONE",
					talkgroup: "9",
					source: "2001",
					startedAt: T0,
					endedAt: T0 + 3_000,
					encrypted: false,
				},
			])
			expect(result.linked).toEqual([])
			expect(await store.diskState()).toBe("disk-low")
			expect(existsSync(probe)).toBe(false)
		})
	})

	it("drops an encrypted call's WAV even when a nearer clear wildcard candidate also matches", async () => {
		await withDir(async root => {
			const store = new EvidenceStore({
				dir: root,
				caps: CAPS,
				logger,
				now: () => T0 + 60_000,
				statfs: plentyOfDisk,
			})
			const probe = await probeDirWith(root, [callWav(T0 + 1_000, "9", "2001")])
			const result = await store.linkProbeRecordings(probe, [
				{
					observationId: "o-enc",
					discoveryId: "d_ONE",
					talkgroup: "9",
					source: "2001",
					startedAt: T0,
					endedAt: T0 + 3_000,
					encrypted: true,
				},
				// no TG/SRC (matches any call) and starts exactly at the file stamp: nearest, but clear
				{
					observationId: "o-clear",
					discoveryId: "d_TWO",
					startedAt: T0 + 1_000,
					endedAt: T0 + 3_000,
					encrypted: false,
				},
			])
			expect(result).toEqual({
				linked: [],
				cut: [],
				droppedEncrypted: ["o-enc"],
			})
			expect(existsSync(join(root, "recordings", "dv", "d_ONE"))).toBe(false)
			expect(existsSync(join(root, "recordings", "dv", "d_TWO"))).toBe(false)
			expect(existsSync(probe)).toBe(false)
		})
	})

	it("reports an encrypted call as dropped while the disk is low", async () => {
		await withDir(async root => {
			const store = new EvidenceStore({
				dir: root,
				caps: CAPS,
				logger,
				now: () => T0,
				statfs: lowDisk,
			})
			const probe = await probeDirWith(root, [callWav(T0, "9", "2001")])
			const result = await store.linkProbeRecordings(probe, [
				{
					observationId: "o-enc",
					discoveryId: "d_ONE",
					talkgroup: "9",
					source: "2001",
					startedAt: T0,
					endedAt: T0 + 3_000,
					encrypted: true,
				},
			])
			expect(result).toEqual({
				linked: [],
				cut: [],
				droppedEncrypted: ["o-enc"],
			})
			expect(existsSync(probe)).toBe(false)
		})
	})

	it("rejects recording ids that could escape the storage directory", async () => {
		await withDir(async root => {
			const store = new EvidenceStore({
				dir: root,
				caps: CAPS,
				logger,
				now: () => T0,
				statfs: plentyOfDisk,
			})
			expect(store.recordingPath("d_ONE~../../etc/passwd.wav")).toBeNull()
			expect(store.recordingPath("../d_ONE~a.wav")).toBeNull()
			expect(store.recordingPath("d_ONE~missing.wav")).toBeNull()
			expect(store.evidencePath("d_ONE", "../psd.json")).toBeNull()
		})
	})
})

describe("EvidenceStore PSD and IQ", () => {
	it("overwrites the PSD only when the SNR improves", async () => {
		await withDir(async root => {
			const store = new EvidenceStore({
				dir: root,
				caps: CAPS,
				logger,
				now: () => T0,
				statfs: plentyOfDisk,
			})
			expect(
				await store.writePsd("d_ONE", {
					startHz: 446e6,
					binHz: 1000,
					bins: [-90, -60, -90],
					snrDb: 20,
				}),
			).toBe(true)
			expect(
				await store.writePsd("d_ONE", {
					startHz: 446e6,
					binHz: 1000,
					bins: [-90, -70, -90],
					snrDb: 15,
				}),
			).toBe(false)
			expect(
				await store.writePsd("d_ONE", {
					startHz: 446e6,
					binHz: 1000,
					bins: [-90, -50, -90],
					snrDb: 30,
				}),
			).toBe(true)
			const path = store.evidencePath("d_ONE", "psd.json") ?? ""
			const saved = JSON.parse(await readFile(path, "utf8")) as {
				snrDb: number
				bins: number[]
			}
			expect(saved.snrDb).toBe(30)
			expect(saved.bins).toEqual([-90, -50, -90])
		})
	})

	it("writes at most one second of IQ and nothing while the disk is low", async () => {
		await withDir(async root => {
			const store = new EvidenceStore({
				dir: root,
				caps: CAPS,
				logger,
				now: () => T0,
				statfs: plentyOfDisk,
			})
			const name = await store.writeIq("d_ONE", new Uint8Array(200_000), {
				sampleRateHz: 48_000,
				centreHz: 446_006_250,
			})
			expect(name).toBe(`iq-${T0}.cu8`)
			expect(
				(await stat(store.evidencePath("d_ONE", name ?? "") ?? "")).size,
			).toBe(96_000)
			const low = new EvidenceStore({
				dir: root,
				caps: CAPS,
				logger,
				now: () => T0,
				statfs: lowDisk,
			})
			expect(
				await low.writeIq("d_ONE", new Uint8Array(10), {
					sampleRateHz: 48_000,
					centreHz: 1,
				}),
			).toBeNull()
			expect(
				await low.writePsd("d_TWO", {
					startHz: 0,
					binHz: 1,
					bins: [],
					snrDb: 50,
				}),
			).toBe(false)
		})
	})

	it("keeps the higher-SNR PSD when two writes for one discovery overlap, in either order", async () => {
		await withDir(async root => {
			const store = new EvidenceStore({
				dir: root,
				caps: CAPS,
				logger,
				now: () => T0,
				statfs: plentyOfDisk,
			})
			const psd = (snrDb: number) => ({
				startHz: 446e6,
				binHz: 1000,
				bins: [-90, -90 + snrDb, -90],
				snrDb,
			})
			expect(
				await Promise.all([
					store.writePsd("d_ONE", psd(30)),
					store.writePsd("d_ONE", psd(20)),
				]),
			).toEqual([true, false])
			expect(
				await Promise.all([
					store.writePsd("d_TWO", psd(20)),
					store.writePsd("d_TWO", psd(30)),
				]),
			).toEqual([true, true])
			for (const id of ["d_ONE", "d_TWO"]) {
				const saved = JSON.parse(
					await readFile(store.evidencePath(id, "psd.json") ?? "", "utf8"),
				) as { snrDb: number }
				expect(saved.snrDb).toBe(30)
			}
		})
	})

	it("keeps both IQ snippets when two writes for one discovery land in the same millisecond", async () => {
		await withDir(async root => {
			const store = new EvidenceStore({
				dir: root,
				caps: CAPS,
				logger,
				now: () => T0,
				statfs: plentyOfDisk,
			})
			const meta = { sampleRateHz: 48_000, centreHz: 446_006_250 }
			const names = await Promise.all([
				store.writeIq("d_ONE", new Uint8Array(1_000).fill(1), meta),
				store.writeIq("d_ONE", new Uint8Array(2_000).fill(2), meta),
			])
			expect(names[0]).not.toBeNull()
			expect(names[1]).not.toBeNull()
			expect(names[0]).not.toBe(names[1])
			const sizes = await Promise.all(
				names.map(
					async n =>
						(await stat(store.evidencePath("d_ONE", n ?? "") ?? "")).size,
				),
			)
			expect(sizes).toEqual([1_000, 2_000])
			for (const n of names)
				expect(
					store.evidencePath("d_ONE", (n ?? "").replace(/\.cu8$/, ".json")),
				).not.toBeNull()
		})
	})

	it("removes a discovery's recordings and evidence", async () => {
		await withDir(async root => {
			const store = new EvidenceStore({
				dir: root,
				caps: CAPS,
				logger,
				now: () => T0,
				statfs: plentyOfDisk,
			})
			await store.writePsd("d_ONE", {
				startHz: 0,
				binHz: 1,
				bins: [1],
				snrDb: 10,
			})
			await mkdir(join(root, "recordings", "dv", "d_ONE"), { recursive: true })
			await writeFile(join(root, "recordings", "dv", "d_ONE", "a.wav"), "x")
			await store.removeDiscovery("d_ONE")
			expect(existsSync(join(root, "evidence", "d_ONE"))).toBe(false)
			expect(existsSync(join(root, "recordings", "dv", "d_ONE"))).toBe(false)
		})
	})
})

describe("EvidenceStore.removeOrphanProbeDirs", () => {
	it("wipes every probe folder left by a crash and nothing else", async () => {
		await withDir(async root => {
			const store = new EvidenceStore({
				dir: root,
				caps: CAPS,
				logger,
				now: () => T0,
				statfs: plentyOfDisk,
			})
			await probeDirWith(root, [callWav(T0, "9", "2001")], "WAV")
			await mkdir(join(root, "recordings", "dv", "probe-scn-def-dmr-2"), {
				recursive: true,
			})
			await mkdir(join(root, "recordings", "dv", "d_A"), { recursive: true })
			await writeFile(
				join(root, "recordings", "dv", "d_A", "x.wav"),
				Buffer.alloc(10),
			)
			expect((await store.removeOrphanProbeDirs()).sort()).toEqual([
				"probe-scn-abc-dmr-1",
				"probe-scn-def-dmr-2",
			])
			expect(await readdir(join(root, "recordings", "dv"))).toEqual(["d_A"])
			expect(await store.removeOrphanProbeDirs()).toEqual([])
		})
	})
})

interface FileSpec {
	kind: "dv" | "analog" | "evidence"
	disc: number
	bytes: number
	ageMs: number
}

const fileArb: fc.Arbitrary<FileSpec> = fc.record({
	kind: fc.constantFrom("dv" as const, "analog" as const, "evidence" as const),
	disc: fc.integer({ min: 0, max: 3 }),
	bytes: fc.integer({ min: 1, max: 4_000 }),
	// young (< 10 s, well clear of the boundary) or whole hours + 30 min (clear of day boundaries)
	ageMs: fc.oneof(
		fc.integer({ min: 0, max: 8_000 }),
		fc.integer({ min: 1, max: 960 }).map(h => h * 3_600_000 + 1_800_000),
	),
})

describe("EvidenceStore.retention", () => {
	it("deletes expired files first, then the oldest, sparing young and keep files", async () => {
		await withDir(async root => {
			const now = Date.now()
			// cap 3000 B: after the expired file goes, 4000 B remain (1000 of them keep, 1000 live): deleting mid.wav reaches the cap
			const store = new EvidenceStore({
				dir: root,
				caps: { ...CAPS, maxRecordingsMb: 3_000 / MIB, maxAgeDays: 1 },
				logger,
				now: () => now,
				statfs: plentyOfDisk,
			})
			const put = async (rel: string, ageMs: number) => {
				const path = join(root, rel)
				await mkdir(join(path, ".."), { recursive: true })
				await writeFile(path, Buffer.alloc(1_000))
				const t = (now - ageMs) / 1000
				await utimes(path, t, t)
			}
			await put("recordings/dv/d_A/old.wav", 3 * DAY)
			await put("recordings/dv/d_KEEP/old.wav", 3 * DAY)
			await put("recordings/dv/d_A/mid.wav", 5 * 3_600_000)
			await put("recordings/dv/d_B/new.wav", 3_600_000)
			await put("recordings/dv/d_B/live.wav", 1_000)
			const { deleted } = await store.retention(new Set(["d_KEEP"]))
			expect(deleted).toEqual([
				join("recordings", "dv", "d_A", "old.wav"),
				join("recordings", "dv", "d_A", "mid.wav"),
			])
			expect(await readdir(join(root, "recordings", "dv"))).toEqual([
				"d_B",
				"d_KEEP",
			])
		})
	})

	it("counts live probe folders against the recordings cap without deleting them", async () => {
		await withDir(async root => {
			const now = Date.now()
			const store = new EvidenceStore({
				dir: root,
				caps: { ...CAPS, maxRecordingsMb: 1_500 / MIB },
				logger,
				now: () => now,
				statfs: plentyOfDisk,
			})
			const put = async (rel: string, ageMs: number) => {
				const path = join(root, rel)
				await mkdir(join(path, ".."), { recursive: true })
				await writeFile(path, Buffer.alloc(1_000))
				const t = (now - ageMs) / 1000
				await utimes(path, t, t)
			}
			await put("recordings/dv/probe-scn-abc-dmr-1/WAV/call.wav", 3_600_000)
			await put("recordings/dv/d_A/old.wav", 1_800_000)
			// 2000 B > 1500 B: only d_A's file may go; the probe's (older) file waits for linking
			const { deleted } = await store.retention(new Set())
			expect(deleted).toEqual([join("recordings", "dv", "d_A", "old.wav")])
			expect(
				existsSync(
					join(
						root,
						"recordings",
						"dv",
						"probe-scn-abc-dmr-1",
						"WAV",
						"call.wav",
					),
				),
			).toBe(true)
		})
	})

	// Feature: signal-discovery-scanner, Property 14: Retention
	// Validates: spec § 8
	it("meets the caps unless only protected files remain, never deletes young or keep files, expired before oldest", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fileArb, { minLength: 1, maxLength: 20 }),
				fc.subarray([0, 1, 2, 3]),
				fc.integer({ min: 1, max: 30 }),
				fc.integer({ min: 0, max: 30_000 }),
				fc.integer({ min: 0, max: 30_000 }),
				async (files, keepIdx, maxAgeDays, recCap, evCap) => {
					await withDir(async root => {
						const now = Date.now()
						const caps: StorageCaps = {
							maxRecordingsMb: recCap / MIB,
							maxEvidenceMb: evCap / MIB,
							maxAgeDays,
							minFreeDiskMb: 0,
						}
						const store = new EvidenceStore({
							dir: root,
							caps,
							logger,
							now: () => now,
							statfs: plentyOfDisk,
						})
						const meta = new Map<string, FileSpec>()
						for (const [i, f] of files.entries()) {
							const rel =
								f.kind === "evidence"
									? join("evidence", `d_${f.disc}`, `f${i}.bin`)
									: join("recordings", f.kind, `d_${f.disc}`, `f${i}.wav`)
							await mkdir(join(root, rel, ".."), { recursive: true })
							await writeFile(join(root, rel), Buffer.alloc(f.bytes))
							const t = (now - f.ageMs) / 1000
							await utimes(join(root, rel), t, t)
							meta.set(rel, f)
						}
						const keep = new Set(keepIdx.map(k => `d_${k}`))
						const isProtected = (f: FileSpec) =>
							f.ageMs < 10_000 || keep.has(`d_${f.disc}`)
						const isExpired = (f: FileSpec) => f.ageMs > maxAgeDays * DAY
						const category = (f: FileSpec) =>
							f.kind === "evidence" ? "evidence" : "recordings"
						const { deleted } = await store.retention(keep)
						const gone = new Set(deleted)
						for (const rel of deleted)
							expect(isProtected(meta.get(rel) as FileSpec)).toBe(false)
						for (const [cat, cap] of [
							["recordings", recCap],
							["evidence", evCap],
						] as const) {
							const remaining = [...meta].filter(
								([rel, f]) => !gone.has(rel) && category(f) === cat,
							)
							const total = remaining.reduce((s, [, f]) => s + f.bytes, 0)
							if (total > cap)
								for (const [, f] of remaining) expect(isProtected(f)).toBe(true)
						}
						for (const [rel, f] of meta)
							if (!gone.has(rel) && isExpired(f))
								expect(isProtected(f)).toBe(true)
						const specs = deleted.map(rel => meta.get(rel) as FileSpec)
						const firstFresh = specs.findIndex(f => !isExpired(f))
						if (firstFresh >= 0)
							expect(specs.slice(firstFresh).every(f => !isExpired(f))).toBe(
								true,
							)
						const nonIncreasingAge = (list: FileSpec[]) =>
							list.every(
								(f, i) => i === 0 || (list[i - 1] as FileSpec).ageMs >= f.ageMs,
							)
						expect(nonIncreasingAge(specs.filter(isExpired))).toBe(true)
						for (const cat of ["recordings", "evidence"] as const)
							expect(
								nonIncreasingAge(
									specs.filter(f => !isExpired(f) && category(f) === cat),
								),
							).toBe(true)
					})
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000) // 100 runs of real file I/O: ~5 s on a loaded laptop
})
