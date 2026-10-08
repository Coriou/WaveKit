/**
 * WebSocket Events Property Tests
 *
 * Property-based tests for WebSocket channel filtering.
 * Requirements: 10.2, 10.3, 10.4
 */

import { describe, it, expect, vi } from "vitest"
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
function connectSocket(broadcaster: WebSocketEventBroadcaster) {
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
	const connect = broadcaster as unknown as {
		handleConnection(socket: WebSocket): void
	}
	connect.handleConnection(socket as unknown as WebSocket)
	listeners.get("message")?.(
		JSON.stringify({ type: "subscribe", channels: ["metrics"] }),
	)
	socket.messages.length = 0
	return {
		socket,
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
