/**
 * Filesystem proofs for the capture directory (WG11 req 6.6, 6.9). Fail closed by meaning: a path
 * is used only when every component from the configured root down is a real directory (no
 * symbolic link anywhere), the directory is ours with mode 0700, and a capture file is a regular
 * file of ours, mode 0600 or stricter, within the per-capture bound and a whole number of cf32
 * samples. Any error or unknown answer is a refusal.
 */
import { constants, type Stats } from "node:fs"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import path from "node:path"
import {
	IQ_CAPTURE_BYTES_PER_SAMPLE,
	IQ_CAPTURE_DIR,
	IQ_CAPTURE_MAX_BYTES,
} from "../scanner/iq-capture-contract.js"

/** The uid captures must belong to; null where the platform has no uid (never proven). */
export function processUid(): number | null {
	return typeof process.getuid === "function" ? process.getuid() : null
}

/** Why the directory cannot be used (fixed codes, logged without paths). */
export type DirRefusal =
	| "root-invalid"
	| "symlink"
	| "not-directory"
	| "not-owner"
	| "mode"
	| "io"

function isOurs(st: Stats, uid: number | null): boolean {
	return uid !== null && st.uid === uid
}

/**
 * Lstat of every component from `root` (inclusive) down to `target` (inclusive): all must exist
 * and none may be a symbolic link; components above `target` must be directories. Sync on purpose:
 * a handful of syscalls, used right before an open so nothing can interleave on the event loop.
 */
export function lstatChainSync(root: string, target: string): Stats | null {
	if (!path.isAbsolute(root) || !path.isAbsolute(target)) return null
	const rel = path.relative(root, target)
	if (rel.startsWith("..") || path.isAbsolute(rel)) return null
	const parts = rel === "" ? [] : rel.split(path.sep)
	let current = root
	try {
		let st = fs.lstatSync(current)
		for (const part of parts) {
			if (st.isSymbolicLink() || !st.isDirectory()) return null
			if (part === "" || part === "." || part === "..") return null
			current = path.join(current, part)
			st = fs.lstatSync(current)
		}
		if (st.isSymbolicLink()) return null
		return st
	} catch {
		return null
	}
}

/**
 * Creates `<root>/iq-captures` with mode 0700 when missing, or proves an existing one: a real
 * directory (no symlink from the root down), owned by this uid, not group/other-accessible.
 * The root itself must already exist as a real directory.
 */
export async function ensureCaptureDir(
	root: string,
	uid: number | null = processUid(),
): Promise<{ dir: string } | { refused: DirRefusal }> {
	if (!path.isAbsolute(root)) return { refused: "root-invalid" }
	const resolvedRoot = path.resolve(root)
	const dir = path.join(resolvedRoot, IQ_CAPTURE_DIR)
	const rootStat = lstatChainSync(resolvedRoot, resolvedRoot)
	if (!rootStat) return { refused: "symlink" }
	if (!rootStat.isDirectory()) return { refused: "not-directory" }
	try {
		await fsp.mkdir(dir, { mode: 0o700 })
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST")
			return { refused: "io" }
	}
	let st: Stats
	try {
		st = await fsp.lstat(dir)
	} catch {
		return { refused: "io" }
	}
	if (st.isSymbolicLink()) return { refused: "symlink" }
	if (!st.isDirectory()) return { refused: "not-directory" }
	if (!isOurs(st, uid)) return { refused: "not-owner" }
	if ((st.mode & 0o077) !== 0) return { refused: "mode" }
	// The chain again: the root must not have been swapped for a link meanwhile.
	if (!lstatChainSync(resolvedRoot, dir)) return { refused: "symlink" }
	return { dir }
}

/** A capture file proven for replay, opened read-only without following links. */
export interface VerifiedCaptureFile {
	fd: number
	size: number
}

/**
 * Proves `<dir>/<name>` and opens it: lstat chain from the configured root, regular file, our uid,
 * mode & 0o077 === 0, size ≤ min(maxBytes, IQ_CAPTURE_MAX_BYTES) and a multiple of 8, then
 * `open(O_RDONLY | O_NOFOLLOW)` and an fstat whose dev/ino/size must equal the lstat (defeats a
 * swap between the proof and the open). The caller owns the returned fd. Null on any doubt.
 */
