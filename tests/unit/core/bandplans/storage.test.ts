import { spawn } from "node:child_process"
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { BANDPLANS_LIMITS } from "@wavekit/api-types"
import fc from "fast-check"
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest"
import { mountFastTemp } from "../../../helpers/bandplans/temp-volume.js"
import type { FastTemp } from "../../../helpers/bandplans/temp-volume.js"
import { BandPlanStorage } from "../../../../src/core/bandplans/storage.js"
import type { StorageStage } from "../../../../src/core/bandplans/storage.js"

const roots: string[] = []
const stores: BandPlanStorage[] = []
let volume: FastTemp | undefined
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(
		stores.splice(0).map(store => store.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})
async function root() {
	if (!volume) throw new Error("temp volume is not mounted")
	const path = await volume.mkdtemp("wavekit-bandplans-storage-")
	roots.push(path)
	return path
}
async function open(
	stateDir: string,
	stage?: (
		stage: StorageStage,
		phase: "before" | "after",
	) => void | Promise<void>,
) {
	const store = await BandPlanStorage.open({
		stateDir,
		...(stage ? { stage } : {}),
	})
	stores.push(store)
	return store
}
const file = (path: string) => join(path, "bandplans", "state.json")
const lock = (path: string) => join(path, "bandplans", ".writer-lock")
const unavailable = {
	code: "BANDPLANS_UNAVAILABLE",
	message: "Band-plan storage is unavailable.",
}
function gate() {
	let release!: () => void
	const promise = new Promise<void>(resolve => {
		release = resolve
	})
	return { promise, release }
}
const preStages: StorageStage[] = [
	"temp-open",
	"temp-write",
	"temp-sync",
	"temp-close",
	"rename",
]

