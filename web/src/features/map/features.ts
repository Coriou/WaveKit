// GeoJSON for the Map's own sources (pure): graticule, range rings, coverage, the approximate-station area, mesh
// links, trails (three fading segments, as the board) and the item markers.
import type { Coverage } from "../../data/index.ts"
import { circle, ringDistances, type LatLon } from "./geo.ts"
import type { MapItem } from "./items.ts"
import { glyphOf } from "./items.ts"
import { GRID_STEPS } from "./style.ts"

type Position = [number, number]
type Props = Record<string, string | number | boolean | null>
export interface Feature {
	type: "Feature"
	id?: number
	properties: Props
	geometry:
		| { type: "Point"; coordinates: Position }
		| { type: "LineString"; coordinates: Position[] }
		| { type: "MultiLineString"; coordinates: Position[][] }
		| { type: "Polygon"; coordinates: Position[][] }
}
export interface FeatureCollection {
	type: "FeatureCollection"
	features: Feature[]
}

export const collection = (features: Feature[]): FeatureCollection => ({
	type: "FeatureCollection",
	features,
})

/** Graticule lines around a centre for every step (each layer shows its step at its zooms). */
export function graticule(c: LatLon): FeatureCollection {
	const out: Feature[] = []
	for (const { step } of GRID_STEPS) {
		// enough lines to cover the view at the zooms where the step shows
		const span = Math.min(180, step * 40)
		const lon0 = Math.floor((c.lon - span) / step) * step
		const lat0 = Math.max(-80, Math.floor((c.lat - span / 2) / step) * step)
		const lat1 = Math.min(80, c.lat + span / 2)
		const lines: Position[][] = []
		for (let lon = lon0; lon <= c.lon + span; lon += step)
			lines.push([
				[lon, lat0],
				[lon, lat1],
			])
		for (let lat = lat0; lat <= lat1; lat += step)
			lines.push([
				[lon0, lat],
				[c.lon + span, lat],
			])
		out.push({
			type: "Feature",
			properties: { s: step },
			geometry: { type: "MultiLineString", coordinates: lines },
		})
	}
	return collection(out)
}

export function rings(station: LatLon | null): FeatureCollection {
	if (!station) return collection([])
	return collection(
		ringDistances().map(({ km }) => ({
			type: "Feature",
			properties: { km },
			geometry: { type: "LineString", coordinates: circle(station, km, 128) },
		})),
	)
}

/** One polygon per protocol, through the farthest position of each bearing bucket in bearing order. */
export function coverageShapes(c: Coverage | null): FeatureCollection {
	if (!c?.available) return collection([])
	const out: Feature[] = []
	for (const p of c.protocols) {
		if (p.sectors.length < 3) continue
		const ring: Position[] = [...p.sectors]
			.sort((a, b) => a.bearingDeg - b.bearingDeg)
			.map(s => [s.lon, s.lat])
		const first = ring[0]
		if (first) ring.push(first)
		out.push({
			type: "Feature",
			properties: { p: p.protocol },
			geometry: { type: "Polygon", coordinates: [ring] },
		})
	}
	return collection(out)
}

/** The dashed amber area of an approximate station (the board's 18 km). */
export function approxArea(station: LatLon | null): FeatureCollection {
	if (!station) return collection([])
	return collection([
		{
			type: "Feature",
			properties: {},
			geometry: { type: "Polygon", coordinates: [circle(station, 18, 64)] },
		},
	])
}

export function links(
	list: readonly { a: LatLon; b: LatLon; snr: number | null }[],
): FeatureCollection {
	return collection(
		list.map(l => ({
			type: "Feature",
			properties: { snr: l.snr ?? -99 },
			geometry: {
				type: "LineString",
				coordinates: [
					[l.a.lon, l.a.lat],
					[l.b.lon, l.b.lat],
				],
			},
		})),
	)
}

/** How far back a trail reaches: aircraft 3 min, the rest 15 min (the board). */
export const TRAIL_SPAN_MS: Readonly<Record<MapItem["kind"], number>> = {
	aircraft: 3 * 60_000,
	vessel: 15 * 60_000,
	aton: 0,
	aprs: 15 * 60_000,
	mesh: 15 * 60_000,
}

const TRAIL_ALPHA = [0.5, 0.28, 0.1] as const

/**
 * A trail as three segments from the predicted head back over the span (newest the most opaque). Points come
 * from the item's trail (core track or positions seen since the page opened). Without a head the trail ends at
 * its newest point; trailHead() then draws the rest, so the body can be pushed less often than the markers.
 */
export function trailSegments(
	it: MapItem,
	head: LatLon | null,
	now: number,
	colour: string,
): Feature[] {
	const span = TRAIL_SPAN_MS[it.kind]
	if (span === 0 || it.trail.length === 0) return []
	const from = now - span
	const pts = it.trail.filter(p => p.at >= from)
	if (pts.length === 0) return []
	const line: { lon: number; lat: number; at: number }[] = head
		? [...pts, { lat: head.lat, lon: head.lon, at: now }]
		: pts
	const out: Feature[] = []
	for (let k = 0; k < 3; k++) {
		const t1 = now - (span * k) / 3
		const t0 = now - (span * (k + 1)) / 3
		const seg = line.filter(p => p.at >= t0 && p.at <= t1)
		// join to the next newer segment so the line has no gaps
		const newer = line.find(p => p.at > t1)
		const coords: Position[] = seg.map(p => [p.lon, p.lat])
		if (newer) coords.push([newer.lon, newer.lat])
		if (coords.length < 2) continue
		out.push({
			type: "Feature",
			properties: { c: colour, a: TRAIL_ALPHA[k] ?? 0.1 },
			geometry: { type: "LineString", coordinates: coords },
		})
	}
	return out
}

/** The trail's newest point within its span, where a body drawn without a head ends; null without one. */
export function trailEnd(it: MapItem, now: number): LatLon | null {
	const span = TRAIL_SPAN_MS[it.kind]
	const last = it.trail[it.trail.length - 1]
	return span > 0 && last && last.at >= now - span
		? { lat: last.lat, lon: last.lon }
		: null
}

/** The stretch from a trail body's end to the predicted head, drawn like the newest segment. */
export function trailHead(from: LatLon, head: LatLon, colour: string): Feature {
	return {
		type: "Feature",
		properties: { c: colour, a: TRAIL_ALPHA[0] },
		geometry: {
			type: "LineString",
			coordinates: [
				[from.lon, from.lat],
				[head.lon, head.lat],
			],
		},
	}
}

const DRAW_ORDER: Readonly<Record<MapItem["kind"], number>> = {
	mesh: 0,
	aprs: 1,
	aton: 2,
	vessel: 3,
	aircraft: 4,
}

/** Marker points: glyph `g`, rotation `r`, draw order `z` (aircraft on top, the selected item above all). */
export function markers(
	list: readonly { it: MapItem; at: LatLon }[],
	selected: string | null,
): FeatureCollection {
	return collection(
		list.map(({ it, at }, i) => {
			const { glyph, rotate } = glyphOf(it)
			return {
				type: "Feature",
				id: i,
				properties: {
					id: it.id,
					g: glyph,
					r: Math.round(rotate),
					z: it.id === selected ? 9 : DRAW_ORDER[it.kind],
				},
				geometry: { type: "Point", coordinates: [at.lon, at.lat] },
			}
		}),
	)
}
