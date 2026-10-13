import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import type { Dirent } from "node:fs"
import {
	lstat,
	mkdir,
	open,
	readdir,
	rename,
	rmdir,
	unlink,
} from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { BANDPLANS_LIMITS, bandPlanStateSchema } from "@wavekit/api-types"
import type { BandPlanState } from "@wavekit/api-types"
import type { ZodIssue } from "zod"
import {
	BandPlansError,
	type BandPlanStoreUnavailableReason,
} from "./contract.js"

export type StorageStage =
	| "parent-open"
	| "parent-sync"
	| "parent-close"
	| "directory-open"
	| "directory-sync"
	| "directory-close"
	| "read-open"
	| "read"
	| "read-close"
	| "temp-open"
	| "temp-write"
	| "temp-sync"
	| "temp-close"
	| "rename"
	| "temp-remove"
	| "lock-release"
export interface BandPlanStorageOptions {
	stateDir: string
	/** False skips mkdir, the writer lock, the init write, and the temp sweep. */
	writable?: boolean
	/** Once after a post-rename failure latches a store that had opened. */
	onStoreUnavailable?: (reason: BandPlanStoreUnavailableReason) => void
	/** Test-only lifecycle observation and fault injection around local I/O. */
	stage?: (
		stage: StorageStage,
		phase: "before" | "after",
	) => void | Promise<void>
}

/**
 * Internal storeId when a read-only open finds no state.json.
 * Nothing is written. Views report `storeId: null`; this id is not served.
 * A later writable open mints a new id and persists it.
 */
export const BANDPLAN_READ_ONLY_EMPTY_STORE_ID =
	"00000000-0000-0000-0000-000000000000"

const LEFTOVER_TEMP = /^\.state-.*\.tmp$/
const READ_FLAGS =
	constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

class StorageUnavailable extends BandPlansError {
	readonly reason: BandPlanStoreUnavailableReason
	constructor(reason: BandPlanStoreUnavailableReason) {
		super("BANDPLANS_UNAVAILABLE")
		this.name = "StorageUnavailable"
		this.reason = reason
	}
}

export function bandPlanStorageFailureReason(
	error: unknown,
): BandPlanStoreUnavailableReason {
	return classifyFailure(error)
}

function errno(error: unknown): string | undefined {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
	)
		return error.code
	return undefined
}

function classifyFailure(error: unknown): BandPlanStoreUnavailableReason {
	if (error instanceof StorageUnavailable) return error.reason
	if (error instanceof BandPlansError) {
		if (error.code === "BANDPLANS_QUOTA") return "oversized"
		if (error.code === "BANDPLANS_INVALID") return "invalid"
		return "io"
	}
	const code = errno(error)
	if (
		code === "EACCES" ||
		code === "EPERM" ||
		code === "ELOOP" ||
		code === "ENOTDIR" ||
		code === "EISDIR"
	)
		return "permissions"
	return "io"
}

function missing(error: unknown): boolean {
	return errno(error) === "ENOENT"
}

function isQuota(issue: ZodIssue): boolean {
	if (issue.code !== "custom") return false
	const params: unknown = issue.params
	return (
		typeof params === "object" &&
		params !== null &&
		"quota" in params &&
		params.quota === true
	)
}

/** Detached schema-valid state. Quota and shape failures throw; nothing is repaired. */
export function validateBandPlanState(value: unknown): BandPlanState {
	const result = bandPlanStateSchema.safeParse(value)
	if (!result.success)
		throw new BandPlansError(
			result.error.issues.some(isQuota)
				? "BANDPLANS_QUOTA"
				: "BANDPLANS_INVALID",
		)
	return result.data
}

function createEmptyState(storeId: string): BandPlanState {
	return validateBandPlanState({
		version: 1,
		storeId,
		revision: 0,
		stack: null,
		importedPacks: [],
		operatorBands: [],
		edits: [],
		presets: [],
	})
}

/** Local Unix only: stateDir must already be durable, with trustworthy stable parents.
 * Writable opens take a no-stealing mkdir lock for the process lifetime.
 * A lock left by a crash stays held until offline repair; the next writable
 * open reports unavailable. Read-only opens do not create, lock, write, or sweep.
 * Filesystem sync success is not a hardware guarantee.
 * The service owns CAS and publication; storage rejects overlapping writes.
 * Invalid, oversized or unknown-version bytes are left untouched.
 */
