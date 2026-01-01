/**
 * WebSocket Events - Real-time event broadcasting
 *
 * Requirements:
 * - 10.1: WHEN a client connects to /ws, THE API_Server SHALL accept the WebSocket connection
 * - 10.2: WHEN a client subscribes to channels, THE API_Server SHALL send events for those channels only
 * - 10.3: WHEN a decoder produces output, THE API_Server SHALL broadcast it to subscribed clients
 * - 10.4: WHEN a source connects or disconnects, THE API_Server SHALL broadcast the event to subscribed clients
 * - 10.5: THE API_Server SHALL support channels: decoders, metrics, sources
 */

import type { FastifyInstance } from "fastify"
import type { WebSocket } from "ws"
import type { Logger } from "../../utils/logger.js"
import { createComponentLogger } from "../../utils/logger.js"
import type { DecoderOutput } from "../../decoders/types.js"

/**
 * Supported WebSocket channels for subscription.
 * - decoders: Decoder output, started, stopped, error events
 * - metrics: Source metrics events
 * - sources: Source connected, disconnected, error events
 * - health: Decoder health state change events (Requirement 20.4)
 */
export type WebSocketChannel = "decoders" | "metrics" | "sources" | "health"

/**
 * Message sent from client to server.
 */
export interface ClientMessage {
	type: "subscribe" | "unsubscribe"
	channels: WebSocketChannel[]
}

/**
 * Message sent from server to client.
 */
export interface ServerMessage {
	type:
		| "decoder:output"
		| "decoder:started"
		| "decoder:stopped"
		| "decoder:error"
		| "decoder:health"
		| "source:connected"
		| "source:disconnected"
		| "source:error"
		| "metrics"
		| "subscribed"
		| "unsubscribed"
		| "error"
	channel?: WebSocketChannel
	data: unknown
}

/**
 * Internal client state tracking subscriptions.
 */
interface ClientState {
	socket: WebSocket
	subscriptions: Set<WebSocketChannel>
	id: string
}

/**
 * Validates if a value is a valid WebSocket channel.
 */
function isValidChannel(channel: unknown): channel is WebSocketChannel {
	return (
		channel === "decoders" ||
		channel === "metrics" ||
		channel === "sources" ||
		channel === "health"
	)
}

/**
 * Validates and parses a client message.
 */
function parseClientMessage(data: unknown): ClientMessage | null {
	if (typeof data !== "object" || data === null) {
		return null
	}

	const msg = data as Record<string, unknown>

	if (msg["type"] !== "subscribe" && msg["type"] !== "unsubscribe") {
		return null
	}

	if (!Array.isArray(msg["channels"])) {
		return null
	}

	const validChannels = msg["channels"].filter(isValidChannel)
	if (validChannels.length === 0) {
		return null
	}

	return {
		type: msg["type"] as "subscribe" | "unsubscribe",
		channels: validChannels,
	}
}

/**
 * WebSocketEventBroadcaster - Manages WebSocket connections and broadcasts events.
 *
 * Handles:
 * - Client connection management
 * - Channel subscription/unsubscription
 * - Event broadcasting to subscribed clients
 * - Graceful cleanup on disconnect
 */
export class WebSocketEventBroadcaster {
	private readonly log: Logger
	private readonly clients: Map<string, ClientState> = new Map()
	private clientIdCounter = 0

	constructor(logger: Logger) {
		this.log = createComponentLogger(logger, "WebSocketBroadcaster")
	}

	/**
	 * Registers the WebSocket route with Fastify.
	 * Call this after registering the fastify-websocket plugin.
	 *
	 * @param fastify - Fastify instance with websocket plugin registered
	 */
	registerRoute(fastify: FastifyInstance): void {
		fastify.get("/ws", { websocket: true }, (socket: WebSocket, _request) => {
			this.handleConnection(socket)
		})

		this.log.info("WebSocket route registered at /ws")
	}

