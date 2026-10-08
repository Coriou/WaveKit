import type { DecoderOutput, TunerState } from "@wavekit/api-types"
import { emptyLane, laneFail, laneOk } from "./freshness.js"
import {
	RATE_WINDOW_MS,
	RESTART_WINDOW_MS,
	pushCounter,
	pushFanout,
	sparkAdd,
} from "./rates.js"
import {
	aircraftDelete,
	aircraftKey,
	aircraftPrune,
	aircraftResync,
	aircraftUpsert,
	createRing,
	ringCloseGap,
	ringOpenGap,
	ringPush,
} from "./ring-buffer.js"
import {
	POLL_ENDPOINTS,
	RESYNC_ENDPOINTS,
	type ActionRecord,
	type AircraftLookup,
	type AppState,
	type ConnState,
	type DecoderOp,
	type DecoderRow,
	type DecoderSession,
	type Endpoint,
	type FetchOutcome,
	type FormattedMessage,
	type Inbound,
	type Lane,
	type LaneError,
	type RestInbound,
	type WriteIntent,
	type WsEvent,
} from "./types.js"

export interface ReduceDeps {
	summarize(
		output: DecoderOutput,
		decoderId: string,
		lookup: AircraftLookup,
	): FormattedMessage
}

export const PLAIN_SUMMARY: ReduceDeps = {
	summarize: (output, decoderId) => ({
		protocol: output.type.toUpperCase().slice(0, 8),
		category: "other",
		segments: [],
		fields: [],
		emergency: false,
		searchText: `${decoderId} ${output.type}`.toLowerCase(),
	}),
}

export function initialState(now: number): AppState {
	return {
		conn: {
			target: { base: null, ws: null },
			discovery: { mode: "probing", tried: [] },
			ws: {
				state: "idle",
				since: null,
				code: null,
				reason: null,
				nextRetryAt: null,
				attempt: 0,
			},
			rest: {
				lastOkAt: null,
				lastCycleAt: null,
				nextAt: null,
				failing: [],
				firstFailAt: null,
				lastError: null,
			},
			invalidFrames: 0,
			rejectedItems: 0,
			lastEventAt: null,
		},
		sources: emptyLane(),
		metrics: record(),
		decoders: emptyLane(),
		session: record(),
		tuner: emptyLane(),
		tunerLastCommand: record(),
		relay: emptyLane(),
		fanout: emptyLane(),
		fanoutHistory: [],
		branchEvents: record(),
		resources: emptyLane(),
		alerts: [],
		audio: emptyLane(),
		presets: emptyLane(),
		status: emptyLane(),
		messages: { version: 0, ring: createRing() },
		aircraft: { version: 0, map: new Map(), stats: emptyLane() },
		actions: { byKey: record(), stoppedByCli: [] },
		effects: { polls: [] },
		now,
	}
}

// ---------- server-keyed records (R30) ----------

/** A record with no prototype: server ids such as "__proto__" or "toString" are plain keys. */
function record<T>(): Record<string, T> {
	return Object.create(null) as Record<string, T>
}

function own<T>(rec: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(rec, key) ? rec[key] : undefined
}

/** Copy-on-write set into a prototype-free record. */
function put<T>(
	rec: Readonly<Record<string, T>>,
	key: string,
	value: NoInfer<T>,
): Record<string, T> {
	const next = Object.assign(record<T>(), rec)
	next[key] = value
	return next
}

function newSession(at: number): DecoderSession {
	return {
		lastWsOutputAt: null,
		lastError: null,
		previousHealth: null,
		events: [],
		restarts: [],
		spark: {},
		firstObservedAt: at,
	}
}

function addUnique<T>(list: readonly T[], items: readonly T[]): T[] {
	const out = [...list]
	for (const x of items) if (!out.includes(x)) out.push(x)
	return out
}

