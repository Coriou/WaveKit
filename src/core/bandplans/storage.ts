import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { BANDPLANS_LIMITS, bandPlanStateSchema } from "@wavekit/api-types"
import type { BandPlanState } from "@wavekit/api-types"
import type { ZodIssue } from "zod"
import { BandPlansError } from "./contract.js"

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
	/** Test-only lifecycle observation and fault injection around local I/O. */
	stage?: (
		stage: StorageStage,
		phase: "before" | "after",
	) => void | Promise<void>
}
const unavailable = () => new BandPlansError("BANDPLANS_UNAVAILABLE")
function missing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	)
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
 * Crash locks require offline repair. Filesystem sync success is not a hardware guarantee.
 * The service owns CAS and publication; storage rejects overlapping writes.
 * Invalid, oversized or unknown-version bytes are left untouched.
 */
export class BandPlanStorage {
	private readonly directory: string
	private readonly lock: string
	private readonly file: string
	private directoryHandle: FileHandle | undefined
	private ownsLock = false
	private unsafeIO = false
	private available = false
	private closing = false
	private current: BandPlanState | undefined
	private active: Promise<void> | undefined
	private closeResult: Promise<void> | undefined
	private constructor(private readonly options: BandPlanStorageOptions) {
		this.directory = join(options.stateDir, "bandplans")
		this.lock = join(this.directory, ".writer-lock")
		this.file = join(this.directory, "state.json")
	}
	static async open(options: BandPlanStorageOptions): Promise<BandPlanStorage> {
		const storage = new BandPlanStorage(options)
		try {
			await storage.initialize()
			storage.available = true
			return storage
		} catch {
			await storage.cleanup().catch(() => undefined)
			throw unavailable()
		}
	}
	isAvailable(): boolean {
		return this.available && !this.closing
	}
	snapshot(): BandPlanState {
		if (!this.isAvailable() || !this.current) throw unavailable()
		return validateBandPlanState(this.current)
	}
	persist(state: BandPlanState): Promise<void> {
		if (!this.isAvailable()) return Promise.reject(unavailable())
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
			await mkdir(this.lock, { mode: 0o700 })
			this.ownsLock = true
			await this.perform("parent-sync", () => parent.sync())
		} finally {
			await this.closeHandle(parent, "parent-close")
		}
		let handle: FileHandle
		try {
			handle = await this.acquire(this.file, flags, "read-open")
		} catch (error) {
			if (!missing(error)) throw error
			const empty = createEmptyState(randomUUID())
			await this.write(JSON.stringify(empty))
			this.current = empty
			return
		}
		try {
			await this.check(handle, false, 0o600)
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
			if (length > BANDPLANS_LIMITS.stateBytes) throw unavailable()
			this.current = validateBandPlanState(
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
		if (this.directoryHandle) {
			const handle = this.directoryHandle
			this.directoryHandle = undefined
			await this.closeHandle(handle, "directory-close")
		}
		if (this.unsafeIO) throw unavailable()
		if (this.ownsLock) {
			await this.perform("lock-release", () => rmdir(this.lock))
			this.ownsLock = false
		}
	}
}