	/**
	 * Handles a new WebSocket connection (Requirement 10.1).
	 */
	private handleConnection(socket: WebSocket): void {
		const clientId = `client-${++this.clientIdCounter}`

		const clientState: ClientState = {
			socket,
			subscriptions: new Set(),
			id: clientId,
		}

		this.clients.set(clientId, clientState)

		this.log.info({ clientId }, "WebSocket client connected")

		// Handle incoming messages
		socket.on("message", (data: Buffer | string) => {
			this.handleMessage(clientState, data)
		})

		// Handle client disconnect
		socket.on("close", () => {
			this.handleDisconnect(clientState)
		})

		// Handle errors
		socket.on("error", (err: Error) => {
			this.log.error({ clientId, err }, "WebSocket error")
		})
	}

	/**
	 * Handles incoming messages from a client.
	 */
	private handleMessage(client: ClientState, data: Buffer | string): void {
		try {
			const rawData = typeof data === "string" ? data : data.toString("utf-8")
			const parsed = JSON.parse(rawData) as unknown
			const message = parseClientMessage(parsed)

			if (!message) {
				this.sendToClient(client, {
					type: "error",
					data: { message: "Invalid message format" },
				})
				return
			}

			if (message.type === "subscribe") {
				this.handleSubscribe(client, message.channels)
			} else {
				this.handleUnsubscribe(client, message.channels)
			}
		} catch (err) {
			this.log.warn(
				{ clientId: client.id, err },
				"Failed to parse client message",
			)
			this.sendToClient(client, {
				type: "error",
				data: { message: "Invalid JSON" },
			})
		}
	}

	/**
	 * Handles channel subscription (Requirement 10.2).
	 */
	private handleSubscribe(
		client: ClientState,
		channels: WebSocketChannel[],
	): void {
		for (const channel of channels) {
			client.subscriptions.add(channel)
		}

		this.log.debug(
			{
				clientId: client.id,
				channels,
				totalSubscriptions: client.subscriptions.size,
			},
			"Client subscribed to channels",
		)

		this.sendToClient(client, {
			type: "subscribed",
			data: { channels: Array.from(client.subscriptions) },
		})
	}

	/**
	 * Handles channel unsubscription.
	 */
	private handleUnsubscribe(
		client: ClientState,
		channels: WebSocketChannel[],
	): void {
		for (const channel of channels) {
			client.subscriptions.delete(channel)
		}

		this.log.debug(
			{
				clientId: client.id,
				channels,
				totalSubscriptions: client.subscriptions.size,
			},
			"Client unsubscribed from channels",
		)

		this.sendToClient(client, {
			type: "unsubscribed",
			data: { channels: Array.from(client.subscriptions) },
		})
	}

	/**
	 * Handles client disconnect.
	 */
	private handleDisconnect(client: ClientState): void {
		this.clients.delete(client.id)
		this.log.info({ clientId: client.id }, "WebSocket client disconnected")
	}

	/**
	 * Sends a message to a specific client.
	 */
	private sendToClient(client: ClientState, message: ServerMessage): void {
		if (client.socket.readyState === 1) {
			// WebSocket.OPEN
			try {
				client.socket.send(JSON.stringify(message))
			} catch (err) {
				this.log.error(
					{ clientId: client.id, err },
					"Failed to send message to client",
				)
			}
		}
	}

	/**
	 * Broadcasts a message to all clients subscribed to a channel (Requirement 10.2).
	 *
	 * @param channel - The channel to broadcast to
	 * @param message - The message to broadcast
	 */
	broadcast(channel: WebSocketChannel, message: ServerMessage): void {
		const messageWithChannel = { ...message, channel }
		const serialized = JSON.stringify(messageWithChannel)

		let sentCount = 0

		for (const client of this.clients.values()) {
			if (client.subscriptions.has(channel) && client.socket.readyState === 1) {
				try {
					client.socket.send(serialized)
					sentCount++
				} catch (err) {
					this.log.error(
						{ clientId: client.id, err },
						"Failed to broadcast to client",
					)
				}
			}
		}

		this.log.trace(
			{ channel, type: message.type, sentCount },
			"Broadcast message",
		)
	}

