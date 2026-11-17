import { DISCOVERY_NEAR_MAX_TOLERANCE_HZ } from "./scanner.js"

/**
 * WG8 recordings inventory (docs/specs/web-gaps-8, requirement 4): a protected, read-only list
 * of the WAV recordings WaveKit already writes (dsd-fme per-call recordings and scanner
 * recordings) with whole-file download. No Keep, delete or trim (activity-recording-catalog
 * tasks 5 and 6).
 */

/**
 * WG8 req 4.1: the inventory routes mount only in protected access mode. false would mount
 * them in legacy mode too.
 */
export const RECORDINGS_REQUIRES_ACCESS = true
/** WG8 req 4.1: the list route. */
export const RECORDINGS_ROUTE = "/api/recordings"
/** WG8 req 4.5: the download route (`:id` is a RECORDING_INVENTORY_ID). */
export const RECORDINGS_FILE_ROUTE = "/api/recordings/:id/file"
/** WG8 req 4.4: page size bounds. */
export const RECORDINGS_PAGE_LIMIT_DEFAULT = 50
export const RECORDINGS_PAGE_LIMIT_MAX = 200
/** WG8 req 4.4: characters of an opaque cursor. */
export const RECORDINGS_CURSOR_MAX_LENGTH = 512
/**
 * WG8 req 4.6: the former per-scan file bound. The catalogue no longer scans per listing; this
 * stays the size of one index chunk (how many files the first build indexes before a listing
 * may answer with `indexing: true`).
 */
export const RECORDINGS_SCAN_MAX_FILES = 2000
/**
 * Recordings catalogue bound: at most this many files are indexed and listed, newest
 * modification time first. Past it the oldest are left out (`truncated`, `truncatedBefore`).
 * About 600 bytes of memory per entry: 50 000 entries ≈ 30 MB.
 */
export const RECORDINGS_CATALOGUE_MAX = 50_000
/** Recording folders the catalogue enters (newest directory change first); past it, `truncated`. */
export const RECORDINGS_CATALOGUE_MAX_FOLDERS = 20_000
/** Characters of the `q` text filter. */
export const RECORDINGS_QUERY_TEXT_MAX = 64
/** WG8 req 4.6: bytes read from a file to find the RIFF `fmt ` and `data` chunks. */
export const RECORDINGS_HEADER_READ_BYTES = 4096
/** The largest `toleranceHz` of a `nearHz` listing: the discovery list's bound. */
export const RECORDINGS_NEAR_MAX_TOLERANCE_HZ = DISCOVERY_NEAR_MAX_TOLERANCE_HZ
/** Entries of `matchedByChannel`: the Activity facets' value cap. */
export const RECORDINGS_CHANNELS_MAX = 32
/** WG8 req 4.6: concurrent filesystem operations of one scan. */
export const RECORDINGS_SCAN_CONCURRENCY = 8
/** WG8 req 4.2: a file modified this recently may still be written (= RECORDING_IN_PROGRESS_MS). */
export const RECORDINGS_IN_PROGRESS_MS = 10_000

/**
 * WG8 req 4.3: an inventory id, never a path. `dsd:<n>~<basename>` (n = index of the dsd-fme
 * recording directory in the inventory's source list, basename a dsd-fme call name) or
 * `scan:<recordingId>` (the scanner's `d_<id>~<file>.wav`). Checked before any lookup.
 */
export const RECORDING_INVENTORY_ID =
	/^(?:dsd:(0|[1-9]\d{0,3})~(\d{8}_\d{6}_\d{5}_[A-Za-z0-9_.-]{1,200}\.wav)|scan:(d_[0-9A-Za-z]+~[A-Za-z0-9_.-]{1,200}\.wav))$/

/**
 * A dsd-fme call recording's stable key (`dsd~<call name>`, an Activity row's
 * `recording.id`). The file route also takes it: the first configured dsd-fme directory that
 * holds the file serves it. Checked before any lookup, like RECORDING_INVENTORY_ID.
 */
export const RECORDING_DSD_KEY =
	/^dsd~(\d{8}_\d{6}_\d{5}_[A-Za-z0-9_.-]{1,200}\.wav)$/

export type RecordingInventoryKind =
	| "dsd-fme-call"
	| "scanner-dv"
	| "scanner-analog"
