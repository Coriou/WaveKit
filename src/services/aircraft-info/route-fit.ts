/**
 * Whether a planned route still fits what the aircraft is doing. The route belongs to the
 * callsign and comes from a crowd-sourced database, so it can be stale or wrong: it does not
 * fit when the aircraft flies away from the destination while already well clear of the origin,
 * when it flies low far from both airports (it is departing from or landing at a third one),
 * when it climbs out near the destination or descends near the origin (the callsign is flying
 * the return leg).
 *
 * @module src/services/aircraft-info/route-fit
 */

import type { AircraftRoute, AircraftState } from "@wavekit/api-types"
import { haversineM, initialBearingDeg } from "../../core/coverage/geo.js"

/** Near the origin any heading fits: departures turn, climb out and hold (80 km). */
export const ROUTE_ORIGIN_SLACK_M = 80_000
/** Near the destination any heading fits: approaches, holds and go-arounds (30 km). */
export const ROUTE_DESTINATION_SLACK_M = 30_000
/**
 * Most a course may differ from the bearing to the destination. 100° allows a dog-leg along
 * airways and a great circle drawn from far away, and rejects flying away (more than 90° off).
 */
export const ROUTE_MAX_OFF_COURSE_DEG = 100

/**
 * Hysteresis around the off-course bound, so a verdict does not flap while an aircraft
 * turns or its track jitters near 100°: a fitting route stops fitting only past
 * 100 + 10 = 110° off, and a route that did not fit fits again only at 100 - 10 = 90° or
 * less. The 20° band is several times the few degrees an ADS-B track wanders in level
 * flight.
 */
export const ROUTE_OFF_COURSE_MARGIN_DEG = 10
/**
 * Hysteresis around both slacks: a fitting route stops fitting only beyond slack + 5 km
 * (origin 85 km, destination 35 km), and one that did not fit fits again within
 * slack - 5 km (origin 75 km, destination 25 km). 5 km is about 20 s at 250 m/s, so an
 * aircraft holding or turning on a slack edge keeps its verdict.
 */
export const ROUTE_SLACK_MARGIN_M = 5_000

/**
 * Below this an aircraft is climbing out of or descending into an airport (10,000 ft: the
 * usual end of departure and start of arrival procedures).
 */
export const ROUTE_LOW_ALTITUDE_FT = 10_000
/**
 * A low aircraft farther than this from both route airports flies another route (120 km
 * covers a long approach or climb-out with vectors, about 40 nm).
 */
export const ROUTE_LOW_FAR_M = 120_000
/**
 * Hysteresis around the low-altitude bound: a fitting route stops fitting only below
 * 10,000 - 1,000 = 9,000 ft, and one that did not fit fits again only above 11,000 ft.
 */
export const ROUTE_ALTITUDE_MARGIN_FT = 1_000
/**
 * A vertical rate at least this steep (ft/min) is a climb-out or a descent, not level flight
 * or a gentle step (1,000 ft/min; a 3° approach at 140 kt is about 740 ft/min, so the
 * arrival rule needs a clear descent).
 */
export const ROUTE_PHASE_RATE_FPM = 1_000

/**
 * Without a position or a course nothing contradicts the route: the previous verdict
 * stands, or it fits. `previous` (the verdict shown now) applies the hysteresis margins;
 * absent, the plain bounds decide.
 */
export function routePlausible(
	route: Pick<AircraftRoute, "origin" | "destination">,
	aircraft: Pick<AircraftState, "position" | "velocity" | "altitude">,
	previous?: boolean,
): boolean {
	const at = aircraft.position
	const { origin, destination } = route
	if (at) {
		const phase = flightPhaseFits(
			{
				fromOriginM: haversineM(at.lat, at.lon, origin.lat, origin.lon),
				toDestinationM: haversineM(
					at.lat,
					at.lon,
					destination.lat,
					destination.lon,
				),
				altitudeFt: altitudeFtOf(aircraft.altitude),
				verticalRateFpm: verticalRateOf(aircraft.altitude),
			},
			previous,
		)
		if (!phase) return false
	}
	const course = aircraft.velocity?.track ?? aircraft.velocity?.trueHeading
	if (!at || course === undefined || !Number.isFinite(course))
		return previous ?? true
	return routeFits(
		{
			fromOriginM: haversineM(at.lat, at.lon, origin.lat, origin.lon),
			toDestinationM: haversineM(
				at.lat,
				at.lon,
				destination.lat,
				destination.lon,
			),
			offCourseDeg: offCourseDeg(
				initialBearingDeg(at.lat, at.lon, destination.lat, destination.lon),
				course,
			),
		},
		previous,
	)
}

