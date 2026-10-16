/**
 * WG4 frozen contract for lane D (docs/specs/web-gaps-4, requirement 2, design "Approximate
 * station location"). Read-only for the lane: the estimator and route consume these names.
 */
import type {
	AircraftState,
	AprsStation,
	MeshNode,
	StationEstimate,
	VesselState,
} from "@wavekit/api-types"

/** Weight of one contributing entity, by fleet and how directly it was heard. */
export const STATION_ESTIMATE_WEIGHTS = {
	/** Mesh node heard directly: hopsAway 0 and not via MQTT. */
	meshDirect: 4,
	/** Mesh node heard over RF through relays (hopsAway > 0 or unknown, not via MQTT). */
	meshRelayed: 1,
	/** APRS station (kind "station") heard without a digipeater. */
	aprsDirect: 2,
	/** APRS station heard through a digipeater. Objects and items never contribute. */
	aprsRelayed: 1,
	vessel: 1,
	aircraft: 1,
} as const
/** Mesh nodes last heard via MQTT never contribute (they can be anywhere). */
export const STATION_ESTIMATE_MQTT_WEIGHT = 0
/** Available with at least this many contributing entities ... */
export const STATION_ESTIMATE_MIN_ENTITIES = 10
/** ... or at least this many direct (weight 4 or 2) entities. */
export const STATION_ESTIMATE_MIN_DIRECT = 3
/** Contributors beyond this are dropped oldest position first. */
export const STATION_ESTIMATE_MAX_POINTS = 8_000
/** Weiszfeld iterations on the unit sphere. */
export const STATION_ESTIMATE_MAX_ITERATIONS = 50
/** Positions older than this (by their own time) do not contribute. */
export const STATION_ESTIMATE_MAX_POSITION_AGE_MS = 4 * 60 * 60 * 1000

/**
 * Snapshot getters Main injects (pull model, read on request only). A getter that is absent
 * or throws skips that fleet. The trackers are never imported by value.
 */
export interface StationEstimateSources {
	aircraft?: () => readonly AircraftState[]
	vessels?: () => readonly VesselState[]
	aprs?: () => readonly AprsStation[]
	mesh?: () => readonly MeshNode[]
	/** Configured station lat and lon both set (any provenance). */
	stationConfigured: () => boolean
	now?: () => number
}

/** Cached for STATION_ESTIMATE_CACHE_MS; concurrent calls share one computation. */
export interface StationEstimateProvider {
	estimate(): Promise<StationEstimate>
}
