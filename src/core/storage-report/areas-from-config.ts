/**
 * Pure mapping from the runtime configuration to the storage report inputs (WG4 req 3,
 * design "Main wiring"): the area table in STORAGE_AREA_IDS order and the Activity
 * retention block. Paths are resolved to absolute and never leave the core.
 */
import { join, resolve } from "node:path"
import type {
	StorageActivityRetention,
	StoragePartBounds,
} from "@wavekit/api-types"
import {
	DECODER_SETTINGS_FILE_NAME,
	IQ_CAPTURES_QUOTA_BYTES,
	RECORDING_KEEPS_FILE_NAME,
} from "@wavekit/api-types"
import type {
	ActivityRetentionPolicy,
	ActivityStoreStats,
} from "../activity/storage/contract.js"
import { resolveActivityLimits } from "../activity/storage/limits.js"
import type { ActivityRetentionOverrides } from "../activity/runtime.js"
import { BAND_OVERRIDE_FILE_NAME } from "../../decoders/band-override-store.js"
import { STATION_STORE_FILE } from "../station/contract.js"
import { BACKUPS_DIR } from "../state-backup.js"
import {
	NOISE_QUARANTINE_MAX_AGE_MS,
	NOISE_QUARANTINE_MAX_BYTES,
	NOISE_QUARANTINE_MAX_FILES,
	QUARANTINE_ROOT_DIR,
} from "../scanner/store/noise-quarantine.js"
import { ENGINE_DIR, JOURNAL_DIR } from "../scanner/store/persistence.js"
import type { StorageAreaSource } from "./contract.js"

const MiB = 1024 * 1024
const DAY_MS = 86_400_000
/**
 * A quarantined WAV (noise-quarantine.ts WAV_NAME: `<operation id>.wav`), the unit its prune
 * counts against NOISE_QUARANTINE_MAX_FILES; its `.json` sidecar rides with it, uncounted.
 */
const QUARANTINE_ENTRY_FILE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/

/**
 * Scanner storage folders the store writes with literal names: `recordings/` and `evidence/`
 * (evidence-store.ts), `.analog-operations/` (analog-operations.ts: the analog files' intent,
 * receipt and facts sidecar, counted with the recordings as the recordings cap counts them) and
 * `captures/` (scanner-service.ts CaptureStore dir).
 */
export const SCANNER_RECORDINGS_DIRS = ["recordings", ".analog-operations"]
export const SCANNER_EVIDENCE_DIR = "evidence"
export const SCANNER_CAPTURES_DIR = "captures"

/** Directory of the IQ capture route (`POST /api/iq-captures`) under the state dir. */
export const IQ_CAPTURES_DIR = "iq-captures"

/** Default per-call WAV directory of the dsd-fme adapter. */
export const DSD_FME_DEFAULT_RECORDING_DIR = "/app/decoded_calls"

/**
 * `scanner.storage` as the storage report reads it. The bounds other than maxRecordingsMb are
 * optional: a missing one reports that part's bound as null (unknown, never a guess).
 */
export interface StorageScannerCaps {
	dir: string | null
	maxRecordingsMb: number
	maxEvidenceMb?: number
	maxJournalMb?: number
	maxAgeDays?: number
	maxCapturesMb?: number
}

/** A positive count of `unit`, or null (missing, malformed). */
function scaled(value: number | undefined, unit: number): number | null {
	return value !== undefined && Number.isFinite(value) && value > 0
		? value * unit
		: null
}

const NO_BOUNDS: StoragePartBounds = {
	maxBytes: null,
	maxAgeMs: null,
	maxFiles: null,
}

/**
 * The scanner storage split (StorageArea.parts) with each folder's bounds: the scanner's own
 * caps (`scanner.storage`, MiB and days as its retention applies them) and the noise
 * quarantine's constants. With the scanner off nothing prunes, so every bound is null.
 */