function withPolls(s: AppState, endpoints: readonly Endpoint[]): AppState {
	const polls = addUnique(s.effects.polls, endpoints)
	return polls.length === s.effects.polls.length
		? s
		: { ...s, effects: { polls } }
}

function patchList<T>(
	lane: Lane<T[]>,
	match: (x: T) => boolean,
	patch: (x: T) => T,
): Lane<T[]> {
	const list = lane.value
	if (list === undefined) return lane
	let changed = false
	const value = list.map(x => {
		if (!match(x)) return x
		changed = true
		return patch(x)
	})
	return changed ? { ...lane, value } : lane
}

export function endpointsFor(intent: WriteIntent): Endpoint[] {
	switch (intent.kind) {
		case "decoder":
			return ["decoders"]
		case "tuner":
			return ["tuner", "relay"]
		case "audio":
		case "preset":
			return ["audio"]
	}
}

// ---------- REST ----------

function updateSessions(
	prev: Record<string, DecoderSession>,
	rows: readonly DecoderRow[],
	at: number,
): Record<string, DecoderSession> {
	const next = Object.assign(record<DecoderSession>(), prev)
	for (const d of rows) {
		const cur = own(prev, d.id) ?? newSession(at)
		const lastEvent = cur.events[cur.events.length - 1]
		next[d.id] = {
			...cur,
			events: pushCounter(cur.events, at, d.stats.eventsOut, RATE_WINDOW_MS),
			restarts: pushCounter(
				cur.restarts,
				at,
				d.restartCount,
				RESTART_WINDOW_MS,
			),
			spark: sparkAdd(cur.spark, lastEvent, { t: at, v: d.stats.eventsOut }),
		}
	}
	return next
}

function restOkConn(
	conn: ConnState,
	endpoint: Endpoint,
	rejected: number,
	at: number,
): ConnState {
	return {
		...conn,
		rejectedItems: conn.rejectedItems + rejected,
		rest: {
			...conn.rest,
			lastOkAt: at,
			failing: conn.rest.failing.filter(e => e !== endpoint),
			firstFailAt: null,
		},
	}
}

function restError(
	s: AppState,
	endpoint: Endpoint,
	error: LaneError,
	at: number,
): AppState {
	const conn: ConnState = {
		...s.conn,
		rest: {
			...s.conn.rest,
			failing: addUnique(s.conn.rest.failing, [endpoint]),
			lastError: error,
			firstFailAt: s.conn.rest.firstFailAt ?? at,
		},
	}
	switch (endpoint) {
		case "decoders":
			return { ...s, conn, decoders: laneFail(s.decoders, error) }
		case "sources":
			return { ...s, conn, sources: laneFail(s.sources, error) }
		case "tuner":
			return { ...s, conn, tuner: laneFail(s.tuner, error) }
		case "relay":
			return { ...s, conn, relay: laneFail(s.relay, error) }
		case "fanout":
			return { ...s, conn, fanout: laneFail(s.fanout, error) }
		case "resources":
			return { ...s, conn, resources: laneFail(s.resources, error) }
		case "audio":
			return { ...s, conn, audio: laneFail(s.audio, error) }
		case "status":
			return { ...s, conn, status: laneFail(s.status, error) }
		case "presets":
			return { ...s, conn, presets: laneFail(s.presets, error) }
		case "aircraft":
			return {
				...s,
				conn,
				aircraft: { ...s.aircraft, stats: laneFail(s.aircraft.stats, error) },
			}
	}
}

function okOr<T>(
	s: AppState,
	endpoint: Endpoint,
	outcome: FetchOutcome<T>,
	at: number,
	onOk: (value: T, conn: ConnState) => AppState,
): AppState {
	if (!outcome.ok) return restError(s, endpoint, outcome.error, at)
	return onOk(outcome.value, restOkConn(s.conn, endpoint, outcome.rejected, at))
}

