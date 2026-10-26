import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import { basename, dirname, join } from "node:path"
import { z } from "zod"

/**
 * Boot + process-start identities detect PID reuse, including container restarts.
 * Fallback identities retain raw milliseconds and tolerate observation jitter.
 * The current process caches fallback identities to absorb later clock steps.
 * Without readable boot/start evidence, a live PID is held even if the hostname
 * changed: this sacrifices automatic recovery rather than evicting a live writer.
 */
export const lockOwnerSchema = z.object({
	pid: z.number().int().positive(),
	hostname: z.string(),
	bootId: z
		.object({ kind: z.enum(["linux", "time"]), value: z.string() })
		.nullable(),
	startTime: z
		.object({ kind: z.enum(["linux", "time"]), value: z.string() })
		.nullable(),
})
export type LockOwner = z.infer<typeof lockOwnerSchema>
export interface OwnerReader {
	readFile: (path: string) => Promise<string>
	kill: (pid: number) => void
	hostname: () => string
	uptime: () => number
	processUptime: () => number
	now: () => number
}
const reader: OwnerReader = {
	readFile: path => fs.readFile(path, "utf8"),
	kill: pid => {
		process.kill(pid, 0)
	},
	hostname: () => os.hostname(),
	uptime: () => os.uptime(),
	processUptime: () => process.uptime(),
	now: () => Date.now(),
}
export function hasLockCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	)
}
export function parseStartTime(stat: string): string | null {
	// comm (field 2) may contain spaces and ')'; field 22 is offset 19 after comm.
	const end = stat.lastIndexOf(")")
	if (end < 0) return null
	const value = stat
		.slice(end + 1)
		.trim()
		.split(/\s+/)[19]
	return value !== undefined && /^\d+$/.test(value) ? value : null
}
async function linuxStart(
	pid: number | "self",
	io: OwnerReader,
): Promise<string | null> {
	try {
		return parseStartTime(await io.readFile(`/proc/${pid}/stat`))
	} catch {
		return null
	}
}
export function bootTime(io: OwnerReader = reader): number {
	return io.now() - io.uptime() * 1000
}
let fallbackBoot: LockOwner["bootId"]
let fallbackStart: LockOwner["startTime"]
export async function readLockOwner(
	io: OwnerReader = reader,
): Promise<LockOwner> {
	let bootId: LockOwner["bootId"]
	try {
		const value = (await io.readFile("/proc/sys/kernel/random/boot_id")).trim()
		bootId = value ? { kind: "linux", value } : null
	} catch {
		bootId = null
	}
	if (bootId === null) {
		const fallback = { kind: "time", value: String(bootTime(io)) } as const
		if (io === reader) fallbackBoot ??= fallback
		bootId = io === reader ? (fallbackBoot ?? fallback) : fallback
	}
	const start = await linuxStart("self", io)
	let startTime: LockOwner["startTime"] =
		start === null
			? {
					kind: "time",
					value: String(io.now() - io.processUptime() * 1000),
				}
			: { kind: "linux", value: start }
	if (start === null && io === reader) {
		fallbackStart ??= startTime
		startTime = fallbackStart
	}
	return { pid: process.pid, hostname: io.hostname(), bootId, startTime }
}
export interface OwnerProbe {
	alive: boolean
	startTime: LockOwner["startTime"]
}
// 5 s = 1 s integral-uptime truncation + 4 s clock/observation jitter margin.
// Larger clock steps cannot be distinguished from a new boot by this fallback.
export const TIME_IDENTITY_TOLERANCE_MS = 5 * 1000
function identityDiffers(
	recorded: NonNullable<LockOwner["bootId"]>,
	current: NonNullable<LockOwner["bootId"]>,
): boolean {
	if (recorded.kind === "linux") return recorded.value !== current.value
	return (
		Math.abs(Number(recorded.value) - Number(current.value)) >
		TIME_IDENTITY_TOLERANCE_MS
	)
}
export function isStale(
	recorded: LockOwner,
	current: LockOwner,
	probe: OwnerProbe,
): boolean {
	const bootKnown =
		recorded.bootId !== null &&
		current.bootId !== null &&
		recorded.bootId.kind === current.bootId.kind
	if (
		bootKnown &&
		recorded.bootId &&
		current.bootId &&
		identityDiffers(recorded.bootId, current.bootId)
	)
		return true
	if (!probe.alive) return true
	const startKnown =
		recorded.startTime !== null &&
		probe.startTime !== null &&
		recorded.startTime.kind === probe.startTime.kind
	if (!bootKnown && !startKnown) return false
	return (
		recorded.hostname !== current.hostname ||
		(startKnown &&
			recorded.startTime !== null &&
			probe.startTime !== null &&
			identityDiffers(recorded.startTime, probe.startTime))
	)
}
export async function probeLockOwner(
	owner: LockOwner,
	io: OwnerReader = reader,
): Promise<OwnerProbe> {
	try {
		io.kill(owner.pid)
	} catch (error) {
		if (hasLockCode(error, "ESRCH")) return { alive: false, startTime: null }
	}
	const start = await linuxStart(owner.pid, io)
	return {
		alive: true,
		startTime:
			start === null
				? owner.pid === process.pid
					? (await readLockOwner(io)).startTime
					: null
				: { kind: "linux", value: start },
	}
}

