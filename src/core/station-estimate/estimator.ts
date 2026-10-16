/**
 * WG4 lane D: pure approximate station location estimator (docs/specs/web-gaps-4,
 * requirement 2; design "Approximate station location (lane D)"). No I/O, no trackers: the
 * provider hands in snapshots and a clock.
 */
import type {
	AircraftState,
	AprsStation,
	MeshNode,
	StationEstimateBasis,
	StationEstimateUnavailableReason,
	VesselState,
} from "@wavekit/api-types"
import {
	STATION_ESTIMATE_MIN_UNCERTAINTY_KM,
	STATION_ESTIMATE_ROUNDING_DEG,
	STATION_ESTIMATE_UNCERTAINTY_STEP_KM,
} from "@wavekit/api-types"
import { haversineM } from "../coverage/geo.js"
import {
	STATION_ESTIMATE_MAX_ITERATIONS,
	STATION_ESTIMATE_MAX_POINTS,
	STATION_ESTIMATE_MAX_POSITION_AGE_MS,
	STATION_ESTIMATE_MIN_DIRECT,
	STATION_ESTIMATE_MIN_ENTITIES,
	STATION_ESTIMATE_WEIGHTS,
} from "./contract.js"

export type StationEstimateFleet = keyof StationEstimateBasis

export interface StationEstimatePoint {
	lat: number
	lon: number
	weight: number
	/** Epoch ms of the position, by the entity's own time. */
	at: number
	fleet: StationEstimateFleet
}

export interface StationEstimateSnapshots {
	aircraft?: readonly AircraftState[] | undefined
	vessels?: readonly VesselState[] | undefined
	aprs?: readonly AprsStation[] | undefined
	mesh?: readonly MeshNode[] | undefined
}

export interface StationEstimateContributors {
	points: StationEstimatePoint[]
	basis: StationEstimateBasis
	/** Kept contributors of weight 4 (direct mesh) or 2 (direct APRS). */
	direct: number
}

export interface WeightedPosition {
	lat: number
	lon: number
	weight: number
}

export interface StationEstimateUnavailable {
	available: false
	reason: StationEstimateUnavailableReason
}

export interface StationEstimateAvailable {
	available: true
	/** Rounded to STATION_ESTIMATE_ROUNDING_DEG. */
	lat: number
	/** Rounded, normalised to [-180, 180). */
	lon: number
	uncertaintyKm: number
	/** Unrounded geometric median. */
	rawLat: number
	rawLon: number
}

export type StationEstimateComputation =
	| StationEstimateUnavailable
	| StationEstimateAvailable

const DEG = Math.PI / 180
const RAD = 180 / Math.PI
const DEGENERATE_NORM = 1e-9
const COINCIDENT_CHORD = 1e-12
const CONVERGED_STEP_RAD = 1e-9

function validLatLon(lat: number, lon: number): boolean {
	return (
		Number.isFinite(lat) &&
		Number.isFinite(lon) &&
		lat >= -90 &&
		lat <= 90 &&
		lon >= -180 &&
		lon <= 180
	)
}

/**
 * APRS "direct" rule: a station is direct when no element of its `path` ends with `*` (the
 * TNC2 "has been used" marker, e.g. `W1AW*` in `K1ABC>APRS,W1AW*,WIDE2-2:`). An empty path is
 * direct. Note: the direwolf adapter reads KISS frames and `parseAx25Address` drops the
 * AX.25 H bit, so live paths never carry `*` today; such stations count as direct.
 */
export function isAprsDirect(path: readonly string[]): boolean {
	for (const element of path) if (element.endsWith("*")) return false
	return true
}

