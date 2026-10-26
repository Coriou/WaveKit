import type { Logger } from "../utils/logger.js"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { z } from "zod"
import {
	lockWait,
	heartbeatValue,
	ownerHasRecentHeartbeat,
	startLockHeartbeat,
	isStale,
	lockOwnerSchema,
	probeLockOwner,
	readLockOwner,
} from "../utils/lock-owner.js"
import type { LockHeartbeat, LockWaitOptions } from "../utils/lock-owner.js"
import { WaveKitError } from "../utils/errors.js"
import {
	digestMachineToken,
	generateMachineToken,
	isCanonicalToken,
	sessionCredentialBinding,
} from "./credentials.js"
import type { AccessRandomBytes } from "./credentials.js"
import { sessionSnapshotSchema } from "./schema.js"
import type { SessionSnapshot } from "./sessions.js"

const STATE = "access-state.json"
const MARKER = "initialized"
const MARKER_CONTENT = "wavekit-private-access-v1\n"
const MAX_BYTES = 64 * 1024
const LIFETIME = 30 * 24 * 60 * 60 * 1000
const ownerName = /^owner-([1-9][0-9]*)-([a-f0-9-]{36})\.lock$/
const ownerSchema = z
	.object({
		identity: lockOwnerSchema.optional(),
		version: z.literal(1),
		pid: z.number().int().positive().max(0x7fffffff),
		scope: z.string().regex(/^[a-f0-9]{64}$/),
		nonce: z.string().uuid(),
	})
	.strict()
/**
 * Envelope version stays 1. Device name, kind and last-seen migrate inside
 * `sessions` (snapshot version 2). An older WaveKit rejects that inner version
 * while parsing the envelope and fails closed; a second envelope version is
 * not required for the embedding.
 */
const stateSchema = z
	.object({
		version: z.literal(1),
		machineToken: z.string().refine(isCanonicalToken),
		credentialBinding: z.string().regex(/^[a-f0-9]{64}$/),
		sessions: sessionSnapshotSchema,
	})
	.strict()
const optionsSchema = z.object({
	directory: z.string().min(1).max(4096).refine(isAbsolute),
	mode: z.enum(["load", "provision"]),
	ownership: z.literal("single-host-pid-namespace"),
})
type PrivateState = z.infer<typeof stateSchema>

export interface PrivateAccessStorageOptions {
	directory: string
	mode: "load" | "provision"
	/** Dedicated local directory, never shared across hosts or PID namespaces. */
	ownership: "single-host-pid-namespace"
	random?: AccessRandomBytes
	logger?: Logger
	lockWait?: LockWaitOptions
}

export interface ReadMachineCredentialOptions {
	directory: string
}

function failure(code: string): WaveKitError {
	return new WaveKitError("Private access storage unavailable", code)
}

function hasCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	)
}

/** Legacy scope hash remains a local PID-evidence boundary. */
async function processScope(): Promise<string> {
	const uid = process.getuid?.()
	if (uid === undefined) throw failure("ACCESS_STORAGE_SCOPE_UNSUPPORTED")
	let scope: string
	if (process.platform === "linux") {
		const [boot, namespace] = await Promise.all([
			fs
				.readFile("/proc/sys/kernel/random/boot_id", "utf8")
				.catch(() => "unknown"),
			fs.readlink("/proc/self/ns/pid").catch(() => "unknown"),
		])
		scope = `linux:${hostname()}:${uid}:${boot.trim()}:${namespace}`
	} else if (process.platform === "darwin")
		scope = `darwin:${hostname()}:${uid}`
	else throw failure("ACCESS_STORAGE_SCOPE_UNSUPPORTED")
	return createHash("sha256").update(scope).digest("hex")
}

