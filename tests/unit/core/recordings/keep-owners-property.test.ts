import fc from "fast-check"
import type * as NodeFs from "node:fs"
import { afterEach, expect, it, vi } from "vitest"

import type { RecordingInventory } from "../../../../src/core/recordings/inventory.js"
import { openRecordingKeepService } from "../../../../src/core/recordings/keep-service.js"
import type { RecordingDeleteFs } from "../../../../src/core/recordings/keep-service.js"
import { parseRecordingKeepsFile } from "../../../../src/core/recordings/keep-store.js"
import type { RecordingKeepsFs } from "../../../../src/core/recordings/keep-store.js"
import type { Logger } from "../../../../src/utils/logger.js"

/**
 * One in-memory world behind every owner: the recordings directory `/rec` (entries carry an
 * inode; a swap replaces the inode under the same name) and the keep store file. The real
 * pruner reads it through the mocked `node:fs` promises, the real keep service through its
 * `deleteFs`, `storeFs` and inventory seams. Every seam call first awaits the fast-check
 * scheduler, so the owners interleave at every await point.
 */
const world = vi.hoisted(() => {
	interface Entry {
		ino: number
		size: number
		link: boolean
		/** The call name the inode was created under (survives the private rename). */
		origin: string
	}
	const state = {
		rec: new Map<string, Entry>(),
		/** Private delete directories (relative to `/rec`). */
		dirs: new Set<string>(),
		store: new Map<string, Buffer>(),
		nextIno: 1,
		failStore: false,
		/** Inodes an inventory open verified (the only ones a delete may unlink). */
		opened: new Set<number>(),
		violations: [] as string[],
		/** Kept keys per the store file on "disk" (the committed truth). */
		keptOnDisk: (): Set<string> => new Set(),
		yieldPoint: async (_label: string): Promise<void> => undefined,
	}
	const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1)
	const err = (code: string): Error => Object.assign(new Error(code), { code })
	const pruner = {
		readdir: async (): Promise<string[]> => {
			await state.yieldPoint("prune:readdir")
			return [
				...[...state.rec.keys()].filter(k => !k.includes("/")),
				...state.dirs,
			]
		},
		stat: async (p: string) => {
			await state.yieldPoint("prune:stat")
			const e = state.rec.get(base(p))
			if (!e) throw err("ENOENT")
			return {
				isFile: () => !e.link,
				size: e.size,
				mtimeMs: 0,
			}
		},
		unlink: async (p: string): Promise<void> => {
			await state.yieldPoint("prune:unlink")
			const name = base(p)
			if (state.keptOnDisk().has(`dsd~${name}`))
				state.violations.push(`pruner unlinked a kept file ${name}`)
			if (!state.rec.delete(name)) throw err("ENOENT")
		},
	}
	return { state, pruner, base, err }
})

vi.mock("node:fs", async importOriginal => {
	const real = await importOriginal<typeof NodeFs>()
	return {
		...real,
		promises: world.pruner,
		default: { ...real, promises: world.pruner },
	}
})

const { pruneCallRecordings, setCallRecordingProtection } =
	await import("../../../../src/decoders/builtin/call-recordings.js")

const NOW = 1_800_000_000_000
const N = 5
const nameOf = (i: number): string =>
	`20261001_0101${String(i).padStart(2, "0")}_${String(i).padStart(5, "0")}_1_GROUP_TGT_9_SRC_${i}.wav`
const idOf = (i: number): string => `dsd:0~${nameOf(i)}`

const silent: Logger = (() => {
	const l: Record<string, unknown> = {}
	for (const k of ["warn", "info", "debug", "error", "trace", "fatal"])
		l[k] = () => undefined
	l["child"] = () => l
	return l as unknown as Logger
})()

const { state, base, err } = world

