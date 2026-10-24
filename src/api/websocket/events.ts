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

import type { FastifyAccessController } from "../../access/fastify-adapter.js"
import type { FastifyInstance } from "fastify"
import type { WebSocket } from "ws"
import type {
	ActivityClientTransport,
	ActivitySubscriptionHub,
	ActivityWireMessage,
} from "../activity-subscriptions.js"
import type { Logger } from "../../utils/logger.js"
import { createComponentLogger } from "../../utils/logger.js"
import type { DecoderOutput } from "../../decoders/types.js"
import type { FanoutStatus } from "../../core/fanout-manager.js"
import type {
	LiveAudioLevel,
	LiveDemodConfig,
	LiveDemodStatus,
} from "../../core/live-demodulator.js"
import type {
	ResourceSnapshot,
	SourceLinkQuality,
	ResourceAlert,
	TunerState,
	TunerControlMode,
	AircraftState,
	AircraftTrackerStats,
	DecoderStatusEventData,
	SourceStatusEventData,
	SourceRemovedEventData,
	DigitalVoiceCallEventData,
	DigitalVoiceStatus,
	ScanJob,
	DecoderCreatedEventData,
	DecoderRemovedEventData,
	TunerCommandOrigin,
	OperatorDataReadDto,
	BandPlansServerMessage,
	VesselServerMessage,
	VesselState,
	VesselTrackerStats,
	AnalogTransmissionEventData,
	AprsServerMessage,
	AprsStation,
	AprsTrackerStats,
	MeshServerMessage,
	MeshNode,
	MeshTrackerStats,
} from "@wavekit/api-types"

/**
 * Supported WebSocket channels for subscription.
 * - decoders: Decoder output, started, stopped, error, status events
 * - metrics: Source metrics events
 * - sources: Source connected, disconnected, error, status, removed events
 * - health: Decoder health state change events (Requirement 20.4)
 * - fanout: Fanout backpressure telemetry (snapshots, backpressure, drain)
 * - live-audio: Live demodulation status and config events
 * - digital-voice: Digital voice stream status and per-call state
 * - resources: Container, SDR host, and source backpressure monitoring
 * - tuner: RTL-TCP tuner control events
 * - scanner: Signal discovery scanner jobs, progress, discoveries, activity, identify, status (rate-limited)
 * - spectrum: core waterfall frames, opt-in; `options.spectrum` on subscribe selects a source and profile
 * - bandplans: change notice `{storeId, revision}` after a changed commit and on subscribe; clients refetch
 * - vessels: AIS vessel current state (new, update, lost, stats), WG1
 * - aprs: APRS station, object and item current state (new, update, lost, stats), WG2
 * - mesh: Meshtastic node current state (new, update, lost, stats), WG2
 */
export type WebSocketChannel =
	| "decoders"
	| "metrics"
	| "sources"
	| "health"
	| "fanout"
	| "live-audio"
	| "digital-voice"
	| "resources"
	| "tuner"
	| "aircraft"
	| "scanner"
	| "spectrum"
	| "operator-data"
	| "bandplans"
	| "vessels"
	| "aprs"
	| "mesh"

/**
 * Message sent from client to server. `options` carries per-channel subscribe
 * options (e.g. `options.spectrum`); the channel's observer validates them.
 */
export interface ClientMessage {
	type: "subscribe" | "unsubscribe"
	channels: WebSocketChannel[]
	options?: Partial<Record<WebSocketChannel, unknown>>
}

/**
 * A channel's subscription lifecycle (one observer per channel): `subscribed` on
 * every subscribe that names the channel (with its options), `unsubscribed` once
 * when a client that had the channel unsubscribes, disconnects or is terminated.
 */
export interface ChannelObserver {
	subscribed(clientId: string, options: unknown): void
	unsubscribed(clientId: string): void
}

/**
 * Message sent from server to client.
 */
