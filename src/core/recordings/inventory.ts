/**
 * WG8 recordings inventory (docs/specs/web-gaps-8, requirement 4): a read-only, bounded list of
 * the dsd-fme per-call recordings and the scanner recordings, and the id → path lookup of the
 * download route. The list is served from an in-memory catalogue (see "the catalogue" below),
 * never from a filesystem walk per request.
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
	RECORDING_DSD_KEY,
	RECORDING_INVENTORY_ID,
	RECORDINGS_HEADER_READ_BYTES,
	RECORDINGS_CATALOGUE_MAX,
	RECORDINGS_CATALOGUE_MAX_FOLDERS,
	RECORDINGS_CHANNELS_MAX,
	RECORDINGS_IN_PROGRESS_MS,
	RECORDINGS_SCAN_CONCURRENCY,
} from "@wavekit/api-types"
import type {
	RecordingInventoryItem,
	RecordingInventoryKind,
	RecordingInventoryPage,
	RecordingInventoryQuery,
	RecordingsChangedEventData,
} from "@wavekit/api-types"
import {
	DSD_FME_CALL_WAV,
	DSD_FME_TEMP_WAV,
	dsdFmeCallRecordable,
	dsdFmeNameServable,
} from "../../decoders/builtin/call-recordings.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import { WaveKitError } from "../../utils/errors.js"
import { createComponentLogger } from "../../utils/logger.js"
import type { Logger } from "../../utils/logger.js"
import { recordingKeepKeyOf } from "./contract.js"
import type { RecordingKeepKey, RecordingProtection } from "./contract.js"
import {
	afterCursor,
	compareEntries,
	encodeCursor,
	parseInventoryQuery,
} from "./cursor.js"
import type { InventoryEntry, NormalisedQuery } from "./cursor.js"
import {
	SCANNER_DISCOVERY_ID,
	SCANNER_RECORDING_ID,
	SCANNER_RECORDING_KINDS,
	callNameFields,
	DV_CALL_RECORDINGS_SERVED,
	dvCallDecoderField,
	dvCallDecoderOf,
	startedAtLocalFromName,
} from "./names.js"
import { parseRiffDurationMs } from "./riff.js"
import {
	readRecordingCopy,
	readRecordingReceipt,
	recordingParts,
	type RecordingReceiptFacts,
} from "./recording-cut.js"

/**
 * Names waiting for a copy-sidecar re-read (copyChanged), at most this many (oldest forgotten:
 * the slow reconcile reads a forgotten one's sidecar with its receipt only when its WAV changes,
 * so a forgotten change waits for the next restart; 4 096 far exceeds the 63 writes one
 * re-point can make).
 */
export const RECORDINGS_COPY_DIRTY_MAX = 4096

/**
 * Pause of the slow reconcile between two folders: 1 500 folders take at least 30 s, so a
 * reconcile never competes with live work. Folders are re-read one at a time.
 */
export const RECORDINGS_RECONCILE_FOLDER_GAP_MS = 20
/** Default rest between the end of one reconcile and the start of the next. */
export const RECORDINGS_RECONCILE_INTERVAL_MS = 60_000
/**
 * How long after a scanner analog file's last write (its mtime) a missing receipt may still
 * appear (ms): 300 000 (5 min). The store links the WAV before it writes the operation's
 * receipt.json, so a pass may index the file first; while the file is this young a null receipt
 * is not kept as final and the next pass reads it again. It covers the in-progress window
 * (RECORDINGS_IN_PROGRESS_MS, 10 s), the late-verdict hold (26 s) and the prepare and commit
 * after the link (well under a second, minutes on a stalled disk) with room to spare; a pass
 * runs at least every RECORDINGS_RECONCILE_INTERVAL_MS (60 s), so a late receipt is read within
 * about a minute. At exactly the bound (now − mtime = 300 000) it is still read again; past it
 * the null stands (an older analog file without a receipt keeps none: unknown cut and part).
 */
export const RECORDINGS_RECEIPT_WAIT_MS = 300_000

/** A file last written at `mtimeMs` may still get its receipt at `at` (RECORDINGS_RECEIPT_WAIT_MS). */
function receiptMayFollow(mtimeMs: number, at: number): boolean {
	return at - mtimeMs <= RECORDINGS_RECEIPT_WAIT_MS
}
/**
 * Longest a listing waits for the first build or an urgent refresh (a delete, invalidate, a
 * source change) before it answers from what is indexed (`indexing: true` during the build).
 * Under the 1 s "usable" budget.
 */
export const RECORDINGS_INDEXING_WAIT_MS = 750
/** A writer's notices within this window are refreshed together. */
export const RECORDINGS_TOUCH_DEBOUNCE_MS = 250
/** `recordings:changed` at most once per this interval. */
export const RECORDINGS_EVENT_MIN_INTERVAL_MS = 1_000
/** Settle timer slack past an in-progress file's due time. */
export const RECORDINGS_SETTLE_SLACK_MS = 50
/**
 * Past the bound, the oldest files stay out until the catalogue shrinks below this share of
 * RECORDINGS_CATALOGUE_MAX (45 000), so a full catalogue does not re-open them every reconcile.
 */
export const RECORDINGS_CATALOGUE_REARM = 0.9
/**
 * Names read from one folder: twice the entry bound (100 000 by default), so a folder holding
 * every listed recording plus as many other files is still read whole. Past it, `truncated`
 * (which names were read is then the filesystem's order).
 */
export const RECORDINGS_FOLDER_NAMES_FACTOR = 2
/**
 * A folder listing is sorted (newest dsd-fme names first in the first build) only up to this
 * many names: a 100 000-name sort would hold the event loop for tens of milliseconds.
 */
export const RECORDINGS_SORT_NAMES_MAX = 4_096
/**
 * itemsOfKeys reads at most this many keys: a transmission names at most 15 file parts (30 min
 * at 120 s) plus its start file, so 16 (TRANSMISSION_ARTEFACTS_MAX).
 */
export const RECORDINGS_ITEMS_OF_KEYS_MAX = 16
/** The paced reconcile re-checks a large folder in chunks of this many names, pausing between. */
export const RECORDINGS_RECONCILE_CHUNK_NAMES = 256
/**
 * After a discovery is deleted its folders leave the listing at once (kept files stay); they are
 * re-checked this much later, once the scanner removed the files, so survivors show again.
 */
export const RECORDINGS_REMOVED_RECHECK_MS = 10_000
/** dsd-fme call names start with `YYYYMMDD_HHMMSS`: the part compared to find newer calls. */
const CALL_STAMP_LENGTH = 15
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

/** One dsd source: a dsd-fme `-7` directory, or (`kind: "dv-call"`) the dv call recorder's. */
export interface RecordingDsdSourceConfig {
	/** The owning decoder; for a dv-call source only a label (items carry their own decoder). */
	decoderId: string
	dir: string
	kind?: "dv-call"
}

export interface RecordingInventoryOptions {
	/**
	 * dsd-fme recording directories, sorted by decoder id. Re-read on every scan. `kind: "dv-call"`
	 * marks the digital-voice call recorder's directory: one more dsd source (same `dsd~` keys)
	 * whose items carry the decoder named in each file name (see dvCallDecoderIds).
	 */
	dsdFmeDirs: () => readonly RecordingDsdSourceConfig[]
	/**
	 * The decoder ids a dv-call file's name field may stand for (the configured and active
	 * decoders, probes included), read when a file is indexed. A field maps to a decoder only by
	 * an exact match (dvCallDecoderOf); unknown or ambiguous is null, never a guess. Absent (or
	 * null, or throwing): every dv-call item has decoderId null.
	 */
	dvCallDecoderIds?: (() => readonly string[]) | null
	/** `<scanner storage>/recordings`, or null when there is no scanner. Re-read on every scan. */
	scannerRecordingsDir: () => string | null
	/**
	 * The centre frequency in Hz of the live discovery owning a recording folder, or null when
	 * unknown. `discoveryId` is the folder's id: a discovery merged into another keeps its folder,
	 * so the lookup must resolve merge aliases (ScannerService.recordingFolderDiscovery).
	 */
	discoveryCentreHz?: (discoveryId: string) => number | null
	/**
	 * The live discovery owning a recording folder, through merge aliases: its id and centre
	 * frequency, or null. Takes precedence over discoveryCentreHz (read at list time, memory only).
	 */
	discoveryOwner?: (
		folderId: string,
	) => { id: string; frequencyHz: number | null } | null
	/** Rest between reconciles (RECORDINGS_RECONCILE_INTERVAL_MS by default). */
	reconcileIntervalMs?: number
	/** Test seam: RECORDINGS_REMOVED_RECHECK_MS by default. */
	removedRecheckMs?: number
	/** Test seam: the entry bound (RECORDINGS_CATALOGUE_MAX by default). */
	catalogueMax?: number
	/** Test seam: the folder bound (RECORDINGS_CATALOGUE_MAX_FOLDERS by default). */
	catalogueMaxFolders?: number
	now?: () => number
	logger: Logger
	fs?: RecordingFsPort
	/**
	 * WG9: the deletion decision. When given, every listed item carries `kept` (read at list
	 * time, not cached); when absent the items are exactly the WG8 items (no `kept` property).
	 */
	protection?: RecordingProtection
	/**
	 * The Activity row linked to a recording key (memory only, read at list time). When given,
	 * every listed item carries `activityEventId` (null when none); absent, no such property.
	 */
	activityEventId?: (key: string) => string | null
}

