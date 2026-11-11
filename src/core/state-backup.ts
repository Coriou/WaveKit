/**
 * Automatic, bounded pre-migration backup of the scanner state directory.
 *
 * A build that reads scanner state written in another format migrates it one way (newer build)
 * or sets unreadable files aside as `.invalid-*` and starts empty (older build). Before either
 * happens, this module compares the format marker on disk (`state-format.json` in the state
 * directory) with the one this build writes and, when they differ, backs the whole directory up
 * to `<dir>/.backups/pre-<fromFormat>.<takenAt ms>`. It stays inside the directory (excluded from
 * its own walk) so a hard link never crosses a volume and a state directory never writes next to
 * itself (a custom `scanner.storage.dir` may sit anywhere). The backup carries the marker it was
 * taken under (none for unmarked state) and, when the caller names it, a copy of the recording
 * keep store, which lives outside the scanner directory, under `outside/`.
 *
 * Retention (pruneBackups): at most one backup per source format, at most BACKUP_MAX_KEPT in all,
 * and never the one whose source format is this build's (the state this build wrote before an
 * older build migrated it away), so an upgrade, a downgrade and the next upgrade each keep the
 * copy that undoes them. A new backup is renamed into place before any older one is deleted, so
 * a crash in between leaves an extra complete backup, pruned on the next start. A backup expires
 * (noteCleanLoad) once it is BACKUP_EXPIRY_MS old and the state has loaded cleanly
 * BACKUP_EXPIRY_CLEAN_LOADS times on the format it migrated to: its hard-linked recordings keep
 * their disk space until then.
 *
 * Files under `recordings/`, `captures/` and `iq-captures/` are hard links (finished files are
 * renamed into place, removed by unlink, never rewritten; staging `.tmp` paths excepted), everything
 * else is copied with a copy-on-write clone where the file system supports
 * one (APFS, btrfs, XFS reflink), else a plain copy: the journal is appended to and truncated in
 * place, so it must never share an inode with the backup. Symlinks are not followed or copied.
 *
 * Never throws: every failure becomes a `skipped` outcome with a fixed reason, and the marker is
 * then written so the next start does not back up the already migrated state under the old name;
 * except an unreadable directory, whose marker is left alone (nothing is known about its state).
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
import { RECORDING_KEEPS_FILE_NAME } from "@wavekit/api-types"
import { WaveKitError } from "../utils/errors.js"
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
/**
 * Backups kept at most: 2 = the pre-upgrade copy (older format, taken by a newer build) plus
 * the pre-downgrade copy (newer format, taken by an older build started on it). One per source
 * format; a third format change deletes the oldest by receipt time, never this build's own.
 */
export const BACKUP_MAX_KEPT = 2
/**
 * A backup expires once it is 14 days old: 14 x 86,400,000 ms = 1,209,600,000 ms, two weeks of
 * running on the new format, long enough to notice a regression that calls for a rollback...
 */
export const BACKUP_EXPIRY_MS = 14 * 86_400_000
/**
 * ...and once the state has loaded cleanly 3 times on the format it migrated to (counted in the
 * receipt, one per process start): an age alone could expire a backup on a core that never ran.
 */
export const BACKUP_EXPIRY_CLEAN_LOADS = 3
/** Folder inside a backup for files from outside the state directory (the keep store). */
export const BACKUP_OUTSIDE_DIR = "outside"
/**
 * Candidate names tried for a new backup (`pre-<from>.<ms>`, then `-1`, `-2`...): 8 > the
 * BACKUP_MAX_KEPT kept plus one leftover of a crash, so a free name is always found in practice.
 */
const BACKUP_NAME_TRIES = 8
/**
 * File operations in flight at once during the walk and the copy: 16 = 4x libuv's default
 * thread pool of 4, enough to keep every pool thread busy while results come back, small enough
 * that a 200,000-file tree never queues more than 16 requests (no burst of open descriptors).
 */
export const BACKUP_IO_CONCURRENCY = 16