	/**
	 * Broadcasts decoder output to subscribed clients (Requirement 10.3).
	 *
	 * @param decoderId - The decoder that produced the output
	 * @param output - The decoder output
	 */
	broadcastDecoderOutput(decoderId: string, output: DecoderOutput): void {
		this.broadcast("decoders", {
			type: "decoder:output",
			data: { decoderId, output },
		})
	}

	/**
	 * Broadcasts decoder started event.
	 *
	 * @param decoderId - The decoder that started
	 */
	broadcastDecoderStarted(decoderId: string): void {
		this.broadcast("decoders", {
			type: "decoder:started",
			data: { decoderId },
		})
	}

	/**
	 * Broadcasts decoder stopped event.
	 *
	 * @param decoderId - The decoder that stopped
	 */
	broadcastDecoderStopped(decoderId: string): void {
		this.broadcast("decoders", {
			type: "decoder:stopped",
			data: { decoderId },
		})
	}

	/**
	 * Broadcasts decoder error event.
	 *
	 * @param decoderId - The decoder that errored
	 * @param error - The error message
	 */
	broadcastDecoderError(decoderId: string, error: string): void {
		this.broadcast("decoders", {
			type: "decoder:error",
			data: { decoderId, error },
		})
	}

	/**
	 * Broadcasts decoder health state change event (Requirement 20.4).
	 *
	 * @param decoderId - The decoder whose health changed
	 * @param health - The new health state ('running', 'degraded', or 'faulted')
	 * @param previousHealth - The previous health state (optional)
	 */
	broadcastDecoderHealth(
		decoderId: string,
		health: string,
		previousHealth?: string,
	): void {
		this.broadcast("health", {
			type: "decoder:health",
			data: { decoderId, health, previousHealth },
		})
	}

	/**
	 * Broadcasts source connected event (Requirement 10.4).
	 *
	 * @param sourceId - The source that connected
	 */
	broadcastSourceConnected(sourceId: string): void {
		this.broadcast("sources", {
			type: "source:connected",
			data: { sourceId },
		})
	}

	/**
	 * Broadcasts source disconnected event (Requirement 10.4).
	 *
	 * @param sourceId - The source that disconnected
	 * @param error - Optional error message
	 */
	broadcastSourceDisconnected(sourceId: string, error?: string): void {
		this.broadcast("sources", {
			type: "source:disconnected",
			data: { sourceId, error },
		})
	}

	/**
	 * Broadcasts source error event.
	 *
	 * @param sourceId - The source that errored
	 * @param error - The error message
	 */
	broadcastSourceError(sourceId: string, error: string): void {
		this.broadcast("sources", {
			type: "source:error",
			data: { sourceId, error },
		})
	}

	/**
	 * Broadcasts metrics event (Requirement 10.5).
	 *
	 * @param sourceId - The source the metrics are for
	 * @param metrics - The metrics data
	 */
	broadcastMetrics(
		sourceId: string,
		metrics: { bytesReceived: number; dataRate: number },
	): void {
		this.broadcast("metrics", {
			type: "metrics",
			data: { sourceId, ...metrics },
		})
	}

	/**
	 * Returns the number of connected clients.
	 */
	getConnectedClients(): number {
		return this.clients.size
	}

	/**
	 * Returns the number of clients subscribed to a specific channel.
	 */
	getSubscribersCount(channel: WebSocketChannel): number {
		let count = 0
		for (const client of this.clients.values()) {
			if (client.subscriptions.has(channel)) {
				count++
			}
		}
		return count
	}

	/**
	 * Closes all client connections.
	 */
	closeAll(): void {
		for (const client of this.clients.values()) {
			try {
				client.socket.close(1000, "Server shutting down")
			} catch {
				// Ignore errors during shutdown
			}
		}
		this.clients.clear()
		this.log.info("All WebSocket connections closed")
	}
}