interface ExistingServerMessage {
	type:
		| "decoder:output"
		| "decoder:started"
		| "decoder:stopped"
		| "decoder:error"
		| "decoder:health"
		| "decoder:status"
		| "source:connected"
		| "source:disconnected"
		| "source:error"
		| "source:caps-changed"
		| "source:status"
		| "source:removed"
		| "metrics"
		| "fanout:snapshot"
		| "fanout:backpressure"
		| "fanout:drain"
		| "live-audio:status"
		| "live-audio:level"
		| "live-audio:config"
		| "live-audio:started"
		| "live-audio:stopped"
		| "live-audio:error"
		| "live-audio:transmission"
		| "digital-voice:call"
		| "digital-voice:status"
		| "resources:snapshot"
		| "resources:alert"
		| "resources:link-quality"
		| "tuner:state-changed"
		| "tuner:command-sent"
		| "tuner:control-mode-changed"
		| "tuner:error"
		| "tuner:rate-policy"
		| "aircraft:new"
		| "aircraft:update"
		| "aircraft:lost"
		| "aircraft:stats"
		| "scanner:job"
		| "scanner:progress"
		| "scanner:discovery"
		| "scanner:activity"
		| "scanner:monitor"
		| "scanner:identify"
		| "scanner:status"
		| "spectrum:frame"
		| "spectrum:profile"
		| "decoder:created"
		| "decoder:removed"
		| "subscribed"
		| "unsubscribed"
		| "error"
	channel?: WebSocketChannel
	data: unknown
}

/** Operator metadata preserves the canonical DTO and three-field wire envelope. */
interface OperatorDataServerMessage {
	type: "operator-data:snapshot" | "operator-data:updated"
	channel: "operator-data"
	data: OperatorDataReadDto
}

export type ServerMessage =
	| ExistingServerMessage
	| OperatorDataServerMessage
	| BandPlansServerMessage
	| VesselServerMessage
	| AprsServerMessage
	| MeshServerMessage

/**
 * Internal client state tracking subscriptions.
 */
interface ClientState {
	socket: WebSocket
	subscriptions: Set<WebSocketChannel>
	id: string
	current?: () => boolean
}

interface DeliveryState {
	queue: Array<{ data: string; bytes: number }>
	queuedBytes: number
	alive: boolean
	lastPing: number
}

const MAX_OUTBOUND_BYTES = 1024 * 1024
const MAX_QUEUED_MESSAGES = 256
const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Validates if a value is a valid WebSocket channel.
 */
