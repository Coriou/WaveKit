import { describe, expect, it } from "vitest"

import {
	EventsRelay,
	FleetThrottle,
	OUT_MS,
	UPDATE_EVERY_MS,
	WorkerSocket,
	fleetKeyOf,
} from "../../src/data/events-relay.ts"
import type {
	EventsWorkerToMain,
	MainToEventsWorker,
} from "../../src/data/events-relay.ts"
import { FakeSocket } from "./fake-socket.ts"

const msg = (type: string, data: unknown) => JSON.stringify({ type, data })
const plane = (icao: string, n: number) =>
	msg("aircraft:update", { icao, messages: n })

describe("fleetKeyOf", () => {
	it("keys the four fleets' messages by their entity field", () => {
		expect(fleetKeyOf(plane("ABC", 1))).toEqual({
			id: "aircraft|ABC",
			update: true,
		})
		expect(fleetKeyOf(msg("vessel:new", { mmsi: "1" }))).toEqual({
			id: "vessel|1",
			update: false,
		})
		expect(fleetKeyOf(msg("aprs:lost", { key: "F4X" }))?.id).toBe("aprs|F4X")
		expect(fleetKeyOf(msg("mesh:update", { nodeId: "!a" }))?.id).toBe("mesh|!a")
	})

	it("leaves everything else alone", () => {
		expect(fleetKeyOf(msg("aircraft:stats", { total: 3 }))).toBeNull()
		expect(fleetKeyOf(msg("tuner:state-changed", { icao: "X" }))).toBeNull()
		expect(fleetKeyOf(msg("aircraft:update", { icao: 7 }))).toBeNull()
		expect(fleetKeyOf("not json")).toBeNull()
		expect(fleetKeyOf("[1]")).toBeNull()
	})
})

const typeOf = (t: string) => (JSON.parse(t) as { type: string }).type
const dataOf = (t: string) => (JSON.parse(t) as { data: unknown }).data

describe("FleetThrottle", () => {
	it("passes the first update, then the newest once a window", () => {
		const sent: string[] = []
		const t = new FleetThrottle(x => sent.push(x), 1000)
		t.push(plane("A", 1), 0)
		t.push(plane("B", 1), 10)
		t.push(plane("A", 2), 200)
		t.push(plane("A", 3), 400)
		t.push(msg("tuner:state-changed", {}), 500)
		expect(sent.map(dataOf)).toEqual([
			{ icao: "A", messages: 1 },
			{ icao: "B", messages: 1 },
			{},
		])
		expect(t.waiting).toBe(1)
		t.sweep(900)
		expect(sent).toHaveLength(3)
		t.sweep(1000)
		expect(sent.slice(3).map(dataOf)).toEqual([{ icao: "A", messages: 3 }])
		expect(t.dropped).toBe(1)
		expect(t.waiting).toBe(0)
		// the trailing send starts a new window
		t.push(plane("A", 4), 1500)
		expect(sent).toHaveLength(4)
		t.push(plane("A", 5), 2000)
		expect(sent.slice(4).map(dataOf)).toEqual([{ icao: "A", messages: 5 }])
	})

	it("sends the waiting update before a new or lost of the same entity", () => {
		const sent: string[] = []
		const t = new FleetThrottle(x => sent.push(x), 1000)
		t.push(plane("A", 1), 0)
		t.push(plane("A", 2), 100)
		t.push(msg("aircraft:lost", { icao: "A" }), 200)
		t.push(msg("aircraft:new", { icao: "A" }), 300)
		t.push(plane("A", 3), 400)
		expect(sent.map(typeOf)).toEqual([
			"aircraft:update",
			"aircraft:update",
			"aircraft:lost",
			"aircraft:new",
			"aircraft:update",
		])
		expect(t.waiting).toBe(0)
	})

	it("drains everything waiting", () => {
		const sent: string[] = []
		const t = new FleetThrottle(x => sent.push(x), 1000)
		t.push(plane("A", 1), 0)
		t.push(plane("A", 2), 1)
		t.drain()
		expect(sent.map(dataOf)).toEqual([
			{ icao: "A", messages: 1 },
			{ icao: "A", messages: 2 },
		])
	})
})