export function scannerStorageParts(
	storage: StorageScannerCaps,
	enabled: boolean,
): NonNullable<StorageAreaSource["parts"]> {
	const on = (bounds: StoragePartBounds): StoragePartBounds =>
		enabled ? bounds : NO_BOUNDS
	const maxAgeMs = scaled(storage.maxAgeDays, DAY_MS)
	return {
		parts: [
			{
				id: "recordings",
				names: SCANNER_RECORDINGS_DIRS,
				// evidence-store.ts retention: maxRecordingsMb, and maxAgeDays for every file.
				bounds: on({
					maxBytes: scaled(storage.maxRecordingsMb, MiB),
					maxAgeMs,
					maxFiles: null,
				}),
			},
			{
				id: "quarantine",
				names: [QUARANTINE_ROOT_DIR],
				// noise-quarantine.ts prune counts entries: a WAV (its WAV_NAME) with its JSON sidecar.
				boundedFile: QUARANTINE_ENTRY_FILE,
				bounds: on({
					maxBytes: NOISE_QUARANTINE_MAX_BYTES,
					maxAgeMs: NOISE_QUARANTINE_MAX_AGE_MS,
					maxFiles: NOISE_QUARANTINE_MAX_FILES,
				}),
			},
			{
				id: "journal",
				names: [JOURNAL_DIR],
				// persistence.ts pruneJournal({ maxBytes: maxJournalMb MiB, maxAgeDays }).
				bounds: on({
					maxBytes: scaled(storage.maxJournalMb, MiB),
					maxAgeMs,
					maxFiles: null,
				}),
			},
			{
				id: "captures",
				names: [SCANNER_CAPTURES_DIR],
				// CaptureStore.retention(maxCapturesMb MiB).
				bounds: on({
					maxBytes: scaled(storage.maxCapturesMb, MiB),
					maxAgeMs: null,
					maxFiles: null,
				}),
			},
			{
				id: "evidence",
				names: [SCANNER_EVIDENCE_DIR],
				bounds: on({
					maxBytes: scaled(storage.maxEvidenceMb, MiB),
					maxAgeMs,
					maxFiles: null,
				}),
			},
			// Learned receiver state: nothing prunes it by size or age.
			{ id: "engine", names: [ENGINE_DIR], bounds: NO_BOUNDS },
		],
		fallback: { id: "other", names: [], bounds: NO_BOUNDS },
	}
}

export interface StorageAreaInputs {
	stateDir: string
	/** Resolved Activity `maxDbBytes`; null when unknown. */
	activityMaxDbBytes: number | null
	/** `scanner.storage`: `dir` null means `<stateDir>/scanner`. */
	scannerStorage: StorageScannerCaps
	/** False when the scanner is not running: its area then reports no cap. Default true. */
	scannerEnabled?: boolean
	/** Configured decoders; every `dsd-fme` instance that records contributes its dir. */
	decoders: readonly {
		type: string
		options?: Record<string, unknown> | undefined
	}[]
	/** Private access directory in protected mode; null or empty omits the area. */
	accessDirectory: string | null
	/** `logging.dir`; unset omits the area. */
	logsDir?: string | undefined
}