function validateSnapshot(input: unknown, binding: string): SessionSnapshot {
	// Structural validation applies on every write. SessionStore.open owns the
	// startup clock check; a running store's monotonic clock can outlive wall jumps.
	const result = sessionSnapshotSchema.safeParse(input)
	if (!result.success || result.data.credentialBinding !== binding)
		throw failure("ACCESS_STORAGE_INVALID")
	const ids = new Set<string>()
	const hashes = new Set<string>()
	for (const record of result.data.sessions) {
		if (
			ids.has(record.deviceId) ||
			hashes.has(record.tokenHash) ||
			!isCanonicalToken(record.deviceId.slice(7)) ||
			!isCanonicalToken(record.csrfToken) ||
			digestMachineToken(record.csrfToken).toString("hex") ===
				record.tokenHash ||
			record.createdAt > record.renewedAt ||
			record.expiresAt <= record.renewedAt ||
			record.expiresAt - record.renewedAt > LIFETIME
		)
			throw failure("ACCESS_STORAGE_INVALID")
		ids.add(record.deviceId)
		hashes.add(record.tokenHash)
	}
	return result.data
}

/**
 * One process owns this dedicated local directory until close(). Each open first
 * publishes its own unique owner file, then rejects a recent matching live
 * owner (even the same PID) or observes an old heartbeat until release or expiry.
 * Concurrent contenders may both refuse;
 * retry after graceful cleanup. PID evidence is trusted only within the same
 * scope. Owners are held while their heartbeat is fresh and reclaimed after
 * its lease expires.
 *
 * Parent directories must be trusted/stable. Existing selected directories/files
 * must already be private and owned by this uid; unrelated paths are never chmod'd.
 * Await open before listeners. Keep this owner for SessionStore's whole lifetime;
 * close the authority before close(). Setup runs stopped; a later command pairs
 * with a running core through authenticated requests to an explicit trusted target.
 *
 * One atomic state holds the reusable credential and bounded hashed sessions.
 * persist resolves only after file+directory fsync; failures latch unavailable.
 * A failure after rename has an uncertain disk outcome, never a success claim.
 * Restart reloads validated disk state; no rollback can promise undo after rename.
 */
export class PrivateAccessStorage {
	#directory: string
	#handle: FileHandle
	#directoryIdentity: { dev: number; ino: number }
	#stopHeartbeat: LockHeartbeat | undefined
	#ownershipLost = false
	#owner = ""
	#ownerIdentity: { dev: number; ino: number } | undefined
	#state: PrivateState | undefined
	#created = false
	#closed = false
	#unavailable = false
	#queue: Promise<void> = Promise.resolve()

	private constructor(
		directory: string,
		handle: FileHandle,
		identity: { dev: number; ino: number },
	) {
		this.#directory = directory
		this.#handle = handle
		this.#directoryIdentity = identity
	}

	/**
	 * Read-only machine-client boundary, including while the core writer is live.
	 * Reuses the initialized-state/file validators; never acquires/reaps owners,
	 * creates files/directories, chmods or persists. Parent paths must be trusted
	 * and stable. No storage instance escapes; the callback alone receives the
	 * sensitive token. Check a caller deadline inside that callback before I/O.
	 */
	static async readMachineCredential<T>(
		options: ReadMachineCredentialOptions,
		consumer: (token: string) => T | Promise<T>,
	): Promise<T> {
		const parsed = z
			.object({
				directory: z
					.string()
					.min(1)
					.max(4096)
					.refine(isAbsolute)
					.refine(value => !value.includes("\0")),
			})
			.strict()
			.safeParse(options)
		if (!parsed.success || typeof consumer !== "function")
			throw failure("ACCESS_CREDENTIAL_UNAVAILABLE")
		let handle: FileHandle | undefined
		let token: string
		try {
			const uid = process.getuid?.()
			if (uid === undefined) throw failure("ACCESS_CREDENTIAL_UNAVAILABLE")
			const stat = await fs.lstat(parsed.data.directory)
			if (
				!stat.isDirectory() ||
				stat.isSymbolicLink() ||
				stat.uid !== uid ||
				(stat.mode & 0o7777) !== 0o700
			)
				throw failure("ACCESS_CREDENTIAL_UNAVAILABLE")
			handle = await fs.open(
				parsed.data.directory,
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			)
			const reader = new PrivateAccessStorage(
				parsed.data.directory,
				handle,
				stat,
			)
			await reader.#assertDirectory()
			await reader.#load("load", undefined)
			await reader.#assertDirectory()
			token = reader.#current().machineToken
			reader.#state = undefined
			reader.#closed = true
		} catch {
			throw failure("ACCESS_CREDENTIAL_UNAVAILABLE")
		} finally {
			await handle?.close().catch(() => {
				throw failure("ACCESS_CREDENTIAL_UNAVAILABLE")
			})
		}
		try {
			return await consumer(token)
		} catch {
			throw failure("ACCESS_CREDENTIAL_UNAVAILABLE")
		}
	}

