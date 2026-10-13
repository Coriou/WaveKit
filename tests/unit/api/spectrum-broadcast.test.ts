import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import type {
	SpectrumFrameEventData,
	SpectrumProfileEventData,
} from "@wavekit/api-types"
import {
	WebSocketEventBroadcaster,
	type WebSocketChannel,
} from "../../../src/api/websocket/events.js"
import { wireSpectrumBroadcasts } from "../../../src/api/websocket/spectrum-broadcast.js"
import { createLogger } from "../../../src/utils/logger.js"

function connect(broadcaster: WebSocketEventBroadcaster) {
	const socket = Object.assign(new EventEmitter(), {
		readyState: 1,
		bufferedAmount: 0,
		sent: [] as { type: string; channel?: string; data: unknown }[],
		send(d: string) {
			this.sent.push(JSON.parse(d) as never)
		},
		close: () => undefined,
		ping: () => undefined,
		terminate: () => undefined,
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

class Source extends EventEmitter {
	subscribe(): Promise<void> {
		return Promise.resolve()
	}
	unsubscribe(): Promise<void> {
		return Promise.resolve()
	}
}

const ack = {
	selection: "source",
	sourceId: "rtl",
	profile: { key: "25:2048", hz: 25, bins: 2048 },
	effectiveHz: 20,
	outcome: "exact",
	adjusted: [],
	backfillFrames: 2,
} satisfies SpectrumProfileEventData

function frame(
	at: string,
	flag: "backfill" | "snapshot",
): SpectrumFrameEventData {
	return {
		sourceId: "rtl",
		profile: "25:2048",
		epoch: 1,
		tuningTrust: "commanded",
		centerHz: 446_000_000,
		sampleRateHz: 1_024_000,
		binHz: 1000,
		nativeBinHz: 1000,
		startHz: 445_000_000,
		binCount: 1,
		bins: "AA==",
		binEncoding: "u8-halfdb-127.5",
		floorDbfs: -90,
		thresholdDb: 10,
		tracks: [],
		masks: { dcHz: 446_000_000, dcGuardHz: 1500, spurRanges: [] },
		...(flag === "backfill"
			? { backfill: true as const }
			: { snapshot: true as const }),
		at,
	}
}

describe("spectrum broadcast backfill order", () => {
	it("sends the ack, then backfill frames, then snapshots, to that client only", () => {
		const b = new WebSocketEventBroadcaster(createLogger({ level: "fatal" }))
		const source = new Source()
		const wiring = wireSpectrumBroadcasts(source, b)
		const c1 = connect(b)
		const c2 = connect(b)
		c1.send({
			type: "subscribe",
			channels: ["spectrum"] satisfies WebSocketChannel[],
		})
		c2.send({
			type: "subscribe",
			channels: ["spectrum"] satisfies WebSocketChannel[],
		})
		const before = c2.socket.sent.length
		const older = frame("2026-10-13T00:00:00.000Z", "backfill")
		const newer = frame("2026-10-13T00:00:01.000Z", "backfill")
		const snapshot = frame("2026-10-13T00:00:02.000Z", "snapshot")
		source.emit("profile", c1.id, ack, [snapshot], [older, newer])
		expect(c1.socket.sent.map(m => m.type)).toEqual([
			"subscribed",
			"spectrum:profile",
			"spectrum:frame",
			"spectrum:frame",
			"spectrum:frame",
		])
		expect(c1.socket.sent.slice(1).map(m => m.data)).toEqual([
			ack,
			older,
			newer,
			snapshot,
		])
		expect(c2.socket.sent.length).toBe(before)
		wiring.dispose()
		b.closeAll()
	})

	it("sends a snapshot straight after the ack when there is no backfill", () => {
		const b = new WebSocketEventBroadcaster(createLogger({ level: "fatal" }))
		const source = new Source()
		const wiring = wireSpectrumBroadcasts(source, b)
		const c = connect(b)
		c.send({
			type: "subscribe",
			channels: ["spectrum"] satisfies WebSocketChannel[],
		})
		const snapshot = frame("2026-10-13T00:00:02.000Z", "snapshot")
		const { backfillFrames: _frames, ...plain } = ack
		source.emit("profile", c.id, plain, [snapshot], [])
		expect(c.socket.sent.slice(1).map(m => m.type)).toEqual([
			"spectrum:profile",
			"spectrum:frame",
		])
		expect(c.socket.sent[2]?.data).toMatchObject({ snapshot: true })
		// A profile emit that predates the backfill argument still delivers the snapshot.
		source.emit("profile", c.id, ack, [snapshot])
		expect(c.socket.sent.at(-1)?.data).toMatchObject({ snapshot: true })
		wiring.dispose()
		b.closeAll()
	})
})
