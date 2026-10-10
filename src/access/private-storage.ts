import { constants } from "node:fs"
import fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { z } from "zod"
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
		version: z.literal(1),
		pid: z.number().int().positive().max(0x7fffffff),
		scope: z.string().regex(/^[a-f0-9]{64}$/),
		nonce: z.string().uuid(),
	})
	.strict()
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

/** ESRCH is trusted only within this scope; foreign scope requires offline repair. */
async function processScope(): Promise<string> {
	const uid = process.getuid?.()
	if (uid === undefined) throw failure("ACCESS_STORAGE_SCOPE_UNSUPPORTED")
	let identity: string
	if (process.platform === "linux") {
		const [boot, namespace] = await Promise.all([
			fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
			fs.readlink("/proc/self/ns/pid"),
		])
		if (!/^[a-f0-9-]{36}\n?$/.test(boot) || !/^pid:\[[0-9]+\]$/.test(namespace))
			throw failure("ACCESS_STORAGE_SCOPE_UNSUPPORTED")
		identity = `linux:${hostname()}:${uid}:${boot.trim()}:${namespace}`
	} else if (process.platform === "darwin") {
		// macOS has one host PID namespace. The explicit local-only contract
		// excludes network/shared directories; unknown owners remain fail-closed.
		identity = `darwin:${hostname()}:${uid}`
	} else throw failure("ACCESS_STORAGE_SCOPE_UNSUPPORTED")
	return createHash("sha256").update(identity).digest("hex")
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
 * publishes its own unique owner file, then rejects ANY other live owner (even
 * the same PID). Concurrent contenders may both refuse; retry after graceful
 * cleanup. Only validated, immutable owner paths in the SAME scope with ESRCH
 * are reaped. EPERM, foreign/unverifiable namespace and unknown files never grant
 * ownership. Foreign/stale-unverifiable recovery is an explicit offline operation.
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
			try {
				await fs.mkdir(options.directory, { mode: 0o700 })
				createdDirectory = true
			} catch (error) {
				if (!hasCode(error, "EEXIST")) throw error
			}
			const stat = await fs.lstat(options.directory)
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
			await storage.#acquire(scope)
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

	async #acquire(scope: string): Promise<void> {
		const nonce = randomUUID()
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
				JSON.stringify({ version: 1, pid: process.pid, scope, nonce }),
			)
			await handle.sync()
		} finally {
			await handle.close()
		}
		const entries = await fs.readdir(this.#directory)
		if (entries.length > 64)
			throw failure("ACCESS_STORAGE_OWNERSHIP_UNVERIFIED")
		for (const entry of entries) {
			if (entry === this.#owner || !entry.startsWith("owner-")) continue
			const match = ownerName.exec(entry)
			if (!match) throw failure("ACCESS_STORAGE_OWNERSHIP_UNVERIFIED")
			const data = await this.#read(entry, 512)
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
			if (owner.data.scope !== scope)
				throw failure("ACCESS_STORAGE_FOREIGN_OWNER")
			try {
				process.kill(owner.data.pid, 0)
				throw failure("ACCESS_STORAGE_BUSY")
			} catch (error) {
				if (!hasCode(error, "ESRCH")) throw failure("ACCESS_STORAGE_BUSY")
			}
			// The unique immutable path cannot name a later owner's different nonce.
			await fs.unlink(join(this.#directory, entry)).catch(error => {
				if (!hasCode(error, "ENOENT")) throw error
			})
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
				sessions: { version: 1, credentialBinding: binding, sessions: [] },
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

	async #atomic(name: string, content: string, initial = false): Promise<void> {
		const temp = join(this.#directory, `.${name}-${randomUUID()}.tmp`)
		let handle: FileHandle | undefined
		let ownedTemp = false
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
			await this.#assertDirectory()
			await fs.rename(temp, join(this.#directory, name))
			ownedTemp = false
			await this.#handle.sync()
		} catch {
			this.#unavailable = true
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

	/** Explicit stopped-authority rotation. Old-binding persistence hooks reject. */
	rotateMachineCredential(random?: AccessRandomBytes): Promise<void> {
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
			const next: PrivateState = {
				version: 1,
				machineToken,
				credentialBinding: binding,
				sessions: { version: 1, credentialBinding: binding, sessions: [] },
			}
			await this.#atomic(STATE, JSON.stringify(next))
			this.#state = next
		})
	}

	close(): Promise<void> {
		return this.#serialize(async () => {
			if (this.#closed) return
			this.#closed = true
			let failed = false
			try {
				await this.#assertDirectory()
				if (this.#ownerIdentity) {
					const stat = await fs.lstat(join(this.#directory, this.#owner))
					if (
						stat.isFile() &&
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