	static async open(
		options: PrivateAccessStorageOptions,
	): Promise<PrivateAccessStorage> {
		const parsed = optionsSchema.safeParse(options)
		if (
			!parsed.success ||
			(options.random !== undefined && typeof options.random !== "function")
		)
			throw failure("ACCESS_STORAGE_INVALID")
		let storage: PrivateAccessStorage | undefined
		let handle: FileHandle | undefined
		try {
			const scope = await processScope()
			let createdDirectory = false
			if (options.mode === "provision") {
				try {
					await fs.mkdir(options.directory, { mode: 0o700 })
					createdDirectory = true
				} catch (error) {
					if (!hasCode(error, "EEXIST")) throw error
				}
			}
			const stat = await fs.lstat(options.directory).catch(error => {
				if (options.mode === "load" && hasCode(error, "ENOENT"))
					throw failure("ACCESS_STORAGE_MISSING")
				throw error
			})
			if (
				!stat.isDirectory() ||
				stat.isSymbolicLink() ||
				stat.uid !== process.getuid?.() ||
				(!createdDirectory && (stat.mode & 0o7777) !== 0o700)
			)
				throw failure("ACCESS_STORAGE_UNSAFE")
			handle = await fs.open(
				options.directory,
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			)
			if (createdDirectory) {
				await handle.chmod(0o700)
				const parent = await fs.open(
					dirname(options.directory),
					constants.O_RDONLY | constants.O_DIRECTORY,
				)
				try {
					await parent.sync()
				} finally {
					await parent.close()
				}
			}
			storage = new PrivateAccessStorage(options.directory, handle, stat)
			await storage.#assertDirectory()
			await storage.#acquire(scope, {
				...options.lockWait,
				...(options.logger ? { logger: options.logger } : {}),
			})
			await storage.#load(options.mode, options.random)
			return storage
		} catch (error) {
			if (storage) await storage.close().catch(() => undefined)
			else if (handle) await handle.close().catch(() => undefined)
			if (error instanceof WaveKitError) throw error
			throw failure("ACCESS_STORAGE_UNAVAILABLE")
		}
	}

	get created(): boolean {
		return this.#created
	}
	get unavailable(): boolean {
		return this.#unavailable
	}
	get credentialBinding(): string {
		return this.#current().credentialBinding
	}

	machineSecretDigest(): Buffer {
		return digestMachineToken(this.#current().machineToken)
	}

	/** Sensitive callback for local/allowed-target machine clients; never log it. */
	useMachineCredential<T>(consumer: (token: string) => T): T {
		return consumer(this.#current().machineToken)
	}

	startupSnapshot(): SessionSnapshot {
		return structuredClone(this.#current().sessions)
	}

	#current(): PrivateState {
		if (this.#ownershipLost) throw failure("ACCESS_STORAGE_BUSY")
		if (this.#closed || this.#unavailable || !this.#state)
			throw failure("ACCESS_STORAGE_UNAVAILABLE")
		return this.#state
	}

	async #assertDirectory(): Promise<void> {
		const [path, opened] = await Promise.all([
			fs.lstat(this.#directory),
			this.#handle.stat(),
		])
		if (
			!path.isDirectory() ||
			path.isSymbolicLink() ||
			path.dev !== this.#directoryIdentity.dev ||
			path.ino !== this.#directoryIdentity.ino ||
			opened.dev !== path.dev ||
			opened.ino !== path.ino ||
			path.uid !== process.getuid?.() ||
			(path.mode & 0o7777) !== 0o700
		)
			throw failure("ACCESS_STORAGE_UNSAFE")
	}

	async #read(name: string, limit: number): Promise<string | undefined> {
		const path = join(this.#directory, name)
		let stat
		try {
			stat = await fs.lstat(path)
		} catch (error) {
			if (hasCode(error, "ENOENT")) return undefined
			throw error
		}
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.nlink !== 1 ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o7777) !== 0o600 ||
			stat.size > limit
		)
			throw failure("ACCESS_STORAGE_UNSAFE")
		let handle: FileHandle
		try {
			handle = await fs.open(
				path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			)
		} catch (error) {
			if (hasCode(error, "ENOENT")) return undefined
			throw error
		}
		try {
			const opened = await handle.stat()
			if (
				!opened.isFile() ||
				opened.uid !== process.getuid?.() ||
				(opened.mode & 0o7777) !== 0o600 ||
				opened.dev !== stat.dev ||
				opened.ino !== stat.ino ||
				opened.nlink !== 1 ||
				opened.size > limit
			)
				throw failure("ACCESS_STORAGE_UNSAFE")
			const buffer = Buffer.alloc(limit + 1)
			let total = 0
			while (total < buffer.length) {
				const read = await handle.read(
					buffer,
					total,
					buffer.length - total,
					total,
				)
				if (read.bytesRead === 0) break
				total += read.bytesRead
			}
			if (total > limit) throw failure("ACCESS_STORAGE_UNSAFE")
			return buffer.subarray(0, total).toString("utf8")
		} finally {
			await handle.close()
		}
	}

	async #acquire(
		scope: string,
		options: LockWaitOptions | undefined,
	): Promise<void> {
		const wait = lockWait(options)
		const nonce = randomUUID()
		const identity = await readLockOwner()
		this.#owner = `owner-${process.pid}-${nonce}.lock`
		const handle = await fs.open(
			join(this.#directory, this.#owner),
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		)
		try {
			await handle.chmod(0o600)
			const stat = await handle.stat()
			this.#ownerIdentity = { dev: stat.dev, ino: stat.ino }
			await handle.writeFile(
				JSON.stringify({
					version: 1,
					pid: process.pid,
					scope,
					nonce,
					identity,
				}),
			)
			await handle.sync()
		} finally {
			await handle.close()
		}
		this.#stopHeartbeat = await startLockHeartbeat(
			join(this.#directory, this.#owner),
			{
				...options,
				onLost: () => {
					this.#ownershipLost = true
					this.#unavailable = true
				},
			},
		)
		const entries = await fs.readdir(this.#directory)
		if (entries.length > 64)
			throw failure("ACCESS_STORAGE_OWNERSHIP_UNVERIFIED")
		for (const entry of entries) {
			if (entry === this.#owner || !entry.startsWith("owner-")) continue
			const match = ownerName.exec(entry)
			if (!match) throw failure("ACCESS_STORAGE_OWNERSHIP_UNVERIFIED")
			// Identity includes a full hostname; reuse the existing bounded metadata read.
			const data = await this.#read(entry, MAX_BYTES)
			if (data === undefined) continue
			let decoded: unknown
			try {
				decoded = JSON.parse(data)
			} catch {
				throw failure("ACCESS_STORAGE_OWNERSHIP_UNVERIFIED")
			}
			const owner = ownerSchema.safeParse(decoded)
			if (
				!owner.success ||
				owner.data.pid !== Number(match[1]) ||
				owner.data.nonce !== match[2]
			)
				throw failure("ACCESS_STORAGE_OWNERSHIP_UNVERIFIED")
			const recorded = owner.data.identity
			if (recorded && recorded.pid !== owner.data.pid)
				throw failure("ACCESS_STORAGE_OWNERSHIP_UNVERIFIED")
			const path = join(this.#directory, entry)
			for (;;) {
				const stat = await fs.lstat(path).catch(error => {
					if (hasCode(error, "ENOENT")) return undefined
					throw error
				})
				if (!stat) break
				const candidate = recorded ?? {
					...identity,
					pid: owner.data.pid,
					// Legacy records never recorded a start time; do not borrow ours.
					startTime: null,
					...(owner.data.scope !== scope
						? { bootId: null, startTime: null }
						: {}),
				}
				const probe = await probeLockOwner(candidate)
				if (
					isStale(
						candidate,
						identity,
						probe,
						wait.observe(path, heartbeatValue(stat)),
					)
				) {
					await options?.beforeReclaim?.()
					const latest = await fs.lstat(path).catch(error => {
						if (hasCode(error, "ENOENT")) return undefined
						throw error
					})
					if (!latest) break
					if (heartbeatValue(latest) !== heartbeatValue(stat)) {
						wait.observe(path, heartbeatValue(latest))
						if (!(await wait.retry())) throw failure("ACCESS_STORAGE_BUSY")
						continue
					}
					// A reclaimer paused between this final heartbeat read and unlink can
					// take a lock refreshed during its own pause. Without fencing tokens,
					// this advisory lease cannot close that window. The old holder notices
					// the loss within H = 10 s and stops writing; at most the write already
					// in flight can land.
					await fs.unlink(path).catch(error => {
						if (!hasCode(error, "ENOENT")) throw error
					})
					break
				}
				const code =
					owner.data.scope !== scope
						? "ACCESS_STORAGE_FOREIGN_OWNER"
						: "ACCESS_STORAGE_BUSY"
				// Recent, matching live owners reject immediately; old wall timestamps
				// only select monotonic observation, including after a clock step.
				if (
					ownerHasRecentHeartbeat(candidate, identity, probe, stat.mtimeMs) ||
					!(await wait.retry())
				)
					throw failure(code)
			}
		}
	}

	async #load(
		mode: "load" | "provision",
		random: AccessRandomBytes | undefined,
	): Promise<void> {
		const marker = await this.#read(MARKER, 64)
		const text = await this.#read(STATE, MAX_BYTES)
		if (text === undefined) {
			if (
				marker !== undefined ||
				(await fs.readdir(this.#directory)).some(entry => entry !== this.#owner)
			)
				throw failure("ACCESS_STORAGE_INCOMPLETE")
			if (mode !== "provision") throw failure("ACCESS_STORAGE_MISSING")
			const machineToken = generateMachineToken(random)
			const binding = sessionCredentialBinding(digestMachineToken(machineToken))
			const state: PrivateState = {
				version: 1,
				machineToken,
				credentialBinding: binding,
				sessions: { version: 2, credentialBinding: binding, sessions: [] },
			}
			// Persist setup intent first: a failed/incomplete setup is never regenerated.
			await this.#atomic(MARKER, MARKER_CONTENT, true)
			await this.#atomic(STATE, JSON.stringify(state), true)
			this.#state = state
			this.#created = true
			return
		}
		if (marker !== MARKER_CONTENT) throw failure("ACCESS_STORAGE_INCOMPLETE")
		let input: unknown
		try {
			input = JSON.parse(text)
		} catch {
			throw failure("ACCESS_STORAGE_INVALID")
		}
		const result = stateSchema.safeParse(input)
		if (
			!result.success ||
			result.data.credentialBinding !==
				sessionCredentialBinding(digestMachineToken(result.data.machineToken))
		)
			throw failure("ACCESS_STORAGE_INVALID")
		validateSnapshot(result.data.sessions, result.data.credentialBinding)
		this.#state = result.data
	}

	/**
	 * `latch: "integrity"` (last-seen writes) still latches on every integrity check
	 * (directory identity before and after the write, marker, missing state) but not on a
	 * failed open, write, sync, rename or directory sync: the previous state file stays
	 * authoritative and the next full commit rewrites it.
	 */
	async #atomic(
		name: string,
		content: string,
		initial = false,
		latch: "always" | "integrity" = "always",
	): Promise<void> {
		const temp = join(this.#directory, `.${name}-${randomUUID()}.tmp`)
		let handle: FileHandle | undefined
		let ownedTemp = false
		let writing = false
		try {
			if (Buffer.byteLength(content) > MAX_BYTES)
				throw failure("ACCESS_STORAGE_INVALID")
			await this.#assertDirectory()
			const existing = await this.#read(name, MAX_BYTES)
			if (
				(initial && existing !== undefined) ||
				(!initial && existing === undefined)
			)
				throw failure("ACCESS_STORAGE_INCOMPLETE")
			if (name === STATE && (await this.#read(MARKER, 64)) !== MARKER_CONTENT)
				throw failure("ACCESS_STORAGE_INCOMPLETE")
			writing = true
			handle = await fs.open(
				temp,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW,
				0o600,
			)
			ownedTemp = true
			await handle.chmod(0o600)
			await handle.writeFile(content, "utf8")
			await handle.sync()
			await handle.close()
			handle = undefined
			writing = false
			await this.#assertDirectory()
			writing = true
			if (this.#unavailable || !(await this.#stopHeartbeat?.check()))
				throw failure("ACCESS_STORAGE_BUSY")
			await fs.rename(temp, join(this.#directory, name))
			ownedTemp = false
			await this.#handle.sync()
		} catch {
			if (latch === "always" || !writing) this.#unavailable = true
			if (this.#ownershipLost) throw failure("ACCESS_STORAGE_BUSY")
			throw failure("ACCESS_STORAGE_UNAVAILABLE")
		} finally {
			if (handle) await handle.close().catch(() => undefined)
			if (ownedTemp) await fs.unlink(temp).catch(() => undefined)
		}
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const task = this.#queue.then(operation)
		this.#queue = task.then(
			() => undefined,
			() => undefined,
		)
		return task
	}

	/** Pass directly as SessionStore's required persistence hook. */
	persist = (snapshot: SessionSnapshot): Promise<void> => {
		let copy: unknown
		try {
			copy = structuredClone(snapshot)
		} catch {
			return Promise.reject(failure("ACCESS_STORAGE_INVALID"))
		}
		return this.#serialize(async () => {
			const current = this.#current()
			const sessions = validateSnapshot(copy, current.credentialBinding)
			const next = { ...current, sessions }
			await this.#atomic(STATE, JSON.stringify(next))
			this.#state = next
		})
	}

	/**
	 * WG2 req 11.6: last-seen persistence. Same validation and atomic replace as `persist`, but a
	 * failed write does not mark the storage unavailable (see #atomic), so one bad hourly write
	 * never locks out logins.
	 */
	persistSeen = (snapshot: SessionSnapshot): Promise<void> => {
		let copy: unknown
		try {
			copy = structuredClone(snapshot)
		} catch {
			return Promise.reject(failure("ACCESS_STORAGE_INVALID"))
		}
		return this.#serialize(async () => {
			const current = this.#current()
			const sessions = validateSnapshot(copy, current.credentialBinding)
			const next = { ...current, sessions }
			await this.#atomic(STATE, JSON.stringify(next), false, "integrity")
			this.#state = next
		})
	}

	/**
	 * Stopped-authority rotation. The same durable write replaces the credential
	 * and, by default, removes remembered sessions. `keepSessions` rebinds them
	 * to the new generation instead. Old-binding persistence hooks still reject,
	 * so a live store cannot write the previous generation.
	 */
	rotateMachineCredential(options?: {
		random?: AccessRandomBytes
		keepSessions?: boolean
	}): Promise<void> {
		const random = options?.random
		const keepSessions = options?.keepSessions === true
		return this.#serialize(async () => {
			const current = this.#current()
			let machineToken = generateMachineToken(random)
			for (
				let attempt = 1;
				machineToken === current.machineToken && attempt < 8;
				attempt++
			)
				machineToken = generateMachineToken(random)
			if (machineToken === current.machineToken)
				throw failure("ACCESS_STORAGE_ROTATION_FAILED")
			const binding = sessionCredentialBinding(digestMachineToken(machineToken))
			const sessions = validateSnapshot(
				{
					version: 2,
					credentialBinding: binding,
					sessions: keepSessions
						? current.sessions.sessions.map(record => ({ ...record }))
						: [],
				},
				binding,
			)
			const next: PrivateState = {
				version: 1,
				machineToken,
				credentialBinding: binding,
				sessions,
			}
			await this.#atomic(STATE, JSON.stringify(next))
			this.#state = next
		})
	}

	close(): Promise<void> {
		return this.#serialize(async () => {
			if (this.#closed) return
			this.#closed = true
			await this.#stopHeartbeat?.()
			this.#stopHeartbeat = undefined
			let failed = false
			try {
				await this.#assertDirectory()
				if (this.#ownerIdentity) {
					const stat = await fs
						.lstat(join(this.#directory, this.#owner))
						.catch(error => {
							if (hasCode(error, "ENOENT")) return undefined
							throw error
						})
					if (
						stat?.isFile() &&
						stat.dev === this.#ownerIdentity.dev &&
						stat.ino === this.#ownerIdentity.ino
					)
						await fs.unlink(join(this.#directory, this.#owner))
				}
			} catch {
				failed = true
			}
			try {
				await this.#handle.close()
			} catch {
				failed = true
			}
			if (failed) throw failure("ACCESS_STORAGE_UNAVAILABLE")
		})
	}
}