/** Collects weighted contributors from tracker snapshots (requirement 2.2, 2.9). */
export function collectContributors(
	snapshots: StationEstimateSnapshots,
	now: number,
): StationEstimateContributors {
	const minAt = now - STATION_ESTIMATE_MAX_POSITION_AGE_MS
	const points: StationEstimatePoint[] = []
	const push = (
		lat: number,
		lon: number,
		at: number,
		weight: number,
		fleet: StationEstimateFleet,
	): void => {
		if (weight <= 0 || !validLatLon(lat, lon)) return
		if (!Number.isFinite(at) || at < minAt) return
		points.push({ lat, lon, weight, at, fleet })
	}

	for (const a of snapshots.aircraft ?? []) {
		if (!a.position) continue
		const at =
			a.seenPos !== undefined ? a.lastUpdated - a.seenPos * 1000 : a.lastUpdated
		push(
			a.position.lat,
			a.position.lon,
			at,
			STATION_ESTIMATE_WEIGHTS.aircraft,
			"aircraft",
		)
	}
	for (const v of snapshots.vessels ?? []) {
		if (!v.position) continue
		push(
			v.position.lat,
			v.position.lon,
			Date.parse(v.position.at),
			STATION_ESTIMATE_WEIGHTS.vessel,
			"vessels",
		)
	}
	for (const s of snapshots.aprs ?? []) {
		if (s.kind !== "station" || !s.position) continue
		push(
			s.position.lat,
			s.position.lon,
			Date.parse(s.position.at),
			isAprsDirect(s.path)
				? STATION_ESTIMATE_WEIGHTS.aprsDirect
				: STATION_ESTIMATE_WEIGHTS.aprsRelayed,
			"aprs",
		)
	}
	for (const n of snapshots.mesh ?? []) {
		if (n.viaMqtt || !n.position) continue
		push(
			n.position.lat,
			n.position.lon,
			Date.parse(n.position.at),
			n.hopsAway === 0
				? STATION_ESTIMATE_WEIGHTS.meshDirect
				: STATION_ESTIMATE_WEIGHTS.meshRelayed,
			"mesh",
		)
	}

	let kept = points
	if (points.length > STATION_ESTIMATE_MAX_POINTS) {
		kept = points
			.sort((a, b) => b.at - a.at)
			.slice(0, STATION_ESTIMATE_MAX_POINTS)
	}
	const basis: StationEstimateBasis = {
		aircraft: 0,
		vessels: 0,
		aprs: 0,
		mesh: 0,
	}
	let direct = 0
	for (const p of kept) {
		basis[p.fleet]++
		if (isDirectWeight(p.weight)) direct++
	}
	return { points: kept, basis, direct }
}

function isDirectWeight(weight: number): boolean {
	return (
		weight === STATION_ESTIMATE_WEIGHTS.meshDirect ||
		weight === STATION_ESTIMATE_WEIGHTS.aprsDirect
	)
}

/**
 * Unrounded weighted geometric median on the unit sphere (Weiszfeld in R³ with chord
 * distances). Returns null when the weighted mean vector vanishes (degenerate). Longitude in
 * [-180, 180]. Weights must be positive.
 */
export function sphericalGeometricMedian(
	points: readonly WeightedPosition[],
): { lat: number; lon: number } | null {
	const n = points.length
	if (n === 0) return null
	const xs = new Float64Array(n)
	const ys = new Float64Array(n)
	const zs = new Float64Array(n)
	const ws = new Float64Array(n)
	let mx = 0
	let my = 0
	let mz = 0
	for (let i = 0; i < n; i++) {
		const p = points[i]!
		const phi = p.lat * DEG
		const lam = p.lon * DEG
		const c = Math.cos(phi)
		xs[i] = c * Math.cos(lam)
		ys[i] = c * Math.sin(lam)
		zs[i] = Math.sin(phi)
		ws[i] = p.weight
		mx += p.weight * xs[i]!
		my += p.weight * ys[i]!
		mz += p.weight * zs[i]!
	}
	let wsum = 0
	for (let i = 0; i < n; i++) wsum += ws[i]!
	// Degenerate when the weight-normalised mean vector is shorter than 1e-9.
	let norm = Math.hypot(mx, my, mz)
	if (!(norm / wsum >= DEGENERATE_NORM)) return null
	let x = mx / norm
	let y = my / norm
	let z = mz / norm

	for (let iter = 0; iter < STATION_ESTIMATE_MAX_ITERATIONS; iter++) {
		let nx = 0
		let ny = 0
		let nz = 0
		let den = 0
		for (let i = 0; i < n; i++) {
			const dx = x - xs[i]!
			const dy = y - ys[i]!
			const dz = z - zs[i]!
			const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
			if (d < COINCIDENT_CHORD) return toLatLon(xs[i]!, ys[i]!, zs[i]!)
			const f = ws[i]! / d
			nx += f * xs[i]!
			ny += f * ys[i]!
			nz += f * zs[i]!
			den += f
		}
		nx /= den
		ny /= den
		nz /= den
		norm = Math.hypot(nx, ny, nz)
		if (!(norm > 0)) break
		nx /= norm
		ny /= norm
		nz /= norm
		const chord = Math.hypot(nx - x, ny - y, nz - z)
		const step = 2 * Math.asin(Math.min(1, chord / 2))
		x = nx
		y = ny
		z = nz
		if (step < CONVERGED_STEP_RAD) break
	}
	return toLatLon(x, y, z)
}

