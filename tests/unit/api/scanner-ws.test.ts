import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import type { WebSocket } from "ws"
import {
	WebSocketEventBroadcaster,
	type WebSocketChannel,
} from "../../../src/api/websocket/events.js"
import { wireScannerBroadcasts } from "../../../src/api/websocket/scanner-broadcast.js"
import { createLogger } from "../../../src/utils/logger.js"
import { testSettings } from "../../mocks/scanner/engine-fakes.js"

function client(
	broadcaster: WebSocketEventBroadcaster,
	id: string,
	channels: WebSocketChannel[],
) {
	const messages: { type: string; channel: string; data: unknown }[] = []
	const socket = {
		readyState: 1,
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

describe("scanner WebSocket channels", () => {
	it("accepts subscriptions to the scanner channel", () => {
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
			JSON.stringify({ type: "subscribe", channels: ["scanner"] }),
		)
		const reply = JSON.parse(socket.sent.at(-1)!) as {
			type: string
			data: { channels: string[] }
		}
		expect(reply.type).toBe("subscribed")
		expect(reply.data.channels.sort()).toEqual(["scanner"])
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
})
