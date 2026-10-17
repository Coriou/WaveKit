/**
 * WG10 RK2 property 1 over the real keep service, the real deleter and the real verified unlink,
 * on an in-memory filesystem whose calls resolve in an order fast-check schedules, with an
 * adversary swapping files, folders and ancestors at a random call.
 */
import { readFileSync } from "node:fs"
import * as nodeFs from "node:fs/promises"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type {
	OpenedRecording,
	RecordingInventory,
} from "../../../../src/core/recordings/inventory.js"
import { openRecordingKeepService } from "../../../../src/core/recordings/keep-service.js"
import { nodeRecordingKeepsFs } from "../../../../src/core/recordings/keep-store.js"
import type { RecordingKeepsFs } from "../../../../src/core/recordings/keep-store.js"
import { verifiedUnlink } from "../../../../src/core/recordings/verified-unlink.js"
import type { RecordingDeleteFs } from "../../../../src/core/recordings/verified-unlink.js"
import { createScannerRecordingDeleter } from "../../../../src/core/scanner/recording-delete.js"
import type { Logger } from "../../../../src/utils/logger.js"

const D = "d_P1"
const ROOT = "/s"
const DV = `${ROOT}/recordings/dv`
const DIR = `${DV}/${D}`
const FILES = ["a.wav", "b.wav", "c.wav"] as const

interface Node {
	kind: "file" | "dir" | "link"
	ino: number
	target?: string
}

class FsError extends Error {
	constructor(readonly code: string) {
		super(code)
	}
}

/** Paths are canonical (no symlink component); intermediate symlinks are followed on access. */
class MemFs {
	readonly nodes = new Map<string, Node>()
	readonly links = new Map<number, number>()
	private nextIno = 1
	private tmp = 0
	onDestroy: (ino: number) => void = () => undefined

