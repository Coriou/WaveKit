import type { DecoderRow, DecoderSession, GlyphRole } from "./types.js"

export type ProcState =
	| "suspended"
	| "suspend-pending"
	| "faulted"
	| "faulted-retry"
	| "faulted-retrying"
	| "crash-loop"
	| "stopped"
	| "restarting"
	| "resuming"
	| "down"
	| "starting"
	| "up"
	| "unknown"

export const STARTING_UPTIME_S = 10
export const CRASH_LOOP_INCREMENTS = 2
/** A "suspending" transition older than this means the stop has not happened (R70). */
export const SUSPEND_PENDING_MS = 10_000

/**
 * Spec §10.7, evaluated in order, extended for core's proposed contracts (R70):
 * - Suspension (intended, rate-driven) is rendered ahead of health; a "suspending"
 *   transition seen for > 10 s means the stop is pending.
 * - health "faulted": terminal when not running and no restart is scheduled; still
 *   retrying with `nextRestartAt` ("faulted-retry", fault) or while running on
 *   probation ("faulted-retrying", attention).
 * - Not running: stopped (by this CLI, or `desiredRunning: false`), core's
 *   "restarting", core's "resuming" transition after a retune or rate change (not a
 *   fault), an unrecognised transition (?), else for older cores (no
 *   `desiredRunning`) the R15 inference (`restartCount > 0`), else down.
 * - An unknown health never reads as up.
 * `now` and `suspendingSince` (local first sight of "suspending", kept in the session)
 * are needed only for the pending-suspension timing (M-b).
 */
export function processState(
	d: DecoderRow,
	restartIncrements5m: number,
	stoppedByCli: boolean,
	now?: number,
	/** Local time "suspending" was first seen (session), M-b. */
	suspendingSince?: number,
): ProcState {
	if (
		d.transition === "suspending" &&
		now !== undefined &&
		suspendingSince !== undefined &&
		now - suspendingSince > SUSPEND_PENDING_MS
	)
		return "suspend-pending"
	if (d.suspended === true) return "suspended"
	if (d.health === "faulted") {
		if (d.running) return "faulted-retrying"
		return d.nextRestartAt !== undefined ? "faulted-retry" : "faulted"
	}
	if (restartIncrements5m >= CRASH_LOOP_INCREMENTS) return "crash-loop"
	if (!d.running) {
		if (stoppedByCli || d.desiredRunning === false) return "stopped"
		if (d.health === "restarting") return "restarting"
		if (d.transition === "resuming") return "resuming"
		if (d.health === "unknown" || d.transition === "unknown") return "unknown"
		if (d.desiredRunning === undefined && d.restartCount > 0)
			return "restarting"
		return "down"
	}
	if (d.health === "unknown") return "unknown"
	if (d.uptime < STARTING_UPTIME_S && d.stats.eventsOut === 0) return "starting"
	return "up"
}

/**
 * "restarting" and a fault that is still retrying while running are attention (R31):
 * not running must not look calm, but they are not terminal. Suspension is intended.
 */
export function procRole(s: ProcState): GlyphRole {
	switch (s) {
		case "faulted":
		case "faulted-retry":
		case "crash-loop":
		case "down":
			return "fault"
		case "restarting":
		case "faulted-retrying":
		case "suspend-pending":
			return "attention"
		case "stopped":
		case "starting":
		case "resuming":
		case "suspended":
			return "neutral"
		case "up":
			return "live"
		case "unknown":
			return "unknown"
	}
}

export function isFailing(s: ProcState): boolean {
	return procRole(s) === "fault"
}

export function lastDecodeAt(
	d: DecoderRow,
	session: DecoderSession | undefined,
): number | null {
	const rest = d.lastOutputAt ? Date.parse(d.lastOutputAt) : Number.NaN
	const ws = session?.lastWsOutputAt ?? Number.NaN
	const candidates = [rest, ws].filter(Number.isFinite)
	return candidates.length > 0 ? Math.max(...candidates) : null
}

export type DecodesFact =
	| { kind: "na" }
	| { kind: "rate"; perSec: number; lastAt: number | null }
	| { kind: "last"; lastAt: number }
	| { kind: "none"; uptimeSec: number }
	| { kind: "total"; count: number }

export function decodesFact(
	d: DecoderRow,
	ratePerSec: number | null,
	lastAt: number | null,
): DecodesFact {
	if (!d.running) return { kind: "na" }
	if (ratePerSec !== null && ratePerSec > 0)
		return { kind: "rate", perSec: ratePerSec, lastAt }
	if (lastAt !== null) return { kind: "last", lastAt }
	if (d.stats.eventsOut === 0) return { kind: "none", uptimeSec: d.uptime }
	return { kind: "total", count: d.stats.eventsOut }
}
