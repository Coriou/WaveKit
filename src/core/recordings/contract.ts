/**
 * WG9 frozen contract for lane RK (docs/specs/web-gaps-9, requirement 2, design "Recording
 * Keep and deletion"). Read-only for the lanes: RK implements the keep store, the protection
 * coordinator and the routes against these names; Main wires them in src/index.ts and
 * src/api/server.ts and applies the scanner-side deleter hooks. Imports nothing but
 * `@wavekit/api-types` and the error base, so every deleter can import it without pulling
 * runtime modules into the startup bundle.
 */
import type {
	RecordingKeepErrorCode,
	RecordingKeepResult,
	RecordingDeleteResult,
} from "@wavekit/api-types"
import {
	RECORDING_ERROR_STATUS,
	RECORDING_INVENTORY_ID,
} from "@wavekit/api-types"
import { WaveKitError } from "../../utils/errors.js"

export const RECORDING_KEEPS_SCHEMA_VERSION = 1

/**
 * A stable keep key; never a path. `dsd~<basename>` for a dsd-fme call recording (any dsd-fme
 * recording directory: the inventory index `n` is not stable, the call name carries a time and
 * five random digits, and matching the name in every directory can only over-protect) or
 * `scan:<discoveryId>~<file>` for a scanner recording (the scanner recording id).
 */
export const RECORDING_KEEP_KEY =
	/^(?:dsd~(\d{8}_\d{6}_\d{5}_[A-Za-z0-9_.-]{1,200}\.wav)|scan:(d_[0-9A-Za-z]+)~([A-Za-z0-9_.-]{1,200}\.wav))$/

export type RecordingKeepKey = string & { readonly __recordingKeepKey: true }

/** The keep key of an inventory id, or null when the id is not a RECORDING_INVENTORY_ID. */
export function recordingKeepKeyOf(
	inventoryId: string,
): RecordingKeepKey | null {
	const m = RECORDING_INVENTORY_ID.exec(inventoryId)
	if (!m) return null
	const key = m[2] !== undefined ? `dsd~${m[2]}` : `scan:${m[3] ?? ""}`
	return RECORDING_KEEP_KEY.test(key) ? (key as RecordingKeepKey) : null
}

/** The keep key of a dsd-fme call file name (a basename, never a path), or null. */
export function dsdFmeKeepKey(basename: string): RecordingKeepKey | null {
	const key = `dsd~${basename}`
	return RECORDING_KEEP_KEY.test(key) ? (key as RecordingKeepKey) : null
}

/** The keep key of a scanner recording file in a discovery folder, or null. */
export function scannerKeepKey(
	discoveryId: string,
	basename: string,
): RecordingKeepKey | null {
	const key = `scan:${discoveryId}~${basename}`
	return RECORDING_KEEP_KEY.test(key) ? (key as RecordingKeepKey) : null
}

/** One stored keep. */
export interface RecordingKeepEntry {
	readonly key: RecordingKeepKey
	/** ISO time the recording was kept. */
	readonly keptAt: string
	/** File size when kept (counts against RECORDING_KEEPS_MAX_BYTES). */
	readonly bytes: number
}

/** `<stateDir>/recording-keeps.json`. */
export interface RecordingKeepsFile {
	schemaVersion: typeof RECORDING_KEEPS_SCHEMA_VERSION
	/** Increments by one per successful write; 0 is "no file". */
	revision: number
	keeps: RecordingKeepEntry[]
}

/**
 * The single deletion decision every deletion owner consults before it removes a recording
 * file or a folder that holds one. Synchronous and fail closed by meaning: while the store is
 * loading, unreadable or failed, every answer is "protected".
 */
export interface RecordingProtection {
	/** True when the key is kept, a delete of it is in progress, or the store state is unknown. */
	isProtected(key: RecordingKeepKey): boolean
	/** dsd-fme pruner form: a file name (never a path); a name that is not a call name is false. */
	isDsdFmeFileProtected(basename: string): boolean
	/** Scanner form: true when the file is kept or the store state is unknown. */
	isScannerFileProtected(discoveryId: string, basename: string): boolean
	/** True when any kept scanner recording lives in the discovery, or the store state is unknown. */
	discoveryHoldsKept(discoveryId: string): boolean
}

