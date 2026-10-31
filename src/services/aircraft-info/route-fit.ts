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

/** Without a position or a course nothing contradicts the route, so it fits. */
export function routePlausible(
	route: Pick<AircraftRoute, "origin" | "destination">,
	aircraft: Pick<AircraftState, "position" | "velocity">,
): boolean {
	const at = aircraft.position
	const course = aircraft.velocity?.track ?? aircraft.velocity?.trueHeading
	if (!at || course === undefined || !Number.isFinite(course)) return true
	const { origin, destination } = route
	return routeFits({
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
	})
}

/** Degrees between a course and a bearing, 0 to 180. */
export function offCourseDeg(bearingDeg: number, courseDeg: number): number {
	return Math.abs(((bearingDeg - courseDeg + 540) % 360) - 180)
}

/**
 * The verdict from measured distances and angle: within either slack (strictly closer than it)
 * any heading fits; elsewhere the course may be at most ROUTE_MAX_OFF_COURSE_DEG off.
 */
export function routeFits(m: {
	fromOriginM: number
	toDestinationM: number
	offCourseDeg: number
}): boolean {
	if (m.fromOriginM < ROUTE_ORIGIN_SLACK_M) return true
	if (m.toDestinationM < ROUTE_DESTINATION_SLACK_M) return true
	return m.offCourseDeg <= ROUTE_MAX_OFF_COURSE_DEG
}
