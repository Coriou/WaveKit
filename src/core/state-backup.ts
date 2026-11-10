/**
 * Automatic, bounded pre-migration backup of the scanner state directory.
 *
 * A build that reads scanner state written in another format migrates it one way (newer build)
 * or sets unreadable files aside as `.invalid-*` and starts empty (older build). Before either
 * happens, this module compares the format marker on disk (`state-format.json` in the state
 * directory) with the one this build writes and, when they differ, keeps ONE backup of the whole
 * directory at `<dir>/.backups/pre-<fromFormat>`, replacing any earlier backup. It stays inside
 * the directory (excluded from its own walk) so a hard link never crosses a volume and a state
 * directory never writes next to itself (a custom `scanner.storage.dir` may sit anywhere).
 *
 * Files under `recordings/`, `captures/` and `iq-captures/` are hard links (finished files are
 * renamed into place, removed by unlink, never rewritten; staging `.tmp` paths excepted), everything
 * else is copied with a copy-on-write clone where the file system supports
 * one (APFS, btrfs, XFS reflink), else a plain copy: the journal is appended to and truncated in
 * place, so it must never share an inode with the backup. Symlinks are not followed or copied.
 *
 * Never throws: every failure becomes a `skipped` outcome with a fixed reason, and the marker is
 * then written so the next start does not back up the already migrated state under the old name.
 */
import { constants, type BigIntStatsFs } from "node:fs"
import {
	copyFile,
	link,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	statfs,
	writeFile,
} from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { z } from "zod"
import { createComponentLogger } from "../utils/logger.js"
import type { Logger } from "../utils/logger.js"
import { atomicWrite } from "./scanner/store/atomic-write.js"
import { HELD_JOURNAL_FORMAT } from "./scanner/store/held-recordings.js"

/** The marker file, at the top of the scanner state directory. */
export const STATE_FORMAT_FILE = "state-format.json"
/** The backups directory inside the state directory; never itself backed up. */
export const BACKUPS_DIR = ".backups"
/** The receipt written inside a backup. */
export const BACKUP_RECEIPT_FILE = "backup.json"
/**
 * Scanner state file version (`version` in discoveries.json, jobs.json, settings.json; the
 * persistence's FILE_VERSION). Kept here as a constant: bump both together.
 */
export const SCANNER_STATE_FILE_VERSION = 1
/**
 * Bump when a change migrates scanner state one way without changing the file version or the
 * held-journal format (a rewrite an older build cannot read back), so the next start backs up.
 */
export const SCANNER_STATE_REVISION = 1

/**
 * Free space the backup must leave on the volume: 2 GiB = 2048 MiB x 1,048,576 B, the scanner's
 * own `storage.minFreeDiskMb` default, so the backup never pushes the scanner into its low-disk
 * refusal. A backup that would leave less (free - bytes to copy < margin) is skipped.
 */
export const BACKUP_MIN_FREE_BYTES = 2048 * 1024 * 1024
/**
 * Files a backup may hold: 200,000 = the scanner's 10,000 `maxDiscoveries` default x up to
 * 10 files per discovery folder (recordings, sidecars, evidence) x 2 headroom. A larger tree is
 * not walked further and the backup is skipped (`too-many-files`), bounding the startup walk.
 */
export const BACKUP_MAX_FILES = 200_000

export interface StateFormat {
	fileVersion: number
	heldJournalFormat: number
	revision: number
}

export const CURRENT_SCANNER_STATE_FORMAT: StateFormat = {
	fileVersion: SCANNER_STATE_FILE_VERSION,
	heldJournalFormat: HELD_JOURNAL_FORMAT,
	revision: SCANNER_STATE_REVISION,
}

const FormatSchema = z.object({
	fileVersion: z.number().int().min(0).max(1_000_000),
	heldJournalFormat: z.number().int().min(0).max(1_000_000),
	revision: z.number().int().min(0).max(1_000_000),
})

/** `f<fileVersion>-h<heldJournalFormat>-r<revision>`; validated integers only, never raw input. */
export function formatLabel(f: StateFormat): string {
	return `f${f.fileVersion}-h${f.heldJournalFormat}-r${f.revision}`
}

/** On-disk marker: a validated format, `unmarked` (state from a build before markers), `unknown` (malformed). */
type DiskFormat =
	| { kind: "format"; format: StateFormat }
	| { kind: "unmarked" }
	| { kind: "unknown" }

export type BackupSkipReason =
	| "low-disk"
	| "disk-unknown"
	| "too-many-files"
	| "copy-failed"

export type BackupNoneReason = "same-format" | "fresh"

export interface StateBackupTaken {
	kind: "taken"
	fromFormat: string
	toFormat: string
	/** Path relative to the state directory (`.backups/pre-<from>`). */
	path: string
	files: number
	copiedBytes: number
	linkedFiles: number
	replaced: number
}

export interface StateBackupSkipped {
	kind: "skipped"
	reason: BackupSkipReason
	fromFormat: string
	toFormat: string
	/** Bytes to copy and free bytes measured (low-disk only). */
	neededBytes?: number
	freeBytes?: number
}

