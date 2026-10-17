import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	symlink,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises"
import * as nodeFs from "node:fs/promises"
import { readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	RECORDING_KEEPS_FILE_NAME,
	RECORDING_KEEPS_MAX_BYTES,
	RECORDING_KEEPS_MAX_ENTRIES,
} from "@wavekit/api-types"
import {
	pruneCallRecordings,
	setCallRecordingProtection,
} from "../../../../src/decoders/builtin/call-recordings.js"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import type { RecordingInventory } from "../../../../src/core/recordings/inventory.js"
import { openRecordingKeepService } from "../../../../src/core/recordings/keep-service.js"
import type {
	RecordingDeleteFs,
	RecordingKeepServiceInternal,
	RecordingKeepServiceOptions,
} from "../../../../src/core/recordings/keep-service.js"
import {
	nodeRecordingKeepsFs,
	serializeRecordingKeepsFile,
} from "../../../../src/core/recordings/keep-store.js"
import type { RecordingKeepsFs } from "../../../../src/core/recordings/keep-store.js"
import type { RecordingKeepKey } from "../../../../src/core/recordings/contract.js"
import type { RecordingKeepsFile } from "../../../../src/core/recordings/contract.js"
import type { Logger } from "../../../../src/utils/logger.js"

function spyLogger(): {
	logger: Logger
	calls: unknown[][]
	warn: ReturnType<typeof vi.fn>
} {
	const calls: unknown[][] = []
	const mk = () =>
		vi.fn((...args: unknown[]) => {
			calls.push(args)
		})
	const warn = mk()
	const l: Record<string, unknown> = {
		warn,
		info: mk(),
		debug: mk(),
		error: mk(),
		trace: mk(),
		fatal: mk(),
	}
	l["child"] = (bindings: unknown) => {
		calls.push([bindings])
		return l
	}
	return { logger: l as unknown as Logger, calls, warn }
}

const KEY_DSD = (i: number): string =>
	`dsd~20261016_120000_${String(i % 100_000).padStart(5, "0")}_${i}_GROUP_TGT_1_SRC_2.wav`

function fileOf(keys: readonly string[], bytesEach = 1): RecordingKeepsFile {
	return {
		schemaVersion: 1,
		revision: 1,
		keeps: keys.map(key => ({
			key: key as RecordingKeepKey,
			keptAt: "2026-10-17T08:00:00.000Z",
			bytes: bytesEach,
		})),
	}
}

const NAME = "20261016_120000_01234_1_GROUP_TGT_100_SRC_2001.wav"
const NAME2 = "20261016_120001_01234_1_GROUP_TGT_100_SRC_2001.wav"
const DSD_ID = `dsd:0~${NAME}`
const DSD_ID2 = `dsd:0~${NAME2}`
const SCAN_ID = "scan:d_x~call.wav"
const BYTES = 16_044

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

interface Fixture {
	root: string
	stateDir: string
	dsd: string
	scan: string
	now: number
	inventory: RecordingInventory
	logs: ReturnType<typeof spyLogger>
	invalidations: number
	open(
		extra?: Partial<RecordingKeepServiceOptions>,
	): Promise<RecordingKeepServiceInternal>
}

