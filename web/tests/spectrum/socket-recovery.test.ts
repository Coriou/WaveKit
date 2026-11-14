import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SpectrumPipeline } from "../../src/spectrum/pipeline.ts"
import {
	DEFAULT_LAYOUT,
	DEFAULT_LEVELS,
	MAX_BINS,
	type SpectrumLinkState,
	type WorkerToMain,
} from "../../src/spectrum/protocol.ts"
import {
	type AuthProbe,
	type AuthProbeResult,
	BACKOFF_CAP_ATTEMPT,
	BACKOFF_CAP_MS,
	KICK_AFTER_SUBSCRIBE_MS,
	PAUSED_WATCH_MS,
	PROBE_AFTER_FAILED_CONNECTS,
	SpectrumSocket,
	authProbeUrl,
	closeNeedsAuthCheck,
	fetchAuthProbe,
	stallTimeoutMs,
} from "../../src/spectrum/socket.ts"
import { backoffDelay } from "../../src/spectrum/schedule.ts"
import { FakeFrames, FakeRenderer, FakeTimers } from "./fakes.ts"
import { frame } from "./frames.ts"

/** A browser-shaped WebSocket the test drives by hand. */
class FakeWebSocket {
	static readonly CONNECTING = 0
	static readonly OPEN = 1
	static readonly CLOSING = 2
	static readonly CLOSED = 3
	static all: FakeWebSocket[] = []
	readonly url: string
	readyState = FakeWebSocket.CONNECTING
	sent: string[] = []
	closed = false
	onopen: (() => void) | null = null
	onmessage: ((event: { data: unknown }) => void) | null = null
	onclose: ((event: { code: number; reason: string }) => void) | null = null
	onerror: (() => void) | null = null

	constructor(url: string) {
		this.url = url
		FakeWebSocket.all.push(this)
	}
	/** The fake core: what it answers to each subscribe (one macrotask later, like a real socket). */
	core: (() => string[]) | null = null
	send(text: string): void {
		this.sent.push(text)
		if (JSON.parse(text).type === "subscribe")
			this.subscribeTimes.push(Date.now() - T0)
		const core = this.core
		if (core && JSON.parse(text).type === "subscribe")
			setTimeout(() => {
				if (this.readyState !== FakeWebSocket.OPEN) return
				for (const m of core()) this.receive(m)
			}, 0)
	}
	close(): void {
		this.closed = true
		this.readyState = FakeWebSocket.CLOSED
	}
	// test side
	open(): void {
		this.readyState = FakeWebSocket.OPEN
		this.onopen?.()
	}
	receive(text: string): void {
		this.onmessage?.({ data: text })
	}
	drop(code = 1006, reason = ""): void {
		this.readyState = FakeWebSocket.CLOSED
		this.onerror?.()
		this.onclose?.({ code, reason })
	}
	get subscribes(): number {
		return this.sent.filter(m => JSON.parse(m).type === "subscribe").length
	}
	/** Fake-clock times (ms since the test start) of each subscribe sent. */
	subscribeTimes: number[] = []
}

const T0 = Date.parse("2026-10-16T12:00:00.000Z")
const SUB = { sourceId: "rtl", hz: 25, bins: 2048 }

function ack(
	over: {
		outcome?: string
		effectiveHz?: number
		backfillFrames?: number
	} = {},
): string {
	return JSON.stringify({
		type: "spectrum:profile",
		channel: "spectrum",
		data: {
			selection: "source",
			sourceId: "rtl",
			outcome: over.outcome ?? "exact",
			adjusted: [],
			profile: { key: "25:2048", hz: 25, bins: 2048 },
			effectiveHz: over.effectiveHz ?? 25,
			...(over.backfillFrames !== undefined
				? { backfillFrames: over.backfillFrames }
				: {}),
		},
	})
}

function atSecond(second: number): string {
	return `2026-10-16T12:00:${String(second).padStart(2, "0")}.000Z`
}

function frameAt(second: number, epoch = 1, bytes?: number[]): string {
	return JSON.stringify({
		type: "spectrum:frame",
		channel: "spectrum",
		data: frame({
			at: atSecond(second),
			epoch,
			...(bytes ? { bytes } : {}),
		}),
	})
}

