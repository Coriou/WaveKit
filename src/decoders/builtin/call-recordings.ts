/**
 * Retention for dsd-fme per-call WAV recordings (`-7 <dir> -P`).
 *
 * Only files named by dsd-fme are touched (dsd_file.c, pinned ed1d1d6):
 * close_and_rename_wav_file writes
 * `<YYYYMMDD>_<HHMMSS>_<%05d random>_<sysid>_<GROUP|PRIVATE>_TGT_<tgt>_SRC_<src>.wav`
 * and open_wav_file writes the in-progress `TEMP_<YYYYMMDD>_<HHMMSS>_<%04X>.wav`
 * (left behind if dsd-fme dies mid-call). Any other WAV in the directory
 * (a user's own files, other tools) is never deleted.
 *
 * Files older than the age limit are deleted, then the oldest remaining files
 * are deleted until the directory total fits the size limit. Files modified
 * in the last few seconds are never touched: dsd-fme may still be writing
 * the current call.
 */

import { promises as fs } from "node:fs"
import * as path from "node:path"

import type { RecordingProtection } from "../../core/recordings/contract.js"
import type { Logger } from "../../utils/logger.js"
import { createComponentLogger, createLogger } from "../../utils/logger.js"

export interface CallRecordingRetention {
	/** Keep at most this many megabytes (MiB) of recordings. */
	maxTotalMb: number
	/** Delete recordings older than this. */
	maxAgeHours: number
}

export interface PruneResult {
	deleted: string[]
	keptFiles: number
	keptBytes: number
	/**
	 * Files the age or size rule chose but the recording protection port kept (WG9 req 2.5).
	 * Present only while a port is installed, so the result is unchanged without one.
	 */
	protectedSkipped?: number
}

let protectionPort: RecordingProtection | null = null
let protectionLog: Logger | null = null

/**
 * The skipped-count log when no logger was injected (the frozen one-argument form): a
 * module-level logger created on first need, as src/access/sessions.ts does, so a port-null
 * run never creates one and its behaviour and logs stay byte-identical.
 */
let fallbackLog: Logger | null = null
function skipLog(): Logger {
	if (protectionLog !== null) return protectionLog
	fallbackLog ??= createComponentLogger(
		createLogger({ level: "info" }),
		"CallRecordings",
	)
	return fallbackLog
}

/**
 * Installs the deletion decision the pruner consults before each unlink (WG9 req 2.5); null
 * restores the unprotected behaviour. The skipped count (never a name or path) is logged to
 * the optional logger, or to a module-level fallback logger without one.
 */
export function setCallRecordingProtection(
	protection: RecordingProtection | null,
	logger?: Logger,
): void {
	protectionPort = protection
	protectionLog =
		protection !== null && logger !== undefined
			? createComponentLogger(logger, "CallRecordings")
			: null
}

/** Fail closed: a throwing port counts as protected. */
function isProtectedFile(port: RecordingProtection, file: string): boolean {
	try {
		return port.isDsdFmeFileProtected(path.basename(file)) !== false
	} catch {
		return true
	}
}

/**
 * WG9 R2: an operator-configured recording root that is itself a symlink, resolved by
 * realpath once (operator config is trusted). Deleters use `real` as their base, so a symlink
 * below it is still refused, and refuse the whole root when the real directory's identity
 * (dev/ino) no longer matches. Only symlinked roots are pinned: a real directory root keeps
 * today's per-run checks unchanged.
 */
export interface PinnedRecordingRoot {
	/** The configured path (absolute). */
	readonly configured: string
	/** realpath of the configured path at first resolution. */
	readonly real: string
	readonly dev: number
	readonly ino: number
}

const rootPins = new Map<string, Promise<PinnedRecordingRoot | null>>()

async function resolveRecordingRoot(
	abs: string,
): Promise<PinnedRecordingRoot | null> {
	try {
		if (!(await fs.lstat(abs)).isSymbolicLink()) return null
		const real = await fs.realpath(abs)
		const st = await fs.lstat(real)
		if (st.isSymbolicLink() || !st.isDirectory()) return null
		return { configured: abs, real, dev: st.dev, ino: st.ino }
	} catch {
		// Missing (or unreadable) at first resolution: today's behaviour.
		return null
	}
}