/** Runs `fn` over `items` with at most `limit` in flight; rejects with the first failure. */
async function forEachLimited<T>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0
	let failed = false
	const worker = async (): Promise<void> => {
		while (!failed && next < items.length) {
			const item = items[next++] as T
			try {
				await fn(item)
			} catch (err) {
				failed = true
				throw err
			}
		}
	}
	const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
		worker(),
	)
	const results = await Promise.allSettled(workers)
	for (const r of results) if (r.status === "rejected") throw r.reason
}

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
	| "unreadable"
	| "low-disk"
	| "disk-unknown"
	| "too-many-files"
	| "copy-failed"

export type BackupNoneReason = "same-format" | "fresh"

export interface StateBackupTaken {
	kind: "taken"
	fromFormat: string
	toFormat: string
	/** Path relative to the state directory (`.backups/pre-<from>.<ms>`). */
	path: string
	files: number
	copiedBytes: number
	linkedFiles: number
	/** Whether the keep store (keepsFile) was copied into `outside/`. */
	keepsCopied: boolean
	/** Older backups deleted by retention after this one was in place. */
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
	/**
	 * The recording keep store (`<stateDir>/recording-keeps.json`), outside the scanner directory;
	 * copied into the backup's `outside/` folder when given and present.
	 */
	keepsFile?: string
	/** Injectable for tests (a crash between the rename and the deletes); `fs.rm` by default. */
	remove?: (path: string) => Promise<void>
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

/** Whether the directory holds anything besides the marker and backups; missing is `empty`. */
async function stateKind(
	dir: string,
): Promise<"state" | "empty" | "unreadable"> {
	try {
		const names = await readdir(dir)
		return names.some(n => n !== STATE_FORMAT_FILE && n !== BACKUPS_DIR)
			? "state"
			: "empty"
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT"
			? "empty"
			: "unreadable"
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

/**
 * Recursive walk (symlinks and `.backups` skipped), stopping past `maxFiles`; then the sizes of
 * the copied files (hard-linked ones cost no space and need no lstat), BACKUP_IO_CONCURRENCY at once.
 */
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
			plan.files.push({
				rel: childRel,
				size: 0,
				hardLink: writtenOnce(childRel),
			})
		}
	}
	const copied = plan.files.filter(f => !f.hardLink)
	await forEachLimited(copied, BACKUP_IO_CONCURRENCY, async f => {
		f.size = (await lstat(join(root, f.rel))).size
	})
	for (const f of copied) plan.copyBytes += f.size
	return plan
}

function toNumber(v: bigint | number): number {
	return typeof v === "bigint" ? Number(v) : v
}

const ReceiptSchema = z.object({
	fromFormat: z.string().max(64),
	toFormat: z.string().max(64),
	takenAt: z.string().max(64),
	takenAtMs: z.number().int().min(0).optional(),
	cleanLoads: z.number().int().min(0).max(1_000_000).optional(),
})
type Receipt = z.infer<typeof ReceiptSchema>

interface KeptBackup {
	name: string
	/** null: no readable receipt (oldest, never expires, its own source format). */
	receipt: Receipt | null
	/** Receipt time in ms; 0 without one. */
	at: number
}

/** Receipts are this module's own files: 64 KiB is far past one (about 300 bytes). */
const RECEIPT_MAX_BYTES = 64 * 1024