function reduceRest(s: AppState, item: RestInbound): AppState {
	const at = item.at
	switch (item.endpoint) {
		case "decoders":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({
				...s,
				conn,
				decoders: laneOk(value, at, "rest"),
				session: updateSessions(s.session, value, at),
			}))
		case "sources":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({
				...s,
				conn,
				sources: laneOk(value, at, "rest"),
			}))
		case "tuner":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({
				...s,
				conn,
				tuner: laneOk(value, at, "rest"),
			}))
		case "relay":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({
				...s,
				conn,
				relay: laneOk(value, at, "rest"),
			}))
		case "fanout":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({
				...s,
				conn,
				fanout: laneOk(value, at, "rest"),
				fanoutHistory: pushFanout(s.fanoutHistory, value),
			}))
		case "resources":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({
				...s,
				conn,
				resources: laneOk(value, at, "rest"),
			}))
		case "audio":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({
				...s,
				conn,
				audio: laneOk(value, at, "rest"),
			}))
		case "status":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({
				...s,
				conn,
				status: laneOk(value, at, "rest"),
			}))
		case "presets":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({
				...s,
				conn,
				presets: laneOk(value, at, "rest"),
			}))
		case "aircraft":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => {
				aircraftResync(s.aircraft.map, value.aircraft, at)
				return {
					...s,
					conn,
					aircraft: {
						version: s.aircraft.version + 1,
						map: s.aircraft.map,
						stats: laneOk(value.stats, at, "rest"),
					},
				}
			})
	}
}

// ---------- WS ----------

function upsertTuner(
	lane: Lane<TunerState[]>,
	state: TunerState,
	at: number,
): Lane<TunerState[]> {
	const list = lane.value ?? []
	const idx = list.findIndex(t => t.sourceId === state.sourceId)
	const value =
		idx >= 0 ? list.map((t, i) => (i === idx ? state : t)) : [...list, state]
	return laneOk(value, at, "ws")
}

