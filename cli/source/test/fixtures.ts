import { REST_GUARDS } from "../data/api-client.js"
import { parseServerMessage } from "../data/guards.js"
import {
	PLAIN_SUMMARY,
	initialState,
	reduce,
	type ReduceDeps,
} from "../data/reducers.js"
import {
	ENDPOINT_PATHS,
	POLL_ENDPOINTS,
	type AppState,
	type Endpoint,
	type Inbound,
	type LaneError,
	type RestInbound,
} from "../data/types.js"
import type { Scenario, ScenarioFrame, ScenarioName } from "./scenario-types.js"
import { loadScenario, mergeById } from "./scenarios.js"

export const FIXTURE_BASE = "http://127.0.0.1:9000"
const FIXTURE_WS = "ws://127.0.0.1:9000/ws"
const WINDOW_MS = 600_000

const PATH_TO_ENDPOINT = new Map<string, Endpoint>(
	(Object.entries(ENDPOINT_PATHS) as Array<[Endpoint, string]>).map(
		([e, p]) => [p, e],
	),
)

function restItem(path: string, body: unknown, at: number): Inbound | null {
	const endpoint = PATH_TO_ENDPOINT.get(path)
	if (!endpoint) return null
	const guarded = REST_GUARDS[endpoint](body)
	const outcome = guarded
		? { ok: true as const, value: guarded.value, rejected: guarded.rejected }
		: {
				ok: false as const,
				error: {
					kind: "invalid" as const,
					message: `fixture ${path} failed its guard`,
					at,
				},
			}
	return { kind: "rest", endpoint, outcome, at } as RestInbound
}

function wsItem(f: ScenarioFrame, at: number): Inbound {
	const event = parseServerMessage({
		type: f.type,
		channel: f.channel,
		data: f.data,
	})
	if (!event)
		throw new Error(`fixture frame ${f.type} failed parseServerMessage`)
	return { kind: "ws", event, at }
}

function restError(sc: Scenario, at: number): LaneError {
	const reason = sc.conn.restError ?? "ECONNREFUSED"
	return reason === "timeout"
		? { kind: "timeout", message: "timeout 2s", at }
		: { kind: "network", message: reason, at }
}

/** Turn a resolved scenario into the inbound items a live runtime would have queued, oldest first. */
export function scenarioInbound(sc: Scenario): {
	items: Inbound[]
	now: number
} {
	const now = Date.parse(sc.now)
	const c = sc.conn
	const restAt = now - (c.restAgoMs ?? 2000)
	const wsBase = now - (c.wsAgoMs ?? c.restAgoMs ?? 2000)
	const downFor = c.downForMs ?? 1000
	const timed: Inbound[] = []
	if (c.cached) {
		// Earlier REST answers, anchored to the last REST success so they stay older than it.
		for (const h of sc.restHistory ?? []) {
			const item = restItem(
				h.path,
				mergeById(sc.rest[h.path]?.body, h.merge),
				restAt + h.offsetMs,
			)
			if (item) timed.push(item)
		}
		for (const [path, r] of Object.entries(sc.rest)) {
			if (r.status !== 200) continue
			const item = restItem(path, r.body, restAt)
			if (item) timed.push(item)
		}
		for (const f of [...sc.ws, ...(sc.wsAppend ?? [])])
			timed.push(wsItem(f, wsBase + f.offsetMs))
		timed.push({ kind: "rest:cycle", at: restAt, nextAt: restAt + 5000 })
	}
	timed.sort((a, b) => a.at - b.at)
	const items: Inbound[] = [
		{
			kind: "target",
			at: now - WINDOW_MS,
			base: FIXTURE_BASE,
			ws: FIXTURE_WS,
			discovery: { mode: "explicit", tried: [] },
		},
		// A cold start with the API down never had an open socket, so it must not open a gap.
		...(c.cached || c.ws === "open"
			? [{ kind: "ws:open" as const, at: now - WINDOW_MS + 1 }]
			: []),
		...timed,
	]
	if (c.ws === "closed") {
		items.push({
			kind: "ws:close",
			at: now - (c.wsClosedAgoMs ?? downFor),
			code: c.closeCode ?? 1006,
			reason: "",
			nextRetryAt: now + 8000,
		})
	}
	if (c.rest === "down") {
		for (const at of [now - downFor, now - 1000]) {
			for (const endpoint of POLL_ENDPOINTS) {
				items.push({
					kind: "rest",
					endpoint,
					outcome: { ok: false, error: restError(sc, at) },
					at,
				} as RestInbound)
			}
		}
		items.push({ kind: "rest:cycle", at: now - 1000, nextAt: now + 4000 })
	}
	items.sort((a, b) => a.at - b.at)
	return { items, now }
}

export function scenarioState(
	name: ScenarioName,
	deps: ReduceDeps = PLAIN_SUMMARY,
): AppState {
	const { items, now } = scenarioInbound(loadScenario(name))
	return reduce(initialState(now - WINDOW_MS - 1000), items, now, deps)
}