/** Degrees between a course and a bearing, 0 to 180. */
export function offCourseDeg(bearingDeg: number, courseDeg: number): number {
	return Math.abs(((bearingDeg - courseDeg + 540) % 360) - 180)
}

/**
 * The verdict from measured distances and angle: within either slack (strictly closer than it)
 * any heading fits; elsewhere the course may be at most ROUTE_MAX_OFF_COURSE_DEG off. With a
 * previous verdict the bounds move by the margins, away from flipping it: a route that fit
 * keeps fitting until clearly outside (slacks + ROUTE_SLACK_MARGIN_M, bound +
 * ROUTE_OFF_COURSE_MARGIN_DEG), one that did not fit needs to be clearly inside to fit again.
 */
export function routeFits(
	m: {
		fromOriginM: number
		toDestinationM: number
		offCourseDeg: number
	},
	previous?: boolean,
): boolean {
	const sign = previous === undefined ? 0 : previous ? 1 : -1
	const slack = sign * ROUTE_SLACK_MARGIN_M
	if (m.fromOriginM < ROUTE_ORIGIN_SLACK_M + slack) return true
	if (m.toDestinationM < ROUTE_DESTINATION_SLACK_M + slack) return true
	return (
		m.offCourseDeg <=
		ROUTE_MAX_OFF_COURSE_DEG + sign * ROUTE_OFF_COURSE_MARGIN_DEG
	)
}

function finite(n: number | null | undefined): number | undefined {
	return typeof n === "number" && Number.isFinite(n) ? n : undefined
}

/** Feet: 0 on the ground, else barometric, else geometric; undefined when unknown. */
function altitudeFtOf(a: AircraftState["altitude"]): number | undefined {
	if (!a) return undefined
	if (a.onGround === true) return 0
	return finite(a.baro) ?? finite(a.geom)
}

function verticalRateOf(a: AircraftState["altitude"]): number | undefined {
	if (!a || a.onGround === true) return undefined
	return finite(a.baroRate) ?? finite(a.geomRate)
}

/**
 * The phase checks, from measured distances, altitude and vertical rate (unknown values
 * contradict nothing): a low aircraft must be near one of the route's airports; one climbing
 * out near the destination or descending near the origin flies the return leg. Both slacks and
 * the altitude bound move by their margins with a previous verdict, as in routeFits.
 */
export function flightPhaseFits(
	m: {
		fromOriginM: number
		toDestinationM: number
		altitudeFt: number | undefined
		verticalRateFpm: number | undefined
	},
	previous?: boolean,
): boolean {
	const sign = previous === undefined ? 0 : previous ? 1 : -1
	const alt = m.altitudeFt
	if (alt === undefined) return true
	const lowBound = ROUTE_LOW_ALTITUDE_FT - sign * ROUTE_ALTITUDE_MARGIN_FT
	if (alt >= lowBound) return true
	const slack = sign * ROUTE_SLACK_MARGIN_M
	const far = ROUTE_LOW_FAR_M + slack
	if (m.fromOriginM >= far && m.toDestinationM >= far) return false
	const rate = m.verticalRateFpm
	if (rate === undefined) return true
	const nearDestination = m.toDestinationM < ROUTE_DESTINATION_SLACK_M + slack
	const nearOrigin = m.fromOriginM < ROUTE_ORIGIN_SLACK_M + slack
	if (nearDestination && !nearOrigin && rate >= ROUTE_PHASE_RATE_FPM)
		return false
	if (nearOrigin && !nearDestination && rate <= -ROUTE_PHASE_RATE_FPM)
		return false
	return true
}
