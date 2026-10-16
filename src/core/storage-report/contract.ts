/**
 * WG4 frozen contract for lane S (docs/specs/web-gaps-4, requirement 3, design "Storage
 * report"). Read-only for the lane: the report builder and route consume these names.
 */
import type {
	StorageActivityRetention,
	StorageAreaId,
	StorageReport,
} from "@wavekit/api-types"

/** Concurrent lstat/readdir calls per report. */
export const STORAGE_SCAN_FS_CONCURRENCY = 8

/** One area Main configures. Paths are absolute and never returned by the API. */
export interface StorageAreaSource {
	id: StorageAreaId
	/** A directory or a single file; one area may list several (e.g. dsd-fme wavDirs). */
	paths: readonly string[]
	/** Configured cap in bytes; null when WaveKit does not cap the area. */
	capBytes: number | null
	/** Absolute paths inside `paths` that belong to another area and are not counted here. */
	exclude?: readonly string[]
}

export interface StorageReportOptions {
	/** The filesystem reported is the one holding stateDir. */
	stateDir: string
	/** In STORAGE_AREA_IDS order; ids unique. */
	areas: readonly StorageAreaSource[]
	/** Activity limits and usage; null or throwing means `retention: null` on the activity area. */
	activityRetention?: () => StorageActivityRetention | null
	/** Scanner evidence minFreeDiskMb in bytes; null when the scanner is not configured. */
	minFreeBytes: number | null
	now?: () => number
}

/** Cached for STORAGE_REPORT_CACHE_MS; concurrent calls share one scan. */
export interface StorageReportProvider {
	report(): Promise<StorageReport>
}