/** What the routes call (protected mode only). */
export interface RecordingKeepService extends RecordingProtection {
	/** `PUT /api/recordings/:id/keep`. */
	keep(inventoryId: string): Promise<RecordingKeepResult>
	/** `DELETE /api/recordings/:id/keep`. Allowed when the file is gone. */
	unkeep(inventoryId: string): Promise<RecordingKeepResult>
	/** `DELETE /api/recordings/:id` (dsd-fme call recordings only). */
	remove(inventoryId: string): Promise<RecordingDeleteResult>
	/** "ready" only after a successful load; "loading" and "failed" mean every answer is protected. */
	state(): "loading" | "ready" | "failed"
	close(): Promise<void>
}

export class RecordingKeepError extends WaveKitError {
	declare readonly code: RecordingKeepErrorCode | "RECORDING_NOT_FOUND"
	readonly status: number

	constructor(
		code: RecordingKeepErrorCode | "RECORDING_NOT_FOUND",
		message: string,
	) {
		super(message, code)
		this.name = "RecordingKeepError"
		this.status = RECORDING_ERROR_STATUS[code]
	}
}

// --- WG10 additions (docs/specs/web-gaps-10, requirement 1) ---

/**
 * WG10 req 1.9: a private delete directory `mkdtemp` created next to a recording
 * (`RECORDING_DELETE_PRIVATE_PREFIX` + six characters).
 */
export const RECORDING_DELETE_PRIVATE_DIR = /^\.wavekit-delete-[A-Za-z0-9]{6}$/
/** WG10 req 1.9: the moved entry's name once its identity check passed (unlinked next). */
export const RECORDING_DELETE_VERIFIED_NAME = "verified"
/** WG10 req 1.9: private directories one startup sweep acts on at most (the rest are left, counted). */
export const RECORDING_DELETE_SWEEP_MAX_DIRS = 64
/** WG10 req 1.5: merge aliases one discovery holds at most (the oldest is released beyond). */
export const DISCOVERY_RECORDING_ALIASES_MAX = 64

/** WG10 req 1.8: totals of the keep store (bytes as stored at Keep time). */
export interface RecordingKeepTotals {
	recordings: number
	bytes: number
}

/** WG10 req 1.8: what the storage report reads; `totals()` is null unless the state is `ready`. */
export interface RecordingKeepTotalsSource {
	state(): "loading" | "ready" | "failed"
	totals(): RecordingKeepTotals | null
}

/**
 * WG10 req 1.1-1.3: the scanner side of a `scan:` delete, called by the keep service under the
 * key's mutex with the key marked deleting. `stillDeletable()` is the deletion decision for this
 * key (false while kept or the store is not ready); the deleter calls it in the same synchronous
 * turn as its unlink and deletes nothing when it answers false. Resolves `deleted` (file unlinked;
 * bookkeeping attempted after) or `not-found` (no such verified file, or it changed). Throws
 * `RecordingKeepError` `RECORDING_DELETE_UNSUPPORTED` (analog recording, not scanner-owned) or
 * `RECORDING_BUSY` (the discovery is being removed); any other error is a 500 for the caller.
 */
export interface ScannerRecordingDeleter {
	deleteRecording(
		recordingId: string,
		stillDeletable: () => boolean,
	): Promise<"deleted" | "not-found">
}

/** WG10 req 1.9: counts of one startup sweep of delete leftovers (never names or paths). */
export interface RecordingDeleteSweepResult {
	/** Private directories found (bounded by RECORDING_DELETE_SWEEP_MAX_DIRS acted on). */
	found: number
	/** `verified` entries unlinked. */
	deleted: number
	/** Unverified (or now protected) entries put back under their name. */
	restored: number
	/** Empty private directories removed. */
	removedEmpty: number
	/** Directories left in place (not provably ours, unexpected content, taken name, over the bound). */
	left: number
}