/** A replayed frame as the core sends after each ack: backfill (oldest first) or the snapshot. */
function replayAt(
	second: number,
	kind: "backfill" | "snapshot",
	bytes?: number[],
): string {
	return JSON.stringify({
		type: "spectrum:frame",
		channel: "spectrum",
		data: {
			...frame({ at: atSecond(second), ...(bytes ? { bytes } : {}) }),
			[kind]: true,
		},
	})
}

/** What the real core answers to every subscribe of a paused source: ack, backfill, snapshot. */
function pausedCoreAnswer(): string[] {
	return [
		ack({ backfillFrames: 2 }),
		replayAt(1, "backfill"),
		replayAt(2, "backfill"),
		replayAt(2, "snapshot"),
	]
}

function latest(): FakeWebSocket {
	const ws = FakeWebSocket.all.at(-1)
	if (!ws) throw new Error("no socket")
	return ws
}

/** A probe that answers `result` and counts its calls. */
function probe(result: AuthProbeResult): AuthProbe & { calls: number } {
	const fn = Object.assign(
		() => {
			fn.calls++
			return Promise.resolve(result)
		},
		{ calls: 0 },
	)
	return fn
}

const UNREACHABLE: AuthProbeResult = { lost: false, status: null }

function openSocket(authProbe: AuthProbe = probe(UNREACHABLE)) {
	const states: SpectrumLinkState[] = []
	const attempts: number[] = []
	const messages: string[] = []
	const frames: string[] = []
	let failure: string | undefined
	const socket = new SpectrumSocket(
		"ws://core/ws",
		{
			message: m => {
				messages.push(m.type)
				if (m.type === "spectrum:frame") frames.push(m.data.at)
			},
			state: (s, info) => {
				// state changes only: an attempts update repeats the state
				if (states.at(-1) !== s) states.push(s)
				if (info?.attempts !== undefined) attempts.push(info.attempts)
				if (info?.message !== undefined) failure = info.message
			},
		},
		{ authProbe },
	)
	socket.setSubscription(SUB)
	return {
		socket,
		states,
		attempts,
		messages,
		frames,
		failure: () => failure,
	}
}

