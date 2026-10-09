import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FetchLike } from "../../../cli/source/data/config.js"
import { PLAIN_SUMMARY } from "../../../cli/source/data/reducers.js"
import {
	FLUSH_MS,
	createRuntime,
	type Timers,
} from "../../../cli/source/data/runtime.js"
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
		const fetchFn = vi.fn<FetchLike>(url => okJson(bodies(url)))
		const rt = createRuntime({
			fetchFn,
			wsFactory: wsFake().factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})
		rt.start()
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
		await vi.advanceTimersByTimeAsync(FLUSH_MS)
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
			wsFactory: ws.factory,
			now: () => Date.now(),
			random: () => 0.5,
			timers: fakeTimers,
			summarize: PLAIN_SUMMARY.summarize,
			explicit: TARGET,
		})

	it("start and reconnect each fetch one set of endpoints, not one per trigger plus one per ws:open", async () => {
		const fetchFn = vi.fn<FetchLike>(url => okJson(bodies(url)))
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
})
