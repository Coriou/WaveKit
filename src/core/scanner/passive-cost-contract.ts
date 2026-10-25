/**
 * WG11 frozen contract (docs/specs/web-gaps-11, requirement 2): the passive CPU guard. Lane SC
 * implements `passiveCostDecision` (`src/core/scanner/passive-cost.ts`); Main wires the recheck
 * into the scanner service. Constants and types only.
 */

/** Spectrum engine utilization (fraction of one core) above which passive is disabled (§ 10.7). */
export const PASSIVE_COST_LIMIT_DEFAULT = 0.25
/** The first check runs this long after the engine opened (§ 10.7). */
export const PASSIVE_COST_WINDOW_MS = 60_000
/** After the first check the guard re-reads the running engine this often. */
export const PASSIVE_COST_RECHECK_MS = 300_000
/** A disabled source comes back at or below `limit × PASSIVE_COST_CLEAR_RATIO` (hysteresis). */
export const PASSIVE_COST_CLEAR_RATIO = 0.8

export interface PassiveCostInput {
	/** The running engine's utilization (fraction of one core); null when unknown or no engine. */
	utilization: number | null
	/** `scanner.passive.maxEngineUtilization ?? PASSIVE_COST_LIMIT_DEFAULT`. */
	limit: number
	/** Passive is currently disabled by this guard for the source. */
	disabled: boolean
	/** Since the current engine opened; null when no engine runs. */
	sinceOpenMs: number | null
	/** Since the guard last checked this source; null before the first check of this engine. */
	sinceLastCheckMs: number | null
}

/** `disable` / `clear` change the source's passive state; `keep` changes nothing. */
export type PassiveCostDecision = "disable" | "clear" | "keep"

/** WG15 DQ 8.3: a baseline (engine cost without passive) is valid at most this long. */
export const PASSIVE_BASELINE_MAX_AGE_MS = 1_800_000
/** WG15 DQ 8.4 row 3: a shared engine at or above this utilization is saturated. */
export const PASSIVE_SATURATION = 0.95
