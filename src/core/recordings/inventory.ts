/**
 * WG8 recordings inventory (docs/specs/web-gaps-8, requirement 4): a read-only, bounded list of
 * the dsd-fme per-call recordings and the scanner recordings, and the id → path lookup of the
 * download route.
 *
 * Trust surface, fail closed: an id is never a path; symbolic links are never followed (every
 * directory level and every file is `lstat`ed, a symlinked configured directory is skipped);
 * files still being written, in-progress names, probe folders and anything not matching the
 * name patterns are never listed or resolved. Nothing is ever written, renamed, deleted or
 * chmodded. Logs carry fixed text, counts and allowlisted error fields only.
 */

import { constants as fsConstants, promises as nodeFs } from "node:fs"
import type { Dir } from "node:fs"
import * as path from "node:path"
import type { Readable } from "node:stream"
import {
	RECORDING_INVENTORY_ID,
	RECORDINGS_HEADER_READ_BYTES,
	RECORDINGS_IN_PROGRESS_MS,
	RECORDINGS_SCAN_CONCURRENCY,
	RECORDINGS_SCAN_MAX_FILES,
} from "@wavekit/api-types"
import type {
	RecordingInventoryItem,
	RecordingInventoryKind,
	RecordingInventoryPage,
	RecordingInventoryQuery,
} from "@wavekit/api-types"
import {
	DSD_FME_CALL_WAV,
	DSD_FME_TEMP_WAV,
} from "../../decoders/builtin/call-recordings.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import { WaveKitError } from "../../utils/errors.js"
import { createComponentLogger } from "../../utils/logger.js"
import type { Logger } from "../../utils/logger.js"
import { compareEntries, paginate, parseInventoryQuery } from "./cursor.js"
import type { InventoryEntry } from "./cursor.js"
import {
	SCANNER_DISCOVERY_ID,
	SCANNER_RECORDING_ID,
	SCANNER_RECORDING_KINDS,
	callNameFields,
	startedAtLocalFromName,
} from "./names.js"
import { parseRiffDurationMs } from "./riff.js"

/** Listing cache lifetime (by the injected clock). */
export const RECORDINGS_LIST_CACHE_MS = 2_000
/** Header results kept (path + size + mtime); the oldest is dropped first. */
export const RECORDINGS_HEADER_CACHE_MAX = 4_096
/**
 * Directory entries read per scan across every directory, matching or not
 * (8 × RECORDINGS_SCAN_MAX_FILES = 16 000). Reaching it stops the scan (truncated).
 */
export const RECORDINGS_SCAN_MAX_ENTRIES = 8 * RECORDINGS_SCAN_MAX_FILES
/** Scanner discovery folders entered per scan. Reaching it stops the scan (truncated). */
export const RECORDINGS_SCAN_MAX_DIRS = 2_000
/**
 * Longest listed or resolvable id: Fastify's default `maxParamLength` (100) bounds the download
 * route parameter, and a cursor `{"m":<≤ 24>,"i":"<≤ 100>"}` stays ≤ 137 bytes, ≤ 184 base64url
 * characters, well inside the 512-character cursor bound. Real dsd-fme ids are about 56
 * characters; a scanner id (26-character discovery ULID + file name) is usually below 100.
 */
export const RECORDINGS_ID_MAX_LENGTH = 100

export interface RecordingStats {
	isFile(): boolean
	isDirectory(): boolean
	isSymbolicLink(): boolean
	size: number
	mtimeMs: number
	dev: number
	ino: number
}

/** The open-file calls the inventory and the download route make (a `FileHandle` fits). */
export interface RecordingFileHandle {
	read(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
	): Promise<{ bytesRead: number }>
	stat(): Promise<RecordingStats>
	close(): Promise<void>
	createReadStream(options?: { autoClose?: boolean }): Readable
}

/** The filesystem calls the inventory makes (all read-only). A test seam. */
export interface RecordingFsPort {
	/** Entry names of a directory, read lazily; the iterator is returned (closed) early on a bound. */
	opendir(dir: string): Promise<AsyncIterable<string>>
	lstat(p: string): Promise<RecordingStats>
	stat(p: string): Promise<RecordingStats>
	realpath(p: string): Promise<string>
	open(p: string, flags: number): Promise<RecordingFileHandle>
}

