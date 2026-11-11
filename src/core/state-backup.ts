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
 * keep store, which lives outside the scanner directory, under `outside/` (the scanner does not
 * name it yet, so the user docs do not promise it).
 *
 * Retention (pruneBackups): at most one backup per source format, at most BACKUP_MAX_KEPT in all,
 * and never the one whose source format is this build's (the state this build wrote before an
 * older build migrated it away), so an upgrade, a downgrade and the next upgrade each keep the
 * copy that undoes them. Order is the receipt's `seq` (one more than the highest kept when taken),
 * then its time: a sequence, so a wall clock stepped back never makes the newest look oldest. A
 * new backup is renamed into place before any older one is deleted, so a crash in between leaves
 * an extra complete backup, pruned on the next start. A backup expires (noteCleanLoad) once it is
 * BACKUP_EXPIRY_MS old and the state has loaded cleanly BACKUP_EXPIRY_CLEAN_LOADS times on the
 * format it migrated to (`cleanLoads`); this build's own-format backup instead once it is that old
 * and this build has loaded cleanly that many times since (`ownFormatCleanLoads`), when its
 * retention protection lapses too. Its hard-linked recordings keep their disk space until then.
 * Expiry trusts the wall clock (`now`): a clock far ahead (a receiver without a real-time clock
 * before NTP corrects it) can age a backup early; the clean-load count still has to be reached.
 *
 * Files under `recordings/`, `captures/` and `iq-captures/` are hard links (finished files are
 * renamed into place, removed by unlink, never rewritten; staging `.tmp` paths excepted), everything
 * else is copied with a copy-on-write clone where the file system supports
 * one (APFS, btrfs, XFS reflink), else a plain copy: the journal is appended to and truncated in
 * place, so it must never share an inode with the backup. Symlinks are not followed or copied.
 * A link that fails (EPERM, EXDEV) falls back to a copy, whose size is checked against the margin
 * before it is made. Copied files, the receipt and every backup directory are flushed to disk
 * (fsync) before the rename into place, and the backups directory after it.
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
	open,
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
import type { ScannerStateBackupStatus } from "@wavekit/api-types"
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
 * format; a third format change deletes the oldest (by `seq`), never this build's own while
 * its protection holds (see noteCleanLoad).
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
/**
 * Highest value of a receipt counter (`cleanLoads`, `ownFormatCleanLoads`, `seq`): the schema's
 * bound, so a counter stops there and the receipt stays valid (1,000,000 loads is centuries of
 * restarts; the expiry thresholds are far below it).
 */
export const BACKUP_RECEIPT_COUNT_MAX = 1_000_000
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

/** The outcome as scanner status shows it (`ScannerStatus.stateBackup`); null before the check. */
export function backupStatusOf(
	outcome: StateBackupOutcome | null,
): ScannerStateBackupStatus | null {
	if (outcome === null) return null
	if (outcome.kind === "none")
		return {
			outcome: "none",
			reason: outcome.reason,
			toFormat: outcome.toFormat,
		}
	if (outcome.kind === "skipped")
		return {
			outcome: "skipped",
			reason: outcome.reason,
			fromFormat: outcome.fromFormat,
			toFormat: outcome.toFormat,
		}
	return {
		outcome: "taken",
		fromFormat: outcome.fromFormat,
		toFormat: outcome.toFormat,
		path: outcome.path,
	}
}

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
	/**
	 * Injectable for tests; by default opens the path and flushes it to disk (`FileHandle.sync`).
	 * A file's failure fails the backup (`copy-failed`); a directory's is ignored (some file
	 * systems refuse to sync a directory, and its entries are then as durable as they get).
	 */
	fsync?: (path: string, kind: "file" | "dir") => Promise<void>
}

/** Thrown inside the copy when a link fallback's copy would cross BACKUP_MIN_FREE_BYTES. */
class FallbackLowDisk extends WaveKitError {
	/** `size`: the bytes of the copy that tripped the check, counted in the skip's neededBytes. */
	constructor(readonly size: number) {
		super(
			"A hard-link fallback copy would leave less than the free-space margin",
			"STATE_BACKUP_LOW_DISK",
		)
	}
}

async function defaultFsync(
	path: string,
	_kind: "file" | "dir",
): Promise<void> {
	// Read-only for both: fsync needs no write access, and a copy is never written through it.
	const handle = await open(path, "r")
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
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
	cleanLoads: z.number().int().min(0).max(BACKUP_RECEIPT_COUNT_MAX).optional(),
	ownFormatCleanLoads: z
		.number()
		.int()
		.min(0)
		.max(BACKUP_RECEIPT_COUNT_MAX)
		.optional(),
	seq: z.number().int().min(0).max(BACKUP_RECEIPT_COUNT_MAX).optional(),
})
type Receipt = z.infer<typeof ReceiptSchema>

