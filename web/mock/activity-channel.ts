/**
 * Channel scopes of the Activity mock, as the core answers them (src/core/activity/query/read.ts):
 * `channelHz` (one channel) or `nearHz` ± `toleranceHz` match a row's `channel.frequencyHz`; a row
 * without `channel` (stored before it existed) matches by its own `frequencyHz` within
 * ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ below (inclusive) and above (exclusive) the scope, and
 * the answer says `channelMatch: "mixed"`. The `channel` facet counts rows by channel frequency
 * (decimal Hz), null for rows without one.
 */
import {
	ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ,
	ACTIVITY_CHANNEL_NEAR_MAX_TOLERANCE_HZ,
	DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
} from "@wavekit/api-types"
import type { ActivityQuery, ActivitySummary } from "@wavekit/api-types"

/** The scope's channel frequencies, inclusive; null when the query has none. */
export function channelScope(
	q: ActivityQuery,
): { minHz: number; maxHz: number } | null {
	if (q.channelHz !== undefined)
		return { minHz: q.channelHz, maxHz: q.channelHz }
	if (q.nearHz === undefined) return null
	const tolerance = q.toleranceHz ?? DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ
	return {
		minHz: Math.max(0, q.nearHz - tolerance),
		maxHz: q.nearHz + tolerance,
	}
}

/** Whether a row is in the query's channel scope (true when it has none). */
export function matchesChannel(
	item: ActivitySummary,
	q: ActivityQuery,
): boolean {
	const scope = channelScope(q)
	if (scope === null) return true
	if (item.channel !== undefined)
		return (
			item.channel.frequencyHz >= scope.minHz &&
			item.channel.frequencyHz <= scope.maxHz
		)
	return (
		item.frequencyHz !== null &&
		item.frequencyHz >= scope.minHz - ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ &&
		item.frequencyHz < scope.maxHz + ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ
	)
}

/** `channelMatch` of matched rows: only with a channel scope. */
export function channelMatchOf(
	matched: readonly ActivitySummary[],
	q: ActivityQuery,
): { channelMatch?: "exact" | "mixed" } {
	if (channelScope(q) === null) return {}
	return {
		channelMatch: matched.every(item => item.channel !== undefined)
			? "exact"
			: "mixed",
	}
}

/** A row's `channel` facet value. */
export function channelFacetValue(item: ActivitySummary): string | null {
	return item.channel === undefined ? null : String(item.channel.frequencyHz)
}

/** The channel query parameters of GET /api/activity, checked as the core checks them. */
export function channelParams(
	num: (name: string) => number | undefined,
): Pick<ActivityQuery, "channelHz" | "nearHz" | "toleranceHz"> {
	const channelHz = num("channelHz")
	const nearHz = num("nearHz")
	const toleranceHz = num("toleranceHz")
	if (channelHz !== undefined && nearHz !== undefined)
		throw new Error("channelHz must not be combined with nearHz")
	if (toleranceHz !== undefined && nearHz === undefined)
		throw new Error("toleranceHz requires nearHz")
	if (
		toleranceHz !== undefined &&
		(toleranceHz < 0 || toleranceHz > ACTIVITY_CHANNEL_NEAR_MAX_TOLERANCE_HZ)
	)
		throw new Error("toleranceHz is out of range")
	return {
		...(channelHz === undefined ? {} : { channelHz }),
		...(nearHz === undefined ? {} : { nearHz }),
		...(toleranceHz === undefined ? {} : { toleranceHz }),
	}
}
