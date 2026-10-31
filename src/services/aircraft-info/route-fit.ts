/**
 * Whether a planned route still fits what the aircraft is doing. The route belongs to the
 * callsign and comes from a crowd-sourced database, so it can be stale or wrong: it does not
 * fit when the aircraft flies away from the destination while already well clear of the origin.
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
 * Without a position or a course nothing contradicts the route: the previous verdict
 * stands, or it fits. `previous` (the verdict shown now) applies the hysteresis margins;
 * absent, the plain bounds decide.
 */
export function routePlausible(
	route: Pick<AircraftRoute, "origin" | "destination">,
	aircraft: Pick<AircraftState, "position" | "velocity">,
	previous?: boolean,
): boolean {
	const at = aircraft.position
	const course = aircraft.velocity?.track ?? aircraft.velocity?.trueHeading
	if (!at || course === undefined || !Number.isFinite(course))
		return previous ?? true
	const { origin, destination } = route
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
