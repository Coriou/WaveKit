import fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { rename } from "node:fs/promises"
import { HEARTBEAT_MS } from "../../../src/utils/lock-owner.js"
import { spawn } from "node:child_process"
import {
	chmod,
	lstat,
	mkdir,
	utimes,
	mkdtemp,
	readFile,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import { OperatorDataStorage } from "../../../src/operator-data/storage.js"
import type { StorageStage } from "../../../src/operator-data/storage.js"
import { formatStartupFailure } from "../../../src/utils/startup-failure.js"
import { OPERATOR_DATA_LIMITS } from "../../../src/operator-data/schema.js"

const roots: string[] = []
const stores: OperatorDataStorage[] = []
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
	const path = await mkdtemp(join(tmpdir(), "wavekit-operator-storage-"))
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
	const store = await OperatorDataStorage.open({
		stateDir,
		...(stage ? { stage } : {}),
	})
	stores.push(store)
	return store
}
const file = (path: string) => join(path, "operator-data", "state.json")
const lock = (path: string) => join(path, "operator-data", ".writer-lock")
const unavailable = {
	code: expect.stringMatching(
		/^OPERATOR_DATA_(UNAVAILABLE|IO|LOCK_HELD|PERMISSIONS|INVALID|OVERSIZED)$/,
	),
	message: "Operator data is unavailable.",
}
function gate() {
	let release!: () => void
	const promise = new Promise<void>(resolve => {
		release = resolve
	})
	return { promise, release }
}