function toLatLon(
	x: number,
	y: number,
	z: number,
): { lat: number; lon: number } {
	return {
		lat: Math.atan2(z, Math.hypot(x, y)) * RAD,
		lon: Math.atan2(y, x) * RAD,
	}
}

/** Rounds to STATION_ESTIMATE_ROUNDING_DEG, fixed to 2 decimals, never -0. */
export function roundEstimateDeg(value: number): number {
	const r = Number(
		(
			Math.round(value / STATION_ESTIMATE_ROUNDING_DEG) *
			STATION_ESTIMATE_ROUNDING_DEG
		).toFixed(2),
	)
	return r === 0 ? 0 : r
}

/** Rounds a longitude and normalises it to [-180, 180). */
export function roundEstimateLon(lon: number): number {
	let r = roundEstimateDeg(lon)
	while (r >= 180) r = roundEstimateDeg(r - 360)
	while (r < -180) r = roundEstimateDeg(r + 360)
	return r === 0 ? 0 : r
}

/** Weighted median of haversine distances (km) from (lat, lon), rounded up to the 5 km step, at least 10 km. */
export function estimateUncertaintyKm(
	lat: number,
	lon: number,
	points: readonly WeightedPosition[],
): number {
	const n = points.length
	const dist = new Float64Array(n)
	const order = new Uint32Array(n)
	let total = 0
	for (let i = 0; i < n; i++) {
		const p = points[i]!
		dist[i] = haversineM(lat, lon, p.lat, p.lon) / 1000
		order[i] = i
		total += p.weight
	}
	order.sort((a, b) => dist[a]! - dist[b]!)
	let acc = 0
	let median = 0
	for (let k = 0; k < n; k++) {
		const i = order[k]!
		acc += points[i]!.weight
		median = dist[i]!
		if (acc >= total / 2) break
	}
	const step = STATION_ESTIMATE_UNCERTAINTY_STEP_KM
	return Math.max(
		STATION_ESTIMATE_MIN_UNCERTAINTY_KM,
		step * Math.ceil(median / step),
	)
}

/** Pure estimate from collected contributors (requirement 2.3 to 2.5). */
export function computeEstimate(
	points: readonly WeightedPosition[],
): StationEstimateComputation {
	let direct = 0
	for (const p of points) if (isDirectWeight(p.weight)) direct++
	if (
		points.length < STATION_ESTIMATE_MIN_ENTITIES &&
		direct < STATION_ESTIMATE_MIN_DIRECT
	) {
		return { available: false, reason: "too-few-positions" }
	}
	const median = sphericalGeometricMedian(points)
	if (!median) return { available: false, reason: "degenerate" }
	return {
		available: true,
		lat: roundEstimateDeg(median.lat),
		lon: roundEstimateLon(median.lon),
		uncertaintyKm: estimateUncertaintyKm(median.lat, median.lon, points),
		rawLat: median.lat,
		rawLon: median.lon,
	}
}
