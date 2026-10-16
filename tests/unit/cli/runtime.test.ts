import { createCliFetch } from "../../../cli/source/data/access-transport.js"
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FetchLike } from "../../../cli/source/data/config.js"
import { PLAIN_SUMMARY } from "../../../cli/source/data/reducers.js"
import { loadScenario } from "../../../cli/source/test/scenarios.js"
import {
	FLUSH_MS,
	POLL_MS,
	BACKGROUND_EVENTS,
	createRuntime,
	nodeRuntimeDeps,
	isUrgent,
	type Timers,
} from "../../../cli/source/data/runtime.js"
import type { Inbound } from "../../../cli/source/data/types.js"
import type {
	WsFactory,
	WsHandlers,
} from "../../../cli/source/data/ws-client.js"

const TARGET = {
	base: "http://127.0.0.1:9100",
	ws: "ws://127.0.0.1:9100/ws",
	explicit: true,
}

const fakeTimers: Timers = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: h => clearTimeout(h as NodeJS.Timeout),
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: h => clearInterval(h as NodeJS.Timeout),
}

function wsFake() {
	const sockets: WsHandlers[] = []
	const closed: number[] = []
	const factory: WsFactory = (_url, h) => {
		const n = sockets.push(h) - 1
		return { send: () => undefined, close: () => void closed.push(n) }
	}
	return { factory, sockets, closed }
}

const never: FetchLike = () => new Promise(() => undefined)
const okJson = (body: unknown) =>
	Promise.resolve({
		ok: true,
		status: 200,
		statusText: "OK",
		json: () => Promise.resolve(body),
	})

function bodies(url: string): unknown {
	if (url.endsWith("/api/decoders")) return []
	if (url.endsWith("/api/sources")) return []
	if (url.endsWith("/api/tuner")) return []
	return { not: "valid" }
}

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	vi.useRealTimers()
})

describe("runtime", () => {
	it("commits at most once per flush tick however many events arrive", () => {
		const ws = wsFake()
		const rt = createRuntime({
			fetchFn: never,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		const h = ws.sockets[0]!
		h.open()
		h.message(JSON.stringify({ type: "subscribed", data: { channels: [] } }))
		for (let i = 0; i < 500; i++) {
			h.message(
				JSON.stringify({
					type: "decoder:output",
					channel: "decoders",
					data: {
						decoderId: "readsb",
						output: {
							type: "aircraft",
							decoder: "readsb",
							timestamp: "t",
							data: {},
						},
					},
				}),
			)
		}
		const before = rt.store.commits()
		vi.advanceTimersByTime(FLUSH_MS)
		expect(rt.store.commits() - before).toBe(1)
		expect(rt.store.get().messages.ring.entries).toHaveLength(500)
		rt.stop()
	})

	// Feature: cli-dashboard-overhaul, Property 18: batched reduce
	// Validates: spec §10.5 (one commit per tick)
	it("P18: k ticks produce at most k commits", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 40 }), {
					minLength: 1,
					maxLength: 15,
				}),
				perTick => {
					const ws = wsFake()
					const rt = createRuntime({
						fetchFn: never,
						probeFetchFn: never,
						wsFactory: ws.factory,
						now: () => Date.now(),
						random: () => 0.5,
						timers: fakeTimers,
						summarize: PLAIN_SUMMARY.summarize,
						explicit: TARGET,
					})
					rt.start()
					const h = ws.sockets[0]!
					const before = rt.store.commits()
					for (const n of perTick) {
						for (let i = 0; i < n; i++)
							h.message(
								JSON.stringify({
									type: "metrics",
									channel: "metrics",
									data: { sourceId: "s", bytesReceived: i, dataRate: 1 },
								}),
							)
						vi.advanceTimersByTime(FLUSH_MS)
					}
					expect(rt.store.commits() - before).toBeLessThanOrEqual(
						perTick.length,
					)
					rt.stop()
				},
			),
			{ numRuns: 100 },
		)
	})

	it("polls every endpoint and runs scheduled effects after the commit", async () => {
		// Mid-second, so only an urgent item can commit before the boundary.
		vi.setSystemTime(new Date(1_000_000_100))
		const fetchFn = vi.fn<FetchLike>(url => okJson(bodies(url)))
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: wsFake().factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		// Final M2: a lane's first answer is urgent, so it commits on the next tick.
		await vi.advanceTimersByTimeAsync(FLUSH_MS)
		const urls = fetchFn.mock.calls.map(c => c[0])
		for (const p of [
			"/api/decoders",
			"/api/sources",
			"/api/tuner",
			"/api/tuner-relay",
			"/api/telemetry/fanout",
			"/api/resources",
			"/api/live-audio/status",
			"/api/status",
			"/api/live-audio/presets",
			"/api/aircraft",
		]) {
			expect(urls).toContain(`${TARGET.base}${p}`)
		}
		expect(rt.store.get().decoders.value).toEqual([])
		expect(rt.store.get().conn.rest.failing).toContain("status")
		rt.stop()
	})

	it("sends tuner commands in order and stops at the first failure", async () => {
		const posts: string[] = []
		const fetchFn: FetchLike = (url, init) => {
			if (init?.method === "POST") {
				posts.push(url)
				return url.endsWith("/frequency")
					? Promise.resolve({
							ok: false,
							status: 409,
							statusText: "Conflict",
							json: () =>
								Promise.resolve({
									code: "TUNER_CONTROL_EXTERNAL",
									message: "device busy",
								}),
						})
					: okJson({})
			}
			return new Promise(() => undefined)
		}
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: wsFake().factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		rt.send({
			kind: "tuner",
			sourceId: "pi-iq",
			commands: [
				{ setting: "frequency", body: { hz: 446000000 }, label: "frequency" },
				{ setting: "gain", body: { tenthsDb: 207 }, label: "gain" },
			],
		})
		await vi.advanceTimersByTimeAsync(FLUSH_MS * 2)
		expect(posts).toEqual([`${TARGET.base}/api/tuner/pi-iq/frequency`])
		const rec = rt.store.get().actions.byKey["tuner:pi-iq"]
		expect(rec?.state).toBe("failed")
		expect(rec?.outcomes.map(o => [o.label, o.result?.status ?? null])).toEqual(
			[
				["frequency", 409],
				["gain", null],
			],
		)
		rt.stop()
	})

	it("an unknown tuner outcome halts the sequence (R23): later commands are not sent", async () => {
		const posts: string[] = []
		const fetchFn: FetchLike = (url, init) => {
			if (init?.method === "POST") {
				posts.push(url)
				return Promise.reject(new DOMException("t", "TimeoutError"))
			}
			return new Promise(() => undefined)
		}
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: wsFake().factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		rt.send({
			kind: "tuner",
			sourceId: "pi-iq",
			commands: [
				{ setting: "frequency", body: { hz: 446000000 }, label: "frequency" },
				{ setting: "gain", body: { tenthsDb: 207 }, label: "gain" },
			],
		})
		await vi.advanceTimersByTimeAsync(FLUSH_MS * 2)
		expect(posts).toEqual([`${TARGET.base}/api/tuner/pi-iq/frequency`])
		const rec = rt.store.get().actions.byKey["tuner:pi-iq"]
		expect(rec?.state).toBe("unknown")
		expect(
			rec?.outcomes.map(o => [o.label, o.result?.outcome ?? null]),
		).toEqual([
			["frequency", "unknown"],
			["gain", null],
		])
		rt.stop()
	})

	it("M6: a slow first write's result does not land on the second write to the same key", async () => {
		let failFirst: (() => void) | null = null
		const fetchFn: FetchLike = (url, init) => {
			if (init?.method !== "POST") return new Promise(() => undefined)
			if (url.endsWith("/stop"))
				return new Promise(resolve => {
					failFirst = () =>
						resolve({
							ok: false,
							status: 500,
							statusText: "Internal Server Error",
							json: () => Promise.resolve({ message: "boom" }),
						})
				})
			return okJson({})
		}
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: wsFake().factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		rt.send({ kind: "decoder", op: "stop", decoderId: "readsb" })
		rt.send({ kind: "decoder", op: "start", decoderId: "readsb" })
		await vi.advanceTimersByTimeAsync(FLUSH_MS)
		expect(rt.store.get().actions.byKey["decoder:readsb"]?.state).toBe("ok")
		failFirst!()
		await vi.advanceTimersByTimeAsync(FLUSH_MS)
		expect(rt.store.get().actions.byKey["decoder:readsb"]).toMatchObject({
			state: "ok",
			intent: { op: "start" },
		})
		rt.stop()
	})

	it("stop() halts the flush, polls and socket", async () => {
		const fetchFn = vi.fn<FetchLike>(url => okJson(bodies(url)))
		const ws = wsFake()
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		await vi.advanceTimersByTimeAsync(FLUSH_MS)
		expect(ws.closed).toEqual([])
		rt.stop()
		expect(ws.closed).toEqual([0])
		expect(vi.getTimerCount()).toBe(0)
		const calls = fetchFn.mock.calls.length
		const commits = rt.store.commits()
		await vi.advanceTimersByTimeAsync(30_000)
		expect(fetchFn.mock.calls.length).toBe(calls)
		expect(rt.store.commits()).toBe(commits)
		expect(ws.sockets).toHaveLength(1)
	})

	it("rediscovers after a failed discovery and reports what it tried", async () => {
		const discover = vi.fn(() =>
			Promise.resolve({
				target: null,
				tried: ["127.0.0.1:9000", "127.0.0.1:3000"],
			}),
		)
		const rt = createRuntime({
			fetchFn: never,
			probeFetchFn: never,
			wsFactory: wsFake().factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: null,
			discover,
		})
		rt.start()
		await vi.advanceTimersByTimeAsync(FLUSH_MS)
		expect(rt.store.get().conn.discovery).toEqual({
			mode: "failed",
			tried: ["127.0.0.1:9000", "127.0.0.1:3000"],
		})
		expect(rt.store.get().conn.rest.failing.length).toBeGreaterThan(0)
		await vi.advanceTimersByTimeAsync(15_000)
		expect(discover).toHaveBeenCalledTimes(2)
		rt.stop()
	})
})

