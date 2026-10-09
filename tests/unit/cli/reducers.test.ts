import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type {
	AircraftState,
	FanoutSnapshot,
	LiveAudioConfig,
} from "@wavekit/api-types"
import {
	NO_REPLY_MS,
	initialState,
	reduce,
} from "../../../cli/source/data/reducers.js"
import type {
	AppState,
	CommandOutcome,
	DecoderRow,
	Inbound,
	RestInbound,
	SourceRow,
	WriteIntent,
} from "../../../cli/source/data/types.js"

const T0 = 1_000_000

const decoder = (over: Partial<DecoderRow> = {}): DecoderRow => ({
	id: "readsb",
	type: "readsb",
	running: true,
	health: "running",
	uptime: 51,
	stats: { bytesIn: 1, eventsOut: 0, errors: 0 },
	restartCount: 0,
	...over,
})
const fanout = (
	t: number,
	offered: number,
	dropped: number,
): FanoutSnapshot => ({
	timestamp: new Date(t).toISOString(),
	branches: [
		{
			id: "decoder-readsb",
			decoderId: "readsb",
			backpressureActive: false,
			backpressureEnterCount: 0,
			droppedBytesTotal: dropped,
			droppedChunksTotal: 0,
			bufferBytes: 0,
			highWaterMark: 0,
			totalBytesWritten: offered,
		},
	],
	backpressureActiveCount: 0,
	droppedBytesTotal: dropped,
	droppedChunksTotal: 0,
	totalBytesWritten: offered,
})
const ac = (icao: string): AircraftState => ({
	icao,
	seen: 0,
	messages: 1,
	firstSeen: 0,
	lastUpdated: 0,
})

const restOk = (at: number, rows: DecoderRow[]): Inbound =>
	({
		kind: "rest",
		endpoint: "decoders",
		outcome: { ok: true, value: rows, rejected: 0 },
		at,
	}) as RestInbound
const output = (at: number, decoderId = "dsd-fme"): Inbound => ({
	kind: "ws",
	at,
	event: {
		type: "decoder:output",
		decoderId,
		output: { type: "call_end", decoder: decoderId, timestamp: "t", data: {} },
	},
})

/** A pool of inbound factories; P18/P19 draw sequences from it. */
const POOL: Array<(at: number) => Inbound> = [
	at =>
		restOk(at, [
			decoder({
				stats: { bytesIn: 1, eventsOut: Math.floor(at / 1000), errors: 0 },
			}),
		]),
	at =>
		({
			kind: "rest",
			endpoint: "status",
			outcome: {
				ok: false,
				error: { kind: "network", message: "ECONNREFUSED", at },
			},
			at,
		}) as RestInbound,
	at => output(at),
	at => ({
		kind: "ws",
		at,
		event: { type: "fanout:snapshot", snapshot: fanout(at, at * 10, at) },
	}),
	at => ({
		kind: "ws",
		at,
		event: { type: "decoder:health", decoderId: "readsb", health: "idle" },
	}),
	at => ({
		kind: "ws",
		at,
		event: {
			type: "metrics",
			sourceId: "pi-iq",
			bytesReceived: at,
			dataRate: 3994,
		},
	}),
	at => ({
		kind: "ws",
		at,
		event: { type: "aircraft:update", aircraft: ac(`a${at % 3}`) },
	}),
	at => ({
		kind: "ws",
		at,
		event: {
			type: "resources:alert",
			alert: {
				type: "container-cpu",
				severity: "critical",
				message: "High CPU usage: 273.5%",
				timestamp: "t",
			},
		},
	}),
	at => ({
		kind: "ws:close",
		at,
		code: 1006,
		reason: "",
		nextRetryAt: at + 1000,
	}),
	at => ({ kind: "ws:open", at }),
	at => ({ kind: "ws:invalid", at }),
	// R47 M9: status events, actions and server-time timestamps (server clock ahead).
	at => restSources(at, [source({ bytesReceived: at })]),
	at =>
		ws(at, {
			type: "source:status",
			source: source({ connected: (at / 100) % 2 === 0, bytesReceived: at }),
		}),
	at =>
		ws(at, {
			type: "decoder:status",
			decoder: decoder({
				running: at % 3 !== 0,
				health: at % 3 !== 0 ? "running" : "idle",
			}),
		}),
	at => ({
		kind: "ws",
		at,
		event: {
			type: "decoder:output",
			decoderId: "readsb",
			output: {
				type: "aircraft",
				decoder: "readsb",
				timestamp: new Date(at + 3_600_000).toISOString(),
				data: {},
			},
		},
	}),
	at => ({
		kind: "action:sent",
		at,
		id: 1 + ((at / 100) % 2),
		key: "decoder:readsb",
		intent: { kind: "decoder", op: "restart", decoderId: "readsb" },
	}),
	at => ({
		kind: "action:result",
		at,
		id: 1 + ((at / 100) % 2),
		key: "decoder:readsb",
		outcomes: [
			{
				label: "restart",
				at,
				result:
					at % 3 === 0
						? { ok: true, outcome: "ok", status: 200, message: "ok" }
						: {
								ok: false,
								outcome: "unknown",
								status: null,
								message: "sent · no reply in 10s",
							},
			},
		],
	}),
	at => ws(at, { type: "decoder:started", decoderId: "readsb" }),
	at => ws(at, { type: "decoder:stopped", decoderId: "readsb" }),
	at => ({
		kind: "action:sent",
		at,
		id: 3,
		key: "audio",
		intent: { kind: "audio", op: "start" },
	}),
	at => ws(at, { type: "live-audio:started" }),
]