export function openVerifiedCaptureSync(
	root: string,
	file: string,
	expectedBytes: number | null,
	uid: number | null = processUid(),
): VerifiedCaptureFile | null {
	const st = lstatChainSync(root, file)
	if (!st || !fileProven(st, uid, expectedBytes)) return null
	let fd: number
	try {
		fd = fs.openSync(
			file,
			constants.O_RDONLY |
				(constants.O_NOFOLLOW ?? 0) |
				(constants.O_NONBLOCK ?? 0),
		)
	} catch {
		return null
	}
	try {
		const fst = fs.fstatSync(fd)
		if (
			fst.dev !== st.dev ||
			fst.ino !== st.ino ||
			fst.size !== st.size ||
			!fileProven(fst, uid, expectedBytes)
		) {
			fs.closeSync(fd)
			return null
		}
		return { fd, size: fst.size }
	} catch {
		try {
			fs.closeSync(fd)
		} catch {
			// already closed
		}
		return null
	}
}

function fileProven(
	st: Stats,
	uid: number | null,
	expectedBytes: number | null,
): boolean {
	return (
		st.isFile() &&
		!st.isSymbolicLink() &&
		isOurs(st, uid) &&
		(st.mode & 0o077) === 0 &&
		st.size <= IQ_CAPTURE_MAX_BYTES &&
		st.size % IQ_CAPTURE_BYTES_PER_SAMPLE === 0 &&
		(expectedBytes === null || st.size === expectedBytes)
	)
}

/** Async proof without opening (used when a capture finishes). */
export async function verifyCaptureFile(
	root: string,
	file: string,
	expectedBytes: number,
	uid: number | null = processUid(),
): Promise<boolean> {
	await Promise.resolve()
	const v = openVerifiedCaptureSync(root, file, expectedBytes, uid)
	if (!v) return false
	try {
		fs.closeSync(v.fd)
	} catch {
		// nothing to do
	}
	return true
}

/** The capture directory's identity, recorded once proven (review BLOCKING). */
export interface DirIdentity {
	dev: number
	ino: number
}

/** Lstat chain from `root` to `dir`: a real directory (no link anywhere); its dev/ino, else null. */
export function captureDirIdentitySync(
	root: string,
	dir: string,
): DirIdentity | null {
	const st = lstatChainSync(root, dir)
	if (!st || !st.isDirectory()) return null
	return { dev: st.dev, ino: st.ino }
}

/** The directory is still the one recorded: chain re-proven, no link, same dev/ino. */
export function dirStillProvenSync(
	root: string,
	dir: string,
	identity: DirIdentity,
): boolean {
	const now = captureDirIdentitySync(root, dir)
	return now !== null && now.dev === identity.dev && now.ino === identity.ino
}

export type GuardedUnlink = "removed" | "missing" | "refused"

/**
 * Unlinks `<dir>/<name>` only after re-proving the directory (chain, no link, recorded dev/ino) and
 * the file (a regular file of ours, on the directory's device, not a link; `expectIno` when the file
 * identity was recorded at its proof). Sync: nothing interleaves between the proofs and the unlink.
 * "refused": the directory or file is not what it must be (the caller turns capture off).
 */
export function unlinkProvenSync(
	root: string,
	dir: string,
	identity: DirIdentity,
	name: string,
	uid: number | null,
	expectIno?: number,
): GuardedUnlink {
	if (name.includes("/") || name.includes(path.sep) || name.startsWith("."))
		return "refused"
	if (!dirStillProvenSync(root, dir, identity)) return "refused"
	const file = path.join(dir, name)
	let st: Stats
	try {
		st = fs.lstatSync(file)
	} catch (err: unknown) {
		return (err as NodeJS.ErrnoException).code === "ENOENT"
			? "missing"
			: "refused"
	}
	if (
		st.isSymbolicLink() ||
		!st.isFile() ||
		!isOurs(st, uid) ||
		st.dev !== identity.dev ||
		(expectIno !== undefined && st.ino !== expectIno)
	)
		return "refused"
	try {
		fs.unlinkSync(file)
		return "removed"
	} catch (err: unknown) {
		return (err as NodeJS.ErrnoException).code === "ENOENT"
			? "missing"
			: "refused"
	}
}
