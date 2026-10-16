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
import * as path from "node:path"
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

export interface RecordingStats {
	isFile(): boolean
	isDirectory(): boolean
	isSymbolicLink(): boolean
	size: number
	mtimeMs: number
}

export interface RecordingFileHandle {
	read(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
	): Promise<{ bytesRead: number }>
	close(): Promise<void>
}

/** The filesystem calls the inventory makes (all read-only). A test seam. */
export interface RecordingFsPort {
	readdir(dir: string): Promise<string[]>
	lstat(p: string): Promise<RecordingStats>
	realpath(p: string): Promise<string>
	open(p: string, flags: number): Promise<RecordingFileHandle>
}

const defaultFs: RecordingFsPort = {
	readdir: dir => nodeFs.readdir(dir),
	lstat: p => nodeFs.lstat(p),
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
}

interface Counts {
	sourceErrors: number
	dirErrors: number
	fileErrors: number
	lookupErrors: number
	firstError: unknown
}

interface Candidate {
	file: string
	name: string
	id: string
	kind: RecordingInventoryKind
	decoderId: string | null
	discoveryId: string | null
	frequencyHz: number | null
}

interface Snapshot {
	at: number
	entries: InventoryEntry[]
	scannedFiles: number
	truncated: boolean
	scannedAt: string
}

const SKIP_CODES = new Set(["ENOENT", "ELOOP", "ENOTDIR"])
const OPEN_FLAGS =
	fsConstants.O_RDONLY |
	(typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0)

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
		firstError: undefined,
	}
}