async function* direntNames(dir: Dir): AsyncGenerator<string> {
	try {
		for await (const entry of dir) yield entry.name
	} finally {
		// Already closed after a full iteration; closing again only rejects.
		await dir.close().catch(() => undefined)
	}
}

/** The Node filesystem behind the port. */
export const nodeRecordingFs: RecordingFsPort = {
	opendir: async dir => direntNames(await nodeFs.opendir(dir)),
	lstat: p => nodeFs.lstat(p),
	stat: p => nodeFs.stat(p),
	realpath: p => nodeFs.realpath(p),
	open: (p, flags) => nodeFs.open(p, flags),
}

export interface RecordingInventoryOptions {
	/** dsd-fme recording directories, sorted by decoder id. Re-read on every scan. */
	dsdFmeDirs: () => readonly { decoderId: string; dir: string }[]
	/** `<scanner storage>/recordings`, or null when there is no scanner. Re-read on every scan. */
	scannerRecordingsDir: () => string | null
	/** A discovery's centre frequency in Hz, or null when unknown. */
	discoveryCentreHz?: (discoveryId: string) => number | null
	now?: () => number
	logger: Logger
	fs?: RecordingFsPort
}

export interface RecordingInventory {
	list(
		query: RecordingInventoryQuery | unknown,
	): Promise<RecordingInventoryPage>
	/** The absolute path of an eligible recording, or null. Never throws. */
	resolve(id: string): Promise<string | null>
	/**
	 * An open, verified handle on an eligible recording and its file name, or null. The caller
	 * owns (closes) the handle. Never throws.
	 */
	open(
		id: string,
	): Promise<{ handle: RecordingFileHandle; name: string } | null>
}

export class RecordingInventoryError extends WaveKitError {
	declare readonly code: "RECORDINGS_QUERY_INVALID"

	constructor(code: "RECORDINGS_QUERY_INVALID") {
		super("Invalid recordings query", code)
		this.name = "RecordingInventoryError"
	}
}

interface DsdSource {
	decoderId: string
	dir: string
	/** realpath of `dir` at derivation. */
	real: string
}

interface Counts {
	sourceErrors: number
	dirErrors: number
	fileErrors: number
	lookupErrors: number
	longIds: number
	firstError: unknown
}

interface Candidate {
	loc: Location
	name: string
	id: string
	kind: RecordingInventoryKind
	decoderId: string | null
	discoveryId: string | null
	frequencyHz: number | null
}

/** Where an id may live, and what its real path must be once opened. */
interface Location {
	file: string
	name: string
	/** realpath(source dir) joined with the name: the only acceptable realpath of `file`. */
	real: string
	/** Configured directories on the way to `file`, each re-checked as a real directory. */
	dirs: string[]
}

interface Snapshot {
	at: number
	entries: InventoryEntry[]
	scannedFiles: number
	truncated: boolean
	scannedAt: string
}

const SKIP_CODES = new Set(["ENOENT", "ELOOP", "ENOTDIR"])
/** Read-only, never through a final symlink, never blocking on a FIFO. */
const OPEN_FLAGS =
	(fsConstants.O_RDONLY ?? 0) |
	(fsConstants.O_NOFOLLOW ?? 0) |
	(fsConstants.O_NONBLOCK ?? 0)

function errCode(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null) return undefined
	const code = (err as { code?: unknown }).code
	return typeof code === "string" ? code : undefined
}

function isSkip(err: unknown): boolean {
	const code = errCode(err)
	return code !== undefined && SKIP_CODES.has(code)
}

function newCounts(): Counts {
	return {
		sourceErrors: 0,
		dirErrors: 0,
		fileErrors: 0,
		lookupErrors: 0,
		longIds: 0,
		firstError: undefined,
	}
}

function note(
	counts: Counts,
	key: Exclude<keyof Counts, "firstError" | "longIds">,
	err: unknown,
): void {
	counts[key]++
	if (counts.firstError === undefined) counts.firstError = err
}

