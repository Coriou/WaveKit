/**
 * WG4 frozen contract for lane S (docs/specs/web-gaps-4, requirement 3, design "Storage
 * report"). Read-only for the lane: the report builder and route consume these names.
 */
import type { Logger } from "../../utils/logger.js"
import type {
	StorageActivityRetention,
	StorageAreaId,
	StorageKeptSummary,
	StoragePartBounds,
	StorageReport,
	StorageScannerPartId,
} from "@wavekit/api-types"

/** Concurrent lstat/readdir calls of a direct scanStorageAreas call (its default). */
export const STORAGE_SCAN_FS_CONCURRENCY = 8

/**
 * Concurrent lstat/readdir calls of the background count: 2, half of libuv's default thread
 * pool of 4 (the image sets no UV_THREADPOOL_SIZE), so a count running for up to
 * STORAGE_COUNT_MAX_WALL_MS never fills the pool that recording and journal writes share. A
 * report's statfs is one more call outside it (reports share one build, so at most one): 3
 * pool threads at most, one always free. Counts are single-flight across their fs calls: a
 * count that hit its wall time on a stalled filesystem settles with its calls still pending,
 * and the next count starts only once they drain, so counts never hold more than 2 threads
 * together. Only a report's statfs that never answers stays outside this bound: each later
 * report may add one (only the count requested by the report whose statfs timed out takes one
 * call less).
 */
export const STORAGE_COUNT_FS_CONCURRENCY = 2

/**
 * Entries one background count may visit. The live scanner state holds about 31.5k files
 * (plus a few thousand folders); 200,000 leaves about 6x headroom. Its walk queue holds at
 * most this many pending paths, about 250 B each: 50 MB in the worst case (one flat folder).
 */
export const STORAGE_COUNT_MAX_ENTRIES = 200_000

/**
 * Wall time of one background count. Measured at STORAGE_COUNT_FS_CONCURRENCY (2) on a synthetic
 * 50,501-entry tree on a loaded host (load average 82 to 226): 6,400 to 7,500 entries/s (8,700 to
 * 9,800 at 8 calls in flight). At the slowest, 6,400 entries/s, 200,000 entries take about 31 s;
 * 60 s covers that with 1.9x margin, and a stalled filesystem frees the count after it. A request
 * never waits on a count longer than its own STORAGE_SCAN_MAX_WALL_MS budget.
 */
export const STORAGE_COUNT_MAX_WALL_MS = 60_000

/**
 * Oldest finished count a report serves as exact: 120 s, four report cache periods. A report
 * starts a refresh once the count is older than STORAGE_REPORT_CACHE_MS (30 s); that refresh
 * takes at most STORAGE_COUNT_MAX_WALL_MS (60 s); a report built just before it finishes is
 * shared for one more STORAGE_REPORT_CACHE_MS (30 s): 30 + 60 + 30 = 120 s while anyone asks.
 * An older count means nobody asked for a while or the refreshes failed: the report then waits
 * for the refresh within its STORAGE_SCAN_MAX_WALL_MS budget and, if it is still not done, marks
 * the areas it serves from the old count `stale`.
 */
export const STORAGE_COUNT_MAX_SERVE_AGE_MS = 120_000

/** One area Main configures. Paths are absolute and never returned by the API. */
export interface StorageAreaSource {
	id: StorageAreaId
	/** A directory or a single file; one area may list several (e.g. dsd-fme wavDirs). */
	paths: readonly string[]
	/** Configured cap in bytes; null when WaveKit does not cap the area. */
	capBytes: number | null
	/** Absolute paths inside `paths` that belong to another area and are not counted here. */
	exclude?: readonly string[]
	/**
	 * Splits the area's one root by its direct children: an entry named in a part's `names`
	 * counts in that part, every other entry (and the root's own files) in `fallback`. Only for
	 * an area with exactly one path; ignored otherwise. Each part is reported, found or not.
	 */
	parts?: {
		readonly parts: readonly StorageAreaPartSource[]
		readonly fallback: StorageAreaPartSource
	}
}

export interface StorageAreaPartSource {
	id: StorageScannerPartId
	/** Direct children of the area's root counted in this part (unused for the fallback). */
	names: readonly string[]
	bounds: StoragePartBounds
	/**
	 * The files `bounds.maxFiles` counts (by base name, regular files only): the prune's own unit.
	 * Absent: every file of the part.
	 */
	boundedFile?: RegExp
	/**
	 * The files `bounds.maxBytes` counts, by their path segments from the area's root (the part's
	 * own name first; regular files only): the cap's own unit, as its admission counts it. Absent:
	 * every byte of the part.
	 */
	boundedPath?: (rel: readonly string[]) => boolean
}

export interface StorageReportOptions {
	/** The filesystem reported is the one holding stateDir. */
	stateDir: string
	/**
	 * Ids unique. A function is evaluated at each scan (cache misses only), so areas
	 * follow runtime changes; a static list is validated at construction.
	 */
	areas: readonly StorageAreaSource[] | (() => readonly StorageAreaSource[])
	/** Activity limits and usage; null or throwing means `retention: null` on the activity area. */
	activityRetention?: () => StorageActivityRetention | null
	/**
	 * Scanner evidence minFreeDiskMb in bytes; null when the scanner is not configured.
	 * A function is evaluated at each scan, like `areas`.
	 */
	minFreeBytes: number | null | (() => number | null)
	/** WG10 req 1.8: the keep store summary; omitted or throwing means `kept: null`. */
	kept?: () => StorageKeptSummary | null
	now?: () => number
	/** Warns once when a count waits for an earlier count's stalled fs calls. */
	logger?: Logger
}

/**
 * Cached for STORAGE_REPORT_CACHE_MS; concurrent calls share one report. Sizes come from a
 * background count the report waits on within its budget, then serves from its last result.
 */
export interface StorageReportProvider {
	report(): Promise<StorageReport>
	/**
	 * Starts a background count now (at startup) without waiting for it, so the first report
	 * serves finished sizes; a no-op while one runs or a fresh one exists.
	 */
	warm?(): void
}
