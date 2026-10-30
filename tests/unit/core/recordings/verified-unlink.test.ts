/**
 * WG10 RK2: the shared verified unlink (requirements 1.1-1.3, 1.9): progress names, the decision
 * in the unlink's turn, crash leftovers by name, refusals and the counted fs budget.
 */
import * as nodeFs from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RECORDING_DELETE_PRIVATE_DIR } from "../../../../src/core/recordings/contract.js"
import {
	nodeRecordingDeleteFs,
	verifiedUnlink,
} from "../../../../src/core/recordings/verified-unlink.js"
import type { RecordingDeleteFs } from "../../../../src/core/recordings/verified-unlink.js"
import type { Logger } from "../../../../src/utils/logger.js"

const NAME = "20261016_120000_01234_1_GROUP_TGT_100_SRC_2001.wav"

const roots: string[] = []
afterEach(async () => {
	for (const r of roots.splice(0))
		await nodeFs.rm(r, { recursive: true, force: true })
})

function quietLogger(): { logger: Logger; lines: unknown[][] } {
	const lines: unknown[][] = []
	const l: Record<string, unknown> = {}
	for (const level of ["warn", "info", "debug", "error", "trace", "fatal"])
		l[level] = vi.fn((...args: unknown[]) => {
			lines.push([level, ...args])
		})
	l["child"] = () => l
	return { logger: l as unknown as Logger, lines }
}

type Call = { op: string; p: string }
function countingFs(
	over: Partial<RecordingDeleteFs> = {},
): RecordingDeleteFs & {
	calls: Call[]
	count(op: string): number
} {
	const calls: Call[] = []
	const base = { ...nodeRecordingDeleteFs, ...over }
	const wrap =
		<A extends unknown[], R>(op: string, fn: (...a: A) => Promise<R>) =>
		(...a: A): Promise<R> => {
			calls.push({ op, p: String(a[0]) })
			return fn(...a)
		}
	return {
		calls,
		count: op => calls.filter(c => c.op === op).length,
		lstat: wrap("lstat", base.lstat),
		unlink: wrap("unlink", base.unlink),
		rename: wrap("rename", base.rename),
		link: wrap("link", base.link),
		mkdtemp: wrap("mkdtemp", base.mkdtemp),
		rmdir: wrap("rmdir", base.rmdir),
		readlink: wrap("readlink", base.readlink),
		symlink: wrap("symlink", base.symlink),
	}
}

async function setup(): Promise<{
	dir: string
	file: string
	id: { dev: number; ino: number }
}> {
	const root = await nodeFs.mkdtemp(path.join(tmpdir(), "wk-vunlink-"))
	roots.push(root)
	const dir = path.join(root, "rec")
	await nodeFs.mkdir(dir, { mode: 0o755 })
	const file = path.join(dir, NAME)
	await nodeFs.writeFile(file, "AUDIO")
	const st = await nodeFs.lstat(file)
	return { dir, file, id: { dev: st.dev, ino: st.ino } }
}

const privateDirs = async (dir: string): Promise<string[]> =>
	(await nodeFs.readdir(dir)).filter(n => RECORDING_DELETE_PRIVATE_DIR.test(n))

