import { createServer, type AddressInfo, type Socket } from "node:net"
import { describe, expect, it } from "vitest"
import { WebSocketServer, type WebSocket } from "ws"
import {
	CHANNELS,
	backoffDelay,
	createNodeWsFactory,
	createWsClient,
	nodeWsFactory,
	type WsHandlers,
} from "../../../cli/source/data/ws-client.js"
import type { Inbound } from "../../../cli/source/data/types.js"

function harness() {
	const emitted: Inbound[] = []
	const sockets: Array<{
		url: string
		h: WsHandlers
		sent: string[]
		closed: boolean
	}> = []
	const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
	let clock = 1000
	const client = createWsClient({
		url: () => "ws://127.0.0.1:9000/ws",
		factory: (url, h) => {
			const s = { url, h, sent: [] as string[], closed: false }
			sockets.push(s)
			return {
				send: t => s.sent.push(t),
				close: () => {
					s.closed = true
				},
			}
		},
		emit: i => emitted.push(i),
		now: () => clock,
		random: () => 0.5,
		setTimeout: (fn, ms) => {
			const t = { fn, ms, cleared: false }
			timers.push(t)
			return t
		},
		clearTimeout: h => {
			;(h as { cleared: boolean }).cleared = true
		},
	})
	const fire = () => {
		const t = timers.filter(x => !x.cleared).shift()
		if (!t) throw new Error("no timer")
		t.cleared = true
		clock += t.ms
		t.fn()
	}
	return { client, emitted, sockets, timers, fire }
}

describe("backoffDelay", () => {
	it("follows 1, 2, 4, 8, 15 s with ±20 % jitter", () => {
		expect([0, 1, 2, 3, 4, 9].map(a => backoffDelay(a, () => 0.5))).toEqual([
			1000, 2000, 4000, 8000, 15000, 15000,
		])
		expect(backoffDelay(0, () => 0)).toBe(800)
		expect(backoffDelay(4, () => 1)).toBe(18000)
	})
})

describe("ws client", () => {
	it("subscribes on open and emits ws:open on the ack", () => {
		const { client, sockets, emitted } = harness()
		client.start()
		const s = sockets[0]!
		s.h.open()
		expect(JSON.parse(s.sent[0]!)).toEqual({
			type: "subscribe",
			channels: [...CHANNELS],
		})
		s.h.message(
			JSON.stringify({ type: "subscribed", data: { channels: [...CHANNELS] } }),
		)
		expect(emitted.map(e => e.kind)).toEqual(["ws:connecting", "ws:open"])
	})
	it("drops bad frames into ws:invalid and forwards good ones", () => {
		const { client, sockets, emitted } = harness()
		client.start()
		const s = sockets[0]!
		s.h.message("{nope")
		s.h.message(JSON.stringify({ type: "who-knows", data: {} }))
		s.h.message(
			JSON.stringify({
				type: "decoder:started",
				channel: "decoders",
				data: { decoderId: "readsb" },
			}),
		)
		expect(emitted.slice(1).map(e => e.kind)).toEqual([
			"ws:invalid",
			"ws:invalid",
			"ws",
		])
	})
	it("backs off after close and resets after a successful subscribe", () => {
		const { client, sockets, emitted, fire } = harness()
		client.start()
		sockets[0]!.h.error("connect ECONNREFUSED 127.0.0.1:9000")
		sockets[0]!.h.close(1006, "")
		const close = emitted.find(e => e.kind === "ws:close")
		expect(close).toMatchObject({
			code: 1006,
			reason: "connect ECONNREFUSED 127.0.0.1:9000",
			nextRetryAt: 2000,
		})
		fire()
		expect(sockets).toHaveLength(2)
		sockets[1]!.h.close(1006, "")
		expect(emitted.filter(e => e.kind === "ws:close").at(-1)).toMatchObject({
			nextRetryAt: 2000 + 2000,
		})
		fire()
		sockets[2]!.h.message(
			JSON.stringify({ type: "subscribed", data: { channels: [] } }),
		)
		sockets[2]!.h.close(1000, "Server shutting down")
		const last = emitted.filter(e => e.kind === "ws:close").at(-1)
		expect(last && "nextRetryAt" in last ? last.nextRetryAt : null).toBe(
			4000 + 1000,
		)
	})
	it("reconnectNow ignores the old socket's events and connects immediately", () => {
		const { client, sockets, emitted } = harness()
		client.start()
		client.reconnectNow()
		expect(sockets).toHaveLength(2)
		expect(sockets[0]!.closed).toBe(true)
		const before = emitted.length
		sockets[0]!.h.close(1006, "")
		expect(emitted.length).toBe(before)
	})
})

