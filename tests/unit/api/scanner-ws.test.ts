import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import type { WebSocket } from "ws"
import {
	WebSocketEventBroadcaster,
	type WebSocketChannel,
} from "../../../src/api/websocket/events.js"
import { wireScannerBroadcasts } from "../../../src/api/websocket/scanner-broadcast.js"
import { wireSpectrumBroadcasts } from "../../../src/api/websocket/spectrum-broadcast.js"
import { createLogger } from "../../../src/utils/logger.js"
import { testSettings } from "../../mocks/scanner/engine-fakes.js"

function client(
	broadcaster: WebSocketEventBroadcaster,
	id: string,
	channels: WebSocketChannel[],
	readyState = 1,
) {
	const messages: { type: string; channel: string; data: unknown }[] = []
	const socket = {
		readyState,
		send: (d: string) => messages.push(JSON.parse(d) as never),
		close: vi.fn(),
		on: vi.fn(),
	}
	;(broadcaster as unknown as { clients: Map<string, unknown> }).clients.set(
		id,
		{
			socket: socket as unknown as WebSocket,
			subscriptions: new Set(channels),
			id,
		},
	)
	return messages
}

class FakeScanner extends EventEmitter {
	readonly current = testSettings()
	settings() {
		return this.current
	}
}

/** A socket through handleConnection, so messages, close and terminate take the real paths. */
function connect(broadcaster: WebSocketEventBroadcaster) {
	const socket = Object.assign(new EventEmitter(), {
		readyState: 1,
		bufferedAmount: 0,
		sent: [] as { type: string; channel?: string; data: unknown }[],
		send(d: string) {
			this.sent.push(JSON.parse(d) as never)
		},
		close: vi.fn(),
		ping: vi.fn(),
		terminate: vi.fn(),
	})
	;(
		broadcaster as unknown as { handleConnection(s: unknown): void }
	).handleConnection(socket)
	const ids = [
		...(
			broadcaster as unknown as { clients: Map<string, unknown> }
		).clients.keys(),
	]
	const send = (msg: unknown) => socket.emit("message", JSON.stringify(msg))
	return { socket, id: ids.at(-1)!, send }
}

class FakeSpectrum extends EventEmitter {
	readonly calls: [string, string, unknown?][] = []
	subscribe(clientId: string, options: unknown): Promise<void> {
		this.calls.push(["subscribe", clientId, options])
		return Promise.resolve()
	}
	unsubscribe(clientId: string): Promise<void> {
		this.calls.push(["unsubscribe", clientId])
		return Promise.resolve()
	}
	unsubscribes(clientId: string): number {
		return this.calls.filter(c => c[0] === "unsubscribe" && c[1] === clientId)
			.length
	}
}

