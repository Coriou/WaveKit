import type { BandRegion } from "./decoders.js"

/**
 * Where a station field's value comes from. Precedence env > yaml > ui > default. `ui` is the
 * persisted operator layer written by PATCH /api/station (WG4, docs/specs/web-gaps-4,
 * requirement 6); env and yaml values pin a field against UI writes.
 */
export type StationProvenance = "default" | "yaml" | "env" | "ui"
export interface StationValue<T> {
	readonly value: T | null
	readonly provenance: StationProvenance
}
/** Explicit operator identity; coordinates never determine country or region. */
export interface StationIdentity {
	readonly name: StationValue<string>
	readonly lat: StationValue<number>
	readonly lon: StationValue<number>
	readonly altM: StationValue<number>
	readonly callsign: StationValue<string>
	readonly country: StationValue<string>
	readonly effectiveCountry: string | null
	readonly region: BandRegion
	/** WG4: revision of the persisted UI layer (0 when none); send it as If-Match. */
	readonly revision?: number
	/** WG4: whether PATCH /api/station is mounted for this deployment. */
	readonly writable?: boolean
}

/** WG4: the station fields an operator may set. */
export type StationField =
	| "name"
	| "lat"
	| "lon"
	| "altM"
	| "callsign"
	| "country"
export const STATION_FIELDS: readonly StationField[] = [
	"name",
	"lat",
	"lon",
	"altM",
	"callsign",
	"country",
]

/**
 * WG4 PATCH /api/station body. A present key sets the UI value (validated like the YAML
 * `station` block); null clears it; an absent key is unchanged. `lat` and `lon` are set or
 * cleared together. At least one key.
 */
export interface StationUpdate {
	name?: string | null
	lat?: number | null
	lon?: number | null
	altM?: number | null
	callsign?: string | null
	country?: string | null
}

/** WG4 PATCH /api/station 200 body. */
export interface StationUpdateResult {
	station: StationIdentity
	revision: number
	/** Fields whose effective value changed, in STATION_FIELDS order. */
	changed: StationField[]
	/** Components that pick the change up at their next start (`readsb` when lat/lon changed). */
	appliesOnRestart: "readsb"[]
	/** Fields that only take effect after a WaveKit restart (`country`). */
	restartRequired: "country"[]
	/** The coverage map was cleared because the location moved more than 1 km or was cleared. */
	coverageCleared: boolean
}

export type StationErrorCode =
	| "STATION_UPDATE_INVALID"
	| "STATION_FIELD_PINNED"
	| "STATION_REVISION_MISMATCH"
	| "STATION_STORE_UNAVAILABLE"

/** WG4 PATCH /api/station error body (400, 409, 412, 503). */
export interface StationErrorBody {
	error: string
	code: StationErrorCode
	message: string
	/** 409: the pinned fields of the request; 400: the invalid fields when known. */
	fields?: StationField[]
}

/** WG4 approximate station location (docs/specs/web-gaps-4, requirement 2). */
export const STATION_ESTIMATE_ROUNDING_DEG = 0.05
export const STATION_ESTIMATE_MIN_UNCERTAINTY_KM = 10
export const STATION_ESTIMATE_UNCERTAINTY_STEP_KM = 5
export const STATION_ESTIMATE_CACHE_MS = 60_000

/** too-few-positions: below the entity thresholds; degenerate: no unique median (e.g. antipodal). */
export type StationEstimateUnavailableReason =
	| "too-few-positions"
	| "degenerate"

/** Entities that contributed, per fleet. */
export interface StationEstimateBasis {
	aircraft: number
	vessels: number
	aprs: number
	mesh: number
}

/**
 * GET /api/station/estimate. Derived from heard positions; never authoritative, never used by
 * coverage or decoders, computed whether or not a station location is configured.
 */
export interface StationEstimate {
	available: boolean
	/** Null when available. */
	reason: StationEstimateUnavailableReason | null
	/** Rounded to STATION_ESTIMATE_ROUNDING_DEG; null when unavailable. */
	lat: number | null
	lon: number | null
	/** Multiple of 5 km, at least 10 km; null when unavailable. */
	uncertaintyKm: number | null
	basis: StationEstimateBasis
	computedAt: string
	/** computedAt + STATION_ESTIMATE_CACHE_MS. */
	cachedUntil: string
	authoritative: false
	/** Configured station lat and lon both set (any provenance). */
	stationConfigured: boolean
}