describe("nodeWsFactory (in-test server on 127.0.0.1, never the live core)", () => {
	it("passes frames both ways and reports the close code and reason", async () => {
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 })
		await new Promise<void>(resolve => wss.once("listening", () => resolve()))
		const { port } = wss.address() as AddressInfo
		wss.on("connection", sock => {
			sock.on("message", data => {
				sock.send(JSON.stringify({ echo: JSON.parse(String(data)) }))
				sock.close(4000, "bye")
			})
		})
		const got: string[] = []
		const closed = new Promise<[number, string]>(resolve => {
			const h = nodeWsFactory(`ws://127.0.0.1:${port}/ws`, {
				open: () => h.send(JSON.stringify({ type: "subscribe" })),
				message: text => got.push(text),
				close: (code, reason) => resolve([code, reason]),
				error: () => {},
			})
		})
		expect(await closed).toEqual([4000, "bye"])
		expect(got).toEqual(['{"echo":{"type":"subscribe"}}'])
		await new Promise<void>(resolve => wss.close(() => resolve()))
	})
	it("can be closed while still connecting without an unhandled error", async () => {
		const errors: string[] = []
		const closed = new Promise<number>(resolve => {
			const h = nodeWsFactory("ws://127.0.0.1:9/ws", {
				open: () => {},
				message: () => {},
				close: code => resolve(code),
				error: m => errors.push(m),
			})
			h.close()
		})
		expect(typeof (await closed)).toBe("number")
	})
})

describe("A2 fix round 1", () => {
	it("I3: a factory that throws schedules a retry instead of escaping", () => {
		const emitted: Inbound[] = []
		const timers: Array<() => void> = []
		let calls = 0
		const client = createWsClient({
			url: () => "ws://127.0.0.1:9000/ws",
			factory: () => {
				calls++
				throw new SyntaxError("The URL contains a fragment identifier")
			},
			emit: i => emitted.push(i),
			now: () => 1000,
			random: () => 0.5,
			setTimeout: fn => {
				timers.push(fn)
				return fn
			},
			clearTimeout: () => {},
		})
		expect(() => client.start()).not.toThrow()
		expect(emitted.map(e => e.kind)).toEqual(["ws:connecting", "ws:close"])
		expect(emitted[1]).toMatchObject({
			code: 0,
			reason: "The URL contains a fragment identifier",
			nextRetryAt: 2000,
		})
		expect(() => timers.shift()?.()).not.toThrow()
		expect(calls).toBe(2)
		client.stop()
	})
	it("I3: nodeWsFactory throws synchronously on a fragment URL; the client survives it", () => {
		expect(() =>
			nodeWsFactory("ws://127.0.0.1:9/ws#x", {
				open: () => {},
				message: () => {},
				close: () => {},
				error: () => {},
			}),
		).toThrow()
		const emitted: Inbound[] = []
		const client = createWsClient({
			url: () => "ws://127.0.0.1:9/ws#x",
			factory: nodeWsFactory,
			emit: i => emitted.push(i),
			now: () => 0,
			random: () => 0.5,
			setTimeout: fn => fn,
			clearTimeout: () => {},
		})
		expect(() => client.start()).not.toThrow()
		expect(emitted.at(-1)?.kind).toBe("ws:close")
		client.stop()
	})
	it("M1: reconnectNow on an open socket records a close before reconnecting", () => {
		const { client, sockets, emitted } = harness()
		client.start()
		sockets[0]!.h.open()
		sockets[0]!.h.message(
			JSON.stringify({ type: "subscribed", data: { channels: [] } }),
		)
		client.reconnectNow()
		expect(emitted.map(e => e.kind)).toEqual([
			"ws:connecting",
			"ws:open",
			"ws:close",
			"ws:connecting",
		])
		expect(emitted[2]).toMatchObject({
			code: 1000,
			reason: "reconnect requested",
			nextRetryAt: 1000,
		})
		// The synthetic close is emitted once; a later close of the old socket is ignored.
		sockets[0]!.h.close(1006, "")
		expect(emitted).toHaveLength(4)
	})
	it("M1: no synthetic close when the socket was never open", () => {
		const { client, emitted } = harness()
		client.start()
		client.reconnectNow()
		expect(emitted.map(e => e.kind)).toEqual(["ws:connecting", "ws:connecting"])
	})
	it("I2: a server that never answers the handshake closes the socket", async () => {
		const held: Socket[] = []
		const server = createServer(sock => held.push(sock))
		await new Promise<void>(resolve =>
			server.listen(0, "127.0.0.1", () => resolve()),
		)
		const { port } = server.address() as AddressInfo
		const started = Date.now()
		const code = await new Promise<number>(resolve => {
			nodeWsFactory(`ws://127.0.0.1:${port}/ws`, {
				open: () => {},
				message: () => {},
				close: c => resolve(c),
				error: () => {},
			})
		})
		expect(code).toBe(1006)
		expect(Date.now() - started).toBeLessThan(10000)
		for (const s of held) s.destroy()
		await new Promise<void>(resolve => server.close(() => resolve()))
	}, 20000)
	it("M5: a frame over 8 MiB is refused and the socket closes", async () => {
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 })
		await new Promise<void>(resolve => wss.once("listening", () => resolve()))
		const { port } = wss.address() as AddressInfo
		const peerClose = new Promise<number>(resolve =>
			wss.on("connection", sock => {
				sock.on("close", code => resolve(code))
				sock.send(Buffer.alloc(8 * 1024 * 1024 + 1, 0x61))
			}),
		)
		const got: string[] = []
		const errors: string[] = []
		await new Promise<void>(resolve => {
			nodeWsFactory(`ws://127.0.0.1:${port}/ws`, {
				open: () => {},
				message: t => got.push(t),
				close: () => resolve(),
				error: m => errors.push(m),
			})
		})
		expect(got).toEqual([])
		expect(errors.join(" ")).toMatch(/max payload size exceeded/i)
		// ws tells the peer 1009 (message too big); locally the close reads 1006.
		expect(await peerClose).toBe(1009)
		await new Promise<void>(resolve => wss.close(() => resolve()))
	}, 20000)
})

