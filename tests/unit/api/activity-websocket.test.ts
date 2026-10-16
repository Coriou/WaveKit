import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { createActivitySubscriptions } from "../../../src/api/activity-subscriptions.js"
import { WebSocketEventBroadcaster } from "../../../src/api/websocket/events.js"
import type {
	ActivityQueryService,
	ActivityReplayFrame,
	ActivityReplayHandle,
} from "../../../src/core/activity/storage/contract.js"
import pino from "pino"

const logger = pino({ level: "silent" })

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

function inertService(): ActivityQueryService {
	const fail = (): never => {
		throw new Error("activity service was called")
	}
	return {
		search: async () => fail(),
		detail: async () => fail(),
		facets: async () => fail(),
		trails: async () => fail(),
		replay: () => fail(),
		close: async () => {},
	}
}

describe("activity websocket hook", () => {
	it("answers ACTIVITY_DISABLED instead of invalid format when no hub is attached", () => {
		const broadcaster = new WebSocketEventBroadcaster(logger)
		const { socket, send } = connect(broadcaster)
		send({ type: "activity:subscribe", id: "one", query: {} })
		send({ type: "nope" })
		expect(socket.sent.map(message => message.data)).toEqual([
			{
				code: "ACTIVITY_DISABLED",
				message: "Activity is disabled",
			},
			{ message: "Invalid message format" },
		])
		expect(socket.sent[0]?.channel).toBe("activity")
		broadcaster.closeAll()
	})

	it("answers ACTIVITY_UNAVAILABLE when the store did not open", () => {
		const broadcaster = new WebSocketEventBroadcaster(logger)
		broadcaster.attachActivity(
			createActivitySubscriptions({
				service: inertService(),
				enabled: false,
				unavailable: true,
			}),
		)
		const { socket, send } = connect(broadcaster)
		send({ type: "activity:subscribe", id: "one", query: {} })
		send({ type: "activity:unsubscribe", id: "one" })
		expect(socket.sent.map(message => message.data)).toEqual([
			{
				code: "ACTIVITY_UNAVAILABLE",
				message: "Activity is unavailable",
				id: "one",
			},
			{
				code: "ACTIVITY_UNAVAILABLE",
				message: "Activity is unavailable",
				id: "one",
			},
		])
		broadcaster.closeAll()
	})

	it("resumes a paused activity frame on drain and detaches on close", () => {
		const frames: ActivityReplayFrame[] = []
		let stops = 0
		let resumes = 0
		const service: ActivityQueryService = {
			...inertService(),
			replay(_input, sink): ActivityReplayHandle {
				const frame: ActivityReplayFrame = {
					type: "records",
					items: [],
					scannedThrough: "1",
					cursor: "cursor-1",
				}
				frames.push(frame)
				sink.send(frame)
				return {
					resume() {
						resumes += 1
						sink.send({
							type: "progress",
							scannedThrough: "1",
							cursor: "cursor-1",
						})
					},
					stop() {
						stops += 1
					},
				}
			},
		}
		const broadcaster = new WebSocketEventBroadcaster(logger)
		broadcaster.attachActivity(
			createActivitySubscriptions({ service, enabled: true }),
		)
		const { socket, send } = connect(broadcaster)
		socket.bufferedAmount = 8
		send({ type: "activity:subscribe", id: "one", query: {} })
		expect(socket.sent).toEqual([])
		expect(stops).toBe(0)
		socket.bufferedAmount = 0
		socket.emit("drain")
		expect(
			socket.sent.some(message => message.type === "activity:records"),
		).toBe(true)
		expect(socket.sent.every(message => message.channel === "activity")).toBe(
			true,
		)
		expect(resumes).toBe(1)
		socket.emit("close", 1000, Buffer.from(""))
		expect(stops).toBe(1)
		broadcaster.closeAll()
	})

	it("closes activity subscriptions when the broadcaster shuts down", () => {
		let stops = 0
		const service: ActivityQueryService = {
			...inertService(),
			replay(): ActivityReplayHandle {
				return {
					resume() {},
					stop() {
						stops += 1
					},
				}
			},
		}
		const broadcaster = new WebSocketEventBroadcaster(logger)
		broadcaster.attachActivity(
			createActivitySubscriptions({ service, enabled: true }),
		)
		const { socket, send } = connect(broadcaster)
		send({ type: "activity:subscribe", id: "one", query: {} })
		broadcaster.closeAll()
		expect(stops).toBe(1)
		expect(socket.close).toHaveBeenCalled()
	})

	it("still accepts an ordinary channel subscribe", () => {
		const broadcaster = new WebSocketEventBroadcaster(logger)
		broadcaster.attachActivity(
			createActivitySubscriptions({
				service: inertService(),
				enabled: false,
			}),
		)
		const { socket, send } = connect(broadcaster)
		send({ type: "subscribe", channels: ["decoders"] })
		expect(socket.sent.at(-1)?.type).toBe("subscribed")
		broadcaster.closeAll()
	})
})