/**
 * The pin of a configured recording root, resolved once per process per configured path; null
 * when the root was not a symlink to a directory at that moment (missing, a real directory, a
 * dangling link), which keeps today's behaviour for it.
 */
export function pinRecordingRoot(
	dir: string,
): Promise<PinnedRecordingRoot | null> {
	const abs = path.resolve(dir)
	let pin = rootPins.get(abs)
	if (pin === undefined) {
		pin = resolveRecordingRoot(abs)
		rootPins.set(abs, pin)
	}
	return pin
}

/** Test seam: forgets every pin (a fresh process). */
export function resetRecordingRootPins(): void {
	rootPins.clear()
}

/** True while the pinned real root is still the same real directory (fail closed). */
export async function recordingRootIntact(
	pin: PinnedRecordingRoot,
): Promise<boolean> {
	try {
		const st = await fs.lstat(pin.real)
		return (
			!st.isSymbolicLink() &&
			st.isDirectory() &&
			st.dev === pin.dev &&
			st.ino === pin.ino
		)
	} catch {
		return false
	}
}

/** `p` re-based from the configured root onto the pinned real root (other paths unchanged). */
export function rebaseOnRecordingRoot(
	pin: PinnedRecordingRoot,
	p: string,
): string {
	const abs = path.resolve(p)
	if (abs === pin.configured) return pin.real
	if (abs.startsWith(pin.configured + path.sep))
		return path.join(pin.real, abs.slice(pin.configured.length + 1))
	return p
}

/** dsd-fme's final per-call recording name. */
export const DSD_FME_CALL_WAV = /^\d{8}_\d{6}_\d{5}_.*_TGT_.*_SRC_.*\.wav$/
/** dsd-fme's in-progress recording name. */
export const DSD_FME_TEMP_WAV = /^TEMP_\d{8}_\d{6}_[0-9A-F]{4}\.wav$/

/** True for a WAV file named by dsd-fme's per-call recorder. */
export function isDsdFmeRecording(name: string): boolean {
	return DSD_FME_CALL_WAV.test(name) || DSD_FME_TEMP_WAV.test(name)
}

/** A recording modified this recently may still be open in dsd-fme. */
export const RECORDING_IN_PROGRESS_MS = 10_000

interface RecordingFile {
	path: string
	size: number
	mtimeMs: number
}

async function listWavFiles(dir: string): Promise<RecordingFile[]> {
	let names: string[]
	try {
		names = await fs.readdir(dir)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
		throw err
	}
	const files: RecordingFile[] = []
	for (const name of names) {
		if (!isDsdFmeRecording(name)) continue
		const file = path.join(dir, name)
		try {
			const stat = await fs.stat(file)
			if (stat.isFile()) {
				files.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs })
			}
		} catch {
			// Removed meanwhile.
		}
	}
	return files
}

/**
 * True when `dir` is a real directory (lstat: not a symlink). Missing is "safe" (it lists
 * as empty, as before). Only used while a protection port is installed.
 */
async function isRealDirOrMissing(dir: string): Promise<boolean> {
	try {
		const st = await fs.lstat(dir)
		return !st.isSymbolicLink() && st.isDirectory()
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return true
		throw err
	}
}

/**
 * The guarded listing used while a protection port is installed (WG9 req 2.5): a scanned
 * directory that is a symlink or not a real directory (or lies under one of the scanned
 * directories that is) is never listed, so nothing in it is ever unlinked; a candidate that
 * is a symlink is never a candidate (lstat, fail closed). The port only knows dsd-fme
 * basenames, so following a link could reach a kept recording it cannot recognise.
 */
