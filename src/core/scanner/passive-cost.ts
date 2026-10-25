import {
	PASSIVE_COST_CLEAR_RATIO,
	PASSIVE_COST_RECHECK_MS,
	PASSIVE_COST_WINDOW_MS,
	PASSIVE_SATURATION,
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

/**
 * WG11 (Main decision on review M2): a guard-disabled source whose engine has closed (headless, no
 * display holding it) is re-enabled for probation after three recheck periods (15 min); the next
 * open is judged again by the usual first check.
 */
export const PASSIVE_PROBATION_MS = 3 * PASSIVE_COST_RECHECK_MS

/** Pure: true iff disabled, no engine open and at least `PASSIVE_PROBATION_MS` since disabling. */
export function passiveProbationDue(input: {
	disabled: boolean
	engineOpen: boolean
	sinceDisabledMs: number | null
}): boolean {
	const { disabled, engineOpen, sinceDisabledMs } = input
	return (
		disabled &&
		!engineOpen &&
		sinceDisabledMs !== null &&
		Number.isFinite(sinceDisabledMs) &&
		sinceDisabledMs >= PASSIVE_PROBATION_MS
	)
}

/**
 * The cumulative `idle` / `active` milliseconds of an event-loop sample (`EventLoopUtilization`),
 * with the generation of the worker that produced it (bumped on every worker (re)start).
 */
export interface EluSample {
	idle: number
	active: number
	generation: number
}

/**
 * WG11 (Main decision on review M1): utilization over the window between two cumulative samples of
 * the same worker; with no previous sample, or one from another worker generation (or, defensively,
 * counters that went back), the window is the current worker's whole life so far. A replacement
 * worker is identified by its generation, never by its counters alone: a fresh worker's counters
 * can exceed the old one's. Null for an empty or non-finite window.
 */
export function windowedUtilization(
	current: EluSample,
	previous: EluSample | null,
): number | null {
	const fresh =
		previous === null ||
		current.generation !== previous.generation ||
		current.idle < previous.idle ||
		current.active < previous.active
	const active = fresh ? current.active : current.active - previous.active
	const idle = fresh ? current.idle : current.idle - previous.idle
	const total = active + idle
	if (!Number.isFinite(total) || total <= 0) return null
	return active / total
}

/** WG15 DQ 8.1: who holds the source's engine. `closed`: no engine open. */
export type PassiveHolders = "sole" | "shared" | "off" | "closed"

export interface PassiveGuardInput {
	/** Passive is enabled (not disabled by this guard). */
	enabled: boolean
	holders: PassiveHolders
	/** U over a completed window (8.2); null when there is no measurement. */
	measurement: number | null
	/** A valid baseline B (8.3); null when unavailable. */
	baseline: number | null
	limit: number
	/** Rows 2 to 4 are judged at a window's first completion, then every 300 s. */
	judgementDue: boolean
	baselineWindowAllowed: boolean
	/** 8.6: a disabled source's trial is due. */
	trialDue: boolean
	/** WG11 probation (engine closed). */
	probationDue: boolean
}

export type PassiveGuardDecision =
	| "keep"
	| "disable"
	| "clear"
	| "baseline"
	| "trial"

export interface PassiveGuardResult {
	decision: PassiveGuardDecision
	/** The 8.4 row that decided. */
	row: number
	/** `disabledReason` figure: whole engine (rows 2, 3) or marginal (row 4). */
	figure: "engine" | "passive" | null
	/** The figure's value (U or M) when it disables. */
	value: number | null
}

const finite = (x: number | null): x is number =>
	x !== null && Number.isFinite(x)

/**
 * WG15 DQ 8.4: the passive guard precedence table, first matching row wins. Pure. Row 2 is
 * exactly the WG11 rule (`passiveCostDecision`) on the whole engine.
 */
export function passiveGuardDecision(
	input: PassiveGuardInput,
): PassiveGuardResult {
	const keep = (row: number): PassiveGuardResult => ({
		decision: "keep",
		row,
		figure: null,
		value: null,
	})
	const { enabled, holders, measurement: u, limit } = input
	if (!enabled && holders === "closed")
		return input.probationDue
			? { decision: "clear", row: 11, figure: null, value: null }
			: keep(11)
	if (!finite(u) || !Number.isFinite(limit)) return keep(1)
	if (enabled) {
		// Enabled but not on the engine (a restore in flight): nothing of passive to judge.
		if (holders === "off" || holders === "closed") return keep(1)
		if (holders === "sole") {
			if (!input.judgementDue) return keep(2)
			const over = u > limit
			return over
				? { decision: "disable", row: 2, figure: "engine", value: u }
				: keep(2)
		}
		if (u >= PASSIVE_SATURATION)
			return { decision: "disable", row: 3, figure: "engine", value: u }
		const b = input.baseline
		if (finite(b)) {
			if (!input.judgementDue) return keep(4)
			const m = Math.max(0, u - b)
			return m > limit
				? { decision: "disable", row: 4, figure: "passive", value: m }
				: keep(4)
		}
		if (u <= limit) return keep(5)
		if (input.baselineWindowAllowed)
			return { decision: "baseline", row: 6, figure: null, value: null }
		return keep(7)
	}
	if (u <= limit * PASSIVE_COST_CLEAR_RATIO)
		return { decision: "clear", row: 8, figure: null, value: null }
	if (input.trialDue && finite(input.baseline))
		return { decision: "trial", row: 9, figure: null, value: null }
	return keep(10)
}
