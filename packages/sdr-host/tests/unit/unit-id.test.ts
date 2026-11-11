import { describe, expect, it } from "vitest"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	loadOrCreateUnitId,
	loadUnitIdAtStartup,
	stateDirPersistence,
	TMPFS_MAGIC,
	UNIT_ID_FILE_NAME,
	type StatePersistenceProbe,
	type UnitIdFs,
} from "../../src/telemetry/unit-id.js"

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "sdr-host-unit-id-"))
	try {
		await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

function codeError(code: string): Error {
	return Object.assign(new Error(code), { code })
}

/** An in-memory fs that records every call; `fail` names a step that rejects. */
function recordingFs(
	options: {
		read?: () => Promise<Buffer>
		fail?: "open" | "write" | "sync" | "rename" | "syncDir"
		failCode?: string
	} = {},
): { fs: UnitIdFs; calls: string[] } {
	const calls: string[] = []
	const step = async (name: string, what: string): Promise<void> => {
		calls.push(what)
		if (options.fail === name) throw codeError(options.failCode ?? "EIO")
	}
	const fs: UnitIdFs = {
		readFile: options.read ?? (() => Promise.reject(codeError("ENOENT"))),
		open: async path => {
			await step("open", `open ${path}`)
			return {
				writeFile: data => step("write", `write ${data.trim()}`),
				sync: () => step("sync", "fsync file"),
				close: async () => {
					calls.push("close")
				},
			}
		},
		rename: (from, to) => step("rename", `rename ${from} -> ${to}`),
		unlink: async path => {
			calls.push(`unlink ${path}`)
		},
		mkdir: async path => {
			calls.push(`mkdir ${path}`)
		},
		syncDir: path => step("syncDir", `fsync dir ${path}`),
	}
	return { fs, calls }
}

describe("sdr-host unit id", () => {
	it("keeps the same id across restarts (a second load reads it back)", async () => {
		await withDir(async dir => {
			const first = await loadOrCreateUnitId(dir)
			expect(first.source).toBe("created")
			expect(first.unitId).toMatch(/^[0-9a-f]{32}$/)
			const second = await loadOrCreateUnitId(dir)
			expect(second).toEqual({
				unitId: first.unitId,
				source: "read",
				reason: null,
			})
			// Only the id file is left (no temporary file).
			expect(await readdir(dir)).toEqual([UNIT_ID_FILE_NAME])
		})
	})

	it("creates a new id when the file is missing", async () => {
		await withDir(async dir => {
			const first = await loadOrCreateUnitId(dir, undefined, () =>
				"a".repeat(32),
			)
			expect(first.unitId).toBe("a".repeat(32))
			await rm(join(dir, UNIT_ID_FILE_NAME))
			const again = await loadOrCreateUnitId(dir, undefined, () =>
				"b".repeat(32),
			)
			expect(again).toEqual({
				unitId: "b".repeat(32),
				source: "created",
				reason: null,
			})
			const text = await readFile(join(dir, UNIT_ID_FILE_NAME), "utf8")
			expect(JSON.parse(text)).toEqual({ version: 1, unitId: "b".repeat(32) })
		})
	})

	it.each([
		["not JSON", "{"],
		["a wrong version", JSON.stringify({ version: 2, unitId: "c".repeat(32) })],
		["a short id", JSON.stringify({ version: 1, unitId: "c".repeat(31) })],
		["upper-case hex", JSON.stringify({ version: 1, unitId: "C".repeat(32) })],
		["an oversized file", " ".repeat(2000)],
	])("regenerates a malformed file (%s)", async (_what, content) => {
		await withDir(async dir => {
			await writeFile(join(dir, UNIT_ID_FILE_NAME), content)
			const loaded = await loadOrCreateUnitId(dir, undefined, () =>
				"d".repeat(32),
			)
			expect(loaded).toEqual({
				unitId: "d".repeat(32),
				source: "created",
				reason: null,
			})
			const reread = await loadOrCreateUnitId(dir)
			expect(reread.unitId).toBe("d".repeat(32))
		})
	})

	it.each(["EACCES", "EIO", "EISDIR"])(
		"keeps the file and reports no id on a %s read error",
		async code => {
			const { fs, calls } = recordingFs({
				read: () => Promise.reject(codeError(code)),
			})
			expect(await loadOrCreateUnitId("/state", fs)).toEqual({
				unitId: null,
				source: "unavailable",
				reason: "state-unreadable",
			})
			// Nothing was written over the file that could not be read.
			expect(calls).toEqual([])
		},
	)

	it("reports state-unreadable when the id path is a directory (real fs)", async () => {
		await withDir(async dir => {
			const { mkdir } = await import("node:fs/promises")
			await mkdir(join(dir, UNIT_ID_FILE_NAME))
			const loaded = await loadOrCreateUnitId(dir)
			expect(loaded).toEqual({
				unitId: null,
				source: "unavailable",
				reason: "state-unreadable",
			})
		})
	})

	it("writes, fsyncs, renames and fsyncs the directory, in that order", async () => {
		const { fs, calls } = recordingFs()
		const loaded = await loadOrCreateUnitId("/state", fs, () => "e".repeat(32))
		expect(loaded.unitId).toBe("e".repeat(32))
		expect(calls).toHaveLength(7)
		expect(calls[0]).toBe("mkdir /state")
		expect(calls[1]).toMatch(/^open \/state\/unit-id\.json\.\d+\.tmp$/)
		expect(calls[2]).toBe(`write {"version":1,"unitId":"${"e".repeat(32)}"}`)
		expect(calls[3]).toBe("fsync file")
		expect(calls[4]).toBe("close")
		expect(calls[5]).toMatch(
			/^rename \/state\/unit-id\.json\.\d+\.tmp -> \/state\/unit-id\.json$/,
		)
		expect(calls[6]).toBe("fsync dir /state")
	})

	it.each(["write", "sync", "rename"] as const)(
		"removes the temporary file and reports no id when %s fails",
		async fail => {
			const { fs, calls } = recordingFs({ fail })
			expect(await loadOrCreateUnitId("/state", fs)).toEqual({
				unitId: null,
				source: "unavailable",
				reason: "state-unwritable",
			})
			expect(calls.at(-1)).toMatch(/^unlink \/state\/unit-id\.json\.\d+\.tmp$/)
			// The handle is closed even when a write or fsync fails.
			if (fail !== "rename") expect(calls).toContain("close")
		},
	)

	it("reports no id when the temporary file cannot be opened (nothing to remove)", async () => {
		const { fs, calls } = recordingFs({ fail: "open" })
		expect(await loadOrCreateUnitId("/state", fs)).toMatchObject({
			unitId: null,
			reason: "state-unwritable",
		})
		expect(calls.some(c => c.startsWith("unlink"))).toBe(false)
	})

	it("reports no id when the directory fsync fails (the rename may not be durable)", async () => {
		const { fs, calls } = recordingFs({ fail: "syncDir" })
		expect(await loadOrCreateUnitId("/state", fs)).toMatchObject({
			unitId: null,
			reason: "state-unwritable",
		})
		// Renamed already: there is no temporary file left to remove.
		expect(calls.some(c => c.startsWith("unlink"))).toBe(false)
	})

	it.each(["EINVAL", "ENOTSUP", "EPERM", "EISDIR"])(
		"keeps the id when the directory fsync is unsupported (%s, best effort)",
		async code => {
			const { fs, calls } = recordingFs({ fail: "syncDir", failCode: code })
			expect(
				await loadOrCreateUnitId("/state", fs, () => "9".repeat(32)),
			).toEqual({
				unitId: "9".repeat(32),
				source: "created",
				reason: null,
				dirSyncError: code,
			})
			expect(calls.at(-1)).toBe("fsync dir /state")
			expect(calls.some(c => c.startsWith("unlink"))).toBe(false)
		},
	)
})

describe("sdr-host state dir persistence", () => {
	const probe = (
		devices: Record<string, number | string>,
		inContainer = true,
		fsTypes: Record<string, number | string> = {},
	): StatePersistenceProbe => ({
		inContainer: () => inContainer,
		fsTypeOf: async path => {
			const type = fsTypes[path] ?? 0xef53
			if (typeof type === "string") throw codeError(type)
			return type
		},
		deviceOf: async path => {
			const dev = devices[path]
			if (dev === undefined) throw codeError("ENOENT")
			if (typeof dev === "string") throw codeError(dev)
			return dev
		},
	})

	it("is a mount when the dir's device differs from its parent's", async () => {
		expect(
			await stateDirPersistence("/state", probe({ "/state": 2, "/": 1 })),
		).toBe("mount")
	})

	it("is not a mount on the parent's device (the container layer)", async () => {
		expect(
			await stateDirPersistence("/state", probe({ "/state": 1, "/": 1 })),
		).toBe("not-mount")
	})

	it("is not a mount when the dir is missing", async () => {
		expect(await stateDirPersistence("/state", probe({ "/": 1 }))).toBe(
			"not-mount",
		)
	})

	it.each([
		["the dir", { "/state": "EACCES", "/": 1 }],
		["the parent", { "/state": 2, "/": "EIO" }],
	])("is unknown when stat of %s fails", async (_what, devices) => {
		expect(await stateDirPersistence("/state", probe(devices))).toBe("unknown")
	})

	it("needs no mount outside a container", async () => {
		expect(
			await stateDirPersistence(
				"/state",
				probe({ "/state": 1, "/": 1 }, false),
			),
		).toBe("not-container")
	})

	it.each([true, false])(
		"rejects a tmpfs state dir (in a container: %s)",
		async inContainer => {
			expect(
				await stateDirPersistence(
					"/state",
					probe({ "/state": 2, "/": 1 }, inContainer, {
						"/state": TMPFS_MAGIC,
					}),
				),
			).toBe("tmpfs")
		},
	)

	it("skips the tmpfs check when statfs fails", async () => {
		expect(
			await stateDirPersistence(
				"/state",
				probe({ "/state": 2, "/": 1 }, true, { "/state": "ENOSYS" }),
			),
		).toBe("mount")
	})

	it("reports state-not-persistent for a tmpfs state dir at startup and writes nothing", async () => {
		const { fs, calls } = recordingFs()
		const startup = await loadUnitIdAtStartup("/state", {
			fs,
			probe: probe({ "/state": 2, "/": 1 }, true, { "/state": TMPFS_MAGIC }),
		})
		expect(startup).toEqual({
			persistence: "tmpfs",
			result: {
				unitId: null,
				source: "unavailable",
				reason: "state-not-persistent",
			},
		})
		expect(calls).toEqual([])
	})

	it("reports state-not-persistent at startup and writes nothing", async () => {
		const { fs, calls } = recordingFs()
		const startup = await loadUnitIdAtStartup("/state", {
			fs,
			probe: probe({ "/state": 1, "/": 1 }),
		})
		expect(startup).toEqual({
			persistence: "not-mount",
			result: {
				unitId: null,
				source: "unavailable",
				reason: "state-not-persistent",
			},
		})
		expect(calls).toEqual([])
	})

	it.each(["mount", "unknown"] as const)(
		"loads the id at startup when the state dir is %s",
		async persistence => {
			const { fs } = recordingFs()
			const startup = await loadUnitIdAtStartup("/state", {
				fs,
				probe: probe(
					persistence === "mount"
						? { "/state": 2, "/": 1 }
						: { "/state": "EACCES", "/": 1 },
				),
				random: () => "f".repeat(32),
			})
			expect(startup.persistence).toBe(persistence)
			expect(startup.result.unitId).toBe("f".repeat(32))
		},
	)
})