/** A dsd-fme call name the inventory lists (never TEMP), as `dsd:<n>~<name>`. */
function dsdId(n: number, name: string): string | null {
	if (!DSD_FME_CALL_WAV.test(name) || DSD_FME_TEMP_WAV.test(name)) return null
	const id = `dsd:${n}~${name}`
	return RECORDING_INVENTORY_ID.test(id) ? id : null
}

/** A scanner recording file name in a discovery folder, as `scan:<d>~<name>`. */
function scanId(discoveryId: string, name: string): string | null {
	// req 4.2: a TEMP_ file is never listed, in a scanner folder either
	if (DSD_FME_TEMP_WAV.test(name)) return null
	if (!SCANNER_DISCOVERY_ID.test(discoveryId)) return null
	const recordingId = `${discoveryId}~${name}`
	const m = SCANNER_RECORDING_ID.exec(recordingId)
	if (!m || m[1] !== discoveryId || m[2] !== name) return null
	const id = `scan:${recordingId}`
	return RECORDING_INVENTORY_ID.test(id) ? id : null
}

/** `join(dir, name)` only when its dirname is `dir` and its basename `name`. */
function childPath(dir: string, name: string): string | null {
	const p = path.join(dir, name)
	return path.dirname(p) === dir && path.basename(p) === name ? p : null
}

async function closeQuietly(handle: RecordingFileHandle): Promise<void> {
	try {
		await handle.close()
	} catch {
		// Nothing to do: the handle is gone either way.
	}
}

/** A tiny counting semaphore bounding the fs operations in flight. */
class Semaphore {
	private active = 0
	private readonly waiting: (() => void)[] = []

	constructor(private readonly max: number) {}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.max) {
			await new Promise<void>(resolve => this.waiting.push(resolve))
		} else {
			this.active++
		}
		try {
			return await fn()
		} finally {
			const next = this.waiting.shift()
			if (next) next()
			else this.active--
		}
	}
}

