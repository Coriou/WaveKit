import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	acquireWriterLock,
	bootTime,
	INCOMPLETE_LOCK_MS,
	isStale,
	parseStartTime,
	readLockOwner,
	probeLockOwner,
	releaseWriterLock,
	TIME_IDENTITY_TOLERANCE_MS,
	HEARTBEAT_MS,
	HEARTBEAT_STALE_MS,
	LOCK_WAIT_MS,
	startLockHeartbeat,
	lockWait,
} from "../../../src/utils/lock-owner.js"
import type { LockOwner, OwnerReader } from "../../../src/utils/lock-owner.js"

const owner: LockOwner = {
	pid: 123,
	hostname: "host",
	bootId: { kind: "linux", value: "boot" },
	startTime: { kind: "linux", value: "123" },
}
const roots: string[] = []
afterEach(async () => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	for (const root of roots.splice(0))
		await fs.rm(root, { recursive: true, force: true })
})
function io(files: Record<string, string> = {}): OwnerReader {
	return {
		readFile: async path => {
			if (files[path] !== undefined) return files[path]
			throw Object.assign(new Error(), { code: "ENOENT" })
		},
		kill: () => undefined,
		hostname: () => "host",
		uptime: () => 10,
		processUptime: () => 2,
		now: () => 100000,
	}
}
describe("lock identity", () => {
	it("detects reused PIDs across boots and process starts, while holding the same owner", () => {
		expect(
			isStale(
				owner,
				{ ...owner, bootId: { kind: "linux", value: "next" } },
				{ alive: true, startTime: owner.startTime },
			),
		).toBe(true)
		expect(
			isStale(owner, owner, {
				alive: true,
				startTime: { kind: "linux", value: "456" },
			}),
		).toBe(true)
		expect(
			isStale(owner, owner, { alive: true, startTime: owner.startTime }),
		).toBe(false)
	})
	it("holds alive PIDs without readable evidence even across hostname changes", () => {
		const unknown = { ...owner, bootId: null, startTime: null }
		expect(isStale(unknown, unknown, { alive: true, startTime: null })).toBe(
			false,
		)
		expect(
			isStale(
				unknown,
				{ ...unknown, hostname: "new" },
				{ alive: true, startTime: null },
			),
		).toBe(false)
		expect(
			isStale(
				owner,
				{ ...owner, hostname: "new" },
				{ alive: true, startTime: null },
			),
		).toBe(false)
	})
	it("never trusts local PID evidence from another namespace or unknown boot", () => {
		for (const recorded of [
			{ ...owner, pidNamespace: "1" },
			{ ...owner, bootId: null },
		]) {
			const current = { ...owner, pidNamespace: "2" }
			expect(
				isStale(
					recorded,
					current,
					{ alive: false, startTime: null },
					HEARTBEAT_STALE_MS,
				),
			).toBe(false)
			expect(
				isStale(
					recorded,
					current,
					{ alive: false, startTime: null },
					HEARTBEAT_STALE_MS + 1,
				),
			).toBe(true)
		}
	})
	it.each([LOCK_WAIT_MS, LOCK_WAIT_MS + 1])(
		"stops waiting at elapsed %i",
		async elapsed => {
			let now = 0
			const sleep = vi.fn(async () => undefined)
			const wait = lockWait({ now: () => now, sleep })
			now = elapsed
			expect(await wait.retry()).toBe(false)
			expect(sleep).not.toHaveBeenCalled()
		},
	)
	it("reads Linux stat after the last parenthesis and mocks proc on every OS", async () => {
		const stat = `123 (name with ) spaces) ${["S", ...Array<string>(18).fill("0"), "456"].join(" ")}`
		expect(parseStartTime(stat)).toBe("456")
		expect(parseStartTime("bad")).toBeNull()
		const current = await readLockOwner({
			...io({
				"/proc/self/stat": stat,
				"/proc/sys/kernel/random/boot_id": "boot\n",
			}),
			pidNamespace: async () => "4026531836",
		})
		expect(current).toMatchObject({
			bootId: owner.bootId,
			pidNamespace: "4026531836",
			startTime: { kind: "linux", value: "456" },
		})
		expect(await readLockOwner(io())).toMatchObject({
			bootId: { kind: "time", value: "90000" },
			startTime: { kind: "time", value: "98000" },
		})
	})
	it("retains raw fallback milliseconds and holds the whole-second uptime repro", async () => {
		const first = await readLockOwner({ ...io(), now: () => 100250 })
		const second = await readLockOwner({ ...io(), now: () => 101050 })
		expect(first.bootId).toEqual({ kind: "time", value: "90250" })
		expect(second.bootId).toEqual({ kind: "time", value: "91050" })
		expect(second.startTime).toEqual({ kind: "time", value: "99050" })
		expect(bootTime({ ...io(), now: () => 100250 })).toBe(90250)
		expect(
			isStale(first, second, { alive: true, startTime: first.startTime }),
		).toBe(false)
	})
	it.each(["boot", "start"] as const)(
		"compares time-kind %s at and past the tolerance in both directions",
		kind => {
			const recorded: LockOwner = {
				...owner,
				bootId: { kind: "time", value: "90000" },
				startTime: { kind: "time", value: "98000" },
			}
			for (const delta of [
				TIME_IDENTITY_TOLERANCE_MS - 1,
				TIME_IDENTITY_TOLERANCE_MS,
				TIME_IDENTITY_TOLERANCE_MS + 1,
			]) {
				for (const sign of [-1, 1]) {
					const current = {
						...recorded,
						bootId: {
							kind: "time" as const,
							value: String(90000 + (kind === "boot" ? sign * delta : 0)),
						},
					}
					const startTime = {
						kind: "time" as const,
						value: String(98000 + (kind === "start" ? sign * delta : 0)),
					}
					expect(isStale(recorded, current, { alive: true, startTime })).toBe(
						kind === "start" && delta > TIME_IDENTITY_TOLERANCE_MS,
					)
				}
			}
		},
	)

	it("treats ESRCH as dead and EPERM as alive", async () => {
		for (const code of ["ESRCH", "EPERM"]) {
			const mock = io()
			mock.kill = () => {
				throw Object.assign(new Error(), { code })
			}
			expect((await probeLockOwner(owner, mock)).alive).toBe(code !== "ESRCH")
		}
	})
	it("obeys the decision table", () => {
		// Feature: stale-locks, Property 1: scope/boot/liveness/heartbeat decision table
		// Validates: Requirements R1, R5
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				(bootDiffers, foreignScope, startDiffers, alive, expired) => {
					expect(
						isStale(
							owner,
							{
								...owner,
								hostname: foreignScope ? "other" : "host",
								bootId: {
									kind: "linux",
									value: bootDiffers ? "other" : "boot",
								},
							},
							{
								alive,
								startTime: {
									kind: "linux",
									value: startDiffers ? "456" : "123",
								},
							},
							expired ? HEARTBEAT_STALE_MS + 1 : HEARTBEAT_STALE_MS,
						),
					).toBe(
						bootDiffers ||
							expired ||
							(!foreignScope && (startDiffers || !alive)),
					)
				},
			),
			{ numRuns: 100 },
		)
	})
})
async function lockPath() {
	const root = await fs.mkdtemp(join(tmpdir(), "wavekit-lock-test-"))
	roots.push(root)
	const lock = join(root, ".writer-lock")
	await fs.mkdir(lock)
	return lock
}
describe("directory reclamation", () => {
	it.each([INCOMPLETE_LOCK_MS - 1, INCOMPLETE_LOCK_MS, INCOMPLETE_LOCK_MS + 1])(
		"handles incomplete owners at age %i",
		async age => {
			const lock = await lockPath()
			const now = Date.now()
			vi.spyOn(Date, "now").mockReturnValue(now)
			await fs.utimes(lock, new Date(now - age), new Date(now - age))
			let clock = now
			expect(
				await acquireWriterLock(lock, {
					now: () => clock,
					sleep: async ms => {
						clock += ms
					},
				}),
			).toBe(true)
			expect(clock - now).toBeLessThanOrEqual(LOCK_WAIT_MS)
			await releaseWriterLock(lock)
		},
	)
	it("a publisher stalled past the bound cannot overwrite a successful acquirer", async () => {
		const lock = await lockPath()
		await fs.rmdir(lock)
		const rename = fs.rename
		const now = Date.now()
		vi.spyOn(Date, "now").mockReturnValue(now)
		let suspended = false
		let successor: string | undefined
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (!suspended && to === lock) {
				suspended = true
				// The stalled publisher has a complete private lock, never a public one.
				await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" })
				expect(
					JSON.parse(
						await fs.readFile(join(String(from), "owner.json"), "utf8"),
					),
				).toMatchObject({ pid: process.pid })
				vi.spyOn(Date, "now").mockReturnValue(now + INCOMPLETE_LOCK_MS + 1)
				expect(await acquireWriterLock(lock)).toBe(true)
				successor = await fs.readFile(join(lock, "owner.json"), "utf8")
			}
			return rename(from, to)
		})
		expect(await acquireWriterLock(lock)).toBe(false)
		expect(await fs.readFile(join(lock, "owner.json"), "utf8")).toBe(successor)
		expect(await acquireWriterLock(lock)).toBe(false)
		await releaseWriterLock(lock)
	})
	it("rechecks a legacy owner published after the stale observation", async () => {
		const lock = await lockPath()
		const now = Date.now()
		vi.spyOn(Date, "now").mockReturnValue(now)
		const old = new Date(now - INCOMPLETE_LOCK_MS - 1)
		await fs.utimes(lock, old, old)
		const published = JSON.stringify(await readLockOwner())
		const rename = fs.rename
		let resumed = false
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (!resumed && to === join(lock, ".reclaim")) {
				resumed = true
				await fs.writeFile(join(lock, "owner.json"), published)
			}
			return rename(from, to)
		})
		expect(await acquireWriterLock(lock)).toBe(false)
		expect(resumed).toBe(true)
		expect(await fs.readFile(join(lock, "owner.json"), "utf8")).toBe(published)
		expect(await fs.readdir(lock)).toEqual(["owner.json"])
		await releaseWriterLock(lock)
	})
	it("releases its reclaim claim after a failed rename", async () => {
		const lock = await lockPath()
		const current = await readLockOwner()
		await fs.writeFile(
			join(lock, "owner.json"),
			JSON.stringify({ ...current, pid: 99999999 }),
		)
		const rename = fs.rename
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (from === lock) throw Object.assign(new Error(), { code: "EIO" })
			return rename(from, to)
		})
		await expect(acquireWriterLock(lock)).rejects.toMatchObject({ code: "EIO" })
		expect(await fs.readdir(lock)).toEqual(["owner.json"])
	})
	it("allows exactly one publisher on an initially empty path", async () => {
		const lock = await lockPath()
		await fs.rmdir(lock)
		// Make both publishers observe ENOENT before either can publish.
		const lstat = fs.lstat
		let observations = 0
		let release = () => undefined as void
		const barrier = new Promise<void>(resolve => {
			release = resolve
		})
		vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
			if (args[0] === lock && observations < 2) {
				observations++
				if (observations === 2) release()
				await barrier
				throw Object.assign(new Error(), { code: "ENOENT" })
			}
			return lstat(...args)
		})
		const results = await Promise.all([
			acquireWriterLock(lock),
			acquireWriterLock(lock),
		])
		expect(results.filter(Boolean)).toHaveLength(1)
		await releaseWriterLock(lock)
	})
	it("removes only its private directory on publication failure", async () => {
		const lock = await lockPath()
		await fs.rmdir(lock)
		const rename = fs.rename
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to).endsWith("owner.json"))
				throw Object.assign(new Error("publication failed"), { code: "EIO" })
			return rename(from, to)
		})
		await expect(acquireWriterLock(lock)).rejects.toMatchObject({ code: "EIO" })
		expect(await fs.readdir(join(lock, ".."))).toEqual([])
	})
	it("cleans only exact stale UUID directories after acquisition", async () => {
		const lock = await lockPath()
		await fs.rmdir(lock)
		const uuid = "12345678-1234-1234-1234-123456789abc"
		const stale = `${lock}.stale-${uuid}`
		const unrelated = `${lock}.stale-${uuid}-extra`
		const target = `${lock}-target`
		const symlink = `${lock}.stale-22345678-1234-1234-1234-123456789abc`
		const regular = `${lock}.stale-32345678-1234-1234-1234-123456789abc`
		await fs.mkdir(stale)
		await fs.writeFile(join(stale, "abandoned"), "old")
		await fs.mkdir(unrelated)
		await fs.mkdir(target)
		await fs.symlink(target, symlink)
		await fs.writeFile(regular, "keep")
		expect(await acquireWriterLock(lock)).toBe(true)
		await expect(fs.lstat(stale)).rejects.toMatchObject({ code: "ENOENT" })
		expect((await fs.lstat(unrelated)).isDirectory()).toBe(true)
		expect((await fs.lstat(symlink)).isSymbolicLink()).toBe(true)
		expect((await fs.lstat(target)).isDirectory()).toBe(true)
		expect(await fs.readFile(regular, "utf8")).toBe("keep")
		await releaseWriterLock(lock)
	})

	it.each([INCOMPLETE_LOCK_MS - 1, INCOMPLETE_LOCK_MS, INCOMPLETE_LOCK_MS + 1])(
		"sweeps only exact private UUID directories at age %i",
		async age => {
			const lock = await lockPath()
			await fs.rmdir(lock)
			const now = Date.now()
			vi.spyOn(Date, "now").mockReturnValue(now)
			const abandoned = `${lock}.new-12345678-1234-1234-1234-123456789abc`
			const unrelated = `${abandoned}-extra`
			const symlink = `${lock}.new-22345678-1234-1234-1234-123456789abc`
			const regular = `${lock}.new-32345678-1234-1234-1234-123456789abc`
			await fs.mkdir(abandoned)
			await fs.mkdir(unrelated)
			await fs.symlink(unrelated, symlink)
			await fs.writeFile(regular, "keep")
			const old = new Date(now - age)
			await fs.utimes(abandoned, old, old)
			expect(await acquireWriterLock(lock)).toBe(true)
			if (age >= INCOMPLETE_LOCK_MS)
				await expect(fs.lstat(abandoned)).rejects.toMatchObject({
					code: "ENOENT",
				})
			else expect((await fs.lstat(abandoned)).isDirectory()).toBe(true)
			expect((await fs.lstat(unrelated)).isDirectory()).toBe(true)
			expect((await fs.lstat(symlink)).isSymbolicLink()).toBe(true)
			expect(await fs.readFile(regular, "utf8")).toBe("keep")
			await releaseWriterLock(lock)
		},
	)

	it.each(["missing", "malformed", "dead-owner", "abandoned-claim"])(
		"allows exactly one concurrent reclaimer of %s",
		async kind => {
			const lock = await lockPath()
			if (kind === "abandoned-claim") {
				await fs.mkdir(join(lock, ".reclaim"))
				await fs.writeFile(
					join(lock, ".reclaim", "owner.json"),
					JSON.stringify({ ...(await readLockOwner()), pid: 99999999 }),
				)
			}
			if (kind !== "missing")
				await fs.writeFile(
					join(lock, "owner.json"),
					kind === "malformed"
						? "{}"
						: JSON.stringify({ ...(await readLockOwner()), pid: 99999999 }),
				)
			const now = Date.now()
			const old = new Date(now - INCOMPLETE_LOCK_MS - 1000)
			await fs.utimes(lock, old, old)
			if (kind === "malformed")
				await fs.utimes(join(lock, "owner.json"), old, old)
			const options = {
				now: () => now,
				sleep: () => new Promise<void>(resolve => setImmediate(resolve)),
			}
			const results = await Promise.all([
				acquireWriterLock(lock, options),
				acquireWriterLock(lock, options),
			])
			expect(results.filter(Boolean)).toHaveLength(1)
			await releaseWriterLock(lock)
		},
	)
})