describe("dedicated operator-data storage", () => {
	it("reclaims an abandoned incomplete writer directory", async () => {
		const path = await root()
		await mkdir(join(path, "operator-data"), { mode: 0o700 })
		await mkdir(lock(path), { mode: 0o700 })
		const old = new Date(Date.now() - 31000)
		await utimes(lock(path), old, old)
		let clock = 0
		const recovered = await OperatorDataStorage.open({
			stateDir: path,
			lockWait: {
				now: () => clock,
				sleep: async ms => {
					clock += ms
				},
			},
		})
		expect(clock).toBe(30000)
		await recovered.close()
		expect(await readdir(join(path, "operator-data"))).not.toContain(
			".writer-lock",
		)
	})

	it("durably initializes once, syncs parent on every open, and returns detached snapshots", async () => {
		const path = await root()
		const stages: string[] = []
		const observe = (stage: StorageStage, phase: string) => {
			stages.push(`${stage}:${phase}`)
		}
		const first = await open(path, observe)
		const initial = first.snapshot()
		expect(initial.revision).toBe(0)
		expect((await lstat(join(path, "operator-data"))).mode & 0o777).toBe(0o700)
		expect((await lstat(file(path))).mode & 0o777).toBe(0o600)
		expect(stages.indexOf("parent-sync:after")).toBeLessThan(
			stages.indexOf("temp-open:before"),
		)
		expect(stages.indexOf("temp-sync:after")).toBeLessThan(
			stages.indexOf("rename:before"),
		)
		expect(stages.at(-1)).toBe("directory-sync:after")
		initial.preferenceOverrides.units = "metric"
		expect(first.snapshot().preferenceOverrides).toEqual({})
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

	// Feature: operator-data, Property 6: Recovery preservation
	// Validates: Requirements 4.1, 4.4–4.7
	// Each reopen now also syncs the prepared lock and its parent directory.
	it("restores exact committed state over 100 real-directory restarts", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 100000 }),
				fc.constantFrom("metric", "nautical", "imperial"),
				async (revision, units) => {
					const path = await root()
					const first = await open(path)
					const next = {
						...first.snapshot(),
						revision,
						preferenceOverrides: { units },
					}
					await first.persist(next)
					await first.close()
					await writeFile(
						join(path, "operator-data", ".state-leftover.tmp"),
						"ignored",
					)
					const second = await open(path)
					expect(second.snapshot()).toEqual(next)
					await second.close()
				},
			),
			{ numRuns: 100 },
		)
	}, 180_000)

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
						? "x".repeat(OPERATOR_DATA_LIMITS.snapshotBytes + 1)
						: kind === "empty"
							? ""
							: "{bad"
			await writeFile(file(path), bytes)
			await expect(open(path)).rejects.toMatchObject(unavailable)
			expect(await readFile(file(path), "utf8")).toBe(bytes)
			await expect(lstat(lock(path))).rejects.toMatchObject({ code: "ENOENT" })
		},
	)

	it("rejects another same-process opener and real child-process lock acquisition", async () => {
		const path = await root()
		const first = await open(path)
		const held: unknown = await open(path).catch((error: unknown) => error)
		expect(held).toMatchObject({
			...unavailable,
			code: "OPERATOR_DATA_LOCK_HELD",
		})
		expect(formatStartupFailure(held)).toBe(
			"WaveKit startup failed: WaveKitError [OPERATOR_DATA_LOCK_HELD]: startup could not complete\n",
		)
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
		const directory = join(path, "operator-data")
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

	const preStages: StorageStage[] = [
		"temp-open",
		"temp-write",
		"temp-sync",
		"temp-close",
		"rename",
	]
	// Feature: operator-data, Property 5: Durability boundary
	// Validates: Requirements 4.2–4.3
	it("preserves prior bytes and permits retry for 100 injected pre-rename failures", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(...preStages),
				fc.integer({ min: 1, max: 100000 }),
				async (failure, revision) => {
					const path = await root()
					let armed = false
					const store = await open(path, (stage, phase) => {
						if (armed && stage === failure && phase === "before")
							throw new Error("private fault path")
					})
					const prior = store.snapshot()
					const bytes = await readFile(file(path))
					const next = { ...prior, revision }
					armed = true
					await expect(store.persist(next)).rejects.toMatchObject(unavailable)
					expect(await readFile(file(path))).toEqual(bytes)
					expect(store.snapshot()).toEqual(prior)
					expect((await readdir(join(path, "operator-data"))).sort()).toEqual([
						".writer-lock",
						"state.json",
					])
					armed = false
					await store.persist(next)
					expect(store.snapshot()).toEqual(next)
					await store.close()
				},
			),
			{ numRuns: 100 },
		)
	}, 60000)

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
			expect(() => store.snapshot()).toThrow("Operator data is unavailable.")
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
			// Read failures need existing state; all other stages exercise missing initialization.
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
			const recovered = await open(path)
			expect(recovered.isAvailable()).toBe(true)
		},
	)

	it("rejects failed recovery directory sync without exposing or replacing visible state", async () => {
		const path = await root()
		const first = await open(path)
		const previous = await readFile(file(path), "utf8")
		await first.close()
		let synced = false
		await expect(
			open(path, (stage, phase) => {
				if (stage === "directory-sync" && phase === "before") {
					synced = true
					throw new Error("recovery sync")
				}
			}),
		).rejects.toMatchObject(unavailable)
		expect(synced).toBe(true)
		expect(await readFile(file(path), "utf8")).toBe(previous)
		await expect(lstat(lock(path))).rejects.toMatchObject({ code: "ENOENT" })
		const recovered = await open(path)
		expect(recovered.snapshot()).toEqual(JSON.parse(previous))
	})

	it("parent-sync failure on reopen preserves exact state", async () => {
		const path = await root()
		const store = await open(path)
		await store.persist({ ...store.snapshot(), revision: 42 })
		await store.close()
		const prior = await readFile(file(path))
		await expect(
			open(path, (stage, phase) => {
				if (stage === "parent-sync" && phase === "before")
					throw new Error("fault")
			}),
		).rejects.toMatchObject(unavailable)
		expect(await readFile(file(path))).toEqual(prior)
		await expect(lstat(lock(path))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("close drains active persistence, rejects new work, and keeps ownership until completion", async () => {
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
			code: "OPERATOR_DATA_BUSY",
		})
		const close = store.close()
		expect(store.close()).toBe(close)
		await expect(store.persist(next)).rejects.toMatchObject(unavailable)
		await expect(open(path)).rejects.toMatchObject(unavailable)
		blocked.release()
		await write
		await close
		expect((await open(path)).snapshot()).toEqual(next)
	})

	it.each(["directory-close", "lock-release"])(
		"fails closed when ownership cleanup fails at %s",
		async failure => {
			const path = await root()
			let armed = false
			const store = await open(path, (stage, phase) => {
				if (armed && stage === failure && phase === "before")
					throw new Error("fault")
			})
			armed = true
			const closing = store.close()
			await expect(closing).rejects.toMatchObject(unavailable)
			expect(store.close()).toBe(closing)
			await expect(open(path)).rejects.toMatchObject(unavailable)
			expect((await lstat(lock(path))).isDirectory()).toBe(true)
		},
	)

	it("validates before I/O and captures a detached proposal", async () => {
		const path = await root()
		const store = await open(path)
		const next = { ...store.snapshot(), revision: 1 }
		await expect(
			store.persist({ ...next, version: 2 } as unknown as typeof next),
		).rejects.toMatchObject({ code: "OPERATOR_DATA_INVALID" })
		const persistence = store.persist(next)
		next.revision = 99
		await persistence
		expect(store.snapshot().revision).toBe(1)
	})
	it.each(["directory", "file"])(
		"rejects a %s owned by another UID",
		async target => {
			const path = await root()
			const first = await open(path)
			await first.close()
			const uid = process.getuid!()
			let substituted = false
			await expect(
				open(path, (stage, phase) => {
					if (
						phase === "after" &&
						stage === (target === "directory" ? "directory-open" : "read-open")
					) {
						vi.spyOn(process as { getuid(): number }, "getuid").mockReturnValue(
							uid + 1,
						)
						substituted = true
					}
				}),
			).rejects.toMatchObject(unavailable)
			expect(substituted).toBe(true)
			vi.restoreAllMocks()
			await expect(lstat(lock(path))).rejects.toMatchObject({ code: "ENOENT" })
		},
	)

	it.each(["temp-open", "temp-write", "temp-sync", "temp-close"] as const)(
		"retries after an after-operation %s fault",
		async failure => {
			const path = await root()
			let armed = false
			const store = await open(path, (stage, phase) => {
				if (armed && stage === failure && phase === "after")
					throw new Error("fault")
			})
			const prior = store.snapshot()
			armed = true
			await expect(
				store.persist({ ...prior, revision: 1 }),
			).rejects.toMatchObject(unavailable)
			expect(store.snapshot()).toEqual(prior)
			expect(JSON.parse(await readFile(file(path), "utf8"))).toEqual(prior)
			armed = false
			await store.persist({ ...prior, revision: 1 })
			expect(store.snapshot().revision).toBe(1)
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
	] as const)("cleans failed reopen after %s finishes", async failure => {
		const path = await root()
		const first = await open(path)
		await first.close()
		const prior = await readFile(file(path))
		await expect(
			open(path, (stage, phase) => {
				if (stage === failure && phase === "after") throw new Error("fault")
			}),
		).rejects.toMatchObject(unavailable)
		expect(await readFile(file(path))).toEqual(prior)
		await expect(lstat(lock(path))).rejects.toMatchObject({ code: "ENOENT" })
		expect((await open(path)).isAvailable()).toBe(true)
	})

	it.each(["rename-after", "directory-sync-before", "directory-sync-after"])(
		"preserves initialized state after uncertain open at %s",
		async failure => {
			const path = await root()
			await expect(
				open(path, (stage, phase) => {
					if (`${stage}-${phase}` === failure) throw new Error("fault")
				}),
			).rejects.toMatchObject(unavailable)
			const initialized = JSON.parse(
				await readFile(file(path), "utf8"),
			) as unknown
			await expect(lstat(lock(path))).rejects.toMatchObject({ code: "ENOENT" })
			expect((await open(path)).snapshot()).toEqual(initialized)
		},
	)

	it("rejects invalid UTF-8 rather than silently replacing stored bytes", async () => {
		const path = await root()
		const first = await open(path)
		const snapshot = first.snapshot()
		await first.close()
		const encoded = JSON.stringify({
			...snapshot,
			savedFrequencies: [
				{
					id: "ea9f7e26-8b4d-44b6-90d5-92c7048b0173",
					name: "valid name",
					frequencyHz: 100000000,
					mode: "nfm",
					bandwidthHz: 12500,
					tone: { kind: "none" },
					createdAt: "2026-10-10T00:00:00.000Z",
					updatedAt: "2026-10-10T00:00:00.000Z",
				},
			],
		})
		const bytes = Buffer.from(encoded)
		bytes[encoded.indexOf("valid name")] = 0xff
		await writeFile(file(path), bytes)
		await expect(open(path)).rejects.toMatchObject(unavailable)
		expect(await readFile(file(path))).toEqual(bytes)
	})

	it("keeps failed-open ownership when lock cleanup cannot finish", async () => {
		const path = await root()
		await expect(
			open(path, (stage, phase) => {
				if (
					phase === "before" &&
					(stage === "parent-sync" || stage === "lock-release")
				)
					throw new Error("fault")
			}),
		).rejects.toMatchObject(unavailable)
		await expect(open(path)).rejects.toMatchObject(unavailable)
		expect((await lstat(lock(path))).isDirectory()).toBe(true)
	})

	it("fails unavailable if its own temporary-file cleanup fails", async () => {
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
		armed = false
		await store.close()
		expect((await open(path)).snapshot()).toEqual(prior)
	})
	it("does not resolve persistence or replace its snapshot before directory sync finishes", async () => {
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
		const write = store.persist({ ...prior, revision: 1 }).then(() => {
			resolved = true
		})
		await entered.promise
		expect(resolved).toBe(false)
		expect(store.snapshot()).toEqual(prior)
		expect(JSON.parse(await readFile(file(path), "utf8"))).toEqual({
			...prior,
			revision: 1,
		})
		blocked.release()
		await write
		expect(resolved).toBe(true)
		expect(store.snapshot().revision).toBe(1)
	})
})

