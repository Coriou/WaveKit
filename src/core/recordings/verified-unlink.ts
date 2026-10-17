/**
 * WG10 lane RK2: the verified unlink shared by the dsd-fme delete (keep service) and the scanner
 * delete (evidence store) (docs/specs/web-gaps-10, requirements 1.1-1.3 and 1.9; design
 * "Recording follow-ups (lane RK2)"). Extracted from the WG9 keep-service delete with every WG9
 * check kept: the path's lstat against the opened handle, the shared-writable-parent refusal, the
 * `mkdtemp` private directory and its identity, the directory re-check right before the unlink.
 *
 * WG10 progress names (req 1.9): the moved entry keeps the recording's own basename inside the
 * private directory until its identity check passed; it is then renamed to
 * `RECORDING_DELETE_VERIFIED_NAME` in the same directory, the directory is re-checked, and the
 * deletion decision `stillDeletable()` and the `unlink` run in one synchronous turn. A startup
 * sweep can therefore tell an unverified leftover (restore it) from a verified one (unlink it).
 *
 * Logs: fixed text only (never a path, name, key or id). Imports stay minimal (contract, errors,
 * logger type) so the deleters can import it without pulling runtime modules into the startup
 * bundle.
 */
import * as nodeFs from "node:fs/promises"
import * as nodePath from "node:path"
import { WaveKitError } from "../../utils/errors.js"
import type { Logger } from "../../utils/logger.js"
import { RECORDING_DELETE_VERIFIED_NAME } from "./contract.js"

export const RECORDING_DELETE_FAILED_TEXT = "Recording could not be deleted"
export const RECORDING_BUSY_TEXT =
	"Another operation on this recording is in progress"
export const RECORDING_DELETE_UNSUPPORTED_TEXT =
	"This recording cannot be deleted"

/**
 * The private directory a delete moves the recording into before its final check: created by
 * `mkdtemp` (mode 0700) in the recording's directory, a directory and not a dsd-fme or scanner
 * name, so neither the pruner nor the inventory lists it.
 */
export const RECORDING_DELETE_PRIVATE_PREFIX = ".wavekit-delete-"

/** The calls a delete makes on the opened path (injectable for tests). */
export interface RecordingDeleteFs {
	lstat(p: string): Promise<{
		dev: number
		ino: number
		mode: number
		isFile(): boolean
		isDirectory(): boolean
		isSymbolicLink(): boolean
	}>
	unlink(p: string): Promise<void>
	/** Moves the recording into the private delete directory (same filesystem, atomic). */
	rename(from: string, to: string): Promise<void>
	/** Restores a moved regular file without replacing what now holds the name (EEXIST then). */
	link(existing: string, newPath: string): Promise<void>
	/** Creates the private delete directory (mode 0700) next to the recording. */
	mkdtemp(prefix: string): Promise<string>
	/** Removes the private delete directory; fails when it is not empty (left in place then). */
	rmdir(p: string): Promise<void>
	readlink(p: string): Promise<string>
	/** Restores a moved symlink as a symlink (EEXIST when the name is taken; never clobbers). */
	symlink(target: string, p: string): Promise<void>
}

export const nodeRecordingDeleteFs: RecordingDeleteFs = {
	lstat: p => nodeFs.lstat(p),
	unlink: p => nodeFs.unlink(p),
	rename: (a, b) => nodeFs.rename(a, b),
	link: (a, b) => nodeFs.link(a, b),
	mkdtemp: prefix => nodeFs.mkdtemp(prefix),
	rmdir: p => nodeFs.rmdir(p),
	readlink: p => nodeFs.readlink(p),
	symlink: (target, p) => nodeFs.symlink(target, p),
}

/**
 * `deleted`: the verified file was unlinked. `not-found`: the path is gone or no longer the
 * opened file (nothing deleted; a foreign entry is put back). `protected`: the file is the
 * opened one but `stillDeletable()` answered false (put back under its name, nothing deleted).
 */