export const RECORDING_INVENTORY_KINDS: readonly RecordingInventoryKind[] =
	Object.freeze(["dsd-fme-call", "scanner-dv", "scanner-analog"])

export type RecordingCallType = "group" | "private" | "unit"

/**
 * Why a scanner analog recording's file ended before its transmission did, from the file's own
 * receipt: `scanner-moved` (the sweep retuned away), `duration-rollover` (the file reached its
 * length limit; the transmission continues in the next part), `source-lost` (the input stopped),
 * `shutdown` (WaveKit stopped). Null when the file was not cut short or the reason is unknown.
 */
export type RecordingCut =
	| "scanner-moved"
	| "duration-rollover"
	| "source-lost"
	| "shutdown"
export const RECORDING_CUTS: readonly RecordingCut[] = Object.freeze([
	"scanner-moved",
	"duration-rollover",
	"source-lost",
	"shutdown",
])

/**
 * Whether speech was heard in a recording, by the recorder's own measure at its finish: `heard`,
 * `not-heard`, or `unchecked` (not measured: a file classed by its tone, a recording of another
 * kind, a file finished before the field existed, or anything unknown).
 */
export type RecordingSpeech = "heard" | "not-heard" | "unchecked"
export const RECORDING_SPEECH: readonly RecordingSpeech[] = Object.freeze([
	"heard",
	"not-heard",
	"unchecked",
])

/** WG8 req 4.3: one recording. Every field is derived; nothing is guessed. */
export interface RecordingInventoryItem {
	id: string
	kind: RecordingInventoryKind
	/** The dsd-fme decoder that owns the directory; null for scanner recordings. */
	decoderId: string | null
	/** The scanner discovery; null for dsd-fme recordings. */
	discoveryId: string | null
	/** `YYYY-MM-DDTHH:MM:SS` local time from the file name (no zone); null when absent or invalid. */
	startedAtLocal: string | null
	/** ISO-8601 file modification time. */
	modifiedAt: string
	bytes: number
	/** From the RIFF header of a plain PCM WAV; null otherwise. */
	durationMs: number | null
	callType: RecordingCallType | null
	/** Decimal digits only, else null. */
	talkgroup: string | null
	/** Decimal digits only, else null. */
	source: string | null
	/** Known only for scanner recordings (the discovery's centre); never guessed. */
	frequencyHz: number | null
	/**
	 * WG9 req 2.2: the recording is kept (protected from every deletion owner). Absent from cores
	 * before WG9 (read as not kept). While the keep store is unavailable every item reads true.
	 */
	kept?: boolean
	/**
	 * The stable keep key (`dsd~<call name>` or `scan:<recordingId>`): unlike `id`, it survives a
	 * renumbering of the dsd-fme directories. Absent from older cores.
	 */
	key?: string
	/**
	 * The live discovery owning the recording's folder, through merge aliases (the folder keeps
	 * the id it was made under, `discoveryId`). Null when no live discovery owns it and for
	 * dsd-fme recordings. Absent from older cores.
	 */
	ownerDiscoveryId?: string | null
	/**
	 * The Activity row linked to this recording (`GET /api/activity/:eventId`): a dsd-fme call's
	 * `call_end` row or a scanner recording's `recording-change` row. Null when none is known (no
	 * such row, or Activity is off). Absent from older cores.
	 */
	activityEventId?: string | null
	/**
	 * Scanner analog recordings only: why the file ended early (RecordingCut), null when it was
	 * not cut short or its receipt is missing, unreadable or names no such reason. Absent on
	 * other kinds and from older cores.
	 */
	cut?: RecordingCut | null
	/**
	 * Scanner analog recordings only: this file's place (1-based) among the listed files of one
	 * observation (a transmission split by roll-overs), in the order they were finished; null
	 * when the observation is unknown or this is its only listed file. Absent from older cores.
	 */
	part?: number | null
	/** The number of listed files of that observation (null with `part`). */
	parts?: number | null
	/**
	 * When the file's audio starts (ISO-8601 UTC): a scanner analog file's first sample, from its
	 * receipt. Null when unknown (other kinds, older files). Absent from older cores.
	 */
	startedAt?: string | null
	/**
	 * The scanner observation the file recorded (one transmission; its roll-over parts share it),
	 * from its receipt. Null when unknown and for other kinds. Absent from older cores.
	 */
	observationId?: string | null
	/** RecordingSpeech, from the file's receipt; `unchecked` when unknown. Absent from older cores. */
	speech?: RecordingSpeech
	/**
	 * Why the recorder kept the file: its finish reason code (`prior-none`, `own-tone`, `final`,
	 * `joined-decode`, …), as the recorder decisions report it. Null when unknown and for other
	 * kinds. Absent from older cores.
	 */
	keptBy?: string | null
}