/** Every GET waits until the test answers it. */
function heldFetch() {
	const pending: Array<{ url: string; answer: (body: unknown) => void }> = []
	const fetchFn: FetchLike = url =>
		new Promise(resolve => {
			pending.push({
				url,
				answer: body =>
					resolve({
						ok: true,
						status: 200,
						statusText: "OK",
						json: () => Promise.resolve(body),
					}),
			})
		})
	const answerAll = (): void => {
		for (const p of pending.splice(0)) p.answer(bodies(p.url))
	}
	return { fetchFn, pending, answerAll }
}

const decoderRow = (running: boolean) => ({
	id: "readsb",
	type: "readsb",
	running,
	health: running ? "running" : "idle",
	uptime: 1,
	stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
	restartCount: 0,
})

describe("poll cycles (R47 M1, M2)", () => {
	it("M1: reconnect() during a cycle queues the next cycle instead of overlapping it", async () => {
		const held = heldFetch()
		const rt = createRuntime({
			fetchFn: held.fetchFn,
			probeFetchFn: never,
			wsFactory: wsFake().factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		await vi.advanceTimersByTimeAsync(0)
		expect(held.pending).toHaveLength(10)
		rt.reconnect()
		rt.reconnect()
		await vi.advanceTimersByTimeAsync(0)
		expect(held.pending).toHaveLength(10)
		held.answerAll()
		await vi.advanceTimersByTimeAsync(0)
		// One queued cycle (both reconnects folded), started as soon as the first ended.
		expect(held.pending).toHaveLength(10)
		held.answerAll()
		await vi.advanceTimersByTimeAsync(4_999)
		expect(held.pending).toHaveLength(0)
		await vi.advanceTimersByTimeAsync(1)
		expect(held.pending).toHaveLength(8)
		rt.stop()
	})

	it("M2: an older response never overwrites a newer one for the same endpoint", async () => {
		const held = heldFetch()
		const ws = wsFake()
		const rt = createRuntime({
			fetchFn: held.fetchFn,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		await vi.advanceTimersByTimeAsync(0)
		const older = held.pending.find(p => p.url.endsWith("/api/decoders"))!
		// decoder:started schedules an immediate /api/decoders poll beside the cycle's.
		ws.sockets[0]!.message(
			JSON.stringify({
				type: "decoder:started",
				channel: "decoders",
				data: { decoderId: "readsb" },
			}),
		)
		await vi.advanceTimersByTimeAsync(FLUSH_MS)
		const newer = held.pending.filter(p => p.url.endsWith("/api/decoders"))
		expect(newer).toHaveLength(2)
		newer[1]!.answer([decoderRow(false)])
		await vi.advanceTimersByTimeAsync(0)
		older.answer([decoderRow(true)])
		// REST answers are background items: they commit on the next whole second.
		await vi.advanceTimersByTimeAsync(1000)
		expect(rt.store.get().decoders.value?.[0]?.running).toBe(false)
		rt.stop()
	})
})

const DISCOVERED = { ...TARGET, explicit: false }
const refused = (): Promise<never> =>
	Promise.reject(
		new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
	)

/**
 * A core that can go down and come back: discovery, REST and WS all follow `up`.
 * Sockets open (with the subscribe ack) or close 10 ms after they are created.
 */
function flakyCore(discoverMs = 100) {
	const state = {
		up: true,
		sockets: 0,
		opened: [] as number[],
		live: null as WsHandlers | null,
	}
	const discover = vi.fn(
		() =>
			new Promise<{ target: typeof DISCOVERED | null; tried: string[] }>(
				resolve => {
					setTimeout(
						() =>
							resolve({
								target: state.up ? DISCOVERED : null,
								tried: ["127.0.0.1:9000", "127.0.0.1:3000"],
							}),
						discoverMs,
					)
				},
			),
	)
	const fetchFn = vi.fn<FetchLike>(url =>
		state.up ? okJson(bodies(url)) : refused(),
	)
	const factory: WsFactory = (_url, h) => {
		const n = ++state.sockets
		setTimeout(() => {
			if (state.up) {
				state.live = h
				state.opened.push(n)
				h.open()
				h.message(
					JSON.stringify({ type: "subscribed", data: { channels: [] } }),
				)
			} else h.close(1006, "")
		}, 10)
		return { send: () => undefined, close: () => undefined }
	}
	const goDown = (): void => {
		state.up = false
		state.live?.close(1006, "")
		state.live = null
	}
	return Object.assign(state, { discover, fetchFn, factory, goDown })
}

describe("rediscovery (fix round 1, Critical)", () => {
	it("discovered target lost for 120 s, then recovered: one chain, one gap, no extra reconnects", async () => {
		const core = flakyCore()
		const rt = createRuntime({
			fetchFn: core.fetchFn,
			probeFetchFn: never,
			wsFactory: core.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: null,
			discover: core.discover,
		})
		rt.start()
		await vi.advanceTimersByTimeAsync(5_000)
		expect(core.discover).toHaveBeenCalledTimes(1)
		expect(rt.store.get().conn.ws.state).toBe("open")

		core.goDown()
		await vi.advanceTimersByTimeAsync(120_000)
		// ≤ one run per 15 s once the first 15 s unreachable have passed.
		const downRuns = core.discover.mock.calls.length - 1
		expect(downRuns).toBeGreaterThanOrEqual(1)
		expect(downRuns).toBeLessThanOrEqual(8)

		core.up = true
		await vi.advanceTimersByTimeAsync(30_000)
		const afterRecovery = core.discover.mock.calls.length - 1 - downRuns
		expect(afterRecovery).toBeLessThanOrEqual(1)
		// Exactly one socket opened after recovery and nothing reconnected it again.
		expect(core.opened).toHaveLength(2)
		expect(core.sockets).toBe(core.opened[1])
		const s = rt.store.get()
		expect(s.conn.ws.state).toBe("open")
		expect(s.messages.ring.gaps).toHaveLength(1)
		expect(s.messages.ring.gaps[0]?.to).not.toBeNull()

		rt.stop()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("discovery that finds the current target does not reconnect a socket that is already back", async () => {
		// Discovery is slow here, so the socket's own backoff reconnects first.
		const core = flakyCore(20_000)
		const rt = createRuntime({
			fetchFn: core.fetchFn,
			probeFetchFn: never,
			wsFactory: core.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: null,
			discover: core.discover,
		})
		rt.start()
		await vi.advanceTimersByTimeAsync(25_000)
		expect(core.opened).toHaveLength(1)
		core.goDown()
		// Wait for the rediscovery run to start, then bring the core back while it runs.
		for (let i = 0; i < 60 && core.discover.mock.calls.length < 2; i++)
			await vi.advanceTimersByTimeAsync(1_000)
		expect(core.discover).toHaveBeenCalledTimes(2)
		core.up = true
		await vi.advanceTimersByTimeAsync(40_000)
		expect(core.discover).toHaveBeenCalledTimes(2)
		expect(rt.store.get().conn.discovery.mode).toBe("found")
		expect(core.opened).toHaveLength(2)
		expect(core.sockets).toBe(core.opened[1])
		expect(rt.store.get().messages.ring.gaps).toHaveLength(1)
		rt.stop()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("a timeout is not an answer: a discovered target that only times out is rediscovered (M3)", async () => {
		const discover = vi.fn(() =>
			Promise.resolve({ target: DISCOVERED, tried: [] }),
		)
		const rt = createRuntime({
			fetchFn: () => Promise.reject(new DOMException("t", "TimeoutError")),
			probeFetchFn: never,
			wsFactory: wsFake().factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: null,
			discover,
		})
		rt.start()
		await vi.advanceTimersByTimeAsync(25_000)
		expect(discover.mock.calls.length).toBeGreaterThanOrEqual(2)
		rt.stop()
	})

	it("a poll that answers cancels the pending rediscovery chain", async () => {
		const core = flakyCore()
		const rt = createRuntime({
			fetchFn: core.fetchFn,
			probeFetchFn: never,
			wsFactory: core.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: null,
			discover: core.discover,
		})
		rt.start()
		await vi.advanceTimersByTimeAsync(5_000)
		core.goDown()
		// Polls fail from ~5 s; the first rediscovery fails at ~20 s and arms the chain.
		await vi.advanceTimersByTimeAsync(16_000)
		const runs = core.discover.mock.calls.length
		expect(runs).toBe(2)
		// Back up before the chain fires: the next poll answers and cancels it.
		core.up = true
		await vi.advanceTimersByTimeAsync(60_000)
		expect(core.discover.mock.calls.length).toBe(runs)
		rt.stop()
	})
})

describe("R55 runtime follow-ups", () => {
	/** The ws client reports ws:open on the subscribe ack (assumption 6). */
	const openAndAck = (h: WsHandlers): void => {
		h.open()
		h.message(JSON.stringify({ type: "subscribed", data: { channels: [] } }))
	}
	const make = (fetchFn: FetchLike, ws = wsFake()) =>
		createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})

	it("start and reconnect each fetch one set of endpoints, not one per trigger plus one per ws:open", async () => {
		// Valid bodies: only an applied-OK answer covers the ws:open's resync (I2).
		const fetchFn = vi.fn<FetchLike>(url => okJson(liveBody(url)))
		const ws = wsFake()
		const rt = make(fetchFn, ws)
		rt.start()
		openAndAck(ws.sockets[0]!)
		await vi.advanceTimersByTimeAsync(FLUSH_MS * 2)
		expect(fetchFn).toHaveBeenCalledTimes(10)
		rt.reconnect()
		openAndAck(ws.sockets[1]!)
		await vi.advanceTimersByTimeAsync(FLUSH_MS * 2)
		expect(fetchFn).toHaveBeenCalledTimes(20)
		rt.stop()
	})

	it("a ws:open the runtime did not ask for still resyncs REST", async () => {
		const fetchFn = vi.fn<FetchLike>(url => okJson(bodies(url)))
		const ws = wsFake()
		const rt = make(fetchFn, ws)
		rt.start()
		openAndAck(ws.sockets[0]!)
		await vi.advanceTimersByTimeAsync(FLUSH_MS * 2)
		const before = fetchFn.mock.calls.length
		// The socket drops and the ws client's own backoff reopens it later.
		ws.sockets[0]!.close(1006, "")
		await vi.advanceTimersByTimeAsync(2_000)
		openAndAck(ws.sockets[ws.sockets.length - 1]!)
		await vi.advanceTimersByTimeAsync(FLUSH_MS * 2)
		expect(fetchFn.mock.calls.length - before).toBeGreaterThanOrEqual(10)
		rt.stop()
	})

	it("a response that lands after stop() is not applied", async () => {
		const held = heldFetch()
		const rt = make(held.fetchFn)
		rt.start()
		await vi.advanceTimersByTimeAsync(0)
		expect(held.pending).toHaveLength(10)
		rt.stop()
		held.answerAll()
		await vi.advanceTimersByTimeAsync(0)
		rt.tick()
		expect(rt.store.get().decoders.receivedAt).toBeNull()
	})

	it("stop() drops inbound queued before it", () => {
		const ws = wsFake()
		const rt = make(never, ws)
		rt.start()
		const h = ws.sockets[0]!
		h.open()
		h.message(JSON.stringify({ type: "subscribed", data: { channels: [] } }))
		h.message(
			JSON.stringify({
				type: "decoder:output",
				channel: "decoders",
				data: {
					decoderId: "readsb",
					output: {
						type: "aircraft",
						decoder: "readsb",
						timestamp: "t",
						data: {},
					},
				},
			}),
		)
		rt.stop()
		rt.tick()
		expect(rt.store.get().messages.ring.entries).toHaveLength(0)
	})
})

describe("R55 follow-ups fix", () => {
	const ack = (h: WsHandlers): void => {
		h.open()
		h.message(JSON.stringify({ type: "subscribed", data: { channels: [] } }))
	}
	const make = (fetchFn: FetchLike, ws = wsFake()) =>
		createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
	const count = (fn: ReturnType<typeof vi.fn<FetchLike>>, path: string) =>
		fn.mock.calls.filter(c => c[0] === `${TARGET.base}${path}`).length

	it("core restarting: resync GETs fail fast, ws:open within 1 s refetches presets and aircraft", async () => {
		let up = false
		const fetchFn = vi.fn<FetchLike>(url =>
			up ? okJson(bodies(url)) : Promise.reject(new TypeError("fetch failed")),
		)
		const ws = wsFake()
		const rt = make(fetchFn, ws)
		rt.start()
		await vi.advanceTimersByTimeAsync(0)
		expect(count(fetchFn, "/api/live-audio/presets")).toBe(1)
		up = true
		ack(ws.sockets[0]!)
		await vi.advanceTimersByTimeAsync(FLUSH_MS * 2)
		expect(count(fetchFn, "/api/live-audio/presets")).toBe(2)
		expect(count(fetchFn, "/api/aircraft")).toBe(2)
		rt.stop()
	})

	it("never drops an event's poll that shares a batch with ws:open", async () => {
		const held = heldFetch()
		const ws = wsFake()
		const rt = make(held.fetchFn, ws)
		rt.start()
		await vi.advanceTimersByTimeAsync(0)
		expect(held.pending).toHaveLength(10)
		const h = ws.sockets[0]!
		ack(h)
		h.message(
			JSON.stringify({
				type: "decoder:started",
				channel: "decoders",
				data: { decoderId: "readsb" },
			}),
		)
		await vi.advanceTimersByTimeAsync(FLUSH_MS)
		// The resync is still in flight (covered), but decoder:started's poll runs.
		expect(held.pending.map(p => p.url)).toEqual([
			...Array.from({ length: 10 }, () => expect.any(String)),
			`${TARGET.base}/api/decoders`,
		])
		rt.stop()
	})

	it("a write answered after stop() is not applied", async () => {
		let answer: (() => void) | null = null
		const fetchFn: FetchLike = (url, init) =>
			init?.method === "POST"
				? new Promise(resolve => {
						answer = () =>
							resolve({
								ok: true,
								status: 200,
								statusText: "OK",
								json: () => Promise.resolve({}),
							})
					})
				: new Promise(() => undefined)
		const rt = make(fetchFn)
		rt.start()
		rt.send({ kind: "audio", op: "start" })
		rt.tick()
		expect(rt.store.get().actions.byKey["audio"]?.state).toBe("sent")
		rt.stop()
		;(answer as (() => void) | null)?.()
		await vi.advanceTimersByTimeAsync(0)
		rt.tick()
		expect(rt.store.get().actions.byKey["audio"]?.state).toBe("sent")
	})

	it("I2: a resync answered 500 or with an invalid body is fetched again on ws:open", async () => {
		const fetchFn = vi.fn<FetchLike>(url =>
			url.endsWith("/api/aircraft")
				? Promise.resolve({
						ok: false,
						status: 500,
						statusText: "x",
						json: () => Promise.resolve({}),
					})
				: okJson(liveBody(url)),
		)
		const ws = wsFake()
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		await vi.advanceTimersByTimeAsync(0)
		ws.sockets[0]!.open()
		ws.sockets[0]!.message(
			JSON.stringify({ type: "subscribed", data: { channels: [] } }),
		)
		await vi.advanceTimersByTimeAsync(FLUSH_MS * 2)
		const n = (p: string) =>
			fetchFn.mock.calls.filter(c => c[0] === `${TARGET.base}${p}`).length
		expect(n("/api/aircraft")).toBe(2)
		expect(n("/api/live-audio/presets")).toBe(1)
		rt.stop()
	})

	it("I3: a resync GET still pending at ws:open is fetched again when it then fails", async () => {
		const pending: Array<{ url: string; fail: () => void }> = []
		const urls: string[] = []
		const fetchFn: FetchLike = url => {
			urls.push(url)
			return new Promise((_, reject) => {
				pending.push({ url, fail: () => reject(new TypeError("fetch failed")) })
			})
		}
		const ws = wsFake()
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		await vi.advanceTimersByTimeAsync(0)
		expect(urls).toHaveLength(10)
		ws.sockets[0]!.open()
		ws.sockets[0]!.message(
			JSON.stringify({ type: "subscribed", data: { channels: [] } }),
		)
		await vi.advanceTimersByTimeAsync(FLUSH_MS)
		// Covered while pending: nothing new yet.
		expect(urls).toHaveLength(10)
		// Core is restarting: the pending GETs now fail.
		for (const p of pending.splice(0)) p.fail()
		await vi.advanceTimersByTimeAsync(0)
		const n = (p: string) => urls.filter(u => u === `${TARGET.base}${p}`).length
		expect(n("/api/live-audio/presets")).toBe(2)
		expect(n("/api/aircraft")).toBe(2)
		expect(n("/api/decoders")).toBe(2)
		rt.stop()
	})
})

describe("background items wait for the whole second (D3)", () => {
	// The core stamps every broadcast with its channel; unknown channels are ignored.
	const frame = (type: string, data: unknown) =>
		JSON.stringify({
			type,
			channel: type.startsWith("decoder:") ? "decoders" : "metrics",
			data,
		})
	it("a snapshot alone commits at the next second boundary; a decode commits on the next tick", () => {
		vi.setSystemTime(new Date(1_000_000_100))
		const ws = wsFake()
		const rt = createRuntime({
			fetchFn: never,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		vi.advanceTimersByTime(1000)
		const h = ws.sockets[0]!
		const base = rt.store.commits()
		h.message(
			frame("metrics", { sourceId: "s", bytesReceived: 1, dataRate: 1 }),
		)
		// Inside the same second: background only, nothing to commit yet.
		vi.advanceTimersByTime(FLUSH_MS)
		expect(rt.store.commits()).toBe(base)
		expect(rt.store.get().metrics["s"]).toBeUndefined()
		// The boundary commits it (ages move anyway).
		vi.advanceTimersByTime(1000)
		expect(rt.store.commits()).toBeGreaterThan(base)
		expect(rt.store.get().metrics["s"]).toBeDefined()
		// A decode does not wait for the second.
		const before = rt.store.commits()
		h.message(
			frame("decoder:output", {
				decoderId: "readsb",
				output: {
					type: "aircraft",
					decoder: "readsb",
					timestamp: "t",
					data: {},
				},
			}),
		)
		vi.advanceTimersByTime(FLUSH_MS)
		expect(rt.store.commits()).toBe(before + 1)
		rt.stop()
	})
	it("classifies every background kind (R83) and keeps the rest urgent", () => {
		const wsItem = (event: Record<string, unknown>): Inbound =>
			({ kind: "ws", at: 0, event }) as Inbound
		for (const type of [
			"fanout:snapshot",
			"metrics",
			"source:status",
			"resources:snapshot",
		])
			expect(isUrgent(wsItem({ type })), type).toBe(false)
		expect([...BACKGROUND_EVENTS].sort()).toEqual([
			"fanout:snapshot",
			"metrics",
			"resources:snapshot",
			"source:status",
		])
		expect(isUrgent({ kind: "rest:cycle", at: 0, nextAt: 0 })).toBe(false)
		expect(
			isUrgent({
				kind: "rest",
				endpoint: "status",
				at: 0,
				outcome: {
					ok: false,
					error: { kind: "network", message: "x", at: 0 },
				},
			} as Inbound),
		).toBe(false)
		for (const type of [
			"decoder:output",
			"decoder:started",
			"decoder:stopped",
			"decoder:status",
			"decoder:health",
			"source:connected",
			"source:disconnected",
			"tuner:state-changed",
			"live-audio:status",
			"aircraft:update",
			"aircraft:stats",
			"resources:alert",
		])
			expect(isUrgent(wsItem({ type })), type).toBe(true)
		const others: Inbound[] = [
			{ kind: "ws:open", at: 0 },
			{ kind: "ws:connecting", at: 0, attempt: 0 },
			{ kind: "ws:invalid", at: 0 },
			{
				kind: "ws:close",
				at: 0,
				code: 1006,
				reason: "",
				nextRetryAt: null,
			},
			{
				kind: "target",
				at: 0,
				base: null,
				ws: null,
				discovery: { mode: "probing", tried: [] },
			},
			{
				kind: "action:sent",
				at: 0,
				id: 1,
				key: "audio",
				intent: { kind: "audio", op: "start" },
			},
			{ kind: "action:result", at: 0, id: 1, key: "audio", outcomes: [] },
		]
		for (const item of others) expect(isUrgent(item), item.kind).toBe(true)
	})
	it("an urgent item carries queued background items into the same commit", () => {
		vi.setSystemTime(new Date(1_000_000_100))
		const ws = wsFake()
		const rt = createRuntime({
			fetchFn: never,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		vi.advanceTimersByTime(1000)
		const h = ws.sockets[0]!
		h.message(
			frame("metrics", { sourceId: "s", bytesReceived: 1, dataRate: 1 }),
		)
		h.message(frame("decoder:started", { decoderId: "readsb" }))
		const before = rt.store.commits()
		vi.advanceTimersByTime(FLUSH_MS)
		expect(rt.store.commits()).toBe(before + 1)
		expect(rt.store.get().metrics["s"]).toBeDefined()
		rt.stop()
	})
})

function liveBody(url: string): unknown {
	const path = new URL(url).pathname
	return loadScenario("live").rest[path]?.body ?? {}
}

describe("final M2: REST answers a user waits on are urgent", () => {
	it("isUrgent honours the runtime's urgent mark on a REST answer", () => {
		const rest = (urgent: boolean): Inbound =>
			({
				kind: "rest",
				endpoint: "decoders",
				at: 0,
				outcome: { ok: true, value: [], rejected: 0 },
				...(urgent ? { urgent: true } : {}),
			}) as Inbound
		expect(isUrgent(rest(true))).toBe(true)
		expect(isUrgent(rest(false))).toBe(false)
	})
	it("the poll after a write commits on the next tick", async () => {
		vi.setSystemTime(new Date(1_000_000_100))
		let running = true
		let gets = 0
		const fetchFn: FetchLike = (url, init) => {
			if (init?.method === "POST") {
				running = false
				return okJson({})
			}
			if (url.endsWith("/api/decoders")) {
				gets++
				return okJson([decoderRow(running)])
			}
			return okJson(bodies(url))
		}
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: wsFake().factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		await vi.advanceTimersByTimeAsync(FLUSH_MS)
		expect(rt.store.get().decoders.value?.[0]?.running).toBe(true)
		rt.send({ kind: "decoder", op: "stop", decoderId: "readsb" })
		// Still inside the same second (1_000_000_900 at most).
		await vi.advanceTimersByTimeAsync(FLUSH_MS * 3)
		expect(gets).toBe(2)
		expect(rt.store.get().decoders.value?.[0]?.running).toBe(false)
		rt.stop()
	})
	it("after a ws auto-reconnect the resync answers are urgent again (A11 re-review)", async () => {
		vi.setSystemTime(new Date(1_000_000_100))
		let running = true
		const fetchFn: FetchLike = url =>
			okJson(
				url.endsWith("/api/decoders") ? [decoderRow(running)] : bodies(url),
			)
		const ws = wsFake()
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		const openAndAck = (h: WsHandlers) => {
			h.open()
			h.message(JSON.stringify({ type: "subscribed", data: { channels: [] } }))
		}
		rt.start()
		openAndAck(ws.sockets[0]!)
		await vi.advanceTimersByTimeAsync(FLUSH_MS * 2)
		expect(rt.store.get().decoders.value?.[0]?.running).toBe(true)
		running = false
		// The socket drops; the ws client's own backoff reopens it (no runtime resync).
		ws.sockets[0]!.close(1006, "")
		await vi.advanceTimersByTimeAsync(2_000)
		openAndAck(ws.sockets[ws.sockets.length - 1]!)
		// Still inside the same second: only an urgent answer commits.
		await vi.advanceTimersByTimeAsync(FLUSH_MS * 2)
		expect(rt.store.get().decoders.value?.[0]?.running).toBe(false)
		rt.stop()
	})
})

describe("R98: failed resync endpoints retry once REST recovers", () => {
	it("REST hangs, ws:open resync fails, REST recovers: the presets banner clears within one poll cycle", async () => {
		vi.setSystemTime(new Date(1_000_000_100))
		let up = false
		const calls: string[] = []
		const fetchFn: FetchLike = url => {
			calls.push(url)
			if (!up) return Promise.reject(new DOMException("t", "TimeoutError"))
			if (url.endsWith("/api/live-audio/presets")) return okJson({})
			return okJson(bodies(url))
		}
		const ws = wsFake()
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		await vi.advanceTimersByTimeAsync(FLUSH_MS)
		// The WS comes back while REST still hangs: its resync GETs fail too.
		const h = ws.sockets[0]!
		h.open()
		h.message(JSON.stringify({ type: "subscribed", data: { channels: [] } }))
		await vi.advanceTimersByTimeAsync(FLUSH_MS * 2)
		expect(rt.store.get().conn.rest.failing).toContain("presets")
		// REST recovers; nothing reconnects.
		up = true
		const before = calls.filter(u => u.endsWith("/api/aircraft")).length
		await vi.advanceTimersByTimeAsync(POLL_MS + 1_000)
		expect(rt.store.get().conn.rest.failing).not.toContain("presets")
		expect(
			calls.filter(u => u.endsWith("/api/aircraft")).length,
		).toBeGreaterThan(before)
		rt.stop()
	})
	it("a REST that keeps hanging retries the resync endpoints at most once per poll", async () => {
		vi.setSystemTime(new Date(1_000_000_100))
		const calls: string[] = []
		// Poll endpoints answer, the resync ones keep failing.
		const fetchFn: FetchLike = url => {
			calls.push(url)
			if (
				url.endsWith("/api/live-audio/presets") ||
				url.endsWith("/api/aircraft")
			)
				return Promise.reject(new DOMException("t", "TimeoutError"))
			return okJson(bodies(url))
		}
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: wsFake().factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		await vi.advanceTimersByTimeAsync(POLL_MS * 4)
		const presets = calls.filter(u =>
			u.endsWith("/api/live-audio/presets"),
		).length
		// The start resync, then at most one retry per poll cycle.
		expect(presets).toBeGreaterThan(1)
		expect(presets).toBeLessThanOrEqual(1 + 4)
		rt.stop()
	})
})

// Validates: core-access-policy requirements 6.3, 6.4.
describe("CLI access transport wiring", () => {
	it("uses only the required probe transport for discovery and REST only after adoption", async () => {
		const fetchFn = vi.fn<FetchLike>(url => okJson(bodies(url)))
		const probeFetchFn = vi.fn<FetchLike>(() => okJson({ status: "ok" }))
		const rt = createRuntime({
			fetchFn,
			probeFetchFn,
			wsFactory: wsFake().factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: null,
		})
		rt.start()
		await vi.advanceTimersByTimeAsync(FLUSH_MS)
		expect(probeFetchFn.mock.calls.map(c => c[0])).toEqual([
			"http://127.0.0.1:9000/health",
		])
		expect(fetchFn.mock.calls.length).toBeGreaterThan(0)
		expect(fetchFn.mock.calls.every(c => !c[0].endsWith("/health"))).toBe(true)
		rt.stop()
	})
	it("node dependencies keep injected protected transports separate from credential-free probes", async () => {
		const native = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ status: "ok", private: "discard" }), {
				status: 503,
			}),
		)
		const fetchFn = vi.fn<FetchLike>(() => okJson([]))
		const wsFactory = wsFake().factory
		try {
			const deps = nodeRuntimeDeps(TARGET, PLAIN_SUMMARY.summarize, {
				fetchFn,
				wsFactory,
			})
			expect(deps.fetchFn).toBe(fetchFn)
			expect(deps.wsFactory).toBe(wsFactory)
			expect(
				await (await deps.probeFetchFn(`${TARGET.base}/health`)).json(),
			).toEqual({ status: "ok" })
			expect(native.mock.calls[0]?.[1]).toMatchObject({
				headers: {},
				redirect: "error",
				credentials: "omit",
			})
			expect(fetchFn).not.toHaveBeenCalled()
		} finally {
			native.mockRestore()
		}
	})
	it.each([401, 403])(
		"REST %s is an answered server and explicit access never migrates",
		async status => {
			const discover = vi.fn(async () => ({ target: null, tried: [] }))
			const fetchFn = createCliFetch({
				fetch: async () =>
					new Response(JSON.stringify({ message: "untrusted message" }), {
						status,
					}),
			})
			const ws = wsFake()
			const rt = createRuntime({
				fetchFn,
				probeFetchFn: never,
				wsFactory: ws.factory,
				now: () => Date.now(),
				random: () => 0.5,
				timers: fakeTimers,
				summarize: PLAIN_SUMMARY.summarize,
				explicit: TARGET,
				discover,
			})
			rt.start()
			ws.sockets[0]!.accessBlocked?.(
				status === 401 ? "unauthorized" : "forbidden",
			)
			await vi.advanceTimersByTimeAsync(40_000)
			expect(discover).not.toHaveBeenCalled()
			expect(rt.store.get().conn.rest.failing).toContain("status")
			expect(rt.store.get().status.error).toMatchObject({
				kind: "http",
				status,
				message: `HTTP ${status}`,
			})
			expect(rt.store.get().conn.ws.nextRetryAt).toBeNull()
			rt.stop()
		},
	)
})

describe("Scan runtime bounded demand and generations", () => {
	it("coalesces high-rate frames, refetches after reconnect and releases demand on stop", async () => {
		const { SCAN_FRAME, SCAN_PROFILE } =
			await import("../../../cli/source/test/fixtures.js")
		const sent: string[] = [],
			handlers: WsHandlers[] = []
		const rt = createRuntime({
			fetchFn: never,
			probeFetchFn: never,
			wsFactory: (_url, h) => {
				handlers.push(h)
				return { send: s => sent.push(s), close: () => undefined }
			},
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		rt.setScanDemand({ sourceId: "rtl", cursor: null, detail: null })
		const h = handlers[0]!
		h.open()
		h.message(JSON.stringify({ type: "subscribed", data: { channels: [] } }))
		h.message(
			JSON.stringify({
				type: "spectrum:profile",
				channel: "spectrum",
				data: SCAN_PROFILE,
			}),
		)
		for (let i = 0; i < 1000; i++)
			h.message(
				JSON.stringify({
					type: "spectrum:frame",
					channel: "spectrum",
					data: { ...SCAN_FRAME, epoch: i === 999 ? 2 : 4 },
				}),
			)
		for (let i = 0; i < 1000; i++)
			h.message(
				JSON.stringify({
					type: "spectrum:frame",
					channel: "spectrum",
					data: {},
				}),
			)
		rt.tick()
		expect(rt.store.get().scan.invalidFrames).toBe(1000)
		expect(rt.store.get().scan.rows).toHaveLength(1)
		expect(rt.store.get().scan.rows[0]?.frame.epoch).toBe(2)
		rt.setScanDemand({ sourceId: "other", cursor: null, detail: null })
		h.message(
			JSON.stringify({
				type: "spectrum:frame",
				channel: "spectrum",
				data: SCAN_FRAME,
			}),
		)
		rt.tick()
		expect(rt.store.get().scan.rows).toHaveLength(0)
		rt.reconnect()
		const next = handlers[1]!
		next.open()
		next.message(JSON.stringify({ type: "subscribed", data: { channels: [] } }))
		expect(sent.at(-1)).toContain('"sourceId":"other"')
		rt.setScanDemand(null)
		expect(JSON.parse(sent.at(-1)!)).toEqual({
			type: "unsubscribe",
			channels: ["scanner", "spectrum"],
		})
		rt.stop()
	})
	it("drops delayed old-source/detail reads and caps same-path request cadence", async () => {
		const { SCAN_DISCOVERY, SCAN_JOB, SCAN_STATUS, SCAN_PROFILE } =
			await import("../../../cli/source/test/fixtures.js")
		const ws = wsFake(),
			urls: string[] = [],
			signals: AbortSignal[] = []
		let resolveOld: ((r: Response) => void) | undefined
		const fetchFn: FetchLike = (url, init) => {
			if (!url.includes("/scanner") && !url.includes("/spectrum"))
				return never(url, init)
			urls.push(url)
			signals.push(init!.signal!)
			if (url.includes("sourceId=rtl"))
				return new Promise<Response>(r => {
					resolveOld = r
				})
			const body = url.endsWith("/api/scanner")
				? SCAN_STATUS
				: url.endsWith("/api/spectrum")
					? { defaultProfile: SCAN_PROFILE.profile, sources: [] }
					: url.endsWith("/jobs")
						? [SCAN_JOB]
						: url.includes("/jobs/")
							? SCAN_JOB
							: { items: [], nextCursor: null }
			return Promise.resolve(new Response(JSON.stringify(body)))
		}
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		rt.setScanDemand({ sourceId: "rtl", cursor: null, detail: null })
		rt.tick()
		await vi.advanceTimersByTimeAsync(200)
		rt.setScanDemand({
			sourceId: "other",
			cursor: null,
			detail: { kind: "job", id: "job1" },
		})
		rt.tick()
		expect(signals[0]?.aborted).toBe(true)
		resolveOld?.(
			new Response(
				JSON.stringify({ items: [SCAN_DISCOVERY], nextCursor: null }),
			),
		)
		await vi.advanceTimersByTimeAsync(200)
		expect(rt.store.get().scan.lanes.discoveries.value?.items).toEqual([])
		rt.setScanDemand({
			sourceId: "other",
			cursor: null,
			detail: { kind: "job", id: "job2" },
		})
		rt.tick()
		await vi.advanceTimersByTimeAsync(200)
		expect(urls.filter(u => u.endsWith("/api/scanner"))).toHaveLength(2) // one per source generation, not per detail
		rt.setScanDemand(null)
		rt.stop()
	})
})

it.each(["status", "spectrum"] as const)(
	"fences pre-admission %s fatal REST while applying post-admission failure",
	async key => {
		const { SCAN_STATUS, SCAN_PROFILE, SCAN_FRAME } =
			await import("../../../cli/source/test/fixtures.js")
		const ws = wsFake()
		const path = key === "status" ? "/api/scanner" : "/api/spectrum"
		const fatal =
			key === "status"
				? {
						...SCAN_STATUS,
						engines: [
							{
								...SCAN_STATUS.engines[0]!,
								sourceId: "rtl",
								state: "error",
								lastError: "fatal",
							},
						],
					}
				: {
						defaultProfile: SCAN_PROFILE.profile,
						sources: [
							{
								sourceId: "rtl",
								eligible: true,
								engine: "error",
								tuningTrust: null,
								lastError: "fatal",
							},
						],
					}
		let pending: ((r: Response) => void) | undefined,
			first = true
		const fetchFn: FetchLike = (url, init) => {
			if (url.endsWith(path)) {
				if (first) {
					first = false
					return new Promise<Response>(r => {
						pending = r
					})
				}
				return Promise.resolve(new Response(JSON.stringify(fatal)))
			}
			if (url.includes("/api/scanner") || url.includes("/api/spectrum"))
				return Promise.resolve(
					new Response(
						JSON.stringify(
							url.endsWith("/api/scanner")
								? SCAN_STATUS
								: url.endsWith("/api/spectrum")
									? { defaultProfile: SCAN_PROFILE.profile, sources: [] }
									: url.endsWith("/jobs")
										? []
										: { items: [], nextCursor: null },
						),
					),
				)
			return never(url, init)
		}
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		try {
			rt.start()
			rt.setScanDemand({ sourceId: "rtl", cursor: null, detail: null })
			const h = ws.sockets[0]!
			h.open()
			h.message(JSON.stringify({ type: "subscribed", data: { channels: [] } }))
			rt.tick()
			expect(pending).toBeDefined()
			h.message(
				JSON.stringify({
					type: "spectrum:profile",
					channel: "spectrum",
					data: SCAN_PROFILE,
				}),
			)
			h.message(
				JSON.stringify({
					type: "spectrum:frame",
					channel: "spectrum",
					data: SCAN_FRAME,
				}),
			)
			rt.tick()
			pending!(new Response(JSON.stringify(fatal)))
			await vi.advanceTimersByTimeAsync(200)
			expect(rt.store.get().scan.profile?.sourceId).toBe("rtl")
			expect(rt.store.get().scan.rows).toHaveLength(1)
			await vi.advanceTimersByTimeAsync(5000)
			expect(rt.store.get().scan.phase).toBe("error")
			expect(rt.store.get().scan.profile).toBeNull()
			expect(rt.store.get().scan.rows).toHaveLength(0)
		} finally {
			rt.stop()
		}
	},
)

it.each(["timeout", "source", "detail", "stop"] as const)(
	"cancels exactly once a late Scan body after %s and never commits it",
	async why => {
		const ws = wsFake(),
			cancel = vi.fn(() =>
				why === "detail"
					? Promise.reject(new Error("cancel rejected"))
					: undefined,
			),
			json = vi.fn()
		let late: ((r: Awaited<ReturnType<FetchLike>>) => void) | undefined
		const fetchFn: FetchLike = (url, init) =>
			url.includes("/discoveries?")
				? new Promise(r => {
						late = r
					})
				: never(url, init)
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
		rt.setScanDemand({ sourceId: "rtl", cursor: null, detail: null })
		rt.tick()
		expect(late).toBeDefined()
		const resolve = late!
		if (why === "timeout") await vi.advanceTimersByTimeAsync(2100)
		else if (why === "source")
			rt.setScanDemand({ sourceId: "other", cursor: null, detail: null })
		else if (why === "detail")
			rt.setScanDemand({
				sourceId: "rtl",
				cursor: null,
				detail: { kind: "job", id: "j" },
			})
		else rt.stop()
		const body = new ReadableStream<Uint8Array>({ cancel })
		resolve({ ok: true, status: 200, statusText: "OK", body, json })
		await vi.advanceTimersByTimeAsync(200)
		expect(cancel).toHaveBeenCalledTimes(1)
		expect(json).not.toHaveBeenCalled()
		expect(rt.store.get().scan.lanes.discoveries.value).toBeNull()
		rt.stop()
	},
)

it.each(["profile-first", "source-first"] as const)(
	"admits requestedB after old servedA removal (%s) and continues REST reads",
	async order => {
		const { SCAN_PROFILE, SCAN_FRAME } =
			await import("../../../cli/source/test/fixtures.js")
		const ws = wsFake(),
			reads: string[] = []
		const fetchFn: FetchLike = (url, init) => {
			if (url.includes("/api/scanner") || url.includes("/api/spectrum")) {
				reads.push(url)
				return Promise.resolve(
					new Response(
						JSON.stringify(
							url.endsWith("/jobs") ? [] : { items: [], nextCursor: null },
						),
					),
				)
			}
			return never(url, init)
		}
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		try {
			rt.start()
			rt.setScanDemand({ sourceId: "A", cursor: null, detail: null })
			const h = ws.sockets[0]!
			h.open()
			h.message(JSON.stringify({ type: "subscribed", data: { channels: [] } }))
			const event = (type: string, data: unknown) =>
				h.message(
					JSON.stringify({
						type,
						channel: type.startsWith("source:") ? "sources" : "spectrum",
						data,
					}),
				)
			event("spectrum:profile", { ...SCAN_PROFILE, sourceId: "A" })
			event("spectrum:frame", { ...SCAN_FRAME, sourceId: "A" })
			rt.tick()
			expect(rt.store.get().scan.rows).toHaveLength(1)
			rt.setScanDemand({ sourceId: "B", cursor: null, detail: null })
			const removal = () =>
				event("spectrum:profile", {
					selection: "none",
					sourceId: null,
					profile: null,
					effectiveHz: null,
					outcome: "removed",
					adjusted: [],
					removedSourceId: "A",
					code: "SPECTRUM_SOURCE_REMOVED",
				})
			const source = () => event("source:removed", { sourceId: "A" })
			if (order === "profile-first") {
				removal()
				source()
			} else {
				source()
				removal()
			}
			rt.tick()
			expect(rt.store.get().scan.sourceId).toBe("B")
			expect(rt.store.get().scan.phase).toBe("negotiating")
			expect(rt.store.get().scan.rows).toHaveLength(0)
			event("spectrum:profile", { ...SCAN_PROFILE, sourceId: "B" })
			event("spectrum:frame", { ...SCAN_FRAME, sourceId: "B" })
			rt.tick()
			expect(rt.store.get().scan.profile?.sourceId).toBe("B")
			expect(rt.store.get().scan.rows[0]?.frame.sourceId).toBe("B")
			await vi.advanceTimersByTimeAsync(200)
			const before = reads.length
			await vi.advanceTimersByTimeAsync(5200)
			expect(reads.length).toBeGreaterThan(before)
			expect(rt.store.get().scan.phase).toBe("waiting")
		} finally {
			rt.stop()
		}
	},
)

it.each([0, 10000])(
	"admits signed unverified Spectrum history at centre%s",
	async centerHz => {
		const { SCAN_FRAME, SCAN_PROFILE } =
			await import("../../../cli/source/test/fixtures.js")
		const ws = wsFake()
		const rt = createRuntime({
			fetchFn: never,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		try {
			rt.start()
			rt.setScanDemand({ sourceId: "rtl", cursor: null, detail: null })
			const h = ws.sockets[0]!
			h.open()
			h.message(JSON.stringify({ type: "subscribed", data: { channels: [] } }))
			h.message(
				JSON.stringify({
					type: "spectrum:profile",
					channel: "spectrum",
					data: SCAN_PROFILE,
				}),
			)
			h.message(
				JSON.stringify({
					type: "spectrum:frame",
					channel: "spectrum",
					data: {
						...SCAN_FRAME,
						centerHz,
						startHz: centerHz - 819500,
						binHz: 4000,
						binCount: 410,
						bins: Buffer.from(new Uint8Array(410).fill(70)).toString("base64"),
						tuningTrust: "unverified",
						tracks: [
							{
								startHz: -50500,
								endHz: -40500,
								flags: { burst: false, iqImage: false, edge: false },
							},
						],
						masks: {
							dcHz: centerHz,
							dcGuardHz: 1500,
							spurRanges: [{ startHz: -30500, endHz: -20500 }],
						},
					},
				}),
			)
			rt.tick()
			const row = rt.store.get().scan.rows[0]!
			expect(row.frame.startHz).toBe(centerHz - 819500)
			expect(row.frame.tuningTrust).toBe("unverified")
			expect(row.frame.tracks[0]?.startHz).toBe(-50500)
			expect(row.frame.masks.spurRanges[0]?.startHz).toBe(-30500)
			expect(row.bins).toHaveLength(410)
			expect(rt.store.get().scan.invalidFrames).toBe(0)
		} finally {
			rt.stop()
		}
	},
)

// Identify uses real adapter dispatch fences; no render tick may authorize stale ingress.
describe("identify runtime consent and receipt", () => {
	async function readyRuntime(
		options: {
			deferredCredential?: boolean
			post?: () => Promise<Response>
			autoDiscovery?: boolean
		} = {},
	) {
		const {
			SCAN_FRAME,
			SCAN_PROFILE,
			SCAN_STATUS,
			SCAN_DISCOVERY,
			SCAN_JOB,
			scenarioState,
		} = await import("../../../cli/source/test/fixtures.js")
		const { MachineCredential } =
			await import("../../../cli/source/data/access-credentials.js")
		const state = scenarioState("live", PLAIN_SUMMARY)
		const source = {
			...state.sources.value![0]!,
			id: "rtl",
			connected: true,
			caps: {
				...state.sources.value![0]!.caps,
				kind: "iq" as const,
				format: "U8_IQ" as const,
				centerFreq: SCAN_FRAME.centerHz,
				sampleRate: SCAN_FRAME.sampleRateHz,
			},
			activity: {
				...state.sources.value![0]!.activity!,
				state: "streaming" as const,
			},
		}
		const ws = wsFake()
		const posts: string[] = [],
			reads: string[] = []
		let credentialResolve:
			| ((credential: InstanceType<typeof MachineCredential>) => void)
			| null = null
		let defer = false
		let discoveryTarget = TARGET
		let direct: unknown = {
			...SCAN_JOB,
			id: "off-list",
			identify: {
				...SCAN_JOB.identify,
				targets: SCAN_JOB.identify.targets.map(t => ({
					...t,
					jobId: "off-list",
				})),
			},
		}
		let readOverride: ((url: string) => Promise<Response> | null) | null = null
		let directStatus = 200
		const accepted = {
			...(direct as typeof SCAN_JOB),
			identify: {
				...SCAN_JOB.identify,
				target: {
					frequencyHz: SCAN_DISCOVERY.frequencyHz,
					bandwidthHz: SCAN_DISCOVERY.bandwidthHz,
				},
				timeoutMs: 15000,
				protocols: [],
				exhaustive: false,
				record: false,
				targets: SCAN_JOB.identify.targets.map(t => ({
					...t,
					jobId: "off-list",
				})),
			},
		}
		const native = vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input)
			if (init?.method === "POST") {
				posts.push(init.body as string)
				return options.post
					? options.post()
					: new Response(JSON.stringify(accepted), { status: 201 })
			}
			reads.push(url)
			const overridden = readOverride?.(url)
			if (overridden) return overridden
			const body = url.endsWith("/api/sources")
				? [source]
				: url.endsWith("/api/scanner")
					? SCAN_STATUS
					: url.includes("/discoveries/disc1/observations")
						? { items: [], nextCursor: null }
						: url.endsWith("/discoveries/disc1")
							? SCAN_DISCOVERY
							: url.includes("/discoveries?")
								? { items: [SCAN_DISCOVERY], nextCursor: null }
								: url.endsWith("/api/scanner/jobs")
									? []
									: url.endsWith("/jobs/off-list")
										? direct
										: url.endsWith("/api/spectrum")
											? { defaultProfile: SCAN_PROFILE.profile, sources: [] }
											: []
			return new Response(JSON.stringify(body), {
				status: url.endsWith("/jobs/off-list") ? directStatus : 200,
			})
		})
		const fetchFn = createCliFetch({
			fetch: native,
			policy: {
				origin: TARGET.base,
				credentials: () =>
					defer
						? new Promise(resolve => {
								credentialResolve = resolve
								defer = false
							})
						: Promise.resolve(new MachineCredential("A".repeat(43))),
			},
		})
		const rt = createRuntime({
			fetchFn,
			probeFetchFn: never,
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: options.autoDiscovery ? null : TARGET,
			discover: async () => ({ target: discoveryTarget, tried: [] }),
		})
		rt.start()
		for (let i = 0; i < 50; i++) await Promise.resolve()
		ws.sockets[0]!.open()
		ws.sockets[0]!.message(
			JSON.stringify({ type: "subscribed", data: { channels: [] } }),
		)
		const context = {
			sourceId: "rtl",
			discoveryId: "disc1",
			key: "discovery:disc1",
			active: true,
			columns: 80,
			rows: 24,
			contentRows: 19,
		}
		rt.setIdentifyContext(context)
		rt.setScanDemand({
			sourceId: "rtl",
			cursor: null,
			detail: { kind: "discovery", id: "disc1" },
		})
		const event = (type: string, data: unknown) =>
			ws.sockets[0]!.message(
				JSON.stringify({
					type,
					channel: type.startsWith("source:")
						? "sources"
						: type.startsWith("spectrum:")
							? "spectrum"
							: "scanner",
					data,
				}),
			)
		event("source:status", source)
		event("spectrum:profile", SCAN_PROFILE)
		event("spectrum:frame", SCAN_FRAME)
		rt.tick()
		for (let i = 0; i < 50; i++) await Promise.resolve()
		rt.tick()
		expect(
			rt.identifySnapshot().readiness,
			JSON.stringify(rt.identifySnapshot().readiness),
		).toMatchObject({ ready: true })
		defer = options.deferredCredential === true
		return {
			rt,
			event,
			context,
			source,
			SCAN_FRAME,
			SCAN_PROFILE,
			SCAN_STATUS,
			posts,
			reads,
			native,
			accepted,
			ws,
			setDiscoveryTarget: (next: typeof TARGET) => {
				discoveryTarget = next
			},
			setReadOverride: (
				override: (url: string) => Promise<Response> | null,
			) => {
				readOverride = override
			},
			resolveCredential: () =>
				credentialResolve?.(new MachineCredential("A".repeat(43))),
			setDirect: (body: unknown, status = 200) => {
				direct = body
				directStatus = status
			},
			prompt: () => {
				const p = rt.prepareIdentify(context)!
				expect(p).not.toBeNull()
				rt.markIdentifyVisible(p.token)
				return p
			},
		}
	}
	async function drain() {
		for (let i = 0; i < 60; i++) await Promise.resolve()
	}
	it("requires committed consent, consumes double y once, adopts201 but unlocks only exact-ID GET", async () => {
		const h = await readyRuntime()
		const hidden = h.rt.prepareIdentify(h.context)!
		h.rt.confirmIdentify(hidden.token)
		expect(h.posts).toHaveLength(0)
		const p = h.prompt()
		h.rt.confirmIdentify(p.token)
		h.rt.confirmIdentify(p.token)
		await drain()
		expect(h.posts).toHaveLength(1)
		expect(JSON.parse(h.posts[0]!)).toEqual({
			sourceId: "rtl",
			target: { frequencyHz: 446056250, bandwidthHz: 12500 },
			timeoutMs: 15000,
			exhaustive: false,
			record: false,
		})
		expect(h.rt.identifySnapshot().receipt?.phase).toBe("known")
		expect(h.reads).not.toContain(`${TARGET.base}/api/scanner/jobs/off-list`)
		h.rt.setIdentifyInspection(true)
		await drain()
		expect(h.reads).toContain(`${TARGET.base}/api/scanner/jobs/off-list`)
		expect(h.rt.identifySnapshot().receipt?.phase).toBe("terminal-confirmed")
		h.rt.stop()
	})
	it.each([
		"disconnect",
		"remove",
		"caps",
		"profile",
		"epoch",
		"trust",
		"discovery",
		"invalid",
		"disabled",
		"help",
		"resize",
		"freshness",
		"reconnect",
	])(
		"fences deferred credentials without any render tick: %s",
		async invalidator => {
			const h = await readyRuntime({ deferredCredential: true })
			const p = h.prompt()
			h.rt.confirmIdentify(p.token)
			switch (invalidator) {
				case "disconnect":
					h.event("source:disconnected", { sourceId: "rtl" })
					break
				case "remove":
					h.event("source:removed", { sourceId: "rtl" })
					break
				case "caps":
					h.event("source:caps-changed", {
						sourceId: "rtl",
						caps: { ...h.source.caps, centerFreq: 445000000 },
					})
					break
				case "profile":
					h.event("spectrum:profile", h.SCAN_PROFILE)
					break
				case "epoch":
					h.event("spectrum:frame", { ...h.SCAN_FRAME, epoch: 999 })
					break
				case "trust":
					h.event("spectrum:frame", {
						...h.SCAN_FRAME,
						tuningTrust: "unverified",
					})
					break
				case "discovery":
					h.event("scanner:discovery", {
						change: "merged",
						discovery: {
							...(await import("../../../cli/source/test/fixtures.js"))
								.SCAN_DISCOVERY,
							id: "survivor",
						},
					})
					break
				case "invalid":
					h.event("spectrum:frame", {})
					break
				case "disabled":
					h.event("scanner:status", { ...h.SCAN_STATUS, enabled: false })
					break
				case "help":
					h.rt.setIdentifyContext({ ...h.context, active: false, key: "help" })
					break
				case "resize":
					h.rt.setIdentifyContext({ ...h.context, columns: 59 })
					break
				case "freshness":
					vi.setSystemTime(Date.now() + 15001)
					break
				case "reconnect":
					h.rt.reconnect()
					break
			}
			h.resolveCredential()
			await drain()
			expect(h.posts).toHaveLength(0)
			expect(h.rt.identifySnapshot().receipt?.phase).toBe("unsent")
			h.rt.stop()
		},
	)
	it("equivalent frames refresh age without revoking visible consent", async () => {
		const h = await readyRuntime({ deferredCredential: true })
		const p = h.prompt()
		h.rt.confirmIdentify(p.token)
		h.event("spectrum:frame", { ...h.SCAN_FRAME, at: "2026-10-11T12:00:01Z" })
		h.resolveCredential()
		await drain()
		expect(h.posts).toHaveLength(1)
		h.rt.stop()
	})
	it("keeps receipt reads independent of removed source, display demand and failed list", async () => {
		const h = await readyRuntime()
		const p = h.prompt()
		h.rt.confirmIdentify(p.token)
		await drain()
		h.rt.setIdentifyInspection(false)
		h.rt.setScanDemand(null)
		h.rt.setIdentifyContext({
			...h.context,
			sourceId: null,
			discoveryId: null,
			active: false,
		})
		h.event("source:removed", { sourceId: "rtl" })
		h.setDirect({ code: "NOT_FOUND" }, 404)
		h.rt.setIdentifyInspection(true)
		await drain()
		expect(h.rt.identifySnapshot().receipt).toMatchObject({
			phase: "known",
			jobId: "off-list",
			terminalAt: null,
		})
		expect(h.posts).toHaveLength(1)
		h.rt.stop()
	})
	it.each(["failed", "oversized", "over-200"])(
		"exact-ID inspection survives an actual %s job list",
		async mode => {
			const h = await readyRuntime()
			const { SCAN_JOB } = await import("../../../cli/source/test/fixtures.js")
			h.setReadOverride(url =>
				url.endsWith("/api/scanner/jobs")
					? Promise.resolve(
							mode === "failed"
								? new Response("{}", { status: 503 })
								: mode === "oversized"
									? new Response(" ".repeat(2 * 1024 * 1024 + 1))
									: new Response(
											JSON.stringify(
												Array.from({ length: 201 }, (_, i) => ({
													...SCAN_JOB,
													id: `other-${i}`,
												})),
											),
										),
						)
					: null,
			)
			vi.setSystemTime(Date.now() + 5001)
			h.event("spectrum:frame", h.SCAN_FRAME)
			h.rt.tick()
			await drain()
			h.rt.tick()
			if (mode === "over-200") {
				expect(h.rt.store.get().scan.lanes.jobs.value).toHaveLength(200)
				expect(h.rt.store.get().scan.omittedJobs).toBe(1)
			} else expect(h.rt.store.get().scan.lanes.jobs.error).not.toBeNull()
			const p = h.prompt()
			h.rt.confirmIdentify(p.token)
			await drain()
			expect(h.rt.identifySnapshot().receipt?.phase).toBe("known")
			h.rt.setScanDemand(null)
			h.rt.setIdentifyInspection(true)
			await drain()
			expect(h.reads).toContain(`${TARGET.base}/api/scanner/jobs/off-list`)
			expect(h.rt.identifySnapshot().receipt?.phase).toBe("terminal-confirmed")
			h.rt.stop()
		},
	)
	it.each(["leave", "help", "source", "tab", "close-and-restore"])(
		"late201 retains attribution without restoring %s focus or demand",
		async mode => {
			let release!: (response: Response) => void
			const h = await readyRuntime({
				post: () =>
					new Promise(resolve => {
						release = resolve
					}),
			})
			const p = h.prompt()
			h.rt.confirmIdentify(p.token)
			await drain()
			expect(h.posts).toHaveLength(1)
			h.rt.setIdentifyInspection(false)
			h.rt.setScanDemand(null)
			h.rt.setIdentifyContext({
				...h.context,
				active: mode === "source" || mode === "tab",
				sourceId: mode === "source" ? "other" : "rtl",
				key: mode,
			})
			if (mode === "close-and-restore") h.rt.setIdentifyContext(h.context)
			release(new Response(JSON.stringify(h.accepted), { status: 201 }))
			await drain()
			await vi.advanceTimersByTimeAsync(5001)
			expect(h.rt.identifySnapshot()).toMatchObject({
				receipt: { phase: "known", destination: TARGET.base },
				inspection: false,
				autoOpen: null,
			})
			expect(h.reads.filter(url => url.endsWith("/jobs/off-list"))).toEqual([])
			h.rt.setIdentifyInspection(true)
			await drain()
			expect(h.rt.identifySnapshot().receipt?.phase).toBe("terminal-confirmed")
			h.rt.stop()
		},
	)
	it.each(["trust", "target", "lockout", "membership", "metadata"])(
		"REST %s refresh permanently fences material consent but permits benign metadata",
		async mode => {
			const h = await readyRuntime()
			const { SCAN_DISCOVERY } =
				await import("../../../cli/source/test/fixtures.js")
			const p = h.prompt()
			const changed =
				mode === "trust"
					? { ...SCAN_DISCOVERY, tuningTrust: "relay" }
					: mode === "target"
						? { ...SCAN_DISCOVERY, frequencyHz: SCAN_DISCOVERY.frequencyHz + 1 }
						: mode === "lockout"
							? {
									...SCAN_DISCOVERY,
									operator: { lockout: true },
								}
							: mode === "membership"
								? { ...SCAN_DISCOVERY, sourceIds: ["other"] }
								: { ...SCAN_DISCOVERY, lastSeenAt: "2026-10-11T12:00:01Z" }
			h.setReadOverride(url =>
				url.endsWith("/discoveries/disc1")
					? Promise.resolve(new Response(JSON.stringify(changed)))
					: null,
			)
			vi.setSystemTime(Date.now() + 5001)
			h.event("spectrum:frame", h.SCAN_FRAME)
			h.rt.tick()
			await drain()
			h.setReadOverride(() => null)
			vi.setSystemTime(Date.now() + 5001)
			h.event("spectrum:frame", h.SCAN_FRAME)
			h.rt.tick()
			await drain()
			h.rt.confirmIdentify(p.token)
			await drain()
			expect(h.posts).toHaveLength(mode === "metadata" ? 1 : 0)
			h.rt.stop()
		},
	)

	it("REST trust change during deferred credentials refuses native dispatch without a render tick", async () => {
		const h = await readyRuntime({ deferredCredential: true })
		const { SCAN_DISCOVERY } =
			await import("../../../cli/source/test/fixtures.js")
		const p = h.prompt()
		h.rt.confirmIdentify(p.token)
		await drain()
		h.setReadOverride(url =>
			url.endsWith("/discoveries/disc1")
				? Promise.resolve(
						new Response(
							JSON.stringify({ ...SCAN_DISCOVERY, tuningTrust: "relay" }),
						),
					)
				: null,
		)
		vi.setSystemTime(Date.now() + 5001)
		h.event("spectrum:frame", h.SCAN_FRAME)
		h.rt.tick()
		await drain()
		h.resolveCredential()
		await drain()
		expect(h.posts).toHaveLength(0)
		expect(h.rt.identifySnapshot().receipt?.phase).toBe("unsent")
		h.rt.stop()
	})
	it("late A201 cannot focus B or read its ID there; explicit inspection back at A uses a new generation", async () => {
		let release!: (response: Response) => void
		const h = await readyRuntime({
			autoDiscovery: true,
			post: () =>
				new Promise(resolve => {
					release = resolve
				}),
		})
		const p = h.prompt()
		h.rt.confirmIdentify(p.token)
		await drain()
		const B = {
			base: "http://127.0.0.1:9200",
			ws: "ws://127.0.0.1:9200/ws",
			explicit: true,
		}
		h.setDiscoveryTarget(B)
		h.setReadOverride(url =>
			url.startsWith(TARGET.base)
				? Promise.reject(new Error("A unavailable"))
				: null,
		)
		await vi.advanceTimersByTimeAsync(5001)
		vi.setSystemTime(Date.now() + 16000)
		await vi.advanceTimersByTimeAsync(5001)
		await drain()
		h.rt.tick()
		expect(
			h.rt.store.get().conn.target.base,
			JSON.stringify({ conn: h.rt.store.get().conn, reads: h.reads }),
		).toBe(B.base)
		h.rt.setIdentifyContext({ ...h.context, key: "B detail" })
		release(new Response(JSON.stringify(h.accepted), { status: 201 }))
		await drain()
		expect(h.rt.identifySnapshot()).toMatchObject({
			receipt: { phase: "known", destination: TARGET.base },
			autoOpen: null,
			inspection: false,
		})
		h.rt.setIdentifyInspection(true)
		await drain()
		expect(h.reads.filter(url => url.endsWith("/jobs/off-list"))).toEqual([])
		const oldGeneration = h.rt.identifySnapshot().receipt!.readGeneration
		h.rt.setIdentifyInspection(false)
		h.setDiscoveryTarget(TARGET)
		h.setReadOverride(url =>
			url.startsWith(B.base)
				? Promise.reject(new Error("B unavailable"))
				: null,
		)
		await vi.advanceTimersByTimeAsync(5001)
		vi.setSystemTime(Date.now() + 16000)
		await vi.advanceTimersByTimeAsync(5001)
		await drain()
		h.rt.tick()
		expect(h.rt.store.get().conn.target.base).toBe(TARGET.base)
		h.rt.setIdentifyInspection(true)
		await drain()
		expect(h.reads.filter(url => url.endsWith("/jobs/off-list"))).toEqual([
			`${TARGET.base}/api/scanner/jobs/off-list`,
		])
		expect(h.rt.identifySnapshot().receipt).toMatchObject({
			phase: "terminal-confirmed",
			destination: TARGET.base,
		})
		expect(h.rt.identifySnapshot().receipt!.readGeneration).toBeGreaterThan(
			oldGeneration,
		)
		h.rt.stop()
	})

	it("a detail GET issued before discovery ingress cannot reauthorize, but a new successful inspection can", async () => {
		const h = await readyRuntime()
		const { SCAN_DISCOVERY } =
			await import("../../../cli/source/test/fixtures.js")
		let resolve!: (response: Response) => void
		h.setReadOverride(url =>
			url.endsWith("/discoveries/disc1")
				? new Promise(r => {
						resolve = r
					})
				: null,
		)
		vi.setSystemTime(Date.now() + 5001)
		h.rt.tick()
		await drain()
		expect(resolve).toBeTypeOf("function")
		h.event("scanner:discovery", {
			change: "merged",
			discovery: { ...SCAN_DISCOVERY, id: "survivor" },
		})
		resolve(new Response(JSON.stringify(SCAN_DISCOVERY)))
		await drain()
		expect(h.rt.identifySnapshot().readiness.reason).toBe(
			"Reinspect a fresh discovery detail",
		)
		expect(h.rt.prepareIdentify(h.context)).toBeNull()
		expect(h.posts).toHaveLength(0)
		h.setReadOverride(() => null)
		vi.setSystemTime(Date.now() + 5001)
		h.rt.tick()
		await drain()
		expect(h.rt.identifySnapshot().readiness.ready).toBe(true)
		h.rt.stop()
	})
	it("live dimensions changing during credentials fail before native dispatch, even without a resize render", async () => {
		const h = await readyRuntime({ deferredCredential: true })
		let live = h.context
		h.rt.setIdentifyContext(h.context, () => live)
		const p = h.prompt()
		h.rt.confirmIdentify(p.token)
		live = { ...h.context, columns: 0, rows: 0 }
		h.resolveCredential()
		await drain()
		expect(h.posts).toHaveLength(0)
		expect(h.rt.identifySnapshot().receipt?.phase).toBe("unsent")
		h.rt.stop()
	})
	it("post-dispatch deadline preserves201 with stalled body and never promotes late completion", async () => {
		let release!: () => void
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				release = () => {
					try {
						controller.enqueue(Buffer.from("{}"))
						controller.close()
					} catch {
						/* cancelled */
					}
				}
			},
		})
		const h = await readyRuntime({
			post: async () => new Response(body, { status: 201 }),
		})
		const p = h.prompt()
		h.rt.confirmIdentify(p.token)
		await drain()
		await vi.advanceTimersByTimeAsync(15000)
		expect(h.rt.identifySnapshot().receipt).toMatchObject({
			phase: "unresolved",
			status: 201,
			acceptedResponse: true,
		})
		release()
		await drain()
		h.rt.reconnect()
		expect(h.rt.identifySnapshot().receipt?.phase).toBe("unresolved")
		expect(h.rt.prepareIdentify(h.context)).toBeNull()
		expect(h.posts).toHaveLength(1)
		h.rt.stop()
	})
})