describe("heartbeat leases", () => {
	it.each([false, true])(
		"waits across namespaces, with continued refresh=%s",
		async refresh => {
			const lock = await lockPath()
			const current = await readLockOwner()
			const path = join(lock, "owner.json")
			await fs.writeFile(
				path,
				JSON.stringify({
					...current,
					hostname: "other",
					pidNamespace: "other",
					pid: 99999999,
				}),
			)
			const started = Date.now()
			let clock = started
			await fs.utimes(path, new Date(clock), new Date(clock))
			expect(
				await acquireWriterLock(lock, {
					now: () => clock,
					sleep: async ms => {
						clock += ms
						if (refresh) await fs.utimes(path, new Date(clock), new Date(clock))
					},
				}),
			).toBe(!refresh)
			expect(clock - started).toBe(LOCK_WAIT_MS)
			if (refresh)
				expect(JSON.parse(await fs.readFile(path, "utf8"))).toMatchObject({
					hostname: "other",
				})
			await releaseWriterLock(lock)
		},
	)
	it("refreshes every H and stops after release", async () => {
		const lock = await lockPath()
		await fs.rmdir(lock)
		vi.useFakeTimers()
		expect(await acquireWriterLock(lock)).toBe(true)
		const path = join(lock, "owner.json")
		const utimes = vi.spyOn(fs, "open")
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
		await releaseWriterLock(lock)
		const count = utimes.mock.calls.length
		await vi.advanceTimersByTimeAsync(2 * HEARTBEAT_MS)
		expect(utimes.mock.calls).toHaveLength(count)
		await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" })
	})
	it("updates the inode mtime and stops on close", async () => {
		const lock = await lockPath()
		const path = join(lock, "owner.json")
		await fs.writeFile(path, "owner")
		await fs.utimes(path, new Date(0), new Date(0))
		vi.useFakeTimers()
		const stop = await startLockHeartbeat(path)
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1)
		expect((await fs.stat(path)).mtimeMs).toBe(0)
		await vi.advanceTimersByTimeAsync(1)
		await stop()
		expect((await fs.stat(path)).mtimeMs).toBe(Date.now())
		await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
		expect((await fs.stat(path)).mtimeMs).toBe(Date.now() - HEARTBEAT_MS)
	})
	it("releases by renaming even with contender claim files", async () => {
		const lock = await lockPath()
		await fs.rmdir(lock)
		expect(await acquireWriterLock(lock)).toBe(true)
		await fs.mkdir(join(lock, ".reclaim"))
		await fs.mkdir(
			join(lock, ".reclaim.new-12345678-1234-1234-1234-123456789abc"),
		)
		await releaseWriterLock(lock)
		expect(await fs.readdir(join(lock, ".."))).toEqual([])
	})
})
