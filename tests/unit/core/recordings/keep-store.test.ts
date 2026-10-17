import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import * as nodeFs from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	RECORDING_KEEPS_FILE_MAX_BYTES,
	RECORDING_KEEPS_FILE_NAME,
	RECORDING_KEEPS_MAX_BYTES,
	RECORDING_KEEPS_MAX_ENTRIES,
} from "@wavekit/api-types"
import type { RecordingKeepsFile } from "../../../../src/core/recordings/contract.js"
import {
	nodeRecordingKeepsFs,
	openRecordingKeepStore,
	parseRecordingKeepsFile,
	serializeRecordingKeepsFile,
} from "../../../../src/core/recordings/keep-store.js"
import type { RecordingKeepsFs } from "../../../../src/core/recordings/keep-store.js"
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

function fileOf(
	keys: readonly string[],
	bytesEach = 1,
	revision = 1,
): RecordingKeepsFile {
	return {
		schemaVersion: 1,
		revision,
		keeps: keys.map(key => ({
			key: key as RecordingKeepsFile["keeps"][number]["key"],
			keptAt: "2026-10-17T08:00:00.000Z",
			bytes: bytesEach,
		})),
	}
}

describe("recording keep store", () => {
	let dir = ""
	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true })
		dir = ""
	})
	const mk = async (): Promise<string> =>
		(dir = await mkdtemp(path.join(tmpdir(), "wk-keeps-")))
	const filePath = (): string => path.join(dir, RECORDING_KEEPS_FILE_NAME)

	async function expectFailed(text: string | Buffer): Promise<void> {
		await mk()
		await writeFile(filePath(), text)
		const before = await readFile(filePath())
		const { logger, warn } = spyLogger()
		const store = await openRecordingKeepStore({ stateDir: dir, log: logger })
		expect(store.state()).toBe("failed")
		expect(store.snapshot().keeps).toEqual([])
		expect(warn).toHaveBeenCalledTimes(1)
		await expect(store.write(fileOf([KEY_DSD(1)]))).rejects.toMatchObject({
			code: "RECORDING_KEEPS_UNAVAILABLE",
			status: 503,
		})
		expect((await readFile(filePath())).equals(before)).toBe(true)
		expect(await readdir(dir)).toEqual([RECORDING_KEEPS_FILE_NAME])
	}

	it("loads a missing file as empty, revision 0", async () => {
		await mk()
		const store = await openRecordingKeepStore({
			stateDir: dir,
			log: spyLogger().logger,
		})
		expect(store.state()).toBe("ready")
		expect(store.snapshot()).toEqual({
			schemaVersion: 1,
			revision: 0,
			keeps: [],
		})
		expect(await readdir(dir)).toEqual([])
	})

	it("round trips a write through a reload", async () => {
		await mk()
		const log = spyLogger().logger
		const store = await openRecordingKeepStore({ stateDir: dir, log })
		const next = fileOf([KEY_DSD(1), "scan:d_x~call.wav"], 1234, 1)
		await store.write(next)
		expect(store.snapshot()).toEqual(next)
		expect(await readFile(filePath(), "utf8")).toBe(
			serializeRecordingKeepsFile(next),
		)
		await store.close()
		const again = await openRecordingKeepStore({ stateDir: dir, log })
		expect(again.state()).toBe("ready")
		expect(again.snapshot()).toEqual(next)
		expect(await readdir(dir)).toEqual([RECORDING_KEEPS_FILE_NAME])
	})

	it("fails closed on corrupt JSON, leaving the file in place", async () => {
		await expectFailed("{ not json")
	})

	it.each([
		["array", "[]"],
		["wrong version", JSON.stringify({ ...fileOf([]), schemaVersion: 2 })],
		["extra field", JSON.stringify({ ...fileOf([]), extra: 1 })],
		[
			"entry extra field",
			JSON.stringify({
				...fileOf([]),
				keeps: [{ ...fileOf([KEY_DSD(1)]).keeps[0], x: 1 }],
			}),
		],
		["negative bytes", JSON.stringify(fileOf([KEY_DSD(1)], -1))],
		["fraction bytes", JSON.stringify(fileOf([KEY_DSD(1)], 1.5))],
		["unsafe bytes", JSON.stringify(fileOf([KEY_DSD(1)], 2 ** 53))],
		["unsafe revision", JSON.stringify(fileOf([], 1, 2 ** 53))],
		["negative revision", JSON.stringify(fileOf([], 1, -1))],
		[
			"bad keptAt",
			JSON.stringify({
				...fileOf([]),
				keeps: [{ key: KEY_DSD(1), keptAt: "yesterday", bytes: 1 }],
			}),
		],
		["missing keeps", JSON.stringify({ schemaVersion: 1, revision: 0 })],
	])("fails closed on a wrong shape (%s)", async (_name, text) => {
		await expectFailed(text)
	})

	it("fails closed on duplicate keys", async () => {
		await expectFailed(JSON.stringify(fileOf([KEY_DSD(1), KEY_DSD(1)])))
	})

	it.each([
		"/etc/passwd",
		"dsd~../20261016_120000_00001_1_GROUP_TGT_1_SRC_2.wav",
		"scan:d_x~../../x.wav",
		"scan:d_x/../d_y~x.wav",
		"dsd:0~20261016_120000_00001_1_GROUP_TGT_1_SRC_2.wav",
	])("fails closed on a key that is a path or an id (%s)", async key => {
		await expectFailed(JSON.stringify(fileOf([key])))
	})

	it("accepts 2000 entries and fails closed on 2001", async () => {
		const keys = (n: number) => Array.from({ length: n }, (_, i) => KEY_DSD(i))
		const ok = serializeRecordingKeepsFile(
			fileOf(keys(RECORDING_KEEPS_MAX_ENTRIES)),
		)
		expect(parseRecordingKeepsFile(ok)?.keeps).toHaveLength(2000)
		await mk()
		await writeFile(filePath(), ok)
		const store = await openRecordingKeepStore({
			stateDir: dir,
			log: spyLogger().logger,
		})
		expect(store.state()).toBe("ready")
		await rm(dir, { recursive: true, force: true })
		await expectFailed(
			serializeRecordingKeepsFile(
				fileOf(keys(RECORDING_KEEPS_MAX_ENTRIES + 1)),
			),
		)
	})

	it("accepts kept bytes at 512 MiB and fails closed one past", async () => {
		const at = fileOf([KEY_DSD(1), KEY_DSD(2)])
		const at0 = at.keeps[0]
		const at1 = at.keeps[1]
		if (!at0 || !at1) throw new Error("fixture")
		const atBound: RecordingKeepsFile = {
			...at,
			keeps: [
				{ ...at0, bytes: RECORDING_KEEPS_MAX_BYTES - 10 },
				{ ...at1, bytes: 10 },
			],
		}
		expect(
			parseRecordingKeepsFile(serializeRecordingKeepsFile(atBound)),
		).not.toBeNull()
		await expectFailed(
			serializeRecordingKeepsFile({
				...atBound,
				keeps: [atBound.keeps[0] ?? at0, { ...at1, bytes: 11 }],
			}),
		)
	})

	it("accepts a file of exactly 1 MiB and fails closed one byte past", async () => {
		const body = serializeRecordingKeepsFile(fileOf([KEY_DSD(1)]))
		const exact =
			body + " ".repeat(RECORDING_KEEPS_FILE_MAX_BYTES - body.length)
		expect(Buffer.byteLength(exact)).toBe(RECORDING_KEEPS_FILE_MAX_BYTES)
		await mk()
		await writeFile(filePath(), exact)
		const store = await openRecordingKeepStore({
			stateDir: dir,
			log: spyLogger().logger,
		})
		expect(store.state()).toBe("ready")
		expect(store.snapshot().keeps).toHaveLength(1)
		await rm(dir, { recursive: true, force: true })
		await expectFailed(`${exact} `)
	})

	it("states the bound arithmetic: 2000 entries at the longest dsd key fit in 1 MiB", () => {
		const longest = `dsd~20261016_120000_00001_${"a".repeat(200)}.wav`
		const keys = Array.from(
			{ length: RECORDING_KEEPS_MAX_ENTRIES },
			(_, i) => `${longest.slice(0, -4 - String(i).length)}${i}.wav`,
		)
		const file = fileOf(keys, RECORDING_KEEPS_MAX_BYTES, 2 ** 52)
		const body = serializeRecordingKeepsFile(file)
		expect(longest.length).toBe(230)
		// ~ 2000 x 312 bytes ≈ 624 KB < 1 MiB
		expect(Buffer.byteLength(body)).toBeLessThan(RECORDING_KEEPS_FILE_MAX_BYTES)
		expect(Buffer.byteLength(body)).toBeLessThan(640_000)
	})

	it("fails closed on a symlink or a directory at the path", async () => {
		await mk()
		await writeFile(
			path.join(dir, "real.json"),
			serializeRecordingKeepsFile(fileOf([])),
		)
		await nodeFs.symlink("real.json", filePath())
		const a = await openRecordingKeepStore({
			stateDir: dir,
			log: spyLogger().logger,
		})
		expect(a.state()).toBe("failed")
		await rm(filePath())
		await nodeFs.mkdir(filePath())
		const b = await openRecordingKeepStore({
			stateDir: dir,
			log: spyLogger().logger,
		})
		expect(b.state()).toBe("failed")
	})

	function failingFs(on: "write" | "rename"): RecordingKeepsFs {
		return {
			...nodeRecordingKeepsFs,
			open: (async (...args: Parameters<typeof nodeFs.open>) => {
				const handle = await nodeFs.open(...args)
				if (on === "write" && args[1] === "wx") {
					return Object.assign(Object.create(handle) as object, {
						writeFile: () =>
							Promise.reject(
								Object.assign(new Error("EIO /secret"), { code: "EIO" }),
							),
						close: () => handle.close(),
					})
				}
				return handle
			}) as typeof nodeFs.open,
			rename: (async (...args: Parameters<typeof nodeFs.rename>) => {
				if (on === "rename")
					throw Object.assign(new Error("EXDEV /secret"), { code: "EXDEV" })
				return nodeFs.rename(...args)
			}) as typeof nodeFs.rename,
		}
	}

	it.each(["write", "rename"] as const)(
		"a %s failure leaves memory and disk agreeing, removes the tmp file and does not poison the chain",
		async on => {
			await mk()
			const log = spyLogger()
			const first = fileOf([KEY_DSD(1)], 1, 1)
			const seed = await openRecordingKeepStore({
				stateDir: dir,
				log: log.logger,
			})
			await seed.write(first)
			const fs = failingFs(on)
			const store = await openRecordingKeepStore({
				stateDir: dir,
				log: log.logger,
				fs,
			})
			await expect(
				store.write(fileOf([KEY_DSD(1), KEY_DSD(2)], 1, 2)),
			).rejects.toMatchObject({
				code: "RECORDING_KEEPS_UNAVAILABLE",
			})
			expect(store.snapshot()).toEqual(first)
			expect(
				parseRecordingKeepsFile(await readFile(filePath(), "utf8")),
			).toEqual(first)
			expect(await readdir(dir)).toEqual([RECORDING_KEEPS_FILE_NAME])
			expect(JSON.stringify(log.calls)).not.toContain("/secret")
			// The chain is not poisoned: a later write on a healthy store succeeds.
			const healthy = await openRecordingKeepStore({
				stateDir: dir,
				log: log.logger,
			})
			await healthy.write(fileOf([KEY_DSD(3)], 1, 2))
			expect(healthy.snapshot().keeps[0]?.key).toBe(KEY_DSD(3))
		},
	)

	it("serialises writes and keeps going after a refused one", async () => {
		await mk()
		const store = await openRecordingKeepStore({
			stateDir: dir,
			log: spyLogger().logger,
		})
		const bad = fileOf([KEY_DSD(1), KEY_DSD(1)])
		const results = await Promise.allSettled([
			store.write(fileOf([KEY_DSD(1)], 1, 1)),
			store.write(bad),
			store.write(fileOf([KEY_DSD(2)], 1, 2)),
		])
		expect(results.map(r => r.status)).toEqual([
			"fulfilled",
			"rejected",
			"fulfilled",
		])
		expect(results[1]).toMatchObject({
			reason: { code: "RECORDING_KEEP_LIMIT" },
		})
		expect(store.snapshot().keeps.map(e => e.key)).toEqual([KEY_DSD(2)])
	})

	it("sweeps stale tmp files of other processes, keeping fresh ones", async () => {
		await mk()
		const stale = path.join(dir, `${RECORDING_KEEPS_FILE_NAME}.1.tmp`)
		const fresh = path.join(dir, `${RECORDING_KEEPS_FILE_NAME}.2.tmp`)
		await writeFile(stale, "x")
		await writeFile(fresh, "x")
		const old = (Date.now() - 120_000) / 1000
		await nodeFs.utimes(stale, old, old)
		await openRecordingKeepStore({ stateDir: dir, log: spyLogger().logger })
		expect((await readdir(dir)).sort()).toEqual([
			`${RECORDING_KEEPS_FILE_NAME}.2.tmp`,
		])
	})
})
