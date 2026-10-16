import { STATION_ESTIMATE_CACHE_MS } from "@wavekit/api-types"
import type { StationEstimate } from "@wavekit/api-types"
import { WaveKitError } from "../../utils/errors.js"
import { collectContributors, computeEstimate } from "./estimator.js"
import type {
	StationEstimateProvider,
	StationEstimateSources,
} from "./contract.js"

/** Call a snapshot getter; absent or throwing skips that fleet. */
function snapshot<T>(getter: (() => readonly T[]) | undefined) {
	if (getter === undefined) return undefined
	try {
		return getter()
	} catch {
		return undefined
	}
}

/**
 * Pull-model station estimator: computed on request, cached for STATION_ESTIMATE_CACHE_MS,
 * concurrent calls share one computation. Failures are never cached.
 */
export function createStationEstimator(
	sources: StationEstimateSources,
): StationEstimateProvider {
	const clock = sources.now ?? Date.now
	let cached: { value: StationEstimate; until: number } | undefined
	let inFlight: Promise<StationEstimate> | undefined

	function compute(): StationEstimate {
		const now = clock()
		const aircraft = snapshot(sources.aircraft)
		const vessels = snapshot(sources.vessels)
		const aprs = snapshot(sources.aprs)
		const mesh = snapshot(sources.mesh)
		// Only fleet getters are skipped on failure; a throwing stationConfigured is an
		// unexpected failure (500, not cached).
		const stationConfigured = sources.stationConfigured() === true
		const { points, basis } = collectContributors(
			{
				...(aircraft !== undefined && { aircraft }),
				...(vessels !== undefined && { vessels }),
				...(aprs !== undefined && { aprs }),
				...(mesh !== undefined && { mesh }),
			},
			now,
		)
		const result = computeEstimate(points)
		const computedAt = new Date(now).toISOString()
		const cachedUntil = new Date(now + STATION_ESTIMATE_CACHE_MS).toISOString()
		const common = {
			basis,
			computedAt,
			cachedUntil,
			authoritative: false,
			stationConfigured,
		} as const
		if (!result.available)
			return {
				available: false,
				reason: result.reason,
				lat: null,
				lon: null,
				uncertaintyKm: null,
				...common,
			}
		return {
			available: true,
			reason: null,
			lat: result.lat,
			lon: result.lon,
			uncertaintyKm: result.uncertaintyKm,
			...common,
		}
	}

	return {
		estimate(): Promise<StationEstimate> {
			if (cached !== undefined && clock() < cached.until)
				return Promise.resolve(cached.value)
			if (inFlight !== undefined) return inFlight
			const run = (async () => {
				// Yield first so `inFlight` is assigned before the finally block clears it.
				await Promise.resolve()
				try {
					const value = compute()
					cached = { value, until: Date.parse(value.cachedUntil) }
					return value
				} catch (error) {
					throw new WaveKitError(
						"Station estimate failed",
						"STATION_ESTIMATE_FAILED",
						error instanceof Error ? error : undefined,
					)
				} finally {
					inFlight = undefined
				}
			})()
			inFlight = run
			return run
		},
	}
}