const storeFs = {
	open: async (p: string, flags: unknown) => {
		await state.yieldPoint("store:open")
		if (flags === "r")
			return { sync: async () => undefined, close: async () => undefined }
		if (flags === "wx") {
			if (state.store.has(p)) throw err("EEXIST")
			state.store.set(p, Buffer.alloc(0))
			return {
				writeFile: async (body: string) => {
					await state.yieldPoint("store:write")
					state.store.set(p, Buffer.from(body, "utf8"))
				},
				sync: async () => undefined,
				close: async () => undefined,
			}
		}
		const c = state.store.get(p)
		if (c === undefined) throw err("ENOENT")
		return {
			stat: async () => ({ isFile: () => true, size: c.length }),
			read: async (buf: Buffer, off: number, len: number, pos: number) => {
				const n = Math.max(0, Math.min(len, c.length - pos))
				c.copy(buf, off, pos, pos + n)
				return { bytesRead: n }
			},
			close: async () => undefined,
		}
	},
	rename: async (a: string, b: string) => {
		await state.yieldPoint("store:rename")
		if (state.failStore) throw err("EIO")
		const c = state.store.get(a)
		if (c === undefined) throw err("ENOENT")
		state.store.delete(a)
		state.store.set(b, c)
	},
	unlink: async (p: string) => {
		if (!state.store.delete(p)) throw err("ENOENT")
	},
	readdir: async () => [...state.store.keys()].map(base),
	lstat: async () => {
		throw err("ENOENT")
	},
	mkdir: async () => undefined,
} as unknown as RecordingKeepsFs

state.keptOnDisk = () => {
	const c = state.store.get("/state/recording-keeps.json")
	if (c === undefined) return new Set()
	const f = parseRecordingKeepsFile(c.toString("utf8"))
	return new Set(f?.keeps.map(e => e.key) ?? [])
}

const fileId = (e: { ino: number; link: boolean }) => ({
	dev: 1,
	ino: e.ino,
	isFile: () => !e.link,
	isSymbolicLink: () => e.link,
})

/** The model key of a delete path: relative to `/rec`, so private directories nest. */
const rel = (p: string): string => (p.startsWith("/rec/") ? p.slice(5) : p)
let nextDir = 0

const deleteFs: RecordingDeleteFs = {
	lstat: async p => {
		await state.yieldPoint("delete:lstat")
		const e = state.rec.get(rel(p))
		if (!e) throw err("ENOENT")
		return fileId(e)
	},
	mkdtemp: async prefix => {
		await state.yieldPoint("delete:mkdtemp")
		const d = `${prefix}${nextDir++}`
		state.dirs.add(rel(d))
		return d
	},
	rmdir: async p => {
		await state.yieldPoint("delete:rmdir")
		const d = rel(p)
		if (!state.dirs.has(d)) throw err("ENOENT")
		if ([...state.rec.keys()].some(k => k.startsWith(`${d}/`)))
			throw err("ENOTEMPTY")
		state.dirs.delete(d)
	},
	rename: async (a, b) => {
		await state.yieldPoint("delete:rename")
		const e = state.rec.get(rel(a))
		if (!e) throw err("ENOENT")
		state.rec.delete(rel(a))
		state.rec.set(rel(b), e)
	},
	link: async (a, b) => {
		await state.yieldPoint("delete:link")
		const e = state.rec.get(rel(a))
		if (!e) throw err("ENOENT")
		if (state.rec.has(rel(b))) throw err("EEXIST")
		state.rec.set(rel(b), e)
	},
	readlink: async p => {
		await state.yieldPoint("delete:readlink")
		const e = state.rec.get(rel(p))
		if (!e) throw err("ENOENT")
		if (!e.link) throw err("EINVAL")
		return `ino:${e.ino}`
	},
	symlink: async (target, p) => {
		await state.yieldPoint("delete:symlink")
		if (state.rec.has(rel(p))) throw err("EEXIST")
		// Modelled as the same entry: a symlink recreated with the same target.
		const moved = [...state.rec.values()].find(
			e => e.link && `ino:${e.ino}` === target,
		)
		if (!moved) throw err("ENOENT")
		state.rec.set(rel(p), moved)
	},
	unlink: async p => {
		await state.yieldPoint("delete:unlink")
		const e = state.rec.get(rel(p))
		if (!e) throw err("ENOENT")
		state.rec.delete(rel(p))
		// A violation is an inode losing its LAST name when it is not the verified inode; a foreign
		// inode restored under its original name and then unlinked from the private name is fine.
		const stillNamed = [...state.rec.values()].includes(e)
		if (!stillNamed && (!state.opened.has(e.ino) || e.link))
			state.violations.push("delete unlinked an unverified inode")
		if (!stillNamed && state.keptOnDisk().has(`dsd~${e.origin}`))
			state.violations.push(`delete unlinked a kept file ${e.origin}`)
	},
}