beforeEach(() => {
	FakeWebSocket.all = []
	vi.useFakeTimers()
	vi.setSystemTime(new Date(T0))
	// backoffDelay's jitter at its midpoint: attempt n waits exactly 500 · 2^n ms (≤ 10 s)
	vi.spyOn(Math, "random").mockReturnValue(0.5)
	vi.stubGlobal("WebSocket", FakeWebSocket)
	// never a real request from a unit test
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("no network in tests"))),
	)
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe("SpectrumSocket recovery", () => {
	it("reconnects with backoff after a drop, resubscribes, and goes reconnecting → live", () => {
		const t = openSocket()
		const first = latest()
		first.open()
		expect(first.subscribes).toBe(1)
		first.receive(ack())
		first.receive(frameAt(1))
		expect(t.states).toEqual(["connecting", "live"])

		first.drop()
		expect(t.states.at(-1)).toBe("reconnecting")
		// backoff: nothing before 500 ms, then a new socket
		vi.advanceTimersByTime(499)
		expect(FakeWebSocket.all).toHaveLength(1)
		vi.advanceTimersByTime(1)
		expect(FakeWebSocket.all).toHaveLength(2)

		// that one fails too: the next attempt waits twice as long
		latest().drop()
		vi.advanceTimersByTime(999)
		expect(FakeWebSocket.all).toHaveLength(2)
		vi.advanceTimersByTime(1)
		expect(FakeWebSocket.all).toHaveLength(3)

		const third = latest()
		third.open()
		// the same subscription, sent again on the new socket
		expect(third.sent.map(m => JSON.parse(m))).toEqual([
			{
				type: "subscribe",
				channels: ["spectrum"],
				options: { spectrum: SUB },
			},
		])
		// open, the ack and its replayed frames are not live: still reconnecting
		third.receive(ack({ backfillFrames: 1 }))
		third.receive(replayAt(1, "backfill"))
		third.receive(replayAt(1, "snapshot"))
		expect(t.states.at(-1)).toBe("reconnecting")
		third.receive(frameAt(5))
		expect(t.states.at(-1)).toBe("live")
		expect(t.frames.at(-1)).toBe("2026-10-16T12:00:05.000Z")
		// a live frame resets the backoff
		third.drop()
		vi.advanceTimersByTime(500)
		expect(FakeWebSocket.all).toHaveLength(4)
		t.socket.dispose()
	})

	it("resubscribes a silent stream with a growing backoff; the core's ack, backfill and snapshot never count as live", () => {
		const t = openSocket()
		const ws = latest()
		ws.core = pausedCoreAnswer
		ws.open()
		vi.advanceTimersByTime(0)
		// the first answer is replay only: not live yet
		expect(t.states).toEqual(["connecting"])
		ws.receive(frameAt(3))
		expect(t.states).toEqual(["connecting", "live"])
		const timeout = stallTimeoutMs(SUB.hz)

		// the source stops: every resubscribe gets ack + backfill + snapshot back
		vi.advanceTimersByTime(120_000)
		expect(t.states).toEqual(["connecting", "live", "reconnecting"])
		const times = ws.subscribeTimes
		const gaps = times.slice(2).map((at, i) => at - (times[i + 1] ?? 0))
		// 5 s stall, then max(stall, backoff) spacing growing to the 10 s cap
		expect(times[1]).toBe(timeout)
		expect(gaps.slice(0, 4)).toEqual([5000, 5000, 5000, 8000])
		expect(new Set(gaps.slice(4))).toEqual(new Set([10_000]))
		expect(ws.subscribes).toBeLessThanOrEqual(15)
		expect(FakeWebSocket.all).toHaveLength(1)

		// the core resumes the source: live frames flow again on the same socket, no reload
		ws.receive(frameAt(30))
		expect(t.states.at(-1)).toBe("live")
		const sent = ws.subscribes
		for (let i = 0; i < 20; i++) {
			vi.advanceTimersByTime(1000)
			ws.receive(frameAt(31 + i))
		}
		expect(ws.subscribes).toBe(sent)
		t.socket.dispose()
	})

	it("times the stall from the rate the core acked, not the one asked", () => {
		const t = openSocket()
		const ws = latest()
		ws.open()
		// asked 25 Hz, served 0.5 Hz: 4 periods are 8 s
		ws.receive(ack({ effectiveHz: 0.5 }))
		ws.receive(frameAt(1))
		vi.advanceTimersByTime(7999)
		expect(ws.subscribes).toBe(1)
		ws.receive(frameAt(9))
		vi.advanceTimersByTime(7999)
		expect(ws.subscribes).toBe(1)
		vi.advanceTimersByTime(1)
		expect(ws.subscribes).toBe(2)
		expect(stallTimeoutMs(0.5)).toBe(8000)
		t.socket.dispose()
	})

	it("waits the backoff cap after a rejected ack", () => {
		const t = openSocket()
		const ws = latest()
		ws.open()
		ws.receive(ack())
		ws.receive(frameAt(1))
		vi.advanceTimersByTime(stallTimeoutMs(SUB.hz))
		expect(ws.subscribes).toBe(2)
		// the core could not start the engine
		ws.receive(ack({ outcome: "rejected" }))
		const cap = backoffDelay(BACKOFF_CAP_ATTEMPT)
		expect(cap).toBe(10_000)
		vi.advanceTimersByTime(cap - 1)
		expect(ws.subscribes).toBe(2)
		vi.advanceTimersByTime(1)
		expect(ws.subscribes).toBe(3)
		ws.receive(ack({ outcome: "rejected" }))
		vi.advanceTimersByTime(cap - 1)
		expect(ws.subscribes).toBe(3)
		vi.advanceTimersByTime(1)
		expect(ws.subscribes).toBe(4)
		t.socket.dispose()
	})

	it("while the receiver is paused resubscribes only every PAUSED_WATCH_MS, stays live, and resubscribes at once on resume", () => {
		const t = openSocket()
		const ws = latest()
		ws.core = pausedCoreAnswer
		ws.open()
		ws.receive(frameAt(1))
		t.socket.setSourcePaused(true)
		vi.advanceTimersByTime(10 * 60_000)
		// slow checks, never a burst of engine start attempts
		const gaps = ws.subscribeTimes
			.slice(1)
			.map((at, i) => at - ws.subscribeTimes[i]!)
		expect(gaps.length).toBeGreaterThan(0)
		expect(Math.min(...gaps)).toBeGreaterThanOrEqual(PAUSED_WATCH_MS)
		expect(ws.subscribes).toBeLessThanOrEqual(
			1 + (10 * 60_000) / PAUSED_WATCH_MS,
		)
		// a paused receiver sending nothing is not a stalled link
		expect(t.states).toEqual(["connecting", "live"])

		const before = ws.subscribes
		t.socket.setSourcePaused(false)
		expect(ws.subscribes).toBe(before + 1)
		vi.advanceTimersByTime(0)
		ws.receive(frameAt(40))
		expect(t.states.at(-1)).toBe("live")
		t.socket.dispose()
	})

	it("reconnects a socket dropped during a pause without waiting for the resume", () => {
		const t = openSocket()
		const ws = latest()
		ws.open()
		ws.receive(frameAt(1))
		t.socket.setSourcePaused(true)
		ws.drop()
		vi.advanceTimersByTime(backoffDelay(0))
		expect(FakeWebSocket.all).toHaveLength(2)
		latest().open()
		expect(latest().subscribes).toBe(1)
		// the receiver resumed but the page never heard: frames flow again on the new socket
		latest().receive(frameAt(50))
		expect(t.states.at(-1)).toBe("live")
		t.socket.dispose()
	})

	it("keeps resubscribing at the paused pace when the page's pause is stale and the core lost the subscription", () => {
		const t = openSocket()
		const ws = latest()
		ws.open()
		ws.receive(frameAt(1))
		t.socket.setSourcePaused(true)
		// the core answers resubscribes, but only the third one brings frames back
		let answered = 0
		ws.core = () => (++answered >= 2 ? [ack(), frameAt(30)] : [ack()])
		vi.advanceTimersByTime(3 * PAUSED_WATCH_MS + 1000)
		expect(answered).toBeGreaterThanOrEqual(2)
		expect(t.frames).toContain(atSecond(30))
		expect(t.states.at(-1)).toBe("live")
		t.socket.dispose()
	})

	it("kick: a live stream is left alone, a silent one resubscribes at once", () => {
		const t = openSocket()
		const ws = latest()
		ws.open()
		ws.receive(frameAt(1))
		t.socket.kick()
		expect(ws.subscribes).toBe(1)
		vi.advanceTimersByTime(stallTimeoutMs(25) - 1)
		ws.receive(frameAt(2))
		t.socket.kick()
		expect(ws.subscribes).toBe(1)
		// paused and silent for longer than the stall timeout: the kick does not wait for the watchdog
		t.socket.setSourcePaused(true)
		vi.advanceTimersByTime(stallTimeoutMs(25) + 1)
		const before = ws.subscribes
		t.socket.kick()
		expect(ws.subscribes).toBe(before + 1)
		t.socket.dispose()
	})

	it("kick: a resume and its resync in one render send one subscribe, not two", () => {
		const t = openSocket()
		const ws = latest()
		ws.open()
		ws.receive(frameAt(1))
		t.socket.setSourcePaused(true)
		vi.advanceTimersByTime(PAUSED_WATCH_MS - 1000)
		const before = ws.subscribes
		// SpectrumCanvas: the sourcePaused effect, then the resync effect
		t.socket.setSourcePaused(false)
		t.socket.kick()
		expect(ws.subscribes).toBe(before + 1)
		// past the in-flight window a kick into a silent stream subscribes again
		vi.advanceTimersByTime(KICK_AFTER_SUBSCRIBE_MS)
		t.socket.kick()
		expect(ws.subscribes).toBe(before + 2)
		t.socket.dispose()
	})

	it("kick: after a rejected ack waits the backoff cap like the watchdog", () => {
		const t = openSocket()
		const ws = latest()
		ws.open()
		ws.receive(ack({ outcome: "rejected" }))
		const before = ws.subscribes
		vi.advanceTimersByTime(KICK_AFTER_SUBSCRIBE_MS)
		// repeated feed or tuning changes while the core keeps refusing
		t.socket.kick()
		t.socket.kick()
		expect(ws.subscribes).toBe(before)
		vi.advanceTimersByTime(BACKOFF_CAP_MS - KICK_AFTER_SUBSCRIBE_MS)
		expect(ws.subscribes).toBe(before + 1)
		t.socket.dispose()
	})

	it("paces the paused watchdog at three backoff caps and kicks within one round trip", () => {
		expect(BACKOFF_CAP_MS).toBe(10_000)
		expect(PAUSED_WATCH_MS).toBe(3 * BACKOFF_CAP_MS)
		expect(KICK_AFTER_SUBSCRIBE_MS).toBeLessThan(stallTimeoutMs(25))
	})

	it("kick: reconnects a dropped socket at once instead of waiting the backoff", () => {
		const t = openSocket()
		const ws = latest()
		ws.open()
		ws.receive(frameAt(1))
		ws.drop()
		// a few failed connects grow the backoff
		for (let i = 0; i < 3; i++) {
			vi.advanceTimersByTime(backoffDelay(i))
			latest().drop()
		}
		const count = FakeWebSocket.all.length
		t.socket.kick()
		expect(FakeWebSocket.all).toHaveLength(count + 1)
		latest().open()
		expect(latest().subscribes).toBe(1)
		t.socket.dispose()
	})

	it("kick: tries again after a failed link", async () => {
		const lost = probe({ lost: true, status: 401 })
		const t = openSocket(lost)
		latest().drop(1008, "Access expired")
		vi.advanceTimersByTime(backoffDelay(0))
		latest().drop()
		await vi.advanceTimersByTimeAsync(0)
		expect(t.states.at(-1)).toBe("failed")
		const count = FakeWebSocket.all.length
		vi.advanceTimersByTime(60_000)
		expect(FakeWebSocket.all).toHaveLength(count)
		// paired again in another tab, then this tab became visible
		t.socket.kick()
		expect(FakeWebSocket.all).toHaveLength(count + 1)
		latest().open()
		latest().receive(frameAt(9))
		expect(t.states.at(-1)).toBe("live")
		t.socket.dispose()
	})

	it("a stall check on a socket still closing reconnects instead of waiting on it", () => {
		const t = openSocket()
		const ws = latest()
		ws.open()
		ws.receive(frameAt(1))
		// closing, and its close event never comes (a frozen tab's socket)
		ws.readyState = FakeWebSocket.CLOSING
		vi.advanceTimersByTime(stallTimeoutMs(25) + 1)
		expect(ws.closed).toBe(true)
		vi.advanceTimersByTime(backoffDelay(0))
		expect(FakeWebSocket.all).toHaveLength(2)
		latest().open()
		expect(latest().subscribes).toBe(1)
		t.socket.dispose()
	})

	it("drops and reconnects a socket that answers nothing, not even the ack", () => {
		const t = openSocket()
		const ws = latest()
		ws.open()
		ws.receive(frameAt(1))
		const timeout = stallTimeoutMs(SUB.hz)
		vi.advanceTimersByTime(timeout)
		expect(ws.subscribes).toBe(2)
		// no ack for the resubscribe within the next window: the socket is dead
		vi.advanceTimersByTime(timeout)
		expect(ws.closed).toBe(true)
		vi.advanceTimersByTime(500)
		expect(FakeWebSocket.all).toHaveLength(2)
		latest().open()
		expect(latest().subscribes).toBe(1)
		latest().receive(frameAt(20))
		expect(t.states).toEqual(["connecting", "live", "reconnecting", "live"])
		t.socket.dispose()
	})

	it("retries a 1008 close (the core's graceful stop) and goes live again when the core is back", async () => {
		const auth = probe(UNREACHABLE)
		const t = openSocket(auth)
		const ws = latest()
		ws.open()
		ws.receive(ack())
		ws.receive(frameAt(1))
		// recreate: the core closes every socket with 1008 "Access expired", then goes down
		ws.drop(1008, "Access expired")
		await vi.advanceTimersByTimeAsync(0)
		// no check against a core that is stopping
		expect(auth.calls).toBe(0)
		expect(t.states.at(-1)).toBe("reconnecting")
		// down for a while: connects fail (the first one checks the session: network error), the backoff grows
		await vi.advanceTimersByTimeAsync(500)
		latest().drop()
		await vi.advanceTimersByTimeAsync(0)
		expect(auth.calls).toBe(1)
		await vi.advanceTimersByTimeAsync(1000)
		latest().drop()
		await vi.advanceTimersByTimeAsync(2000)
		expect(t.states.at(-1)).toBe("reconnecting")
		// back up
		const back = latest()
		back.open()
		back.receive(ack())
		back.receive(frameAt(20))
		expect(t.states).toEqual(["connecting", "live", "reconnecting", "live"])
		expect(t.failure()).toBeUndefined()
		t.socket.dispose()
	})

	it("fails with an honest note when a 1008 close comes with a 401 from the session check", async () => {
		const auth = probe({ lost: true, status: 401 })
		const t = openSocket(auth)
		const ws = latest()
		ws.open()
		ws.receive(frameAt(1))
		ws.drop(1008, "Access expired")
		await vi.advanceTimersByTimeAsync(0)
		expect(auth.calls).toBe(0)
		// the core is up but refuses this browser: the reconnect is closed again
		await vi.advanceTimersByTimeAsync(500)
		expect(FakeWebSocket.all).toHaveLength(2)
		latest().open()
		latest().drop(1008, "Access expired")
		await vi.advanceTimersByTimeAsync(0)
		expect(auth.calls).toBe(1)
		expect(t.states.at(-1)).toBe("failed")
		expect(t.failure()).toContain("Access expired")
		expect(t.failure()).toContain("HTTP 401")
		expect(t.failure()).toContain("no longer signed in")
		// no retry, ever
		await vi.advanceTimersByTimeAsync(10 * 60_000)
		expect(FakeWebSocket.all).toHaveLength(2)
		expect(t.states.at(-1)).toBe("failed")
		t.socket.dispose()
	})

	it("checks the session after repeated connects that never open, and counts the attempts", async () => {
		const auth = probe({ lost: true, status: 403 })
		const t = openSocket(auth)
		for (let i = 0; i < PROBE_AFTER_FAILED_CONNECTS - 1; i++) {
			latest().drop()
			await vi.advanceTimersByTimeAsync(backoffDelay(i))
		}
		expect(auth.calls).toBe(0)
		// never live: still connecting, with the tries counted
		expect(t.states).toEqual(["connecting"])
		expect(Math.max(...t.attempts)).toBe(PROBE_AFTER_FAILED_CONNECTS - 1)
		latest().drop()
		await vi.advanceTimersByTimeAsync(0)
		expect(auth.calls).toBe(1)
		expect(t.states.at(-1)).toBe("failed")
		expect(t.failure()).toContain("HTTP 403")
		t.socket.dispose()
	})

	it("classifies close codes: none is final by itself", () => {
		expect(closeNeedsAuthCheck(1008)).toBe(true)
		// a core restart, an abnormal drop, a server error, an application code: retried without a check
		for (const code of [1000, 1001, 1006, 1011, 4001, 4401, 4500])
			expect(closeNeedsAuthCheck(code)).toBe(false)
		expect(stallTimeoutMs(25)).toBe(5000)
		expect(stallTimeoutMs(0.5)).toBe(8000)
		expect(stallTimeoutMs(undefined)).toBe(5000)
		expect(authProbeUrl("wss://wk.example/ws")).toBe(
			"https://wk.example/api/access/session",
		)
		expect(authProbeUrl("ws://localhost:5173/ws")).toBe(
			"http://localhost:5173/api/access/session",
		)
	})

	it("probes with the browser's cookie; only 401 and 403 are a lost session", async () => {
		const answers: (number | Error)[] = [
			401,
			403,
			404,
			503,
			200,
			new Error("down"),
		]
		const fetchMock = vi.fn((_url: string, _init: RequestInit) => {
			const next = answers.shift()
			if (next instanceof Error || next === undefined)
				return Promise.reject(next ?? new Error("none"))
			return Promise.resolve(new Response(null, { status: next }))
		})
		vi.stubGlobal("fetch", fetchMock)
		const check = fetchAuthProbe("http://core/api/access/session")
		const results: AuthProbeResult[] = []
		for (let i = 0; i < 6; i++) results.push(await check())
		expect(results).toEqual([
			{ lost: true, status: 401 },
			{ lost: true, status: 403 },
			{ lost: false, status: 404 },
			{ lost: false, status: 503 },
			{ lost: false, status: 200 },
			{ lost: false, status: null },
		])
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
			credentials: "include",
		})
	})
})

