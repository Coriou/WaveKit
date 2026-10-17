import {
	PASSIVE_COST_CLEAR_RATIO,
	PASSIVE_COST_RECHECK_MS,
	PASSIVE_COST_WINDOW_MS,
	type PassiveCostDecision,
	type PassiveCostInput,
} from "./passive-cost-contract.js"

/**
 * WG11 requirement 2: decide whether the passive CPU guard disables, clears or keeps a source.
 * Pure. The first check is due `PASSIVE_COST_WINDOW_MS` after the engine opened, later checks every
 * `PASSIVE_COST_RECHECK_MS`. Disable above the limit; clear at or below `limit × CLEAR_RATIO`.
 * Unknown or non-finite readings keep the current state (fail safe).
 */
export function passiveCostDecision(
	input: PassiveCostInput,
): PassiveCostDecision {
	const { utilization, limit, disabled, sinceOpenMs, sinceLastCheckMs } = input
	if (utilization === null || sinceOpenMs === null) return "keep"
	if (!Number.isFinite(utilization) || !Number.isFinite(limit)) return "keep"
	const due =
		sinceLastCheckMs === null
			? sinceOpenMs >= PASSIVE_COST_WINDOW_MS
			: sinceLastCheckMs >= PASSIVE_COST_RECHECK_MS
	if (!due) return "keep"
	if (!disabled && utilization > limit) return "disable"
	if (disabled && utilization <= limit * PASSIVE_COST_CLEAR_RATIO)
		return "clear"
	return "keep"
}