function reduceWs(
	s: AppState,
	ev: WsEvent,
	at: number,
	deps: ReduceDeps,
): AppState {
	switch (ev.type) {
		case "decoder:output": {
			const lookup: AircraftLookup = icao =>
				s.aircraft.map.get(aircraftKey(icao))?.state
			const formatted = deps.summarize(ev.output, ev.decoderId, lookup)
			ringPush(s.messages.ring, {
				decoderId: ev.decoderId,
				type: ev.output.type,
				receivedAt: at,
				output: ev.output,
				formatted,
			})
			// Server time (minor 7): comparable with REST lastOutputAt, never with the local clock.
			const sess = own(s.session, ev.decoderId) ?? newSession(at)
			const t = Date.parse(ev.output.timestamp)
			const lastWsOutputAt = Number.isFinite(t)
				? Math.max(t, sess.lastWsOutputAt ?? t)
				: sess.lastWsOutputAt
			return {
				...s,
				messages: { version: s.messages.version + 1, ring: s.messages.ring },
				session: put(s.session, ev.decoderId, { ...sess, lastWsOutputAt }),
			}
		}
		case "decoder:started":
		case "decoder:stopped":
			return withPolls(
				confirmDecoder(s, ev.decoderId, ev.type === "decoder:started", at),
				["decoders"],
			)
		case "decoder:status": {
			// One GET /api/decoders/:id body, latest wins. Lifecycle-driven, so the
			// lane's receivedAt (the last full list) is kept.
			const d = ev.decoder
			const list = s.decoders.value
			const prev = list?.find(x => x.id === d.id)
			const decoders =
				list === undefined
					? s.decoders
					: {
							...s.decoders,
							value: prev
								? list.map(x => (x.id === d.id ? d : x))
								: [...list, d],
						}
			const sess = own(s.session, d.id) ?? newSession(at)
			const session =
				prev !== undefined && prev.health !== d.health
					? put(s.session, d.id, { ...sess, previousHealth: prev.health })
					: s.session
			return confirmDecoder({ ...s, decoders, session }, d.id, d.running, at)
		}
		case "decoder:health": {
			const prev =
				s.decoders.value?.find(d => d.id === ev.decoderId)?.health ?? null
			const sess = own(s.session, ev.decoderId) ?? newSession(at)
			return {
				...s,
				decoders: patchList(
					s.decoders,
					d => d.id === ev.decoderId,
					d => ({ ...d, health: ev.health }),
				),
				session: put(
					s.session,
					ev.decoderId,
					prev !== null && prev !== ev.health
						? { ...sess, previousHealth: prev }
						: sess,
				),
			}
		}
		case "decoder:error": {
			const sess = own(s.session, ev.decoderId) ?? newSession(at)
			return {
				...s,
				session: put(s.session, ev.decoderId, {
					...sess,
					lastError: { message: ev.error, at },
				}),
			}
		}
		case "source:status": {
			// One GET /api/sources item: REPLACE the row, never merge (R30), so a stale
			// activityUnrecognised cannot survive. The heartbeat refreshes every source
			// every 10 s, so the lane counts as fresh.
			const list = s.sources.value
			if (list === undefined) return s
			const row = ev.source
			const value = list.some(x => x.id === row.id)
				? list.map(x => (x.id === row.id ? row : x))
				: [...list, row]
			return { ...s, sources: laneOk(value, at, "ws") }
		}
		case "source:connected":
			return withPolls(
				{
					...s,
					sources: patchList(
						s.sources,
						x => x.id === ev.sourceId,
						x => ({ ...x, connected: true }),
					),
				},
				["sources"],
			)
		case "source:disconnected": {
			const err = ev.error
			return withPolls(
				{
					...s,
					sources: patchList(
						s.sources,
						x => x.id === ev.sourceId,
						x => ({
							...x,
							connected: false,
							...(err !== undefined ? { lastError: err } : {}),
						}),
					),
				},
				["sources"],
			)
		}
		case "source:error":
			return withPolls(
				{
					...s,
					sources: patchList(
						s.sources,
						x => x.id === ev.sourceId,
						x => ({ ...x, lastError: ev.error }),
					),
				},
				["sources"],
			)
		case "source:caps-changed":
			return {
				...s,
				sources: patchList(
					s.sources,
					x => x.id === ev.sourceId,
					x => ({ ...x, caps: ev.caps }),
				),
			}
		case "metrics":
			return {
				...s,
				metrics: put(s.metrics, ev.sourceId, {
					bytesReceived: ev.bytesReceived,
					dataRateKiB: ev.dataRate,
					at,
				}),
			}
		case "fanout:snapshot":
			return {
				...s,
				fanout: laneOk(ev.snapshot, at, "ws"),
				fanoutHistory: pushFanout(s.fanoutHistory, ev.snapshot),
			}
		case "fanout:backpressure":
			return {
				...s,
				branchEvents: put(s.branchEvents, ev.branchId, {
					active: true,
					at,
					bufferedBytes: ev.bufferedBytes,
				}),
			}
		case "fanout:drain":
			return {
				...s,
				branchEvents: put(s.branchEvents, ev.branchId, { active: false, at }),
			}
		case "resources:snapshot":
			return { ...s, resources: laneOk(ev.snapshot, at, "ws") }
		case "resources:alert": {
			const a = ev.alert
			const key = `${a.type}|${a.sourceId ?? ""}|${a.severity}`
			const idx = s.alerts.findIndex(x => x.key === key)
			const alerts =
				idx >= 0
					? s.alerts.map((x, i) =>
							i === idx
								? { ...x, alert: a, count: x.count + 1, lastAt: at }
								: x,
						)
					: [...s.alerts, { key, alert: a, count: 1, firstAt: at, lastAt: at }]
			return { ...s, alerts }
		}
		case "tuner:state-changed":
			return { ...s, tuner: upsertTuner(s.tuner, ev.state, at) }
		case "tuner:control-mode-changed": {
			const patched = patchList(
				s.tuner,
				t => t.sourceId === ev.sourceId,
				t => ({ ...t, controlMode: ev.mode }),
			)
			return patched === s.tuner
				? s
				: { ...s, tuner: { ...patched, receivedAt: at, origin: "ws" } }
		}
		case "tuner:command-sent":
			return {
				...s,
				tunerLastCommand: put(s.tunerLastCommand, ev.sourceId, {
					command: ev.command,
					value: ev.value,
					at,
				}),
			}
		case "live-audio:status":
			return { ...s, audio: laneOk(ev.status, at, "ws") }
		case "live-audio:config": {
			const cur = s.audio.value
			return cur
				? { ...s, audio: laneOk({ ...cur, config: ev.config }, at, "ws") }
				: s
		}
		case "aircraft:new":
		case "aircraft:update":
			aircraftUpsert(s.aircraft.map, ev.aircraft, at)
			return {
				...s,
				aircraft: { ...s.aircraft, version: s.aircraft.version + 1 },
			}
		case "aircraft:lost":
			aircraftDelete(s.aircraft.map, ev.icao)
			return {
				...s,
				aircraft: { ...s.aircraft, version: s.aircraft.version + 1 },
			}
		case "aircraft:stats":
			return {
				...s,
				aircraft: { ...s.aircraft, stats: laneOk(ev.stats, at, "ws") },
			}
		// The POST response carries tuner and audio failures; these frames add nothing the CLI shows.
		case "tuner:error":
		case "live-audio:started":
		case "live-audio:stopped":
		case "live-audio:error":
		case "subscribed":
		case "unsubscribed":
		case "server-error":
			return s
	}
}

