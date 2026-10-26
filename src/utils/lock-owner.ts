import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import { createComponentLogger } from "./logger.js"
import type { Logger } from "./logger.js"

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
	// Linux owners need PID namespace evidence even when boot_id was unreadable.
	platform: z.string().optional(),
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
	platform?: () => string
}
const reader: OwnerReader = {
	platform: () => process.platform,
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
		platform: io.platform?.() ?? process.platform,
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
		(Boolean(recorded.pidNamespace) || Boolean(current.pidNamespace)
			? Boolean(recorded.pidNamespace) &&
				Boolean(current.pidNamespace) &&
				recorded.pidNamespace === current.pidNamespace
			: // No namespace on either side: only a known non-Linux platform
				// (no PID namespaces) may use local PID evidence.
				recorded.bootId.kind !== "linux" &&
				recorded.platform !== undefined &&
				recorded.platform !== "linux" &&
				current.platform !== undefined &&
				current.platform !== "linux")
	)
}
/** Wall time only selects fail-fast; an old timestamp never proves lease expiry. */
export function ownerHasRecentHeartbeat(
	recorded: LockOwner,
	current: LockOwner,
	probe: OwnerProbe,
	mtimeMs: number,
): boolean {
	return (
		sameScope(recorded, current) &&
		probe.alive &&
		recorded.startTime !== null &&
		probe.startTime !== null &&
		recorded.startTime.kind === probe.startTime.kind &&
		!identityDiffers(recorded.startTime, probe.startTime) &&
		Math.abs(Date.now() - mtimeMs) <=
			HEARTBEAT_STALE_MS + TIME_IDENTITY_TOLERANCE_MS
	)
}
export function isStale(
	recorded: LockOwner,
	current: LockOwner,
	probe: OwnerProbe,
	unchangedFor = 0,
): boolean {
	if (
		recorded.bootId?.kind === "linux" &&
		current.bootId?.kind === "linux" &&
		recorded.bootId.value !== current.bootId.value
	)
		return true
	if (unchangedFor >= HEARTBEAT_STALE_MS) return true
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
export interface LockWaitOptions {
	/** Monotonic milliseconds; never a wall clock. */
	now?: () => number
	sleep?: (ms: number) => Promise<void>
	logger?: Logger
	/** Test-only hook at the last heartbeat recheck before reclaim. */
	beforeReclaim?: () => Promise<void>
	onLost?: () => void
}
export function heartbeatValue(stat: {
	dev: number
	ino: number
	size: number
	mtimeMs: number
}): string {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
}
export function lockWait(options: LockWaitOptions = {}) {
	const now = options.now ?? (() => performance.now())
	const sleep =
		options.sleep ??
		(ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
	const started = now()
	const observations = new Map<string, { value: string; since: number }>()
	const log = options.logger
		? createComponentLogger(options.logger, "StorageLock")
		: undefined
	let logged = false
	return {
		now,
		value: (path: string) => observations.get(path)?.value,
		observe: (path: string, value: string) => {
			let previous = observations.get(path)
			if (!previous || previous.value !== value) {
				previous = { value, since: now() }
				observations.set(path, previous)
			}
			return Math.max(0, Math.min(LOCK_WAIT_MS, now() - previous.since))
		},
		retry: async () => {
			const elapsed = Math.max(0, now() - started)
			if (elapsed >= LOCK_WAIT_MS) return false
			if (!logged) {
				log?.info("Waiting for storage lock heartbeat")
				logged = true
			}
			await sleep(Math.min(HEARTBEAT_MS, LOCK_WAIT_MS - elapsed))
			return true
		},
	}
}
export interface LockHeartbeat {
	(): Promise<void>
	readonly lost: boolean
	check: () => Promise<boolean>
}
export async function startLockHeartbeat(
	path: string,
	options: {
		onLost?: () => void
		verify?: () => Promise<boolean>
		logger?: Logger
	} = {},
): Promise<LockHeartbeat> {
	const log = options.logger
		? createComponentLogger(options.logger, "StorageLock")
		: undefined
	const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
	const identity = await handle.stat()
	let lost = false
	let stopped = false
	let pending = Promise.resolve()
	const lose = () => {
		if (lost) return
		lost = true
		clearInterval(timer)
		options.onLost?.()
	}
	const check = async () => {
		if (lost || stopped) return false
		try {
			const [actual, opened] = await Promise.all([
				fs.lstat(path),
				handle.stat(),
			])
			if (
				actual.dev !== opened.dev ||
				actual.ino !== opened.ino ||
				actual.dev !== identity.dev ||
				actual.ino !== identity.ino ||
				(options.verify && !(await options.verify()))
			) {
				lose()
				return false
			}
			return !lost && !stopped
		} catch {
			lose()
			return false
		}
	}
	const timer = setInterval(() => {
		pending = pending
			.then(async () => {
				if (!(await check())) return
				const now = new Date()
				await handle.utimes(now, now)
			})
			.catch(() => {
				lose()
				log?.warn("Storage lock heartbeat refresh failed")
			})
	}, HEARTBEAT_MS)
	timer.unref()
	let closing: Promise<void> | undefined
	const stop = () => {
		closing ??= (async () => {
			clearInterval(timer)
			await pending
			stopped = true
			await handle.close()
		})()
		return closing
	}
	Object.defineProperty(stop, "lost", { get: () => lost })
	return Object.assign(stop, { check }) as LockHeartbeat
}
const OWNER = "owner.json"
export interface WriterLock {
	readonly lost: boolean
	check: () => Promise<boolean>
	stop: () => Promise<void>
	release: () => Promise<void>
}
async function writerHandle(
	lock: string,
	options: LockWaitOptions,
	expected: {
		directory: { dev: number; ino: number }
		ownerIdentity: { dev: number; ino: number }
		contents: string
	},
): Promise<WriterLock> {
	const { directory, ownerIdentity, contents } = expected
	const verify = async () => {
		const actual = await fs.lstat(lock)
		const ownerActual = await fs.lstat(join(lock, OWNER))
		return (
			ownerActual.dev === ownerIdentity.dev &&
			ownerActual.ino === ownerIdentity.ino &&
			actual.dev === directory.dev &&
			actual.ino === directory.ino &&
			(await fs.readFile(join(lock, OWNER), "utf8")) === contents
		)
	}
	const heartbeat = await startLockHeartbeat(join(lock, OWNER), {
		...options,
		verify,
	})
	return {
		get lost() {
			return heartbeat.lost
		},
		check: heartbeat.check,
		stop: heartbeat,
		release: async () => {
			let ours = false
			try {
				ours = await heartbeat.check()
			} finally {
				await heartbeat()
			}
			if (!ours || !(await verify().catch(() => false))) return
			const aside = `${lock}.stale-${randomUUID()}`
			await fs.rename(lock, aside)
			await fs.rm(aside, { recursive: true, force: true })
		},
	}
}
export async function acquireWriterLock(
	lock: string,
	options: LockWaitOptions = {},
): Promise<WriterLock | false> {
	const wait = lockWait(options)
	for (;;) {
		try {
			const result = await acquireDirectory(lock, wait, options)
			if (typeof result !== "string") return result
			if (result === "held") return false
		} catch (error) {
			if (!hasLockCode(error, "ENOENT")) throw error
			return false
		}
		if (!(await wait.retry())) return false
	}
}
export async function releaseWriterLock(lock: WriterLock): Promise<void> {
	await lock.release()
}
function isContended(error: unknown): boolean {
	return ["ENOTEMPTY", "EEXIST", "EISDIR", "ENOTDIR"].some(code =>
		hasLockCode(error, code),
	)
}
async function ownerIsHeld(
	lock: string,
	current: LockOwner,
	wait: ReturnType<typeof lockWait>,
): Promise<"held" | "wait" | false> {
	let owner: LockOwner | undefined
	let stat = await fs.lstat(lock)
	try {
		const handle = await fs.open(
			join(lock, OWNER),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		)
		try {
			stat = await handle.stat()
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
	const unchangedFor = wait.observe(lock, heartbeatValue(stat))
	// Observe abandoned sibling claims concurrently with the holder, so both
	// reach 3H within the same 3H + H acquisition budget after a container kill.
	try {
		const claim = `${lock}.reclaim`
		const claimStat = await fs.lstat(claim)
		if (claimStat.isDirectory() && !claimStat.isSymbolicLink())
			await ownerIsHeld(claim, current, wait)
	} catch (error) {
		if (!hasLockCode(error, "ENOENT") && !hasLockCode(error, "ENAMETOOLONG"))
			throw error
	}
	if (!owner) return unchangedFor >= HEARTBEAT_STALE_MS ? false : "wait"
	const probe = await probeLockOwner(owner)
	if (isStale(owner, current, probe, unchangedFor)) return false
	// A matching live owner with a recent heartbeat should reject CLI contenders
	// immediately. A clock step only selects observation, never immediate reclaim.
	return ownerHasRecentHeartbeat(owner, current, probe, stat.mtimeMs)
		? "held"
		: "wait"
}
async function currentHeartbeatValue(lock: string): Promise<string> {
	try {
		return heartbeatValue(await fs.lstat(join(lock, OWNER)))
	} catch (error) {
		if (!hasLockCode(error, "ENOENT")) throw error
		return heartbeatValue(await fs.lstat(lock))
	}
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
	wait: ReturnType<typeof lockWait>,
	options: LockWaitOptions,
): Promise<WriterLock | "held" | "wait"> {
	const current = await readLockOwner()
	const prepared = `${lock}.new-${randomUUID()}`
	await fs.mkdir(prepared, { mode: 0o700 })
	try {
		const contents = JSON.stringify({ ...current, nonce: randomUUID() })
		const temp = join(prepared, `${randomUUID()}.tmp`)
		const handle = await fs.open(temp, "wx", 0o600)
		try {
			await handle.writeFile(contents)
			await handle.sync()
		} finally {
			await handle.close()
		}
		await fs.rename(temp, join(prepared, OWNER))
		await syncDirectory(prepared)
		const expected = {
			directory: await fs.lstat(prepared),
			ownerIdentity: await fs.lstat(join(prepared, OWNER)),
			contents,
		}

		const before = await fs.lstat(lock).catch((error: unknown) => {
			if (hasLockCode(error, "ENOENT")) return undefined
			throw error
		})
		if (before) {
			if (!before.isDirectory() || before.isSymbolicLink()) return "held"
			const held = await ownerIsHeld(lock, current, wait)
			if (held) return held
			// Claim before moving, then verify both inode and owner again: a legacy
			// publisher may have installed its live owner since our first observation.
			// A sibling claim leaves legacy directory heartbeat metadata untouched.
			const claim = `${lock}.reclaim`
			const claimed = await acquireDirectory(
				claim,
				wait,
				options.logger ? { logger: options.logger } : {},
			)
			if (typeof claimed === "string") return claimed
			const claimHandle = claimed
			try {
				const actual = await fs.lstat(lock)
				if (actual.ino !== before.ino || actual.dev !== before.dev)
					return "held"
				const observed = wait.value(lock)
				const recheck = await ownerIsHeld(lock, current, wait)
				if (wait.value(lock) !== observed) return "wait"
				if (recheck) return recheck
				await options.beforeReclaim?.()
				const finalValue = await currentHeartbeatValue(lock)
				if (finalValue !== observed) {
					wait.observe(lock, finalValue)
					return "wait"
				}
				// A reclaimer paused between this final heartbeat read and rename can
				// take a lock refreshed during its own pause. Without fencing tokens,
				// this advisory lease cannot close that window. The old holder notices
				// the loss within H = 10 s and stops writing; at most the write already
				// in flight can land.
				const aside = `${lock}.stale-${randomUUID()}`
				await fs.rename(lock, aside)
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
				await claimHandle.release()
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
		return await writerHandle(lock, options, expected)
	} finally {
		// Never clean the public lock on failure: only our private sibling is ours.
		await fs.rm(prepared, { recursive: true, force: true })
	}
}
async function cleanupStaleDirectories(lock: string): Promise<void> {
	const prefixes = [`${basename(lock)}.stale-`]
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
	try {
		for (const entry of await fs.readdir(dirname(lock))) {
			const prefix = prefixes.find(value => entry.startsWith(value))
			if (!prefix || !uuid.test(entry.slice(prefix.length))) continue
			try {
				const path = join(dirname(lock), entry)
				const stat = await fs.lstat(path)
				if (stat.isDirectory() && !stat.isSymbolicLink())
					await fs.rm(path, { recursive: true, force: true })
			} catch {
				// A concurrent acquirer may already have cleaned this sibling.
			}
		}
	} catch {
		// Sibling cleanup must not fail a successfully published lock.
	}
}