	constructor() {
		for (const p of ["/", ROOT, `${ROOT}/recordings`, DV, DIR]) this.mkdir(p)
	}
	mkdir(p: string): void {
		this.nodes.set(p, { kind: "dir", ino: this.nextIno++ })
	}
	writeFile(p: string): number {
		const ino = this.nextIno++
		this.nodes.set(p, { kind: "file", ino })
		this.links.set(ino, 1)
		return ino
	}
	private parentOf(p: string): string {
		const i = p.lastIndexOf("/")
		return i <= 0 ? "/" : p.slice(0, i)
	}
	/** Resolves every component but the last. */
	resolve(p: string, depth = 0): string {
		if (depth > 8) throw new FsError("ELOOP")
		const parts = p.split("/").filter(Boolean)
		let cur = ""
		for (let i = 0; i < parts.length - 1; i++) {
			const next = `${cur}/${parts[i] ?? ""}`
			const n = this.nodes.get(next)
			if (!n) throw new FsError("ENOENT")
			if (n.kind === "link") cur = this.follow(n.target ?? "", depth + 1)
			else if (n.kind === "dir") cur = next
			else throw new FsError("ENOTDIR")
		}
		return `${cur}/${parts.at(-1) ?? ""}`
	}
	private follow(p: string, depth: number): string {
		const r = this.resolve(p, depth)
		const n = this.nodes.get(r)
		if (n?.kind === "link") return this.follow(n.target ?? "", depth + 1)
		if (!n) throw new FsError("ENOENT")
		return r
	}
	private hasChildren(p: string): boolean {
		for (const k of this.nodes.keys()) if (k.startsWith(`${p}/`)) return true
		return false
	}
	private drop(p: string): void {
		const n = this.nodes.get(p)
		this.nodes.delete(p)
		if (n?.kind !== "file") return
		const left = (this.links.get(n.ino) ?? 1) - 1
		this.links.set(n.ino, left)
		if (left === 0) this.onDestroy(n.ino)
	}
	lstat(p: string) {
		const n = this.nodes.get(this.resolve(p))
		if (!n) throw new FsError("ENOENT")
		return {
			dev: 1,
			ino: n.ino,
			mode: n.kind === "dir" ? 0o40755 : 0o100644,
			isFile: () => n.kind === "file",
			isDirectory: () => n.kind === "dir",
			isSymbolicLink: () => n.kind === "link",
		}
	}
	openNoFollow(p: string): { dev: number; ino: number } {
		const n = this.nodes.get(this.resolve(p))
		if (!n) throw new FsError("ENOENT")
		if (n.kind === "link") throw new FsError("ELOOP")
		if (n.kind !== "file") throw new FsError("EISDIR")
		return { dev: 1, ino: n.ino }
	}
	unlink(p: string): void {
		const r = this.resolve(p)
		const n = this.nodes.get(r)
		if (!n) throw new FsError("ENOENT")
		if (n.kind === "dir") throw new FsError("EPERM")
		this.drop(r)
	}
	rename(a: string, b: string): void {
		const ra = this.resolve(a)
		const rb = this.resolve(b)
		const src = this.nodes.get(ra)
		if (!src) throw new FsError("ENOENT")
		if (this.nodes.get(this.parentOf(rb))?.kind !== "dir")
			throw new FsError("ENOENT")
		if (ra === rb) return
		const dst = this.nodes.get(rb)
		if (dst) {
			if (dst.kind === "dir") {
				if (src.kind !== "dir") throw new FsError("EISDIR")
				if (this.hasChildren(rb)) throw new FsError("ENOTEMPTY")
			} else if (src.kind === "dir") throw new FsError("ENOTDIR")
			this.drop(rb)
		}
		const moves: [string, Node][] = []
		for (const [k, v] of this.nodes)
			if (k === ra || k.startsWith(`${ra}/`)) moves.push([k, v])
		for (const [k] of moves) this.nodes.delete(k)
		for (const [k, v] of moves) this.nodes.set(rb + k.slice(ra.length), v)
	}
	link(a: string, b: string): void {
		const src = this.nodes.get(this.resolve(a))
		const rb = this.resolve(b)
		if (!src) throw new FsError("ENOENT")
		if (src.kind !== "file") throw new FsError("EPERM")
		if (this.nodes.has(rb)) throw new FsError("EEXIST")
		this.nodes.set(rb, src)
		this.links.set(src.ino, (this.links.get(src.ino) ?? 0) + 1)
	}
	mkdtemp(prefix: string): string {
		const r = this.resolve(`${prefix}XXXXXX`)
		const p = `${r.slice(0, -6)}${String(this.tmp++).padStart(6, "0")}`
		if (this.nodes.get(this.parentOf(p))?.kind !== "dir")
			throw new FsError("ENOENT")
		this.mkdir(p)
		return p
	}
	rmdir(p: string): void {
		const r = this.resolve(p)
		const n = this.nodes.get(r)
		if (!n) throw new FsError("ENOENT")
		if (n.kind !== "dir") throw new FsError("ENOTDIR")
		if (this.hasChildren(r)) throw new FsError("ENOTEMPTY")
		this.nodes.delete(r)
	}
	readlink(p: string): string {
		const n = this.nodes.get(this.resolve(p))
		if (n?.kind !== "link") throw new FsError("EINVAL")
		return n.target ?? ""
	}
	symlink(target: string, p: string): void {
		const r = this.resolve(p)
		if (this.nodes.has(r)) throw new FsError("EEXIST")
		this.nodes.set(r, { kind: "link", ino: this.nextIno++, target })
	}
}

type Swap = "file" | "folder" | "ancestor" | "symlink-file"
type Op = { kind: "keep" | "unkeep" | "delete" | "retention"; file: number }

const quiet = (): Logger => {
	const l: Record<string, unknown> = {}
	for (const level of ["warn", "info", "debug", "error", "trace", "fatal"])
		l[level] = vi.fn()
	l["child"] = () => l
	return l as unknown as Logger
}

/** Keys in the committed store file (updated as each atomic rename lands). */
let committed = new Set<string>()
/** The real store files without fsync (speed only; durability is not under test here). */
const storeFs: RecordingKeepsFs = {
	...nodeRecordingKeepsFs,
	rename: async (a, b) => {
		await nodeFs.rename(a, b)
		const text = readFileSync(String(b), "utf8")
		const file = JSON.parse(text) as { keeps: { key: string }[] }
		committed = new Set(file.keeps.map(k => k.key))
	},
	open: (async (...args: Parameters<typeof nodeFs.open>) => {
		const h = await nodeFs.open(...args)
		h.sync = () => Promise.resolve()
		return h
	}) as typeof nodeFs.open,
}

let base = ""
let runN = 0
beforeAll(async () => {
	base = await mkdtemp(join(tmpdir(), "wk-p1-"))
})
afterAll(async () => {
	await rm(base, { recursive: true, force: true })
})

