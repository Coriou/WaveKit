import type { WriterLock, LockWaitOptions } from "../utils/lock-owner.js"
import type { Logger } from "../utils/logger.js"
import { acquireWriterLock, releaseWriterLock } from "../utils/lock-owner.js"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { createEmptySnapshot } from "./domain.js"
import {
	OPERATOR_DATA_LIMITS,
	OperatorDataError,
	encodeSnapshot,
	validateSnapshot,
} from "./schema.js"
import type { OperatorDataSnapshot } from "./schema.js"

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
export interface OperatorDataStorageOptions {
	stateDir: string
	logger?: Logger
	lockWait?: LockWaitOptions
	/** Test-only lifecycle observation/fault injection around actual local I/O. */
	stage?: (
		stage: StorageStage,
		phase: "before" | "after",
	) => void | Promise<void>
}
class StorageUnavailable extends OperatorDataError {
	readonly reason: "lock-held" | "io"
	constructor(reason: "lock-held" | "io") {
		super("OPERATOR_DATA_UNAVAILABLE")
		this.reason = reason
	}
}
const unavailable = () => new StorageUnavailable("io")
function missing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	)
}

/** Local Unix only: stateDir must already be durable, with trustworthy stable parents.
 * Crash locks use heartbeat recovery. Filesystem sync success is not a hardware guarantee.
 * Service owns CAS/transaction admission/publication; storage rejects overlapping writes.
 */
export class OperatorDataStorage {
	private readonly directory: string
	private readonly lock: string
	private readonly file: string
	private directoryHandle: FileHandle | undefined
	private ownsLock: WriterLock | false = false
	private unsafeIO = false
	private available = false
	private closing = false
	private current: OperatorDataSnapshot | undefined
	private active: Promise<void> | undefined
	private closeResult: Promise<void> | undefined
	private constructor(private readonly options: OperatorDataStorageOptions) {
		this.directory = join(options.stateDir, "operator-data")
		this.lock = join(this.directory, ".writer-lock")
		this.file = join(this.directory, "state.json")
	}
	static async open(
		options: OperatorDataStorageOptions,
	): Promise<OperatorDataStorage> {
		const storage = new OperatorDataStorage(options)
		try {
			await storage.initialize()
			if (storage.ownsLock && storage.ownsLock.lost) throw unavailable()
			storage.available = true
			return storage
		} catch (error) {
			await storage.cleanup().catch(() => undefined)
			throw error instanceof StorageUnavailable ? error : unavailable()
		}
	}
	isAvailable(): boolean {
		return this.available && !this.closing
	}
	snapshot(): OperatorDataSnapshot {
		if (!this.isAvailable() || !this.current) throw unavailable()
		return validateSnapshot(this.current)
	}
	persist(snapshot: OperatorDataSnapshot): Promise<void> {
		if (!this.isAvailable()) return Promise.reject(unavailable())
		if (this.active)
			return Promise.reject(new OperatorDataError("OPERATOR_DATA_BUSY"))
		let next: OperatorDataSnapshot
		let encoded: string
		try {
			next = validateSnapshot(snapshot)
			encoded = encodeSnapshot(next)
		} catch (error) {
			return Promise.reject(error)
		}
		const operation = this.write(encoded).then(() => {
			this.current = next
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
					throw unavailable()
				}
			})()
		}
		return this.closeResult
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
			(privateMode !== undefined &&
				(stat.uid !== process.getuid?.() ||
					(stat.mode & 0o7777) !== privateMode))
		)
			throw unavailable()
	}
	private async initialize(): Promise<void> {
		if (!isAbsolute(this.options.stateDir) || process.getuid === undefined)
			throw unavailable()
		const flags =
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
		const parent = await this.acquire(
			this.options.stateDir,
			flags | constants.O_DIRECTORY,
			"parent-open",
		)
		try {
			await this.check(parent, true)
			try {
				await mkdir(this.directory, { mode: 0o700 })
			} catch (error) {
				if (
					!(
						typeof error === "object" &&
						error !== null &&
						"code" in error &&
						error.code === "EEXIST"
					)
				)
					throw error
			}
			const identity = await lstat(this.directory)
			this.directoryHandle = await this.acquire(
				this.directory,
				flags | constants.O_DIRECTORY,
				"directory-open",
			)
			await this.check(this.directoryHandle, true, 0o700)
			const actual = await this.directoryHandle.stat()
			if (identity.ino !== actual.ino || identity.dev !== actual.dev)
				throw unavailable()
			this.ownsLock = await acquireWriterLock(this.lock, {
				...this.options.lockWait,
				...(this.options.logger ? { logger: this.options.logger } : {}),
				onLost: () => {
					this.available = false
				},
			})
			if (!this.ownsLock) throw new StorageUnavailable("lock-held")
			await this.perform("parent-sync", () => parent.sync())
		} finally {
			await this.closeHandle(parent, "parent-close")
		}
		let handle: FileHandle
		try {
			handle = await this.acquire(this.file, flags, "read-open")
		} catch (error) {
			if (!missing(error)) throw error
			const empty = createEmptySnapshot(randomUUID())
			await this.write(encodeSnapshot(empty))
			this.current = empty
			return
		}
		try {
			await this.check(handle, false, 0o600)
			const bytes = Buffer.alloc(OPERATOR_DATA_LIMITS.snapshotBytes + 1)
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
			if (length > OPERATOR_DATA_LIMITS.snapshotBytes) throw unavailable()
			this.current = validateSnapshot(
				JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(
						bytes.subarray(0, length),
					),
				),
			)
		} finally {
			await this.closeHandle(handle, "read-close")
		}
		// Visible state may be a previously uncertain rename. Complete that
		// directory's durability before exposing it, including to no-op writes.
		if (!this.directoryHandle) throw unavailable()
		await this.perform("directory-sync", () => this.directoryHandle!.sync())
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
			if (!this.ownsLock || !(await this.ownsLock.check())) throw unavailable()
			await rename(temp, this.file)
			renamed = true
			await this.stage("rename", "after")
			if (!this.directoryHandle) throw unavailable()
			await this.perform("directory-sync", () => this.directoryHandle!.sync())
		} catch {
			if (renamed) this.available = false
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
			throw unavailable()
		}
	}
	private async cleanup(): Promise<void> {
		this.available = false
		const lock = this.ownsLock
		try {
			if (this.directoryHandle) {
				const handle = this.directoryHandle
				this.directoryHandle = undefined
				await this.closeHandle(handle, "directory-close")
			}
			if (this.unsafeIO) throw unavailable()
			if (this.ownsLock) {
				const lock = this.ownsLock
				await this.perform("lock-release", () => releaseWriterLock(lock))
				this.ownsLock = false
			}
		} finally {
			if (lock) await lock.stop()
		}
	}
}
