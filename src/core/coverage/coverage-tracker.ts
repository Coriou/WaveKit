import {
	COVERAGE_BEARING_STEP_DEG,
	COVERAGE_MAX_POSITION_AGE_MS,
	COVERAGE_MAX_RANGE_M,
	COVERAGE_PROTOCOLS,
	COVERAGE_WINDOW_HOURS,
} from "@wavekit/api-types"
import type {
	CoverageProtocol,
	CoverageProtocolSummary,
	CoverageRejections,
	CoverageResponse,
	CoverageSector,
} from "@wavekit/api-types"
import { haversineM, initialBearingDeg } from "./geo.js"

const HOUR_MS = 3_600_000
const BUCKETS = 360
const SLOTS = COVERAGE_WINDOW_HOURS
const CELLS = SLOTS * BUCKETS
/** Empty range cell; -1 so a range of 0 m (at the station) is storable. */
const EMPTY = -1
/** Slot hour sentinel: never written. */
const NO_HOUR = -2_147_483_648

interface ProtocolStore {
	range: Float64Array
	lat: Float64Array
	lon: Float64Array
	time: Float64Array
	hour: Int32Array
	accepted: Float64Array
}

function createStore(): ProtocolStore {
	return {
		range: new Float64Array(CELLS).fill(EMPTY),
		lat: new Float64Array(CELLS),
		lon: new Float64Array(CELLS),
		time: new Float64Array(CELLS),
		hour: new Int32Array(SLOTS).fill(NO_HOUR),
		accepted: new Float64Array(SLOTS),
	}
}

/**
 * Pure receiver-coverage accumulator (WG3 requirement 7): per protocol, the farthest accepted
 * position per 1-degree bearing in 24 hourly slots. observe() allocates nothing.
 */
export class CoverageTracker {
	private readonly station: { lat: number; lon: number } | null
	private readonly stores: Record<CoverageProtocol, ProtocolStore>
	private readonly rejected: CoverageRejections = {
		"invalid-position": 0,
		"too-far": 0,
		stale: 0,
		"no-station": 0,
	}

	constructor(station: { lat: number; lon: number } | null) {
		this.station =
			station === null ? null : { lat: station.lat, lon: station.lon }
		this.stores = { adsb: createStore(), ais: createStore() }
	}

	/** Returns true when accepted; otherwise increments the rejection counter. */
	observe(
		protocol: CoverageProtocol,
		lat: number,
		lon: number,
		positionAtMs: number,
		nowMs: number,
	): boolean {
		const station = this.station
		if (station === null) {
			this.rejected["no-station"]++
			return false
		}
		if (
			!Number.isFinite(lat) ||
			!Number.isFinite(lon) ||
			Math.abs(lat) > 90 ||
			Math.abs(lon) > 180 ||
			(lat === 0 && lon === 0)
		) {
			this.rejected["invalid-position"]++
			return false
		}
		if (
			!Number.isFinite(positionAtMs) ||
			!(nowMs - positionAtMs <= COVERAGE_MAX_POSITION_AGE_MS)
		) {
			this.rejected.stale++
			return false
		}
		const range = haversineM(station.lat, station.lon, lat, lon)
		if (!(range <= COVERAGE_MAX_RANGE_M)) {
			this.rejected["too-far"]++
			return false
		}
		const store = this.stores[protocol]
		const hour = Math.floor(positionAtMs / HOUR_MS)
		const slot = ((hour % SLOTS) + SLOTS) % SLOTS
		const stored = store.hour[slot] ?? NO_HOUR
		if (hour < stored) {
			// The slot already holds a newer hour; this position belongs to an evicted hour.
			this.rejected.stale++
			return false
		}
		const base = slot * BUCKETS
		if (hour > stored) {
			store.range.fill(EMPTY, base, base + BUCKETS)
			store.accepted[slot] = 0
			store.hour[slot] = hour
		}
		let bucket = Math.floor(
			initialBearingDeg(station.lat, station.lon, lat, lon) /
				COVERAGE_BEARING_STEP_DEG,
		)
		if (bucket < 0) bucket = 0
		else if (bucket > BUCKETS - 1) bucket = BUCKETS - 1
		const cell = base + bucket
		store.accepted[slot] = (store.accepted[slot] ?? 0) + 1
		if (range > (store.range[cell] ?? EMPTY)) {
			store.range[cell] = range
			store.lat[cell] = lat
			store.lon[cell] = lon
			store.time[cell] = positionAtMs
		}
		return true
	}

	query(nowMs: number, protocol?: CoverageProtocol): CoverageResponse {
		const base = {
			windowHours: COVERAGE_WINDOW_HOURS,
			bearingStepDeg: COVERAGE_BEARING_STEP_DEG,
			rejected: { ...this.rejected },
			timestamp: new Date(nowMs).toISOString(),
		}
		if (this.station === null) {
			return {
				available: false,
				reason: "no-station-location",
				station: null,
				protocols: [],
				...base,
			}
		}
		const currentHour = Math.floor(nowMs / HOUR_MS)
		const minHour = currentHour - SLOTS
		const protocols: CoverageProtocolSummary[] = []
		for (const p of COVERAGE_PROTOCOLS) {
			if (protocol !== undefined && p !== protocol) continue
			protocols.push(this.summarise(p, minHour, currentHour))
		}
		return { available: true, station: { ...this.station }, protocols, ...base }
	}

	private summarise(
		protocol: CoverageProtocol,
		minHour: number,
		currentHour: number,
	): CoverageProtocolSummary {
		const store = this.stores[protocol]
		const live: number[] = []
		let accepted = 0
		for (let s = 0; s < SLOTS; s++) {
			const h = store.hour[s] ?? NO_HOUR
			if (h > minHour && h <= currentHour) {
				live.push(s)
				accepted += store.accepted[s] ?? 0
			}
		}
		const sectors: CoverageSector[] = []
		let maxRangeM: number | null = null
		for (let b = 0; b < BUCKETS; b++) {
			let bestCell = -1
			let best = EMPTY
			for (const s of live) {
				const cell = s * BUCKETS + b
				const r = store.range[cell] ?? EMPTY
				if (r > best) {
					best = r
					bestCell = cell
				}
			}
			if (bestCell < 0) continue
			sectors.push({
				bearingDeg: b * COVERAGE_BEARING_STEP_DEG,
				maxRangeM: best,
				lat: store.lat[bestCell] ?? 0,
				lon: store.lon[bestCell] ?? 0,
				at: new Date(store.time[bestCell] ?? 0).toISOString(),
			})
			if (maxRangeM === null || best > maxRangeM) maxRangeM = best
		}
		return { protocol, sectors, maxRangeM, accepted }
	}
}