// 30 s = 3 × a conservative 10 s legacy owner-publication allowance.
// New locks are born with an owner; only pre-change publishers expose incomplete locks.
export const INCOMPLETE_LOCK_MS = 30 * 1000
const OWNER = "owner.json"
export async function acquireWriterLock(lock: string): Promise<boolean> {
	try {
		return await acquireDirectory(lock)
	} catch (error) {
		// A winning reclaimer or sibling sweep can move/remove a directory.
		if (hasLockCode(error, "ENOENT")) return false
		throw error
	}
}
function isContended(error: unknown): boolean {
	return ["ENOTEMPTY", "EEXIST", "EISDIR", "ENOTDIR"].some(code =>
		hasLockCode(error, code),
	)
}
async function ownerIsHeld(
	lock: string,
	current: LockOwner,
	mtimeMs: number,
): Promise<boolean> {
	let owner: LockOwner | undefined
	try {
		const handle = await fs.open(
			join(lock, OWNER),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		)
		try {
			const parsed = lockOwnerSchema.safeParse(
				JSON.parse(await handle.readFile("utf8")),
			)
			if (parsed.success) owner = parsed.data
		} finally {
			await handle.close()
		}
	} catch (error) {
		if (!hasLockCode(error, "ENOENT") && !(error instanceof SyntaxError))
			throw error
	}
	return owner
		? !isStale(owner, current, await probeLockOwner(owner))
		: Date.now() - mtimeMs < INCOMPLETE_LOCK_MS
}
async function syncDirectory(path: string): Promise<void> {
	const directory = await fs.open(
		path,
		constants.O_RDONLY | constants.O_DIRECTORY,
	)
	try {
		await directory.sync()
	} finally {
		await directory.close()
	}
}
async function acquireDirectory(lock: string): Promise<boolean> {
	const current = await readLockOwner()
	const prepared = `${lock}.new-${randomUUID()}`
	await fs.mkdir(prepared, { mode: 0o700 })
	try {
		const temp = join(prepared, `${randomUUID()}.tmp`)
		const handle = await fs.open(temp, "wx", 0o600)
		try {
			await handle.writeFile(JSON.stringify(current))
			await handle.sync()
		} finally {
			await handle.close()
		}
		await fs.rename(temp, join(prepared, OWNER))
		await syncDirectory(prepared)

		const before = await fs.lstat(lock).catch((error: unknown) => {
			if (hasLockCode(error, "ENOENT")) return undefined
			throw error
		})
		if (before) {
			if (!before.isDirectory() || before.isSymbolicLink()) return false
			if (await ownerIsHeld(lock, current, before.mtimeMs)) return false
			// Claim before moving, then verify both inode and owner again: a legacy
			// publisher may have installed its live owner since our first observation.
			const claim = join(lock, ".reclaim")
			if (!(await acquireWriterLock(claim))) return false
			const actual = await fs.lstat(lock)
			if (actual.ino !== before.ino || actual.dev !== before.dev) {
				await releaseWriterLock(claim)
				return false
			}
			if (await ownerIsHeld(lock, current, before.mtimeMs)) {
				await releaseWriterLock(claim)
				return false
			}
			const aside = `${lock}.stale-${randomUUID()}`
			await fs.rename(lock, aside)
			try {
				try {
					await fs.rename(prepared, lock)
				} catch (error) {
					if (isContended(error)) return false
					throw error
				}
			} finally {
				await fs.rm(aside, { recursive: true, force: true })
			}
		} else {
			// Only attempt direct publication after ENOENT. New-code publishers
			// always rename non-empty directories, so competing publication fails.
			// A pre-change publisher still running could create an empty directory
			// in this residual window and POSIX rename would replace it; deployments
			// must not run that legacy mkdir-first code alongside this implementation.
			try {
				await fs.rename(prepared, lock)
			} catch (error) {
				if (isContended(error)) return false
				throw error
			}
		}
		await syncDirectory(dirname(lock))
		await cleanupStaleDirectories(lock)
		return true
	} finally {
		// Never clean the public lock on failure: only our private sibling is ours.
		await fs.rm(prepared, { recursive: true, force: true })
	}
}
async function cleanupStaleDirectories(lock: string): Promise<void> {
	const prefixes = [`${basename(lock)}.stale-`, `${basename(lock)}.new-`]
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
	try {
		for (const entry of await fs.readdir(dirname(lock))) {
			const prefix = prefixes.find(value => entry.startsWith(value))
			if (!prefix || !uuid.test(entry.slice(prefix.length))) continue
			try {
				const path = join(dirname(lock), entry)
				const stat = await fs.lstat(path)
				if (
					stat.isDirectory() &&
					!stat.isSymbolicLink() &&
					(!entry.startsWith(`${basename(lock)}.new-`) ||
						Date.now() - stat.mtimeMs >= INCOMPLETE_LOCK_MS)
				)
					await fs.rm(path, { recursive: true, force: true })
			} catch {
				// A concurrent acquirer may already have cleaned this sibling.
			}
		}
	} catch {
		// Sibling cleanup must not fail a successfully published lock.
	}
}
export async function releaseWriterLock(lock: string): Promise<void> {
	await fs.unlink(join(lock, OWNER))
	await fs.rmdir(lock)
}