function note(
	counts: Counts,
	key: Exclude<keyof Counts, "firstError">,
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
	const fs = options.fs ?? defaultFs
	const now = options.now ?? Date.now
	const sem = new Semaphore(RECORDINGS_SCAN_CONCURRENCY)
	const headerCache = new Map<string, number | null>()
	let snapshot: Snapshot | null = null
	let inFlight: Promise<Snapshot> | null = null

	const lstat = (p: string): Promise<RecordingStats> =>
		sem.run(() => fs.lstat(p))
	const readdir = async (dir: string): Promise<string[]> => {
		const names = await sem.run(() => fs.readdir(dir))
		return [...names].sort()
	}

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
				out.push({ decoderId: entry.decoderId, dir })
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

	/** An eligible regular file's stats, or null (symlink, not a file, fresh, vanished). */
	async function eligibleStats(
		file: string,
		scanNow: number,
		counts: Counts | null,
	): Promise<RecordingStats | null> {
		let st: RecordingStats
		try {
			st = await lstat(file)
		} catch (err) {
			if (!isSkip(err) && counts) note(counts, "fileErrors", err)
			return null
		}
		if (st.isSymbolicLink() || !st.isFile()) return null
		if (!Number.isFinite(st.mtimeMs) || !Number.isFinite(st.size)) return null
		if (st.mtimeMs > scanNow - RECORDINGS_IN_PROGRESS_MS) return null
		return st
	}

	/** RIFF duration (cached by path + size + mtime); undefined when the file vanished or became a link. */
	async function durationOf(
		file: string,
		st: RecordingStats,
	): Promise<number | null | undefined> {
		const key = `${file}\0${st.size}\0${st.mtimeMs}`
		if (headerCache.has(key)) return headerCache.get(key) ?? null
		let handle: RecordingFileHandle
		try {
			handle = await sem.run(() => fs.open(file, OPEN_FLAGS))
		} catch (err) {
			if (isSkip(err)) return undefined
			return null
		}
		let result: number | null = null
		try {
			const length = Math.max(
				0,
				Math.min(RECORDINGS_HEADER_READ_BYTES, Math.floor(st.size)),
			)
			if (length > 0) {
				const buf = new Uint8Array(length)
				const { bytesRead } = await sem.run(() =>
					handle.read(buf, 0, length, 0),
				)
				result = parseRiffDurationMs(buf.subarray(0, bytesRead), st.size)
			}
		} catch {
			return null
		} finally {
			try {
				await sem.run(() => handle.close())
			} catch {
				// Nothing to do: the handle is gone either way.
			}
		}
		headerCache.set(key, result)
		while (headerCache.size > RECORDINGS_HEADER_CACHE_MAX) {
			const oldest = headerCache.keys().next()
			if (oldest.done) break
			headerCache.delete(oldest.value)
		}
		return result
	}

	async function scan(): Promise<Snapshot> {
		const scanNow = now()
		const counts = newCounts()
		const candidates: Candidate[] = []
		let claimed = 0
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
		const listDir = async (dir: string): Promise<string[] | null> => {
			try {
				return await readdir(dir)
			} catch (err) {
				if (!isSkip(err)) note(counts, "dirErrors", err)
				return null
			}
		}

		const sources = await dsdSources(counts)
		for (const [n, source] of sources.entries()) {
			if (truncated) break
			const names = await listDir(source.dir)
			if (!names) continue
			for (const name of names) {
				const id = dsdId(n, name)
				if (id === null) continue
				const file = childPath(source.dir, name)
				if (file === null) continue
				if (!claim()) break
				candidates.push({
					file,
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
			let rootOk = false
			try {
				rootOk = await isRealDir(root)
			} catch (err) {
				note(counts, "dirErrors", err)
			}
			for (const kindDir of rootOk ? SCANNER_RECORDING_KINDS : []) {
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
				const folders = discoveries.filter(d => SCANNER_DISCOVERY_ID.test(d))
				const real = await Promise.all(
					folders.map(async d => {
						const p = childPath(kindPath, d)
						if (p === null) return null
						try {
							return (await isRealDir(p)) ? p : null
						} catch (err) {
							note(counts, "dirErrors", err)
							return null
						}
					}),
				)
				for (const [i, d] of folders.entries()) {
					if (truncated) break
					const folder = real[i]
					if (!folder) continue
					const names = await listDir(folder)
					if (!names) continue
					for (const name of names) {
						const id = scanId(d, name)
						if (id === null) continue
						const file = childPath(folder, name)
						if (file === null) continue
						if (!claim()) break
						candidates.push({
							file,
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

		const built = await Promise.all(
			candidates.map(async (c): Promise<InventoryEntry | null> => {
				const st = await eligibleStats(c.file, scanNow, counts)
				if (!st) return null
				const durationMs = await durationOf(c.file, st)
				if (durationMs === undefined) return null
				return { mtimeMs: st.mtimeMs, item: toItem(c, st, durationMs) }
			}),
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
			counts.lookupErrors
		if (skipped > 0) {
			log.warn(
				{
					sourceErrors: counts.sourceErrors,
					dirErrors: counts.dirErrors,
					fileErrors: counts.fileErrors,
					lookupErrors: counts.lookupErrors,
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
				if (typeof id !== "string") return null
				const m = RECORDING_INVENTORY_ID.exec(id)
				if (!m) return null
				const scanNow = now()
				const [, n, dsdName, recordingId] = m
				if (n !== undefined && dsdName !== undefined) {
					if (dsdId(Number(n), dsdName) !== id) return null
					const sources = await dsdSources(newCounts())
					const source = sources[Number(n)]
					if (!source) return null
					return await eligiblePath(source.dir, dsdName, scanNow)
				}
				if (recordingId === undefined) return null
				const sm = SCANNER_RECORDING_ID.exec(recordingId)
				const d = sm?.[1]
				const name = sm?.[2]
				if (d === undefined || name === undefined) return null
				if (scanId(d, name) !== id) return null
				const root = scannerRoot(newCounts())
				if (root === null || !(await isRealDir(root))) return null
				for (const kindDir of SCANNER_RECORDING_KINDS) {
					const kindPath = childPath(root, kindDir)
					if (kindPath === null || !(await isRealDir(kindPath))) continue
					const folder = childPath(kindPath, d)
					if (folder === null || !(await isRealDir(folder))) continue
					const found = await eligiblePath(folder, name, scanNow)
					if (found !== null) return found
				}
				return null
			} catch {
				return null
			}
		},
	}

	async function eligiblePath(
		dir: string,
		name: string,
		scanNow: number,
	): Promise<string | null> {
		const file = childPath(dir, name)
		if (file === null) return null
		const st = await eligibleStats(file, scanNow, null)
		return st ? file : null
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