let roots: string[] = []
afterEach(async () => {
	for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

async function fixture(): Promise<Fixture> {
	const root = await mkdtemp(path.join(tmpdir(), "wk-keepsvc-"))
	roots.push(root)
	const now = Date.now() + 60_000
	const stateDir = path.join(root, "state")
	const dsd = path.join(root, "dsd")
	const scan = path.join(root, "scan")
	await mkdir(stateDir)
	const put = async (p: string): Promise<void> => {
		await mkdir(path.dirname(p), { recursive: true })
		await writeFile(p, wav(16_000))
		const t = (now - 30_000) / 1000
		await utimes(p, t, t)
	}
	await put(path.join(dsd, NAME))
	await put(path.join(dsd, NAME2))
	await put(path.join(scan, "dv", "d_x", "call.wav"))
	const logs = spyLogger()
	const base = createRecordingInventory({
		dsdFmeDirs: () => [{ decoderId: "a", dir: dsd }],
		scannerRecordingsDir: () => scan,
		now: () => now,
		logger: logs.logger,
	})
	const f: Fixture = {
		root,
		stateDir,
		dsd,
		scan,
		now,
		logs,
		invalidations: 0,
		inventory: {
			...base,
			invalidate: () => {
				f.invalidations++
				base.invalidate?.()
			},
		},
		open: async extra =>
			(await openRecordingKeepService({
				stateDir,
				inventory: f.inventory,
				logger: logs.logger,
				now: () => now,
				...extra,
			})) as RecordingKeepServiceInternal,
	}
	return f
}

const keyOf = (name: string) => `dsd~${name}` as RecordingKeepKey
const storeText = (f: Fixture) =>
	readFile(path.join(f.stateDir, RECORDING_KEEPS_FILE_NAME), "utf8")

function noSecretsLogged(f: Fixture): void {
	const text = JSON.stringify(f.logs.calls)
	for (const s of [NAME, NAME2, "d_x", "call.wav", f.root, DSD_ID, "dsd~"])
		expect(text).not.toContain(s)
}

describe("recording keep service", () => {
	it("keeps, is idempotent, protects every form, and unkeeps", async () => {
		const f = await fixture()
		const svc = await f.open()
		expect(svc.state()).toBe("ready")
		expect(svc.isDsdFmeFileProtected(NAME)).toBe(false)
		expect(svc.isDsdFmeFileProtected("TEMP_20261016_120000_ABCD.wav")).toBe(
			false,
		)
		await expect(svc.keep(DSD_ID)).resolves.toEqual({
			id: DSD_ID,
			kept: true,
			changed: true,
		})
		const text = await storeText(f)
		await expect(svc.keep(DSD_ID)).resolves.toEqual({
			id: DSD_ID,
			kept: true,
			changed: false,
		})
		expect(await storeText(f)).toBe(text)
		expect(svc.isProtected(keyOf(NAME))).toBe(true)
		expect(svc.isDsdFmeFileProtected(NAME)).toBe(true)
		expect(JSON.parse(text)).toMatchObject({
			revision: 1,
			keeps: [{ key: keyOf(NAME), bytes: BYTES }],
		})

		await svc.keep(SCAN_ID)
		expect(svc.isScannerFileProtected("d_x", "call.wav")).toBe(true)
		expect(svc.discoveryHoldsKept("d_x")).toBe(true)
		expect(svc.discoveryHoldsKept("d_y")).toBe(false)
		await expect(svc.unkeep(SCAN_ID)).resolves.toEqual({
			id: SCAN_ID,
			kept: false,
			changed: true,
		})
		expect(svc.discoveryHoldsKept("d_x")).toBe(false)
		await expect(svc.unkeep(SCAN_ID)).resolves.toEqual({
			id: SCAN_ID,
			kept: false,
			changed: false,
		})
		expect(svc.mutexCount()).toBe(0)
		await svc.close()
		// Reload: kept from disk.
		const again = await f.open()
		expect(again.isDsdFmeFileProtected(NAME)).toBe(true)
		expect(again.isScannerFileProtected("d_x", "call.wav")).toBe(false)
		noSecretsLogged(f)
	})

	it("refuses Keep of a missing or ineligible id with 404 and writes nothing", async () => {
		const f = await fixture()
		const svc = await f.open()
		for (const id of [
			"dsd:0~20261016_120009_01234_1_GROUP_TGT_1_SRC_2.wav",
			"dsd:5~" + NAME,
			"scan:d_y~call.wav",
			"/etc/passwd",
			"dsd:0~../" + NAME,
		])
			await expect(svc.keep(id)).rejects.toMatchObject({
				code: "RECORDING_NOT_FOUND",
				status: 404,
				message: "Recording not found",
			})
		// A fresh (in-progress) file is ineligible.
		const t = f.now / 1000
		await utimes(path.join(f.dsd, NAME2), t, t)
		await expect(svc.keep(DSD_ID2)).rejects.toMatchObject({ status: 404 })
		await expect(storeText(f)).rejects.toMatchObject({ code: "ENOENT" })
		expect(svc.mutexCount()).toBe(0)
	})

	it("unkeeps a vanished file", async () => {
		const f = await fixture()
		const svc = await f.open()
		await svc.keep(DSD_ID)
		await unlink(path.join(f.dsd, NAME))
		await expect(svc.unkeep(DSD_ID)).resolves.toMatchObject({ changed: true })
		expect(svc.isDsdFmeFileProtected(NAME)).toBe(false)
	})

	it("refuses Keep at the entry bound and admits it one below", async () => {
		const f = await fixture()
		const keys = (n: number) =>
			Array.from({ length: n }, (_, i) => KEY_DSD(i + 10))
		const write = (n: number) =>
			writeFile(
				path.join(f.stateDir, RECORDING_KEEPS_FILE_NAME),
				serializeRecordingKeepsFile(fileOf(keys(n))),
			)
		await write(RECORDING_KEEPS_MAX_ENTRIES)
		const full = await f.open()
		await expect(full.keep(DSD_ID)).rejects.toMatchObject({
			code: "RECORDING_KEEP_LIMIT",
			status: 409,
		})
		expect(full.isDsdFmeFileProtected(NAME)).toBe(false)
		await write(RECORDING_KEEPS_MAX_ENTRIES - 1)
		const one = await f.open()
		await expect(one.keep(DSD_ID)).resolves.toMatchObject({ changed: true })
		expect(JSON.parse(await storeText(f)).keeps).toHaveLength(2000)
	})

	it("refuses Keep one byte past the kept-bytes bound and admits it at the bound", async () => {
		const f = await fixture()
		const write = (bytes: number) =>
			writeFile(
				path.join(f.stateDir, RECORDING_KEEPS_FILE_NAME),
				serializeRecordingKeepsFile(fileOf([KEY_DSD(1)], bytes)),
			)
		await write(RECORDING_KEEPS_MAX_BYTES - BYTES + 1)
		const over = await f.open()
		await expect(over.keep(DSD_ID)).rejects.toMatchObject({
			code: "RECORDING_KEEP_LIMIT",
		})
		await write(RECORDING_KEEPS_MAX_BYTES - BYTES)
		const at = await f.open()
		await expect(at.keep(DSD_ID)).resolves.toMatchObject({ changed: true })
	})

	it("deletes an unkept dsd recording and invalidates the inventory", async () => {
		const f = await fixture()
		const svc = await f.open()
		expect((await f.inventory.list({})).items).toHaveLength(3)
		const before = f.invalidations
		await expect(svc.remove(DSD_ID)).resolves.toEqual({
			id: DSD_ID,
			deleted: true,
		})
		await expect(lstat(path.join(f.dsd, NAME))).rejects.toMatchObject({
			code: "ENOENT",
		})
		expect(f.invalidations).toBe(before + 1)
		expect((await f.inventory.list({})).items).toHaveLength(2)
		await expect(svc.remove(DSD_ID)).rejects.toMatchObject({
			code: "RECORDING_NOT_FOUND",
			status: 404,
		})
		expect(svc.mutexCount()).toBe(0)
		expect(svc.isDsdFmeFileProtected(NAME)).toBe(false)
		noSecretsLogged(f)
	})

	it("refuses delete of a kept recording (409) and of a scanner recording (409)", async () => {
		const f = await fixture()
		const svc = await f.open()
		await svc.keep(DSD_ID)
		await expect(svc.remove(DSD_ID)).rejects.toMatchObject({
			code: "RECORDING_KEPT",
			status: 409,
		})
		await expect(svc.remove(SCAN_ID)).rejects.toMatchObject({
			code: "RECORDING_DELETE_UNSUPPORTED",
			status: 409,
		})
		await expect(svc.remove("../x")).rejects.toMatchObject({ status: 404 })
		await lstat(path.join(f.dsd, NAME))
		await lstat(path.join(f.scan, "dv", "d_x", "call.wav"))
	})

	it.each(["file", "symlink"] as const)(
		"refuses a delete when the path is swapped for another %s between open and unlink",
		async kind => {
			const f = await fixture()
			const target = path.join(f.dsd, NAME)
			const other = path.join(f.root, "other.wav")
			await writeFile(other, "OTHER")
			let unlinks = 0
			const deleteFs: RecordingDeleteFs = {
				lstat: async p => {
					// The swap lands after the verified open, right before the device/inode check.
					await rename(target, path.join(f.root, "moved.wav"))
					if (kind === "file") await nodeFs.copyFile(other, target)
					else await symlink(other, target)
					return nodeFs.lstat(p)
				},
				unlink: async p => {
					unlinks++
					await nodeFs.unlink(p)
				},
				rename: (a, b) => nodeFs.rename(a, b),
				link: (a, b) => nodeFs.link(a, b),
				mkdtemp: prefix => nodeFs.mkdtemp(prefix),
				rmdir: p => nodeFs.rmdir(p),
				readlink: p => nodeFs.readlink(p),
				symlink: (t, p) => nodeFs.symlink(t, p),
			}
			const svc = await f.open({ deleteFs })
			await expect(svc.remove(DSD_ID)).rejects.toMatchObject({
				code: "RECORDING_NOT_FOUND",
			})
			expect(unlinks).toBe(0)
			await lstat(target)
			await lstat(path.join(f.root, "moved.wav"))
			expect(await readFile(other, "utf8")).toBe("OTHER")
			expect(svc.mutexCount()).toBe(0)
			noSecretsLogged(f)
		},
	)

	it("answers 404 when the file vanishes at unlink", async () => {
		const f = await fixture()
		const svc = await f.open({
			deleteFs: {
				lstat: p => nodeFs.lstat(p),
				unlink: () =>
					Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" })),
				rename: (a, b) => nodeFs.rename(a, b),
				link: (a, b) => nodeFs.link(a, b),
				mkdtemp: prefix => nodeFs.mkdtemp(prefix),
				rmdir: p => nodeFs.rmdir(p),
				readlink: p => nodeFs.readlink(p),
				symlink: (t, p) => nodeFs.symlink(t, p),
			},
		})
		await expect(svc.remove(DSD_ID)).rejects.toMatchObject({ status: 404 })
	})

	it("refuses Keep with RECORDING_BUSY while a delete is in progress, and protects meanwhile", async () => {
		const f = await fixture()
		let releaseLstat = (): void => undefined
		let held = false
		let entered = (): void => undefined
		const inLstat = new Promise<void>(r => {
			entered = r
		})
		const svc = await f.open({
			deleteFs: {
				lstat: async p => {
					if (!held) {
						held = true
						entered()
						await new Promise<void>(r => {
							releaseLstat = r
						})
					}
					return nodeFs.lstat(p)
				},
				unlink: p => nodeFs.unlink(p),
				rename: (a, b) => nodeFs.rename(a, b),
				link: (a, b) => nodeFs.link(a, b),
				mkdtemp: prefix => nodeFs.mkdtemp(prefix),
				rmdir: p => nodeFs.rmdir(p),
				readlink: p => nodeFs.readlink(p),
				symlink: (t, p) => nodeFs.symlink(t, p),
			},
		})
		const del = svc.remove(DSD_ID)
		await inLstat
		expect(svc.isDsdFmeFileProtected(NAME)).toBe(true)
		await expect(svc.keep(DSD_ID)).rejects.toMatchObject({
			code: "RECORDING_BUSY",
			status: 409,
		})
		releaseLstat()
		await expect(del).resolves.toMatchObject({ deleted: true })
		expect(svc.isDsdFmeFileProtected(NAME)).toBe(false)
		expect(svc.mutexCount()).toBe(0)
	})

	it("a delete queued behind a Keep sees it kept and refuses", async () => {
		const f = await fixture()
		const svc = await f.open()
		const k = svc.keep(DSD_ID)
		const d = svc.remove(DSD_ID)
		await expect(k).resolves.toMatchObject({ changed: true })
		await expect(d).rejects.toMatchObject({ code: "RECORDING_KEPT" })
		await lstat(path.join(f.dsd, NAME))
		expect(svc.mutexCount()).toBe(0)
	})

	it("concurrent Keeps of different keys are all persisted", async () => {
		const f = await fixture()
		const svc = await f.open()
		await Promise.all([svc.keep(DSD_ID), svc.keep(DSD_ID2), svc.keep(SCAN_ID)])
		const disk = JSON.parse(await storeText(f)) as {
			revision: number
			keeps: unknown[]
		}
		expect(disk.keeps).toHaveLength(3)
		expect(disk.revision).toBe(3)
	})

	it("marks inventory items kept and refreshes after Keep and unkeep", async () => {
		const f = await fixture()
		let svc: RecordingKeepServiceInternal | null = null
		const inv = createRecordingInventory({
			dsdFmeDirs: () => [{ decoderId: "a", dir: f.dsd }],
			scannerRecordingsDir: () => f.scan,
			now: () => f.now,
			logger: f.logs.logger,
			protection: {
				isProtected: k => svc?.isProtected(k) ?? true,
				isDsdFmeFileProtected: n => svc?.isDsdFmeFileProtected(n) ?? true,
				isScannerFileProtected: (d, n) =>
					svc?.isScannerFileProtected(d, n) ?? true,
				discoveryHoldsKept: d => svc?.discoveryHoldsKept(d) ?? true,
			},
		})
		const keptOf = async () =>
			Object.fromEntries((await inv.list({})).items.map(i => [i.id, i.kept]))
		expect(await keptOf()).toEqual({
			[DSD_ID]: true,
			[DSD_ID2]: true,
			[SCAN_ID]: true,
		})
		svc = await f.open({
			...{},
			inventory: inv,
		} as Partial<RecordingKeepServiceOptions>)
		expect(await keptOf()).toEqual({
			[DSD_ID]: false,
			[DSD_ID2]: false,
			[SCAN_ID]: false,
		})
		await svc.keep(SCAN_ID)
		expect((await keptOf())[SCAN_ID]).toBe(true)
		await svc.remove(DSD_ID)
		expect(await keptOf()).toEqual({ [DSD_ID2]: false, [SCAN_ID]: true })
		await svc.unkeep(SCAN_ID)
		expect((await keptOf())[SCAN_ID]).toBe(false)
	})

	it("a failed store protects everything and answers 503 for keep, unkeep and delete", async () => {
		const f = await fixture()
		const file = path.join(f.stateDir, RECORDING_KEEPS_FILE_NAME)
		await writeFile(file, "{ corrupt")
		const svc = await f.open()
		expect(svc.state()).toBe("failed")
		expect(svc.isProtected(keyOf(NAME))).toBe(true)
		expect(svc.isDsdFmeFileProtected(NAME)).toBe(true)
		expect(svc.isDsdFmeFileProtected("TEMP_20261016_120000_ABCD.wav")).toBe(
			true,
		)
		expect(svc.isDsdFmeFileProtected("not-a-call.txt")).toBe(true)
		expect(svc.isScannerFileProtected("d_x", "call.wav")).toBe(true)
		expect(svc.isScannerFileProtected("d_x", "bad name")).toBe(true)
		expect(svc.discoveryHoldsKept("d_zzz")).toBe(true)
		for (const op of [
			() => svc.keep(DSD_ID),
			() => svc.unkeep(DSD_ID),
			() => svc.remove(DSD_ID),
		])
			await expect(op()).rejects.toMatchObject({
				code: "RECORDING_KEEPS_UNAVAILABLE",
				status: 503,
			})
		expect(await readFile(file, "utf8")).toBe("{ corrupt")
		await lstat(path.join(f.dsd, NAME))
		expect(f.logs.warn).toHaveBeenCalledTimes(1)
		noSecretsLogged(f)
	})

	function failing(on: "write" | "rename"): RecordingKeepsFs {
		let armed = false
		const fs: RecordingKeepsFs & { arm(): void } = {
			...nodeRecordingKeepsFs,
			arm: () => {
				armed = true
			},
			open: (async (...args: Parameters<typeof nodeFs.open>) => {
				if (armed && on === "write" && args[1] === "wx")
					throw Object.assign(new Error("EIO " + args[0].toString()), {
						code: "EIO",
					})
				return nodeFs.open(...args)
			}) as typeof nodeFs.open,
			rename: (async (...args: Parameters<typeof nodeFs.rename>) => {
				if (armed && on === "rename")
					throw Object.assign(new Error("EXDEV " + args[0].toString()), {
						code: "EXDEV",
					})
				return nodeFs.rename(...args)
			}) as typeof nodeFs.rename,
		}
		return fs
	}

	it.each(["write", "rename"] as const)(
		"a %s failure rolls a Keep back (unprotected, 503) and keeps an unkept file protected (503)",
		async on => {
			const f = await fixture()
			const storeFs = failing(on) as RecordingKeepsFs & { arm(): void }
			const svc = await f.open({ storeFs })
			await svc.keep(DSD_ID)
			const text = await storeText(f)
			storeFs.arm()
			await expect(svc.keep(DSD_ID2)).rejects.toMatchObject({
				code: "RECORDING_KEEPS_UNAVAILABLE",
				status: 503,
			})
			expect(svc.isDsdFmeFileProtected(NAME2)).toBe(false)
			await expect(svc.unkeep(DSD_ID)).rejects.toMatchObject({
				code: "RECORDING_KEEPS_UNAVAILABLE",
			})
			expect(svc.isDsdFmeFileProtected(NAME)).toBe(true)
			expect(await storeText(f)).toBe(text)
			await expect(svc.remove(DSD_ID)).rejects.toMatchObject({
				code: "RECORDING_KEPT",
			})
			expect(svc.mutexCount()).toBe(0)
			noSecretsLogged(f)
		},
	)

	it("after close, Keep answers 503 and the store is unchanged", async () => {
		const f = await fixture()
		const svc = await f.open()
		await svc.keep(DSD_ID)
		await svc.close()
		const text = await storeText(f)
		await expect(svc.keep(DSD_ID2)).rejects.toMatchObject({ status: 503 })
		expect(await storeText(f)).toBe(text)
	})

	describe("review fixes (WG9 RK)", () => {
		afterEach(() => {
			setCallRecordingProtection(null)
		})

		const realDeleteFs = (
			over: Partial<RecordingDeleteFs> = {},
		): RecordingDeleteFs & { unlinked: string[] } => {
			const unlinked: string[] = []
			return {
				unlinked,
				lstat: p => nodeFs.lstat(p),
				unlink: async p => {
					unlinked.push(p)
					await nodeFs.unlink(p)
				},
				rename: (a, b) => nodeFs.rename(a, b),
				link: (a, b) => nodeFs.link(a, b),
				mkdtemp: prefix => nodeFs.mkdtemp(prefix),
				rmdir: p => nodeFs.rmdir(p),
				readlink: p => nodeFs.readlink(p),
				symlink: (t, p) => nodeFs.symlink(t, p),
				...over,
			}
		}
		const privateNames = async (f: Fixture): Promise<string[]> =>
			(await readdir(f.dsd)).filter(n => n.startsWith(".wavekit-delete-"))

		it("finding 1: a file swapped in right after the path check is not unlinked", async () => {
			const f = await fixture()
			const target = path.join(f.dsd, NAME)
			const other = path.join(f.root, "other.wav")
			await writeFile(other, "OTHER")
			let swapped = false
			const fsx = realDeleteFs({
				lstat: async p => {
					const st = await nodeFs.lstat(p)
					if (!swapped) {
						swapped = true
						// The swap lands after the check passed, before anything else runs.
						await rename(target, path.join(f.root, "moved.wav"))
						await nodeFs.copyFile(other, target)
					}
					return st
				},
			})
			const svc = await f.open({ deleteFs: fsx })
			await expect(svc.remove(DSD_ID)).rejects.toMatchObject({
				code: "RECORDING_NOT_FOUND",
			})
			expect(await readFile(target, "utf8")).toBe("OTHER")
			await lstat(path.join(f.root, "moved.wav"))
			expect(await privateNames(f)).toEqual([])
			noSecretsLogged(f)
		})

		it("finding 1: a file swapped in between the rename and the private check is not unlinked", async () => {
			const f = await fixture()
			const target = path.join(f.dsd, NAME)
			const other = path.join(f.root, "other.wav")
			await writeFile(other, "OTHER")
			const fsx = realDeleteFs({
				rename: async (a, b) => {
					await nodeFs.rename(a, b)
					await rename(b, path.join(f.root, "moved.wav"))
					await nodeFs.copyFile(other, b)
				},
			})
			const svc = await f.open({ deleteFs: fsx })
			await expect(svc.remove(DSD_ID)).rejects.toMatchObject({
				code: "RECORDING_NOT_FOUND",
			})
			expect(
				fsx.unlinked.every(p =>
					path.basename(path.dirname(p)).startsWith(".wavekit-delete-"),
				),
			).toBe(true)
			// The foreign file is put back under the free name, the private name is gone.
			expect(await readFile(target, "utf8")).toBe("OTHER")
			await lstat(path.join(f.root, "moved.wav"))
			expect(await privateNames(f)).toEqual([])
		})

		it("finding 1: a symlink swapped in right after the path check is not followed or unlinked", async () => {
			const f = await fixture()
			const target = path.join(f.dsd, NAME)
			const other = path.join(f.root, "other.wav")
			await writeFile(other, "OTHER")
			let swapped = false
			const fsx = realDeleteFs({
				lstat: async p => {
					const st = await nodeFs.lstat(p)
					if (!swapped) {
						swapped = true
						await rename(target, path.join(f.root, "moved.wav"))
						await symlink(other, target)
					}
					return st
				},
			})
			const svc = await f.open({ deleteFs: fsx })
			await expect(svc.remove(DSD_ID)).rejects.toMatchObject({
				code: "RECORDING_NOT_FOUND",
			})
			expect(await readFile(other, "utf8")).toBe("OTHER")
			// Restored as the symlink it was, not as a hard link to its target.
			expect((await lstat(target)).isSymbolicLink()).toBe(true)
			expect(await nodeFs.readlink(target)).toBe(other)
			expect(fsx.unlinked.every(p => path.basename(p) === "recording")).toBe(
				true,
			)
			await lstat(path.join(f.root, "moved.wav"))
			expect(await privateNames(f)).toEqual([])
		})

		it("finding 1: a foreign file is left under the private name when its name is taken again", async () => {
			const f = await fixture()
			const target = path.join(f.dsd, NAME)
			const fsx = realDeleteFs({
				rename: async (a, b) => {
					await nodeFs.rename(a, b)
					await rename(b, path.join(f.root, "moved.wav"))
					await writeFile(b, "FOREIGN")
					await writeFile(target, "NEW")
				},
			})
			const svc = await f.open({ deleteFs: fsx })
			await expect(svc.remove(DSD_ID)).rejects.toMatchObject({
				code: "RECORDING_NOT_FOUND",
			})
			expect(fsx.unlinked).toEqual([])
			expect(await readFile(target, "utf8")).toBe("NEW")
			const left = await privateNames(f)
			expect(left).toHaveLength(1)
			expect(
				await readFile(path.join(f.dsd, left[0] ?? "", "recording"), "utf8"),
			).toBe("FOREIGN")
			// The inventory never lists the private directory or what it holds.
			const ids = (await f.inventory.list({})).items.map(i => i.id)
			expect(ids.some(id => id.includes(".wavekit-delete-"))).toBe(false)
			expect(ids.some(id => id.includes("recording"))).toBe(false)
			expect(JSON.stringify(f.logs.calls)).toContain(
				"Recording delete could not restore a file; it is left under a private name",
			)
			noSecretsLogged(f)
		})

		it("finding 1: the path gone at the rename answers 404 and deletes nothing", async () => {
			const f = await fixture()
			const fsx = realDeleteFs({
				rename: () =>
					Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" })),
			})
			const svc = await f.open({ deleteFs: fsx })
			await expect(svc.remove(DSD_ID)).rejects.toMatchObject({ status: 404 })
			expect(fsx.unlinked).toEqual([])
			await lstat(path.join(f.dsd, NAME))
		})

		it("finding 1: a delete unlinks only the private name of the verified file", async () => {
			const f = await fixture()
			const fsx = realDeleteFs()
			const svc = await f.open({ deleteFs: fsx })
			await expect(svc.remove(DSD_ID)).resolves.toMatchObject({ deleted: true })
			expect(fsx.unlinked).toHaveLength(1)
			expect(path.basename(fsx.unlinked[0] ?? "")).toBe("recording")
			expect(path.basename(path.dirname(fsx.unlinked[0] ?? ""))).toMatch(
				/^\.wavekit-delete-/,
			)
			await expect(lstat(path.join(f.dsd, NAME))).rejects.toMatchObject({
				code: "ENOENT",
			})
			expect(await privateNames(f)).toEqual([])
		})

		it("round 2: mkdtemp failing answers 500 RECORDING_DELETE_FAILED with nothing renamed", async () => {
			const f = await fixture()
			let renames = 0
			const fsx = realDeleteFs({
				mkdtemp: () =>
					Promise.reject(Object.assign(new Error("full"), { code: "ENOSPC" })),
				rename: async (a, b) => {
					renames++
					await nodeFs.rename(a, b)
				},
			})
			const svc = await f.open({ deleteFs: fsx })
			await expect(svc.remove(DSD_ID)).rejects.toMatchObject({
				code: "RECORDING_DELETE_FAILED",
			})
			expect(renames).toBe(0)
			expect(fsx.unlinked).toEqual([])
			await lstat(path.join(f.dsd, NAME))
			expect(await privateNames(f)).toEqual([])
		})

		it("round 2: a shared-directory swap of the private entry after the inner lstat is not unlinked", async () => {
			const f = await fixture()
			const foreign = path.join(f.root, "foreign.wav")
			await writeFile(foreign, "FOREIGN")
			let calls = 0
			let swapErrors = 0
			const fsx = realDeleteFs({
				lstat: async p => {
					const st = await nodeFs.lstat(p)
					if (++calls === 2) {
						// A writer in the shared directory replaces every private entry it can name.
						for (const n of await readdir(f.dsd))
							if (n.startsWith(".wavekit-delete-"))
								await nodeFs.rename(foreign, path.join(f.dsd, n)).catch(() => {
									swapErrors++
								})
					}
					return st
				},
			})
			const svc = await f.open({ deleteFs: fsx })
			await expect(svc.remove(DSD_ID)).resolves.toMatchObject({ deleted: true })
			expect(swapErrors).toBe(1)
			expect(await readFile(foreign, "utf8")).toBe("FOREIGN")
			expect(await privateNames(f)).toEqual([])
		})

		it("finding 2: the real pruner running during Keep's open and close does not delete the file", async () => {
			const f = await fixture()
			let svc: RecordingKeepServiceInternal | null = null
			const prune = async (): Promise<void> => {
				await pruneCallRecordings(
					[f.dsd],
					{ maxTotalMb: 0, maxAgeHours: 0 },
					f.now,
				)
			}
			const inv: RecordingInventory = {
				...f.inventory,
				open: async id => {
					await prune()
					const opened = await f.inventory.open(id)
					await prune()
					if (!opened) return opened
					const close = opened.handle.close.bind(opened.handle)
					const handle = Object.assign(Object.create(opened.handle) as object, {
						close: async () => {
							await prune()
							await close()
							await prune()
						},
					}) as typeof opened.handle
					return { ...opened, handle }
				},
			}
			svc = (await openRecordingKeepService({
				stateDir: f.stateDir,
				inventory: inv,
				logger: f.logs.logger,
				now: () => f.now,
			})) as RecordingKeepServiceInternal
			setCallRecordingProtection(svc)
			await expect(svc.keep(DSD_ID)).resolves.toMatchObject({
				kept: true,
				changed: true,
			})
			await lstat(path.join(f.dsd, NAME))
			// The pruner did run: the unkept neighbour is gone.
			await expect(lstat(path.join(f.dsd, NAME2))).rejects.toMatchObject({
				code: "ENOENT",
			})
		})

		it("finding 2: a failed Keep clears its pending protection", async () => {
			const f = await fixture()
			const svc = await f.open()
			await unlink(path.join(f.dsd, NAME))
			await expect(svc.keep(DSD_ID)).rejects.toMatchObject({ status: 404 })
			expect(svc.isDsdFmeFileProtected(NAME)).toBe(false)
			expect(svc.mutexCount()).toBe(0)
		})

		it("finding 3: Keep of an already kept key whose file vanished answers 404", async () => {
			const f = await fixture()
			const svc = await f.open()
			await svc.keep(DSD_ID)
			await unlink(path.join(f.dsd, NAME))
			f.inventory.invalidate?.()
			await expect(svc.keep(DSD_ID)).rejects.toMatchObject({
				code: "RECORDING_NOT_FOUND",
				status: 404,
			})
			// Still kept: only unkeep removes it.
			expect(svc.isDsdFmeFileProtected(NAME)).toBe(true)
			await expect(svc.unkeep(DSD_ID)).resolves.toMatchObject({ changed: true })
		})
	})
})