export function createRecordingInventory(
	options: RecordingInventoryOptions,
): RecordingInventory {
	const log = createComponentLogger(options.logger, "RecordingInventory")
	const fs = options.fs ?? nodeRecordingFs
	const now = options.now ?? Date.now
	const sem = new Semaphore(RECORDINGS_SCAN_CONCURRENCY)
	const headerCache = new Map<string, number | null>()
	let snapshot: Snapshot | null = null
	let inFlight: Promise<Snapshot> | null = null

	const lstat = (p: string): Promise<RecordingStats> =>
		sem.run(() => fs.lstat(p))

	/** True when `p` is a real directory (not a symlink); missing → false; other errors throw. */
	async function isRealDir(p: string): Promise<boolean> {
		try {
			const st = await lstat(p)
			return st.isDirectory() && !st.isSymbolicLink()
		} catch (err) {
			if (isSkip(err)) return false
			throw err
		}
	}

	/** Current dsd-fme sources: configured order, real directories, first realpath owner wins. */
	async function dsdSources(counts: Counts): Promise<DsdSource[]> {
		let configured: readonly { decoderId: string; dir: string }[]
		try {
			configured = options.dsdFmeDirs()
		} catch (err) {
			note(counts, "sourceErrors", err)
			return []
		}
		const out: DsdSource[] = []
		const seen = new Set<string>()
		for (const entry of configured) {
			if (
				typeof entry.dir !== "string" ||
				entry.dir.length === 0 ||
				!path.isAbsolute(entry.dir)
			) {
				counts.sourceErrors++
				continue
			}
			const dir = path.resolve(entry.dir)
			try {
				if (!(await isRealDir(dir))) continue
				const real = await sem.run(() => fs.realpath(dir))
				if (seen.has(real)) continue
				seen.add(real)
				out.push({ decoderId: entry.decoderId, dir, real })
			} catch (err) {
				note(counts, "sourceErrors", err)
			}
		}
		return out
	}

	function scannerRoot(counts: Counts): string | null {
		try {
			const root = options.scannerRecordingsDir()
			if (root === null) return null
			if (
				typeof root !== "string" ||
				root.length === 0 ||
				!path.isAbsolute(root)
			) {
				counts.sourceErrors++
				return null
			}
			return path.resolve(root)
		} catch (err) {
			note(counts, "sourceErrors", err)
			return null
		}
	}

	function centreHz(
		discoveryId: string,
		memo: Map<string, number | null>,
		counts: Counts,
	): number | null {
		const known = memo.get(discoveryId)
		if (known !== undefined) return known
		let hz: number | null = null
		const lookup = options.discoveryCentreHz
		if (lookup) {
			try {
				const v: unknown = lookup(discoveryId)
				hz = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null
			} catch (err) {
				note(counts, "lookupErrors", err)
			}
		}
		memo.set(discoveryId, hz)
		return hz
	}

	/** True when stats describe a settled regular file (not fresh) at `at`. */
	function settledFile(st: RecordingStats, at: number): boolean {
		if (st.isSymbolicLink() || !st.isFile()) return false
		if (!Number.isFinite(st.mtimeMs) || !Number.isFinite(st.size)) return false
		return st.mtimeMs <= at - RECORDINGS_IN_PROGRESS_MS
	}

	/** An eligible regular file's stats, or null (symlink, not a file, fresh, vanished). */
	async function eligibleStats(
		file: string,
		at: number,
		counts: Counts | null,
	): Promise<RecordingStats | null> {
		let st: RecordingStats
		try {
			st = await lstat(file)
		} catch (err) {
			if (!isSkip(err) && counts) note(counts, "fileErrors", err)
			return null
		}
		return settledFile(st, at) ? st : null
	}

	/**
	 * Verify an opened handle, not the path: a settled regular file (fstat, so a FIFO, a fresh
	 * replacement or an mtime touched after `lstat` fails), whose path still resolves to the
	 * source's real directory and to the opened inode, with every configured directory on the way
	 * still a real directory. With `expected` (the `lstat` the scan saw), fstat dev/ino/size/mtime
	 * must equal it. Returns the fstat, or null on any mismatch or vanished path; other errors throw.
	 * Residual: a directory swapped to a link and back again between the open and these checks is
	 * not detectable from user space without openat-relative traversal (a few syscalls wide).
	 */
	async function verifyOpened(
		h: RecordingFileHandle,
		loc: Location,
		at: number,
		expected: RecordingStats | null,
	): Promise<RecordingStats | null> {
		try {
			const hst = await sem.run(() => h.stat())
			if (!settledFile(hst, at)) return null
			if (
				expected &&
				(hst.dev !== expected.dev ||
					hst.ino !== expected.ino ||
					hst.size !== expected.size ||
					hst.mtimeMs !== expected.mtimeMs)
			)
				return null
			const real = await sem.run(() => fs.realpath(loc.file))
			if (real !== loc.real) return null
			const rst = await sem.run(() => fs.stat(real))
			if (rst.dev !== hst.dev || rst.ino !== hst.ino) return null
			for (const dir of loc.dirs) if (!(await isRealDir(dir))) return null
			return hst
		} catch (err) {
			if (isSkip(err)) return null
			throw err
		}
	}

	/** RIFF duration from an open handle (cached by path + size + mtime); null when unreadable. */
	async function durationOf(
		h: RecordingFileHandle,
		file: string,
		st: RecordingStats,
	): Promise<number | null> {
		const key = `${file}\0${st.size}\0${st.mtimeMs}`
		if (headerCache.has(key)) return headerCache.get(key) ?? null
		let result: number | null = null
		try {
			const length = Math.max(
				0,
				Math.min(RECORDINGS_HEADER_READ_BYTES, Math.floor(st.size)),
			)
			if (length > 0) {
				const buf = new Uint8Array(length)
				const { bytesRead } = await sem.run(() => h.read(buf, 0, length, 0))
				result = parseRiffDurationMs(buf.subarray(0, bytesRead), st.size)
			}
		} catch {
			return null
		}
		headerCache.set(key, result)
		while (headerCache.size > RECORDINGS_HEADER_CACHE_MAX) {
			const oldest = headerCache.keys().next()
			if (oldest.done) break
			headerCache.delete(oldest.value)
		}
		return result
	}

	/**
	 * One candidate's whole lifecycle (lstat, open, verify, read, close): its entry, or null when
	 * it is not eligible, vanished or failed verification (non-skip errors are counted).
	 */
	async function buildEntry(
		c: Candidate,
		at: number,
		counts: Counts,
	): Promise<InventoryEntry | null> {
		const st = await eligibleStats(c.loc.file, at, counts)
		if (!st) return null
		let handle: RecordingFileHandle
		try {
			handle = await sem.run(() => fs.open(c.loc.file, OPEN_FLAGS))
		} catch (err) {
			if (!isSkip(err)) note(counts, "fileErrors", err)
			return null
		}
		const h = handle
		try {
			const hst = await verifyOpened(h, c.loc, at, st)
			if (!hst) return null
			const durationMs = await durationOf(h, c.loc.file, hst)
			return { mtimeMs: hst.mtimeMs, item: toItem(c, hst, durationMs) }
		} catch (err) {
			note(counts, "fileErrors", err)
			return null
		} finally {
			await sem.run(() => closeQuietly(h))
		}
	}

	async function scan(): Promise<Snapshot> {
		const scanNow = now()
		const counts = newCounts()
		const candidates: Candidate[] = []
		let claimed = 0
		let entriesRead = 0
		let dirsEntered = 0
		let truncated = false
		/** Claims one examined name; false once the bound is reached (sets truncated). */
		const claim = (): boolean => {
			if (claimed >= RECORDINGS_SCAN_MAX_FILES) {
				truncated = true
				return false
			}
			claimed++
			return true
		}
		/**
		 * The names of one directory, read lazily under the per-scan entry budget and then
		 * sorted. Only the bounded names collected are sorted: when the budget stops a directory
		 * midway, which names were collected is the filesystem's order (best effort).
		 */
		const listDir = async (dir: string): Promise<string[] | null> => {
			const names: string[] = []
			let it: AsyncIterator<string> | undefined
			try {
				const iterable = await sem.run(() => fs.opendir(dir))
				const iter = iterable[Symbol.asyncIterator]()
				it = iter
				for (;;) {
					const r = await sem.run(() => iter.next())
					if (r.done === true) break
					if (entriesRead >= RECORDINGS_SCAN_MAX_ENTRIES) {
						truncated = true
						break
					}
					entriesRead++
					names.push(r.value)
				}
			} catch (err) {
				if (!isSkip(err)) note(counts, "dirErrors", err)
				return null
			} finally {
				const iter = it
				if (iter?.return) {
					try {
						await sem.run(async () => {
							await iter.return?.()
						})
					} catch {
						// Closing a directory stream cannot leak anything further.
					}
				}
			}
			return names.sort()
		}
		/** A candidate id, or null when it is too long (counted). */
		const bounded = (id: string | null): string | null => {
			if (id === null) return null
			if (id.length > RECORDINGS_ID_MAX_LENGTH) {
				counts.longIds++
				return null
			}
			return id
		}

		const sources = await dsdSources(counts)
		for (const [n, source] of sources.entries()) {
			if (truncated) break
			const names = await listDir(source.dir)
			if (!names) continue
			for (const name of names) {
				const id = bounded(dsdId(n, name))
				if (id === null) continue
				const file = childPath(source.dir, name)
				const real = childPath(source.real, name)
				if (file === null || real === null) continue
				if (!claim()) break
				candidates.push({
					loc: { file, name, real, dirs: [source.dir] },
					name,
					id,
					kind: "dsd-fme-call",
					decoderId: source.decoderId,
					discoveryId: null,
					frequencyHz: null,
				})
			}
		}

		const root = scannerRoot(counts)
		const memo = new Map<string, number | null>()
		if (root !== null && !truncated) {
			let realRoot: string | null = null
			try {
				if (await isRealDir(root))
					realRoot = await sem.run(() => fs.realpath(root))
			} catch (err) {
				if (!isSkip(err)) note(counts, "dirErrors", err)
			}
			for (const kindDir of realRoot !== null ? SCANNER_RECORDING_KINDS : []) {
				if (truncated) break
				const kindPath = childPath(root, kindDir)
				if (kindPath === null) continue
				try {
					if (!(await isRealDir(kindPath))) continue
				} catch (err) {
					note(counts, "dirErrors", err)
					continue
				}
				const discoveries = await listDir(kindPath)
				if (!discoveries) continue
				for (const d of discoveries) {
					if (truncated) break
					if (!SCANNER_DISCOVERY_ID.test(d)) continue
					if (dirsEntered >= RECORDINGS_SCAN_MAX_DIRS) {
						truncated = true
						break
					}
					dirsEntered++
					const folder = childPath(kindPath, d)
					if (folder === null) continue
					try {
						if (!(await isRealDir(folder))) continue
					} catch (err) {
						note(counts, "dirErrors", err)
						continue
					}
					const names = await listDir(folder)
					if (!names) continue
					for (const name of names) {
						const id = bounded(scanId(d, name))
						if (id === null) continue
						const file = childPath(folder, name)
						const real =
							realRoot === null
								? null
								: childPath(path.join(realRoot, kindDir, d), name)
						if (file === null || real === null) continue
						if (!claim()) break
						candidates.push({
							loc: { file, name, real, dirs: [root, kindPath, folder] },
							name,
							id,
							kind: kindDir === "dv" ? "scanner-dv" : "scanner-analog",
							decoderId: null,
							discoveryId: d,
							frequencyHz: centreHz(d, memo, counts),
						})
					}
				}
			}
		}

		// A pool of RECORDINGS_SCAN_CONCURRENCY workers, each taking one candidate through its
		// whole lifecycle (lstat, open, fstat, read, close): at most that many handles live.
		const built: (InventoryEntry | null)[] = candidates.map(() => null)
		let nextIndex = 0
		const worker = async (): Promise<void> => {
			while (nextIndex < candidates.length) {
				const i = nextIndex++
				const c = candidates[i]
				if (!c) continue
				built[i] = await buildEntry(c, scanNow, counts)
			}
		}
		await Promise.all(
			Array.from(
				{
					length: Math.min(RECORDINGS_SCAN_CONCURRENCY, candidates.length),
				},
				() => worker(),
			),
		)
		// A scanner id present under both dv and analog: the dv one wins (as in resolve).
		const byId = new Map<string, InventoryEntry>()
		for (const e of built) {
			if (e && !byId.has(e.item.id)) byId.set(e.item.id, e)
		}
		const entries = [...byId.values()].sort(compareEntries)

		const skipped =
			counts.sourceErrors +
			counts.dirErrors +
			counts.fileErrors +
			counts.lookupErrors +
			counts.longIds
		if (skipped > 0) {
			log.warn(
				{
					sourceErrors: counts.sourceErrors,
					dirErrors: counts.dirErrors,
					fileErrors: counts.fileErrors,
					lookupErrors: counts.lookupErrors,
					longIds: counts.longIds,
					err: safeErrorFields(counts.firstError),
				},
				"Recordings inventory scan skipped entries",
			)
		}
		return {
			at: scanNow,
			entries,
			scannedFiles: claimed,
			truncated,
			scannedAt: new Date(scanNow).toISOString(),
		}
	}

	async function current(): Promise<Snapshot> {
		const t = now()
		if (
			snapshot &&
			t >= snapshot.at &&
			t - snapshot.at < RECORDINGS_LIST_CACHE_MS
		)
			return snapshot
		if (!inFlight) {
			const p = scan()
			inFlight = p
			void p
				.then(
					s => {
						snapshot = s
					},
					() => undefined,
				)
				.finally(() => {
					if (inFlight === p) inFlight = null
				})
		}
		return inFlight
	}

	/** Every place an id may live, in lookup order (dv before analog). No fs call on a bad id. */
	async function locations(id: string): Promise<Location[]> {
		if (typeof id !== "string" || id.length > RECORDINGS_ID_MAX_LENGTH)
			return []
		const m = RECORDING_INVENTORY_ID.exec(id)
		if (!m) return []
		const [, n, dsdName, recordingId] = m
		if (n !== undefined && dsdName !== undefined) {
			if (dsdId(Number(n), dsdName) !== id) return []
			const sources = await dsdSources(newCounts())
			const source = sources[Number(n)]
			if (!source) return []
			const file = childPath(source.dir, dsdName)
			const real = childPath(source.real, dsdName)
			if (file === null || real === null) return []
			return [{ file, name: dsdName, real, dirs: [source.dir] }]
		}
		if (recordingId === undefined) return []
		const sm = SCANNER_RECORDING_ID.exec(recordingId)
		const d = sm?.[1]
		const name = sm?.[2]
		if (d === undefined || name === undefined) return []
		if (scanId(d, name) !== id) return []
		const root = scannerRoot(newCounts())
		if (root === null || !(await isRealDir(root))) return []
		const realRoot = await sem.run(() => fs.realpath(root))
		const out: Location[] = []
		for (const kindDir of SCANNER_RECORDING_KINDS) {
			const kindPath = childPath(root, kindDir)
			const folder = kindPath === null ? null : childPath(kindPath, d)
			if (kindPath === null || folder === null) continue
			// an unreadable sibling kind must not hide a valid location in the other
			const ok = await isRealDir(kindPath)
				.then(async r => r && (await isRealDir(folder)))
				.catch(() => false)
			if (!ok) continue
			const file = childPath(folder, name)
			const real = childPath(path.join(realRoot, kindDir, d), name)
			if (file === null || real === null) continue
			out.push({ file, name, real, dirs: [root, kindPath, folder] })
		}
		return out
	}

	/** The first location whose `lstat` is an eligible file, or null. */
	async function firstEligible(
		id: string,
		at: number,
	): Promise<Location | null> {
		for (const loc of await locations(id)) {
			if (await eligibleStats(loc.file, at, null)) return loc
		}
		return null
	}

	/** Open the first eligible location of `id` and verify the opened object, or null. */
	async function openId(
		id: string,
	): Promise<{ handle: RecordingFileHandle; loc: Location } | null> {
		const at = now()
		const loc = await firstEligible(id, at)
		if (!loc) return null
		const handle = await openVerified(loc, at)
		return handle ? { handle, loc } : null
	}

	/** Open `loc` (O_NOFOLLOW, O_NONBLOCK) and verify it; the caller owns the handle. */
	async function openVerified(
		loc: Location,
		at: number,
	): Promise<RecordingFileHandle | null> {
		let handle: RecordingFileHandle
		try {
			handle = await sem.run(() => fs.open(loc.file, OPEN_FLAGS))
		} catch {
			return null
		}
		const h = handle
		let ok = false
		try {
			ok = (await verifyOpened(h, loc, at, null)) !== null
			return ok ? h : null
		} catch {
			return null
		} finally {
			if (!ok) await closeQuietly(h)
		}
	}

	return {
		async list(query) {
			const q = parseInventoryQuery(query)
			if (q === null)
				throw new RecordingInventoryError("RECORDINGS_QUERY_INVALID")
			const s = await current()
			const page = paginate(s.entries, q)
			return {
				items: page.items,
				nextCursor: page.nextCursor,
				scannedFiles: s.scannedFiles,
				truncated: s.truncated,
				scannedAt: s.scannedAt,
			}
		},

		async resolve(id) {
			try {
				// Opened and verified like a download, then closed: never an escaped path.
				const opened = await openId(id)
				if (!opened) return null
				await sem.run(() => closeQuietly(opened.handle))
				return opened.loc.file
			} catch {
				return null
			}
		},

		async open(id) {
			try {
				const opened = await openId(id)
				return opened ? { handle: opened.handle, name: opened.loc.name } : null
			} catch {
				return null
			}
		},
	}
}

function toItem(
	c: Candidate,
	st: RecordingStats,
	durationMs: number | null,
): RecordingInventoryItem {
	const fields = callNameFields(c.name)
	return {
		id: c.id,
		kind: c.kind,
		decoderId: c.decoderId,
		discoveryId: c.discoveryId,
		startedAtLocal:
			c.kind === "dsd-fme-call"
				? (fields.startedAtLocal ?? startedAtLocalFromName(c.name))
				: fields.startedAtLocal,
		modifiedAt: new Date(st.mtimeMs).toISOString(),
		bytes: st.size,
		durationMs,
		callType: fields.callType,
		talkgroup: fields.talkgroup,
		source: fields.source,
		frequencyHz: c.frequencyHz,
	}
}