async function readReceipt(path: string): Promise<Receipt | null> {
	try {
		const st = await lstat(path)
		if (!st.isFile() || st.size > RECEIPT_MAX_BYTES) return null
		const parsed = ReceiptSchema.safeParse(
			JSON.parse(await readFile(path, "utf8")),
		)
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

function receiptTime(r: Receipt | null): number {
	if (r === null) return 0
	if (r.takenAtMs !== undefined) return r.takenAtMs
	const t = Date.parse(r.takenAt)
	return Number.isFinite(t) ? t : 0
}

/** Complete backups (`pre-*` real directories) and leftover partial ones (`.pre-*.partial-*`). */
async function listBackups(
	backupsDir: string,
): Promise<{ complete: KeptBackup[]; partial: string[] }> {
	const complete: KeptBackup[] = []
	const partial: string[] = []
	let names: string[]
	try {
		names = await readdir(backupsDir)
	} catch {
		return { complete, partial }
	}
	for (const n of names) {
		const isPartial = n.startsWith(".pre-") && n.includes(".partial-")
		if (!isPartial && !n.startsWith("pre-")) continue
		// Only real directories this module made; never follow a symlink out of the backups dir.
		const st = await lstat(join(backupsDir, n)).catch(() => null)
		if (st === null || !st.isDirectory()) continue
		if (isPartial) {
			partial.push(n)
			continue
		}
		const receipt = await readReceipt(join(backupsDir, n, BACKUP_RECEIPT_FILE))
		complete.push({ name: n, receipt, at: receiptTime(receipt) })
	}
	return { complete, partial }
}

/**
 * Which complete backups retention deletes: all but the newest of each source format, then the
 * oldest by receipt time until BACKUP_MAX_KEPT remain, never `keep` (the one just taken) nor the
 * one whose source format is `ownFormat` (this build's). Pure, so the rule is testable alone.
 */
export function backupsToPrune(
	backups: ReadonlyArray<{
		name: string
		fromFormat: string | null
		at: number
	}>,
	ownFormat: string,
	keep: string | null,
): string[] {
	// The just-taken one first (it wins its format even past a clock step back), then newest first.
	const order = [...backups].sort(
		(a, b) =>
			Number(b.name === keep) - Number(a.name === keep) ||
			b.at - a.at ||
			(a.name < b.name ? 1 : -1),
	)
	const seen = new Set<string>()
	const kept: typeof order = []
	const doomed: string[] = []
	for (const b of order) {
		const group = b.fromFormat ?? `?${b.name}`
		if (seen.has(group) && b.name !== keep) doomed.push(b.name)
		else {
			seen.add(group)
			kept.push(b)
		}
	}
	// Oldest first among the deletable ones.
	const deletable = kept
		.filter(b => b.name !== keep && b.fromFormat !== ownFormat)
		.reverse()
	let count = kept.length
	for (const b of deletable) {
		if (count <= BACKUP_MAX_KEPT) break
		doomed.push(b.name)
		count--
	}
	return doomed
}

async function pruneBackups(
	backupsDir: string,
	ownFormat: string,
	keep: string | null,
	remove: (path: string) => Promise<void>,
	log: Logger,
): Promise<number> {
	const { complete, partial } = await listBackups(backupsDir)
	for (const p of partial)
		await remove(join(backupsDir, p)).catch(() => undefined)
	const doomed = backupsToPrune(
		complete.map(b => ({
			name: b.name,
			fromFormat: b.receipt?.fromFormat ?? null,
			at: b.at,
		})),
		ownFormat,
		keep,
	)
	let removed = 0
	for (const name of doomed) {
		try {
			await remove(join(backupsDir, name))
			removed++
			log.info({ backup: name }, "Removed an older scanner state backup")
		} catch (err) {
			log.warn(
				{ err, backup: name },
				"Could not remove an older scanner state backup; retried on the next start",
			)
		}
	}
	return removed
}

async function defaultRemove(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true })
}

/**
 * Compares the on-disk format marker with this build's and, when they differ, takes a backup
 * (see the module comment), prunes older ones, then writes this build's marker. Call once per
 * process, before anything in the directory is read for migration or rewritten.
 */