function pipelineOverSocket(authProbe: AuthProbe = probe(UNREACHABLE)) {
	const posted: WorkerToMain[] = []
	const renderer = new FakeRenderer()
	const pipeline = new SpectrumPipeline({
		post: msg => posted.push(msg),
		openSocket: (url, handlers) =>
			new SpectrumSocket(url, handlers, { authProbe }),
		createRenderer: () => renderer,
		frame: new FakeFrames(),
		timers: new FakeTimers(),
	})
	pipeline.handle({ type: "subscribe", subscription: SUB })
	pipeline.handle({
		type: "init",
		wsUrl: "ws://core/ws",
		canvas: {} as OffscreenCanvas,
		size: { widthCss: 100, heightCss: 100, dpr: 1 },
		layout: DEFAULT_LAYOUT,
		levels: DEFAULT_LEVELS,
		ramp: new Uint8Array(1024),
		historyRows: 16,
		texWidth: MAX_BINS,
	})
	const links = () =>
		posted.flatMap(m => (m.type === "connection" ? [m.state] : []))
	return { pipeline, renderer, posted, links }
}

describe("SpectrumPipeline over a reconnecting socket", () => {
	it("accepts the new stream's frames after a drop and posts reconnecting → live", () => {
		const { pipeline, renderer, links } = pipelineOverSocket()
		const first = latest()
		first.open()
		first.receive(ack())
		first.receive(frameAt(1))
		first.receive(frameAt(2))
		first.drop()
		expect(links().at(-1)).toBe("reconnecting")
		vi.advanceTimersByTime(500)
		const second = latest()
		second.open()
		expect(second.subscribes).toBe(1)
		// the core's reconnect ack, its backfill replaying a held row, then the new stream
		second.receive(ack({ backfillFrames: 1 }))
		second.receive(replayAt(2, "backfill"))
		// the resumed source opened a new epoch
		second.receive(frameAt(40, 2))
		second.receive(frameAt(41, 2))
		expect(renderer.rows).toHaveLength(4)
		expect(new Set(links())).toEqual(
			new Set(["connecting", "live", "reconnecting"]),
		)
		expect(links().at(-1)).toBe("live")
		pipeline.dispose()
	})

	it("resets a hold left by a stale ack before a drop, so the new stream's backfill is drawn once", () => {
		const { pipeline, renderer } = pipelineOverSocket()
		const first = latest()
		first.open()
		first.receive(ack())
		for (const s of [1, 2, 3]) first.receive(frameAt(s, 1, [s]))
		// a resubscribe's ack holds rows up to 12:00:03, then the socket drops before its replay
		first.receive(ack({ backfillFrames: 3 }))
		first.drop()
		vi.advanceTimersByTime(500)
		const second = latest()
		second.open()
		// the core produced 4 and 5 meanwhile: backfill 2..5, snapshot 5, then live 6
		second.receive(ack({ backfillFrames: 4 }))
		for (const s of [2, 3, 4, 5]) second.receive(replayAt(s, "backfill", [s]))
		second.receive(replayAt(5, "snapshot", [5]))
		second.receive(frameAt(6, 1, [6]))
		// every row once, in order: none swallowed, none drawn twice
		expect(renderer.rows.map(r => r.first)).toEqual([1, 2, 3, 4, 5, 6])
		pipeline.dispose()
	})

	it("passes the receiver's pause to the socket: slow resubscribes while paused, one at once on resume", () => {
		const { pipeline } = pipelineOverSocket()
		pipeline.handle({ type: "sourcePaused", paused: true })
		const ws = latest()
		ws.core = pausedCoreAnswer
		ws.open()
		ws.receive(frameAt(1))
		vi.advanceTimersByTime(5 * 60_000)
		const gaps = ws.subscribeTimes
			.slice(1)
			.map((at, i) => at - ws.subscribeTimes[i]!)
		expect(Math.min(...gaps)).toBeGreaterThanOrEqual(PAUSED_WATCH_MS)
		const before = ws.subscribes
		pipeline.handle({ type: "sourcePaused", paused: false })
		expect(ws.subscribes).toBe(before + 1)
		pipeline.dispose()
	})

	it("passes a kick to the socket", () => {
		const { pipeline } = pipelineOverSocket()
		const ws = latest()
		ws.open()
		vi.advanceTimersByTime(stallTimeoutMs(25) - 1000)
		// no live frame yet: the kick resubscribes at once
		pipeline.handle({ type: "kick" })
		expect(ws.subscribes).toBe(2)
		pipeline.dispose()
	})
})