describe("liveness watchdog (A2 review M4, optional in A4)", () => {
	const quick = createNodeWsFactory({ silenceMs: 300, checkMs: 50 })
	async function server(onConn: (sock: WebSocket) => void) {
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 })
		await new Promise<void>(resolve => wss.once("listening", () => resolve()))
		wss.on("connection", onConn)
		const { port } = wss.address() as AddressInfo
		return { wss, url: `ws://127.0.0.1:${port}/ws` }
	}
	it("terminates a socket whose server pinged once and then went silent", async () => {
		const { wss, url } = await server(sock => sock.ping())
		const errors: string[] = []
		const started = Date.now()
		const code = await new Promise<number>(resolve => {
			quick(url, {
				open: () => {},
				message: () => {},
				close: c => resolve(c),
				error: m => errors.push(m),
			})
		})
		expect(code).toBe(1006)
		expect(errors.join(" ")).toMatch(/no heartbeat from server/)
		expect(Date.now() - started).toBeLessThan(5000)
		await new Promise<void>(resolve => wss.close(() => resolve()))
	}, 20000)
	it("never fires for a server that does not ping (older core)", async () => {
		const { wss, url } = await server(() => {})
		let closed = false
		const h = quick(url, {
			open: () => {},
			message: () => {},
			close: () => {
				closed = true
			},
			error: () => {},
		})
		await new Promise(r => setTimeout(r, 700))
		expect(closed).toBe(false)
		h.close()
		await new Promise<void>(resolve => wss.close(() => resolve()))
	}, 20000)
	it("keeps a socket alive while pings keep coming", async () => {
		let timer: NodeJS.Timeout | undefined
		const { wss, url } = await server(sock => {
			timer = setInterval(() => sock.ping(), 100)
		})
		let closed = false
		const h = quick(url, {
			open: () => {},
			message: () => {},
			close: () => {
				closed = true
			},
			error: () => {},
		})
		await new Promise(r => setTimeout(r, 800))
		expect(closed).toBe(false)
		clearInterval(timer)
		h.close()
		await new Promise<void>(resolve => wss.close(() => resolve()))
	}, 20000)
})