function relayHarness() {
	const posted: EventsWorkerToMain[] = []
	let timers: { fn: () => void; ms: number }[] = []
	let clock = 0
	let socket: FakeSocket | null = null
	const relay = new EventsRelay({
		post: m => posted.push(m),
		openSocket: url => (socket = new FakeSocket(url)),
		now: () => clock,
		setTimer: (fn, ms) => {
			const t = { fn, ms }
			timers.push(t)
			return t
		},
		clearTimer: t => {
			timers = timers.filter(x => x !== t)
		},
	})
	relay.handle({ op: "open", url: "ws://core/ws" })
	const ws = () => {
		if (!socket) throw new Error("no socket")
		return socket
	}
	/** Fires the timers due within `ms` (in order of their delay). */
	const advance = (ms: number) => {
		clock += ms
		const due = timers.filter(t => t.ms <= ms).sort((a, b) => a.ms - b.ms)
		timers = timers.filter(t => t.ms > ms)
		for (const t of due) t.fn()
	}
	return { relay, posted, ws, advance, timers: () => timers }
}

describe("EventsRelay", () => {
	it("batches messages and rate limits fleet updates", () => {
		const { posted, ws, advance } = relayHarness()
		ws().open()
		ws().receive({ type: "aircraft:update", data: { icao: "A", messages: 1 } })
		ws().receive({ type: "aircraft:update", data: { icao: "A", messages: 2 } })
		ws().receive({ type: "live-audio:level", data: { db: -3 } })
		expect(posted).toEqual([{ ev: "open" }])
		advance(OUT_MS)
		expect(posted[1]).toEqual({
			ev: "messages",
			texts: [plane("A", 1), msg("live-audio:level", { db: -3 })],
		})
		advance(UPDATE_EVERY_MS / 4)
		advance(UPDATE_EVERY_MS / 4)
		advance(UPDATE_EVERY_MS / 4)
		expect(posted).toHaveLength(2)
		advance(UPDATE_EVERY_MS / 4)
		advance(OUT_MS)
		expect(posted[2]).toEqual({ ev: "messages", texts: [plane("A", 2)] })
	})

	it("sends, and on close flushes what waits before reporting it", () => {
		const { relay, posted, ws, timers } = relayHarness()
		ws().open()
		relay.handle({ op: "send", data: JSON.stringify({ type: "subscribe" }) })
		expect(ws().sent).toEqual([{ type: "subscribe" }])
		ws().receive({ type: "aircraft:update", data: { icao: "A", messages: 1 } })
		ws().receive({ type: "aircraft:update", data: { icao: "A", messages: 2 } })
		ws().drop()
		expect(posted.slice(1)).toEqual([
			{ ev: "error" },
			{ ev: "messages", texts: [plane("A", 1), plane("A", 2)] },
			{ ev: "close" },
		])
		expect(timers()).toHaveLength(0)
	})
})

class FakeWorker {
	readonly sent: MainToEventsWorker[] = []
	onmessage: ((event: { data: EventsWorkerToMain }) => void) | null = null
	onerror: ((event: unknown) => void) | null = null
	terminated = false
	postMessage(m: MainToEventsWorker): void {
		this.sent.push(m)
	}
	terminate(): void {
		this.terminated = true
	}
	emit(data: EventsWorkerToMain): void {
		this.onmessage?.({ data })
	}
}

describe("WorkerSocket", () => {
	it("is a SocketLike over the worker", () => {
		const worker = new FakeWorker()
		const socket = new WorkerSocket("ws://core/ws", worker)
		const seen: unknown[] = []
		let opened = 0
		let closed = 0
		socket.onopen = () => (opened += 1)
		socket.onclose = () => (closed += 1)
		socket.onmessage = e => seen.push(e.data)
		expect(worker.sent).toEqual([{ op: "open", url: "ws://core/ws" }])
		expect(() => socket.send("x")).toThrow()
		worker.emit({ ev: "open" })
		expect(socket.readyState).toBe(1)
		expect(opened).toBe(1)
		socket.send("hello")
		worker.emit({ ev: "messages", texts: ["a", "b"] })
		expect(seen).toEqual(["a", "b"])
		socket.close(1000, "bye")
		expect(socket.readyState).toBe(2)
		expect(worker.sent.slice(1)).toEqual([
			{ op: "send", data: "hello" },
			{ op: "close", code: 1000, reason: "bye" },
		])
		worker.emit({ ev: "close" })
		expect(socket.readyState).toBe(3)
		expect(closed).toBe(1)
		expect(worker.terminated).toBe(true)
	})

	it("closes when the worker fails", () => {
		const worker = new FakeWorker()
		const socket = new WorkerSocket("ws://core/ws", worker)
		let closed = 0
		socket.onclose = () => (closed += 1)
		worker.onerror?.({})
		expect(socket.readyState).toBe(3)
		expect(closed).toBe(1)
	})
})
