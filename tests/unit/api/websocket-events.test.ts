/**
 * WebSocket Events Property Tests
 *
 * Property-based tests for WebSocket channel filtering.
 * Requirements: 10.2, 10.3, 10.4
 */

import { describe, it, expect, vi } from "vitest"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { FastifyAccessController } from "../../../src/access/fastify-adapter.js"
import type { OperatorDataReadDto } from "@wavekit/api-types"
import { createEmptySnapshot } from "../../../src/operator-data/domain.js"
import { toOperatorDataReadDto } from "../../../src/operator-data/transport.js"
import { OPERATOR_DATA_LIMITS } from "../../../src/operator-data/schema.js"
import type { WebSocket } from "ws"
import * as fc from "fast-check"
import {
	WebSocketEventBroadcaster,
	type WebSocketChannel,
	type ServerMessage,
} from "../../../src/api/websocket/events.js"
import { createLogger } from "../../../src/utils/logger.js"

// Create a test logger
const testLogger = createLogger({ level: "fatal" })

// All valid WebSocket channels
const ALL_CHANNELS: WebSocketChannel[] = [
	"decoders",
	"metrics",
	"sources",
	"health",
	"fanout",
	"live-audio",
	"tuner",
]

/**
 * Mock WebSocket for testing
 */
function createMockWebSocket() {
	const messages: string[] = []
	return {
		readyState: 1, // WebSocket.OPEN
		send: vi.fn((data: string) => {
			messages.push(data)
		}),
		close: vi.fn(),
		on: vi.fn(),
		messages,
	}
}

/**
 * Arbitrary for generating valid WebSocket channels
 */
const channelArb = fc.constantFrom<WebSocketChannel>(
	"decoders",
	"metrics",
	"sources",
	"health",
	"fanout",
	"live-audio",
	"tuner",
)

/**
 * Arbitrary for generating non-empty subsets of channels
 */
const channelSubsetArb = fc
	.subarray(ALL_CHANNELS, { minLength: 1, maxLength: 3 })
	.map(arr => arr as WebSocketChannel[])

