/**
 * Receiver coverage (WG3, docs/specs/web-gaps-3, requirement 7): the maximum range at which
 * ADS-B and AIS positions were received per 1-degree bearing from the configured station
 * location, over the last 24 hours. In-memory only; it starts empty after a restart.
 * GET /api/coverage.
 */

export type CoverageProtocol = "adsb" | "ais"

export const COVERAGE_PROTOCOLS: readonly CoverageProtocol[] = ["adsb", "ais"]
/** Bearing bucket width in degrees; 360 buckets, bucket b covers [b, b + 1). */
export const COVERAGE_BEARING_STEP_DEG = 1
/** Rolling window, in hourly buckets. */
export const COVERAGE_WINDOW_HOURS = 24
/** Positions farther than this from the station are rejected as implausible. */
export const COVERAGE_MAX_RANGE_M = 500_000
/** Positions older than this when observed are rejected. */
export const COVERAGE_MAX_POSITION_AGE_MS = 60_000

/** The farthest accepted position in one bearing bucket over the window. */
export interface CoverageSector {
	/** Bucket start, integer 0-359, degrees true from the station. */
	bearingDeg: number
	/** Great-circle distance in metres. */
	maxRangeM: number
	lat: number
	lon: number
	/** ISO time of that position. */
	at: string
}

export interface CoverageProtocolSummary {
	protocol: CoverageProtocol
	/** Only buckets with data, by bearingDeg ascending; at most 360. */
	sectors: CoverageSector[]
	/** Largest maxRangeM over the sectors; null when there are none. */
	maxRangeM: number | null
	/** Positions accepted inside the window. */
	accepted: number
}

/** Positions not counted, since start, by reason. */
export interface CoverageRejections {
	"invalid-position": number
	"too-far": number
	stale: number
	"no-station": number
}

export interface CoverageResponse {
	/** False when no station lat/lon is configured; protocols is then empty. */
	available: boolean
	reason?: "no-station-location"
	station: { lat: number; lon: number } | null
	windowHours: number
	bearingStepDeg: number
	protocols: CoverageProtocolSummary[]
	rejected: CoverageRejections
	timestamp: string
}
