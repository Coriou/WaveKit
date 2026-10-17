// Geodesy and units for the Map (pure). Great-circle on a 6371 km sphere, as the board.

const R_KM = 6371
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

export interface LatLon {
	readonly lat: number
	readonly lon: number
}

/** The point `km` from `p` on initial bearing `brg` (degrees true). */
export function destination(p: LatLon, brg: number, km: number): LatLon {
	const d = km / R_KM
	const b = rad(brg)
	const p1 = rad(p.lat)
	const l1 = rad(p.lon)
	const p2 = Math.asin(
		Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b),
	)
	const l2 =
		l1 +
		Math.atan2(
			Math.sin(b) * Math.sin(d) * Math.cos(p1),
			Math.cos(d) - Math.sin(p1) * Math.sin(p2),
		)
	return { lat: deg(p2), lon: ((deg(l2) + 540) % 360) - 180 }
}

export function distanceKm(a: LatLon, b: LatLon): number {
	const dp = rad(b.lat - a.lat)
	const dl = rad(b.lon - a.lon)
	const h =
		Math.sin(dp / 2) ** 2 +
		Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2
	return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial bearing from a to b, degrees true 0–360. */
export function bearing(a: LatLon, b: LatLon): number {
	const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat))
	const x =
		Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
		Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon))
	return (deg(Math.atan2(y, x)) + 360) % 360
}

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const

export function cardinal(brg: number): string {
	return CARDINALS[Math.round((((brg % 360) + 360) % 360) / 45) % 8] ?? "N"
}

/** "12.4 km NE" (one decimal under 10 km), as the selection panel's "From station". */
export function relativeText(from: LatLon, to: LatLon): string {
	const d = distanceKm(from, to)
	return `${d.toFixed(d < 10 ? 1 : 0)} km ${cardinal(bearing(from, to))}`
}

/** Kilometres per CSS pixel at a latitude and MapLibre zoom (512 px tiles). */
export function kmPerPx(lat: number, zoom: number): number {
	return (40_075.016_686 * Math.cos(rad(lat))) / (512 * 2 ** zoom)
}

const SCALE_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]

/** The longest round distance that fits in `maxPx`, and its length in pixels. */
export function scaleBar(
	kmPx: number,
	maxPx = 110,
): { km: number; px: number; text: string } {
	let km = SCALE_STEPS[0] ?? 0.1
	for (const s of SCALE_STEPS) if (s / kmPx <= maxPx) km = s
	const text = km < 1 ? `${Math.round(km * 1000)} m` : `${km} km`
	return { km, px: Math.round(km / kmPx), text }
}

export const fmtLat = (v: number) =>
	`${Math.abs(v).toFixed(4)}° ${v >= 0 ? "N" : "S"}`
export const fmtLon = (v: number) =>
	`${Math.abs(v).toFixed(4)}° ${v >= 0 ? "E" : "W"}`

/** Six-character Maidenhead locator (e.g. IN88jr). */
export function toLocator(lat: number, lon: number): string {
	const L = Math.min(359.9999, Math.max(0, lon + 180))
	const A = Math.min(179.9999, Math.max(0, lat + 90))
	const a =
		String.fromCharCode(65 + Math.floor(L / 20)) +
		String.fromCharCode(65 + Math.floor(A / 10))
	const b = String(Math.floor((L % 20) / 2)) + String(Math.floor(A % 10))
	const c =
		String.fromCharCode(97 + Math.floor((L % 2) * 12)) +
		String.fromCharCode(97 + Math.floor((A % 1) * 24))
	return a + b + c
}

/** Feet as the board labels them: FL from 10 000 ft, else rounded feet with a thin space. */
export function flText(ft: number): string {
	if (ft >= 10_000) return `FL${String(Math.round(ft / 100)).padStart(3, "0")}`
	const n = Math.round(ft / 100) * 100
	return `${n.toLocaleString("en-GB").replace(/,/g, " ")} ft`
}

/** A closed ring of `steps` points around `c` at `km` (GeoJSON order: [lon, lat]). */
export function circle(c: LatLon, km: number, steps = 96): [number, number][] {
	const out: [number, number][] = []
	for (let i = 0; i <= steps; i++) {
		const p = destination(c, (i / steps) * 360, km)
		out.push([p.lon, p.lat])
	}
	return out
}