interface KeptBackup {
	name: string
	/**
	 * null: no readable receipt (missing, corrupt or invalid). Its source format is then unknown,
	 * so it is never protected as this build's own: it groups alone, sorts oldest, counts no clean
	 * loads and never expires by age, but retention deletes it first once past BACKUP_MAX_KEPT.
	 */
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
 * oldest until BACKUP_MAX_KEPT remain, never `keep` (the one just taken) nor the one whose source
 * format is `ownFormat` (this build's) unless its protection has lapsed (`ownLapsed`, see
 * noteCleanLoad). Newest means the highest `seq` (0 without one), then the latest receipt time,
 * then the name. Pure, so the rule is testable alone.
 */
export function backupsToPrune(
	backups: ReadonlyArray<{
		name: string
		fromFormat: string | null
		at: number
		seq?: number
		ownLapsed?: boolean
	}>,
	ownFormat: string,
	keep: string | null,
): string[] {
	// The just-taken one first, then newest first by sequence: crash recovery (keep null) picks
	// the survivor of a format by `seq`, which a clock stepped back between two starts cannot invert.
	const order = [...backups].sort(
		(a, b) =>
			Number(b.name === keep) - Number(a.name === keep) ||
			(b.seq ?? 0) - (a.seq ?? 0) ||
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
		.filter(
			b =>
				b.name !== keep && (b.fromFormat !== ownFormat || b.ownLapsed === true),
		)
		.reverse()
	let count = kept.length
	for (const b of deletable) {
		if (count <= BACKUP_MAX_KEPT) break
		doomed.push(b.name)
		count--
	}
	return doomed
}

/** Whether this build's own-format backup has served its time (see noteCleanLoad). */
function ownFormatLapsed(b: KeptBackup, nowMs: number): boolean {
	return (
		nowMs - b.at >= BACKUP_EXPIRY_MS &&
		(b.receipt?.ownFormatCleanLoads ?? 0) >= BACKUP_EXPIRY_CLEAN_LOADS
	)
}

async function pruneBackups(
	backupsDir: string,
	ownFormat: string,
	keep: string | null,
	nowMs: number,
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
			seq: b.receipt?.seq ?? 0,
			ownLapsed: ownFormatLapsed(b, nowMs),
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
		await pruneBackups(backupsDir, toFormat, null, opts.now(), remove, log)
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
	const { partial, complete } = await listBackups(backupsDir)
	for (const p of partial)
		await remove(join(backupsDir, p)).catch(() => undefined)
	// One more than the highest kept: the order retention trusts over the wall clock.
	const seq = Math.min(
		complete.reduce((m, b) => Math.max(m, b.receipt?.seq ?? 0), 0) + 1,
		BACKUP_RECEIPT_COUNT_MAX,
	)

	const takenAtMs = opts.now()
	const partialDir = join(backupsDir, `.pre-${fromFormat}.partial-${takenAtMs}`)
	const doLink = opts.link ?? link
	const doFsync = opts.fsync ?? defaultFsync
	const syncDir = (path: string): Promise<void> =>
		doFsync(path, "dir").catch(() => undefined)
	let linkedFiles = 0
	// Bytes copied where a hard link failed (EPERM, EXDEV): reserved against the margin before
	// each such copy, in the same synchronous step as the check, so concurrent copies share it.
	let fallbackBytes = 0
	let finalName: string
	const linkedCount = plan.files.filter(f => f.hardLink).length
	log.info(
		{
			files: plan.files.length,
			copyFiles: plan.files.length - linkedCount,
			linkFiles: linkedCount,
			copyMb: Math.round(copyBytes / (1024 * 1024)),
		},
		`Backing up ${plan.files.length} files (~${Math.round(copyBytes / (1024 * 1024))} MB to copy) before the scanner state format change`,
	)
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
					// EXDEV, EPERM, a file system without links: fall back to a copy, which costs space.
				}
				const size = (await lstat(src)).size
				if (
					freeBytes - copyBytes - fallbackBytes - size <
					BACKUP_MIN_FREE_BYTES
				)
					throw new FallbackLowDisk(size)
				fallbackBytes += size
			}
			await copyFile(src, dst, constants.COPYFILE_FICLONE)
			await doFsync(dst, "file")
		})
		if (opts.keepsFile !== undefined && keepsSize !== null) {
			await mkdir(join(partialDir, BACKUP_OUTSIDE_DIR), { recursive: true })
			const keepsCopy = join(
				partialDir,
				BACKUP_OUTSIDE_DIR,
				RECORDING_KEEPS_FILE_NAME,
			)
			await copyFile(opts.keepsFile, keepsCopy, constants.COPYFILE_FICLONE)
			await doFsync(keepsCopy, "file")
			await syncDir(join(partialDir, BACKUP_OUTSIDE_DIR))
		}
		const receipt = {
			fromFormat,
			toFormat,
			takenAt: new Date(takenAtMs).toISOString(),
			takenAtMs,
			seq,
			cleanLoads: 0,
			ownFormatCleanLoads: 0,
			files: plan.files.length,
			copiedBytes: copyBytes + fallbackBytes,
			linkedFiles,
			keepsCopied: keepsSize !== null,
		}
		const receiptPath = join(partialDir, BACKUP_RECEIPT_FILE)
		await writeFile(receiptPath, `${JSON.stringify(receipt, null, "\t")}\n`)
		await doFsync(receiptPath, "file")
		// Every copied file is on disk, then every directory's entries (links included), before the
		// rename: a power cut never leaves a backup counted as taken with empty copies.
		await forEachLimited(plan.dirs, BACKUP_IO_CONCURRENCY, d =>
			syncDir(join(partialDir, d)),
		)
		await syncDir(partialDir)
		finalName = await freeName(backupsDir, `pre-${fromFormat}.${takenAtMs}`)
		// The new backup is in place before any older one goes (pruneBackups below).
		await rename(partialDir, join(backupsDir, finalName))
		await syncDir(backupsDir)
	} catch (err) {
		await remove(partialDir).catch(() => undefined)
		return err instanceof FallbackLowDisk
			? skipped("low-disk", {
					// The copy that tripped the check is needed too (it was never reserved).
					neededBytes: copyBytes + fallbackBytes + err.size,
					freeBytes,
				})
			: skipped("copy-failed")
	}
	const replaced = await pruneBackups(
		backupsDir,
		toFormat,
		finalName,
		takenAtMs,
		remove,
		log,
	)
	return {
		kind: "taken",
		fromFormat,
		toFormat,
		path: join(BACKUPS_DIR, finalName),
		files: plan.files.length,
		copiedBytes: copyBytes + fallbackBytes,
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
 * taken on the way to this build's format (`cleanLoads`; the load in the process that took it
 * counts) and of the one whose source format is this build's (`ownFormatCleanLoads`: the state
 * this build wrote before an older build migrated it, so every such load is after it was taken).
 * Deletes one that is BACKUP_EXPIRY_MS old with BACKUP_EXPIRY_CLEAN_LOADS of its counter, so a
 * newer build back on its format after a downgrade does not keep its own old copy forever.
 * Counters stop at BACKUP_RECEIPT_COUNT_MAX. Returns the names deleted. Never throws.
 */