/**
 * WG8 req 4.4: GET /api/recordings query (query-string values arrive as strings). Every filter
 * narrows the listing and `matched`; none changes `counts`.
 */
export interface RecordingInventoryQuery {
	limit?: number
	cursor?: string
	kind?: RecordingInventoryKind
	decoderId?: string
	/** `true` or `false`. */
	kept?: boolean | "true" | "false"
	/** A discovery id: matches its own folder and every folder whose live owner it is. */
	discoveryId?: string
	/** Decimal digits. */
	talkgroup?: string
	/** Decimal digits (the radio id). */
	source?: string
	/** Inclusive frequency range in Hz (integers); only recordings with a known frequency match. */
	minHz?: number | string
	maxHz?: number | string
	/**
	 * Recordings of this channel: `frequencyHz` (the owning discovery's, the channel frequency)
	 * equal to it, integer Hz. Not with `nearHz`.
	 */
	channelHz?: number | string
	/** Recordings whose `frequencyHz` lies within `toleranceHz` of this (integer Hz), inclusive. */
	nearHz?: number | string
	/**
	 * With `nearHz` only: integer Hz, 0 to RECORDINGS_NEAR_MAX_TOLERANCE_HZ; omitted:
	 * DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ, as the discovery list.
	 */
	toleranceHz?: number | string
	/** Inclusive modification time range, ISO-8601 with a zone. */
	since?: string
	until?: string
	/**
	 * Case-insensitive text (1 to RECORDINGS_QUERY_TEXT_MAX characters) in the talkgroup, radio,
	 * decoder, kind, local start time or frequency in MHz; never in the opaque id.
	 */
	q?: string
}

/** Recordings catalogue totals (over everything listed, whatever the filters). */
export interface RecordingInventoryCounts {
	total: number
	kept: number
	bytes: number
	byKind: Record<RecordingInventoryKind, number>
}

/** WG8 req 4.4: GET /api/recordings 200 body. Newest `modifiedAt` first, ties by id. */
export interface RecordingInventoryPage {
	items: RecordingInventoryItem[]
	nextCursor: string | null
	/** Files in the catalogue this page comes from (at most RECORDINGS_CATALOGUE_MAX). */
	scannedFiles: number
	/**
	 * Files were left out: only ever the oldest (modified at or before `truncatedBefore`) past
	 * RECORDINGS_CATALOGUE_MAX, or a folder bound was reached (RECORDINGS_CATALOGUE_MAX_FOLDERS).
	 */
	truncated: boolean
	/** ISO-8601 time of the last completed catalogue check of every folder (build or reconcile). */
	scannedAt: string
	/** Catalogue revision: changes whenever a listed recording is added, removed or changed. */
	revision?: number
	/** True while the first build runs: the listing is partial (newest folders first). */
	indexing?: boolean
	/** Recordings matching the filters (cursor aside). */
	matched?: number
	/**
	 * With `nearHz` only: the matching recordings per channel frequency (decimal Hz), count
	 * descending then frequency ascending, at most RECORDINGS_CHANNELS_MAX entries.
	 */
	matchedByChannel?: { frequencyHz: number; count: number }[]
	counts?: RecordingInventoryCounts
	/** Past the bound: the newest modification time left out (ISO-8601); null otherwise. */
	truncatedBefore?: string | null
}

/**
 * `recordings` WebSocket channel (protected mode only), `recordings:changed` message: the
 * catalogue changed. Counts only, never an id or a name; at most one message a second. Refetch.
 */
export interface RecordingsChangedEventData {
	revision: number
	added: number
	removed: number
	changed: number
	indexing: boolean
}

export type RecordingInventoryErrorCode =
	| "RECORDINGS_QUERY_INVALID"
	| "RECORDING_NOT_FOUND"
	| "RECORDINGS_UNAVAILABLE"

/** WG8 inventory error body (400, 404, 503). Never carries a path or a submitted value. */
export interface RecordingInventoryErrorBody {
	error: string
	code: RecordingInventoryErrorCode
	message: string
}

