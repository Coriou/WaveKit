import type {
	ActivityRetentionPolicy,
	ActivityRetentionShare,
} from "./activity.js"

/**
 * WG4 storage report (docs/specs/web-gaps-4, requirement 3): GET /api/storage. Sizes of the
 * directories and files WaveKit writes, without their paths. It reports the configured caps and
 * retention; it never shortens retention by itself.
 */

export type StorageAreaId =
	| "activity"
	| "scanner-evidence"
	| "iq-captures"
	| "digital-voice-wav"
	| "bandplans"
	| "operator-data"
	| "access"
	| "decoder-overrides"
	| "station"
	| "logs"
export const STORAGE_AREA_IDS: readonly StorageAreaId[] = [
	"activity",
	"scanner-evidence",
	"iq-captures",
	"digital-voice-wav",
	"bandplans",
	"operator-data",
	"access",
	"decoder-overrides",
	"station",
	"logs",
]

/**
 * automatic: WaveKit bounds it (caps, age); state: small operator state, never pruned;
 * other: grows without WaveKit pruning (operator-managed).
 */
export type StorageAreaClass = "automatic" | "state" | "other"
export const STORAGE_AREA_CLASS: Readonly<
	Record<StorageAreaId, StorageAreaClass>
> = {
	activity: "automatic",
	"scanner-evidence": "automatic",
	"iq-captures": "automatic",
	"digital-voice-wav": "other",
	bandplans: "state",
	"operator-data": "state",
	access: "state",
	"decoder-overrides": "state",
	station: "state",
	logs: "other",
}

/** Why an area's totals are lower bounds. */
export type StoragePartialReason =
	| "entry-limit"
	| "depth-limit"
	| "time-limit"
	| "permission"
	| "io-error"

/** Bounds of one report (all areas share them). */
export const STORAGE_SCAN_MAX_ENTRIES = 50_000
export const STORAGE_SCAN_MAX_DEPTH = 16
export const STORAGE_SCAN_MAX_WALL_MS = 2_000
export const STORAGE_REPORT_CACHE_MS = 30_000

export interface StorageFilesystem {
	totalBytes: number
	freeBytes: number
	/** Available to WaveKit's user (statfs bavail × bsize). */
	availableBytes: number
}

/** Activity store limits and usage (from the store's own stats, not the scan). */
export interface StorageActivityRetention {
	policy: ActivityRetentionPolicy
	/** Null when the store does not report it. */
	effective: ActivityRetentionPolicy | null
	maxRows: number
	maxDbBytes: number
	maxAgeMs: number
	rows: number | null
	oldestReceivedAt: string | null
	/** At most 64, rows descending then key ascending (as in ActivityStoreStats.retention). */
	shares: readonly ActivityRetentionShare[]
	sharesTruncated: boolean
}

export interface StorageArea {
	id: StorageAreaId
	class: StorageAreaClass
	/** Apparent size (lstat size) of regular files; symlinks are counted, not followed. */
	bytes: number
	files: number
	exists: boolean
	/** A bound or an error stopped the scan; bytes and files are lower bounds. */
	partial: boolean
	partialReason: StoragePartialReason | null
	/** Configured size cap; null when WaveKit does not cap the area. */
	cap: { bytes: number } | null
	/** Activity only; null for every other area. */
	retention: StorageActivityRetention | null
	/**
	 * `scanner-evidence` only: the same bytes and files split by the scanner storage folder that
	 * holds them, in STORAGE_SCANNER_PART_IDS order; their sums equal the area's. Lower bounds
	 * too when the area is partial. Absent on other areas and from older cores.
	 */
	parts?: readonly StorageAreaPart[]
}

/**
 * The scanner storage folders a `scanner-evidence` area is split into: `recordings` (the
 * recording files and the analog operations' metadata, `.analog-operations`), `quarantine`
 * (reversible noise discards), `journal` (observation journal), `captures` (burst IQ),
 * `evidence` (per-discovery spectra and IQ snippets), `engine` (learned receiver state) and
 * `other` (state files at the root and anything else).
 */
export type StorageScannerPartId =
	| "recordings"
	| "quarantine"
	| "journal"
	| "captures"
	| "evidence"
	| "engine"
	| "other"
export const STORAGE_SCANNER_PART_IDS: readonly StorageScannerPartId[] = [
	"recordings",
	"quarantine",
	"journal",
	"captures",
	"evidence",
	"engine",
	"other",
]

/** What bounds one part (each null when nothing bounds it that way, or the scanner is off). */
export interface StoragePartBounds {
	maxBytes: number | null
	/** Files older than this are removed. */
	maxAgeMs: number | null
	/** Counted in the prune's own unit (StorageAreaPart.boundedFiles), not in raw files. */
	maxFiles: number | null
}

export interface StorageAreaPart {
	id: StorageScannerPartId
	bytes: number
	files: number
	/** The part's folder exists (`other`: anything outside the named folders was found). */
	exists: boolean
	/**
	 * The files counted against `bounds.maxFiles`, in the unit its prune counts: for `quarantine`
	 * its quarantined WAVs (each entry is a WAV and its JSON sidecar, so about half of `files`);
	 * equal to `files` for every other part. Absent from older cores.
	 */
	boundedFiles?: number
	bounds: StoragePartBounds
	/**
	 * bytes > maxBytes or boundedFiles > maxFiles (exactly at a bound is within it). Null when
	 * neither bound is set or the area is partial (its totals are lower bounds).
	 */
	overBound: boolean | null
}

export type StorageLowSpaceState = "ok" | "low" | "unknown"

/** WG10 req 1.8: kept recordings while the keep store is ready (bytes at their size when kept). */
export interface StorageKeptReady {
	state: "ready"
	recordings: number
	bytes: number
	/** RECORDING_KEEPS_MAX_ENTRIES */
	maxRecordings: number
	/** RECORDING_KEEPS_MAX_BYTES */
	maxBytes: number
}
/** WG10 req 1.8: the keep store is loading or failed (every recording protected); no counts. */
export interface StorageKeptUnavailable {
	state: "loading" | "failed"
}
export type StorageKeptSummary = StorageKeptReady | StorageKeptUnavailable

export interface StorageReport {
	generatedAt: string
	/** generatedAt + STORAGE_REPORT_CACHE_MS; requests before it share this report. */
	cachedUntil: string
	/** Of the state directory; null when statfs failed. */
	filesystem: StorageFilesystem | null
	/** Configured areas, in STORAGE_AREA_IDS order. */
	areas: readonly StorageArea[]
	/**
	 * WG10 req 1.8: the recording keep store; null when no keep service is wired (legacy mode).
	 * No filesystem access: totals as stored at Keep time.
	 */
	kept: StorageKeptSummary | null
	lowSpace: {
		/** The only low-space behaviour: scanner evidence stops writing below minFreeBytes. */
		policy: "scanner-evidence-stops-writing"
		minFreeBytes: number | null
		/** low when filesystem.availableBytes < minFreeBytes; unknown without either. */
		state: StorageLowSpaceState
	}
}