export interface StateBackupNone {
	kind: "none"
	reason: BackupNoneReason
	toFormat: string
}

export type StateBackupOutcome =
	| StateBackupTaken
	| StateBackupSkipped
	| StateBackupNone

export interface StatFsLike {
	bavail: bigint | number
	bsize: bigint | number
}

export interface PreMigrationBackupOptions {
	/** The scanner state directory. */
	dir: string
	logger: Logger
	now: () => number
	/** Injectable for tests; `fs.statfs(path, { bigint: true })` by default. */
	statfs?: (path: string) => Promise<StatFsLike>
	/** Injectable for tests; `fs.link` by default. */
	link?: (existing: string, target: string) => Promise<void>
	/** The format this build writes; CURRENT_SCANNER_STATE_FORMAT by default. */
	format?: StateFormat
	/** BACKUP_MAX_FILES by default; injectable so the bound is testable. */
	maxFiles?: number
}

function sameFormat(a: StateFormat, b: StateFormat): boolean {
	return (
		a.fileVersion === b.fileVersion &&
		a.heldJournalFormat === b.heldJournalFormat &&
		a.revision === b.revision
	)
}

async function readDiskFormat(dir: string): Promise<DiskFormat> {
	let text: string
	try {
		text = await readFile(join(dir, STATE_FORMAT_FILE), "utf8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT")
			return { kind: "unmarked" }
		return { kind: "unknown" }
	}
	try {
		const parsed = FormatSchema.safeParse(JSON.parse(text))
		return parsed.success
			? { kind: "format", format: parsed.data }
			: { kind: "unknown" }
	} catch {
		return { kind: "unknown" }
	}
}

/** True when the directory exists and holds anything besides the marker. */
async function hasState(dir: string): Promise<boolean> {
	try {
		const names = await readdir(dir)
		return names.some(n => n !== STATE_FORMAT_FILE && n !== BACKUPS_DIR)
	} catch {
		return false
	}
}

interface PlannedFile {
	rel: string
	size: number
	hardLink: boolean
}

interface Plan {
	files: PlannedFile[]
	dirs: string[]
	copyBytes: number
	overflow: boolean
}

/** Trees whose finished files are renamed into place and never rewritten (see the module comment). */
const WRITE_ONCE_TREES = ["recordings", "captures", "iq-captures"]

function writtenOnce(rel: string): boolean {
	const parts = rel.split(sep)
	if (!WRITE_ONCE_TREES.includes(parts[0] ?? "")) return false
	// Staging (`.tmp/` folders, `*.tmp` files) may still be written in place.
	return !parts.some(p => p === ".tmp" || p.endsWith(".tmp"))
}

/** Recursive lstat walk (symlinks and `.backups` skipped), stopping past `maxFiles`. */
async function planTree(root: string, maxFiles: number): Promise<Plan> {
	const plan: Plan = { files: [], dirs: [], copyBytes: 0, overflow: false }
	const stack: string[] = [""]
	while (stack.length > 0) {
		const rel = stack.pop() ?? ""
		const entries = await readdir(join(root, rel), { withFileTypes: true })
		for (const e of entries) {
			if (rel === "" && e.name === BACKUPS_DIR) continue
			const childRel = rel === "" ? e.name : join(rel, e.name)
			if (e.isDirectory()) {
				plan.dirs.push(childRel)
				stack.push(childRel)
				continue
			}
			if (!e.isFile()) continue
			if (plan.files.length >= maxFiles) {
				plan.overflow = true
				return plan
			}
			const st = await lstat(join(root, childRel))
			const hardLink = writtenOnce(childRel)
			plan.files.push({ rel: childRel, size: st.size, hardLink })
			if (!hardLink) plan.copyBytes += st.size
		}
	}
	return plan
}

function toNumber(v: bigint | number): number {
	return typeof v === "bigint" ? Number(v) : v
}

/** Removes leftover partial backups of this directory and returns the names of complete ones. */
async function priorBackups(
	backupsDir: string,
	prefix: string,
): Promise<{ complete: string[]; partial: string[] }> {
	const complete: string[] = []
	const partial: string[] = []
	let names: string[]
	try {
		names = await readdir(backupsDir)
	} catch {
		return { complete, partial }
	}
	for (const n of names) {
		const isPartial = n.startsWith(`.${prefix}`) && n.includes(".partial-")
		if (!isPartial && !n.startsWith(prefix)) continue
		// Only real directories this module made; never follow a symlink out of the backups dir.
		const st = await lstat(join(backupsDir, n)).catch(() => null)
		if (st === null || !st.isDirectory()) continue
		;(isPartial ? partial : complete).push(n)
	}
	return { complete, partial }
}

/**
 * Compares the on-disk format marker with this build's and, when they differ, takes the single
 * kept backup (see the module comment), then writes this build's marker. Call once per process,
 * before anything in the directory is read for migration or rewritten.
 */