describe("WebSocket Events", () => {
	describe("Property 19: WebSocket Channel Filtering", () => {
		/**
		 * Feature: wavekit-core, Property 19: WebSocket Channel Filtering
		 * Validates: Requirements 10.2, 10.3, 10.4
		 *
		 * For any client subscribed to channel C, the client should receive
		 * all events for channel C and no events for channels not in their
		 * subscription list.
		 */
		it("should deliver events only to clients subscribed to the broadcast channel", () => {
			fc.assert(
				fc.property(
					// Generate subscribed channels (non-empty subset)
					channelSubsetArb,
					// Generate the channel to broadcast to
					channelArb,
					// Generate some test data
					fc.string({ minLength: 1, maxLength: 50 }),
					(subscribedChannels, broadcastChannel, testData) => {
						// Setup
						const broadcaster = new WebSocketEventBroadcaster(testLogger)
						const mockSocket = createMockWebSocket()

						// Simulate client connection by accessing private state
						// We need to use a workaround since we can't directly call handleConnection
						const clientState = {
							socket: mockSocket as unknown as WebSocket,
							subscriptions: new Set<WebSocketChannel>(subscribedChannels),
							id: "test-client-1",
						}

						// Access private clients map
						const clientsMap = (
							broadcaster as unknown as {
								clients: Map<string, typeof clientState>
							}
						).clients
						clientsMap.set("test-client-1", clientState)

						// Clear any previous messages
						mockSocket.messages.length = 0

						// Broadcast a message to the specified channel
						const message: ServerMessage = {
							type: "decoder:output",
							data: { testData },
						}
						broadcaster.broadcast(broadcastChannel, message)

						// Check the result
						const isSubscribed = subscribedChannels.includes(broadcastChannel)

						if (isSubscribed) {
							// Client should receive the message
							expect(mockSocket.messages.length).toBe(1)
							const received = JSON.parse(
								mockSocket.messages[0] ?? "{}",
							) as ServerMessage & { channel: WebSocketChannel }
							expect(received.channel).toBe(broadcastChannel)
							expect(received.data).toEqual({ testData })
						} else {
							// Client should NOT receive the message
							expect(mockSocket.messages.length).toBe(0)
						}

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		/**
		 * Feature: wavekit-core, Property 19: WebSocket Channel Filtering (Part 2)
		 * Validates: Requirements 10.2, 10.3
		 *
		 * For any sequence of broadcasts to different channels, a client should
		 * receive exactly the messages for channels they are subscribed to.
		 */
		it("should correctly filter multiple broadcasts across different channels", () => {
			fc.assert(
				fc.property(
					// Generate subscribed channels
					channelSubsetArb,
					// Generate a sequence of (channel, message) pairs to broadcast
					fc.array(
						fc.tuple(channelArb, fc.string({ minLength: 1, maxLength: 20 })),
						{ minLength: 1, maxLength: 10 },
					),
					(subscribedChannels, broadcasts) => {
						// Setup
						const broadcaster = new WebSocketEventBroadcaster(testLogger)
						const mockSocket = createMockWebSocket()

						// Simulate client connection
						const clientState = {
							socket: mockSocket as unknown as WebSocket,
							subscriptions: new Set<WebSocketChannel>(subscribedChannels),
							id: "test-client-1",
						}

						const clientsMap = (
							broadcaster as unknown as {
								clients: Map<string, typeof clientState>
							}
						).clients
						clientsMap.set("test-client-1", clientState)

						// Clear messages
						mockSocket.messages.length = 0

						// Perform all broadcasts
						for (const [channel, data] of broadcasts) {
							broadcaster.broadcast(channel, {
								type: "decoder:output",
								data: { value: data },
							})
						}

						// Count expected messages (broadcasts to subscribed channels)
						const expectedCount = broadcasts.filter(([channel]) =>
							subscribedChannels.includes(channel),
						).length

						// Verify count matches
						expect(mockSocket.messages.length).toBe(expectedCount)

						// Verify all received messages are for subscribed channels
						for (const msgStr of mockSocket.messages) {
							const msg = JSON.parse(msgStr) as { channel: WebSocketChannel }
							expect(subscribedChannels).toContain(msg.channel)
						}

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		/**
		 * Feature: wavekit-core, Property 19: WebSocket Channel Filtering (Part 3)
		 * Validates: Requirements 10.3, 10.4
		 *
		 * Decoder and source events should be delivered to the correct channels.
		 */
		it("should route decoder events to decoders channel and source events to sources channel", () => {
			fc.assert(
				fc.property(
					// Generate decoder ID
					fc
						.string({ minLength: 1, maxLength: 20 })
						.filter(s => s.trim().length > 0),
					// Generate source ID
					fc
						.string({ minLength: 1, maxLength: 20 })
						.filter(s => s.trim().length > 0),
					(decoderId, sourceId) => {
						// Setup broadcaster with two clients - one for each channel
						const broadcaster = new WebSocketEventBroadcaster(testLogger)

						const decoderSocket = createMockWebSocket()
						const sourceSocket = createMockWebSocket()

						// Client subscribed to decoders only
						const decoderClient = {
							socket: decoderSocket as unknown as WebSocket,
							subscriptions: new Set<WebSocketChannel>(["decoders"]),
							id: "decoder-client",
						}

						// Client subscribed to sources only
						const sourceClient = {
							socket: sourceSocket as unknown as WebSocket,
							subscriptions: new Set<WebSocketChannel>(["sources"]),
							id: "source-client",
						}

						const clientsMap = (
							broadcaster as unknown as {
								clients: Map<string, typeof decoderClient>
							}
						).clients
						clientsMap.set("decoder-client", decoderClient)
						clientsMap.set("source-client", sourceClient)

						// Clear messages
						decoderSocket.messages.length = 0
						sourceSocket.messages.length = 0

						// Broadcast decoder output (Requirement 10.3)
						broadcaster.broadcastDecoderOutput(decoderId, {
							timestamp: new Date(),
							decoder: decoderId,
							type: "decode",
							data: { test: true },
						})

						// Broadcast source connected (Requirement 10.4)
						broadcaster.broadcastSourceConnected(sourceId)

						// Verify decoder client received decoder event but not source event
						expect(decoderSocket.messages.length).toBe(1)
						const decoderMsg = JSON.parse(
							decoderSocket.messages[0] ?? "{}",
						) as { channel: WebSocketChannel; type: string }
						expect(decoderMsg.channel).toBe("decoders")
						expect(decoderMsg.type).toBe("decoder:output")

						// Verify source client received source event but not decoder event
						expect(sourceSocket.messages.length).toBe(1)
						const sourceMsg = JSON.parse(sourceSocket.messages[0] ?? "{}") as {
							channel: WebSocketChannel
							type: string
						}
						expect(sourceMsg.channel).toBe("sources")
						expect(sourceMsg.type).toBe("source:connected")

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		/**
		 * Feature: wavekit-core, Property 19: WebSocket Channel Filtering (Part 4)
		 * Validates: Requirements 10.2
		 *
		 * A client with no subscriptions should receive no events.
		 */
		it("should not deliver any events to clients with no subscriptions", () => {
			fc.assert(
				fc.property(
					// Generate channel to broadcast to
					channelArb,
					// Generate number of broadcasts
					fc.integer({ min: 1, max: 10 }),
					(channel, numBroadcasts) => {
						// Setup
						const broadcaster = new WebSocketEventBroadcaster(testLogger)
						const mockSocket = createMockWebSocket()

						// Client with NO subscriptions
						const clientState = {
							socket: mockSocket as unknown as WebSocket,
							subscriptions: new Set<WebSocketChannel>(), // Empty!
							id: "test-client-1",
						}

						const clientsMap = (
							broadcaster as unknown as {
								clients: Map<string, typeof clientState>
							}
						).clients
						clientsMap.set("test-client-1", clientState)

						// Clear messages
						mockSocket.messages.length = 0

						// Broadcast multiple messages
						for (let i = 0; i < numBroadcasts; i++) {
							broadcaster.broadcast(channel, {
								type: "decoder:output",
								data: { index: i },
							})
						}

						// Client should receive nothing
						expect(mockSocket.messages.length).toBe(0)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		/**
		 * Feature: wavekit-core, Property 19: WebSocket Channel Filtering (Part 5)
		 * Validates: Requirements 10.2
		 *
		 * A client subscribed to all channels should receive all events.
		 */
		it("should deliver all events to clients subscribed to all channels", () => {
			fc.assert(
				fc.property(
					// Generate a sequence of broadcasts to random channels
					fc.array(fc.tuple(channelArb, fc.integer({ min: 0, max: 1000 })), {
						minLength: 1,
						maxLength: 20,
					}),
					broadcasts => {
						// Setup
						const broadcaster = new WebSocketEventBroadcaster(testLogger)
						const mockSocket = createMockWebSocket()

						// Client subscribed to ALL channels
						const clientState = {
							socket: mockSocket as unknown as WebSocket,
							subscriptions: new Set<WebSocketChannel>(ALL_CHANNELS),
							id: "test-client-1",
						}

						const clientsMap = (
							broadcaster as unknown as {
								clients: Map<string, typeof clientState>
							}
						).clients
						clientsMap.set("test-client-1", clientState)

						// Clear messages
						mockSocket.messages.length = 0

						// Broadcast all messages
						for (const [channel, data] of broadcasts) {
							broadcaster.broadcast(channel, {
								type: "decoder:output",
								data: { value: data },
							})
						}

						// Client should receive ALL messages
						expect(mockSocket.messages.length).toBe(broadcasts.length)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})

		/**
		 * Feature: wavekit-core, Property 19: WebSocket Channel Filtering (Part 6)
		 * Validates: Requirements 20.4
		 *
		 * Health events should be delivered to the health channel only.
		 */
		it("should route health events to health channel only", () => {
			fc.assert(
				fc.property(
					// Generate decoder ID
					fc
						.string({ minLength: 1, maxLength: 20 })
						.filter(s => s.trim().length > 0),
					// Generate health state
					fc.constantFrom("running", "degraded", "faulted"),
					(decoderId, health) => {
						// Setup broadcaster with two clients
						const broadcaster = new WebSocketEventBroadcaster(testLogger)

						const healthSocket = createMockWebSocket()
						const decoderSocket = createMockWebSocket()

						// Client subscribed to health only
						const healthClient = {
							socket: healthSocket as unknown as WebSocket,
							subscriptions: new Set<WebSocketChannel>(["health"]),
							id: "health-client",
						}

						// Client subscribed to decoders only
						const decoderClient = {
							socket: decoderSocket as unknown as WebSocket,
							subscriptions: new Set<WebSocketChannel>(["decoders"]),
							id: "decoder-client",
						}

						const clientsMap = (
							broadcaster as unknown as {
								clients: Map<string, typeof healthClient>
							}
						).clients
						clientsMap.set("health-client", healthClient)
						clientsMap.set("decoder-client", decoderClient)

						// Clear messages
						healthSocket.messages.length = 0
						decoderSocket.messages.length = 0

						// Broadcast health event (Requirement 20.4)
						broadcaster.broadcastDecoderHealth(decoderId, health)

						// Verify health client received health event
						expect(healthSocket.messages.length).toBe(1)
						const healthMsg = JSON.parse(healthSocket.messages[0] ?? "{}") as {
							channel: WebSocketChannel
							type: string
							data: { decoderId: string; health: string }
						}
						expect(healthMsg.channel).toBe("health")
						expect(healthMsg.type).toBe("decoder:health")
						expect(healthMsg.data.decoderId).toBe(decoderId)
						expect(healthMsg.data.health).toBe(health)

						// Verify decoder client did NOT receive health event
						expect(decoderSocket.messages.length).toBe(0)

						return true
					},
				),
				{ numRuns: 100 },
			)
		})
	})
})

// Exercise real connection setup so heartbeat listeners and cleanup are covered.
interface TestClientState {
	id: string
	socket: WebSocket
	subscriptions: Set<WebSocketChannel>
	current?: () => boolean
}
interface TestDeliveryState {
	queue: Array<{ data: string; bytes: number }>
	queuedBytes: number
}
interface BroadcasterInternals {
	handleConnection(socket: WebSocket, current?: () => boolean): void
	clients: Map<string, TestClientState>
	delivery: WeakMap<TestClientState, TestDeliveryState>
	maintainClients(): void
	flushClient(client: TestClientState, state: TestDeliveryState): void
}
function connectSocket(
	broadcaster: WebSocketEventBroadcaster,
	current?: () => boolean,
	channels: WebSocketChannel[] = ["metrics"],
) {
	const listeners = new Map<string, (...args: unknown[]) => void>()
	const socket = {
		...createMockWebSocket(),
		bufferedAmount: 0,
		ping: vi.fn(),
		terminate: vi.fn(),
		on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
			listeners.set(event, listener)
		}),
	}
	const connect = broadcaster as unknown as BroadcasterInternals
	connect.handleConnection(socket as unknown as WebSocket, current)
	listeners.get("message")?.(JSON.stringify({ type: "subscribe", channels }))
	socket.messages.length = 0
	return {
		socket,
		client: [...connect.clients.values()].find(
			client => client.socket === (socket as unknown as WebSocket),
		),
		emit: (event: string, ...args: unknown[]) =>
			listeners.get(event)?.(...args),
	}
}

describe("WebSocket reliability", () => {
	it("bounds a slow client's queue and continues delivering to healthy peers", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		const slow = connectSocket(broadcaster)
		const healthy = connectSocket(broadcaster)
		try {
			slow.socket.bufferedAmount = 1
			for (let index = 0; index < 257; index++) {
				broadcaster.broadcastMetrics("source", {
					bytesReceived: index,
					dataRate: 1,
				})
			}
			expect(slow.socket.terminate).toHaveBeenCalledOnce()
			expect(slow.socket.messages).toHaveLength(0)
			expect(healthy.socket.messages).toHaveLength(257)
			expect(broadcaster.getConnectedClients()).toBe(1)
		} finally {
			broadcaster.closeAll()
		}
	})

	it("counts UTF-8 bytes and ws buffered bytes toward the outbound limit", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		const client = connectSocket(broadcaster)
		try {
			client.socket.bufferedAmount = 1024 * 1024 - 100
			broadcaster.broadcast("metrics", {
				type: "metrics",
				data: "é".repeat(50),
			})
			expect(client.socket.terminate).toHaveBeenCalledOnce()
			expect(broadcaster.getConnectedClients()).toBe(0)
		} finally {
			broadcaster.closeAll()
		}
	})

	it("flushes queued messages in order after the socket drains", () => {
		vi.useFakeTimers()
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		const client = connectSocket(broadcaster)
		try {
			client.socket.bufferedAmount = 1
			broadcaster.broadcastMetrics("source", { bytesReceived: 1, dataRate: 1 })
			broadcaster.broadcastMetrics("source", { bytesReceived: 2, dataRate: 1 })
			expect(client.socket.messages).toHaveLength(0)
			client.socket.bufferedAmount = 0
			vi.advanceTimersByTime(100)
			expect(
				client.socket.messages.map(
					message => JSON.parse(message).data.bytesReceived,
				),
			).toEqual([1, 2])
		} finally {
			broadcaster.closeAll()
			vi.useRealTimers()
		}
	})

	it("isolates asynchronous send errors and synchronous send throws", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		const failing = connectSocket(broadcaster)
		const throwing = connectSocket(broadcaster)
		const healthy = connectSocket(broadcaster)
		try {
			let callback: ((error?: Error) => void) | undefined
			failing.socket.send.mockImplementation(
				(_data: string, ...args: unknown[]) => {
					callback = args[0] as (error?: Error) => void
				},
			)
			throwing.socket.send.mockImplementation(() => {
				throw new Error("send failed")
			})
			broadcaster.broadcastMetrics("source", { bytesReceived: 1, dataRate: 1 })
			callback?.(new Error("write failed"))
			expect(failing.socket.terminate).toHaveBeenCalledOnce()
			expect(throwing.socket.terminate).toHaveBeenCalledOnce()
			expect(healthy.socket.messages).toHaveLength(1)
			expect(broadcaster.getConnectedClients()).toBe(1)
		} finally {
			broadcaster.closeAll()
		}
	})

	it("terminates clients missing pong while retaining responsive clients and clears timers", () => {
		vi.useFakeTimers()
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		const dead = connectSocket(broadcaster)
		const healthy = connectSocket(broadcaster)
		try {
			vi.advanceTimersByTime(30_000)
			expect(dead.socket.ping).toHaveBeenCalledOnce()
			healthy.emit("pong")
			vi.advanceTimersByTime(30_000)
			expect(dead.socket.terminate).toHaveBeenCalledOnce()
			expect(healthy.socket.terminate).not.toHaveBeenCalled()
			expect(broadcaster.getConnectedClients()).toBe(1)
			healthy.emit("close", 1000, Buffer.alloc(0))
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			broadcaster.closeAll()
			vi.useRealTimers()
		}
	})

	it("discards pending delivery and heartbeat timers on shutdown", () => {
		vi.useFakeTimers()
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		const client = connectSocket(broadcaster)
		try {
			client.socket.bufferedAmount = 1
			broadcaster.broadcastMetrics("source", { bytesReceived: 1, dataRate: 1 })
			broadcaster.closeAll()
			client.socket.bufferedAmount = 0
			vi.advanceTimersByTime(60_000)
			expect(client.socket.messages).toHaveLength(0)
			expect(client.socket.ping).not.toHaveBeenCalled()
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})
})

const operatorStoreId = "00000000-0000-4000-8000-000000000001"
const operatorTime = "2026-01-01T00:00:00.000Z"
function operatorDto(): OperatorDataReadDto {
	return toOperatorDataReadDto(createEmptySnapshot(operatorStoreId))
}

function maximumOperatorDto(): OperatorDataReadDto {
	const snapshot = createEmptySnapshot(operatorStoreId)
	snapshot.revision = OPERATOR_DATA_LIMITS.revision
	snapshot.preferenceOverrides = {
		units: "nautical",
		timeFormat: "local-12h",
		waterfallPalette: "phosphor",
		showSavedFrequencyLabels: false,
	}
	snapshot.savedFrequencies = Array.from(
		{ length: OPERATOR_DATA_LIMITS.savedFrequencies },
		(_, index) => ({
			id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
			name: "📡".repeat(128),
			group: "📡".repeat(64),
			frequencyHz: 100_000_000_000,
			bandwidthHz: 10_000_000,
			mode: "nfm",
			tone: { kind: "dcs", code: "777", polarity: "inverted" },
			createdAt: operatorTime,
			updatedAt: operatorTime,
		}),
	)
	snapshot.commandUsage = snapshot.savedFrequencies
		.slice(0, OPERATOR_DATA_LIMITS.commandUsage)
		.map((frequency, index) => ({
			command: "open-saved-frequency",
			savedFrequencyId: frequency.id,
			count: OPERATOR_DATA_LIMITS.usageCount,
			lastUsedAt: operatorTime,
			lastUsedRevision: OPERATOR_DATA_LIMITS.revision - index,
		}))
	const remaining =
		OPERATOR_DATA_LIMITS.snapshotBytes -
		Buffer.byteLength(JSON.stringify(snapshot))
	snapshot.savedFrequencies[0]!.updatedAt = operatorTime.replace(
		".000Z",
		`.000${"0".repeat(remaining)}Z`,
	)
	return toOperatorDataReadDto(snapshot)
}

function operatorMessage(
	data = operatorDto(),
	type:
		| "operator-data:snapshot"
		| "operator-data:updated" = "operator-data:snapshot",
): ServerMessage {
	return { type, channel: "operator-data", data }
}

function internals(
	broadcaster: WebSocketEventBroadcaster,
): BroadcasterInternals {
	return broadcaster as unknown as BroadcasterInternals
}

describe("operator-data WebSocket transport and current output authority", () => {
	it("recognizes the channel but preserves inactive legacy subscriptions", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		const subscribed = vi.fn()
		broadcaster.observeChannel("operator-data", {
			subscribed,
			unsubscribed: vi.fn(),
		})
		const client = connectSocket(broadcaster, undefined, [
			"metrics",
			"operator-data",
		])
		try {
			expect(broadcaster.getSubscribersCount("operator-data")).toBe(0)
			expect(broadcaster.getSubscribersCount("metrics")).toBe(1)
			expect(subscribed).not.toHaveBeenCalled()
			expect(
				broadcaster.sendToClients(
					"operator-data",
					[client.client!.id],
					operatorMessage(),
				),
			).toBe(0)
			client.emit(
				"message",
				JSON.stringify({ type: "subscribe", channels: ["operator-data"] }),
			)
			expect(JSON.parse(client.socket.messages[0]!)).toEqual({
				type: "subscribed",
				data: { channels: ["metrics"] },
			})
			expect(subscribed).not.toHaveBeenCalled()
		} finally {
			broadcaster.closeAll()
		}
	})

	it("sends canonical three-field snapshots and updates synchronously on repeat subscriptions", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		broadcaster.enableOperatorDataChannel()
		const data = operatorDto()
		const subscribed = vi.fn((id: string) => {
			expect(
				broadcaster.sendToClients("operator-data", [id], operatorMessage(data)),
			).toBe(1)
		})
		const unsubscribed = vi.fn()
		broadcaster.observeChannel("operator-data", { subscribed, unsubscribed })
		const client = connectSocket(broadcaster, () => true, [])
		try {
			for (let index = 0; index < 2; index++)
				client.emit(
					"message",
					JSON.stringify({ type: "subscribe", channels: ["operator-data"] }),
				)
			expect(subscribed).toHaveBeenCalledTimes(2)
			expect(
				client.socket.messages.map(message => JSON.parse(message).type),
			).toEqual([
				"subscribed",
				"operator-data:snapshot",
				"subscribed",
				"operator-data:snapshot",
			])
			broadcaster.broadcast(
				"operator-data",
				operatorMessage(data, "operator-data:updated"),
			)
			const updated = JSON.parse(client.socket.messages.at(-1)!) as Record<
				string,
				unknown
			>
			expect(Object.keys(updated).sort()).toEqual(["channel", "data", "type"])
			expect(updated).toEqual({
				type: "operator-data:updated",
				channel: "operator-data",
				data,
			})
			client.emit(
				"message",
				JSON.stringify({ type: "unsubscribe", channels: ["operator-data"] }),
			)
			expect(unsubscribed).toHaveBeenCalledOnce()
			broadcaster.invalidateClient(client.client!.id)
			expect(unsubscribed).toHaveBeenCalledOnce()
		} finally {
			broadcaster.closeAll()
		}
	})

	it("seals new subscriptions synchronously while delivering to existing current subscribers", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		broadcaster.enableOperatorDataChannel()
		const subscribed = vi.fn()
		broadcaster.observeChannel("operator-data", {
			subscribed,
			unsubscribed: vi.fn(),
		})
		const existing = connectSocket(broadcaster, () => true, ["operator-data"])
		try {
			broadcaster.stopSubscriptionAdmission()
			const newcomer = connectSocket(broadcaster, () => true, [
				"operator-data",
				"metrics",
			])
			existing.emit(
				"message",
				JSON.stringify({
					type: "subscribe",
					channels: ["operator-data", "metrics"],
				}),
			)
			expect(subscribed).toHaveBeenCalledOnce()
			expect(newcomer.client!.subscriptions.size).toBe(0)
			expect(existing.client!.subscriptions.has("metrics")).toBe(false)
			broadcaster.broadcast(
				"operator-data",
				operatorMessage(undefined, "operator-data:updated"),
			)
			expect(existing.socket.messages).toHaveLength(1)
			expect(newcomer.socket.messages).toHaveLength(0)
		} finally {
			broadcaster.closeAll()
		}
	})

	it.each(["blocked", "closing"] as const)(
		"clears a revoked queued client even when transport is %s",
		transport => {
			const broadcaster = new WebSocketEventBroadcaster(testLogger)
			broadcaster.enableOperatorDataChannel()
			let current = true
			const unsubscribed = vi.fn()
			broadcaster.observeChannel("operator-data", {
				subscribed: vi.fn(),
				unsubscribed,
			})
			const client = connectSocket(broadcaster, () => current, [
				"operator-data",
			])
			try {
				client.socket.bufferedAmount = 1
				broadcaster.broadcast("operator-data", operatorMessage())
				const state = internals(broadcaster).delivery.get(client.client!)!
				expect(state.queue).toHaveLength(1)
				current = false
				if (transport === "closing") client.socket.readyState = 2
				internals(broadcaster).maintainClients()
				expect(client.socket.terminate).toHaveBeenCalledOnce()
				expect(state.queue).toHaveLength(0)
				expect(state.queuedBytes).toBe(0)
				expect(internals(broadcaster).delivery.has(client.client!)).toBe(false)
				expect(unsubscribed).toHaveBeenCalledOnce()
				client.socket.bufferedAmount = 0
				client.socket.readyState = 1
				broadcaster.broadcast("operator-data", operatorMessage())
				client.emit("pong")
				client.emit(
					"message",
					JSON.stringify({ type: "subscribe", channels: ["operator-data"] }),
				)
				expect(client.socket.messages).toHaveLength(0)
				expect(internals(broadcaster).delivery.has(client.client!)).toBe(false)
			} finally {
				broadcaster.closeAll()
			}
		},
	)

	it("checks authority at flush after drain and before each send, discarding the revoked remainder", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		broadcaster.enableOperatorDataChannel()
		let current = true
		const client = connectSocket(broadcaster, () => current, ["operator-data"])
		try {
			client.socket.bufferedAmount = 1
			broadcaster.broadcast("operator-data", operatorMessage())
			broadcaster.broadcast(
				"operator-data",
				operatorMessage(undefined, "operator-data:updated"),
			)
			const state = internals(broadcaster).delivery.get(client.client!)!
			client.socket.bufferedAmount = 0
			client.socket.send.mockImplementation(data => {
				client.socket.messages.push(data)
				current = false
			})
			internals(broadcaster).flushClient(client.client!, state)
			expect(client.socket.messages).toHaveLength(1)
			expect(JSON.parse(client.socket.messages[0]!).type).toBe(
				"operator-data:snapshot",
			)
			expect(client.socket.terminate).toHaveBeenCalledOnce()
			expect(state.queue).toHaveLength(0)
			expect(state.queuedBytes).toBe(0)
		} finally {
			broadcaster.closeAll()
		}
	})

	it("discards a queued snapshot at the flush boundary when revoked before drain", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		broadcaster.enableOperatorDataChannel()
		let current = true
		const client = connectSocket(broadcaster, () => current, ["operator-data"])
		try {
			client.socket.bufferedAmount = 1
			broadcaster.broadcast("operator-data", operatorMessage())
			const state = internals(broadcaster).delivery.get(client.client!)!
			current = false
			client.socket.bufferedAmount = 0
			internals(broadcaster).flushClient(client.client!, state)
			expect(client.socket.messages).toHaveLength(0)
			expect(client.socket.terminate).toHaveBeenCalledOnce()
			expect(state.queue).toHaveLength(0)
		} finally {
			broadcaster.closeAll()
		}
	})

	it("rechecks current output on future enqueue before a closed-readyState early return", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		broadcaster.enableOperatorDataChannel()
		let current = true
		const client = connectSocket(broadcaster, () => current, ["operator-data"])
		try {
			client.socket.bufferedAmount = 1
			broadcaster.broadcast("operator-data", operatorMessage())
			const state = internals(broadcaster).delivery.get(client.client!)!
			current = false
			client.socket.readyState = 2
			expect(
				broadcaster.sendToClients(
					"operator-data",
					[client.client!.id],
					operatorMessage(),
				),
			).toBe(0)
			expect(client.socket.terminate).toHaveBeenCalledOnce()
			expect(state.queue).toHaveLength(0)
			expect(client.socket.messages).toHaveLength(0)
		} finally {
			broadcaster.closeAll()
		}
	})

	it("fails closed on an authority throw and keeps a distinct current machine peer alive", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		broadcaster.enableOperatorDataChannel()
		let unavailable = false
		const session = connectSocket(broadcaster, () => {
			if (unavailable) throw new Error("Session authority unavailable")
			return true
		}, ["operator-data"])
		const machine = connectSocket(broadcaster, () => true, ["operator-data"])
		try {
			unavailable = true
			broadcaster.broadcast("operator-data", operatorMessage())
			expect(session.socket.terminate).toHaveBeenCalledOnce()
			expect(session.socket.messages).toHaveLength(0)
			expect(machine.socket.messages).toHaveLength(1)
			expect(machine.socket.terminate).not.toHaveBeenCalled()
		} finally {
			broadcaster.closeAll()
		}
	})

	it("rechecks client presence after current() synchronously invalidates its reservation", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		broadcaster.enableOperatorDataChannel()
		let invalidate = false
		let id = ""
		const client = connectSocket(broadcaster, () => {
			if (invalidate) broadcaster.invalidateClient(id)
			return true
		}, ["operator-data"])
		id = client.client!.id
		try {
			invalidate = true
			broadcaster.broadcast("operator-data", operatorMessage())
			expect(client.socket.messages).toHaveLength(0)
			expect(internals(broadcaster).delivery.has(client.client!)).toBe(false)
			expect(broadcaster.getConnectedClients()).toBe(0)
		} finally {
			broadcaster.closeAll()
		}
	})

	it("does not recreate later mixed-observer state after an earlier observer invalidates the client", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		broadcaster.enableOperatorDataChannel()
		const late = vi.fn()
		broadcaster.observeChannel("metrics", {
			subscribed: id => broadcaster.invalidateClient(id),
			unsubscribed: vi.fn(),
		})
		broadcaster.observeChannel("operator-data", {
			subscribed: late,
			unsubscribed: vi.fn(),
		})
		const client = connectSocket(broadcaster, () => true, [
			"metrics",
			"operator-data",
		])
		try {
			expect(late).not.toHaveBeenCalled()
			expect(client.socket.terminate).toHaveBeenCalledOnce()
			expect(broadcaster.getConnectedClients()).toBe(0)
		} finally {
			broadcaster.closeAll()
		}
	})

	it("does not capture a snapshot after the acknowledgement overflows the shared budget", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		broadcaster.enableOperatorDataChannel()
		const capture = vi.fn()
		broadcaster.observeChannel("operator-data", {
			subscribed: capture,
			unsubscribed: vi.fn(),
		})
		const client = connectSocket(broadcaster, () => true, [])
		try {
			client.socket.bufferedAmount = 1024 * 1024
			client.emit(
				"message",
				JSON.stringify({ type: "subscribe", channels: ["operator-data"] }),
			)
			expect(capture).not.toHaveBeenCalled()
			expect(client.socket.terminate).toHaveBeenCalledOnce()
		} finally {
			broadcaster.closeAll()
		}
	})

	it("invalidates one snapshot client or channel subscribers without unrelated peer teardown", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		broadcaster.enableOperatorDataChannel()
		const unsubscribed = vi.fn()
		broadcaster.observeChannel("operator-data", {
			subscribed: vi.fn(),
			unsubscribed,
		})
		const first = connectSocket(broadcaster, () => true, ["operator-data"])
		const second = connectSocket(broadcaster, () => true, ["operator-data"])
		const metrics = connectSocket(broadcaster)
		try {
			broadcaster.invalidateClient(first.client!.id)
			broadcaster.invalidateClient(first.client!.id)
			expect(first.socket.terminate).toHaveBeenCalledOnce()
			expect(second.socket.terminate).not.toHaveBeenCalled()
			broadcaster.invalidateChannelClients("operator-data")
			expect(second.socket.terminate).toHaveBeenCalledOnce()
			expect(unsubscribed).toHaveBeenCalledTimes(2)
			expect(metrics.socket.terminate).not.toHaveBeenCalled()
			broadcaster.broadcastMetrics("source", { bytesReceived: 1, dataRate: 1 })
			expect(metrics.socket.messages).toHaveLength(1)
		} finally {
			broadcaster.closeAll()
		}
	})

	it("retains the adopted original request/socket as the controller current-output guard", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		broadcaster.enableOperatorDataChannel()
		let route:
			| ((socket: WebSocket, request: FastifyRequest) => void)
			| undefined
		const fastify = {
			get: (_path: string, _options: unknown, handler: typeof route) => {
				route = handler
			},
		} as unknown as FastifyInstance
		const current = vi.fn(() => true)
		const adopt = vi.fn(() => true)
		const controller = {
			adoptWebSocket: adopt,
			isWebSocketCurrent: current,
		} as unknown as FastifyAccessController
		broadcaster.registerRoute(fastify, controller)
		const socket = {
			...createMockWebSocket(),
			bufferedAmount: 0,
			terminate: vi.fn(),
			ping: vi.fn(),
		}
		const request = { id: "original-request" } as unknown as FastifyRequest
		try {
			route!(socket as unknown as WebSocket, request)
			const client = [...internals(broadcaster).clients.values()][0]!
			client.subscriptions.add("operator-data")
			broadcaster.broadcast("operator-data", operatorMessage())
			expect(adopt).toHaveBeenCalledWith(request, socket)
			expect(current).toHaveBeenCalledWith(request, socket)
			current.mockReturnValue(false)
			broadcaster.broadcast("operator-data", operatorMessage())
			expect(socket.messages).toHaveLength(1)
			expect(socket.terminate).toHaveBeenCalledOnce()
		} finally {
			broadcaster.closeAll()
		}
	})

	it("measures exact maximum envelopes and ack headroom, terminates two-quota backlog, and refetches on reconnect", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		broadcaster.enableOperatorDataChannel()
		const data = maximumOperatorDto()
		const snapshot = operatorMessage(data)
		const update = operatorMessage(data, "operator-data:updated")
		const bytes = Buffer.byteLength(JSON.stringify(data))
		const serializationStart = performance.now()
		const cpuStart = process.cpuUsage()
		const snapshotJson = JSON.stringify(snapshot)
		const updateJson = JSON.stringify(update)
		const serializationMs = performance.now() - serializationStart
		const cpu = process.cpuUsage(cpuStart)
		const snapshotBytes = Buffer.byteLength(snapshotJson)
		const updateBytes = Buffer.byteLength(updateJson)
		// One bounded observation, with no host-dependent timing assertion.
		console.info("Operator WS maximum envelope measurement", {
			readDtoBytes: bytes,
			snapshotBytes,
			updateBytes,
			serializationMs,
			serializationCpuMicroseconds: cpu.user + cpu.system,
		})
		const ackBytes = Buffer.byteLength(
			JSON.stringify({
				type: "subscribed",
				data: { channels: ["operator-data"] },
			}),
		)
		expect(bytes).toBe(524_811)
		expect(snapshotBytes).toBe(524_878)
		expect(updateBytes).toBe(524_877)
		expect(ackBytes + snapshotBytes + 1).toBeLessThan(1024 * 1024)
		expect(snapshotBytes + updateBytes).toBeGreaterThan(1024 * 1024)
		const unsubscribed = vi.fn()
		broadcaster.observeChannel("operator-data", {
			subscribed: id => {
				broadcaster.sendToClients("operator-data", [id], snapshot)
			},
			unsubscribed,
		})
		const client = connectSocket(broadcaster, () => true, [])
		try {
			client.socket.bufferedAmount = 1
			client.emit(
				"message",
				JSON.stringify({ type: "subscribe", channels: ["operator-data"] }),
			)
			const state = internals(broadcaster).delivery.get(client.client!)!
			expect(state.queue).toHaveLength(2)
			expect(state.queuedBytes).toBe(ackBytes + snapshotBytes)
			broadcaster.broadcast("operator-data", update)
			expect(client.socket.terminate).toHaveBeenCalledOnce()
			expect(state.queue).toHaveLength(0)
			expect(state.queuedBytes).toBe(0)
			expect(unsubscribed).toHaveBeenCalledOnce()
			const reconnected = connectSocket(broadcaster, () => true, [])
			reconnected.emit(
				"message",
				JSON.stringify({ type: "subscribe", channels: ["operator-data"] }),
			)
			expect(JSON.parse(reconnected.socket.messages[1]!).data).toEqual(data)
		} finally {
			broadcaster.closeAll()
		}
	})

	it("shares the byte budget across operator and metrics messages including socket bytes", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		broadcaster.enableOperatorDataChannel()
		const client = connectSocket(broadcaster, () => true, [
			"operator-data",
			"metrics",
		])
		try {
			client.socket.bufferedAmount = 1
			broadcaster.broadcast(
				"operator-data",
				operatorMessage(maximumOperatorDto()),
			)
			const state = internals(broadcaster).delivery.get(client.client!)!
			const previous = state.queuedBytes
			broadcaster.broadcast("metrics", {
				type: "metrics",
				data: "x".repeat(1024 * 1024 - previous),
			})
			expect(client.socket.terminate).toHaveBeenCalledOnce()
			expect(state.queuedBytes).toBe(0)
			expect(state.queue).toHaveLength(0)
		} finally {
			broadcaster.closeAll()
		}
	})

	it("shares the 256-message bound across operator and metrics and discards all on overflow", () => {
		const broadcaster = new WebSocketEventBroadcaster(testLogger)
		broadcaster.enableOperatorDataChannel()
		const client = connectSocket(broadcaster, () => true, [
			"operator-data",
			"metrics",
		])
		try {
			client.socket.bufferedAmount = 1
			for (let index = 0; index < 256; index++) {
				if (index % 2)
					broadcaster.broadcast("metrics", { type: "metrics", data: index })
				else broadcaster.broadcast("operator-data", operatorMessage())
			}
			const state = internals(broadcaster).delivery.get(client.client!)!
			expect(state.queue).toHaveLength(256)
			expect(
				state.queuedBytes + client.socket.bufferedAmount,
			).toBeLessThanOrEqual(1024 * 1024)
			broadcaster.broadcastMetrics("source", {
				bytesReceived: 257,
				dataRate: 1,
			})
			expect(client.socket.terminate).toHaveBeenCalledOnce()
			expect(state.queue).toHaveLength(0)
			expect(state.queuedBytes).toBe(0)
		} finally {
			broadcaster.closeAll()
		}
	})
})
