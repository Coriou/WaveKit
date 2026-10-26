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
		).toBe(true)
	})
	it("reads Linux stat after the last parenthesis and mocks proc on every OS", async () => {
		const stat = `123 (name with ) spaces) ${["S", ...Array<string>(18).fill("0"), "456"].join(" ")}`
		expect(parseStartTime(stat)).toBe("456")
		expect(parseStartTime("bad")).toBeNull()
		const current = await readLockOwner(
			io({
				"/proc/self/stat": stat,
				"/proc/sys/kernel/random/boot_id": "boot\n",
			}),
		)
		expect(current).toMatchObject({
			bootId: owner.bootId,
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
						delta > TIME_IDENTITY_TOLERANCE_MS,
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
		// Feature: stale-locks, Property 1: boot/start/liveness decision table
		// Validates: Requirements R1, R5
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				(bootDiffers, startDiffers, alive) => {
					expect(
						isStale(
							owner,
							{
								...owner,
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
						),
					).toBe(bootDiffers || startDiffers || !alive)
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
	it.each([
		INCOMPLETE_LOCK_MS - 1000,
		INCOMPLETE_LOCK_MS,
		INCOMPLETE_LOCK_MS + 1000,
	])("handles incomplete owners at age %i", async age => {
		const lock = await lockPath()
		const now = Date.now()
		vi.spyOn(Date, "now").mockReturnValue(now)
		await fs.utimes(lock, new Date(now - age), new Date(now - age))
		expect(await acquireWriterLock(lock)).toBe(age >= INCOMPLETE_LOCK_MS)
		if (age >= INCOMPLETE_LOCK_MS) await releaseWriterLock(lock)
	})
	it("preserves a successor when a suspended publisher fails after reclamation", async () => {
		const lock = await lockPath()
		await fs.rmdir(lock)
		const rename = fs.rename
		let suspended = false
		let successor: string | undefined
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (!suspended && to === join(lock, "owner.json")) {
				suspended = true
				const old = new Date(Date.now() - INCOMPLETE_LOCK_MS - 1000)
				await fs.utimes(lock, old, old)
				expect(await acquireWriterLock(lock)).toBe(true)
				successor = await fs.readFile(join(lock, "owner.json"), "utf8")
				throw Object.assign(new Error("publisher resumed after reclaim"), {
					code: "EIO",
				})
			}
			return rename(from, to)
		})
		await expect(acquireWriterLock(lock)).rejects.toMatchObject({ code: "EIO" })
		expect(await fs.readFile(join(lock, "owner.json"), "utf8")).toBe(successor)
		expect(await acquireWriterLock(lock)).toBe(false)
		await releaseWriterLock(lock)
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
			const old = new Date(Date.now() - INCOMPLETE_LOCK_MS - 1000)
			await fs.utimes(lock, old, old)
			const results = await Promise.all([
				acquireWriterLock(lock),
				acquireWriterLock(lock),
			])
			expect(results.filter(Boolean)).toHaveLength(1)
			await releaseWriterLock(lock)
		},
	)
})