export async function ensurePreMigrationBackup(
	opts: PreMigrationBackupOptions,
): Promise<StateBackupOutcome> {
	const log = createComponentLogger(opts.logger, "StateBackup")
	const dir = resolve(opts.dir)
	const current = opts.format ?? CURRENT_SCANNER_STATE_FORMAT
	const toFormat = formatLabel(current)
	const outcome = await decide(dir, current, toFormat, opts, log)
	// An unreadable directory says nothing about its format: leave its marker alone.
	if (!(outcome.kind === "skipped" && outcome.reason === "unreadable")) {
		try {
			await atomicWrite(
				join(dir, STATE_FORMAT_FILE),
				`${JSON.stringify(current)}\n`,
			)
		} catch (err) {
			log.warn({ err }, "Could not write the scanner state format marker")
		}
	}
	if (outcome.kind === "taken")
		log.info(outcome, "Scanner state backed up before a format change")
	else if (outcome.kind === "skipped")
		log.warn(
			outcome,
			outcome.reason === "unreadable"
				? "Scanner state directory could not be listed; no pre-migration backup and no format marker"
				: "Scanner state format changed but the pre-migration backup was skipped",
		)
	else log.debug(outcome, "Scanner state format unchanged; no backup needed")
	return outcome
}

async function decide(
	dir: string,
	current: StateFormat,
	toFormat: string,
	opts: PreMigrationBackupOptions,
	log: Logger,
): Promise<StateBackupOutcome> {
	const backupsDir = join(dir, BACKUPS_DIR)
	const remove = opts.remove ?? defaultRemove
	const kind = await stateKind(dir)
	if (kind === "unreadable")
		return {
			kind: "skipped",
			reason: "unreadable",
			fromFormat: "unknown",
			toFormat,
		}
	if (kind === "empty") return { kind: "none", reason: "fresh", toFormat }
	const disk = await readDiskFormat(dir)
	if (disk.kind === "format" && sameFormat(disk.format, current)) {
		// Finishes a retention an earlier start could not (a crash after its rename).
		await pruneBackups(backupsDir, toFormat, null, remove, log)
		return { kind: "none", reason: "same-format", toFormat }
	}
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

	let plan: Plan
	try {
		plan = await planTree(dir, opts.maxFiles ?? BACKUP_MAX_FILES)
	} catch {
		return skipped("copy-failed")
	}
	if (plan.overflow) return skipped("too-many-files")

	let keepsSize: number | null = null
	if (opts.keepsFile !== undefined) {
		const st = await lstat(opts.keepsFile).catch(() => null)
		if (st?.isFile() === true) keepsSize = st.size
	}
	const copyBytes = plan.copyBytes + (keepsSize ?? 0)

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
	if (freeBytes - copyBytes < BACKUP_MIN_FREE_BYTES)
		return skipped("low-disk", { neededBytes: copyBytes, freeBytes })

	// Leftover partial copies of a crashed start go first; complete backups stay for now.
	const { partial } = await listBackups(backupsDir)
	for (const p of partial)
		await remove(join(backupsDir, p)).catch(() => undefined)

	const takenAtMs = opts.now()
	const partialDir = join(backupsDir, `.pre-${fromFormat}.partial-${takenAtMs}`)
	const doLink = opts.link ?? link
	let linkedFiles = 0
	let finalName: string
	try {
		await mkdir(partialDir, { recursive: true })
		// `recursive` makes the order irrelevant: a child's mkdir creates its parent if first.
		await forEachLimited(plan.dirs, BACKUP_IO_CONCURRENCY, async d => {
			await mkdir(join(partialDir, d), { recursive: true })
		})
		await forEachLimited(plan.files, BACKUP_IO_CONCURRENCY, async f => {
			const src = join(dir, f.rel)
			const dst = join(partialDir, f.rel)
			if (f.hardLink) {
				try {
					await doLink(src, dst)
					linkedFiles++
					return
				} catch {
					// EXDEV, EPERM, a file system without links: fall back to a copy.
				}
			}
			await copyFile(src, dst, constants.COPYFILE_FICLONE)
		})
		if (opts.keepsFile !== undefined && keepsSize !== null) {
			await mkdir(join(partialDir, BACKUP_OUTSIDE_DIR), { recursive: true })
			await copyFile(
				opts.keepsFile,
				join(partialDir, BACKUP_OUTSIDE_DIR, RECORDING_KEEPS_FILE_NAME),
				constants.COPYFILE_FICLONE,
			)
		}
		const receipt = {
			fromFormat,
			toFormat,
			takenAt: new Date(takenAtMs).toISOString(),
			takenAtMs,
			cleanLoads: 0,
			files: plan.files.length,
			copiedBytes: copyBytes,
			linkedFiles,
			keepsCopied: keepsSize !== null,
		}
		await writeFile(
			join(partialDir, BACKUP_RECEIPT_FILE),
			`${JSON.stringify(receipt, null, "\t")}\n`,
		)
		finalName = await freeName(backupsDir, `pre-${fromFormat}.${takenAtMs}`)
		// The new backup is in place before any older one goes (pruneBackups below).
		await rename(partialDir, join(backupsDir, finalName))
	} catch {
		await remove(partialDir).catch(() => undefined)
		return skipped("copy-failed")
	}
	const replaced = await pruneBackups(
		backupsDir,
		toFormat,
		finalName,
		remove,
		log,
	)
	return {
		kind: "taken",
		fromFormat,
		toFormat,
		path: join(BACKUPS_DIR, finalName),
		files: plan.files.length,
		copiedBytes: copyBytes,
		linkedFiles,
		keepsCopied: keepsSize !== null,
		replaced,
	}
}