describe("verified unlink (WG10 progress names)", () => {
	it("deletes within the budget: 6 lstat, one rename pair, one unlink, named basename then verified", async () => {
		const s = await setup()
		const fs = countingFs()
		const { logger, lines } = quietLogger()
		await expect(
			verifiedUnlink({
				filePath: s.file,
				handleStat: s.id,
				stillDeletable: () => true,
				fs,
				log: logger,
			}),
		).resolves.toBe("deleted")
		expect(fs.count("lstat")).toBe(6)
		expect(fs.count("rename")).toBe(2)
		expect(fs.count("unlink")).toBe(1)
		expect(fs.count("mkdtemp")).toBe(1)
		expect(fs.count("rmdir")).toBe(1)
		const renames = fs.calls.filter(c => c.op === "rename")
		expect(renames[0]?.p).toBe(s.file)
		const moved = fs.calls.find(
			(c, i) => c.op === "lstat" && i > fs.calls.indexOf(renames[0] as Call),
		)
		expect(path.basename(moved?.p ?? "")).toBe(NAME)
		expect(path.basename(path.dirname(moved?.p ?? ""))).toMatch(
			RECORDING_DELETE_PRIVATE_DIR,
		)
		const unlinked = fs.calls.find(c => c.op === "unlink")?.p ?? ""
		expect(path.basename(unlinked)).toBe("verified")
		expect(path.basename(path.dirname(unlinked))).toMatch(
			RECORDING_DELETE_PRIVATE_DIR,
		)
		// The private directory is re-checked last, right before the unlink.
		const iUnlink = fs.calls.findIndex(c => c.op === "unlink")
		expect(fs.calls[iUnlink - 1]).toEqual({
			op: "lstat",
			p: path.dirname(unlinked),
		})
		await expect(nodeFs.lstat(s.file)).rejects.toMatchObject({
			code: "ENOENT",
		})
		expect(await privateDirs(s.dir)).toEqual([])
		expect(lines).toEqual([])
	})

	it("runs the decision and the unlink in one synchronous turn", async () => {
		const s = await setup()
		let decidedTurnOpen = false
		const order: string[] = []
		const fs = countingFs({
			unlink: p => {
				order.push(decidedTurnOpen ? "unlink-same-turn" : "unlink-later")
				return nodeFs.unlink(p)
			},
		})
		await verifiedUnlink({
			filePath: s.file,
			handleStat: s.id,
			stillDeletable: () => {
				decidedTurnOpen = true
				queueMicrotask(() => {
					decidedTurnOpen = false
				})
				order.push("decide")
				return true
			},
			fs,
			log: quietLogger().logger,
		})
		expect(order).toEqual(["decide", "decide", "unlink-same-turn"])
	})

	it("a decision false before the identity rename restores the file and never names it verified", async () => {
		const s = await setup()
		const fs = countingFs()
		await expect(
			verifiedUnlink({
				filePath: s.file,
				handleStat: s.id,
				stillDeletable: () => false,
				fs,
				log: quietLogger().logger,
			}),
		).resolves.toBe("protected")
		expect(fs.calls.some(c => c.p.endsWith("verified"))).toBe(false)
		expect(await nodeFs.readFile(s.file, "utf8")).toBe("AUDIO")
		expect((await nodeFs.lstat(s.file)).ino).toBe(s.id.ino)
		expect(await privateDirs(s.dir)).toEqual([])
	})

	it("a decision turning false at the unlink (Keep meanwhile) restores the verified file", async () => {
		const s = await setup()
		let n = 0
		const fs = countingFs()
		await expect(
			verifiedUnlink({
				filePath: s.file,
				handleStat: s.id,
				stillDeletable: () => ++n === 1,
				fs,
				log: quietLogger().logger,
			}),
		).resolves.toBe("protected")
		expect(fs.count("unlink")).toBe(1)
		expect(path.basename(fs.calls.find(c => c.op === "unlink")?.p ?? "")).toBe(
			"verified",
		)
		expect(await nodeFs.readFile(s.file, "utf8")).toBe("AUDIO")
		expect(await privateDirs(s.dir)).toEqual([])
	})

	it("a throwing decision is false (fail closed)", async () => {
		const s = await setup()
		await expect(
			verifiedUnlink({
				filePath: s.file,
				handleStat: s.id,
				stillDeletable: () => {
					throw new Error("boom")
				},
				log: quietLogger().logger,
			}),
		).resolves.toBe("protected")
		expect(await nodeFs.readFile(s.file, "utf8")).toBe("AUDIO")
	})

	it("a crash before the identity check leaves the entry under the recording's own name", async () => {
		const s = await setup()
		const fs = countingFs({
			lstat: async p => {
				if (path.basename(p) === NAME && p !== s.file)
					throw Object.assign(new Error("EIO"), { code: "EIO" })
				return nodeFs.lstat(p)
			},
		})
		await expect(
			verifiedUnlink({
				filePath: s.file,
				handleStat: s.id,
				stillDeletable: () => true,
				fs,
				log: quietLogger().logger,
			}),
		).rejects.toMatchObject({ code: "EIO" })
		const dirs = await privateDirs(s.dir)
		expect(dirs).toHaveLength(1)
		expect(await nodeFs.readdir(path.join(s.dir, dirs[0] ?? ""))).toEqual([
			NAME,
		])
	})

	it("a crash at the unlink leaves exactly `verified`", async () => {
		const s = await setup()
		const fs = countingFs({
			unlink: () =>
				Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" })),
		})
		await expect(
			verifiedUnlink({
				filePath: s.file,
				handleStat: s.id,
				stillDeletable: () => true,
				fs,
				log: quietLogger().logger,
			}),
		).rejects.toMatchObject({ code: "EIO" })
		const dirs = await privateDirs(s.dir)
		expect(dirs).toHaveLength(1)
		expect(await nodeFs.readdir(path.join(s.dir, dirs[0] ?? ""))).toEqual([
			"verified",
		])
	})

	it("a vanished path answers not-found with nothing created", async () => {
		const s = await setup()
		await nodeFs.unlink(s.file)
		const fs = countingFs()
		await expect(
			verifiedUnlink({
				filePath: s.file,
				handleStat: s.id,
				stillDeletable: () => true,
				fs,
				log: quietLogger().logger,
			}),
		).resolves.toBe("not-found")
		expect(fs.count("mkdtemp")).toBe(0)
	})

	it("a file swapped after the identity check (at the verified rename) is put back, not unlinked", async () => {
		const s = await setup()
		const other = path.join(path.dirname(s.dir), "other.wav")
		await nodeFs.writeFile(other, "OTHER")
		// A hard link keeps the original inode allocated, so the swapped-in copy can never
		// reuse its number (ext4 reuses a freed inode at once, which made the swap invisible).
		const held = path.join(path.dirname(s.dir), "held.wav")
		const fs = countingFs({
			rename: async (a, b) => {
				if (path.basename(b) === "verified") {
					await nodeFs.link(a, held)
					await nodeFs.unlink(a)
					await nodeFs.copyFile(other, a)
				}
				return nodeFs.rename(a, b)
			},
		})
		const { logger, lines } = quietLogger()
		await expect(
			verifiedUnlink({
				filePath: s.file,
				handleStat: s.id,
				stillDeletable: () => true,
				fs,
				log: logger,
			}),
		).resolves.toBe("not-found")
		expect(fs.count("unlink")).toBe(1)
		expect(await nodeFs.readFile(s.file, "utf8")).toBe("OTHER")
		expect(await privateDirs(s.dir)).toEqual([])
		expect(JSON.stringify(lines)).not.toContain(NAME)
		expect(JSON.stringify(lines)).not.toContain(s.dir)
	})

	it("a group-writable parent without sticky bit refuses before anything moves", async () => {
		const s = await setup()
		await nodeFs.chmod(s.dir, 0o775)
		const fs = countingFs()
		await expect(
			verifiedUnlink({
				filePath: s.file,
				handleStat: s.id,
				stillDeletable: () => true,
				fs,
				log: quietLogger().logger,
			}),
		).rejects.toMatchObject({ code: "RECORDING_DELETE_FAILED" })
		expect(fs.count("mkdtemp") + fs.count("rename")).toBe(0)
	})
})
