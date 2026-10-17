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
/** WG8 req 4.6: files examined per scan (all sources together). */
export const RECORDINGS_SCAN_MAX_FILES = 2000
/** WG8 req 4.6: bytes read from a file to find the RIFF `fmt ` and `data` chunks. */
export const RECORDINGS_HEADER_READ_BYTES = 4096
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

export type RecordingInventoryKind =
	| "dsd-fme-call"
	| "scanner-dv"
	| "scanner-analog"
export const RECORDING_INVENTORY_KINDS: readonly RecordingInventoryKind[] =
	Object.freeze(["dsd-fme-call", "scanner-dv", "scanner-analog"])

export type RecordingCallType = "group" | "private" | "unit"

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
}

/** WG8 req 4.4: GET /api/recordings query. */
export interface RecordingInventoryQuery {
	limit?: number
	cursor?: string
	kind?: RecordingInventoryKind
	decoderId?: string
}

/** WG8 req 4.4: GET /api/recordings 200 body. Newest `modifiedAt` first, ties by id. */
export interface RecordingInventoryPage {
	items: RecordingInventoryItem[]
	nextCursor: string | null
	/** Files examined by the scan this page comes from. */
	scannedFiles: number
	/** The scan stopped at RECORDINGS_SCAN_MAX_FILES. */
	truncated: boolean
	/** ISO-8601 time of that scan. */
	scannedAt: string
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
