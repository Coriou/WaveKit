/**
 * Pure mapping from the runtime configuration to the storage report inputs (WG4 req 3,
 * design "Main wiring"): the area table in STORAGE_AREA_IDS order and the Activity
 * retention block. Paths are resolved to absolute and never leave the core.
 */
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import type { StorageActivityRetention } from "@wavekit/api-types"
import type {
	ActivityRetentionPolicy,
	ActivityStoreStats,
} from "../activity/storage/contract.js"
import { resolveActivityLimits } from "../activity/storage/limits.js"
import type { ActivityRetentionOverrides } from "../activity/runtime.js"
import { BAND_OVERRIDE_FILE_NAME } from "../../decoders/band-override-store.js"
import { STATION_STORE_FILE } from "../station/contract.js"
import type { StorageAreaSource } from "./contract.js"

const MiB = 1024 * 1024

/** Default per-call WAV directory of the dsd-fme adapter. */
export const DSD_FME_DEFAULT_RECORDING_DIR = "/app/decoded_calls"

export interface StorageAreaInputs {
	stateDir: string
	/** Resolved Activity `maxDbBytes`; null when unknown. */
	activityMaxDbBytes: number | null
	/** `scanner.storage`: `dir` null means `<stateDir>/scanner`. */
	scannerStorage: { dir: string | null; maxRecordingsMb: number }
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

/** `child` is `parent` or below it; a name such as `..calls` is still inside. */
export function isInside(child: string, parent: string): boolean {
	const rel = relative(parent, child)
	if (rel === "") return true
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Makes the areas count every file at most once (lexically: the scan never follows
 * symlinks). Inside one area a root below another of its roots is dropped. Across areas
 * a root of one area below a root of another is excluded from the outer area; when two
 * areas share a root, it is excluded from the earlier one, so the later area keeps it.
 */
function disjointAreas(areas: StorageAreaSource[]): StorageAreaSource[] {
	const collapsed = areas.map(area => {
		const unique = [...new Set(area.paths)]
		const paths = unique.filter(
			path => !unique.some(other => other !== path && isInside(path, other)),
		)
		return { area, paths }
	})
	return collapsed.map(({ area, paths }, index) => {
		const exclude = [...(area.exclude ?? [])]
		collapsed.forEach((other, otherIndex) => {
			if (otherIndex === index) return
			for (const inner of other.paths) {
				const covered = paths.some(path =>
					path === inner ? otherIndex > index : isInside(inner, path),
				)
				if (covered && !exclude.includes(inner)) exclude.push(inner)
			}
		})
		const { exclude: _previous, ...rest } = area
		return { ...rest, paths, ...(exclude.length > 0 ? { exclude } : {}) }
	})
}

/** Storage areas in STORAGE_AREA_IDS order. */
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
			capBytes:
				inputs.scannerEnabled === false
					? null
					: inputs.scannerStorage.maxRecordingsMb * MiB,
		},
		{ id: "digital-voice-wav", paths: wavDirs, capBytes: null },
		{ id: "bandplans", paths: [join(stateDir, "bandplans")], capBytes: null },
		{
			id: "operator-data",
			paths: [join(stateDir, "operator-data")],
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
			paths: [join(stateDir, BAND_OVERRIDE_FILE_NAME)],
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
	return disjointAreas(areas)
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