/** `base`, else `base-1`... (BACKUP_NAME_TRIES in all); throws when none is free. */
async function freeName(backupsDir: string, base: string): Promise<string> {
	for (let i = 0; i < BACKUP_NAME_TRIES; i++) {
		const name = i === 0 ? base : `${base}-${i}`
		const taken = await lstat(join(backupsDir, name)).then(
			() => true,
			(err: unknown) => (err as NodeJS.ErrnoException).code !== "ENOENT",
		)
		if (!taken) return name
	}
	throw new WaveKitError("No free scanner backup name", "STATE_BACKUP_NAME")
}

export interface CleanLoadOptions {
	dir: string
	logger: Logger
	now: () => number
	format?: StateFormat
	remove?: (path: string) => Promise<void>
}

/**
 * After a clean load of the state (once per process): counts it in the receipt of every backup
 * taken on the way to this build's format, and deletes one that is BACKUP_EXPIRY_MS old with
 * BACKUP_EXPIRY_CLEAN_LOADS clean loads counted (the load in the process that took it counts).
 * Returns the names deleted. Never throws.
 */
export async function noteCleanLoad(opts: CleanLoadOptions): Promise<string[]> {
	const log = createComponentLogger(opts.logger, "StateBackup")
	const backupsDir = join(resolve(opts.dir), BACKUPS_DIR)
	const own = formatLabel(opts.format ?? CURRENT_SCANNER_STATE_FORMAT)
	const remove = opts.remove ?? defaultRemove
	const expired: string[] = []
	const { complete } = await listBackups(backupsDir)
	for (const b of complete) {
		if (b.receipt === null || b.receipt.toFormat !== own) continue
		const receiptPath = join(backupsDir, b.name, BACKUP_RECEIPT_FILE)
		const cleanLoads = (b.receipt.cleanLoads ?? 0) + 1
		const ageMs = opts.now() - b.at
		try {
			if (
				ageMs >= BACKUP_EXPIRY_MS &&
				cleanLoads >= BACKUP_EXPIRY_CLEAN_LOADS
			) {
				await remove(join(backupsDir, b.name))
				expired.push(b.name)
				log.info(
					{ backup: b.name, ageMs, cleanLoads },
					"Removed an expired scanner state backup (its recordings' space is freed)",
				)
				continue
			}
			// Rewrites the whole receipt, keeping its other fields as they were.
			const raw: unknown = JSON.parse(await readFile(receiptPath, "utf8"))
			const fields =
				raw !== null && typeof raw === "object" && !Array.isArray(raw)
					? raw
					: {}
			await atomicWrite(
				receiptPath,
				`${JSON.stringify({ ...fields, cleanLoads }, null, "\t")}\n`,
			)
		} catch (err) {
			log.warn(
				{ err, backup: b.name },
				"Could not update a scanner state backup receipt",
			)
		}
	}
	return expired
}

async function defaultStatfs(path: string): Promise<BigIntStatsFs> {
	return await statfs(path, { bigint: true })
}