describe("band plan storage", { timeout: 60_000 }, () => {
	beforeAll(() => {
		volume = mountFastTemp()
	})
	afterAll(() => {
		volume?.destroy()
	})
	it("durably initializes once, syncs the parent on every open, and returns detached snapshots", async () => {
		const path = await root()
		const stages: string[] = []
		const observe = (stage: StorageStage, phase: string) => {
			stages.push(`${stage}:${phase}`)
		}
		const first = await open(path, observe)
		const initial = first.snapshot()
		expect(initial).toMatchObject({
			version: 1,
			revision: 0,
			stack: null,
			importedPacks: [],
			operatorBands: [],
			edits: [],
			presets: [],
		})
		expect((await lstat(join(path, "bandplans"))).mode & 0o777).toBe(0o700)
		expect((await lstat(file(path))).mode & 0o777).toBe(0o600)
		expect(stages.indexOf("parent-sync:after")).toBeLessThan(
			stages.indexOf("temp-open:before"),
		)
		expect(stages.indexOf("temp-sync:after")).toBeLessThan(
			stages.indexOf("rename:before"),
		)
		expect(stages.at(-1)).toBe("directory-sync:after")
		initial.revision = 7
		expect(first.snapshot().revision).toBe(0)
		await first.close()
		stages.length = 0
		const second = await open(path, observe)
		expect(second.snapshot().storeId).toBe(initial.storeId)
		expect(stages).toContain("parent-sync:after")
		expect(stages).not.toContain("temp-open:before")
		expect(stages.indexOf("read-close:after")).toBeLessThan(
			stages.indexOf("directory-sync:before"),
		)
		expect(stages.at(-1)).toBe("directory-sync:after")
	})

	// Feature: band-plans, Property 8: Durability and latch
	// Validates: Requirements 8.1, 8.3
	it("restores the exact committed state over 100 real-directory restarts", async () => {
		const path = await root()
		await writeFile(
			join(path, "bandplans", ".state-leftover.tmp"),
			"ignored",
		).catch(() => undefined)
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 0, max: 100000 }), async revision => {
				const first = await open(path)
				const next = { ...first.snapshot(), revision }
				await first.persist(next)
				await first.close()
				await writeFile(
					join(path, "bandplans", ".state-leftover.tmp"),
					"ignored",
				)
				const second = await open(path)
				expect(second.snapshot()).toEqual(next)
				await second.close()
			}),
			{ numRuns: 100 },
		)
	})

	it.each(["corrupt", "future", "oversize", "empty"])(
		"preserves %s state unchanged and releases its own lock",
		async kind => {
			const path = await root()
			const first = await open(path)
			const initial = first.snapshot()
			await first.close()
			const bytes =
				kind === "future"
					? JSON.stringify({ ...initial, version: 2 })
					: kind === "oversize"
						? "x".repeat(BANDPLANS_LIMITS.stateBytes + 1)
						: kind === "empty"
							? ""
							: "{bad"
			await writeFile(file(path), bytes)
			await expect(open(path)).rejects.toMatchObject(unavailable)
			expect(await readFile(file(path), "utf8")).toBe(bytes)
			await expect(lstat(lock(path))).rejects.toMatchObject({ code: "ENOENT" })
		},
	)

	it("rejects another opener and a crash lock without stealing it", async () => {
		const path = await root()
		const first = await open(path)
		await expect(open(path)).rejects.toMatchObject(unavailable)
		const exit = await new Promise<number | null>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					'import {mkdir} from "node:fs/promises"; try {await mkdir(process.argv[1]); process.exitCode=1} catch(e) {process.exitCode=e.code === "EEXIST" ? 0 : 2}',
					lock(path),
				],
				{ stdio: "ignore" },
			)
			child.once("error", reject)
			child.once("exit", resolve)
		})
		expect(exit).toBe(0)
		expect(first.isAvailable()).toBe(true)
		await first.close()
		const second = await open(path)
		await second.close()
		await mkdir(lock(path), { mode: 0o700 })
		await expect(open(path)).rejects.toMatchObject(unavailable)
		expect((await lstat(lock(path))).isDirectory()).toBe(true)
	})

	it("requires an existing absolute parent without creating ancestors", async () => {
		const path = await root()
		await expect(open("relative")).rejects.toMatchObject(unavailable)
		await expect(open(join(path, "absent", "child"))).rejects.toMatchObject(
			unavailable,
		)
		expect(await readdir(path)).toEqual([])
	})

	it.each([
		"directory-mode",
		"directory-symlink",
		"directory-file",
		"file-mode",
		"file-symlink",
		"file-directory",
	])("rejects unsafe %s without repairing existing paths", async kind => {
		const path = await root()
		const first = await open(path)
		await first.close()
		const directory = join(path, "bandplans")
		if (kind === "directory-mode") await chmod(directory, 0o755)
		if (kind === "directory-symlink") {
			await rm(directory, { recursive: true })
			await mkdir(join(path, "target"), { mode: 0o700 })
			await symlink(join(path, "target"), directory)
		}
		if (kind === "directory-file") {
			await rm(directory, { recursive: true })
			await writeFile(directory, "untouched")
		}
		if (kind === "file-mode") await chmod(file(path), 0o644)
		if (kind === "file-symlink") {
			await rm(file(path))
			await writeFile(join(path, "target"), "untouched", { mode: 0o600 })
			await symlink(join(path, "target"), file(path))
		}
		if (kind === "file-directory") {
			await rm(file(path))
			await mkdir(file(path))
		}
		const target = kind.startsWith("directory") ? directory : file(path)
		const before = await lstat(target)
		await expect(open(path)).rejects.toMatchObject(unavailable)
		const after = await lstat(target)
		expect(after.mode).toBe(before.mode)
		expect(after.ino).toBe(before.ino)
	})

	// Feature: band-plans, Property 8: Durability and latch
	// Validates: Requirements 8.1, 8.3
	it("keeps prior bytes and permits retry for 100 injected pre-rename failures", async () => {
		const path = await root()
		let armed = false
		let failure: StorageStage = "temp-open"
		const store = await open(path, (stage, phase) => {
			if (armed && stage === failure && phase === "before")
				throw new Error("private fault path")
		})
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(...preStages),
				fc.integer({ min: 1, max: 100000 }),
				async (stage, revision) => {
					const prior = store.snapshot()
					const bytes = await readFile(file(path))
					failure = stage
					armed = true
					await expect(
						store.persist({ ...prior, revision }),
					).rejects.toMatchObject(unavailable)
					expect(await readFile(file(path))).toEqual(bytes)
					expect(store.snapshot()).toEqual(prior)
					expect(store.isAvailable()).toBe(true)
					expect((await readdir(join(path, "bandplans"))).sort()).toEqual([
						".writer-lock",
						"state.json",
					])
					armed = false
					await store.persist({ ...prior, revision })
					expect(store.snapshot().revision).toBe(revision)
				},
			),
			{ numRuns: 100 },
		)
		await store.close()
	})

	// Feature: band-plans, Property 8: Durability and latch
	// Validates: Requirements 8.1, 8.3
	it.each(["rename-after", "directory-sync-before", "directory-sync-after"])(
		"latches unavailable after %s until reopen",
		async failure => {
			const path = await root()
			let armed = false
			const store = await open(path, (stage, phase) => {
				if (armed && `${stage}-${phase}` === failure) throw new Error("fault")
			})
			const next = { ...store.snapshot(), revision: 1 }
			armed = true
			await expect(store.persist(next)).rejects.toMatchObject(unavailable)
			expect(store.isAvailable()).toBe(false)
			expect(() => store.snapshot()).toThrow(
				"Band-plan storage is unavailable.",
			)
			await expect(store.persist(next)).rejects.toMatchObject(unavailable)
			expect(JSON.parse(await readFile(file(path), "utf8"))).toEqual(next)
			armed = false
			await store.close()
			expect((await open(path)).snapshot()).toEqual(next)
		},
	)

	it.each([
		"parent-open",
		"directory-open",
		"parent-sync",
		"parent-close",
		"read-open",
		"read",
		"read-close",
		...preStages,
		"directory-sync",
	])(
		"settles failed initialization at %s and preserves any visible state",
		async failure => {
			const path = await root()
			if (failure.startsWith("read") && failure !== "read-open") {
				const store = await open(path)
				await store.close()
			}
			const prior = await readFile(file(path)).catch(() => undefined)
			await expect(
				open(path, (stage, phase) => {
					if (stage === failure && phase === "before") throw new Error("fault")
				}),
			).rejects.toMatchObject(unavailable)
			await expect(lstat(lock(path))).rejects.toMatchObject({ code: "ENOENT" })
			if (prior) expect(await readFile(file(path))).toEqual(prior)
			expect((await open(path)).isAvailable()).toBe(true)
		},
	)

	it("rejects invalid UTF-8 and a schema-invalid proposal before replacing bytes", async () => {
		const path = await root()
		const first = await open(path)
		const prior = first.snapshot()
		await first.close()
		const bytes = Buffer.from(JSON.stringify(prior))
		const storeIdAt = bytes.indexOf(prior.storeId)
		expect(storeIdAt).toBeGreaterThanOrEqual(0)
		bytes[storeIdAt] = 0xff
		await writeFile(file(path), bytes)
		await expect(open(path)).rejects.toMatchObject(unavailable)
		expect(await readFile(file(path))).toEqual(bytes)
		const stages: string[] = []
		const fresh = await root()
		const valid = await open(fresh, (stage, phase) => {
			stages.push(`${stage}:${phase}`)
		})
		const current = valid.snapshot()
		stages.length = 0
		await expect(
			valid.persist({ ...current, version: 2 } as unknown as typeof current),
		).rejects.toMatchObject({ code: "BANDPLANS_INVALID" })
		expect(stages).toEqual([])
		expect(valid.snapshot()).toEqual(current)
		expect(JSON.parse(await readFile(file(fresh), "utf8"))).toEqual(current)
	})

	// Feature: band-plans, Property 8: Durability and latch
	// Validates: Requirements 8.1, 8.3
	it("does not acknowledge a write before the directory sync finishes", async () => {
		const path = await root()
		const entered = gate()
		const blocked = gate()
		let armed = false
		const store = await open(path, async (stage, phase) => {
			if (armed && stage === "directory-sync" && phase === "before") {
				entered.release()
				await blocked.promise
			}
		})
		const prior = store.snapshot()
		armed = true
		let resolved = false
		const write = store.persist({ ...prior, revision: 4 }).then(() => {
			resolved = true
		})
		await entered.promise
		expect(resolved).toBe(false)
		expect(store.snapshot()).toEqual(prior)
		expect(JSON.parse(await readFile(file(path), "utf8")).revision).toBe(4)
		blocked.release()
		await write
		expect(store.snapshot().revision).toBe(4)
	})

	it("close drains the active write, rejects new work, and is idempotent", async () => {
		const path = await root()
		const entered = gate()
		const blocked = gate()
		let armed = false
		const store = await open(path, async (stage, phase) => {
			if (armed && stage === "temp-write" && phase === "before") {
				entered.release()
				await blocked.promise
			}
		})
		const next = { ...store.snapshot(), revision: 1 }
		armed = true
		const write = store.persist(next)
		await entered.promise
		await expect(store.persist(next)).rejects.toMatchObject({
			code: "BANDPLANS_BUSY",
		})
		const closing = store.close()
		expect(store.close()).toBe(closing)
		await expect(store.persist(next)).rejects.toMatchObject(unavailable)
		await expect(open(path)).rejects.toMatchObject(unavailable)
		blocked.release()
		await write
		await closing
		expect((await open(path)).snapshot()).toEqual(next)
	})

	it("fails closed when temporary cleanup or lock release cannot finish", async () => {
		const path = await root()
		let armed = false
		const store = await open(path, (stage, phase) => {
			if (
				armed &&
				phase === "before" &&
				(stage === "temp-write" || stage === "temp-remove")
			)
				throw new Error("fault")
		})
		const prior = store.snapshot()
		armed = true
		await expect(
			store.persist({ ...prior, revision: 1 }),
		).rejects.toMatchObject(unavailable)
		expect(store.isAvailable()).toBe(false)
		expect(JSON.parse(await readFile(file(path), "utf8"))).toEqual(prior)
		const closing = store.close()
		await expect(closing).resolves.toBeUndefined()
		const fresh = await root()
		await expect(
			open(fresh, (stage, phase) => {
				if (
					phase === "before" &&
					(stage === "parent-sync" || stage === "lock-release")
				)
					throw new Error("fault")
			}),
		).rejects.toMatchObject(unavailable)
		await expect(open(fresh)).rejects.toMatchObject(unavailable)
		expect((await lstat(lock(fresh))).isDirectory()).toBe(true)
	})
})