/** WG9: an opened, verified recording (the caller owns and closes `handle`). */
export interface OpenedRecording {
	handle: RecordingFileHandle
	/** The file name (a basename). */
	name: string
	/** The absolute path that was opened (never logged nor sent). */
	path: string
	/** The verified fstat of the handle (dev, ino, size, mtime). */
	stat: RecordingStats
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
	open(id: string): Promise<OpenedRecording | null>
	/**
	 * WG9: a recording changed (with its id: after a delete, Keep or unkeep, re-checked at once
	 * and awaited by the next listing) or anything may have (no id: every folder re-read, awaited
	 * by the next listing). Always present on the inventory createRecordingInventory returns;
	 * optional in the type so WG8 test doubles of the interface still type-check.
	 */
	invalidate?(id?: string): void
	/** Starts the first build (idempotent); resolves when it is done. */
	start?(): Promise<void>
	/** Stops timers and listeners. */
	close?(): void
	/**
	 * Memory only: whether a recording key is indexed now. Null while the answer cannot prove a
	 * file is gone: before the first build ends, while a full pass or an urgent refresh runs
	 * (folders are dropped and re-indexed), after a pass that met a source or directory error,
	 * while files are left out (a bound reached, or lifted until the next pass re-adds them), and,
	 * for a `dsd~` key, while a configured dsd-fme directory is missing (not created, unmounted).
	 * False at once for a `dsd~` dsd-fme call name the recording gate refuses (a DMR call while
	 * DMR recordings are off): no source serves it, so no folder state can make it present.
	 */
	hasKey?(key: string): boolean | null
	/**
	 * Memory only: the keep keys of the indexed files whose facts name a transmission (`txId` or
	 * one of `moreTxIds`), rebuilt from the facts on every load and refresh; empty when none.
	 */
	keysOfTx?(txId: string): readonly string[]
	/**
	 * Memory only: the listed items of these keep keys, as a listing serves them (at most
	 * RECORDINGS_ITEMS_OF_KEYS_MAX keys read; a key not listed now is left out). Never throws.
	 */
	itemsOfKeys?(keys: readonly string[]): readonly RecordingInventoryItem[]
	/**
	 * Memory only: the keep keys of the listed scanner analog files that are copies of the root
	 * `key` (their copy sidecar names it, and it is listed and not itself a copy). Every one, in
	 * no particular order; empty when none.
	 */
	keysOfCopyRoot?(key: string): readonly string[]
	/**
	 * Writers: the copy sidecar of the analog file `alias` (`<discovery>~analog-<uuid>.wav`) was
	 * written or removed. Its WAV and receipt are unchanged, so only the sidecar is read again.
	 */
	copyChanged?(alias: string): void
	/** Writers: these discoveries' folders changed (finalize, delete, retention). */
	touchDiscoveries?(ids: readonly string[]): Promise<void>
	/** Writers: a dsd-fme call of `decoderId` ended (no id: every dsd-fme directory). */
	touchCallRecordings?(decoderId?: string): Promise<void>
	/**
	 * Writers: these discoveries were deleted (their folders are being removed): their unkept
	 * files leave the listing at once, and the folders are re-checked once removal is done.
	 */
	discoveriesRemoved?(ids: readonly string[]): void
	/** Merges: these folders' owner or frequency changed (no file changed). */
	ownersChanged?(folderIds: readonly string[]): void
	/** `recordings:changed` notices (at most one a second); returns the unsubscribe. */
	onChange?(listener: (e: RecordingsChangedEventData) => void): () => void
	/** `refreshing`: an urgent refresh (invalidate, source change, settling file) is running. */
	status?(): {
		revision: number
		indexing: boolean
		files: number
		refreshing: boolean
	}
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
	kind: "dsd-fme-call" | "dv-call"
	dir: string
	/** realpath of `dir` at derivation. */
	real: string
}