async function listWavFilesGuarded(
	dirs: readonly string[],
): Promise<{ files: RecordingFile[]; unsafeSkipped: number }> {
	let unsafeSkipped = 0
	const unsafe: string[] = []
	for (const dir of dirs) {
		if (!(await isRealDirOrMissing(dir))) unsafe.push(path.resolve(dir))
	}
	const files: RecordingFile[] = []
	for (const dir of dirs) {
		const abs = path.resolve(dir)
		if (unsafe.some(u => abs === u || abs.startsWith(u + path.sep))) {
			unsafeSkipped++
			continue
		}
		let names: string[]
		try {
			names = await fs.readdir(dir)
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue
			throw err
		}
		for (const name of names) {
			if (!isDsdFmeRecording(name)) continue
			const file = path.join(dir, name)
			try {
				const stat = await fs.lstat(file)
				if (stat.isSymbolicLink()) {
					unsafeSkipped++
				} else if (stat.isFile()) {
					files.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs })
				}
			} catch {
				// Removed meanwhile.
			}
		}
	}
	return { files, unsafeSkipped }
}

/**
 * Applies the retention policy to the dsd-fme recordings directly in `dirs`. With `root` (the
 * configured recording directory the dirs live in, WG9 R2), a root that was a symlink at its
 * first resolution is followed once: the dirs are re-based on its real directory, and a real
 * directory whose identity changed since is refused (nothing deleted, a count logged).
 */
export async function pruneCallRecordings(
	dirs: readonly string[],
	retention: CallRecordingRetention,
	nowMs: number = Date.now(),
	root?: string,
): Promise<PruneResult> {
	if (root !== undefined) {
		const pin = await pinRecordingRoot(root)
		if (pin !== null) {
			if (!(await recordingRootIntact(pin))) {
				skipLog().warn(
					{ rootChanged: 1 },
					"Per-call recording retention refused a recording root that changed",
				)
				return {
					deleted: [],
					keptFiles: 0,
					keptBytes: 0,
					...(protectionPort !== null ? { protectedSkipped: 0 } : {}),
				}
			}
			dirs = dirs.map(d => rebaseOnRecordingRoot(pin, d))
		}
	}
	let files: RecordingFile[]
	let unsafeSkipped = 0
	if (protectionPort === null) {
		files = (await Promise.all(dirs.map(listWavFiles))).flat()
	} else {
		const guarded = await listWavFilesGuarded(dirs)
		files = guarded.files
		unsafeSkipped = guarded.unsafeSkipped
	}
	files.sort((a, b) => a.mtimeMs - b.mtimeMs)

	const maxAgeMs = retention.maxAgeHours * 3_600_000
	const maxBytes = retention.maxTotalMb * 1024 * 1024
	const deleted: string[] = []
	const kept: RecordingFile[] = []
	let total = files.reduce((sum, file) => sum + file.size, 0)
	let protectedSkipped = 0

	for (const file of files) {
		const age = nowMs - file.mtimeMs
		const inProgress = age < RECORDING_IN_PROGRESS_MS
		const expired = age > maxAgeMs
		if (!inProgress && (expired || total > maxBytes)) {
			// Read the port per file, synchronously, right before the unlink (WG9 req 2.5).
			const port = protectionPort
			if (port !== null && isProtectedFile(port, file.path)) {
				// Kept: it still counts toward the total (size accounting unchanged).
				protectedSkipped++
				kept.push(file)
				continue
			}
			try {
				await fs.unlink(file.path)
				deleted.push(file.path)
				total -= file.size
				continue
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					total -= file.size
					continue
				}
				throw err
			}
		}
		kept.push(file)
	}

	if (protectionPort === null) {
		return { deleted, keptFiles: kept.length, keptBytes: total }
	}
	if (protectedSkipped > 0) {
		skipLog().info(
			{ protectedSkipped },
			"Per-call recording retention skipped kept recordings",
		)
	}
	if (unsafeSkipped > 0) {
		skipLog().info(
			{ unsafeSkipped },
			"Per-call recording retention skipped symlinked or non-directory entries",
		)
	}
	return { deleted, keptFiles: kept.length, keptBytes: total, protectedSkipped }
}