describe("scanner WebSocket channels", () => {
	it("accepts subscriptions to scanner and spectrum", () => {
		const b = new WebSocketEventBroadcaster(createLogger({ level: "fatal" }))
		const socket = Object.assign(new EventEmitter(), {
			readyState: 1,
			sent: [] as string[],
			send(d: string) {
				this.sent.push(d)
			},
			close: vi.fn(),
			ping: vi.fn(),
		})
		;(b as unknown as { handleConnection(s: unknown): void }).handleConnection(
			socket,
		)
		socket.emit(
			"message",
			JSON.stringify({ type: "subscribe", channels: ["scanner", "spectrum"] }),
		)
		const reply = JSON.parse(socket.sent.at(-1)!) as {
			type: string
			data: { channels: string[] }
		}
		expect(reply.type).toBe("subscribed")
		expect(reply.data.channels.sort()).toEqual(["scanner", "spectrum"])
		b.closeAll()
	})

	// Feature: signal-discovery-scanner, Property 12: WS rate limits
	// Validates: spec § 12.2
	it("coalesces a burst of discovery updates to one per second and delivers the latest", async () => {
		vi.useFakeTimers()
		try {
			const b = new WebSocketEventBroadcaster(createLogger({ level: "fatal" }))
			const scannerMsgs = client(b, "c1", ["scanner"])
			const scanner = new FakeScanner()
			const wiring = wireScannerBroadcasts(scanner, b, {
				now: () => Date.now(),
			})
			for (let i = 0; i < 50; i++)
				scanner.emit("discovery", {
					change: "updated",
					discovery: { id: "d_1", observationCount: i },
				})
			const firstSecond = scannerMsgs.filter(
				m => m.type === "scanner:discovery",
			)
			expect(firstSecond).toHaveLength(1)
			await vi.advanceTimersByTimeAsync(1100)
			const all = scannerMsgs.filter(m => m.type === "scanner:discovery")
			expect(all).toHaveLength(2)
			expect(all.at(-1)!.data).toMatchObject({
				discovery: { observationCount: 49 },
			})
			wiring.dispose()
			b.closeAll()
		} finally {
			vi.useRealTimers()
		}
	})

	// WG1 req 8.1: progress per job at up to 2 Hz; other messages keep 1 s per key.
	it("delivers scanner:progress at up to 2 Hz per job and discovery at 1 Hz", async () => {
		vi.useFakeTimers()
		try {
			const b = new WebSocketEventBroadcaster(createLogger({ level: "fatal" }))
			const scannerMsgs = client(b, "c1", ["scanner"])
			const scanner = new FakeScanner()
			const wiring = wireScannerBroadcasts(scanner, b, {
				now: () => Date.now(),
			})
			for (let i = 0; i < 20; i++) {
				scanner.emit("progress", { jobId: "j1", hopIndex: i })
				scanner.emit("discovery", {
					change: "updated",
					discovery: { id: "d_1", observationCount: i },
				})
				await vi.advanceTimersByTimeAsync(100)
			}
			await vi.advanceTimersByTimeAsync(1_000)
			const progress = scannerMsgs.filter(m => m.type === "scanner:progress")
			const discovery = scannerMsgs.filter(m => m.type === "scanner:discovery")
			// 2 s of offers every 100 ms: 0, 500, 1000, 1500 ms and the trailing latest.
			expect(progress).toHaveLength(5)
			expect(progress.at(-1)!.data).toMatchObject({ hopIndex: 19 })
			expect(discovery).toHaveLength(3)
			wiring.dispose()
			b.closeAll()
		} finally {
			vi.useRealTimers()
		}
	})

	it("applies a patched ws.maxMessagesPerSecond on the next status event", async () => {
		vi.useFakeTimers()
		try {
			const b = new WebSocketEventBroadcaster(createLogger({ level: "fatal" }))
			const scannerMsgs = client(b, "c1", ["scanner"])
			const scanner = new FakeScanner()
			const wiring = wireScannerBroadcasts(scanner, b, {
				now: () => Date.now(),
			})
			// What patchSettings does: new effective settings, then a forced status emit.
			scanner.current.ws.maxMessagesPerSecond = 2
			scanner.emit("status", { enabled: true })
			for (let i = 0; i < 5; i++)
				scanner.emit("discovery", {
					change: "created",
					discovery: { id: `d_${i}` },
				})
			expect(scannerMsgs.map(m => m.type)).toEqual([
				"scanner:status",
				"scanner:discovery",
			])
			await vi.advanceTimersByTimeAsync(1000)
			expect(scannerMsgs).toHaveLength(4)
			scanner.current.ws.maxMessagesPerSecond = 10
			scanner.emit("status", { enabled: true })
			expect(scannerMsgs).toHaveLength(7)
			wiring.dispose()
			b.closeAll()
		} finally {
			vi.useRealTimers()
		}
	})

	it("forwards the tuner command origin on the tuner channel", () => {
		const b = new WebSocketEventBroadcaster(createLogger({ level: "fatal" }))
		const msgs = client(b, "c1", ["tuner"])
		b.broadcastTunerCommandSent("rtl", "set-frequency", 446_100_000, "scanner")
		b.broadcastTunerCommandSent("rtl", "set-gain", 300)
		expect(msgs.map(m => [m.type, m.data])).toEqual([
			[
				"tuner:command-sent",
				{
					sourceId: "rtl",
					command: "set-frequency",
					value: 446_100_000,
					origin: "scanner",
				},
			],
			[
				"tuner:command-sent",
				{ sourceId: "rtl", command: "set-gain", value: 300 },
			],
		])
	})

	it("sends decoder:created and decoder:removed on the decoders channel", () => {
		const b = new WebSocketEventBroadcaster(createLogger({ level: "fatal" }))
		const msgs = client(b, "c1", ["decoders"])
		b.broadcastDecoderCreated({
			decoderId: "scan-abc-dmr-1",
			decoder: { id: "scan-abc-dmr-1" } as never,
		})
		b.broadcastDecoderRemoved({
			decoderId: "scan-abc-dmr-1",
			removedAt: "2026-10-09T12:00:00.000Z",
		})
		expect(msgs.map(m => [m.type, m.channel])).toEqual([
			["decoder:created", "decoders"],
			["decoder:removed", "decoders"],
		])
	})

	it("passes spectrum subscribe options to the service and forwards the ack and snapshots to that client only", () => {
		const b = new WebSocketEventBroadcaster(createLogger({ level: "fatal" }))
		const spectrum = new FakeSpectrum()
		const wiring = wireSpectrumBroadcasts(spectrum, b)
		const c1 = connect(b)
		const c2 = connect(b)
		const options = { sourceId: "rtl", hz: 25, bins: 2048 }
		c1.send({
			type: "subscribe",
			channels: ["spectrum"],
			options: { spectrum: options },
		})
		c2.send({ type: "subscribe", channels: ["spectrum"] })
		expect(spectrum.calls).toEqual([
			["subscribe", c1.id, options],
			["subscribe", c2.id, undefined],
		])
		const before = c2.socket.sent.length
		spectrum.emit(
			"profile",
			c1.id,
			{ selection: "source", sourceId: "rtl", outcome: "exact" },
			[{ sourceId: "rtl", profile: "25:2048", snapshot: true }],
		)
		expect(c1.socket.sent.map(m => [m.type, m.channel])).toEqual([
			["subscribed", undefined],
			["spectrum:profile", "spectrum"],
			["spectrum:frame", "spectrum"],
		])
		expect(c1.socket.sent[2]?.data).toMatchObject({ snapshot: true })
		expect(c2.socket.sent.length).toBe(before)
		spectrum.emit("frame", { sourceId: "rtl", profile: "10:512" }, [c2.id])
		expect(c2.socket.sent.at(-1)).toMatchObject({
			type: "spectrum:frame",
			channel: "spectrum",
		})
		expect(c1.socket.sent).toHaveLength(3)
		wiring.dispose()
		b.closeAll()
	})

	it("sendToClients serialises once and skips unlisted and closed clients", () => {
		const b = new WebSocketEventBroadcaster(createLogger({ level: "fatal" }))
		const m1 = client(b, "c1", ["spectrum"])
		const m2 = client(b, "c2", ["spectrum"])
		const m3 = client(b, "c3", ["spectrum"])
		const m4 = client(b, "c4", ["spectrum"], 3)
		const m5 = client(b, "c5", ["scanner"])
		const stringify = vi.spyOn(JSON, "stringify")
		let sent = 0
		try {
			sent = b.sendToClients("spectrum", ["c1", "c2", "c4", "c5"], {
				type: "spectrum:frame",
				data: { sourceId: "rtl" },
			})
			expect(stringify).toHaveBeenCalledTimes(1)
		} finally {
			stringify.mockRestore()
		}
		expect(sent).toBe(2)
		expect(m1.map(m => [m.type, m.channel])).toEqual([
			["spectrum:frame", "spectrum"],
		])
		expect(m2).toHaveLength(1)
		expect([m3, m4, m5].map(m => m.length)).toEqual([0, 0, 0])
	})

	it("releases spectrum demand on unsubscribe, close and terminate, exactly once", () => {
		const b = new WebSocketEventBroadcaster(createLogger({ level: "fatal" }))
		const spectrum = new FakeSpectrum()
		const wiring = wireSpectrumBroadcasts(spectrum, b)
		const subscribe = { type: "subscribe", channels: ["spectrum"] }
		const a = connect(b)
		a.send(subscribe)
		a.send({ type: "unsubscribe", channels: ["spectrum"] })
		a.send({ type: "unsubscribe", channels: ["spectrum"] })
		a.socket.emit("close", 1000, Buffer.from(""))
		expect(spectrum.unsubscribes(a.id)).toBe(1)
		const c = connect(b)
		c.send(subscribe)
		c.socket.emit("close", 1000, Buffer.from(""))
		c.socket.emit("close", 1000, Buffer.from(""))
		expect(spectrum.unsubscribes(c.id)).toBe(1)
		const t = connect(b)
		t.send(subscribe)
		// outbound overflow terminates the client; its socket then closes
		t.socket.bufferedAmount = 2 * 1024 * 1024
		b.sendToClients("spectrum", [t.id], { type: "spectrum:frame", data: {} })
		expect(t.socket.terminate).toHaveBeenCalled()
		t.socket.emit("close", 1006, Buffer.from(""))
		expect(spectrum.unsubscribes(t.id)).toBe(1)
		const x = connect(b)
		const y = connect(b)
		x.send(subscribe)
		y.send(subscribe)
		b.closeAll()
		x.socket.emit("close", 1000, Buffer.from(""))
		y.socket.emit("close", 1000, Buffer.from(""))
		expect([spectrum.unsubscribes(x.id), spectrum.unsubscribes(y.id)]).toEqual([
			1, 1,
		])
		wiring.dispose()
	})

	it("re-subscribing switches without a new message type", () => {
		const b = new WebSocketEventBroadcaster(createLogger({ level: "fatal" }))
		const spectrum = new FakeSpectrum()
		const wiring = wireSpectrumBroadcasts(spectrum, b)
		const c = connect(b)
		c.send({
			type: "subscribe",
			channels: ["spectrum"],
			options: { spectrum: { sourceId: "rtl" } },
		})
		c.send({
			type: "subscribe",
			channels: ["spectrum"],
			options: { spectrum: { sourceId: "air", hz: 5 } },
		})
		c.send({ type: "subscribe", channels: ["spectrum"] })
		// another channel's subscribe does not touch the spectrum selection
		c.send({ type: "subscribe", channels: ["scanner"] })
		expect(spectrum.calls).toEqual([
			["subscribe", c.id, { sourceId: "rtl" }],
			["subscribe", c.id, { sourceId: "air", hz: 5 }],
			["subscribe", c.id, undefined],
		])
		wiring.dispose()
		expect(spectrum.calls.at(-1)).toEqual(["unsubscribe", c.id])
		b.closeAll()
	})
})