function optionString(
	options: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = options?.[key]
	return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * The absolute per-call WAV directory a dsd-fme decoder writes, or null when it does not
 * record. Mirrors the adapter: `output: wav` uses `wavDir`, else `perCallRecordingDir`;
 * `enablePerCallRecording` uses `perCallRecordingDir`; both default to /app/decoded_calls.
 */
export function dsdFmeRecordingDir(
	options: Record<string, unknown> | undefined,
): string | null {
	const perCall =
		optionString(options, "perCallRecordingDir") ??
		DSD_FME_DEFAULT_RECORDING_DIR
	if (options?.["output"] === "wav")
		return resolve(optionString(options, "wavDir") ?? perCall)
	if (options?.["enablePerCallRecording"] === true) return resolve(perCall)
	return null
}

/**
 * Storage areas in STORAGE_AREA_IDS order. Overlapping roots (a directory inside another
 * area's, or one recording dir inside another) are resolved by real path at each scan
 * (`disjointStorageAreas`), so each file is counted in one area.
 */
export function storageAreasFromConfig(
	inputs: StorageAreaInputs,
): StorageAreaSource[] {
	const stateDir = resolve(inputs.stateDir)
	const scannerDir = resolve(
		inputs.scannerStorage.dir ?? join(stateDir, "scanner"),
	)
	const wavDirs: string[] = []
	for (const decoder of inputs.decoders) {
		if (decoder.type !== "dsd-fme") continue
		const dir = dsdFmeRecordingDir(decoder.options)
		if (dir !== null && !wavDirs.includes(dir)) wavDirs.push(dir)
	}
	const areas: StorageAreaSource[] = [
		{
			id: "activity",
			paths: [join(stateDir, "activity")],
			capBytes: inputs.activityMaxDbBytes,
		},
		{
			id: "scanner-evidence",
			paths: [scannerDir],
			// Pre-migration backups (state-backup.ts): mostly hard links of the recordings counted
			// here already, and no scanner retention ever removes them.
			exclude: [join(scannerDir, BACKUPS_DIR)],
			parts: scannerStorageParts(
				inputs.scannerStorage,
				inputs.scannerEnabled !== false,
			),
			capBytes:
				inputs.scannerEnabled === false
					? null
					: inputs.scannerStorage.maxRecordingsMb * MiB,
		},
		{
			// The IQ capture route's store; its quota refuses captures past this.
			id: "iq-captures",
			paths: [join(stateDir, IQ_CAPTURES_DIR)],
			capBytes: IQ_CAPTURES_QUOTA_BYTES,
		},
		{ id: "digital-voice-wav", paths: wavDirs, capBytes: null },
		{ id: "bandplans", paths: [join(stateDir, "bandplans")], capBytes: null },
		{
			id: "operator-data",
			// The WG9 recording keep store is operator state too (no new area id)
			paths: [
				join(stateDir, "operator-data"),
				join(stateDir, RECORDING_KEEPS_FILE_NAME),
			],
			capBytes: null,
		},
	]
	if (inputs.accessDirectory)
		areas.push({
			id: "access",
			paths: [resolve(inputs.accessDirectory)],
			capBytes: null,
		})
	areas.push(
		{
			id: "decoder-overrides",
			// Band overrides and the WG8 decoder settings store share the area (no new id)
			paths: [
				join(stateDir, BAND_OVERRIDE_FILE_NAME),
				join(stateDir, DECODER_SETTINGS_FILE_NAME),
			],
			capBytes: null,
		},
		{
			id: "station",
			paths: [join(stateDir, STATION_STORE_FILE)],
			capBytes: null,
		},
	)
	if (inputs.logsDir !== undefined && inputs.logsDir.length > 0)
		areas.push({ id: "logs", paths: [resolve(inputs.logsDir)], capBytes: null })
	return areas
}

/** The scanner storage settings a report reads (ScannerService.settings().storage). */
export interface StorageScannerStorage extends StorageScannerCaps {
	minFreeDiskMb: number
}

/** The running scanner as the storage report sees it. */
export interface StorageScannerView {
	settings(): { storage: StorageScannerStorage }
}

export interface LiveStorageAreaInputs extends Omit<
	StorageAreaInputs,
	"scannerStorage" | "scannerEnabled" | "decoders"
> {
	/** Configured `scanner.storage`; used while no scanner runs. */
	scannerStorage: StorageScannerStorage
	/** The scanner now; null when it is not running. Read at each scan. */
	scanner: () => StorageScannerView | null
	/**
	 * The decoder list, read at each scan: the decoder manager's current config-owned
	 * decoders (`getConfiguredDecoderConfigs`), so one created or removed after startup
	 * shows in the next report. Scanner probes are not listed (scanner storage covers them).
	 */
	decoders: () => StorageAreaInputs["decoders"]
}

/**
 * Area and low-space providers for the storage reporter, evaluated at each scan (the
 * reporter's cache bounds how often): a runtime scanner settings change (storage dir,
 * maxRecordingsMb, minFreeDiskMb) shows in the next report, as does a decoder created or
 * removed after startup.
 */
export function liveStorageReportSources(inputs: LiveStorageAreaInputs): {
	areas: () => StorageAreaSource[]
	minFreeBytes: () => number | null
} {
	const { scanner, decoders, scannerStorage, ...fixed } = inputs
	return {
		areas: () => {
			const running = scanner()
			return storageAreasFromConfig({
				...fixed,
				scannerStorage: running?.settings().storage ?? scannerStorage,
				scannerEnabled: running !== null,
				decoders: decoders(),
			})
		},
		minFreeBytes: () => {
			const running = scanner()
			return running === null
				? null
				: running.settings().storage.minFreeDiskMb * MiB
		},
	}
}

/** Resolved Activity limits the retention block reports. */
export interface StorageActivityLimits {
	retentionPolicy: ActivityRetentionPolicy
	maxRows: number
	maxDbBytes: number
	maxAgeMs: number
}

/**
 * The resolved Activity limits for the configured retention block, as the store resolves
 * them; null when they are invalid (Activity is then unavailable).
 */
export function storageActivityLimits(
	retention: ActivityRetentionOverrides | undefined,
): StorageActivityLimits | null {
	try {
		const resolved = resolveActivityLimits({
			...(retention?.maxRows !== undefined && { maxRows: retention.maxRows }),
			...(retention?.maxDbBytes !== undefined && {
				maxDbBytes: retention.maxDbBytes,
			}),
			...(retention?.maxAgeMs !== undefined && {
				maxAgeMs: retention.maxAgeMs,
			}),
			...(retention?.policy !== undefined && {
				retentionPolicy: retention.policy,
			}),
		})
		return {
			retentionPolicy: resolved.retentionPolicy,
			maxRows: resolved.maxRows,
			maxDbBytes: resolved.maxDbBytes,
			maxAgeMs: resolved.maxAgeMs,
		}
	} catch {
		return null
	}
}

/** Maps the Activity store stats and resolved limits to the report's retention block. */
export function activityRetentionFromStats(
	stats: ActivityStoreStats,
	limits: StorageActivityLimits,
): StorageActivityRetention {
	const retention = stats.retention
	return {
		policy: retention?.policy ?? limits.retentionPolicy,
		effective: retention?.effective ?? null,
		maxRows: limits.maxRows,
		maxDbBytes: limits.maxDbBytes,
		maxAgeMs: limits.maxAgeMs,
		rows: stats.rows,
		oldestReceivedAt: stats.oldestReceivedAt,
		shares: retention ? retention.shares.slice(0, 64) : [],
		sharesTruncated: retention?.sharesTruncated ?? false,
	}
}