export async function ensurePreMigrationBackup(
	opts: PreMigrationBackupOptions,
): Promise<StateBackupOutcome> {
	const log = createComponentLogger(opts.logger, "StateBackup")
	const dir = resolve(opts.dir)
	const current = opts.format ?? CURRENT_SCANNER_STATE_FORMAT
	const toFormat = formatLabel(current)
	const outcome = await decide(dir, current, toFormat, opts)
	try {
		await atomicWrite(
			join(dir, STATE_FORMAT_FILE),
			`${JSON.stringify(current)}\n`,
		)
	} catch (err) {
		log.warn({ err }, "Could not write the scanner state format marker")
	}
	if (outcome.kind === "taken")
		log.info(outcome, "Scanner state backed up before a format change")
	else if (outcome.kind === "skipped")
		log.warn(
			outcome,
			"Scanner state format changed but the pre-migration backup was skipped",
		)
	else log.debug(outcome, "Scanner state format unchanged; no backup needed")
	return outcome
}

async function decide(
	dir: string,
	current: StateFormat,
	toFormat: string,
	opts: PreMigrationBackupOptions,
): Promise<StateBackupOutcome> {
	if (!(await hasState(dir))) return { kind: "none", reason: "fresh", toFormat }
	const disk = await readDiskFormat(dir)
	if (disk.kind === "format" && sameFormat(disk.format, current))
		return { kind: "none", reason: "same-format", toFormat }
	const fromFormat =
		disk.kind === "format" ? formatLabel(disk.format) : disk.kind
	const skipped = (
		reason: BackupSkipReason,
		extra: { neededBytes?: number; freeBytes?: number } = {},
	): StateBackupOutcome => ({
		kind: "skipped",
		reason,
		fromFormat,
		toFormat,
		...extra,
	})

	const backupsDir = join(dir, BACKUPS_DIR)
	const prefix = "pre-"
	const finalName = `${prefix}${fromFormat}`
	const partialName = `.${prefix}${fromFormat}.partial-${opts.now()}`

	let plan: Plan
	try {
		plan = await planTree(dir, opts.maxFiles ?? BACKUP_MAX_FILES)
	} catch {
		return skipped("copy-failed")
	}
	if (plan.overflow) return skipped("too-many-files")

	let freeBytes: number
	try {
		const fsStat = await (opts.statfs ?? defaultStatfs)(dir)
		freeBytes = toNumber(fsStat.bavail) * toNumber(fsStat.bsize)
	} catch {
		// Unknown free space: the safe answer is not to risk filling the disk.
		return skipped("disk-unknown")
	}
	if (!Number.isFinite(freeBytes) || freeBytes < 0)
		return skipped("disk-unknown")
	// Counted as full copies: a clone may cost nothing, but that is not known in advance.
	if (freeBytes - plan.copyBytes < BACKUP_MIN_FREE_BYTES)
		return skipped("low-disk", { neededBytes: plan.copyBytes, freeBytes })

	const prior = await priorBackups(backupsDir, prefix)
	for (const p of prior.partial)
		await rm(join(backupsDir, p), { recursive: true, force: true }).catch(
			() => undefined,
		)

	const partialDir = join(backupsDir, partialName)
	const doLink = opts.link ?? link
	let linkedFiles = 0
	try {
		await mkdir(partialDir, { recursive: true })
		for (const d of plan.dirs)
			await mkdir(join(partialDir, d), { recursive: true })
		for (const f of plan.files) {
			const src = join(dir, f.rel)
			const dst = join(partialDir, f.rel)
			if (f.hardLink) {
				try {
					await doLink(src, dst)
					linkedFiles++
					continue
				} catch {
					// EXDEV, EPERM, a file system without links: fall back to a copy.
				}
			}
			await copyFile(src, dst, constants.COPYFILE_FICLONE)
		}
		const receipt = {
			fromFormat,
			toFormat,
			takenAt: new Date(opts.now()).toISOString(),
			files: plan.files.length,
			copiedBytes: plan.copyBytes,
			linkedFiles,
		}
		await writeFile(
			join(partialDir, BACKUP_RECEIPT_FILE),
			`${JSON.stringify(receipt, null, "\t")}\n`,
		)
		// Only now, with the new backup complete, the older one goes (one kept backup).
		for (const c of prior.complete)
			await rm(join(backupsDir, c), { recursive: true, force: true })
		await rename(partialDir, join(backupsDir, finalName))
	} catch {
		await rm(partialDir, { recursive: true, force: true }).catch(
			() => undefined,
		)
		return skipped("copy-failed")
	}
	return {
		kind: "taken",
		fromFormat,
		toFormat,
		path: join(BACKUPS_DIR, finalName),
		files: plan.files.length,
		copiedBytes: plan.copyBytes,
		linkedFiles,
		replaced: prior.complete.length,
	}
}

async function defaultStatfs(path: string): Promise<BigIntStatsFs> {
	return await statfs(path, { bigint: true })
}