export type VerifiedUnlinkOutcome = "deleted" | "not-found" | "protected"

export interface VerifiedUnlinkOptions {
	/** The recording's path (its basename is the moved entry's name). */
	filePath: string
	/** Device and inode of the verified open (`fstat` of the handle). */
	handleStat: { dev: number; ino: number }
	/** The deletion decision; run in the same synchronous turn as the unlink. Throwing is false. */
	stillDeletable: () => boolean
	fs?: RecordingDeleteFs
	/** Component logger of the caller (fixed-text lines only). */
	log: Logger
}

type FileId = Awaited<ReturnType<RecordingDeleteFs["lstat"]>>

function errCode(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null) return undefined
	const code = (err as { code?: unknown }).code
	return typeof code === "string" ? code : undefined
}

function deleteFailed(): WaveKitError {
	return new WaveKitError(
		RECORDING_DELETE_FAILED_TEXT,
		"RECORDING_DELETE_FAILED",
	)
}

const sameFile = (a: FileId, b: { dev: number; ino: number }): boolean =>
	!a.isSymbolicLink() && a.isFile() && a.dev === b.dev && a.ino === b.ino

const changed = (log: Logger): "not-found" => {
	log.warn({}, "Recording delete refused: the file changed")
	return "not-found"
}

/**
 * Unlinks exactly the opened file. The path is moved (atomic rename) into a fresh private
 * directory (`mkdtemp`, mode 0700, same directory so same filesystem) under its own basename; the
 * moved entry is checked against the handle (device, inode, a regular file); on a match it is
 * renamed to `verified`, checked again, the private directory re-checked last, and the decision
 * plus unlink share one turn; then the directory is removed. A file swapped in before the rename
 * is moved, found foreign and put back by entry type (a regular file with `link`, a symlink with
 * `readlink` + `symlink`; both fail EEXIST and never replace what now holds the name); nothing is
 * deleted. If it cannot be put back it is left in the private directory (never deleted) and a
 * fixed-text warning is logged.
 *
 * Throws `WaveKitError` `RECORDING_DELETE_FAILED` (shared-writable parent, private directory not
 * ours, `mkdtemp` failure as its own error) with nothing renamed; other fs errors propagate.
 * Residual: a same-uid process rebinding the private directory (or its entry) between the last
 * lstat and the unlink is not closed; that needs unlinkat/fstatat on a directory descriptor, which
 * Node does not offer. Such a process could unlink the recording itself.
 *
 * fs calls on success: 6 lstat (path, parent, private dir, moved entry, verified entry, private
 * dir), 1 mkdtemp, 2 rename, 1 unlink, 1 rmdir.
 */
