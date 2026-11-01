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
/** Near the destination any heading fits: approaches, holds and go-arounds (30 km); a clear climb-out there is the return leg (see flightPhaseFits). */
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
 * The low-and-far rule applies only to routes at least this long (300 km): commuter and
 * island-hop sectors shorter than that cruise level below 10,000 ft, far from both ends.
 */
export const ROUTE_LOW_RULE_MIN_ROUTE_M = 300_000
/**
 * Low and far from both airports means "landing at or departing from a third airport" only
 * when the aircraft is on the ground or clearly climbing or descending (500 ft/min).
 */
export const ROUTE_LOW_RULE_MIN_RATE_FPM = 500
/**
 * A climb near the destination is the return leg only once it is clear of a missed approach:
 * above 5,000 ft or 15 km out (missed approaches level off lower, close to the runway).
 */
export const ROUTE_CLIMB_OUT_MIN_ALTITUDE_FT = 5_000
export const ROUTE_CLIMB_OUT_MIN_DISTANCE_M = 15_000
/**
 * Once a phase rule has rejected a route, a rate reversal clears it only when it is clear
 * (500 ft/min the other way): a climb-out that levels off or accelerates keeps its verdict.
 */
export const ROUTE_PHASE_CLEAR_RATE_FPM = 500
/**
 * The return-leg rules apply only to routes at least this long (200 km): on a shorter hop the
 * climb and the descent both happen within the airports' slacks.
 */
export const ROUTE_RETURN_LEG_MIN_ROUTE_M = 200_000

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
				routeM: haversineM(
					origin.lat,
					origin.lon,
					destination.lat,
					destination.lon,
				),
				altitudeFt: altitudeFtOf(aircraft.altitude),
				verticalRateFpm: verticalRateOf(aircraft.altitude),
				onGround: aircraft.altitude?.onGround === true,
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
 * contradict nothing):
 * - low and far: below 10,000 ft, more than 120 km from both airports of a route at least
 *   300 km long, and on the ground or climbing/descending at 500 ft/min or more → another route;
 * - climb-out at the destination: within its slack and closer to it than to the origin, climbing
 *   at 1,000 ft/min or more, above 5,000 ft or 15 km out → the return leg; a descent of
 *   1,000 ft/min or more within the origin slack and closer to the origin → the return leg too;
 *   on the ground at the destination always fits (arrived).
 * With a previous verdict the altitude and distance bounds move by their margins, as in
 * routeFits, and a rejected route stays rejected while the aircraft stays in the same situation:
 * low and far needs no rate any more, and a return-leg rejection clears only on a clear rate the
 * other way (500 ft/min), so level-offs and acceleration segments do not flip it.
 */
export function flightPhaseFits(
	m: {
		fromOriginM: number
		toDestinationM: number
		routeM: number
		altitudeFt: number | undefined
		verticalRateFpm: number | undefined
		onGround: boolean
	},
	previous?: boolean,
): boolean {
	const sign = previous === undefined ? 0 : previous ? 1 : -1
	const rejected = previous === false
	const alt = m.altitudeFt
	if (alt === undefined) return true
	const lowBound = ROUTE_LOW_ALTITUDE_FT - sign * ROUTE_ALTITUDE_MARGIN_FT
	if (alt >= lowBound) return true
	const slack = sign * ROUTE_SLACK_MARGIN_M
	const rate = m.verticalRateFpm
	const far = ROUTE_LOW_FAR_M + slack
	if (
		m.routeM >= ROUTE_LOW_RULE_MIN_ROUTE_M &&
		m.fromOriginM >= far &&
		m.toDestinationM >= far &&
		(rejected ||
			m.onGround ||
			(rate !== undefined && Math.abs(rate) >= ROUTE_LOW_RULE_MIN_RATE_FPM))
	)
		return false
	// each return-leg rule applies only on its own half of the route, so a short hop's normal
	// descent (still within the origin's 80 km) is never read as an arrival back at the origin
	if (m.routeM < ROUTE_RETURN_LEG_MIN_ROUTE_M) return true
	const closerToDestination = m.toDestinationM < m.fromOriginM
	const nearDestination =
		m.toDestinationM < ROUTE_DESTINATION_SLACK_M + slack && closerToDestination
	const nearOrigin =
		m.fromOriginM < ROUTE_ORIGIN_SLACK_M + slack && !closerToDestination
	// on the ground at the destination it has arrived
	if (nearDestination && m.onGround) return true
	if (nearDestination) {
		const clearOfMissedApproach =
			alt >= ROUTE_CLIMB_OUT_MIN_ALTITUDE_FT ||
			m.toDestinationM >= ROUTE_CLIMB_OUT_MIN_DISTANCE_M
		if (rejected) {
			if (rate === undefined || rate > -ROUTE_PHASE_CLEAR_RATE_FPM) return false
		} else if (
			rate !== undefined &&
			rate >= ROUTE_PHASE_RATE_FPM &&
			clearOfMissedApproach
		)
			return false
	}
	if (nearOrigin) {
		if (rejected) {
			if (rate === undefined || rate < ROUTE_PHASE_CLEAR_RATE_FPM) return false
		} else if (rate !== undefined && rate <= -ROUTE_PHASE_RATE_FPM) return false
	}
	return true
}
