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
	const factory: WsFactory = (_url, h) => {
		sockets.push(h)
		return { send: () => undefined, close: () => undefined }
	}
	return { factory, sockets }
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
		expect(rec?.state).toBe("sent")
		expect(
			rec?.outcomes.map(o => [o.label, o.result?.outcome ?? null]),
		).toEqual([
			["frequency", "unknown"],
			["gain", null],
		])
		rt.stop()
	})

	it("stop() halts the flush, polls and socket", async () => {
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
		rt.stop()
		const calls = fetchFn.mock.calls.length
		const commits = rt.store.commits()
		await vi.advanceTimersByTimeAsync(30_000)
		expect(fetchFn.mock.calls.length).toBe(calls)
		expect(rt.store.commits()).toBe(commits)
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