export async function noteCleanLoad(opts: CleanLoadOptions): Promise<string[]> {
	const log = createComponentLogger(opts.logger, "StateBackup")
	const backupsDir = join(resolve(opts.dir), BACKUPS_DIR)
	const own = formatLabel(opts.format ?? CURRENT_SCANNER_STATE_FORMAT)
	const remove = opts.remove ?? defaultRemove
	const expired: string[] = []
	const { complete } = await listBackups(backupsDir)
	const bump = (n: number | undefined): number =>
		Math.min((n ?? 0) + 1, BACKUP_RECEIPT_COUNT_MAX)
	for (const b of complete) {
		if (b.receipt === null) continue
		const field =
			b.receipt.toFormat === own
				? "cleanLoads"
				: b.receipt.fromFormat === own
					? "ownFormatCleanLoads"
					: null
		if (field === null) continue
		const receiptPath = join(backupsDir, b.name, BACKUP_RECEIPT_FILE)
		const count = bump(b.receipt[field])
		const ageMs = opts.now() - b.at
		try {
			if (ageMs >= BACKUP_EXPIRY_MS && count >= BACKUP_EXPIRY_CLEAN_LOADS) {
				await remove(join(backupsDir, b.name))
				expired.push(b.name)
				log.info(
					{ backup: b.name, ageMs, [field]: count },
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
				`${JSON.stringify({ ...fields, [field]: count }, null, "\t")}\n`,
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