interface Counts {
	sourceErrors: number
	/** Configured dsd-fme directories that are not a real directory now (skipped, not errors). */
	missingSources: number
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

/** A folder the catalogue indexes: a dsd-fme directory or a scanner discovery kind folder. */
interface FolderSpec {
	/** The folder path (unique). */
	key: string
	dir: string
	/** realpath of the folder, as derived. */
	real: string
	/** Configured directories on the way, each re-checked as a real directory. */
	dirs: string[]
	kind: RecordingInventoryKind
	/** dv before analog when one id is in both (as resolve). */
	rank: number
	dsdIndex: number | null
	decoderId: string | null
	discoveryId: string | null
	mtimeMs: number
}

interface IndexedEntry extends InventoryEntry {
	/** The keep key, computed once (null: fail closed, reads kept). */
	key: RecordingKeepKey | null
	/** In the sorted view (the winner of its id). */
	listed: boolean
	/** The `q` text for `hayHz` (cached: rebuilt only when the owner's frequency changed). */
	hay?: string
	hayHz?: number | null
	folder: string
	name: string
	rank: number
	discoveryId: string | null
	dev: number
	ino: number
	size: number
	/** A scanner analog file's receipt facts (read when indexed); null: unknown or not analog. */
	receipt: RecordingReceiptFacts | null
}

/**
 * matchedByChannel of a `nearHz` listing: count descending, then frequency ascending, the first
 * RECORDINGS_CHANNELS_MAX. A tolerance of ±1 MHz over a 6.25 kHz raster can hold 321 channels;
 * the cap is the Activity facets' (the web shows the largest few).
 */
export function channelCounts(
	byChannel: ReadonlyMap<number, number>,
): { frequencyHz: number; count: number }[] {
	return [...byChannel]
		.map(([frequencyHz, count]) => ({ frequencyHz, count }))
		.sort((a, b) => b.count - a.count || a.frequencyHz - b.frequencyHz)
		.slice(0, RECORDINGS_CHANNELS_MAX)
}

/** A listed analog file's roll-over place (RecordingInventoryItem.part, parts). */
interface PartOf {
	part: number | null
	parts: number | null
}

interface FolderState {
	spec: FolderSpec
	files: Map<string, IndexedEntry>
	/** In-progress names and when they settle (by the injected clock). */
	pending: Map<string, number>
	/** Creation order (stateSeq). */
	seq: number
}

interface View {
	entries: IndexedEntry[]
	bytes: number
	byKind: Record<RecordingInventoryKind, number>
}

interface Owner {
	id: string | null
	frequencyHz: number | null
}

/** Lower-cased text the `q` filter searches: never the opaque id. */
function haystack(it: RecordingInventoryItem, hz: number | null): string {
	const mhz =
		hz === null
			? ""
			: (hz / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")
	return [
		it.talkgroup ?? "",
		it.source ?? "",
		it.decoderId ?? "",
		it.kind,
		it.startedAtLocal ?? "",
		mhz,
	]
		.join(" ")
		.toLowerCase()
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
		missingSources: 0,
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

/** A dsd source's kinds: dsd-fme's own directories and the dv call recorder's. */
function isCallKind(kind: RecordingInventoryKind): boolean {
	return kind === "dsd-fme-call" || kind === "dv-call"
}

/**
 * Whether a file of this name in a folder of this kind may be listed or opened. dsd-fme's own
 * per-call files carry their protocol in the name: one that is not recordable (DMR while DMR
 * recordings are off, or no or an unknown protocol) is neither listed nor opened, and stays on
 * disk under the usual retention. The dv call recorder's files are served only while
 * DV_CALL_RECORDINGS_SERVED is on (off: no call tap feeds it yet, so nothing checked its calls).
 */
function callFileServable(kind: RecordingInventoryKind, name: string): boolean {
	if (kind === "dv-call") return DV_CALL_RECORDINGS_SERVED
	return kind !== "dsd-fme-call" || dsdFmeCallRecordable(name)
}

/**
 * A `dsd~` key's name that no source may serve: a dsd-fme call name (never TEMP) the gate
 * refuses in a dsd-fme directory (callFileServable), and not in the dv call recorder's name
 * shape while that directory is served (dvCallDecoderField: it serves its own names, whichever
 * decoder they name; DV_CALL_RECORDINGS_SERVED off refuses them all).
 */
function dsdNameRefused(name: string): boolean {
	return (
		dsdId(0, name) !== null &&
		!callFileServable("dsd-fme-call", name) &&
		(!DV_CALL_RECORDINGS_SERVED || dvCallDecoderField(name) === null)
	)
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
	// A scanner probe's dsd-fme call file of a protocol that is not recordable (DMR) never is
	if (!dsdFmeNameServable(name)) return null
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
	const reconcileIntervalMs =
		options.reconcileIntervalMs ?? RECORDINGS_RECONCILE_INTERVAL_MS
	const removedRecheckMs =
		options.removedRecheckMs ?? RECORDINGS_REMOVED_RECHECK_MS
	const removedTimers = new Set<ReturnType<typeof setTimeout>>()
	const maxEntries = options.catalogueMax ?? RECORDINGS_CATALOGUE_MAX
	const maxFolders =
		options.catalogueMaxFolders ?? RECORDINGS_CATALOGUE_MAX_FOLDERS

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

	/**
	 * WG9 R2: a configured root that is itself a symlink, resolved by realpath once (operator
	 * config is trusted), as the deleters resolve it: its real directory and identity. Null when
	 * the root was missing, a real directory or a dangling link at first sight (today's
	 * behaviour). Memoised per configured path for the inventory's lifetime.
	 */
	const rootPins = new Map<
		string,
		Promise<{ real: string; dev: number; ino: number } | null>
	>()
	function pinRoot(
		abs: string,
	): Promise<{ real: string; dev: number; ino: number } | null> {
		let pin = rootPins.get(abs)
		if (pin === undefined) {
			pin = (async () => {
				try {
					if (!(await lstat(abs)).isSymbolicLink()) return null
					const real = await sem.run(() => fs.realpath(abs))
					const st = await lstat(real)
					if (st.isSymbolicLink() || !st.isDirectory()) return null
					return { real, dev: st.dev, ino: st.ino }
				} catch {
					return null
				}
			})()
			rootPins.set(abs, pin)
		}
		return pin
	}

	/**
	 * The base to list a configured root from: the root itself when it is not pinned, the
	 * pinned real directory while its identity holds, or null (counted as a source error) once
	 * that identity changed, so nothing under it is listed or resolved (fail closed).
	 */
	async function rootBase(abs: string, counts: Counts): Promise<string | null> {
		const pin = await pinRoot(abs)
		if (pin === null) return abs
		try {
			const st = await lstat(pin.real)
			if (
				!st.isSymbolicLink() &&
				st.isDirectory() &&
				st.dev === pin.dev &&
				st.ino === pin.ino
			)
				return pin.real
		} catch {
			// Gone: changed.
		}
		counts.sourceErrors++
		return null
	}

	/** The decoder a dv-call file name stands for, by exact match only (else null). */
	function dvCallDecoder(name: string): string | null {
		const field = dvCallDecoderField(name)
		const ids = options.dvCallDecoderIds
		if (field === null || ids === undefined || ids === null) return null
		try {
			return dvCallDecoderOf(field, ids())
		} catch {
			return null
		}
	}

	/** Current dsd-fme sources: configured order, real directories, first realpath owner wins. */
	async function dsdSources(counts: Counts): Promise<DsdSource[]> {
		let configured: readonly RecordingDsdSourceConfig[]
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
			try {
				const dir = await rootBase(path.resolve(entry.dir), counts)
				if (dir === null || !(await isRealDir(dir))) {
					counts.missingSources++
					continue
				}
				const real = await sem.run(() => fs.realpath(dir))
				if (seen.has(real)) continue
				seen.add(real)
				out.push({
					decoderId: entry.decoderId,
					kind: entry.kind === "dv-call" ? "dv-call" : "dsd-fme-call",
					dir,
					real,
				})
			} catch (err) {
				note(counts, "sourceErrors", err)
			}
		}
		return out
	}

	/** `<scanner storage>/recordings`, under the pinned real storage root when it is a symlink. */
	async function scannerRoot(counts: Counts): Promise<string | null> {
		const root = scannerRootConfigured(counts)
		if (root === null) return null
		const base = await rootBase(path.dirname(root), counts)
		return base === null ? null : path.join(base, path.basename(root))
	}

	function scannerRootConfigured(counts: Counts): string | null {
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

	/** RIFF duration from an open handle; null when unreadable. */
	async function durationOf(
		h: RecordingFileHandle,
		st: RecordingStats,
	): Promise<number | null> {
		try {
			const length = Math.max(
				0,
				Math.min(RECORDINGS_HEADER_READ_BYTES, Math.floor(st.size)),
			)
			if (length === 0) return null
			const buf = new Uint8Array(length)
			const { bytesRead } = await sem.run(() => h.read(buf, 0, length, 0))
			return parseRiffDurationMs(buf.subarray(0, bytesRead), st.size)
		} catch {
			return null
		}
	}

	/**
	 * One candidate's whole lifecycle after its `lstat` (open, verify, read, close): its entry and
	 * verified fstat, or null when it vanished or failed verification (non-skip errors counted).
	 */
	async function buildFrom(
		c: Candidate,
		st: RecordingStats,
		at: number,
		counts: Counts,
	): Promise<(InventoryEntry & { stat: RecordingStats }) | null> {
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
			const durationMs = await durationOf(h, hst)
			return {
				mtimeMs: hst.mtimeMs,
				item: toItem(c, hst, durationMs),
				stat: hst,
			}
		} catch (err) {
			note(counts, "fileErrors", err)
			return null
		} finally {
			await sem.run(() => closeQuietly(h))
		}
	}

	// ------------------------------------------------------------------------- the catalogue
	//
	// One in-memory index of every eligible recording, built once in the background (newest
	// folders first), then kept current by targeted refreshes (writers, invalidate, settling
	// in-progress files) and a slow paced reconcile of every folder. A listing reads memory only.
	// Each indexed file passed the full open-time verification when it was indexed; `open` and
	// `resolve` verify again at request time, so the catalogue never widens the trust surface.

	const folders = new Map<string, FolderState>()
	const folderLocks = new Map<string, Promise<void>>()
	const handleSem = new Semaphore(RECORDINGS_SCAN_CONCURRENCY)
	const urgent = new Set<Promise<void>>()
	const listeners = new Set<(e: RecordingsChangedEventData) => void>()
	let revision = 0
	/**
	 * The listed entries, newest first, kept sorted incrementally (binary-search insert and
	 * remove): a change costs one splice, a listing never sorts. One entry per id (the lowest
	 * rank, dv before analog); `byId` holds every indexed copy of an id.
	 */
	const view: View = {
		entries: [],
		bytes: 0,
		byKind: {
			"dsd-fme-call": 0,
			"scanner-dv": 0,
			"scanner-analog": 0,
			"dv-call": 0,
		},
	}
	const byId = new Map<string, IndexedEntry[]>()
	/** Indexed copies per keep key (hasKey). */
	/** Indexed copies per keep key (every copy, listed or not). */
	const byKey = new Map<string, Set<IndexedEntry>>()
	/** Indexed scanner analog copies per receipt observation (roll-over parts). */
	const byObservation = new Map<string, IndexedEntry[]>()
	/**
	 * Indexed copies per transmission their facts name. Bound: catalogue entries × at most 8
	 * (a file's txId + 7 moreTxIds, recording-facts.ts).
	 */
	const byTx = new Map<string, Set<IndexedEntry>>()
	/** Indexed scanner analog copies per root key their copy sidecar names (every copy). */
	const byCopyRoot = new Map<string, Set<IndexedEntry>>()
	/** File names whose copy sidecar changed (copyChanged), re-read by their next refresh. */
	const copyDirty = new Set<string>()
	/** First full build: null until started, then its promise. */
	let build: Promise<void> | null = null
	let built = false
	let startedAt = now()
	let lastFullAt: number | null = null
	let foldersTruncated = false
	let namesTruncated = false
	/** Full passes running now (hasKey cannot tell while one re-indexes folders). */
	let passing = 0
	/**
	 * The last full pass met no source or directory error and left nothing out, and the bound has
	 * not been lifted since (a lifted cutoff re-adds files only at the next pass): hasKey may
	 * prove a file gone.
	 */
	let lastPassClean = false
	/**
	 * Every configured dsd-fme directory was a real directory at the last full pass. A directory
	 * not created yet or briefly unmounted is skipped without an error, so a `dsd~` key (any
	 * directory may hold it) cannot be proved gone until it is back.
	 */
	let lastDsdComplete = false
	/** Past RECORDINGS_CATALOGUE_MAX: the first entry left out (newest-first order). */
	let cutoff: { m: number; i: string } | null = null
	let configKey: string | null = null
	/** Bumped for every folder state created (a pass removes only states older than its derive). */
	let stateSeq = 0
	let pendingTimer: ReturnType<typeof setTimeout> | null = null
	let reconcileTimer: ReturnType<typeof setTimeout> | null = null
	let touchTimer: ReturnType<typeof setTimeout> | null = null
	const touchedDiscoveries = new Set<string>()
	/** Decoders whose call ended; null with `touchedCalls`: every dsd-fme directory. */
	let touchedCalls = false
	let touchedDecoders: Set<string> | null = new Set()
	let touchWaiters: (() => void)[] = []
	let eventTimer: ReturnType<typeof setTimeout> | null = null
	let lastEventAt = Number.NEGATIVE_INFINITY
	const pendingEvent = { added: 0, removed: 0, changed: 0 }
	let closed = false

	function unref(t: ReturnType<typeof setTimeout>): void {
		if (typeof t === "object" && t !== null && "unref" in t) t.unref()
	}

	/** A change to what is listed (or to `kept` and owners, read at list time): revision only. */
	function changed(kind: "added" | "removed" | "changed", n = 1): void {
		if (n <= 0) return
		revision++
		pendingEvent[kind] += n
		scheduleEvent()
	}

	function scheduleEvent(): void {
		if (closed || eventTimer !== null) return
		if (listeners.size === 0) {
			pendingEvent.added = pendingEvent.removed = pendingEvent.changed = 0
			return
		}
		const wait = Math.max(
			0,
			lastEventAt + RECORDINGS_EVENT_MIN_INTERVAL_MS - performance.now(),
		)
		eventTimer = setTimeout(() => {
			eventTimer = null
			lastEventAt = performance.now()
			const data: RecordingsChangedEventData = {
				revision,
				added: pendingEvent.added,
				removed: pendingEvent.removed,
				changed: pendingEvent.changed,
				indexing: !built,
			}
			pendingEvent.added = pendingEvent.removed = pendingEvent.changed = 0
			for (const l of [...listeners]) {
				try {
					l(data)
				} catch (err) {
					log.debug(
						{ err: safeErrorFields(err) },
						"Recordings change listener failed",
					)
				}
			}
		}, wait)
		unref(eventTimer)
	}

	/** Runs `fn` alone for `key` (one folder is never indexed twice at once). */
	async function withFolder(
		key: string,
		fn: () => Promise<void>,
	): Promise<void> {
		const prev = folderLocks.get(key) ?? Promise.resolve()
		const run = prev.then(fn, fn)
		const tail = run.then(
			() => undefined,
			() => undefined,
		)
		folderLocks.set(key, tail)
		try {
			await run
		} finally {
			if (folderLocks.get(key) === tail) folderLocks.delete(key)
		}
	}

	/** True while `state` is the folder's live state (a removed or replaced one is never written). */
	function attached(state: FolderState): boolean {
		return folders.get(state.spec.key) === state
	}

	/** Index in the view where `e` sorts (first position not before it). */
	function viewIndex(e: InventoryEntry): number {
		const entries = view.entries
		let lo = 0
		let hi = entries.length
		while (lo < hi) {
			const mid = (lo + hi) >>> 1
			const at = entries[mid]
			if (at !== undefined && compareEntries(at, e) < 0) lo = mid + 1
			else hi = mid
		}
		return lo
	}

	function viewInsert(e: IndexedEntry): void {
		view.entries.splice(viewIndex(e), 0, e)
		e.listed = true
		view.bytes += e.item.bytes
		view.byKind[e.item.kind]++
	}

	function viewRemove(e: IndexedEntry): void {
		if (!e.listed) return
		const i = viewIndex(e)
		if (view.entries[i] === e) view.entries.splice(i, 1)
		else {
			// Never expected (the order is total); stay correct anyway.
			const j = view.entries.indexOf(e)
			if (j >= 0) view.entries.splice(j, 1)
		}
		e.listed = false
		view.bytes -= e.item.bytes
		view.byKind[e.item.kind]--
	}

	function winnerOf(copies: readonly IndexedEntry[]): IndexedEntry | undefined {
		let best: IndexedEntry | undefined
		for (const c of copies) if (!best || c.rank < best.rank) best = c
		return best
	}

	/** Adds an indexed copy; the view lists the id's winner. */
	function track(e: IndexedEntry): void {
		const observationId = e.receipt?.observationId
		if (observationId) {
			const group = byObservation.get(observationId) ?? []
			group.push(e)
			byObservation.set(observationId, group)
		}
		for (const txId of txIdsOfEntry(e)) {
			const set = byTx.get(txId) ?? new Set<IndexedEntry>()
			set.add(e)
			byTx.set(txId, set)
		}
		const root = e.receipt?.copy?.of.key
		if (root !== undefined) {
			const set = byCopyRoot.get(root) ?? new Set<IndexedEntry>()
			set.add(e)
			byCopyRoot.set(root, set)
		}
		if (e.key !== null) {
			const copies = byKey.get(e.key) ?? new Set<IndexedEntry>()
			copies.add(e)
			byKey.set(e.key, copies)
		}
		const copies = byId.get(e.item.id) ?? []
		const before = winnerOf(copies)
		copies.push(e)
		byId.set(e.item.id, copies)
		if (winnerOf(copies) === e) {
			if (before) viewRemove(before)
			viewInsert(e)
			enforceBound()
		}
	}

	/** Removes an indexed copy; the next copy of its id, if any, is listed instead. */
	function untrack(e: IndexedEntry): void {
		const observationId = e.receipt?.observationId
		if (observationId) {
			const group = byObservation.get(observationId)
			const at = group?.indexOf(e) ?? -1
			if (group && at >= 0) group.splice(at, 1)
			if (group?.length === 0) byObservation.delete(observationId)
		}
		for (const txId of txIdsOfEntry(e)) {
			const set = byTx.get(txId)
			set?.delete(e)
			if (set?.size === 0) byTx.delete(txId)
		}
		const root = e.receipt?.copy?.of.key
		if (root !== undefined) {
			const set = byCopyRoot.get(root)
			set?.delete(e)
			if (set?.size === 0) byCopyRoot.delete(root)
		}
		const copies = byId.get(e.item.id)
		if (!copies) return
		const i = copies.indexOf(e)
		if (i >= 0) {
			copies.splice(i, 1)
			if (e.key !== null) {
				const left = byKey.get(e.key)
				left?.delete(e)
				if (left?.size === 0) byKey.delete(e.key)
			}
		}
		if (copies.length === 0) byId.delete(e.item.id)
		if (e.listed) {
			viewRemove(e)
			const next = winnerOf(copies)
			if (next) {
				viewInsert(next)
				enforceBound()
			}
		}
	}

	/**
	 * The memory and listing bound, kept on every insert: past it the oldest listed entry and
	 * every copy of its id leave the catalogue, and `cutoff` keeps older files out without
	 * opening them. Once the catalogue shrinks below the rearm share, a reconcile adds them back.
	 */
	function enforceBound(): void {
		while (view.entries.length > maxEntries) {
			const last = view.entries[view.entries.length - 1]
			if (!last) break
			cutoff = { m: last.mtimeMs, i: last.item.id }
			for (const c of [...(byId.get(last.item.id) ?? [])]) {
				const state = folders.get(c.folder)
				if (state?.files.get(c.name) === c) {
					state.files.delete(c.name)
				}
				untrack(c)
			}
		}
		if (
			cutoff !== null &&
			view.entries.length < maxEntries * RECORDINGS_CATALOGUE_REARM
		) {
			cutoff = null
			// Files left out are added back only by the next pass: until then none is proved gone.
			lastPassClean = false
		}
	}

	function dropFile(state: FolderState, name: string): boolean {
		if (!attached(state)) return false
		const e = state.files.get(name)
		if (!e) return false
		state.files.delete(name)
		untrack(e)
		changed("removed")
		return true
	}

	function setFile(state: FolderState, name: string, e: IndexedEntry): void {
		if (!attached(state)) return
		const prev = state.files.get(name)
		state.files.set(name, e)
		if (prev) untrack(prev)
		track(e)
		changed(prev ? "changed" : "added")
	}

	function setPending(state: FolderState, name: string, due: number): void {
		if (!attached(state)) return
		state.pending.set(name, due)
		schedulePending()
	}

	function clearPending(state: FolderState, name: string): void {
		state.pending.delete(name)
	}

	function removeFolder(key: string): void {
		const state = folders.get(key)
		if (!state) return
		folders.delete(key)
		const n = state.files.size
		for (const e of state.files.values()) untrack(e)
		state.files.clear()
		changed("removed", n)
	}

	/** True when (m, i) sorts at or after the first entry left out past the bound. */
	function beyondBound(m: number, i: string): boolean {
		if (cutoff === null) return false
		if (m !== cutoff.m) return m < cutoff.m
		return i >= cutoff.i
	}

	/** The scanner kind folder of discovery `d`, or null when it is not a real directory. */
	async function scannerFolder(
		root: string,
		realRoot: string,
		kindDir: (typeof SCANNER_RECORDING_KINDS)[number],
		d: string,
		counts: Counts,
	): Promise<FolderSpec | null> {
		const kindPath = childPath(root, kindDir)
		const folder = kindPath === null ? null : childPath(kindPath, d)
		if (kindPath === null || folder === null) return null
		try {
			const st = await lstat(folder)
			if (st.isSymbolicLink() || !st.isDirectory()) return null
			return {
				key: folder,
				dir: folder,
				real: path.join(realRoot, kindDir, d),
				dirs: [root, kindPath, folder],
				kind: kindDir === "dv" ? "scanner-dv" : "scanner-analog",
				rank: kindDir === "dv" ? 0 : 1,
				dsdIndex: null,
				decoderId: null,
				discoveryId: d,
				mtimeMs: Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0,
			}
		} catch (err) {
			if (!isSkip(err)) note(counts, "dirErrors", err)
			return null
		}
	}

	/** The scanner root and its realpath, or null. */
	async function scannerBase(
		counts: Counts,
	): Promise<{ root: string; realRoot: string } | null> {
		const root = await scannerRoot(counts)
		if (root === null) return null
		try {
			if (!(await isRealDir(root))) return null
			return { root, realRoot: await sem.run(() => fs.realpath(root)) }
		} catch (err) {
			if (!isSkip(err)) note(counts, "dirErrors", err)
			return null
		}
	}

	/** The dsd sources' folders only (dsd-fme and dv call directories): no scanner walk. */
	async function dsdFolders(counts: Counts): Promise<FolderSpec[]> {
		const out: FolderSpec[] = []
		for (const [n, source] of (await dsdSources(counts)).entries()) {
			out.push({
				key: source.dir,
				dir: source.dir,
				real: source.real,
				dirs: [source.dir],
				kind: source.kind,
				rank: 0,
				dsdIndex: n,
				decoderId: source.decoderId,
				discoveryId: null,
				mtimeMs: Number.POSITIVE_INFINITY,
			})
		}
		return out
	}

	/** Every folder to index: dsd-fme directories, then scanner folders newest change first. */
	async function deriveFolders(
		counts: Counts,
		report?: { foldersTruncated: boolean },
	): Promise<FolderSpec[]> {
		const out = await dsdFolders(counts)
		const base = await scannerBase(counts)
		const scanner: FolderSpec[] = []
		let truncatedHere = false
		if (base !== null) {
			for (const kindDir of SCANNER_RECORDING_KINDS) {
				const kindPath = childPath(base.root, kindDir)
				if (kindPath === null) continue
				try {
					if (!(await isRealDir(kindPath))) continue
				} catch (err) {
					note(counts, "dirErrors", err)
					continue
				}
				const listed = await listNames(kindPath, counts)
				if (listed === null) continue
				if (listed.truncated) truncatedHere = true
				const ids = listed.names.filter(d => SCANNER_DISCOVERY_ID.test(d))
				const specs = await pool(ids, d =>
					scannerFolder(base.root, base.realRoot, kindDir, d, counts),
				)
				for (const s of specs) if (s !== null) scanner.push(s)
			}
		}
		// Newest directory change first: the first build lists recent recordings early, and a
		// folder bound leaves out the folders changed least recently.
		scanner.sort((a, b) =>
			a.mtimeMs !== b.mtimeMs
				? b.mtimeMs - a.mtimeMs
				: a.key < b.key
					? -1
					: a.key > b.key
						? 1
						: 0,
		)
		if (scanner.length > maxFolders) {
			scanner.length = maxFolders
			truncatedHere = true
		}
		if (report) report.foldersTruncated = truncatedHere
		return [...out, ...scanner]
	}

	/** A folder's entry names, at most RECORDINGS_FOLDER_NAMES_FACTOR × the entry bound. */
	async function listNames(
		dir: string,
		counts: Counts,
	): Promise<{ names: string[]; truncated: boolean } | null> {
		const names: string[] = []
		let truncated = false
		let it: AsyncIterator<string> | undefined
		try {
			const iterable = await sem.run(() => fs.opendir(dir))
			const iter = iterable[Symbol.asyncIterator]()
			it = iter
			for (;;) {
				const r = await sem.run(() => iter.next())
				if (r.done === true) break
				if (names.length >= maxEntries * RECORDINGS_FOLDER_NAMES_FACTOR) {
					truncated = true
					break
				}
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
		// Newest first where the name says so (dsd-fme names start with the date and time).
		if (names.length <= RECORDINGS_SORT_NAMES_MAX) names.sort().reverse()
		return { names, truncated }
	}

	/** `fn` over `items` with RECORDINGS_SCAN_CONCURRENCY workers, results in input order. */
	async function pool<T, R>(
		items: readonly T[],
		fn: (item: T) => Promise<R>,
	): Promise<R[]> {
		const out: R[] = new Array<R>(items.length)
		let next = 0
		const worker = async (): Promise<void> => {
			while (next < items.length) {
				const i = next++
				const item = items[i] as T
				out[i] = await fn(item)
			}
		}
		await Promise.all(
			Array.from(
				{ length: Math.min(RECORDINGS_SCAN_CONCURRENCY, items.length) },
				() => worker(),
			),
		)
		return out
	}

	function idFor(
		spec: FolderSpec,
		name: string,
		counts: Counts,
	): string | null {
		const id =
			spec.dsdIndex !== null
				? callFileServable(spec.kind, name)
					? dsdId(spec.dsdIndex, name)
					: null
				: spec.discoveryId !== null
					? scanId(spec.discoveryId, name)
					: null
		if (id === null) return null
		if (id.length > RECORDINGS_ID_MAX_LENGTH) {
			counts.longIds++
			return null
		}
		return id
	}

	function sameSpec(a: FolderSpec, b: FolderSpec): boolean {
		return (
			a.dir === b.dir &&
			a.real === b.real &&
			a.kind === b.kind &&
			a.dsdIndex === b.dsdIndex &&
			a.decoderId === b.decoderId &&
			a.discoveryId === b.discoveryId &&
			a.dirs.length === b.dirs.length &&
			a.dirs.every((d, i) => d === b.dirs[i])
		)
	}

	/** The folder's state for `spec` (a changed spec starts over). */
	function stateFor(spec: FolderSpec): FolderState {
		const state = folders.get(spec.key)
		if (state && sameSpec(state.spec, spec)) {
			state.spec = spec
			return state
		}
		if (state) removeFolder(spec.key)
		const fresh: FolderState = {
			spec,
			files: new Map(),
			pending: new Map(),
			seq: ++stateSeq,
		}
		folders.set(spec.key, fresh)
		return fresh
	}

	/** Every configured directory on the way is still a real directory. */
	async function dirsHold(spec: FolderSpec, counts: Counts): Promise<boolean> {
		for (const d of spec.dirs) {
			try {
				if (!(await isRealDir(d))) return false
			} catch (err) {
				note(counts, "dirErrors", err)
				return false
			}
		}
		return true
	}

	/** Re-checks one name of a folder: indexed, pending (still written) or dropped. */
	async function refreshName(
		state: FolderState,
		name: string,
		id: string,
		at: number,
		counts: Counts,
	): Promise<void> {
		const spec = state.spec
		const file = childPath(spec.dir, name)
		const real = childPath(spec.real, name)
		if (file === null || real === null) return
		let st: RecordingStats
		try {
			st = await lstat(file)
		} catch (err) {
			if (!isSkip(err)) note(counts, "fileErrors", err)
			clearPending(state, name)
			dropFile(state, name)
			return
		}
		if (
			st.isSymbolicLink() ||
			!st.isFile() ||
			!Number.isFinite(st.mtimeMs) ||
			!Number.isFinite(st.size)
		) {
			clearPending(state, name)
			dropFile(state, name)
			return
		}
		if (st.mtimeMs > at - RECORDINGS_IN_PROGRESS_MS) {
			// Still being written: listed once it settled (a timer and every listing re-check it).
			dropFile(state, name)
			setPending(state, name, st.mtimeMs + RECORDINGS_IN_PROGRESS_MS)
			return
		}
		clearPending(state, name)
		const prev = state.files.get(name)
		// A copy sidecar change (copyChanged): the WAV stat is unchanged, so the stat-equal pass
		// below would never see it. Only the sidecar is read again (a changed WAV reads it anyway).
		const copyStale = copyDirty.delete(name)
		const copyRoot = spec.dirs[0]
		if (
			copyStale &&
			prev &&
			prev.receipt !== null &&
			spec.kind === "scanner-analog" &&
			copyRoot !== undefined &&
			prev.dev === st.dev &&
			prev.ino === st.ino &&
			prev.size === st.size &&
			prev.mtimeMs === st.mtimeMs
		) {
			const copy = await handleSem.run(() =>
				readRecordingCopy(fs, copyRoot, name),
			)
			if (!attached(state) || state.files.get(name) !== prev) return
			setFile(state, name, {
				...prev,
				listed: false,
				receipt: { ...prev.receipt, copy },
			})
			return
		}
		if (
			prev &&
			prev.dev === st.dev &&
			prev.ino === st.ino &&
			prev.size === st.size &&
			prev.mtimeMs === st.mtimeMs
		) {
			// A young scanner analog file indexed before its receipt was written (the store links
			// the WAV first): only its receipt is read again, on every pass until
			// RECORDINGS_RECEIPT_WAIT_MS. While it is still missing nothing changed, so nothing is
			// replaced and no change is announced.
			const root = spec.dirs[0]
			// The facts sidecar follows the receipt the same way: read again while it is missing.
			if (
				(prev.receipt !== null && (prev.receipt.facts ?? null) !== null) ||
				spec.kind !== "scanner-analog" ||
				root === undefined ||
				!receiptMayFollow(st.mtimeMs, at)
			)
				return
			const late = await handleSem.run(() =>
				readRecordingReceipt(fs, root, name),
			)
			if (late === null || !attached(state) || state.files.get(name) !== prev)
				return
			// Nothing new: a receipt read again without its sidecar changes nothing.
			if (prev.receipt !== null && (late.facts ?? null) === null) return
			setFile(state, name, { ...prev, listed: false, receipt: late })
			return
		}
		if (!prev && beyondBound(st.mtimeMs, id)) return
		const c: Candidate = {
			loc: { file, name, real, dirs: spec.dirs },
			name,
			id,
			kind: spec.kind,
			decoderId: spec.kind === "dv-call" ? dvCallDecoder(name) : spec.decoderId,
			discoveryId: spec.discoveryId,
			frequencyHz: null,
		}
		const entry = await handleSem.run(() => buildFrom(c, st, at, counts))
		const root = spec.dirs[0]
		const receipt =
			entry && spec.kind === "scanner-analog" && root !== undefined
				? await handleSem.run(() => readRecordingReceipt(fs, root, name))
				: null
		// The folder may have been replaced meanwhile (config change): never write into a stale state.
		if (!attached(state)) return
		if (!entry) {
			dropFile(state, name)
			return
		}
		setFile(state, name, {
			mtimeMs: entry.mtimeMs,
			item: entry.item,
			key: recordingKeepKeyOf(entry.item.id),
			listed: false,
			folder: spec.key,
			name,
			rank: spec.rank,
			discoveryId: spec.discoveryId,
			dev: entry.stat.dev,
			ino: entry.stat.ino,
			size: entry.stat.size,
			receipt,
		})
	}

	/** Indexes a folder: every name (`only` absent) or just `only`. */
	async function indexFolder(
		spec: FolderSpec,
		counts: Counts,
		only?: ReadonlySet<string>,
		paced = false,
	): Promise<void> {
		await withFolder(spec.key, async () => {
			if (closed) return
			const state = stateFor(spec)
			const at = now()
			if (!(await dirsHold(spec, counts))) {
				if (folders.get(spec.key) === state) removeFolder(spec.key)
				return
			}
			let names: string[]
			if (only) names = [...only]
			else {
				const listed = await listNames(spec.dir, counts)
				if (listed === null) {
					if (folders.get(spec.key) === state) removeFolder(spec.key)
					return
				}
				if (listed.truncated) namesTruncated = true
				names = listed.names
			}
			const present = new Set<string>()
			const work: [string, string][] = []
			for (const name of names) {
				const id = idFor(spec, name, counts)
				if (id === null) continue
				present.add(name)
				work.push([name, id])
			}
			if (paced) {
				// A large folder never holds the loop or the fs pool for long: chunks, then a pause.
				for (
					let i = 0;
					i < work.length;
					i += RECORDINGS_RECONCILE_CHUNK_NAMES
				) {
					await pool(
						work.slice(i, i + RECORDINGS_RECONCILE_CHUNK_NAMES),
						([name, id]) => refreshName(state, name, id, at, counts),
					)
					if (i + RECORDINGS_RECONCILE_CHUNK_NAMES < work.length)
						await pause(RECORDINGS_RECONCILE_FOLDER_GAP_MS)
				}
			} else
				await pool(work, ([name, id]) =>
					refreshName(state, name, id, at, counts),
				)
			if (only) {
				for (const name of only)
					if (!present.has(name)) {
						clearPending(state, name)
						dropFile(state, name)
					}
				return
			}
			for (const name of [...state.files.keys()])
				if (!present.has(name)) dropFile(state, name)
			for (const name of [...state.pending.keys()])
				if (!present.has(name)) clearPending(state, name)
		})
	}

	function logSkipped(counts: Counts): void {
		const skipped =
			counts.sourceErrors +
			counts.dirErrors +
			counts.fileErrors +
			counts.lookupErrors +
			counts.longIds
		if (skipped === 0) return
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

	/**
	 * One pass over every folder. Unpaced (the first build, an explicit invalidate, a source
	 * change): folders in a pool, newest first. Paced (the reconcile): one folder at a time with
	 * a pause between folders, so it never competes with live work.
	 */
	async function fullPass(paced: boolean): Promise<void> {
		passing++
		try {
			await fullPassOnce(paced)
		} finally {
			passing--
		}
	}

	async function fullPassOnce(paced: boolean): Promise<void> {
		const counts = newCounts()
		// States created after this point (a writer indexed a new folder while the derive ran)
		// are not this pass's to remove.
		const seqAtDerive = stateSeq
		namesTruncated = false
		const out = { foldersTruncated: false }
		const specs = await deriveFolders(counts, out)
		foldersTruncated = out.foldersTruncated
		const keys = new Set(specs.map(s => s.key))
		const gone = [...folders.entries()].filter(
			([key, state]) => !keys.has(key) && state.seq <= seqAtDerive,
		)
		await Promise.all(
			gone.map(([key, state]) =>
				withFolder(key, async () => {
					if (folders.get(key) === state) removeFolder(key)
				}),
			),
		)
		if (paced) {
			for (const spec of specs) {
				if (closed) return
				await indexFolder(spec, counts, undefined, true)
				await pause(RECORDINGS_RECONCILE_FOLDER_GAP_MS)
			}
		} else {
			await pool(specs, spec => indexFolder(spec, counts))
		}
		lastFullAt = now()
		lastDsdComplete = counts.missingSources === 0
		lastPassClean =
			counts.sourceErrors === 0 &&
			counts.dirErrors === 0 &&
			!foldersTruncated &&
			!namesTruncated &&
			cutoff === null
		logSkipped(counts)
	}

	function trackUrgent(p: Promise<void>): Promise<void> {
		const tracked = p.catch((err: unknown) => {
			log.warn(
				{ err: safeErrorFields(err) },
				"Recordings catalogue refresh failed",
			)
		})
		urgent.add(tracked)
		void tracked.finally(() => urgent.delete(tracked))
		return tracked
	}

	function pause(ms: number): Promise<void> {
		return new Promise(resolve => {
			const t = setTimeout(resolve, ms)
			unref(t)
		})
	}

	function scheduleReconcile(): void {
		if (closed || reconcileTimer !== null) return
		reconcileTimer = setTimeout(() => {
			reconcileTimer = null
			void fullPass(true)
				.catch((err: unknown) => {
					log.warn(
						{ err: safeErrorFields(err) },
						"Recordings catalogue reconcile failed",
					)
				})
				.finally(scheduleReconcile)
		}, reconcileIntervalMs)
		unref(reconcileTimer)
	}

	function start(): Promise<void> {
		if (build === null) {
			startedAt = now()
			configKey = sourcesKey()
			build = fullPass(false)
				.catch((err: unknown) => {
					log.warn(
						{ err: safeErrorFields(err) },
						"Recordings catalogue build failed",
					)
				})
				.finally(() => {
					built = true
					// The first `indexing: false` is announced too.
					revision++
					scheduleEvent()
					scheduleReconcile()
				})
		}
		return build
	}

	/** The configured sources as plain text (memory only), to notice a configuration change. */
	function sourcesKey(): string {
		try {
			const dsd = options.dsdFmeDirs().map(d => [d.decoderId, d.dir])
			return JSON.stringify([dsd, options.scannerRecordingsDir()])
		} catch {
			return "error"
		}
	}

	/** Settles in-progress files that are due by the injected clock (urgent, awaited by list). */
	function settleDue(): void {
		const at = now()
		for (const state of folders.values()) {
			if (state.pending.size === 0) continue
			const due = new Set<string>()
			for (const [name, t] of state.pending) if (t <= at) due.add(name)
			if (due.size > 0)
				void trackUrgent(indexFolder(state.spec, newCounts(), due))
		}
	}

	function schedulePending(): void {
		if (pendingTimer !== null || closed) return
		let earliest = Number.POSITIVE_INFINITY
		for (const state of folders.values())
			for (const t of state.pending.values()) earliest = Math.min(earliest, t)
		if (!Number.isFinite(earliest)) return
		const wait = Math.max(0, earliest - now()) + RECORDINGS_SETTLE_SLACK_MS
		pendingTimer = setTimeout(() => {
			pendingTimer = null
			settleDue()
			schedulePending()
		}, wait)
		unref(pendingTimer)
	}

	/** Waits for the first build and urgent refreshes, at most RECORDINGS_INDEXING_WAIT_MS. */
	async function settle(): Promise<void> {
		const waits: Promise<void>[] = [...urgent]
		if (!built && build !== null) waits.push(build)
		if (waits.length === 0) return
		let timer: ReturnType<typeof setTimeout> | undefined
		await Promise.race([
			Promise.all(waits),
			new Promise<void>(resolve => {
				timer = setTimeout(resolve, RECORDINGS_INDEXING_WAIT_MS)
				unref(timer)
			}),
		])
		if (timer !== undefined) clearTimeout(timer)
	}

	function currentView(): View {
		return view
	}

	/**
	 * The listing's per-read helpers: owners cached per read, the protection answer, and the
	 * listed item as a page serves it (roll-over parts computed once per observation).
	 */
	function itemReader(counts: Counts) {
		const protection = options.protection
		const eventIdOf = options.activityEventId
		const owners = new Map<string, Owner | null>()
		const ownerOf = (folderId: string): Owner | null => {
			const known = owners.get(folderId)
			if (known !== undefined) return known
			const o = lookupOwner(folderId, counts)
			owners.set(folderId, o)
			return o
		}
		const keptOf = (e: IndexedEntry): boolean | undefined => {
			if (!protection) return undefined
			if (e.key === null) return true
			try {
				return protection.isProtected(e.key) !== false
			} catch {
				return true
			}
		}
		// Roll-over parts, per observation of a listed analog file: computed once per read.
		const parts = new Map<string, Map<IndexedEntry, PartOf>>()
		const partsOf = (e: IndexedEntry): PartOf | null => {
			const observationId = e.receipt?.observationId ?? null
			if (observationId === null) return null
			let group = parts.get(observationId)
			if (!group) {
				const listed = (byObservation.get(observationId) ?? []).filter(
					f => f.listed,
				)
				group = new Map<IndexedEntry, PartOf>()
				for (const [f, at] of recordingParts(
					listed.map(f => ({
						mtimeMs: f.mtimeMs,
						id: f.item.id,
						cut: f.receipt?.cut ?? null,
						f,
					})),
				))
					group.set(f.f, at)
				parts.set(observationId, group)
			}
			return group.get(e) ?? null
		}
		const itemOf = (
			e: IndexedEntry,
			kept: boolean | undefined,
		): RecordingInventoryItem => {
			const owner = e.discoveryId === null ? null : ownerOf(e.discoveryId)
			const item: RecordingInventoryItem = {
				...e.item,
				// In whole Hz, rounded as the Activity row's channel is (activityChannelOf).
				frequencyHz:
					owner?.frequencyHz == null ? null : Math.round(owner.frequencyHz),
				key: e.key ?? e.item.id,
				ownerDiscoveryId: owner?.id ?? null,
			}
			if (e.item.kind === "scanner-analog") {
				const at = partsOf(e)
				item.cut = e.receipt?.cut ?? null
				item.part = at?.part ?? null
				item.parts = at?.parts ?? null
			}
			// What the recorder knew at the finish (the receipt), unknown for every other kind.
			const receipt = e.item.kind === "scanner-analog" ? e.receipt : null
			item.startedAt = receipt?.startedAt ?? null
			item.observationId = receipt?.observationId ?? null
			item.speech = receipt?.speech ?? "unchecked"
			item.keptBy = receipt?.keptBy ?? null
			item.facts = receipt?.facts ?? null
			// The transmission open at the file's first sample (its facts); null: unknown.
			if (e.item.kind === "scanner-analog") {
				item.txId = receipt?.facts?.txId ?? null
				item.copyOf = copyOfEntry(e)
			}
			if (kept !== undefined) item.kept = kept
			if (eventIdOf !== undefined) {
				let eventId: string | null = null
				try {
					const found = eventIdOf(item.key ?? item.id)
					eventId = typeof found === "string" ? found : null
				} catch {
					eventId = null
				}
				item.activityEventId = eventId
			}
			return item
		}
		return { ownerOf, keptOf, itemOf }
	}

	/** The listed, non-copy root entry of `key`, or null. */
	function listedRootOf(key: string): IndexedEntry | null {
		for (const r of byKey.get(key) ?? [])
			if (r.listed) return (r.receipt?.copy ?? null) === null ? r : null
		return null
	}

	/**
	 * A listed scanner analog file's copy link as served: its sidecar's root, only while that root
	 * is listed and not itself a copy (else null: the file is shown again).
	 */
	function copyOfEntry(
		e: IndexedEntry,
	): { key: string; evidence: string[] } | null {
		const c = e.receipt?.copy ?? null
		if (c === null || e.item.kind !== "scanner-analog") return null
		if (c.of.key === (e.key ?? e.item.id)) return null
		if (listedRootOf(c.of.key) === null) return null
		return { key: c.of.key, evidence: [...c.evidence] }
	}

	/** Listed copies over the whole catalogue (counts.copiesTotal): O(copies indexed). */
	function copiesListed(): number {
		let n = 0
		for (const [root, set] of byCopyRoot) {
			if (listedRootOf(root) === null) continue
			for (const e of set)
				if (
					e.listed &&
					e.item.kind === "scanner-analog" &&
					(e.key ?? e.item.id) !== root
				)
					n++
		}
		return n
	}

	function page(q: NormalisedQuery): RecordingInventoryPage {
		const v = currentView()
		const protection = options.protection
		const counts = newCounts()
		const { ownerOf, keptOf, itemOf } = itemReader(counts)
		const hzOf = (e: IndexedEntry): number | null =>
			e.discoveryId === null
				? null
				: (ownerOf(e.discoveryId)?.frequencyHz ?? null)
		const wanted =
			q.discoveryId === null
				? null
				: { id: q.discoveryId, owner: ownerOf(q.discoveryId)?.id ?? null }
		const keep = (e: IndexedEntry, kept: boolean | undefined): boolean => {
			const it = e.item
			if (q.kind !== null && it.kind !== q.kind) return false
			if (q.decoderId !== null && it.decoderId !== q.decoderId) return false
			if (q.talkgroup !== null && it.talkgroup !== q.talkgroup) return false
			if (q.source !== null && it.source !== q.source) return false
			if (q.sinceMs !== null && e.mtimeMs < q.sinceMs) return false
			if (q.untilMs !== null && e.mtimeMs > q.untilMs) return false
			if (q.kept !== null && (kept === true) !== q.kept) return false
			if (!q.copies && copyOfEntry(e) !== null) return false
			if (wanted !== null) {
				if (e.discoveryId === null) return false
				if (
					e.discoveryId !== wanted.id &&
					(wanted.owner === null || ownerOf(e.discoveryId)?.id !== wanted.owner)
				)
					return false
			}
			if (q.minHz !== null || q.maxHz !== null) {
				const hz = hzOf(e)
				if (hz === null) return false
				if (q.minHz !== null && hz < q.minHz) return false
				if (q.maxHz !== null && hz > q.maxHz) return false
			}
			// The channel scopes match on the channel frequency: the owner's, in whole Hz.
			if (q.channelHz !== null || q.nearHz !== null) {
				const hz = hzOf(e)
				if (hz === null) return false
				const channel = Math.round(hz)
				if (q.channelHz !== null && channel !== q.channelHz) return false
				if (
					q.nearHz !== null &&
					Math.abs(channel - q.nearHz) > (q.nearToleranceHz ?? 0)
				)
					return false
			}
			if (q.q !== null) {
				const hz = hzOf(e)
				if (e.hay === undefined || e.hayHz !== hz) {
					e.hay = haystack(it, hz)
					e.hayHz = hz
				}
				if (!e.hay.includes(q.q)) return false
			}
			return true
		}
		const selected: { e: IndexedEntry; kept: boolean | undefined }[] = []
		/** With `nearHz`: matches per channel frequency (matchedByChannel). */
		const byChannel = q.nearHz === null ? null : new Map<number, number>()
		let matched = 0
		let keptTotal = 0
		let more = false
		const filtered =
			q.kind !== null ||
			q.decoderId !== null ||
			q.talkgroup !== null ||
			q.source !== null ||
			q.sinceMs !== null ||
			q.untilMs !== null ||
			q.kept !== null ||
			!q.copies ||
			wanted !== null ||
			q.minHz !== null ||
			q.maxHz !== null ||
			q.channelHz !== null ||
			q.nearHz !== null ||
			q.q !== null
		// One protection answer per entry per listing, reused by the page.
		const n = v.entries.length
		if (!filtered) {
			const keptAt: (boolean | undefined)[] = new Array<boolean | undefined>(n)
			if (protection)
				for (let i = 0; i < n; i++) {
					const e = v.entries[i]
					const k = e === undefined ? undefined : keptOf(e)
					keptAt[i] = k
					if (k === true) keptTotal++
				}
			// No filter: the page is a slice after the cursor (binary search), nothing more.
			matched = v.entries.length
			let start = 0
			if (q.cursor !== null) {
				const c = q.cursor
				let lo = 0
				let hi = v.entries.length
				while (lo < hi) {
					const mid = (lo + hi) >>> 1
					const at = v.entries[mid]
					if (at !== undefined && !afterCursor(at, c)) lo = mid + 1
					else hi = mid
				}
				start = lo
			}
			const end = Math.min(n, start + q.limit)
			for (let i = start; i < end; i++) {
				const e = v.entries[i]
				if (e) selected.push({ e, kept: keptAt[i] })
			}
			more = end < n
		} else {
			for (let i = 0; i < n; i++) {
				const e = v.entries[i]
				if (e === undefined) continue
				const kept = keptOf(e)
				if (kept === true) keptTotal++
				if (!keep(e, kept)) continue
				matched++
				if (byChannel !== null) {
					// keep() matched it on its channel: hzOf is known (owners are cached).
					const channel = Math.round(hzOf(e) ?? 0)
					byChannel.set(channel, (byChannel.get(channel) ?? 0) + 1)
				}
				if (!afterCursor(e, q.cursor)) continue
				if (selected.length < q.limit) selected.push({ e, kept })
				else more = true
			}
		}
		const last = selected[selected.length - 1]
		const items = selected.map(({ e, kept }) => itemOf(e, kept))
		if (counts.lookupErrors > 0) logSkipped(counts)
		return {
			items,
			nextCursor:
				more && last
					? encodeCursor({ m: last.e.mtimeMs, i: last.e.item.id })
					: null,
			scannedFiles: v.entries.length,
			truncated: cutoff !== null || foldersTruncated || namesTruncated,
			scannedAt: new Date(lastFullAt ?? startedAt).toISOString(),
			revision,
			indexing: !built,
			matched,
			...(byChannel === null
				? {}
				: { matchedByChannel: channelCounts(byChannel) }),
			counts: {
				total: v.entries.length,
				kept: keptTotal,
				bytes: v.bytes,
				byKind: { ...v.byKind },
				copiesTotal: copiesListed(),
			},
			truncatedBefore:
				cutoff !== null ? new Date(cutoff.m).toISOString() : null,
		}
	}

	function lookupOwner(folderId: string, counts: Counts): Owner | null {
		if (options.discoveryOwner) {
			try {
				const o: unknown = options.discoveryOwner(folderId)
				if (typeof o !== "object" || o === null) return null
				const { id, frequencyHz } = o as { id?: unknown; frequencyHz?: unknown }
				return {
					id:
						typeof id === "string" && SCANNER_DISCOVERY_ID.test(id) ? id : null,
					frequencyHz:
						typeof frequencyHz === "number" &&
						Number.isFinite(frequencyHz) &&
						frequencyHz > 0
							? frequencyHz
							: null,
				}
			} catch (err) {
				note(counts, "lookupErrors", err)
				return null
			}
		}
		const hz = centreHz(folderId, new Map(), counts)
		return hz === null ? null : { id: null, frequencyHz: hz }
	}

	/** Re-indexes the folders of these discoveries (writers: finalize, delete, retention). */
	async function refreshDiscoveries(ids: readonly string[]): Promise<void> {
		const counts = newCounts()
		const base = await scannerBase(counts)
		const work: Promise<void>[] = []
		for (const d of ids) {
			if (!SCANNER_DISCOVERY_ID.test(d)) continue
			for (const kindDir of SCANNER_RECORDING_KINDS) {
				const key = base === null ? null : path.join(base.root, kindDir, d)
				const spec =
					base === null
						? null
						: await scannerFolder(base.root, base.realRoot, kindDir, d, counts)
				if (spec !== null) work.push(indexFolder(spec, counts))
				else if (key !== null && folders.has(key))
					work.push(withFolder(key, async () => removeFolder(key)))
			}
		}
		await Promise.all(work)
		logSkipped(counts)
	}

	/**
	 * A call ended: re-read only that decoder's dsd-fme directory and check only names not
	 * indexed yet that are at least as new as the newest one indexed (names start with the date
	 * and time), plus none other: one directory read and one lstat per new call. A decoder with
	 * no indexed dsd-fme directory (not created yet, DMR-mode dsd-fme, dv-recorder-only decoders)
	 * re-derives the dsd sources only (one realpath check per configured source, never the
	 * scanner walk) on each of its call ends, so a directory created since is indexed.
	 */
	async function refreshCalls(
		decoderIds: ReadonlySet<string> | null,
	): Promise<void> {
		const counts = newCounts()
		// The dv call recorder's directory holds every decoder's calls: any touch re-reads it.
		const wanted = (spec: FolderSpec): boolean =>
			spec.kind === "dv-call" ||
			(spec.kind === "dsd-fme-call" &&
				(decoderIds === null ||
					(spec.decoderId !== null && decoderIds.has(spec.decoderId))))
		const states = [...folders.values()].filter(st => wanted(st.spec))
		const known = new Set(
			states
				.filter(st => st.spec.kind === "dsd-fme-call")
				.map(st => st.spec.decoderId),
		)
		// A decoder with no indexed dsd-fme directory re-derives them, even with the dv call
		// recorder's directory indexed: that one never stands for a decoder's own directory.
		const missing =
			decoderIds === null ? [] : [...decoderIds].filter(d => !known.has(d))
		if (missing.length > 0 || states.length === 0) {
			const specs = (await dsdFolders(counts)).filter(wanted)
			await Promise.all(
				specs
					.filter(sp => !folders.has(sp.key))
					.map(sp => indexFolder(sp, counts)),
			)
		}
		await Promise.all(states.map(st => newCalls(st, counts)))
		logSkipped(counts)
	}

	async function newCalls(state: FolderState, counts: Counts): Promise<void> {
		const spec = state.spec
		await withFolder(spec.key, async () => {
			if (closed || !attached(state)) return
			if (!(await dirsHold(spec, counts))) {
				if (attached(state)) removeFolder(spec.key)
				return
			}
			const listed = await listNames(spec.dir, counts)
			if (listed === null) {
				if (attached(state)) removeFolder(spec.key)
				return
			}
			let newest = ""
			for (const name of state.files.keys()) {
				const stamp = name.slice(0, CALL_STAMP_LENGTH)
				if (stamp > newest) newest = stamp
			}
			const at = now()
			const work: [string, string][] = []
			for (const name of listed.names) {
				if (state.files.has(name) || state.pending.has(name)) continue
				if (name.slice(0, CALL_STAMP_LENGTH) < newest) continue
				const id = idFor(spec, name, counts)
				if (id !== null) work.push([name, id])
			}
			await pool(work, ([name, id]) => refreshName(state, name, id, at, counts))
		})
	}

	function flushTouches(): void {
		touchTimer = null
		const ids = [...touchedDiscoveries]
		touchedDiscoveries.clear()
		const calls = touchedCalls
		const decoders = touchedDecoders
		touchedCalls = false
		touchedDecoders = new Set()
		const waiters = touchWaiters
		touchWaiters = []
		const work: Promise<void>[] = []
		if (ids.length > 0) work.push(refreshDiscoveries(ids))
		if (calls) work.push(refreshCalls(decoders))
		void Promise.all(work)
			.catch((err: unknown) => {
				log.warn(
					{ err: safeErrorFields(err) },
					"Recordings catalogue refresh failed",
				)
			})
			.finally(() => {
				for (const w of waiters) w()
			})
	}

	function touch(): Promise<void> {
		if (closed) return Promise.resolve()
		void start()
		const done = new Promise<void>(resolve => touchWaiters.push(resolve))
		if (touchTimer === null) {
			touchTimer = setTimeout(flushTouches, RECORDINGS_TOUCH_DEBOUNCE_MS)
			unref(touchTimer)
		}
		return done
	}

	/** The folder states holding an inventory id (dsd index or discovery), for invalidate(id). */
	function statesOf(id: string): { state: FolderState; name: string }[] {
		const m = typeof id === "string" ? RECORDING_INVENTORY_ID.exec(id) : null
		if (!m) return []
		const out: { state: FolderState; name: string }[] = []
		const [, n, dsdName, recordingId] = m
		const sm =
			recordingId === undefined ? null : SCANNER_RECORDING_ID.exec(recordingId)
		for (const state of folders.values()) {
			const s = state.spec
			if (n !== undefined && dsdName !== undefined) {
				if (s.dsdIndex === Number(n)) out.push({ state, name: dsdName })
			} else if (sm?.[1] !== undefined && sm[2] !== undefined) {
				if (s.discoveryId === sm[1]) out.push({ state, name: sm[2] })
			}
		}
		return out
	}

	function invalidateId(id: string): void {
		const targets = statesOf(id)
		// Keep and unkeep change no file but the listed `kept`: announced as a change.
		changed("changed")
		for (const { state, name } of targets)
			void trackUrgent(indexFolder(state.spec, newCounts(), new Set([name])))
		if (targets.length === 0 && RECORDING_INVENTORY_ID.test(id)) {
			const sm = /^scan:(d_[0-9A-Za-z]+)~/.exec(id)
			if (sm?.[1]) void trackUrgent(refreshDiscoveries([sm[1]]))
		}
	}

	/** Every place an id may live, in lookup order (dv before analog). No fs call on a bad id. */
	async function locations(id: string): Promise<Location[]> {
		if (typeof id !== "string" || id.length > RECORDINGS_ID_MAX_LENGTH)
			return []
		// A dsd-fme call's stable key (an Activity row's recording id): every dsd-fme directory in
		// order, as its keep key protects the name in each.
		const key = RECORDING_DSD_KEY.exec(id)
		if (key?.[1] !== undefined) {
			const name = key[1]
			// Only a name the catalogue lists (a dsd-fme call name, never TEMP_): dsdId's check.
			if (dsdId(0, name) === null) return []
			const out: Location[] = []
			for (const source of await dsdSources(newCounts())) {
				if (!callFileServable(source.kind, name)) continue
				const file = childPath(source.dir, name)
				const real = childPath(source.real, name)
				if (file !== null && real !== null)
					out.push({ file, name, real, dirs: [source.dir] })
			}
			return out
		}
		const m = RECORDING_INVENTORY_ID.exec(id)
		if (!m) return []
		const [, n, dsdName, recordingId] = m
		if (n !== undefined && dsdName !== undefined) {
			if (dsdId(Number(n), dsdName) !== id) return []
			const sources = await dsdSources(newCounts())
			const source = sources[Number(n)]
			if (!source || !callFileServable(source.kind, dsdName)) return []
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
		const root = await scannerRoot(newCounts())
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
	async function openId(id: string): Promise<{
		handle: RecordingFileHandle
		stat: RecordingStats
		loc: Location
	} | null> {
		const at = now()
		const loc = await firstEligible(id, at)
		if (!loc) return null
		const opened = await openVerified(loc, at)
		return opened ? { ...opened, loc } : null
	}

	/** Open `loc` (O_NOFOLLOW, O_NONBLOCK) and verify it; the caller owns the handle. */
	async function openVerified(
		loc: Location,
		at: number,
	): Promise<{ handle: RecordingFileHandle; stat: RecordingStats } | null> {
		let handle: RecordingFileHandle
		try {
			handle = await sem.run(() => fs.open(loc.file, OPEN_FLAGS))
		} catch {
			return null
		}
		const h = handle
		let ok = false
		try {
			const stat = await verifyOpened(h, loc, at, null)
			ok = stat !== null
			return stat !== null ? { handle: h, stat } : null
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
			void start()
			// A configuration change (memory only to notice) re-derives every folder, awaited.
			const key = sourcesKey()
			if (configKey !== null && key !== configKey) {
				configKey = key
				void trackUrgent(fullPass(false))
			}
			settleDue()
			await settle()
			return page(q)
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
				return opened
					? {
							handle: opened.handle,
							name: opened.loc.name,
							path: opened.loc.file,
							stat: opened.stat,
						}
					: null
			} catch {
				return null
			}
		},

		invalidate(id?: string) {
			if (typeof id === "string") {
				invalidateId(id)
				return
			}
			changed("changed")
			void trackUrgent(fullPass(false))
		},

		start,

		close() {
			closed = true
			for (const t of [pendingTimer, reconcileTimer, touchTimer, eventTimer])
				if (t !== null) clearTimeout(t)
			for (const t of removedTimers) clearTimeout(t)
			removedTimers.clear()
			pendingTimer = reconcileTimer = touchTimer = eventTimer = null
			listeners.clear()
			for (const w of touchWaiters.splice(0)) w()
		},

		touchDiscoveries(ids) {
			for (const id of ids)
				if (typeof id === "string" && SCANNER_DISCOVERY_ID.test(id))
					touchedDiscoveries.add(id)
			return touch()
		},

		touchCallRecordings(decoderId) {
			touchedCalls = true
			if (typeof decoderId === "string" && decoderId.length > 0)
				touchedDecoders?.add(decoderId)
			else touchedDecoders = null
			return touch()
		},

		discoveriesRemoved(ids) {
			const set = new Set(
				ids.filter(
					id => typeof id === "string" && SCANNER_DISCOVERY_ID.test(id),
				),
			)
			if (set.size === 0) return
			const protection = options.protection
			for (const state of [...folders.values()]) {
				const d = state.spec.discoveryId
				if (d === null || !set.has(d)) continue
				// Kept files survive a discovery removal: they stay listed (fail closed: an unknown
				// answer keeps them). Everything else leaves the listing now, without an fs call.
				for (const [name, e] of [...state.files]) {
					let kept = true
					try {
						kept =
							protection === undefined
								? false
								: e.key === null || protection.isProtected(e.key) !== false
					} catch {
						kept = true
					}
					if (!kept) dropFile(state, name)
				}
				state.pending.clear()
			}
			const t = setTimeout(() => {
				removedTimers.delete(t)
				if (closed) return
				for (const d of set) touchedDiscoveries.add(d)
				void touch()
			}, removedRecheckMs)
			unref(t)
			removedTimers.add(t)
		},

		ownersChanged(ids) {
			const set = new Set(ids)
			let n = 0
			for (const state of folders.values())
				if (state.spec.discoveryId !== null && set.has(state.spec.discoveryId))
					n += state.files.size
			changed("changed", n)
		},

		onChange(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},

		itemsOfKeys(keys) {
			const out: RecordingInventoryItem[] = []
			const counts = newCounts()
			const { keptOf, itemOf } = itemReader(counts)
			for (const key of keys.slice(0, RECORDINGS_ITEMS_OF_KEYS_MAX)) {
				for (const e of byKey.get(key) ?? []) {
					// Only what a listing serves: the listed copy of its id.
					if (!e.listed) continue
					out.push(itemOf(e, keptOf(e)))
					break
				}
			}
			if (counts.lookupErrors > 0) logSkipped(counts)
			return out
		},

		keysOfCopyRoot(key) {
			if (listedRootOf(key) === null) return []
			const keys: string[] = []
			for (const e of byCopyRoot.get(key) ?? []) {
				if (!e.listed || e.item.kind !== "scanner-analog") continue
				const k = e.key ?? e.item.id
				if (k !== key && !keys.includes(k)) keys.push(k)
			}
			return keys
		},

		copyChanged(alias) {
			if (typeof alias !== "string") return
			const targets = statesOf(`scan:${alias}`)
			for (const { state, name } of targets) {
				copyDirty.delete(name)
				copyDirty.add(name)
				while (copyDirty.size > RECORDINGS_COPY_DIRTY_MAX) {
					const oldest = copyDirty.values().next()
					if (oldest.done === true) break
					copyDirty.delete(oldest.value)
				}
				void trackUrgent(indexFolder(state.spec, newCounts(), new Set([name])))
			}
		},

		keysOfTx(txId) {
			const set = byTx.get(txId)
			if (!set) return []
			const keys: string[] = []
			for (const e of set) {
				const key = e.key ?? e.item.id
				if (!keys.includes(key)) keys.push(key)
			}
			return keys
		},

		hasKey(key) {
			// A dsd-fme call name the gate refuses (DMR while DMR recordings are off) is served by
			// no source, whatever a missing directory or a running pass holds: its link may go.
			if (key.startsWith("dsd~") && dsdNameRefused(key.slice("dsd~".length)))
				return false
			if (
				!built ||
				!lastPassClean ||
				passing > 0 ||
				urgent.size > 0 ||
				cutoff !== null ||
				foldersTruncated ||
				namesTruncated ||
				(!lastDsdComplete && key.startsWith("dsd~"))
			)
				return null
			return byKey.has(key)
		},

		status() {
			return {
				revision,
				indexing: !built,
				files: currentView().entries.length,
				refreshing: urgent.size > 0,
			}
		},
	}
}

/** The transmissions an indexed file's facts name (start id first). */
function txIdsOfEntry(e: IndexedEntry): readonly string[] {
	const facts = e.receipt?.facts
	if (!facts?.txId) return []
	return facts.moreTxIds ? [facts.txId, ...facts.moreTxIds] : [facts.txId]
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
		startedAtLocal: isCallKind(c.kind)
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
