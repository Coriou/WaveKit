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