const comparable = (s: AppState) =>
	JSON.stringify({
		...s,
		aircraft: { ...s.aircraft, map: [...s.aircraft.map.entries()] },
	})

const seq = fc.array(fc.integer({ min: 0, max: POOL.length - 1 }), {
	maxLength: 60,
})
const build = (picks: number[]): Inbound[] =>
	picks.map((p, i) => POOL[p]!(T0 + i * 100))

describe("reduce", () => {
	// Feature: cli-dashboard-overhaul, Property 18: batched reduce
	// Validates: spec §10.5
	it("P18: reduce(s, batch) equals folding reduce over single events", () => {
		fc.assert(
			fc.property(seq, picks => {
				// An empty batch still advances `now` (pinned below); folding zero items cannot.
				fc.pre(picks.length > 0)
				const items = build(picks)
				const now = T0 + 10_000
				const batched = reduce(initialState(T0), items, now)
				const folded = items.reduce(
					(s, item) => reduce(s, [item], now),
					initialState(T0),
				)
				expect(comparable(batched)).toBe(comparable(folded))
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 19: reconnect
	// Validates: spec §10.5, §10.8
	it("P19: one gap per disconnect with from ≤ to; histories empty after ws:open", () => {
		fc.assert(
			fc.property(seq, picks => {
				const items: Inbound[] = [
					{ kind: "ws:open", at: T0 - 1 },
					...build(picks),
				]
				let s = initialState(T0)
				let open = true
				let disconnects = 0
				for (const item of items) {
					s = reduce(s, [item], T0 + 10_000)
					if (item.kind === "ws:close" && open) disconnects++
					if (item.kind === "ws:close") open = false
					if (item.kind === "ws:open") {
						open = true
						expect(s.fanoutHistory).toEqual([])
						for (const sess of Object.values(s.session))
							expect(sess.events).toEqual([])
					}
				}
				const gaps = s.messages.ring.gaps
				expect(gaps.length).toBeLessThanOrEqual(disconnects)
				for (const g of gaps)
					if (g.to !== null) expect(g.from).toBeLessThanOrEqual(g.to)
			}),
			{ numRuns: 100 },
		)
	})

	it("counts exactly one gap per disconnect while entries are retained", () => {
		let s = reduce(
			initialState(T0),
			[{ kind: "ws:open", at: T0 }, output(T0 + 1)],
			T0 + 2,
		)
		s = reduce(
			s,
			[
				{
					kind: "ws:close",
					at: T0 + 10,
					code: 1006,
					reason: "",
					nextRetryAt: T0 + 1010,
				},
				{
					kind: "ws:close",
					at: T0 + 20,
					code: 1006,
					reason: "",
					nextRetryAt: T0 + 1020,
				},
			],
			T0 + 30,
		)
		s = reduce(s, [{ kind: "ws:open", at: T0 + 50 }], T0 + 60)
		expect(s.messages.ring.gaps).toEqual([
			{ afterSeq: 0, from: T0 + 1, to: T0 + 50 },
		])
	})

	it("replaces aircraft keys with the REST resync list", () => {
		let s = reduce(
			initialState(T0),
			[
				{
					kind: "ws",
					at: T0,
					event: { type: "aircraft:new", aircraft: ac("zzz") },
				},
			],
			T0,
		)
		s = reduce(
			s,
			[
				{
					kind: "rest",
					endpoint: "aircraft",
					at: T0 + 1,
					outcome: {
						ok: true,
						rejected: 0,
						value: {
							aircraft: [ac("abc"), ac("def")],
							timestamp: 1,
							stats: {
								aircraftCount: 2,
								withPosition: 0,
								withCallsign: 0,
								enrichedCount: 0,
								messagesProcessed: 0,
								messagesPerSecond: 0,
								enrichmentCache: { hits: 0, misses: 0, size: 0 },
							},
						},
					},
				} as RestInbound,
			],
			T0 + 1,
		)
		expect([...s.aircraft.map.keys()].sort()).toEqual(["ABC", "DEF"])
	})

	it("records previousHealth itself (core never sends it)", () => {
		let s = reduce(
			initialState(T0),
			[restOk(T0, [decoder({ health: "running" })])],
			T0,
		)
		s = reduce(
			s,
			[
				{
					kind: "ws",
					at: T0 + 1,
					event: {
						type: "decoder:health",
						decoderId: "readsb",
						health: "idle",
					},
				},
			],
			T0 + 1,
		)
		expect(s.decoders.value?.[0]?.health).toBe("idle")
		expect(s.session["readsb"]?.previousHealth).toBe("running")
		expect(s.decoders.receivedAt).toBe(T0)
	})

	it("keeps cached values on REST errors and clears the error on success", () => {
		let s = reduce(initialState(T0), [restOk(T0, [decoder()])], T0)
		s = reduce(
			s,
			[
				{
					kind: "rest",
					endpoint: "decoders",
					at: T0 + 5000,
					outcome: {
						ok: false,
						error: { kind: "timeout", message: "timeout 2s", at: T0 + 5000 },
					},
				} as RestInbound,
			],
			T0 + 5000,
		)
		expect(s.decoders.value).toHaveLength(1)
		expect(s.decoders.error?.kind).toBe("timeout")
		expect(s.conn.rest.failing).toEqual(["decoders"])
		s = reduce(s, [restOk(T0 + 10000, [decoder()])], T0 + 10000)
		expect(s.decoders.error).toBeUndefined()
		expect(s.conn.rest.failing).toEqual([])
		expect(s.conn.rest.lastOkAt).toBe(T0 + 10000)
	})

	it("schedules polls as effects and resolves decoder actions", () => {
		let s = reduce(
			initialState(T0),
			[
				{
					kind: "action:sent",
					id: 1,
					at: T0,
					key: "decoder:readsb",
					intent: { kind: "decoder", op: "stop", decoderId: "readsb" },
				},
			],
			T0,
		)
		s = reduce(
			s,
			[
				{
					kind: "action:result",
					id: 1,
					at: T0 + 10,
					key: "decoder:readsb",
					outcomes: [
						{
							label: "stop",
							result: { ok: true, outcome: "ok", status: 200, message: "ok" },
							at: T0 + 10,
						},
					],
				},
			],
			T0 + 10,
		)
		expect(s.actions.byKey["decoder:readsb"]?.state).toBe("ok")
		expect(s.actions.stoppedByCli).toEqual(["readsb"])
		expect(s.effects.polls).toEqual(["decoders"])
		s = reduce(
			s,
			[
				{
					kind: "ws",
					at: T0 + 20,
					event: { type: "decoder:stopped", decoderId: "readsb" },
				},
			],
			T0 + 20,
		)
		expect(s.actions.byKey["decoder:readsb"]?.confirmedAt).toBe(T0 + 20)
	})

	it("dedupes alerts by (type, sourceId, severity)", () => {
		const alert: Inbound = {
			kind: "ws",
			at: T0,
			event: {
				type: "resources:alert",
				alert: {
					type: "container-cpu",
					severity: "critical",
					message: "High CPU usage: 273.5%",
					timestamp: "t",
				},
			},
		}
		const s = reduce(
			initialState(T0),
			[alert, { ...alert, at: T0 + 5 }],
			T0 + 5,
		)
		expect(s.alerts).toHaveLength(1)
		expect(s.alerts[0]).toMatchObject({ count: 2, firstAt: T0, lastAt: T0 + 5 })
	})

	it("an empty batch only advances now across a 1 s boundary", () => {
		const s = initialState(T0)
		expect(reduce(s, [], T0 + 10_000)).toMatchObject({ now: T0 + 10_000 })
		expect(reduce(s, [], T0 + 999)).toBe(s)
	})

	it("returns the same object when nothing changed", () => {
		const s = initialState(T0)
		expect(reduce(s, [], T0 + 500)).toBe(s)
	})
})

const source = (over: Partial<SourceRow> = {}): SourceRow => ({
	id: "pi-iq",
	connected: true,
	consumers: 2,
	bytesReceived: 1,
	dataRate: 3994,
	reconnectAttempts: 0,
	available: true,
	caps: { kind: "iq", sampleRate: 2048000, format: "U8_IQ", exclusive: false },
	assignments: [],
	activity: {
		state: "streaming",
		lastSampleAt: null,
		sampleAgeMs: 4,
		timeoutMs: 10000,
	},
	...over,
})
const restSources = (at: number, rows: SourceRow[]): Inbound =>
	({
		kind: "rest",
		endpoint: "sources",
		outcome: { ok: true, value: rows, rejected: 0 },
		at,
	}) as RestInbound
const ws = (
	at: number,
	event: Extract<Inbound, { kind: "ws" }>["event"],
): Inbound => ({ kind: "ws", at, event })

describe("R15: status events", () => {
	it("source:status replaces the row (never merges) and refreshes the lane (R30)", () => {
		const { activity: _a, ...bare } = source()
		let s = reduce(
			initialState(T0),
			[
				restSources(T0, [
					{ ...bare, activityUnrecognised: true },
					source({ id: "b" }),
				]),
			],
			T0,
		)
		s = reduce(
			s,
			[
				ws(T0 + 9000, {
					type: "source:status",
					source: source({ dataRate: 10 }),
				}),
			],
			T0 + 9000,
		)
		expect(s.sources.value?.[0]).toEqual(source({ dataRate: 10 }))
		expect(s.sources.value?.[0]).not.toHaveProperty("activityUnrecognised")
		expect(s.sources.value?.[1]?.id).toBe("b")
		expect(s.sources.receivedAt).toBe(T0 + 9000)
		expect(s.sources.origin).toBe("ws")
		s = reduce(
			s,
			[ws(T0 + 9500, { type: "source:status", source: source({ id: "new" }) })],
			T0 + 9500,
		)
		expect(s.sources.value?.map(x => x.id)).toEqual(["pi-iq", "b", "new"])
	})
	it("source:status before any REST answer leaves the lane unknown", () => {
		const s = reduce(
			initialState(T0),
			[ws(T0, { type: "source:status", source: source() })],
			T0,
		)
		expect(s.sources.value).toBeUndefined()
	})
	it("REST sources replace rows too", () => {
		const { activity: _a, ...bare } = source()
		let s = reduce(
			initialState(T0),
			[restSources(T0, [{ ...bare, activityUnrecognised: true }])],
			T0,
		)
		s = reduce(s, [restSources(T0 + 5000, [source()])], T0 + 5000)
		expect(s.sources.value?.[0]).not.toHaveProperty("activityUnrecognised")
	})
	it("decoder:status replaces the row, records previousHealth, keeps receivedAt", () => {
		let s = reduce(
			initialState(T0),
			[restOk(T0, [decoder(), decoder({ id: "ais" })])],
			T0,
		)
		const next = decoder({
			running: false,
			health: "idle",
			restartCount: 3,
			lastError: { kind: "exit", message: "code 1", at: "t" },
		})
		s = reduce(
			s,
			[ws(T0 + 100, { type: "decoder:status", decoder: next })],
			T0 + 100,
		)
		expect(s.decoders.value?.[0]).toEqual(next)
		expect(s.decoders.value?.[1]?.id).toBe("ais")
		expect(s.decoders.receivedAt).toBe(T0)
		expect(s.session["readsb"]?.previousHealth).toBe("running")
		// Latest wins; an unknown id is appended.
		s = reduce(
			s,
			[
				ws(T0 + 200, {
					type: "decoder:status",
					decoder: decoder({ running: true, uptime: 1 }),
				}),
				ws(T0 + 201, {
					type: "decoder:status",
					decoder: decoder({ id: "acars" }),
				}),
			],
			T0 + 201,
		)
		expect(s.decoders.value?.map(d => [d.id, d.uptime])).toEqual([
			["readsb", 1],
			["ais", 51],
			["acars", 51],
		])
	})
})

const result = (outcome: "ok" | "failed" | "unknown"): CommandOutcome => ({
	label: "stop",
	at: T0 + 10,
	result: {
		ok: outcome === "ok",
		outcome,
		status: outcome === "unknown" ? null : outcome === "ok" ? 200 : 500,
		message: outcome === "unknown" ? "sent · no reply in 10s" : "x",
	},
})

describe("R23: unknown write outcomes", () => {
	const sent = (op: "stop" | "restart"): Inbound => ({
		kind: "action:sent",
		id: 1,
		at: T0,
		key: "decoder:readsb",
		intent: { kind: "decoder", op, decoderId: "readsb" },
	})
	const res = (o: CommandOutcome): Inbound => ({
		kind: "action:result",
		id: 1,
		at: T0 + 10,
		key: "decoder:readsb",
		outcomes: [o],
	})
	it("an unknown outcome waits as unknown until an event confirms it", () => {
		let s = reduce(
			initialState(T0),
			[sent("stop"), res(result("unknown"))],
			T0 + 10,
		)
		expect(s.actions.byKey["decoder:readsb"]).toMatchObject({
			state: "unknown",
			doneAt: null,
			confirmedAt: null,
		})
		expect(s.actions.stoppedByCli).toEqual([])
		s = reduce(
			s,
			[ws(T0 + 20, { type: "decoder:stopped", decoderId: "readsb" })],
			T0 + 20,
		)
		expect(s.actions.byKey["decoder:readsb"]).toMatchObject({
			state: "ok",
			doneAt: T0 + 20,
			confirmedAt: T0 + 20,
		})
		expect(s.actions.stoppedByCli).toEqual(["readsb"])
	})
	it("decoder:status with the target running state also confirms", () => {
		let s = reduce(
			initialState(T0),
			[sent("stop"), res(result("unknown"))],
			T0 + 10,
		)
		s = reduce(
			s,
			[
				ws(T0 + 30, {
					type: "decoder:status",
					decoder: decoder({ running: true }),
				}),
			],
			T0 + 30,
		)
		expect(s.actions.byKey["decoder:readsb"]?.state).toBe("unknown")
		s = reduce(
			s,
			[
				ws(T0 + 40, {
					type: "decoder:status",
					decoder: decoder({ running: false }),
				}),
			],
			T0 + 40,
		)
		expect(s.actions.byKey["decoder:readsb"]).toMatchObject({
			state: "ok",
			confirmedAt: T0 + 40,
		})
	})
	it("a restart is confirmed by started, not by the stop on the way", () => {
		let s = reduce(
			initialState(T0),
			[sent("restart"), res(result("unknown"))],
			T0 + 10,
		)
		s = reduce(
			s,
			[ws(T0 + 20, { type: "decoder:stopped", decoderId: "readsb" })],
			T0 + 20,
		)
		expect(s.actions.byKey["decoder:readsb"]?.confirmedAt).toBeNull()
		s = reduce(
			s,
			[ws(T0 + 30, { type: "decoder:started", decoderId: "readsb" })],
			T0 + 30,
		)
		expect(s.actions.byKey["decoder:readsb"]).toMatchObject({
			state: "ok",
			confirmedAt: T0 + 30,
		})
	})
	it("a confirmation that arrives before an unknown result makes it ok", () => {
		let s = reduce(
			initialState(T0),
			[
				sent("stop"),
				ws(T0 + 5, { type: "decoder:stopped", decoderId: "readsb" }),
			],
			T0 + 5,
		)
		s = reduce(s, [res(result("unknown"))], T0 + 10)
		expect(s.actions.byKey["decoder:readsb"]?.state).toBe("ok")
		expect(s.actions.stoppedByCli).toEqual(["readsb"])
	})
	it("an unknown outcome followed by not-sent commands stays unknown", () => {
		const s = reduce(
			initialState(T0),
			[
				{
					kind: "action:sent",
					id: 1,
					at: T0,
					key: "tuner:pi-iq",
					intent: { kind: "tuner", sourceId: "pi-iq", commands: [] },
				},
				{
					kind: "action:result",
					id: 1,
					at: T0 + 10,
					key: "tuner:pi-iq",
					outcomes: [
						{ ...result("unknown"), label: "frequency" },
						{ label: "gain", result: null, at: null },
					],
				},
			],
			T0 + 10,
		)
		expect(s.actions.byKey["tuner:pi-iq"]?.state).toBe("unknown")
	})
	it("no command sent at all is failed", () => {
		const s = reduce(
			initialState(T0),
			[
				{
					kind: "action:sent",
					id: 1,
					at: T0,
					key: "audio",
					intent: { kind: "audio", op: "start" },
				},
				{
					kind: "action:result",
					id: 1,
					at: T0 + 10,
					key: "audio",
					outcomes: [{ label: "start", result: null, at: null }],
				},
			],
			T0 + 10,
		)
		expect(s.actions.byKey["audio"]?.state).toBe("failed")
	})
	it("a failed outcome is failed", () => {
		const s = reduce(
			initialState(T0),
			[sent("stop"), res(result("failed"))],
			T0 + 10,
		)
		expect(s.actions.byKey["decoder:readsb"]?.state).toBe("failed")
	})
})

describe("R47: action correlation and reconciliation", () => {
	const sendAs = (id: number, key: string, intent: WriteIntent): Inbound => ({
		kind: "action:sent",
		at: T0,
		id,
		key,
		intent,
	})
	const resultAs = (
		id: number,
		key: string,
		o: CommandOutcome,
		at = T0 + 10,
	): Inbound => ({ kind: "action:result", at, id, key, outcomes: [o] })
	const restart = sendAs(1, "decoder:readsb", {
		kind: "decoder",
		op: "restart",
		decoderId: "readsb",
	})
	const status = (at: number, running: boolean): Inbound =>
		ws(at, { type: "decoder:status", decoder: decoder({ running }) })

	it("M4: a running status before any not-running observation does not confirm a restart", () => {
		let s = reduce(
			initialState(T0),
			[restart, resultAs(1, "decoder:readsb", result("unknown"))],
			T0 + 10,
		)
		s = reduce(s, [status(T0 + 20, true)], T0 + 20)
		expect(s.actions.byKey["decoder:readsb"]).toMatchObject({
			state: "unknown",
			confirmedAt: null,
		})
		s = reduce(s, [status(T0 + 30, false)], T0 + 30)
		expect(s.actions.byKey["decoder:readsb"]?.confirmedAt).toBeNull()
		s = reduce(s, [status(T0 + 40, true)], T0 + 40)
		expect(s.actions.byKey["decoder:readsb"]).toMatchObject({
			state: "ok",
			confirmedAt: T0 + 40,
		})
	})

	it("M4: a running status while the restart is in flight does not confirm it either", () => {
		let s = reduce(initialState(T0), [restart, status(T0 + 5, true)], T0 + 5)
		s = reduce(s, [resultAs(1, "decoder:readsb", result("unknown"))], T0 + 10)
		expect(s.actions.byKey["decoder:readsb"]?.state).toBe("unknown")
	})

	it("M5: in flight is sent; an unknown reply waits, then becomes no-reply after NO_REPLY_MS", () => {
		const key = "audio"
		let s = reduce(
			initialState(T0),
			[sendAs(1, key, { kind: "audio", op: "start" })],
			T0,
		)
		expect(s.actions.byKey[key]?.state).toBe("sent")
		s = reduce(s, [resultAs(1, key, result("unknown"), T0 + 10)], T0 + 10)
		expect(s.actions.byKey[key]).toMatchObject({
			state: "unknown",
			resultAt: T0 + 10,
			doneAt: null,
		})
		s = reduce(s, [], T0 + 10 + NO_REPLY_MS - 1000)
		expect(s.actions.byKey[key]?.state).toBe("unknown")
		const at = T0 + 10 + NO_REPLY_MS + 1000
		s = reduce(s, [], at)
		expect(s.actions.byKey[key]).toMatchObject({
			state: "no-reply",
			doneAt: at,
		})
		// Terminal: a later event is not attributed to this write.
		s = reduce(s, [ws(at + 1, { type: "live-audio:started" })], at + 1)
		expect(s.actions.byKey[key]?.state).toBe("no-reply")
	})

	it("M5: live-audio:started / stopped reconcile an unknown audio write", () => {
		let s = reduce(
			initialState(T0),
			[
				sendAs(1, "audio", { kind: "audio", op: "stop" }),
				resultAs(1, "audio", result("unknown")),
				ws(T0 + 20, { type: "live-audio:started" }),
			],
			T0 + 20,
		)
		expect(s.actions.byKey["audio"]?.state).toBe("unknown")
		s = reduce(s, [ws(T0 + 30, { type: "live-audio:stopped" })], T0 + 30)
		expect(s.actions.byKey["audio"]).toMatchObject({
			state: "ok",
			confirmedAt: T0 + 30,
			doneAt: T0 + 30,
		})
	})

	it("M5: a live-audio:config matching the patch reconciles an unknown preset", () => {
		const config: LiveAudioConfig = {
			enabled: true,
			httpPort: 8090,
			modulation: "nfm",
			bandwidth: 12_500,
			squelch: -50,
			noiseReduction: "off",
			lowPass: 3000,
			highPass: 300,
			gain: 1,
			deEmphasis: false,
			deEmphasisTau: 50,
			audioFormat: "s16le",
			iqDcBlock: true,
		}
		let s = reduce(
			initialState(T0),
			[
				sendAs(1, "preset", {
					kind: "preset",
					name: "nfm",
					patch: { modulation: "nfm", bandwidth: 12_500 },
				}),
				resultAs(1, "preset", result("unknown")),
				ws(T0 + 20, {
					type: "live-audio:config",
					config: { ...config, bandwidth: 25_000 },
				}),
			],
			T0 + 20,
		)
		expect(s.actions.byKey["preset"]?.state).toBe("unknown")
		s = reduce(s, [ws(T0 + 30, { type: "live-audio:config", config })], T0 + 30)
		expect(s.actions.byKey["preset"]?.state).toBe("ok")
	})

	it("M5: an unknown tuner write and an unconfirmed decoder write end as no-reply", () => {
		let s = reduce(
			initialState(T0),
			[
				sendAs(1, "tuner:pi-iq", {
					kind: "tuner",
					sourceId: "pi-iq",
					commands: [],
				}),
				resultAs(1, "tuner:pi-iq", { ...result("unknown"), label: "gain" }),
				sendAs(2, "decoder:readsb", {
					kind: "decoder",
					op: "stop",
					decoderId: "readsb",
				}),
				resultAs(2, "decoder:readsb", result("unknown")),
			],
			T0 + 10,
		)
		s = reduce(s, [], T0 + 10 + NO_REPLY_MS)
		expect(s.actions.byKey["tuner:pi-iq"]?.state).toBe("no-reply")
		expect(s.actions.byKey["decoder:readsb"]?.state).toBe("no-reply")
		expect(s.actions.stoppedByCli).toEqual([])
	})

	it("M6: a second write on the same key never inherits the first one's result", () => {
		const key = "decoder:readsb"
		let s = reduce(
			initialState(T0),
			[
				sendAs(1, key, { kind: "decoder", op: "stop", decoderId: "readsb" }),
				sendAs(2, key, { kind: "decoder", op: "start", decoderId: "readsb" }),
				resultAs(1, key, result("ok")),
			],
			T0 + 10,
		)
		expect(s.actions.byKey[key]).toMatchObject({
			id: 2,
			state: "sent",
			outcomes: [],
			doneAt: null,
		})
		expect(s.actions.stoppedByCli).toEqual([])
		s = reduce(s, [resultAs(2, key, result("failed"), T0 + 20)], T0 + 20)
		expect(s.actions.byKey[key]).toMatchObject({ id: 2, state: "failed" })
	})
})

describe("decode sparkline across reconnects (R47 M12)", () => {
	it("keeps its baseline across ws:open instead of recording a false 0 minute", () => {
		const t2 = T0 + 60_000
		const s = reduce(
			initialState(T0),
			[
				restOk(T0, [
					decoder({ stats: { bytesIn: 1, eventsOut: 10, errors: 0 } }),
				]),
				{ kind: "ws:open", at: T0 + 1 },
				restOk(t2, [
					decoder({ stats: { bytesIn: 1, eventsOut: 25, errors: 0 } }),
				]),
			],
			t2,
		)
		const sess = s.session["readsb"]
		// The rate window still restarts at ws:open (spec §10.5)…
		expect(sess?.events).toEqual([{ t: t2, v: 25 }])
		// …but the 15 decodes since the last sample land in t2's minute.
		expect(sess?.spark[String(Math.floor(t2 / 60_000))]).toBe(15)
	})
})

describe("R30: server-keyed records", () => {
	const ids = ["__proto__", "toString", "constructor"]
	it("decoder, source and branch ids are plain keys", () => {
		let s = reduce(
			initialState(T0),
			[
				restOk(
					T0,
					ids.map(id => decoder({ id })),
				),
			],
			T0,
		)
		for (const id of ids) {
			s = reduce(
				s,
				[
					ws(T0 + 1, { type: "decoder:health", decoderId: id, health: "idle" }),
					ws(T0 + 2, { type: "decoder:error", decoderId: id, error: "boom" }),
					ws(T0 + 3, {
						type: "metrics",
						sourceId: id,
						bytesReceived: 1,
						dataRate: 1,
					}),
					ws(T0 + 4, {
						type: "fanout:backpressure",
						branchId: id,
						bufferedBytes: 1,
						timestamp: "t",
					}),
					ws(T0 + 5, {
						type: "tuner:command-sent",
						sourceId: id,
						command: "freq",
						value: 1,
					}),
				],
				T0 + 5,
			)
		}
		for (const rec of [
			s.session,
			s.metrics,
			s.branchEvents,
			s.tunerLastCommand,
		]) {
			expect(Object.keys(rec).sort()).toEqual([...ids].sort())
		}
		for (const id of ids) {
			expect(s.session[id]?.events).toHaveLength(1)
			expect(s.session[id]?.lastError?.message).toBe("boom")
			expect(s.session[id]?.previousHealth).toBe("running")
		}
		expect(Object.getPrototypeOf({})).toBe(Object.prototype)
	})
	it("a decoder:error for an unseen 'toString' id starts a fresh session", () => {
		const s = reduce(
			initialState(T0),
			[ws(T0, { type: "decoder:error", decoderId: "toString", error: "x" })],
			T0,
		)
		expect(s.session["toString"]).toMatchObject({
			events: [],
			lastError: { message: "x", at: T0 },
		})
	})
})

describe("lastWsOutputAt is server time (minor 7)", () => {
	it("comes from the output timestamp and keeps the newest", () => {
		const out = (at: number, timestamp: string): Inbound => ({
			kind: "ws",
			at,
			event: {
				type: "decoder:output",
				decoderId: "dsd-fme",
				output: { type: "call_end", decoder: "dsd-fme", timestamp, data: {} },
			},
		})
		let s = reduce(initialState(T0), [out(T0, "2099-01-01T00:00:10.000Z")], T0)
		expect(s.session["dsd-fme"]?.lastWsOutputAt).toBe(
			Date.parse("2099-01-01T00:00:10.000Z"),
		)
		s = reduce(
			s,
			[out(T0 + 1, "2099-01-01T00:00:05.000Z"), out(T0 + 2, "not a time")],
			T0 + 2,
		)
		expect(s.session["dsd-fme"]?.lastWsOutputAt).toBe(
			Date.parse("2099-01-01T00:00:10.000Z"),
		)
	})
})

describe("R55 follow-ups", () => {
	const tuner = (
		commands: Extract<WriteIntent, { kind: "tuner" }>["commands"],
	): WriteIntent => ({ kind: "tuner", sourceId: "pi-iq", commands })
	const freq = {
		setting: "frequency" as const,
		body: { hz: 446_000_000 },
		label: "frequency",
	}
	const gain = {
		setting: "gain" as const,
		body: { tenthsDb: 207 },
		label: "gain",
	}
	const sent = (id: number, intent: WriteIntent, at = T0): Inbound => ({
		kind: "action:sent",
		at,
		id,
		key: "tuner:pi-iq",
		intent,
	})
	const outcomes = (
		id: number,
		os: CommandOutcome[],
		at = T0 + 10,
	): Inbound => ({
		kind: "action:result",
		at,
		id,
		key: "tuner:pi-iq",
		outcomes: os,
	})
	const unknown = (label: string): CommandOutcome => ({
		label,
		at: T0 + 10,
		result: {
			ok: false,
			outcome: "unknown",
			status: null,
			message: "sent · no reply in 10s",
		},
	})
	const sentEvent = (at: number, command: string, value: number): Inbound =>
		ws(at, { type: "tuner:command-sent", sourceId: "pi-iq", command, value })

	it("a sparkline baseline older than 2 min is not used (no false spike after an outage)", () => {
		const t2 = T0 + 180_000
		const s = reduce(
			initialState(T0),
			[
				restOk(T0, [
					decoder({ stats: { bytesIn: 1, eventsOut: 10, errors: 0 } }),
				]),
				restOk(t2, [
					decoder({ stats: { bytesIn: 1, eventsOut: 25, errors: 0 } }),
				]),
			],
			t2,
		)
		expect(s.session["readsb"]?.spark[String(Math.floor(t2 / 60_000))]).toBe(0)
		expect(s.session["readsb"]?.sparkPrev).toEqual({ t: t2, v: 25 })
	})

	it("tuner:command-sent with the sent value confirms an unknown single-command write", () => {
		let s = reduce(
			initialState(T0),
			[sent(1, tuner([freq])), outcomes(1, [unknown("frequency")])],
			T0 + 10,
		)
		expect(s.actions.byKey["tuner:pi-iq"]?.state).toBe("unknown")
		s = reduce(s, [sentEvent(T0 + 20, "set-frequency", 445_000_000)], T0 + 20)
		expect(s.actions.byKey["tuner:pi-iq"]?.state).toBe("unknown")
		s = reduce(s, [sentEvent(T0 + 30, "set-frequency", 446_000_000)], T0 + 30)
		expect(s.actions.byKey["tuner:pi-iq"]).toMatchObject({
			state: "ok",
			confirmedAt: T0 + 30,
		})
		expect(s.tunerLastCommand["pi-iq"]).toMatchObject({
			command: "set-frequency",
		})
	})

	it("confirms a sequence only by its last command; a halted sequence stays as it is", () => {
		const halted = reduce(
			initialState(T0),
			[
				sent(1, tuner([freq, gain])),
				outcomes(1, [
					unknown("frequency"),
					{ label: "gain", result: null, at: null },
				]),
				sentEvent(T0 + 20, "set-frequency", 446_000_000),
			],
			T0 + 20,
		)
		expect(halted.actions.byKey["tuner:pi-iq"]?.state).toBe("unknown")
		const full = reduce(
			initialState(T0),
			[
				sent(1, tuner([freq, gain])),
				// The last command's event arrives while the request is in flight.
				sentEvent(T0 + 5, "set-gain", 207),
				outcomes(1, [
					{
						label: "frequency",
						at: T0 + 10,
						result: { ok: true, outcome: "ok", status: 200, message: "ok" },
					},
					unknown("gain"),
				]),
			],
			T0 + 10,
		)
		expect(full.actions.byKey["tuner:pi-iq"]?.state).toBe("ok")
	})

	it("maps every tuner setting to core's command name and value", () => {
		const cases: Array<
			[
				Extract<WriteIntent, { kind: "tuner" }>["commands"][number],
				string,
				number,
			]
		> = [
			[
				{ setting: "ppm", body: { ppm: -3 }, label: "ppm" },
				"set-freq-correction",
				4294967293,
			],
			[
				{ setting: "gain-mode", body: { mode: "agc" }, label: "gain mode" },
				"set-gain-mode",
				0,
			],
			[
				{ setting: "direct-sampling", body: { mode: "q" }, label: "ds" },
				"set-direct-sampling",
				2,
			],
			[
				{ setting: "bias-tee", body: { enabled: true }, label: "bias-t" },
				"set-bias-tee",
				1,
			],
			[
				{ setting: "sample-rate", body: { hz: 2_400_000 }, label: "sr" },
				"set-sample-rate",
				2_400_000,
			],
		]
		for (const [cmd, name, value] of cases) {
			const s = reduce(
				initialState(T0),
				[
					sent(1, tuner([cmd])),
					outcomes(1, [unknown(cmd.label)]),
					sentEvent(T0 + 20, name, value),
				],
				T0 + 20,
			)
			expect(s.actions.byKey["tuner:pi-iq"]?.state, name).toBe("ok")
		}
	})
})

describe("R55 follow-ups fix", () => {
	const send = (intent: WriteIntent): Inbound => ({
		kind: "action:sent",
		at: T0,
		id: 1,
		key: "tuner:pi-iq",
		intent,
	})
	const res = (outcomes: CommandOutcome[], at = T0 + 10): Inbound => ({
		kind: "action:result",
		at,
		id: 1,
		key: "tuner:pi-iq",
		outcomes,
	})
	const unknownOf = (label: string): CommandOutcome => ({
		label,
		at: T0 + 10,
		result: {
			ok: false,
			outcome: "unknown",
			status: null,
			message: "sent · no reply in 10s",
		},
	})
	const seq: WriteIntent = {
		kind: "tuner",
		sourceId: "pi-iq",
		commands: [
			{ setting: "frequency", body: { hz: 446_000_000 }, label: "frequency" },
			{ setting: "gain", body: { tenthsDb: 207 }, label: "gain" },
		],
	}

	it("a sequence whose last command was never sent is not confirmed by an in-flight event", () => {
		const s = reduce(
			initialState(T0),
			[
				send(seq),
				// A foreign client happens to set the same gain while ours is in flight.
				ws(T0 + 5, {
					type: "tuner:command-sent",
					sourceId: "pi-iq",
					command: "set-gain",
					value: 207,
				}),
				res([
					unknownOf("frequency"),
					{ label: "gain", result: null, at: null },
				]),
			],
			T0 + 10,
		)
		expect(s.actions.byKey["tuner:pi-iq"]).toMatchObject({
			state: "unknown",
			confirmedAt: null,
		})
		const later = reduce(
			s,
			[
				ws(T0 + 20, {
					type: "tuner:command-sent",
					sourceId: "pi-iq",
					command: "set-gain",
					value: 207,
				}),
			],
			T0 + 20,
		)
		expect(later.actions.byKey["tuner:pi-iq"]?.state).toBe("unknown")
	})

	it("tuner:control-mode-changed reconciles a control-mode write to that mode", () => {
		const control = (mode: string): WriteIntent => ({
			kind: "tuner",
			sourceId: "pi-iq",
			commands: [{ setting: "control-mode", body: { mode }, label: "control" }],
		})
		const changed = (at: number, mode: "internal" | "external"): Inbound =>
			ws(at, { type: "tuner:control-mode-changed", sourceId: "pi-iq", mode })
		let s = reduce(
			initialState(T0),
			[send(control("internal")), res([unknownOf("control")])],
			T0 + 10,
		)
		s = reduce(s, [changed(T0 + 20, "external")], T0 + 20)
		expect(s.actions.byKey["tuner:pi-iq"]?.state).toBe("unknown")
		s = reduce(s, [changed(T0 + 30, "internal")], T0 + 30)
		expect(s.actions.byKey["tuner:pi-iq"]).toMatchObject({
			state: "ok",
			confirmedAt: T0 + 30,
		})
	})

	it("ws:open asks for the resync set separately from event polls", () => {
		const s = reduce(
			initialState(T0),
			[
				{ kind: "ws:open", at: T0 },
				ws(T0, { type: "decoder:started", decoderId: "readsb" }),
			],
			T0,
		)
		expect(s.effects.polls).toEqual(["decoders"])
		expect(s.effects.resync).toHaveLength(10)
	})
})
