// Positions aircraft reported over ACARS and VDL2 (the ACARS layer): an ADS-C report decoded by libacars, or
// the rough position a VDL2 link frame (XID) carries to 0.1°. They come from GET /api/activity/trails for the
// aviation-data category only, so they never join an ADS-B track: the aircraft said where it was, at a time,
// with its own accuracy, and the Map draws that apart from what readsb heard. Pure functions over the trails.
import type { TrailPoint } from "../../data/fleet-store.ts"
import { collection, type FeatureCollection } from "./features.ts"

/** Reports older than this leave the Map: the trails window the core answers by default (one hour). */
export const REPORTED_MAX_AGE_MS = 60 * 60_000

export interface ReportedPosition {
	/** The Activity entity key ("icao:0A0B01", "reg:N0WK01"). */
	readonly entityKey: string
	readonly lat: number
	readonly lon: number
	/** This browser's clock, ms. */
	readonly at: number
}

/** The latest report of each entity within the window, newest first. */
export function latestReports(
	trails: ReadonlyMap<string, readonly TrailPoint[]>,
	now: number,
	maxAgeMs: number = REPORTED_MAX_AGE_MS,
): ReportedPosition[] {
	const out: ReportedPosition[] = []
	for (const [entityKey, points] of trails) {
		let last: TrailPoint | undefined
		for (const p of points) if (!last || p.at >= last.at) last = p
		if (!last || now - last.at > maxAgeMs) continue
		out.push({ entityKey, lat: last.lat, lon: last.lon, at: last.at })
	}
	return out.sort((a, b) => b.at - a.at)
}

/** "N0WK01" for "reg:N0WK01", the key itself when it has no kind. */
export function reportedName(entityKey: string): string {
	const colon = entityKey.indexOf(":")
	return colon > 0 ? entityKey.slice(colon + 1) : entityKey
}

/** Whole minutes since the report, at least 0. */
export function reportAgeMin(at: number, now: number): number {
	return Math.max(0, Math.floor((now - at) / 60_000))
}

/** Points for the ACARS layer: `id` the entity key, `n` its name, `m` the age in minutes. */
export function reportedFeatures(
	list: readonly ReportedPosition[],
	now: number,
): FeatureCollection {
	return collection(
		list.map((r, i) => ({
			type: "Feature",
			id: i,
			properties: {
				id: r.entityKey,
				n: reportedName(r.entityKey),
				m: reportAgeMin(r.at, now),
			},
			geometry: { type: "Point", coordinates: [r.lon, r.lat] },
		})),
	)
}
