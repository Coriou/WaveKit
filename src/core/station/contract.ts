/**
 * WG4 frozen contract for lane ST (docs/specs/web-gaps-4, requirement 6, design "Station write
 * layer"). Read-only for the lane: the store, service and route consume these names.
 */
import type { Config } from "../../config.js"
import type { Logger } from "../../utils/logger.js"
import type {
	StationField,
	StationIdentity,
	StationUpdate,
	StationUpdateResult,
} from "@wavekit/api-types"

/**
 * PATCH /api/station is mounted only with the access controller (protected mode) while this is
 * true. False mounts it in legacy mode too, without an authorization hook. Flipping it is a
 * one-line change; tests are parameterised over both values.
 */
export const STATION_WRITE_REQUIRES_ACCESS = true

/** `<stateDir>/station.json`. */
export const STATION_STORE_FILE = "station.json"
export const STATION_STORE_SCHEMA_VERSION = 1
/** A larger file is treated as corrupt. */
export const STATION_STORE_MAX_BYTES = 4096
/** At most one `station.json.corrupt-<ms>` is kept. */
export const STATION_STORE_CORRUPT_KEEP = 1
/** A move farther than this (or a cleared location) clears the coverage map. */
export const STATION_COVERAGE_RESET_M = 1_000

/** One persisted UI value (value plus provenance, so a future settings store can absorb it). */
export interface StationStoredValue {
	value: string | number
	provenance: "ui"
	/** ISO time of the write. */
	updatedAt: string
}

export interface StationStoreFile {
	schemaVersion: typeof STATION_STORE_SCHEMA_VERSION
	/** Increments by one per successful write; 0 is "no file". */
	revision: number
	fields: Partial<Record<StationField, StationStoredValue>>
}

/** Live effective station: env > yaml > ui > default. */
export interface StationService {
	identity(): StationIdentity
	/** Effective lat/lon pair, or null when either is unset. */
	location(): { lat: number; lon: number } | null
	/**
	 * Validates, persists (tmp + fsync + rename), then applies. Writes are serialised.
	 * Throws StationUpdateError (400, 409, 412, 503) without changing state.
	 */
	update(
		patch: StationUpdate,
		options?: { ifMatch?: number },
	): Promise<StationUpdateResult>
	/** Called after each applied update with the new identity; returns an unsubscribe. */
	onChange(listener: (identity: StationIdentity) => void): () => void
	close(): Promise<void>
}

/** What `openStationService` (lane ST, `src/core/station/station-service.ts`) accepts. */
export interface StationServiceOptions {
	/** Loaded config: its `station` block and `stationOrigins(config)` are the env/yaml layers. */
	config: Config
	region: StationIdentity["region"]
	stateDir: string
	logger: Logger
	/** Whether PATCH is mounted (reported as `identity().writable`). */
	writable: boolean
	/**
	 * Applies a changed effective location (Main wires the coverage manager's `setStation`).
	 * Returns whether the coverage map was cleared. A throw is logged; the update still succeeds.
	 */
	onLocationChange?: (location: { lat: number; lon: number } | null) => {
		cleared: boolean
	}
	now?: () => number
}