export async function verifiedUnlink(
	options: VerifiedUnlinkOptions,
): Promise<VerifiedUnlinkOutcome> {
	const { filePath, handleStat, log } = options
	const fs = options.fs ?? nodeRecordingDeleteFs
	const decide = (): boolean => {
		try {
			return options.stillDeletable() === true
		} catch {
			return false
		}
	}
	let pre: FileId
	try {
		pre = await fs.lstat(filePath)
	} catch (error: unknown) {
		if (errCode(error) === "ENOENT" || errCode(error) === "ENOTDIR")
			return "not-found"
		throw error
	}
	if (!sameFile(pre, handleStat)) return changed(log)
	// Another uid able to write the recording directory (group or other write without the
	// sticky bit) could rebind the private directory's name: refuse the whole delete.
	const parentDir = nodePath.dirname(filePath)
	const parent = await fs.lstat(parentDir)
	if ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0) {
		log.warn(
			{},
			"Recording delete refused: the recording directory is writable by other users",
		)
		throw deleteFailed()
	}
	// A failure here propagates with nothing renamed.
	const privateDir = await fs.mkdtemp(
		nodePath.join(parentDir, RECORDING_DELETE_PRIVATE_PREFIX),
	)
	const movedPath = nodePath.join(privateDir, nodePath.basename(filePath))
	const verifiedPath = nodePath.join(privateDir, RECORDING_DELETE_VERIFIED_NAME)
	const removeDir = (): Promise<void> =>
		fs.rmdir(privateDir).catch(() => undefined)
	let dirId: FileId
	try {
		dirId = await fs.lstat(privateDir)
	} catch (error: unknown) {
		await removeDir()
		throw error
	}
	const isOurDir = (d: FileId | null): boolean =>
		d !== null &&
		!d.isSymbolicLink() &&
		d.isDirectory() &&
		d.dev === dirId.dev &&
		d.ino === dirId.ino
	if (!isOurDir(dirId)) {
		await removeDir()
		throw deleteFailed()
	}
	try {
		await fs.rename(filePath, movedPath)
	} catch (error: unknown) {
		await removeDir()
		if (errCode(error) === "ENOENT" || errCode(error) === "ENOTDIR")
			return "not-found"
		throw error
	}
	const lstatOrNull = async (p: string): Promise<FileId | null> => {
		try {
			return await fs.lstat(p)
		} catch (error: unknown) {
			if (errCode(error) !== "ENOENT") throw error
			return null
		}
	}
	/** Puts the entry at `inner` back under the recording's name; leaves it on failure. */
	const putBack = async (entry: FileId, inner: string): Promise<void> => {
		if (!(await restoreMoved(fs, entry, inner, filePath)))
			log.warn(
				{ left: 1 },
				"Recording delete could not restore a file; it is left under a private name",
			)
		await removeDir()
	}
	const moved = await lstatOrNull(movedPath)
	if (moved === null) {
		// The moved name was removed under us: nothing of ours is left to delete.
		await removeDir()
		return changed(log)
	}
	if (!sameFile(moved, handleStat)) {
		await putBack(moved, movedPath)
		return changed(log)
	}
	// Not marked verified while it is not deletable: a crash then leaves an unverified entry the
	// sweep restores.
	if (!decide()) {
		await putBack(moved, movedPath)
		return "protected"
	}
	try {
		await fs.rename(movedPath, verifiedPath)
	} catch (error: unknown) {
		await putBack(moved, movedPath)
		if (errCode(error) === "ENOENT") return changed(log)
		throw error
	}
	const verified = await lstatOrNull(verifiedPath)
	if (verified === null) {
		await removeDir()
		return changed(log)
	}
	if (!sameFile(verified, handleStat)) {
		await putBack(verified, verifiedPath)
		return changed(log)
	}
	// The private directory itself must still be ours: a rename of it plus a symlink at its name
	// would redirect the unlink outside. Checked last, so the decision and the unlink below are
	// issued in the same turn as this lstat result. If it changed, everything is left in place.
	let dirNow: FileId | null
	try {
		dirNow = await fs.lstat(privateDir)
	} catch {
		dirNow = null
	}
	if (!isOurDir(dirNow)) return changed(log)
	if (!decide()) {
		await putBack(verified, verifiedPath)
		return "protected"
	}
	try {
		await fs.unlink(verifiedPath)
	} catch (error: unknown) {
		if (errCode(error) === "ENOENT") {
			await removeDir()
			return "not-found"
		}
		throw error
	}
	await removeDir()
	return "deleted"
}

/**
 * Puts a moved entry back under its original name by type, never clobbering: a regular file
 * with `link`, a symlink with `readlink` + `symlink` (`link` on a symlink hard-links its target
 * on macOS). The private name is unlinked only after the restore succeeded. Any other type or
 * any error: false, and the entry stays in the private directory.
 */
async function restoreMoved(
	fs: RecordingDeleteFs,
	moved: FileId,
	innerPath: string,
	filePath: string,
): Promise<boolean> {
	try {
		if (moved.isSymbolicLink()) {
			const target = await fs.readlink(innerPath)
			await fs.symlink(target, filePath)
		} else if (moved.isFile()) {
			await fs.link(innerPath, filePath)
		} else {
			return false
		}
	} catch {
		return false
	}
	await fs.unlink(innerPath).catch(() => undefined)
	return true
}