describe("scanner delete property", () => {
	// Feature: web-gaps-10, Property 1: No scanner delete of a kept or unverified file
	// Validates: Requirements 1.1, 1.2, 1.3
	it("never unlinks a kept or unverified file and forgets exactly the deleted ids", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.scheduler(),
				fc.array(
					fc.record({
						kind: fc.constantFrom(
							"keep" as const,
							"unkeep" as const,
							"delete" as const,
							"retention" as const,
						),
						file: fc.integer({ min: 0, max: FILES.length - 1 }),
					}),
					{ minLength: 1, maxLength: 8 },
				),
				fc.subarray([0, 1, 2]),
				fc.array(
					fc.record({
						kind: fc.constantFrom<Swap>(
							"file",
							"folder",
							"ancestor",
							"symlink-file",
						),
						at: fc.integer({ min: 0, max: 20 }),
						file: fc.integer({ min: 0, max: FILES.length - 1 }),
					}),
					{ maxLength: 3 },
				),
				async (s, ops: Op[], preKept, swaps) => {
					const fs = new MemFs()
					const original = new Map<string, number>()
					for (const f of FILES) original.set(f, fs.writeFile(`${DIR}/${f}`))
					const ids = new Map<string, boolean>(
						FILES.map(f => [`${D}~${f}`, true]),
					)
					let count: number = FILES.length
					committed = new Set()
					/** Files whose key was committed kept when a delete or retention destroyed them. */
					const keptDestroyed: string[] = []
					/** inode → file a delete verified it as (by its verified open). */
					const verifiedOpen = new Map<number, string>()
					const destroyed: { ino: number; by: string }[] = []
					let destroyer = "attacker"
					fs.onDestroy = ino => {
						destroyed.push({ ino, by: destroyer })
						if (destroyer === "attacker") return
						const file =
							destroyer === "retention"
								? retentionFile
								: (destroyer.split(":")[1] ?? "")
						if (committed.has(`scan:${D}~${file}`)) keptDestroyed.push(file)
					}
					let retentionFile = ""
					let calls = 0
					let armed = false
					const adversary = (): void => {
						if (!armed) return
						const at = calls++
						for (const [n, sw] of swaps.entries())
							if (sw.at === at) swapOnce(sw.kind, FILES[sw.file] ?? "a.wav", n)
					}
					const swapOnce = (swap: Swap, f: string, n: number): void => {
						const prev = destroyer
						destroyer = "attacker"
						try {
							if (swap === "file") {
								fs.rename(`${DIR}/${f}`, `${ROOT}/stash-${n}`)
								fs.writeFile(`${DIR}/${f}`)
							} else if (swap === "symlink-file") {
								fs.rename(`${DIR}/${f}`, `${ROOT}/stash-${n}`)
								fs.symlink(`${ROOT}/stash-${n}`, `${DIR}/${f}`)
							} else if (swap === "folder") {
								fs.rename(DIR, `${ROOT}/moved-${n}`)
								fs.mkdir(DIR)
								for (const g of FILES) fs.writeFile(`${DIR}/${g}`)
							} else {
								fs.rename(DV, `${ROOT}/dv-real-${n}`)
								fs.symlink(`${ROOT}/dv-real-${n}`, DV)
							}
						} catch {
							// The swap target is gone already: nothing to swap.
						} finally {
							destroyer = prev
						}
					}
					/** Runs the op synchronously, delivers its result when the scheduler says. */
					const call = async <T>(fn: () => T): Promise<T> => {
						adversary()
						let out: { ok: T } | { err: unknown }
						try {
							out = { ok: fn() }
						} catch (err) {
							out = { err }
						}
						await s.schedule(Promise.resolve())
						if ("err" in out) throw out.err
						return out.ok
					}
					const deleteFs: RecordingDeleteFs = {
						lstat: p => call(() => fs.lstat(p)),
						unlink: p => call(() => fs.unlink(p)),
						rename: (a, b) => call(() => fs.rename(a, b)),
						link: (a, b) => call(() => fs.link(a, b)),
						mkdtemp: p => call(() => fs.mkdtemp(p)),
						rmdir: p => call(() => fs.rmdir(p)),
						readlink: p => call(() => fs.readlink(p)),
						symlink: (t, p) => call(() => fs.symlink(t, p)),
					}
					const serial = new Map<string, Promise<unknown>>()
					const evidence = {
						deleteRecording: async (
							recordingId: string,
							stillDeletable: () => boolean,
						): Promise<"deleted" | "not-found"> => {
							const file = recordingId.split("~")[1] ?? ""
							const prev = serial.get(D) ?? Promise.resolve()
							const run = prev.then(async () => {
								// Chain from the root: every directory real (no symlink).
								for (const p of [`${ROOT}/recordings`, DV, DIR]) {
									const st = await call(() => fs.lstat(p)).catch(() => null)
									if (!st?.isDirectory() || st.isSymbolicLink())
										return "not-found" as const
								}
								let opened: { dev: number; ino: number }
								try {
									opened = await call(() => fs.openNoFollow(`${DIR}/${file}`))
								} catch {
									return "not-found" as const
								}
								verifiedOpen.set(opened.ino, file)
								const prevDestroyer = destroyer
								destroyer = `delete:${file}:${opened.ino}`
								try {
									const r = await verifiedUnlink({
										filePath: `${DIR}/${file}`,
										handleStat: opened,
										stillDeletable,
										fs: deleteFs,
										log: quiet(),
									})
									return r === "deleted"
										? ("deleted" as const)
										: ("not-found" as const)
								} finally {
									destroyer = prevDestroyer
								}
							})
							serial.set(
								D,
								run.catch(() => undefined),
							)
							return run
						},
					}
					const discovery = {
						forgetRecording: (id: string): boolean => {
							if (ids.get(id) !== true) return false
							ids.set(id, false)
							count = Math.max(0, count - 1)
							return true
						},
					}
					const inventory: RecordingInventory = {
						list: () => Promise.reject(new Error("unused")),
						resolve: () => Promise.resolve(null),
						open: async id => {
							const file = id.split("~")[1] ?? ""
							let st: { dev: number; ino: number }
							try {
								st = await call(() => fs.openNoFollow(`${DIR}/${file}`))
							} catch {
								return null
							}
							return {
								name: file,
								path: `${DIR}/${file}`,
								stat: { ...st, size: 100, mtimeMs: 0 },
								handle: {
									close: async () => undefined,
									stat: async () => ({ ...st, size: 100 }),
								},
							} as unknown as OpenedRecording
						},
						invalidate: () => undefined,
					}
					const stateDir = join(base, `r${runN++}`)
					await mkdir(stateDir)
					const svc = await openRecordingKeepService({
						stateDir,
						inventory,
						storeFs,
						logger: quiet(),
						scannerDeleter: createScannerRecordingDeleter({
							evidence,
							discovery,
							logger: quiet(),
						}),
					})
					for (const i of preKept) {
						const f = FILES[i] ?? "a.wav"
						const pending = svc.keep(`scan:${D}~${f}`)
						await s.waitFor(pending)
					}
					armed = true
					const deletedFiles: string[] = []
					const runs = ops.map(async op => {
						const f = FILES[op.file] ?? "a.wav"
						const id = `scan:${D}~${f}`
						try {
							if (op.kind === "keep") {
								await svc.keep(id)
							} else if (op.kind === "unkeep") {
								await svc.unkeep(id)
							} else if (op.kind === "delete") {
								await svc.remove(id)
								deletedFiles.push(f)
							} else {
								// Retention: the per-file decision and the unlink in one turn.
								await s.schedule(Promise.resolve())
								if (!svc.isScannerFileProtected(D, f)) {
									const prev = destroyer
									destroyer = "retention"
									retentionFile = f
									try {
										fs.unlink(`${DIR}/${f}`)
									} catch {
										// Gone already.
									} finally {
										destroyer = prev
									}
								}
							}
						} catch {
							// Refusals (409, 404, 503) are allowed outcomes.
						}
					})
					await s.waitFor(Promise.all(runs))
					// 1. No file of a committed kept key is unlinked by a delete or retention.
					expect(keptDestroyed).toEqual([])
					// 2. A delete unlinks only the inode its verified open found.
					const byDelete = destroyed.filter(d => d.by.startsWith("delete:"))
					for (const d of byDelete)
						expect(d.by).toBe(
							`delete:${verifiedOpen.get(d.ino) ?? "?"}:${d.ino}`,
						)
					// 3. A delete that answered deleted destroyed exactly its file, once.
					expect(byDelete.map(d => d.by.split(":")[1]).sort()).toEqual(
						[...deletedFiles].sort(),
					)
					// 4. The bookkeeping lost exactly the deleted ids (a file swapped in under a
					// deleted name can be deleted again; its id is forgotten once).
					for (const f of FILES)
						expect(ids.get(`${D}~${f}`)).toBe(!deletedFiles.includes(f))
					expect(count).toBe(FILES.length - new Set(deletedFiles).size)
					await svc.close()
				},
			),
			{ numRuns: 100 },
		)
	}, 30_000)
})