function reduceWsOpen(s: AppState, at: number): AppState {
	ringCloseGap(s.messages.ring, at)
	const session = record<DecoderSession>()
	for (const [id, sess] of Object.entries(s.session))
		session[id] = { ...sess, events: [] }
	return withPolls(
		{
			...s,
			conn: {
				...s.conn,
				ws: {
					state: "open",
					since: at,
					code: null,
					reason: null,
					nextRetryAt: null,
					attempt: 0,
				},
			},
			messages: { version: s.messages.version + 1, ring: s.messages.ring },
			fanoutHistory: [],
			session,
		},
		[...POLL_ENDPOINTS, ...RESYNC_ENDPOINTS],
	)
}

function reduceWsClose(
	s: AppState,
	item: Extract<Inbound, { kind: "ws:close" }>,
): AppState {
	let messages = s.messages
	if (s.conn.ws.state === "open") {
		const from = Math.min(
			item.at,
			Math.max(s.conn.lastEventAt ?? item.at, s.conn.ws.since ?? 0),
		)
		ringOpenGap(s.messages.ring, from)
		messages = { version: messages.version + 1, ring: messages.ring }
	}
	return {
		...s,
		messages,
		conn: {
			...s.conn,
			ws: {
				...s.conn.ws,
				state: "closed",
				since: item.at,
				code: item.code,
				reason: item.reason,
				nextRetryAt: item.nextRetryAt,
			},
		},
	}
}

// ---------- actions ----------

function stoppedAfter(
	stopped: readonly string[],
	op: DecoderOp,
	id: string,
): string[] {
	return op === "stop"
		? addUnique(stopped, [id])
		: stopped.filter(x => x !== id)
}

/**
 * decoder:started / stopped / status observed: confirm a pending decoder action whose
 * target running state it shows (stop → not running; start/restart → running). A sent
 * action whose result was "unknown" (R23) becomes ok here.
 */
function confirmDecoder(
	s: AppState,
	decoderId: string,
	running: boolean,
	at: number,
): AppState {
	const key = `decoder:${decoderId}`
	const rec = own(s.actions.byKey, key)
	if (!rec || rec.intent.kind !== "decoder" || rec.confirmedAt !== null)
		return s
	const op = rec.intent.op
	if ((op === "stop") === running) return s
	const resolve = rec.state === "sent" && rec.outcomes.length > 0
	return {
		...s,
		actions: {
			byKey: put(s.actions.byKey, key, {
				...rec,
				confirmedAt: at,
				...(resolve ? { state: "ok" as const, doneAt: at } : {}),
			}),
			stoppedByCli: resolve
				? stoppedAfter(s.actions.stoppedByCli, op, decoderId)
				: s.actions.stoppedByCli,
		},
	}
}

