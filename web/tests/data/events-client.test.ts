import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventsClient, backoffDelay } from "../../src/data/events-client.ts"
import { fakeSockets } from "./fake-socket.ts"

describe("EventsClient", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("sends subscriptions made before the socket opens once it opens", () => {
		const { factory, last } = fakeSockets()
		const client = new EventsClient({
			url: "ws://test/ws",
			createSocket: factory,
		})
		client.subscribe(["tuner", "spectrum"], {
			spectrum: { sourceId: "rtl-0", hz: 20, bins: 512 },
		})
		client.connect()
		expect(client.state).toBe("connecting")
		expect(last().url).toBe("ws://test/ws")
		last().open()
		expect(client.state).toBe("open")
		expect(last().sent).toEqual([
			{
				type: "subscribe",
				channels: ["tuner", "spectrum"],
				options: { spectrum: { sourceId: "rtl-0", hz: 20, bins: 512 } },
			},
		])
	})

	it("dispatches typed messages to their handlers and stops after unsubscribe", () => {
		const { factory, last } = fakeSockets()
		const client = new EventsClient({ createSocket: factory, url: "ws://x/ws" })
		client.connect()
		last().open()
		const seen: number[] = []
		const off = client.on("tuner:state-changed", data =>
			seen.push(data.state.frequency),
		)
		const any = vi.fn()
		client.onAny(any)
		last().receive({
			type: "tuner:state-changed",
			channel: "tuner",
			data: { sourceId: "rtl-0", state: { frequency: 161_500_000 } },
		})
		last().receive({
			type: "live-audio:level",
			channel: "live-audio",
			data: {},
		})
		off()
		last().receive({
			type: "tuner:state-changed",
			channel: "tuner",
			data: { sourceId: "rtl-0", state: { frequency: 1 } },
		})
		expect(seen).toEqual([161_500_000])
		expect(any).toHaveBeenCalledTimes(3)
		expect(any.mock.calls[0]?.[0]).toMatchObject({
			type: "tuner:state-changed",
			channel: "tuner",
		})
	})

	it("ignores malformed frames", () => {
		const { factory, last } = fakeSockets()
		const client = new EventsClient({ createSocket: factory, url: "ws://x/ws" })
		const any = vi.fn()
		client.onAny(any)
		client.connect()
		last().open()
		last().onmessage?.({ data: "not json" })
		last().onmessage?.({ data: JSON.stringify({ nope: 1 }) })
		expect(any).not.toHaveBeenCalled()
	})

	it("reference-counts channel subscriptions", () => {
		const { factory, last } = fakeSockets()
		const client = new EventsClient({ createSocket: factory, url: "ws://x/ws" })
		client.connect()
		last().open()
		const a = client.subscribe(["tuner"])
		const b = client.subscribe(["tuner", "sources"])
		a()
		a()
		expect(last().sent.at(-1)).toEqual({
			type: "subscribe",
			channels: ["tuner", "sources"],
		})
		b()
		expect(last().sent.at(-1)).toEqual({
			type: "unsubscribe",
			channels: ["tuner", "sources"],
		})
		expect(client.channels).toEqual([])
	})

	it("reconnects with exponential backoff capped at 10 s, resubscribes and signals reconnected", () => {
		const { sockets, factory, last } = fakeSockets()
		const client = new EventsClient({
			createSocket: factory,
			url: "ws://x/ws",
			random: () => 0.5,
		})
		client.subscribe(["spectrum"], {
			spectrum: { sourceId: "rtl-0", bins: 1024 },
		})
		client.subscribeActivity("feed1", { categories: ["paging"] })
		const reconnected = vi.fn()
		client.onReconnected(reconnected)
		const states: string[] = []
		client.onState(s => states.push(s))
		client.connect()
		last().open()
		expect(reconnected).not.toHaveBeenCalled()
		last().receive({
			type: "activity:records",
			channel: "activity",
			data: { id: "feed1", items: [], scannedThrough: "12", cursor: "c-12" },
		})

		// Fail repeatedly: delays 500, 1000, 2000, 4000, 8000, 10000, 10000 (jitter centred).
		const delays = [500, 1000, 2000, 4000, 8000, 10_000, 10_000]
		last().drop()
		for (const delay of delays) {
			const before = sockets.length
			vi.advanceTimersByTime(delay - 1)
			expect(sockets.length).toBe(before)
			vi.advanceTimersByTime(1)
			expect(sockets.length).toBe(before + 1)
			last().drop()
		}
		vi.advanceTimersByTime(10_000)
		const socket = last()
		socket.open()
		expect(socket.sent).toEqual([
			{
				type: "subscribe",
				channels: ["spectrum"],
				options: { spectrum: { sourceId: "rtl-0", bins: 1024 } },
			},
			{
				type: "activity:subscribe",
				id: "feed1",
				query: { categories: ["paging"] },
				cursor: "c-12",
			},
		])
		expect(reconnected).toHaveBeenCalledTimes(1)
		expect(states[0]).toBe("connecting")
		expect(states.at(-1)).toBe("open")

		// A successful open resets the backoff.
		socket.drop()
		const before = sockets.length
		vi.advanceTimersByTime(500)
		expect(sockets.length).toBe(before + 1)
	})

	it("stops reconnecting after disconnect()", () => {
		const { sockets, factory, last } = fakeSockets()
		const client = new EventsClient({ createSocket: factory, url: "ws://x/ws" })
		client.connect()
		last().open()
		client.disconnect()
		expect(client.state).toBe("closed")
		vi.advanceTimersByTime(60_000)
		expect(sockets.length).toBe(1)
	})

	it("updates spectrum options on a live subscription", () => {
		const { factory, last } = fakeSockets()
		const client = new EventsClient({ createSocket: factory, url: "ws://x/ws" })
		client.connect()
		last().open()
		client.subscribe(["spectrum"])
		client.setSpectrumOptions({ sourceId: "rtl-0", hz: 25 })
		expect(last().sent.at(-1)).toEqual({
			type: "subscribe",
			channels: ["spectrum"],
			options: { spectrum: { sourceId: "rtl-0", hz: 25 } },
		})
	})

	it("unsubscribes activity feeds", () => {
		const { factory, last } = fakeSockets()
		const client = new EventsClient({ createSocket: factory, url: "ws://x/ws" })
		client.connect()
		last().open()
		const off = client.subscribeActivity("a1", {}, "c-1")
		expect(last().sent.at(-1)).toEqual({
			type: "activity:subscribe",
			id: "a1",
			query: {},
			cursor: "c-1",
		})
		off()
		expect(last().sent.at(-1)).toEqual({
			type: "activity:unsubscribe",
			id: "a1",
		})
	})
})

describe("backoffDelay", () => {
	it("doubles from the base, caps, and jitters by at most 10 %", () => {
		expect(backoffDelay(0, 500, 10_000, () => 0.5)).toBe(500)
		expect(backoffDelay(3, 500, 10_000, () => 0.5)).toBe(4000)
		expect(backoffDelay(50, 500, 10_000, () => 1)).toBe(10_000)
		expect(backoffDelay(1, 500, 10_000, () => 0)).toBe(900)
	})
})
