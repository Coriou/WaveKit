import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import type { ScannerIdentifyEventData } from "@wavekit/api-types"
import type { WebSocket } from "ws"
import { WebSocketEventBroadcaster } from "../../../src/api/websocket/events.js"
import { wireScannerBroadcasts } from "../../../src/api/websocket/scanner-broadcast.js"
import { createLogger } from "../../../src/utils/logger.js"
import { testSettings } from "../../mocks/scanner/engine-fakes.js"

class FakeScanner extends EventEmitter {
	readonly current = testSettings()
	settings() {
		return this.current
	}
}

function scannerClient(broadcaster: WebSocketEventBroadcaster) {
	const messages: { type: string; channel: string; data: unknown }[] = []
	const socket = {
		readyState: 1,
		send: (d: string) => messages.push(JSON.parse(d) as never),
		close: vi.fn(),
		on: vi.fn(),
	}
	;(broadcaster as unknown as { clients: Map<string, unknown> }).clients.set(
		"c1",
		{
			socket: socket as unknown as WebSocket,
			subscriptions: new Set(["scanner"]),
			id: "c1",
		},
	)
	return messages
}

const event = (
	state: ScannerIdentifyEventData["state"],
	targetHz = 446_125_000,
): ScannerIdentifyEventData => ({
	jobId: "j_1",
	targetHz,
	state,
	trials: [],
})

describe("scanner:identify on the scanner channel (spec § 12.2)", () => {
	it("sends identify events per target, coalesced to the latest, and stops after dispose", async () => {
		vi.useFakeTimers()
		try {
			const b = new WebSocketEventBroadcaster(createLogger({ level: "fatal" }))
			const msgs = scannerClient(b)
			const scanner = new FakeScanner()
			const wiring = wireScannerBroadcasts(scanner, b, {
				now: () => Date.now(),
			})
			expect(scanner.listenerCount("identify")).toBe(1)
			scanner.emit("identify", event("waiting-for-signal"))
			scanner.emit("identify", event("trying"))
			scanner.emit("identify", event("identified"))
			// another target of the same job is its own key
			scanner.emit("identify", event("trying", 446_300_000))
			const identify = () => msgs.filter(m => m.type === "scanner:identify")
			expect(identify().map(m => m.data)).toEqual([
				event("waiting-for-signal"),
				event("trying", 446_300_000),
			])
			await vi.advanceTimersByTimeAsync(1100)
			expect(identify().at(-1)).toMatchObject({
				channel: "scanner",
				data: { targetHz: 446_125_000, state: "identified" },
			})
			wiring.dispose()
			expect(scanner.listenerCount("identify")).toBe(0)
			const sent = identify().length
			scanner.emit("identify", event("candidate", 446_400_000))
			await vi.advanceTimersByTimeAsync(1100)
			expect(identify()).toHaveLength(sent)
			b.closeAll()
		} finally {
			vi.useRealTimers()
		}
	})
})