it("latches unavailable on a lost heartbeat and preserves the successor on close", async () => {
	const path = await root()
	vi.useFakeTimers()
	try {
		const first = await open(path)
		const snapshot = first.snapshot()
		const lockPath = join(path, "operator-data", ".writer-lock")
		await rename(lockPath, `${lockPath}.detached`)
		const second = await open(path)
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
		await first.close()
		expect(first.isAvailable()).toBe(false)
		await expect(first.persist(snapshot)).rejects.toMatchObject({
			code: "OPERATOR_DATA_IO",
		})
		expect((await lstat(lockPath)).isDirectory()).toBe(true)
		await second.close()
	} finally {
		vi.useRealTimers()
	}
})
it("checks ownership immediately before committing a write", async () => {
	const path = await root()
	let replace = false
	const store = await open(path, async (stage, phase) => {
		if (replace && stage === "rename" && phase === "before") {
			replace = false
			const lockPath = join(path, "operator-data", ".writer-lock")
			await rename(lockPath, `${lockPath}.detached`)
		}
	})
	const before = await readFile(file(path), "utf8")
	replace = true
	await expect(store.persist(store.snapshot())).rejects.toMatchObject({
		code: "OPERATOR_DATA_IO",
	})
	expect(store.isAvailable()).toBe(false)
	expect(await readFile(file(path), "utf8")).toBe(before)
})

it.each([
	"directory-close:before",
	"directory-close:after",
	"lock-release:before",
])(
	"stops the writer heartbeat and closes its fd after %s fails",
	async fault => {
		const path = await root()
		const ownerPath = join(lock(path), "owner.json")
		const fileOpen = fs.open
		let ownerHandle: FileHandle | undefined
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await fileOpen(...args)
			if (args[0] === ownerPath) ownerHandle = handle
			return handle
		})
		vi.useFakeTimers()
		try {
			const store = await open(path, (stage, phase) => {
				if (`${stage}:${phase}` === fault) throw new Error("cleanup fault")
			})
			const closing = store.close()
			await expect(closing).rejects.toBeDefined()
			expect(store.close()).toBe(closing)
			expect(ownerHandle).toBeDefined()
			expect(ownerHandle?.fd).toBe(-1)
			await expect(ownerHandle?.stat()).rejects.toMatchObject({ code: "EBADF" })
			expect(vi.getTimerCount()).toBe(0)
			const before = await lstat(ownerPath)
			await vi.advanceTimersByTimeAsync(3 * HEARTBEAT_MS)
			expect((await lstat(ownerPath)).mtimeMs).toBe(before.mtimeMs)
		} finally {
			vi.useRealTimers()
		}
	},
)
