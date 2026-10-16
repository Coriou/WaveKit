/** Mean Earth radius in metres (IUGG). */
export const EARTH_RADIUS_M = 6_371_000

const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

/** Great-circle distance in metres between two WGS84 points (haversine). */
export function haversineM(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
): number {
	const p1 = lat1 * DEG_TO_RAD
	const p2 = lat2 * DEG_TO_RAD
	const dp = p2 - p1
	const dl = (lon2 - lon1) * DEG_TO_RAD
	const sdp = Math.sin(dp / 2)
	const sdl = Math.sin(dl / 2)
	const a = sdp * sdp + Math.cos(p1) * Math.cos(p2) * sdl * sdl
	return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, a)))
}

/** Initial great-circle bearing from point 1 to point 2, degrees true in [0, 360). */
export function initialBearingDeg(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
): number {
	const p1 = lat1 * DEG_TO_RAD
	const p2 = lat2 * DEG_TO_RAD
	const dl = (lon2 - lon1) * DEG_TO_RAD
	const y = Math.sin(dl) * Math.cos(p2)
	const x =
		Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
	let deg = Math.atan2(y, x) * RAD_TO_DEG
	if (deg < 0) deg += 360
	if (deg >= 360 || deg === 0) deg = 0
	return deg
}
