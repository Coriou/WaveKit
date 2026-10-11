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
	const frame = (type: string, data: unknown) =>
		JSON.stringify({ type, channel: "x", data })
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