export class BandPlanStorage {
	private readonly directory: string
	private readonly lock: string
	private readonly file: string
	private readonly writable: boolean
	private directoryHandle: FileHandle | undefined
	private ownsLock = false
	private unsafeIO = false
	private available = false
	private closing = false
	/** True only after state.json has been read or written. The read-only empty state stays false. */
	private durable = false
	private current: BandPlanState | undefined
	private active: Promise<void> | undefined
	private closeResult: Promise<void> | undefined
	private constructor(private readonly options: BandPlanStorageOptions) {
		this.directory = join(options.stateDir, "bandplans")
		this.lock = join(this.directory, ".writer-lock")
		this.file = join(this.directory, "state.json")
		this.writable = options.writable !== false
	}
	static async open(options: BandPlanStorageOptions): Promise<BandPlanStorage> {
		const storage = new BandPlanStorage(options)
		try {
			await storage.initialize()
			storage.available = true
			return storage
		} catch (error) {
			await storage.cleanup().catch(() => undefined)
			if (error instanceof StorageUnavailable) throw error
			throw new StorageUnavailable(classifyFailure(error))
		}
	}
	isAvailable(): boolean {
		return this.available && !this.closing
	}
	/** False iff this open is the never-persisted read-only empty state. */
	persisted(): boolean {
		return this.isAvailable() && this.durable
	}
	snapshot(): BandPlanState {
		if (!this.isAvailable() || !this.current) throw new StorageUnavailable("io")
		return validateBandPlanState(this.current)
	}
	persist(state: BandPlanState): Promise<void> {
		if (!this.isAvailable()) return Promise.reject(new StorageUnavailable("io"))
		if (!this.writable)
			return Promise.reject(new BandPlansError("BANDPLANS_READ_ONLY"))
		if (this.active) return Promise.reject(new BandPlansError("BANDPLANS_BUSY"))
		let next: BandPlanState
		let encoded: string
		try {
			next = validateBandPlanState(state)
			encoded = JSON.stringify(next)
		} catch (error) {
			return Promise.reject(error)
		}
		const operation = this.write(encoded).then(() => {
			this.current = next
			this.durable = true
		})
		this.active = operation
		// Clear before the returned promise settles; close still awaits accepted I/O.
		return operation.finally(() => {
			this.active = undefined
		})
	}
	close(): Promise<void> {
		if (!this.closeResult) {
			this.closing = true
			this.available = false
			this.closeResult = (async () => {
				await this.active?.catch(() => undefined)
				try {
					await this.cleanup()
				} catch {
					throw new StorageUnavailable("io")
				}
			})()
		}
		return this.closeResult
	}
	private noteUnavailable(reason: BandPlanStoreUnavailableReason): void {
		const listener = this.options.onStoreUnavailable
		if (!listener) return
		try {
			listener(reason)
		} catch {
			// A listener fault must not change durability or release behavior.
		}
	}
	private async stage(
		stage: StorageStage,
		phase: "before" | "after",
	): Promise<void> {
		await this.options.stage?.(stage, phase)
	}
	private async perform(
		stage: StorageStage,
		operation: () => Promise<unknown>,
	): Promise<void> {
		await this.stage(stage, "before")
		await operation()
		await this.stage(stage, "after")
	}
	private async acquire(
		path: string,
		flags: number,
		stage: StorageStage,
		mode?: number,
	): Promise<FileHandle> {
		await this.stage(stage, "before")
		const handle = await open(path, flags, mode)
		try {
			await this.stage(stage, "after")
		} catch (error) {
			await this.closeHandle(
				handle,
				stage === "temp-open"
					? "temp-close"
					: stage === "read-open"
						? "read-close"
						: stage === "parent-open"
							? "parent-close"
							: "directory-close",
			)
			throw error
		}
		return handle
	}
	private async closeHandle(
		handle: FileHandle,
		stage: StorageStage,
	): Promise<void> {
		// Even an injected close fault must settle real I/O before ownership can release.
		let fault: unknown
		let failed = false
		try {
			await this.stage(stage, "before")
		} catch (error) {
			fault = error
			failed = true
		}
		try {
			await handle.close()
		} catch (error) {
			this.unsafeIO = true
			throw error
		}
		if (failed) throw fault
		await this.stage(stage, "after")
	}
	private async check(
		handle: FileHandle,
		directory: boolean,
		privateMode?: number,
	): Promise<void> {
		const stat = await handle.stat()
		if (
			(directory ? !stat.isDirectory() : !stat.isFile()) ||
			// Permission bits only: a setgid parent makes a new child directory inherit
			// S_ISGID on Linux, which does not widen owner-only access.
			(privateMode !== undefined &&
				(stat.uid !== process.getuid?.() ||
					(stat.mode & 0o777) !== privateMode))
		)
			throw new StorageUnavailable("permissions")
	}
	private async initialize(): Promise<void> {
		if (!isAbsolute(this.options.stateDir)) throw new StorageUnavailable("io")
		if (process.getuid === undefined)
			throw new StorageUnavailable("permissions")
		if (!this.writable) {
			await this.initializeReadOnly()
			return
		}
		await this.initializeWritable()
	}
	private async initializeReadOnly(): Promise<void> {
		let directory: Awaited<ReturnType<typeof lstat>>
		try {
			directory = await lstat(this.directory)
		} catch (error) {
			if (missing(error)) {
				this.current = createEmptyState(BANDPLAN_READ_ONLY_EMPTY_STORE_ID)
				this.durable = false
				return
			}
			throw error
		}
		if (!directory.isDirectory()) throw new StorageUnavailable("permissions")
		let listed: Awaited<ReturnType<typeof lstat>>
		try {
			listed = await lstat(this.file)
		} catch (error) {
			if (missing(error)) {
				this.current = createEmptyState(BANDPLAN_READ_ONLY_EMPTY_STORE_ID)
				this.durable = false
				return
			}
			throw error
		}
		if (!listed.isFile()) throw new StorageUnavailable("permissions")
		const directoryHandle = await this.acquire(
			this.directory,
			READ_FLAGS | constants.O_DIRECTORY,
			"directory-open",
		)
		try {
			await this.check(directoryHandle, true, 0o700)
			const actual = await directoryHandle.stat()
			if (directory.ino !== actual.ino || directory.dev !== actual.dev)
				throw new StorageUnavailable("permissions")
		} finally {
			await this.closeHandle(directoryHandle, "directory-close")
		}
		const handle = await this.acquire(this.file, READ_FLAGS, "read-open")
		try {
			await this.check(handle, false, 0o600)
			const opened = await handle.stat()
			if (opened.ino !== listed.ino || opened.dev !== listed.dev)
				throw new StorageUnavailable("permissions")
			await this.readCurrent(handle)
		} finally {
			await this.closeHandle(handle, "read-close")
		}
	}
	private async initializeWritable(): Promise<void> {
		const parent = await this.acquire(
			this.options.stateDir,
			READ_FLAGS | constants.O_DIRECTORY,
			"parent-open",
		)
		try {
			await this.check(parent, true)
			try {
				await mkdir(this.directory, { mode: 0o700 })
			} catch (error) {
				if (errno(error) !== "EEXIST") throw error
			}
			const identity = await lstat(this.directory)
			this.directoryHandle = await this.acquire(
				this.directory,
				READ_FLAGS | constants.O_DIRECTORY,
				"directory-open",
			)
			await this.check(this.directoryHandle, true, 0o700)
			const actual = await this.directoryHandle.stat()
			if (identity.ino !== actual.ino || identity.dev !== actual.dev)
				throw new StorageUnavailable("permissions")
			try {
				await mkdir(this.lock, { mode: 0o700 })
			} catch (error) {
				if (errno(error) === "EEXIST") throw new StorageUnavailable("lock-held")
				throw error
			}
			this.ownsLock = true
			await this.perform("parent-sync", () => parent.sync())
		} finally {
			await this.closeHandle(parent, "parent-close")
		}
		await this.sweepTemps()
		let handle: FileHandle
		try {
			handle = await this.acquire(this.file, READ_FLAGS, "read-open")
		} catch (error) {
			if (!missing(error)) throw error
			const empty = createEmptyState(randomUUID())
			await this.write(JSON.stringify(empty))
			this.current = empty
			this.durable = true
			return
		}
		try {
			await this.check(handle, false, 0o600)
			await this.readCurrent(handle)
		} finally {
			await this.closeHandle(handle, "read-close")
		}
		// Visible state may be a previously uncertain rename. Complete that
		// directory's durability before exposing it, including to no-op writes.
		if (!this.directoryHandle) throw new StorageUnavailable("io")
		await this.perform("directory-sync", () => this.directoryHandle!.sync())
	}
	private async readCurrent(handle: FileHandle): Promise<void> {
		const bytes = Buffer.alloc(BANDPLANS_LIMITS.stateBytes + 1)
		let length = 0
		await this.perform("read", async () => {
			while (length < bytes.length) {
				const result = await handle.read(
					bytes,
					length,
					bytes.length - length,
					length,
				)
				if (result.bytesRead === 0) break
				length += result.bytesRead
			}
		})
		if (length > BANDPLANS_LIMITS.stateBytes)
			throw new StorageUnavailable("oversized")
		this.current = this.parseState(bytes.subarray(0, length))
		this.durable = true
	}
	private parseState(bytes: Uint8Array): BandPlanState {
		let text: string
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
		} catch {
			throw new StorageUnavailable("invalid")
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch {
			throw new StorageUnavailable("invalid")
		}
		try {
			return validateBandPlanState(parsed)
		} catch (error) {
			if (error instanceof BandPlansError && error.code === "BANDPLANS_QUOTA")
				throw new StorageUnavailable("oversized")
			throw new StorageUnavailable("invalid")
		}
	}
	private async sweepTemps(): Promise<void> {
		if (!this.ownsLock || !this.writable) return
		let entries: Dirent[]
		try {
			entries = await readdir(this.directory, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (!LEFTOVER_TEMP.test(entry.name) || !entry.isFile()) continue
			const path = join(this.directory, entry.name)
			try {
				const stat = await lstat(path)
				if (!stat.isFile()) continue
				await unlink(path)
			} catch {
				// A leftover temp is bounded. Leave it rather than fail open.
			}
		}
	}
	private async write(encoded: string): Promise<void> {
		const temp = join(this.directory, `.state-${randomUUID()}.tmp`)
		let created = false
		let renamed = false
		let handle: FileHandle | undefined
		try {
			await this.stage("temp-open", "before")
			handle = await open(
				temp,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW,
				0o600,
			)
			created = true
			await this.stage("temp-open", "after")
			await this.check(handle, false, 0o600)
			await this.perform("temp-write", () => handle!.writeFile(encoded, "utf8"))
			await this.perform("temp-sync", () => handle!.sync())
			const closing = handle
			handle = undefined
			await this.closeHandle(closing, "temp-close")
			await this.stage("rename", "before")
			await rename(temp, this.file)
			renamed = true
			await this.stage("rename", "after")
			if (!this.directoryHandle) throw new StorageUnavailable("io")
			await this.perform("directory-sync", () => this.directoryHandle!.sync())
		} catch (error) {
			const reason = classifyFailure(error)
			// Init writes are not yet live. Only a latched live store is reported.
			if (renamed) {
				const live = this.available
				this.available = false
				if (live) this.noteUnavailable(reason)
			}
			if (handle) {
				try {
					await this.closeHandle(handle, "temp-close")
				} catch {
					this.available = false
				}
			}
			if (created && !renamed && !this.unsafeIO) {
				try {
					await this.perform("temp-remove", () => unlink(temp))
				} catch {
					this.available = false
				}
			}
			if (this.unsafeIO) this.available = false
			throw new StorageUnavailable(reason)
		}
	}
	private async cleanup(): Promise<void> {
		this.available = false
		if (this.directoryHandle) {
			const handle = this.directoryHandle
			this.directoryHandle = undefined
			await this.closeHandle(handle, "directory-close")
		}
		if (this.unsafeIO) throw new StorageUnavailable("io")
		if (this.ownsLock) {
			await this.perform("lock-release", () => rmdir(this.lock))
			this.ownsLock = false
		}
	}
}
