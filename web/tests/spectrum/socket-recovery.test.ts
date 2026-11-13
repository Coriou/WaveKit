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
	SpectrumSocket,
	closeIsFinal,
	stallTimeoutMs,
} from "../../src/spectrum/socket.ts"
import { FakeFrames, FakeRenderer, FakeTimers } from "./fakes.ts"
import { frameJson } from "./frames.ts"

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
	send(text: string): void {
		this.sent.push(text)
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
}

const SUB = { sourceId: "rtl", hz: 25, bins: 2048 }

function ack(): string {
	return JSON.stringify({
		type: "spectrum:profile",
		channel: "spectrum",
		data: {
			selection: "source",
			sourceId: "rtl",
			outcome: "exact",
			adjusted: [],
			profile: { key: "25:2048" },
		},
	})
}

function frameAt(second: number, epoch = 1): string {
	return frameJson({
		at: `2026-10-16T12:00:${String(second).padStart(2, "0")}.000Z`,
		epoch,
	})
}

function latest(): FakeWebSocket {
	const ws = FakeWebSocket.all.at(-1)
	if (!ws) throw new Error("no socket")
	return ws
}

function openSocket() {
	const states: SpectrumLinkState[] = []
	const messages: string[] = []
	const frames: string[] = []
	let failure: string | undefined
	const socket = new SpectrumSocket("ws://core/ws", {
		message: m => {
			messages.push(m.type)
			if (m.type === "spectrum:frame") frames.push(m.data.at)
		},
		state: (s, message) => {
			states.push(s)
			if (message !== undefined) failure = message
		},
	})
	socket.setSubscription(SUB)
	return { socket, states, messages, frames, failure: () => failure }
}

beforeEach(() => {
	FakeWebSocket.all = []
	vi.useFakeTimers()
	vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"))
	// backoffDelay's jitter at its midpoint: attempt n waits exactly 500 · 2^n ms (≤ 10 s)
	vi.spyOn(Math, "random").mockReturnValue(0.5)
	vi.stubGlobal("WebSocket", FakeWebSocket)
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
		// open is not live: still reconnecting until a frame arrives
		third.receive(ack())
		expect(t.states.at(-1)).toBe("reconnecting")
		third.receive(frameAt(5))
		expect(t.states.at(-1)).toBe("live")
		expect(t.frames).toEqual([
			"2026-10-16T12:00:01.000Z",
			"2026-10-16T12:00:05.000Z",
		])
		// a successful connection resets the backoff
		third.drop()
		vi.advanceTimersByTime(500)
		expect(FakeWebSocket.all).toHaveLength(4)
		t.socket.dispose()
	})

	it("resubscribes a stream that went silent (source paused) and goes live when the core resumes", () => {
		const t = openSocket()
		const ws = latest()
		ws.open()
		ws.receive(ack())
		ws.receive(frameAt(1))
		const timeout = stallTimeoutMs(SUB.hz)

		// the source is paused: no frames; the socket itself stays open
		vi.advanceTimersByTime(timeout - 1)
		expect(t.states.at(-1)).toBe("live")
		expect(ws.subscribes).toBe(1)
		vi.advanceTimersByTime(1)
		expect(t.states.at(-1)).toBe("reconnecting")
		expect(ws.subscribes).toBe(2)

		// while paused the core still acks each resubscribe (the socket is alive): spaced by the backoff
		ws.receive(ack())
		vi.advanceTimersByTime(timeout)
		expect(ws.subscribes).toBe(3)
		ws.receive(ack())
		vi.advanceTimersByTime(timeout)
		expect(ws.subscribes).toBe(4)
		expect(FakeWebSocket.all).toHaveLength(1)

		// the core resumes the source: frames flow again on the same socket, no reload
		ws.receive(ack())
		ws.receive(frameAt(30))
		expect(t.states.at(-1)).toBe("live")
		expect(t.frames.at(-1)).toBe("2026-10-16T12:00:30.000Z")
		// steady frames keep it live without more resubscribes
		for (let i = 0; i < 20; i++) {
			vi.advanceTimersByTime(1000)
			ws.receive(frameAt(31 + i))
		}
		expect(ws.subscribes).toBe(4)
		expect(t.states.filter(s => s === "live")).toHaveLength(2)
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

	it("stops and reports an error on a do-not-retry close", () => {
		const t = openSocket()
		const ws = latest()
		ws.open()
		ws.receive(frameAt(1))
		ws.drop(1008, "Access expired")
		expect(t.states.at(-1)).toBe("failed")
		expect(t.failure()).toContain("Access expired")
		// no retry, ever
		vi.advanceTimersByTime(10 * 60_000)
		expect(FakeWebSocket.all).toHaveLength(1)
		expect(t.states.at(-1)).toBe("failed")
		t.socket.dispose()
	})

	it("classifies close codes", () => {
		expect(closeIsFinal(1008)).toBe(true)
		expect(closeIsFinal(4401)).toBe(true)
		expect(closeIsFinal(4403)).toBe(true)
		// a core restart, an abnormal drop, a server error: retried
		expect(closeIsFinal(1000)).toBe(false)
		expect(closeIsFinal(1001)).toBe(false)
		expect(closeIsFinal(1006)).toBe(false)
		expect(closeIsFinal(1011)).toBe(false)
		expect(closeIsFinal(4500)).toBe(false)
		expect(stallTimeoutMs(25)).toBe(5000)
		expect(stallTimeoutMs(0.5)).toBe(8000)
		expect(stallTimeoutMs(undefined)).toBe(5000)
	})
})

describe("SpectrumPipeline over a reconnecting socket", () => {
	it("accepts the new stream's frames after a drop and posts reconnecting → live", () => {
		const posted: WorkerToMain[] = []
		const renderer = new FakeRenderer()
		const pipeline = new SpectrumPipeline({
			post: msg => posted.push(msg),
			openSocket: (url, handlers) => new SpectrumSocket(url, handlers),
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
		const first = latest()
		first.open()
		first.receive(ack())
		first.receive(frameAt(1))
		first.receive(frameAt(2))
		// a second ack on the same axis holds rows up to 12:00:02 (the replayed backfill)
		first.receive(ack())
		first.drop()
		expect(links().at(-1)).toBe("reconnecting")
		vi.advanceTimersByTime(500)
		const second = latest()
		second.open()
		expect(second.subscribes).toBe(1)
		// the core's reconnect ack, its backfill replaying a held row, then the new stream
		second.receive(ack())
		second.receive(frameAt(2))
		// the resumed source opened a new epoch
		second.receive(frameAt(40, 2))
		second.receive(frameAt(41, 2))
		expect(renderer.rows).toHaveLength(4)
		expect(links()).toEqual(["connecting", "live", "reconnecting", "live"])
		pipeline.dispose()
	})
})
