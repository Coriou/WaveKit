import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import { createComponentLogger, createLogger } from "./logger.js"

/**
 * Boot + process-start identities detect PID reuse, including container restarts.
 * Fallback identities retain raw milliseconds and tolerate observation jitter.
 * The current process caches fallback identities to absorb later clock steps.
 * PID evidence is local to boot/hostname/PID namespace. Across scopes, a fresh
 * heartbeat holds ownership regardless of what local PID probing reports.
 */
export const lockOwnerSchema = z.object({
	pid: z.number().int().positive(),
	hostname: z.string(),
	pidNamespace: z.string().nullable().optional(),
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
	pidNamespace?: () => Promise<string>
	kill: (pid: number) => void
	hostname: () => string
	uptime: () => number
	processUptime: () => number
	now: () => number
}
const reader: OwnerReader = {
	readFile: path => fs.readFile(path, "utf8"),
	pidNamespace: async () => String((await fs.stat("/proc/self/ns/pid")).ino),
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
	const pidNamespace = await io.pidNamespace?.().catch(() => null)
	return {
		pid: process.pid,
		hostname: io.hostname(),
		bootId,
		startTime,
		pidNamespace: pidNamespace ?? null,
	}
}
export interface OwnerProbe {
	alive: boolean
	startTime: LockOwner["startTime"]
}
// 5 s = 1 s integral-uptime truncation + 4 s clock/observation jitter margin.
// Larger clock steps cannot prove a new boot: fresh heartbeats remain held.
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
export function sameScope(recorded: LockOwner, current: LockOwner): boolean {
	return (
		recorded.bootId !== null &&
		current.bootId !== null &&
		recorded.bootId.kind === current.bootId.kind &&
		!identityDiffers(recorded.bootId, current.bootId) &&
		recorded.hostname === current.hostname &&
		(!recorded.pidNamespace ||
			!current.pidNamespace ||
			recorded.pidNamespace === current.pidNamespace)
	)
}
export function isStale(
	recorded: LockOwner,
	current: LockOwner,
	probe: OwnerProbe,
	heartbeatAge = 0,
): boolean {
	if (
		recorded.bootId?.kind === "linux" &&
		current.bootId?.kind === "linux" &&
		recorded.bootId.value !== current.bootId.value
	)
		return true
	if (heartbeatAge > HEARTBEAT_STALE_MS) return true
	if (!sameScope(recorded, current)) return false
	return (
		!probe.alive ||
		(recorded.startTime !== null &&
			probe.startTime !== null &&
			recorded.startTime.kind === probe.startTime.kind &&
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

// H = 10 s; 3 × H = 30 s tolerates two missed refreshes during event-loop
// stalls/fsync. Writes have no tighter deadline; the lease covers their stalls too.
export const HEARTBEAT_MS = 10 * 1000
export const HEARTBEAT_STALE_MS = 3 * HEARTBEAT_MS
// 3 × H + H = 40 s leaves one additional refresh interval for recovery.
export const LOCK_WAIT_MS = HEARTBEAT_STALE_MS + HEARTBEAT_MS
export const INCOMPLETE_LOCK_MS = HEARTBEAT_STALE_MS
const log = createComponentLogger(
	createLogger({ level: "info" }),
	"StorageLock",
)
export interface LockWaitOptions {
	now?: () => number
	sleep?: (ms: number) => Promise<void>
}
export function lockWait(options: LockWaitOptions = {}) {
	const now = options.now ?? (() => Date.now())
	const sleep =
		options.sleep ??
		(ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
	const started = now()
	const monotonicStart = performance.now()
	const elapsed = options.now
		? () => now() - started
		: () => performance.now() - monotonicStart
	let logged = false
	return {
		now,
		retry: async () => {
			if (elapsed() >= LOCK_WAIT_MS) return false
			if (!logged) {
				log.info("Waiting for storage lock heartbeat")
				logged = true
			}
			await sleep(Math.min(HEARTBEAT_MS, LOCK_WAIT_MS - elapsed()))
			return true
		},
	}
}
export async function startLockHeartbeat(
	path: string,
): Promise<() => Promise<void>> {
	// Keep an fd so a late refresh cannot touch a successor after rename/reclaim.
	const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
	let pending = Promise.resolve()
	const timer = setInterval(() => {
		pending = pending
			.then(async () => {
				const now = new Date()
				await handle.utimes(now, now)
			})
			.catch(() => {
				log.warn("Storage lock heartbeat refresh failed")
			})
	}, HEARTBEAT_MS)
	timer.unref()
	return async () => {
		clearInterval(timer)
		await pending
		await handle.close()
	}
}
const heartbeats = new Map<string, () => Promise<void>>()
const OWNER = "owner.json"
export async function acquireWriterLock(
	lock: string,
	options: LockWaitOptions = {},
): Promise<boolean> {
	const wait = lockWait(options)
	for (;;) {
		try {
			const result = await acquireDirectory(lock, wait.now)
			if (result === "acquired") {
				heartbeats.set(lock, await startLockHeartbeat(join(lock, OWNER)))
				return true
			}
			if (result === "held") return false
		} catch (error) {
			if (!hasLockCode(error, "ENOENT")) throw error
			return false
		}
		if (!(await wait.retry())) return false
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
	now: () => number,
): Promise<"held" | "wait" | false> {
	let owner: LockOwner | undefined
	try {
		const handle = await fs.open(
			join(lock, OWNER),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		)
		try {
			mtimeMs = (await handle.stat()).mtimeMs
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
	if (!owner) return now() - mtimeMs > HEARTBEAT_STALE_MS ? false : "wait"
	if (isStale(owner, current, await probeLockOwner(owner), now() - mtimeMs))
		return false
	return sameScope(owner, current) ? "held" : "wait"
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
async function acquireDirectory(
	lock: string,
	now: () => number,
): Promise<"acquired" | "held" | "wait"> {
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
			if (!before.isDirectory() || before.isSymbolicLink()) return "held"
			const held = await ownerIsHeld(lock, current, before.mtimeMs, now)
			if (held) return held
			// Claim before moving, then verify both inode and owner again: a legacy
			// publisher may have installed its live owner since our first observation.
			const claim = join(lock, ".reclaim")
			const claimed = await acquireDirectory(claim, now)
			if (claimed !== "acquired") return claimed
			const claimIdentity = await fs.lstat(claim)
			const stopClaim = await startLockHeartbeat(join(claim, OWNER))
			let moved = false
			try {
				const actual = await fs.lstat(lock)
				if (actual.ino !== before.ino || actual.dev !== before.dev)
					return "held"
				if (await ownerIsHeld(lock, current, before.mtimeMs, now)) return "held"
				const aside = `${lock}.stale-${randomUUID()}`
				await fs.rename(lock, aside)
				moved = true
				try {
					try {
						await fs.rename(prepared, lock)
					} catch (error) {
						if (isContended(error)) return "held"
						throw error
					}
				} finally {
					await fs.rm(aside, { recursive: true, force: true })
				}
			} finally {
				await stopClaim()
				if (!moved) {
					const actual = await fs.lstat(claim).catch((error: unknown) => {
						if (hasLockCode(error, "ENOENT")) return undefined
						throw error
					})
					if (
						actual?.ino === claimIdentity.ino &&
						actual.dev === claimIdentity.dev
					)
						await releaseWriterLock(claim)
				}
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
				if (isContended(error)) return "held"
				throw error
			}
		}
		await syncDirectory(dirname(lock))
		await cleanupStaleDirectories(lock)
		return "acquired"
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
	await heartbeats.get(lock)?.()
	heartbeats.delete(lock)
	const aside = `${lock}.stale-${randomUUID()}`
	await fs.rename(lock, aside)
	await fs.rm(aside, { recursive: true, force: true })
}