const inventory: RecordingInventory = {
	list: async () => ({ items: [] }) as never,
	resolve: async () => null,
	open: async id => {
		await state.yieldPoint("inventory:open")
		const name = id.slice(id.indexOf("~") + 1)
		const e = state.rec.get(name)
		if (!e || e.link) return null
		const ino = e.ino
		state.opened.add(ino)
		const stat = { dev: 1, ino, size: e.size, isFile: () => true }
		return {
			name,
			path: `/rec/${name}`,
			stat: stat as never,
			handle: {
				stat: async () => stat as never,
				close: async () => {
					await state.yieldPoint("inventory:close")
				},
			} as never,
		}
	},
	invalidate: () => undefined,
}

type Op =
	| { t: "keep" | "unkeep" | "remove"; i: number }
	| { t: "prune"; mb: number }
	| { t: "swap"; i: number; link: boolean }
	| { t: "failStore"; on: boolean }

afterEach(() => {
	setCallRecordingProtection(null)
})

// Feature: web-gaps-9, Property 4: No owner deletes a kept file
// Validates: Requirements 2.5, 2.7, 2.8
it("no interleaving of Keep, unkeep, delete, store failure, swaps and the pruner unlinks a kept file", async () => {
	const idx = fc.integer({ min: 0, max: N - 1 })
	const op: fc.Arbitrary<Op> = fc.oneof(
		fc.record({
			t: fc.constantFrom("keep" as const, "unkeep" as const, "remove" as const),
			i: idx,
		}),
		fc.record({
			t: fc.constant("prune" as const),
			mb: fc.constantFrom(0, 0.002, 1),
		}),
		fc.record({ t: fc.constant("swap" as const), i: idx, link: fc.boolean() }),
		fc.record({ t: fc.constant("failStore" as const), on: fc.boolean() }),
	)
	await fc.assert(
		fc.asyncProperty(
			fc.scheduler(),
			fc.uniqueArray(idx, { maxLength: N }),
			fc.array(op, { minLength: 1, maxLength: 10 }),
			async (s, preKept, ops) => {
				state.rec.clear()
				state.dirs.clear()
				state.store.clear()
				state.opened.clear()
				state.violations = []
				state.failStore = false
				state.yieldPoint = async () => undefined
				for (let i = 0; i < N; i++)
					state.rec.set(nameOf(i), {
						ino: state.nextIno++,
						size: 1000,
						link: false,
						origin: nameOf(i),
					})
				const svc = await openRecordingKeepService({
					stateDir: "/state",
					inventory,
					logger: silent,
					storeFs,
					deleteFs,
					now: () => NOW,
				})
				for (const i of preKept) await svc.keep(idOf(i))
				setCallRecordingProtection(svc)
				state.yieldPoint = label => s.schedule(Promise.resolve(), label)

				const keptOk = new Set<number>(preKept)
				const unkeepIdx = new Set(
					ops.flatMap(o => (o.t === "unkeep" ? [o.i] : [])),
				)
				const removes: Array<{ i: number; r: Promise<unknown> }> = []
				const run = ops.map(async o => {
					await s.schedule(Promise.resolve(), `start:${o.t}`)
					switch (o.t) {
						case "keep":
							await svc.keep(idOf(o.i)).then(
								() => keptOk.add(o.i),
								() => undefined,
							)
							return
						case "unkeep":
							await svc.unkeep(idOf(o.i)).catch(() => undefined)
							return
						case "remove": {
							const r = svc.remove(idOf(o.i))
							removes.push({ i: o.i, r })
							await r.catch(() => undefined)
							return
						}
						case "prune":
							await pruneCallRecordings(
								["/rec"],
								{ maxTotalMb: o.mb, maxAgeHours: 1 },
								NOW,
							)
							return
						case "swap": {
							const name = nameOf(o.i)
							if (state.rec.has(name))
								state.rec.set(name, {
									ino: state.nextIno++,
									size: 1000,
									link: o.link,
									origin: name,
								})
							return
						}
						case "failStore":
							state.failStore = o.on
							return
					}
				})
				await s.waitFor(Promise.allSettled(run))
				state.yieldPoint = async () => undefined

				expect(state.violations).toEqual([])
				// A key kept before the run with no unkeep anywhere: delete refused, file still there.
				for (const { i, r } of removes)
					if (preKept.includes(i) && !unkeepIdx.has(i))
						await expect(r).rejects.toMatchObject({ code: "RECORDING_KEPT" })
				// Every successful Keep with no unkeep anywhere in the run left its name in place.
				for (const i of keptOk)
					if (!unkeepIdx.has(i)) expect(state.rec.has(nameOf(i))).toBe(true)
				await svc.close()
			},
		),
		{ numRuns: 150 },
	)
}, 20_000)
