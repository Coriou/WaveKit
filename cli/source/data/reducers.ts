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
	actionKey,
	type ActionRecord,
	type ActionState,
	type AircraftLookup,
	type AppState,
	type CommandOutcome,
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
	type TunerCommand,
	type WriteIntent,
	type WsEvent,
} from "./types.js"

/** An unknown write that nothing reconciles within this long after its result ends as no-reply (R47 M5). */
export const NO_REPLY_MS = 10_000
/**
 * A sparkline baseline older than this is not used: after an outage the decodes since
 * it would all land in the current minute as a false spike (R55).
 */
export const SPARK_BASELINE_MS = 120_000

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

/** R70 M-b: remember when "suspending" was first seen; forget it once the transition ends. */
function trackSuspending(
	sess: DecoderSession,
	row: DecoderRow,
	at: number,
): DecoderSession {
	if (row.transition === "suspending")
		return sess.suspendingSince !== undefined
			? sess
			: { ...sess, suspendingSince: at }
	if (sess.suspendingSince === undefined) return sess
	const { suspendingSince: _s, ...rest } = sess
	return rest
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
		: { ...s, effects: { ...s.effects, polls } }
}

function withResync(s: AppState, endpoints: readonly Endpoint[]): AppState {
	return {
		...s,
		effects: {
			...s.effects,
			resync: addUnique(s.effects.resync ?? [], endpoints),
		},
	}
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
	// Final M4: the full list is the truth, so sessions of decoders it no longer has
	// (or that only ever appeared in decoder:status) are dropped: no unbounded growth.
	const next = record<DecoderSession>()
	for (const d of rows) {
		const cur = trackSuspending(own(prev, d.id) ?? newSession(at), d, at)
		const sample = { t: at, v: d.stats.eventsOut }
		next[d.id] = {
			...cur,
			events: pushCounter(cur.events, at, d.stats.eventsOut, RATE_WINDOW_MS),
			restarts: pushCounter(
				cur.restarts,
				at,
				d.restartCount,
				RESTART_WINDOW_MS,
			),
			spark: sparkAdd(
				cur.spark,
				cur.sparkPrev && at - cur.sparkPrev.t <= SPARK_BASELINE_MS
					? cur.sparkPrev
					: undefined,
				sample,
			),
			sparkPrev: sample,
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
		case "decoder:stopped": {
			const started = ev.type === "decoder:started"
			return withPolls(
				observe(
					s,
					actionKey({ kind: "decoder", decoderId: ev.decoderId }),
					at,
					decoderSeen(started, started),
				),
				["decoders"],
			)
		}
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
			const known = own(s.session, d.id)
			const base = known ?? newSession(at)
			const tracked = trackSuspending(base, d, at)
			const sess =
				prev !== undefined && prev.health !== d.health
					? { ...tracked, previousHealth: prev.health }
					: tracked
			const session =
				sess !== base || known === undefined
					? put(s.session, d.id, sess)
					: s.session
			return observe(
				{ ...s, decoders, session },
				actionKey({ kind: "decoder", decoderId: d.id }),
				at,
				decoderSeen(d.running, false, d.startMode),
			)
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
		case "source:removed": {
			// A11 (R95): the row, its tuner and its live counters go; a later
			// source:status or REST list brings it back (latest wins).
			const id = ev.sourceId
			const has =
				s.sources.value?.some(x => x.id === id) === true ||
				s.tuner.value?.some(t => t.sourceId === id) === true ||
				own(s.metrics, id) !== undefined
			if (!has) return s
			const metrics = record<AppState["metrics"][string]>()
			for (const [k, m] of Object.entries(s.metrics))
				if (k !== id) metrics[k] = m
			return {
				...s,
				sources: s.sources.value
					? { ...s.sources, value: s.sources.value.filter(x => x.id !== id) }
					: s.sources,
				tuner: s.tuner.value
					? {
							...s.tuner,
							value: s.tuner.value.filter(t => t.sourceId !== id),
						}
					: s.tuner,
				metrics,
			}
		}
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
			const next =
				patched === s.tuner
					? s
					: {
							...s,
							tuner: { ...patched, receivedAt: at, origin: "ws" as const },
						}
			// It also reconciles a control-mode write to that mode (R55 minor 3).
			return observe(
				next,
				actionKey({ kind: "tuner", sourceId: ev.sourceId }),
				at,
				rec => {
					const cmds = rec.intent.kind === "tuner" ? rec.intent.commands : []
					const only = cmds.length === 1 ? cmds[0] : undefined
					return only?.setting === "control-mode" &&
						only.body["mode"] === ev.mode
						? "confirms"
						: "nothing"
				},
			)
		}
		case "tuner:command-sent":
			return observe(
				{
					...s,
					tunerLastCommand: put(s.tunerLastCommand, ev.sourceId, {
						command: ev.command,
						value: ev.value,
						at,
					}),
				},
				actionKey({ kind: "tuner", sourceId: ev.sourceId }),
				at,
				tunerSeen(ev.command, ev.value),
			)
		case "live-audio:status":
			return { ...s, audio: laneOk(ev.status, at, "ws") }
		case "live-audio:config": {
			const cur = s.audio.value
			const config = ev.config
			return observe(
				cur ? { ...s, audio: laneOk({ ...cur, config }, at, "ws") } : s,
				actionKey({ kind: "preset" }),
				at,
				rec =>
					rec.intent.kind === "preset" && matchesPatch(config, rec.intent.patch)
						? "confirms"
						: "nothing",
			)
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
		case "live-audio:started":
		case "live-audio:stopped": {
			const op = ev.type === "live-audio:started" ? "start" : "stop"
			return observe(s, actionKey({ kind: "audio" }), at, rec =>
				rec.intent.kind === "audio" && rec.intent.op === op
					? "confirms"
					: "nothing",
			)
		}
		// The POST response carries tuner and audio failures; these frames add nothing the CLI shows.
		case "tuner:error":
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
	return withResync(
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

/** What a reconciling event says about a pending action. */
type Seen = "confirms" | "not-running" | "nothing"

/** rtl_tcp command name and value core emits in tuner:command-sent (src/core/tuner-controller.ts). */
function rtlCommand(cmd: TunerCommand): { name: string; value: number } | null {
	const b = cmd.body
	const bit = (v: unknown): number => (v === true ? 1 : 0)
	switch (cmd.setting) {
		case "frequency":
			return { name: "set-frequency", value: Number(b["hz"]) }
		case "sample-rate":
			return { name: "set-sample-rate", value: Number(b["hz"]) }
		case "gain-mode":
			return { name: "set-gain-mode", value: b["mode"] === "manual" ? 1 : 0 }
		case "gain":
			return { name: "set-gain", value: Number(b["tenthsDb"]) }
		case "ppm": {
			const ppm = Number(b["ppm"])
			return {
				name: "set-freq-correction",
				value: ppm < 0 ? 0xffffffff + ppm + 1 : ppm,
			}
		}
		case "agc":
			return { name: "set-agc-mode", value: bit(b["enabled"]) }
		case "bias-tee":
			return { name: "set-bias-tee", value: bit(b["enabled"]) }
		case "offset-tuning":
			return { name: "set-offset-tuning", value: bit(b["enabled"]) }
		case "direct-sampling":
			return {
				name: "set-direct-sampling",
				value: b["mode"] === "i" ? 1 : b["mode"] === "q" ? 2 : 0,
			}
		case "tuner-gain-index":
			return { name: "set-tuner-gain-index", value: Number(b["index"]) }
		case "control-mode":
			return null
	}
}

/** The result says the sequence's last command was not sent (an earlier one halted it). */
function lastUnsent(outcomes: readonly CommandOutcome[]): boolean {
	return outcomes.length > 0 && outcomes[outcomes.length - 1]?.result === null
}

/**
 * tuner:command-sent confirms a tuner write when it is the intent's last command with
 * the value sent: a single command, or the end of a sequence that ran to the end (R55).
 * A sequence halted before its last command is never confirmed by an earlier one.
 */
function tunerSeen(
	command: string,
	value: unknown,
): (rec: ActionRecord) => Seen {
	return rec => {
		if (rec.intent.kind !== "tuner") return "nothing"
		// A sequence whose last command was never sent cannot be confirmed (R55 minor 2).
		if (lastUnsent(rec.outcomes)) return "nothing"
		const last = rec.intent.commands[rec.intent.commands.length - 1]
		const want = last ? rtlCommand(last) : null
		return want !== null && want.name === command && want.value === value
			? "confirms"
			: "nothing"
	}
}

/**
 * A decoder event, read against a pending decoder action: stop needs not running, start
 * needs running. A restart is confirmed only by decoder:started, or by running after a
 * not-running observation for this send (R47 M4): a stale running status says nothing.
 * R100: a return to auto is confirmed by a status that reads startMode "auto" (it may
 * then be band-suspended, so running says nothing); lifecycle events never confirm it.
 */
function decoderSeen(
	running: boolean,
	started: boolean,
	startMode?: string,
): (rec: ActionRecord) => Seen {
	return rec => {
		if (rec.intent.kind !== "decoder") return "nothing"
		switch (rec.intent.op) {
			case "stop":
				return running ? "nothing" : "confirms"
			case "start":
				return running ? "confirms" : "nothing"
			case "restart":
				if (!running) return "not-running"
				return started || rec.sawNotRunning ? "confirms" : "nothing"
			case "unpin":
				return startMode === "auto" ? "confirms" : "nothing"
		}
	}
}

/** Every patched field has that value in the new config. */
function matchesPatch<T extends object>(config: T, patch: Partial<T>): boolean {
	return (Object.keys(patch) as Array<keyof T>).every(
		k => config[k] === patch[k],
	)
}

/**
 * Apply a reconciling event to the action under `key`. A confirmation sets confirmedAt
 * and turns an unknown write (R23) ok; one that arrives while the request is in flight
 * makes a later unknown result ok. no-reply is terminal: a late event is not attributed.
 */
function observe(
	s: AppState,
	key: string,
	at: number,
	judge: (rec: ActionRecord) => Seen,
): AppState {
	const rec = own(s.actions.byKey, key)
	if (!rec || rec.confirmedAt !== null || rec.state === "no-reply") return s
	const seen = judge(rec)
	if (seen === "nothing") return s
	if (seen === "not-running") {
		return rec.sawNotRunning
			? s
			: {
					...s,
					actions: {
						...s.actions,
						byKey: put(s.actions.byKey, key, { ...rec, sawNotRunning: true }),
					},
				}
	}
	const resolve = rec.state === "unknown"
	const intent = rec.intent
	return {
		...s,
		actions: {
			byKey: put(s.actions.byKey, key, {
				...rec,
				confirmedAt: at,
				...(resolve ? { state: "ok" as const, doneAt: at } : {}),
			}),
			stoppedByCli:
				resolve && intent.kind === "decoder"
					? stoppedAfter(s.actions.stoppedByCli, intent.op, intent.decoderId)
					: s.actions.stoppedByCli,
		},
	}
}

/** Unknown writes that nothing reconciled within NO_REPLY_MS end as no-reply (R47 M5). */
function expireActions(s: AppState, now: number): AppState {
	let byKey: Record<string, ActionRecord> | null = null
	for (const [key, rec] of Object.entries(s.actions.byKey)) {
		if (rec.state !== "unknown" || rec.resultAt === null) continue
		if (now - rec.resultAt < NO_REPLY_MS) continue
		byKey = put(byKey ?? s.actions.byKey, key, {
			...rec,
			state: "no-reply",
			doneAt: now,
		})
	}
	return byKey === null ? s : { ...s, actions: { ...s.actions, byKey } }
}

function reduceActionResult(
	s: AppState,
	item: Extract<Inbound, { kind: "action:result" }>,
): AppState {
	const rec = own(s.actions.byKey, item.key)
	// A result answers only its own send; a newer send on the key owns the record (M6).
	if (!rec || rec.id !== item.id) return s
	const results = item.outcomes.map(o => o.result)
	// null = not sent (an earlier command failed or was unknown): only the sent ones count.
	const failed =
		results.every(r => r === null) || results.some(r => r?.outcome === "failed")
	const unknown = !failed && results.some(r => r?.outcome === "unknown")
	// A confirmation seen in flight does not count for a sequence halted before its
	// last command: an earlier or foreign command-sent cannot vouch for it (R55 minor 2).
	const confirmedAt =
		rec.intent.kind === "tuner" && lastUnsent(item.outcomes)
			? null
			: rec.confirmedAt
	// R23: no reply is not a failure; it waits as "unknown" until an event confirms it.
	const state: ActionState = failed
		? "failed"
		: unknown && confirmedAt === null
			? "unknown"
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
					confirmedAt,
					outcomes: item.outcomes,
					resultAt: item.at,
					doneAt: state === "unknown" ? null : item.at,
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
						id: item.id,
						key: item.key,
						intent: item.intent,
						sentAt: item.at,
						state: "sent",
						outcomes: [],
						resultAt: null,
						doneAt: null,
						confirmedAt: null,
						sawNotRunning: false,
					}),
				},
			}
		case "action:result":
			return reduceActionResult(s, item)
	}
}

/**
 * Fold a batch of inbound items. `now` advances (stale aircraft are pruned and unknown
 * writes expire) only when a 1 s boundary has passed, before the batch is applied, so
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
		s = expireActions({ ...s, now }, now)
		if (aircraftPrune(s.aircraft.map, now) > 0) {
			s = { ...s, aircraft: { ...s.aircraft, version: s.aircraft.version + 1 } }
		}
	}
	for (const item of batch) s = reduceOne(s, item, deps)
	return s
}
