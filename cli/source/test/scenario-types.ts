export type ScenarioName =
	| "live"
	| "idle"
	| "api-down"
	| "api-down-cached"
	| "ws-only"
	| "rest-only"
	| "dropping"
	| "crash-loop"
	| "legacy"
	| "long-text"
	| "burst"
	| "iq-stale"
	| "iq-disconnected"
	| "decoder-faulted"
	| "contracts"
	| "tuner-unknown"

export const SCENARIO_NAMES: readonly ScenarioName[] = [
	"live",
	"idle",
	"api-down",
	"api-down-cached",
	"ws-only",
	"rest-only",
	"dropping",
	"crash-loop",
	"legacy",
	"long-text",
	"burst",
	"iq-stale",
	"iq-disconnected",
	"decoder-faulted",
	"contracts",
	"tuner-unknown",
]

export interface ScenarioRest {
	status: number
	body?: unknown
}

/** A WS frame as core sends it, replayed at (now − conn.wsAgoMs) + offsetMs (offset ≤ 0). */
export interface ScenarioFrame {
	offsetMs: number
	type: string
	channel: string
	data: unknown
}

/** An earlier REST answer: the current body of `path`, with `merge[id]` deep-merged into the array item whose `id` (or `sourceId`) matches. */
export interface ScenarioHistory {
	offsetMs: number
	path: string
	merge: Record<string, unknown>
}

export interface ScenarioConn {
	rest: "ok" | "down"
	ws: "open" | "closed"
	/** false = cold start with the API down: no REST success was ever seen. */
	cached: boolean
	/** Age of the last REST success at `now` (default 2000). */
	restAgoMs?: number
	/** For rest "down": how long it has been failing (default 1000). */
	downForMs?: number
	/** Replayed WS frames are timestamped at now − wsAgoMs + offsetMs (default: restAgoMs). */
	wsAgoMs?: number
	/** For rest "down": "ECONNREFUSED" or "timeout". */
	restError?: string
	/** For ws "closed": close code (default 1006) and age of the close (default = downForMs). */
	closeCode?: number
	wsClosedAgoMs?: number
}

export interface ScenarioTransform {
	/** Strip `activity` from sources and `totalBytesWritten` from all fanout bodies (older core). */
	legacy?: boolean
	/** Rewrite every decoder branch so Δdropped = pct% of Δoffered between consecutive snapshots. */
	dropPercent?: number
	/** Remove every decoder:output frame (no decodes observed). */
	noOutputs?: boolean
}

export interface Scenario {
	name: string
	description: string
	extends?: string
	/** ISO clock of the fixture (UTC). */
	now: string
	conn: ScenarioConn
	/** Keyed by REST path, e.g. "/api/decoders". */
	rest: Record<string, ScenarioRest>
	/** Per-path, per-id deep merges applied after `extends` (arrays matched by id/sourceId). */
	restPatch?: Record<string, Record<string, unknown>>
	restHistory?: ScenarioHistory[]
	ws: ScenarioFrame[]
	wsAppend?: ScenarioFrame[]
	transform?: ScenarioTransform
	/** Canned write results for the mock, keyed "METHOD /path/with/:params". */
	actions?: Record<string, ScenarioRest>
}
