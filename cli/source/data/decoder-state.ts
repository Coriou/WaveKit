import type { DecoderRow, DecoderSession, GlyphRole } from "./types.js"

export type ProcState =
	| "faulted"
	| "crash-loop"
	| "stopped"
	| "restarting"
	| "down"
	| "starting"
	| "up"

export const STARTING_UPTIME_S = 10
export const CRASH_LOOP_INCREMENTS = 2

/**
 * Spec §10.7, evaluated in order. `health` only ever makes a decoder look worse when it is "faulted".
 * R15: `!running` with restarts on record and not faulted is core's automatic-restart backoff
 * ("restarting"); an explicit stop does not reset `restartCount`, so a stop by this CLI wins.
 * Planned core fields (desiredRunning, suspended, suspension) slot in before "restarting":
 * a held or suspended decoder is not restarting.
 */
export function processState(
	d: DecoderRow,
	restartIncrements5m: number,
	stoppedByCli: boolean,
): ProcState {
	if (d.health === "faulted") return "faulted"
	if (restartIncrements5m >= CRASH_LOOP_INCREMENTS) return "crash-loop"
	if (!d.running) {
		if (stoppedByCli) return "stopped"
		return d.restartCount > 0 ? "restarting" : "down"
	}
	if (d.uptime < STARTING_UPTIME_S && d.stats.eventsOut === 0) return "starting"
	return "up"
}

export function procRole(s: ProcState): GlyphRole {
	switch (s) {
		case "faulted":
		case "crash-loop":
		case "down":
			return "fault"
		case "stopped":
		case "restarting":
		case "starting":
			return "neutral"
		case "up":
			return "live"
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