function isValidChannel(channel: unknown): channel is WebSocketChannel {
	return (
		channel === "decoders" ||
		channel === "metrics" ||
		channel === "sources" ||
		channel === "health" ||
		channel === "fanout" ||
		channel === "live-audio" ||
		channel === "digital-voice" ||
		channel === "resources" ||
		channel === "tuner" ||
		channel === "aircraft" ||
		channel === "scanner" ||
		channel === "spectrum" ||
		channel === "operator-data" ||
		channel === "bandplans" ||
		channel === "vessels" ||
		channel === "aprs" ||
		channel === "mesh"
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

	const options = msg["options"]
	return {
		type: msg["type"] as "subscribe" | "unsubscribe",
		channels: validChannels,
		...(typeof options === "object" &&
		options !== null &&
		!Array.isArray(options)
			? { options: options as Partial<Record<WebSocketChannel, unknown>> }
			: {}),
	}
}

function isActivityClientMessage(data: unknown): boolean {
	if (typeof data !== "object" || data === null) return false
	const type = (data as { type?: unknown }).type
	return type === "activity:subscribe" || type === "activity:unsubscribe"
}

/** Live-audio clients never receive the native demod binary path. */
function liveAudioConfigForClient(config: LiveDemodConfig): LiveDemodConfig {
	const client = { ...config }
	delete client.chanBinaryPath
	return client
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
	private readonly delivery = new WeakMap<ClientState, DeliveryState>()
	private maintenanceTimer: ReturnType<typeof setInterval> | undefined
	private readonly observers = new Map<WebSocketChannel, ChannelObserver>()
	private operatorDataEnabled = false
	private subscriptionAdmissionStopped = false
	private activityHub: ActivitySubscriptionHub | undefined

	constructor(logger: Logger) {
		this.log = createComponentLogger(logger, "WebSocketBroadcaster")
	}

	/**
	 * Activity frames use their own queue. The transport key is the client id.
	 * Outbound messages bypass the replaceable-telemetry queue.
	 */
	attachActivity(hub: ActivitySubscriptionHub): void {
		this.activityHub = hub
	}

	/**
	 * Registers the WebSocket route with Fastify.
	 * Call this after registering the fastify-websocket plugin.
	 *
	 * @param fastify - Fastify instance with websocket plugin registered
	 */
	registerRoute(
		fastify: FastifyInstance,
		access?: FastifyAccessController,
	): void {
		fastify.get("/ws", { websocket: true }, (socket, request) => {
			if (access && !access.adoptWebSocket(request, socket)) return
			this.handleConnection(
				socket,
				access ? () => access.isWebSocketCurrent(request, socket) : undefined,
			)
		})

		this.log.info("WebSocket route registered at /ws")
	}

	/**
	 * Handles a new WebSocket connection (Requirement 10.1).
	 */
	private handleConnection(socket: WebSocket, current?: () => boolean): void {
		const clientId = `client-${++this.clientIdCounter}`

		const clientState: ClientState = {
			socket,
			subscriptions: new Set(),
			id: clientId,
			...(current ? { current } : {}),
		}

		this.clients.set(clientId, clientState)
		socket.on("pong", () => {
			if (this.clients.get(clientId) === clientState)
				this.getDelivery(clientState).alive = true
		})

		this.log.info({ clientId }, "WebSocket client connected")

		// Handle incoming messages
		socket.on("message", (data: Buffer | string) => {
			this.handleMessage(clientState, data)
		})

		// ws does not always emit drain; maintainClients also resumes.
		socket.on("drain", () => {
			if (this.clients.get(clientId) !== clientState) return
			if ((socket.bufferedAmount ?? 0) !== 0) return
			this.activityHub?.resume(clientId)
		})

		// Handle client disconnect
		socket.on("close", (code: number, reason: Buffer) => {
			this.handleDisconnect(clientState, code, reason)
		})

		// Handle errors
		socket.on("error", () => {
			this.log.error({ clientId }, "WebSocket error")
			this.terminateClient(clientState)
		})
		if (!this.currentClient(clientState)) return
		this.getDelivery(clientState)
		if (!this.maintenanceTimer) {
			this.maintenanceTimer = setInterval(() => this.maintainClients(), 100)
			this.maintenanceTimer.unref()
		}
	}

	/**
	 * Handles incoming messages from a client.
	 */
	private handleMessage(client: ClientState, data: Buffer | string): void {
		if (!this.currentClient(client)) return
		try {
			const rawData = typeof data === "string" ? data : data.toString("utf-8")

			const parsed = JSON.parse(rawData) as unknown
			if (isActivityClientMessage(parsed)) {
				this.handleActivityMessage(client, parsed)
				return
			}
			const message = parseClientMessage(parsed)

			if (!message) {
				this.sendToClient(client, {
					type: "error",
					data: { message: "Invalid message format" },
				})
				return
			}

			if (message.type === "subscribe") {
				this.handleSubscribe(client, message.channels, message.options)
			} else {
				this.handleUnsubscribe(client, message.channels)
			}
		} catch {
			this.log.warn({ clientId: client.id }, "Failed to parse client message")
			this.sendToClient(client, {
				type: "error",
				data: { message: "Invalid JSON" },
			})
		}
	}

	/**
	 * Activity subscribe/unsubscribe never fall through to "Invalid message format".
	 * Frames go straight to the socket, not the telemetry queue.
	 */
	private handleActivityMessage(client: ClientState, parsed: unknown): void {
		if (!this.activityHub) {
			this.sendActivity(client, {
				type: "error",
				channel: "activity",
				data: {
					code: "ACTIVITY_DISABLED",
					message: "Activity is disabled",
				},
			})
			return
		}
		this.activityHub.handleMessage(this.activityTransport(client), parsed)
	}

	private activityTransport(client: ClientState): ActivityClientTransport {
		return {
			key: client.id,
			send: message => this.sendActivity(client, message),
			close: (code, reason) => {
				try {
					client.socket.close(code, reason)
				} catch {
					// The socket may already be closed.
				}
			},
		}
	}

	/** Direct send. False means the message was not accepted and stays queued. */
	private sendActivity(
		client: ClientState,
		message: ActivityWireMessage,
	): boolean {
		if (!this.currentClient(client) || client.socket.readyState !== 1)
			return false
		if ((client.socket.bufferedAmount ?? 0) !== 0) return false
		try {
			client.socket.send(JSON.stringify(message))
			return true
		} catch {
			return false
		}
	}

	/**
	 * Handles channel subscription (Requirement 10.2).
	 */
	private handleSubscribe(
		client: ClientState,
		channels: WebSocketChannel[],
		options?: Partial<Record<WebSocketChannel, unknown>>,
	): void {
		if (!this.currentClient(client) || this.subscriptionAdmissionStopped) return
		const activeChannels = channels.filter(
			channel => channel !== "operator-data" || this.operatorDataEnabled,
		)
		for (const channel of activeChannels) {
			client.subscriptions.add(channel)
		}

		this.log.info(
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
		for (const channel of new Set(activeChannels)) {
			// Ack or an earlier observer may synchronously invalidate this client.
			if (!this.currentClient(client)) return
			this.observers.get(channel)?.subscribed(client.id, options?.[channel])
		}
	}

	/**
	 * Handles channel unsubscription.
	 */
	private handleUnsubscribe(
		client: ClientState,
		channels: WebSocketChannel[],
	): void {
		const left = new Set<WebSocketChannel>()
		for (const channel of channels) {
			if (client.subscriptions.delete(channel)) left.add(channel)
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
		for (const channel of left)
			this.observers.get(channel)?.unsubscribed(client.id)
	}

	/**
	 * Handles client disconnect.
	 */
	private handleDisconnect(
		client: ClientState,
		code?: number,
		_reason?: Buffer,
	): void {
		// A late close after terminateClient or closeAll is a no-op (finding 7).
		if (!this.clients.has(client.id)) return
		this.clients.delete(client.id)
		try {
			this.activityHub?.detach(client.id)
		} catch (err) {
			this.log.error({ err, clientId: client.id }, "Activity detach failed")
		}
		const state = this.delivery.get(client)
		if (state) {
			state.queue = []
			state.queuedBytes = 0
		}
		this.delivery.delete(client)
		this.stopMaintenanceIfIdle()
		this.notifyUnsubscribed(client)
		this.log.info(
			{ clientId: client.id, code },
			"WebSocket client disconnected",
		)
	}

	/**
	 * Sends a message to a specific client.
	 */
	private sendToClient(client: ClientState, message: ServerMessage): void {
		this.enqueue(client, JSON.stringify(message))
	}

	private getDelivery(client: ClientState): DeliveryState {
		let state = this.delivery.get(client)
		if (!state) {
			state = { queue: [], queuedBytes: 0, alive: true, lastPing: Date.now() }
			this.delivery.set(client, state)
		}
		return state
	}

	private currentClient(client: ClientState): boolean {
		if (this.clients.get(client.id) !== client) return false
		try {
			if (client.current && !client.current()) {
				this.terminateClient(client)
				return false
			}
		} catch {
			this.terminateClient(client)
			return false
		}
		// current() may synchronously invoke reservation/socket cleanup.
		return this.clients.get(client.id) === client
	}

	private enqueue(client: ClientState, data: string): boolean {
		if (!this.currentClient(client) || client.socket.readyState !== 1)
			return false
		const state = this.getDelivery(client)
		const bytes = Buffer.byteLength(data)
		if (
			state.queue.length >= MAX_QUEUED_MESSAGES ||
			state.queuedBytes + (client.socket.bufferedAmount ?? 0) + bytes >
				MAX_OUTBOUND_BYTES
		) {
			this.log.warn(
				{ clientId: client.id },
				"WebSocket outbound limit exceeded",
			)
			this.terminateClient(client)
			return false
		}
		state.queue.push({ data, bytes })
		state.queuedBytes += bytes
		this.flushClient(client, state)
		return this.clients.has(client.id)
	}

	private flushClient(client: ClientState, state: DeliveryState): void {
		// Check authority even while blocked: invalidation discards queued output.
		if (!this.currentClient(client)) return
		while (state.queue.length) {
			if (!this.currentClient(client) || client.socket.readyState !== 1) return
			// Wait for ws to drain before handing it another application message.
			if ((client.socket.bufferedAmount ?? 0) !== 0) return
			const message = state.queue.shift()!
			state.queuedBytes -= message.bytes
			try {
				client.socket.send(message.data, err => {
					if (err) {
						this.log.error({ clientId: client.id }, "WebSocket send failed")
						this.terminateClient(client)
					}
				})
			} catch {
				this.log.error({ clientId: client.id }, "WebSocket send failed")
				this.terminateClient(client)
				return
			}
		}
	}

	private maintainClients(): void {
		for (const client of this.clients.values()) {
			if (!this.currentClient(client)) continue
			if (client.socket.readyState !== 1) {
				this.terminateClient(client)
				continue
			}
			const state = this.getDelivery(client)
			this.flushClient(client, state)
			if ((client.socket.bufferedAmount ?? 0) === 0)
				this.activityHub?.resume(client.id)
			if (
				!this.clients.has(client.id) ||
				Date.now() - state.lastPing < HEARTBEAT_INTERVAL_MS
			)
				continue
			if (!state.alive) {
				this.terminateClient(client)
				continue
			}
			state.alive = false
			state.lastPing = Date.now()
			try {
				client.socket.ping(undefined, undefined, err => {
					if (err) this.terminateClient(client)
				})
			} catch {
				this.terminateClient(client)
			}
		}
	}

	private terminateClient(client: ClientState): void {
		if (!this.clients.has(client.id)) return
		this.handleDisconnect(client)
		try {
			client.socket.terminate()
		} catch {
			this.log.warn({ clientId: client.id }, "WebSocket termination failed")
		}
	}

	private stopMaintenanceIfIdle(): void {
		if (this.clients.size === 0 && this.maintenanceTimer) {
			clearInterval(this.maintenanceTimer)
			this.maintenanceTimer = undefined
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
			if (client.subscriptions.has(channel)) {
				if (this.enqueue(client, serialized)) sentCount++
			}
		}

		this.log.trace(
			{ channel, type: message.type, sentCount },
			"Broadcast message",
		)
	}

	/**
	 * Room left in one client's outbound queue before it would be disconnected
	 * (queued plus socket-buffered bytes against the 1 MiB cap, and messages
	 * against the 256-message cap). Null for an unknown or closed client.
	 */
	outboundHeadroom(
		clientId: string,
	): { bytes: number; messages: number } | null {
		const client = this.clients.get(clientId)
		if (!client || client.socket.readyState !== 1) return null
		const state = this.getDelivery(client)
		return {
			bytes: Math.max(
				0,
				MAX_OUTBOUND_BYTES -
					state.queuedBytes -
					(client.socket.bufferedAmount ?? 0),
			),
			messages: Math.max(0, MAX_QUEUED_MESSAGES - state.queue.length),
		}
	}

	/**
	 * Sends one message to the listed clients that are subscribed to `channel`
	 * (same filter as broadcast), serialising it once. Returns the clients reached.
	 */
	sendToClients(
		channel: WebSocketChannel,
		clientIds: Iterable<string>,
		message: ServerMessage,
	): number {
		const serialized = JSON.stringify({ ...message, channel })
		let sent = 0
		for (const id of clientIds) {
			const client = this.clients.get(id)
			if (
				client?.subscriptions.has(channel) &&
				this.enqueue(client, serialized)
			)
				sent++
		}
		return sent
	}

	/** Observes one channel's subscriptions (one observer per channel); returns the unobserve function. */
	observeChannel(
		channel: WebSocketChannel,
		observer: ChannelObserver,
	): () => void {
		this.observers.set(channel, observer)
		return () => {
			if (this.observers.get(channel) === observer)
				this.observers.delete(channel)
		}
	}

	private notifyUnsubscribed(client: ClientState): void {
		const channels = [...client.subscriptions]
		client.subscriptions.clear()
		for (const channel of channels) {
			try {
				this.observers.get(channel)?.unsubscribed(client.id)
			} catch {
				this.log.warn(
					{ clientId: client.id },
					"WebSocket observer cleanup failed",
				)
			}
		}
	}

	/** Called only by the protected operator mount before listener startup. */
	enableOperatorDataChannel(): void {
		this.operatorDataEnabled = true
	}

	/** Seal new subscriptions while current output remains live during drain. */
	stopSubscriptionAdmission(): void {
		this.subscriptionAdmissionStopped = true
	}

	invalidateClient(clientId: string): void {
		const client = this.clients.get(clientId)
		if (client) this.terminateClient(client)
	}

	invalidateChannelClients(channel: WebSocketChannel): void {
		for (const client of [...this.clients.values()]) {
			if (client.subscriptions.has(channel)) this.terminateClient(client)
		}
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
	 * Broadcasts a decoder's full status on lifecycle changes; the payload is
	 * identical to GET /api/decoders/:id.
	 */
	broadcastDecoderStatus(status: DecoderStatusEventData): void {
		this.broadcast("decoders", {
			type: "decoder:status",
			data: status,
		})
	}

	/**
	 * Broadcasts a source's full status; the payload is identical to a
	 * GET /api/sources item, including `activity`.
	 */
	broadcastSourceStatus(status: SourceStatusEventData): void {
		this.broadcast("sources", {
			type: "source:status",
			data: status,
		})
	}

	/**
	 * Broadcasts that a source was removed. Sent once per removal; clients drop
	 * the row and any cached `source:status`.
	 *
	 * @param sourceId - The source that was removed
	 * @param removedAt - Removal time (defaults to now)
	 */
	broadcastSourceRemoved(sourceId: string, removedAt: Date = new Date()): void {
		const data: SourceRemovedEventData = {
			sourceId,
			removedAt: removedAt.toISOString(),
		}
		this.broadcast("sources", { type: "source:removed", data })
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
	 * Broadcasts fanout telemetry snapshot (periodic).
	 *
	 * @param snapshot - Complete fanout status snapshot
	 */
	broadcastFanoutSnapshot(snapshot: FanoutStatus): void {
		this.broadcast("fanout", {
			type: "fanout:snapshot",
			data: snapshot,
		})
	}

	/**
	 * Broadcasts fanout backpressure event (edge-triggered on entry).
	 *
	 * @param branchId - The branch that entered backpressure
	 * @param bufferedBytes - Current buffer usage when backpressure triggered
	 */
	broadcastFanoutBackpressure(branchId: string, bufferedBytes: number): void {
		this.broadcast("fanout", {
			type: "fanout:backpressure",
			data: {
				branchId,
				bufferedBytes,
				timestamp: new Date().toISOString(),
			},
		})
	}

	/**
	 * Broadcasts fanout drain event (edge-triggered on exit).
	 *
	 * @param branchId - The branch that drained
	 * @param durationMs - How long the branch was in backpressure state
	 */
	broadcastFanoutDrain(branchId: string, durationMs: number): void {
		this.broadcast("fanout", {
			type: "fanout:drain",
			data: {
				branchId,
				durationMs,
				timestamp: new Date().toISOString(),
			},
		})
	}

	/**
	 * Broadcasts live audio status to subscribed clients.
	 */
	broadcastLiveAudioStatus(status: LiveDemodStatus): void {
		this.broadcast("live-audio", {
			type: "live-audio:status",
			data: {
				...status,
				config: liveAudioConfigForClient(status.config),
			},
		})
	}

	/**
	 * Broadcasts the live audio meter (10–20 Hz while running). The level passes through
	 * unchanged, including `autoSquelch` (`{ state, evidence? }`, evidence squelch
	 * requirement 4.1: stage 2 of auto squelch; `squelchOpen` stays stage 1).
	 */
	broadcastLiveAudioLevel(level: LiveAudioLevel): void {
		this.broadcast("live-audio", {
			type: "live-audio:level",
			data: level,
		})
	}

	/**
	 * Broadcasts one squelch-delimited analog transmission edge (open, then
	 * close) on the live-audio channel (WG1 req 3.2).
	 */
	broadcastLiveAudioTransmission(event: AnalogTransmissionEventData): void {
		this.broadcast("live-audio", {
			type: "live-audio:transmission",
			data: event,
		})
	}

	/**
	 * Broadcasts digital voice call state (start, encryption change, end).
	 */
	broadcastDigitalVoiceCall(call: DigitalVoiceCallEventData): void {
		this.broadcast("digital-voice", {
			type: "digital-voice:call",
			data: call,
		})
	}

	/**
	 * Broadcasts digital voice stream status (same body as GET /api/digital-voice/status).
	 */
	broadcastDigitalVoiceStatus(status: DigitalVoiceStatus): void {
		this.broadcast("digital-voice", {
			type: "digital-voice:status",
			data: status,
		})
	}

	/**
	 * Broadcasts live audio config to subscribed clients.
	 */
	broadcastLiveAudioConfig(config: LiveDemodConfig): void {
		this.broadcast("live-audio", {
			type: "live-audio:config",
			data: liveAudioConfigForClient(config),
		})
	}

	/** Broadcasts per-source link-quality reports to subscribed clients. */
	broadcastLinkQuality(reports: SourceLinkQuality[]): void {
		this.broadcast("resources", {
			type: "resources:link-quality",
			data: reports,
		})
	}

	/**
	 * Broadcasts resource snapshot to subscribed clients.
	 *
	 * @param snapshot - Complete resource monitoring snapshot
	 */
	broadcastResourceSnapshot(snapshot: ResourceSnapshot): void {
		this.broadcast("resources", {
			type: "resources:snapshot",
			data: snapshot,
		})
	}

	/**
	 * Broadcasts resource alert to subscribed clients.
	 *
	 * @param alert - Resource alert (high drops, OOM, etc.)
	 */
	broadcastResourceAlert(alert: ResourceAlert): void {
		this.broadcast("resources", {
			type: "resources:alert",
			data: alert,
		})
	}

	/**
	 * Broadcasts tuner state changes to subscribed clients.
	 */
	broadcastTunerStateChanged(sourceId: string, state: TunerState): void {
		this.broadcast("tuner", {
			type: "tuner:state-changed",
			channel: "tuner",
			data: { sourceId, state },
		})
	}

	/**
	 * Broadcasts tuner command events to subscribed clients. `origin` (Task 27) tells
	 * clients who sent the command (`scanner`, `rest`, …); omitted when unknown.
	 */
	broadcastTunerCommandSent(
		sourceId: string,
		command: string,
		value: number,
		origin?: TunerCommandOrigin,
	): void {
		this.broadcast("tuner", {
			type: "tuner:command-sent",
			channel: "tuner",
			data: { sourceId, command, value, ...(origin ? { origin } : {}) },
		})
	}

	/**
	 * Broadcasts tuner control mode changes to subscribed clients.
	 */
	broadcastTunerControlModeChanged(
		sourceId: string,
		mode: TunerControlMode,
	): void {
		this.broadcast("tuner", {
			type: "tuner:control-mode-changed",
			channel: "tuner",
			data: { sourceId, mode },
		})
	}

	/**
	 * Broadcasts tuner errors to subscribed clients.
	 */
	broadcastTunerError(sourceId: string, error: string): void {
		this.broadcast("tuner", {
			type: "tuner:error",
			channel: "tuner",
			data: { sourceId, error },
		})
	}

	// ========================================================================
	// Aircraft Events (ADS-B specific)
	// ========================================================================

	/**
	 * Broadcasts new aircraft event to subscribed clients.
	 *
	 * @param aircraft - The new aircraft state
	 */
	broadcastAircraftNew(aircraft: AircraftState): void {
		this.broadcast("aircraft", {
			type: "aircraft:new",
			data: aircraft,
		})
	}

	/**
	 * Broadcasts aircraft update event to subscribed clients.
	 *
	 * @param aircraft - The updated aircraft state
	 */
	broadcastAircraftUpdate(aircraft: AircraftState): void {
		this.broadcast("aircraft", {
			type: "aircraft:update",
			data: aircraft,
		})
	}

	/**
	 * Broadcasts aircraft lost event to subscribed clients.
	 *
	 * @param icao - The ICAO address of the lost aircraft
	 * @param aircraft - The final aircraft state before loss
	 */
	broadcastAircraftLost(icao: string, aircraft: AircraftState): void {
		this.broadcast("aircraft", {
			type: "aircraft:lost",
			data: { icao, aircraft },
		})
	}

	/**
	 * Broadcasts aircraft tracker statistics to subscribed clients.
	 *
	 * @param stats - The tracker statistics
	 */
	broadcastAircraftStats(stats: AircraftTrackerStats): void {
		this.broadcast("aircraft", {
			type: "aircraft:stats",
			data: stats,
		})
	}

	/** A vessel heard for the first time (WG1 req 6.4). */
	broadcastVesselNew(vessel: VesselState): void {
		this.broadcast("vessels", {
			type: "vessel:new",
			channel: "vessels",
			data: vessel,
		})
	}

	/** A known vessel's merged state changed. */
	broadcastVesselUpdate(vessel: VesselState): void {
		this.broadcast("vessels", {
			type: "vessel:update",
			channel: "vessels",
			data: vessel,
		})
	}

	/** A vessel expired or was evicted at the cap, with its final state. */
	broadcastVesselLost(mmsi: string, vessel: VesselState): void {
		this.broadcast("vessels", {
			type: "vessel:lost",
			channel: "vessels",
			data: { mmsi, vessel },
		})
	}

	/** Periodic vessel tracker statistics. */
	broadcastVesselStats(stats: VesselTrackerStats): void {
		this.broadcast("vessels", {
			type: "vessel:stats",
			channel: "vessels",
			data: stats,
		})
	}

	/** WG2: a new APRS station, object or item. */
	broadcastAprsNew(station: AprsStation): void {
		this.broadcast("aprs", { type: "aprs:new", channel: "aprs", data: station })
	}

	/** WG2: a known APRS entity changed (Main puts it through the update throttle). */
	broadcastAprsUpdate(station: AprsStation): void {
		this.broadcast("aprs", {
			type: "aprs:update",
			channel: "aprs",
			data: station,
		})
	}

	/** WG2: an APRS entity expired, was evicted or killed, with its final state. */
	broadcastAprsLost(key: string, station: AprsStation): void {
		this.broadcast("aprs", {
			type: "aprs:lost",
			channel: "aprs",
			data: { key, station },
		})
	}

	/** WG2: periodic APRS tracker statistics. */
	broadcastAprsStats(stats: AprsTrackerStats): void {
		this.broadcast("aprs", { type: "aprs:stats", channel: "aprs", data: stats })
	}

	/** WG2: a new Meshtastic node. */
	broadcastMeshNew(node: MeshNode): void {
		this.broadcast("mesh", { type: "mesh:new", channel: "mesh", data: node })
	}

	/** WG2: a known node changed (Main puts it through the update throttle). */
	broadcastMeshUpdate(node: MeshNode): void {
		this.broadcast("mesh", { type: "mesh:update", channel: "mesh", data: node })
	}

	/** WG2: a node expired or was evicted, with its final state. */
	broadcastMeshLost(nodeId: string, node: MeshNode): void {
		this.broadcast("mesh", {
			type: "mesh:lost",
			channel: "mesh",
			data: { nodeId, node },
		})
	}

	/** WG2: periodic mesh tracker statistics. */
	broadcastMeshStats(stats: MeshTrackerStats): void {
		this.broadcast("mesh", { type: "mesh:stats", channel: "mesh", data: stats })
	}

	/** Full job DTO on the scanner channel (the server normally goes through the WS limiter). */
	broadcastScannerJob(job: ScanJob): void {
		this.broadcast("scanner", { type: "scanner:job", data: job })
	}

	/** A decoder appeared at runtime (scanner probes, spec § 6.5). */
	broadcastDecoderCreated(data: DecoderCreatedEventData): void {
		this.broadcast("decoders", { type: "decoder:created", data })
	}

	/** A runtime decoder is gone. */
	broadcastDecoderRemoved(data: DecoderRemovedEventData): void {
		this.broadcast("decoders", { type: "decoder:removed", data })
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
		try {
			this.activityHub?.close()
		} catch (err) {
			this.log.error({ err }, "Activity subscriptions close failed")
		}
		const clients = [...this.clients.values()]
		for (const client of clients) this.handleDisconnect(client)
		for (const client of clients) {
			try {
				client.socket.close(1000, "Server shutting down")
			} catch {
				// Ignore errors during shutdown
			}
		}
		this.log.info("All WebSocket connections closed")
	}
}