function reduceActionResult(
	s: AppState,
	item: Extract<Inbound, { kind: "action:result" }>,
): AppState {
	const rec = own(s.actions.byKey, item.key)
	if (!rec) return s
	const results = item.outcomes.map(o => o.result)
	const failed =
		results.length === 0 ||
		results.some(r => r === null || r.outcome === "failed")
	const unknown = !failed && results.some(r => r?.outcome === "unknown")
	// R23: no reply is not a failure; it stays "sent" until an event confirms it.
	const state: ActionRecord["state"] = failed
		? "failed"
		: unknown && rec.confirmedAt === null
			? "sent"
			: "ok"
	const intent = rec.intent
	const stopped =
		intent.kind === "decoder" && state === "ok"
			? stoppedAfter(s.actions.stoppedByCli, intent.op, intent.decoderId)
			: s.actions.stoppedByCli
	return withPolls(
		{
			...s,
			actions: {
				byKey: put(s.actions.byKey, item.key, {
					...rec,
					state,
					outcomes: item.outcomes,
					doneAt: state === "sent" ? null : item.at,
				}),
				stoppedByCli: stopped,
			},
		},
		endpointsFor(intent),
	)
}

function reduceOne(s: AppState, item: Inbound, deps: ReduceDeps): AppState {
	switch (item.kind) {
		case "rest":
			return reduceRest(s, item)
		case "rest:cycle":
			return {
				...s,
				conn: {
					...s.conn,
					rest: { ...s.conn.rest, lastCycleAt: item.at, nextAt: item.nextAt },
				},
			}
		case "ws":
			return reduceWs(
				{ ...s, conn: { ...s.conn, lastEventAt: item.at } },
				item.event,
				item.at,
				deps,
			)
		case "ws:connecting":
			return {
				...s,
				conn: {
					...s.conn,
					ws: { ...s.conn.ws, state: "connecting", attempt: item.attempt },
				},
			}
		case "ws:open":
			return reduceWsOpen(s, item.at)
		case "ws:close":
			return reduceWsClose(s, item)
		case "ws:invalid":
			return {
				...s,
				conn: { ...s.conn, invalidFrames: s.conn.invalidFrames + 1 },
			}
		case "target":
			return {
				...s,
				conn: {
					...s.conn,
					target: { base: item.base, ws: item.ws },
					discovery: item.discovery,
				},
			}
		case "action:sent":
			return {
				...s,
				actions: {
					...s.actions,
					byKey: put(s.actions.byKey, item.key, {
						key: item.key,
						intent: item.intent,
						sentAt: item.at,
						state: "sent",
						outcomes: [],
						doneAt: null,
						confirmedAt: null,
					}),
				},
			}
		case "action:result":
			return reduceActionResult(s, item)
	}
}

/**
 * Fold a batch of inbound items. `now` advances (and stale aircraft are pruned)
 * only when a 1 s boundary has passed, before the batch is applied, so
 * reduce(s, [a, b]) equals reduce(reduce(s, [a]), [b]) (P18).
 */
export function reduce(
	state: AppState,
	batch: readonly Inbound[],
	now: number,
	deps: ReduceDeps = PLAIN_SUMMARY,
): AppState {
	let s = state
	if (Math.floor(now / 1000) !== Math.floor(s.now / 1000)) {
		s = { ...s, now }
		if (aircraftPrune(s.aircraft.map, now) > 0) {
			s = { ...s, aircraft: { ...s.aircraft, version: s.aircraft.version + 1 } }
		}
	}
	for (const item of batch) s = reduceOne(s, item, deps)
	return s
}