// ------------------------------------------------------------------ WG9 Keep and delete

/**
 * WG9 req 2: per-recording Keep and deletion on the inventory above (protected only, like the
 * inventory). Keep protects one recording from every WaveKit deletion owner (the dsd-fme call
 * pruner, scanner evidence retention, discovery removal and analog retention) until unkept.
 * Delete removes one dsd-fme call recording; deleting a kept recording is refused (unkeep first).
 * Scanner recordings can be kept and unkept this batch but not deleted
 * (`RECORDING_DELETE_UNSUPPORTED`).
 */
export const RECORDING_KEEPS_REQUIRES_ACCESS = true
/** `PUT` keeps, `DELETE` unkeeps (`:id` is a RECORDING_INVENTORY_ID). Both idempotent. */
export const RECORDING_KEEP_ROUTE = "/api/recordings/:id/keep"
/** `DELETE` removes the recording file. */
export const RECORDING_DELETE_ROUTE = "/api/recordings/:id"
/** The keep store file under `stateDir`. */
export const RECORDING_KEEPS_FILE_NAME = "recording-keeps.json"
/**
 * WG9 req 2.3 bounds. Entries: 2 000 (the inventory scan bound). File: 1 MiB (an entry is at
 * most about 330 bytes of JSON with a 236-character key, so 2 000 entries fit in about 660 KB).
 * Kept bytes: 512 MiB in total (the default dsd-fme call recording cap; about 9.3 hours of
 * 8 kHz 16-bit mono call audio), counted with each file's size when it was kept.
 */
export const RECORDING_KEEPS_MAX_ENTRIES = 2000
export const RECORDING_KEEPS_FILE_MAX_BYTES = 1_048_576
export const RECORDING_KEEPS_MAX_BYTES = 536_870_912

/** `PUT`/`DELETE /api/recordings/:id/keep` 200 body. `changed` false = it already was so. */
export interface RecordingKeepResult {
	id: string
	kept: boolean
	changed: boolean
}

/** `DELETE /api/recordings/:id` 200 body. */
export interface RecordingDeleteResult {
	id: string
	deleted: true
}

export type RecordingKeepErrorCode =
	| "RECORDING_KEPT"
	| "RECORDING_BUSY"
	| "RECORDING_KEEP_LIMIT"
	| "RECORDING_DELETE_UNSUPPORTED"
	| "RECORDING_KEEPS_UNAVAILABLE"
	| "RECORDING_KEEP_FAILED"
	| "RECORDING_DELETE_FAILED"

/** WG9: status of every inventory, Keep and delete error code. */
export const RECORDING_ERROR_STATUS: Readonly<
	Record<RecordingInventoryErrorCode | RecordingKeepErrorCode, number>
> = Object.freeze({
	RECORDINGS_QUERY_INVALID: 400,
	RECORDING_NOT_FOUND: 404,
	RECORDINGS_UNAVAILABLE: 503,
	/** Delete of a kept recording: unkeep it first. */
	RECORDING_KEPT: 409,
	/** A Keep and a delete of the same recording overlapped; the other one won. */
	RECORDING_BUSY: 409,
	/** Keep would pass RECORDING_KEEPS_MAX_ENTRIES or RECORDING_KEEPS_MAX_BYTES. */
	RECORDING_KEEP_LIMIT: 409,
	/** Delete of a scanner recording (not this batch). */
	RECORDING_DELETE_UNSUPPORTED: 409,
	/** The keep store is loading, unreadable or cannot be written. */
	RECORDING_KEEPS_UNAVAILABLE: 503,
	/** Keep or unkeep failed for another reason (WG9 amendment); fixed per-operation text. */
	RECORDING_KEEP_FAILED: 500,
	/** Delete failed for another reason, including a shared writable folder (WG9 amendment). */
	RECORDING_DELETE_FAILED: 500,
})

/** WG9 Keep/delete error body (fixed text; never a path, file name or submitted value). */
export interface RecordingKeepErrorBody {
	error: string
	code: RecordingKeepErrorCode
	message: string
}

/**
 * WG9 req 2.6: 409 code of `DELETE /api/scanner/discoveries/:id` when the discovery holds a kept
 * recording (no cascade to protected media; unkeep first).
 */
export const SCANNER_DISCOVERY_HOLDS_KEPT_CODE =
	"SCANNER_DISCOVERY_HOLDS_KEPT_RECORDINGS"
