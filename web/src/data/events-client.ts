/**
 * The core's `/ws` channel socket: subscribe with options, typed dispatch per message type,
 * reconnect with exponential backoff (capped at 10 s), resubscribe after a reconnect and a
 * `reconnected` signal so stores refetch REST (the core replays nothing). Activity feeds
 * (`activity:subscribe`) resume from their last cursor.
 */
import type {
	ActivityQuery,
	ActivityRecordsMessage,
	ActivityProgressMessage,
	ActivityResetMessage,
	AnalogTransmissionEventData,
	BandPlansChangedEventData,
	DecoderCreatedEventData,
	DecoderOutputMessage,
	DecoderRemovedEventData,
	DecoderStatusEventData,
	LiveAudioConfig,
	LiveAudioLevel,
	LiveAudioStatus,
	ScanJob,
	ScannerIdentifyEventData,
	SourceRemovedEventData,
	SourceStatusEventData,
	SpectrumFrameEventData,
	SpectrumProfileEventData,
	SpectrumSubscribeOptions,
	TunerCommandSentEventData,
	TunerControlMode,
	TunerState,
} from "@wavekit/api-types"

export type EventChannel =
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

/** `data` of each server message type the web app handles. */
export interface EventMap {
	subscribed: { channels: EventChannel[] }
	unsubscribed: { channels: EventChannel[] }
	error: { message: string; code?: string; id?: string }
	"source:status": SourceStatusEventData
	"source:removed": SourceRemovedEventData
	"source:connected": { sourceId: string }
	"source:disconnected": { sourceId: string; error?: string }
	"source:error": { sourceId: string; error: string }
	"decoder:output": DecoderOutputMessage
	"decoder:status": DecoderStatusEventData
	"decoder:created": DecoderCreatedEventData
	"decoder:removed": DecoderRemovedEventData
	"decoder:started": { decoderId: string }
	"decoder:stopped": { decoderId: string }
	"decoder:error": { decoderId: string; error: string }
	"tuner:state-changed": { sourceId: string; state: TunerState }
	"tuner:command-sent": TunerCommandSentEventData
	"tuner:control-mode-changed": { sourceId: string; mode: TunerControlMode }
	"tuner:error": { sourceId: string; error: string }
	"live-audio:status": LiveAudioStatus
	"live-audio:config": LiveAudioConfig
	"live-audio:level": LiveAudioLevel
	"live-audio:started": unknown
	"live-audio:stopped": unknown
	"live-audio:error": unknown
	"live-audio:transmission": AnalogTransmissionEventData
	"scanner:job": ScanJob
	"scanner:identify": ScannerIdentifyEventData
	"spectrum:profile": SpectrumProfileEventData
	"spectrum:frame": SpectrumFrameEventData
	"bandplans:changed": BandPlansChangedEventData
	"activity:subscribed": { id: string }
	"activity:unsubscribed": { id: string }
	"activity:records": ActivityRecordsMessage["data"]
	"activity:progress": ActivityProgressMessage["data"]
	"activity:reset": ActivityResetMessage["data"]
	"activity:closed": {
		reason: "resumable"
		cursors: Readonly<Record<string, string>>
	}
}

export type EventType = keyof EventMap

export interface ServerEnvelope {
	type: string
	channel?: string
	data: unknown
}

export type EventHandler<K extends EventType> = (
	data: EventMap[K],
	envelope: ServerEnvelope,
) => void

export interface SubscribeOptions {
	spectrum?: SpectrumSubscribeOptions
}

export type ConnectionState = "idle" | "connecting" | "open" | "closed"

/** The subset of the browser WebSocket the client uses (injectable for tests). */
export interface SocketLike {
	readonly readyState: number
	onopen: ((event: unknown) => void) | null
	onclose: ((event: unknown) => void) | null
	onerror: ((event: unknown) => void) | null
	onmessage: ((event: { data: unknown }) => void) | null
	send(data: string): void
	close(code?: number, reason?: string): void
}

export type SocketFactory = (url: string) => SocketLike

export interface EventsClientOptions {
	/** Default: ws(s)://<location.host>/ws. */
	url?: string
	/** Default: the global WebSocket. */
	createSocket?: SocketFactory
	/** First retry delay; doubles per failure up to maxDelayMs. */
	baseDelayMs?: number
	maxDelayMs?: number
	/** 0..1 jitter source; default Math.random. */
	random?: () => number
}

interface ActivityFeed {
	query: ActivityQuery
	cursor: string | undefined
}

const OPEN = 1

export function defaultWsUrl(): string {
	const loc = (globalThis as { location?: { protocol: string; host: string } })
		.location
	if (!loc) return "ws://127.0.0.1:3101/ws"
	return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/ws`
}

/** Backoff for the n-th consecutive failure (0-based): base·2ⁿ with ±10 % jitter, capped. */
export function backoffDelay(
	attempt: number,
	baseMs: number,
	maxMs: number,
	random: () => number,
): number {
	const raw = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 20))
	return Math.min(maxMs, Math.round(raw * (0.9 + random() * 0.2)))
}

export class EventsClient {
	private readonly url: string
	private readonly createSocket: SocketFactory
	private readonly baseDelayMs: number
	private readonly maxDelayMs: number
	private readonly random: () => number
	private socket: SocketLike | null = null
	private stateValue: ConnectionState = "idle"
	private attempt = 0
	private everOpened = false
	private retryTimer: ReturnType<typeof setTimeout> | null = null
	private wanted = false
	private readonly channelRefs = new Map<EventChannel, number>()
	private readonly channelOptions: SubscribeOptions = {}
	private readonly handlers = new Map<
		string,
		Set<(data: unknown, envelope: ServerEnvelope) => void>
	>()
	private readonly anyHandlers = new Set<(envelope: ServerEnvelope) => void>()
	private readonly stateHandlers = new Set<(state: ConnectionState) => void>()
	private readonly reconnectHandlers = new Set<() => void>()
	private readonly feeds = new Map<string, ActivityFeed>()

	constructor(options: EventsClientOptions = {}) {
		this.url = options.url ?? defaultWsUrl()
		this.createSocket =
			options.createSocket ??
			(url =>
				new (
					globalThis as unknown as {
						WebSocket: new (url: string) => SocketLike
					}
				).WebSocket(url))
		this.baseDelayMs = options.baseDelayMs ?? 500
		this.maxDelayMs = options.maxDelayMs ?? 10_000
		this.random = options.random ?? Math.random
	}

	get state(): ConnectionState {
		return this.stateValue
	}

	/** Channels with at least one subscriber. */
	get channels(): EventChannel[] {
		return [...this.channelRefs.keys()]
	}

	connect(): void {
		this.wanted = true
		if (this.socket || this.retryTimer) return
		this.open()
	}

	/** Closes the socket and stops reconnecting; subscriptions are kept for a later connect(). */
	disconnect(): void {
		this.wanted = false
		if (this.retryTimer) clearTimeout(this.retryTimer)
		this.retryTimer = null
		const socket = this.socket
		this.socket = null
		if (socket) {
			socket.onopen = null
			socket.onclose = null
			socket.onerror = null
			socket.onmessage = null
			try {
				socket.close(1000, "client closed")
			} catch {
				// already closed
			}
		}
		this.setState("closed")
	}

	/**
	 * Subscribes to channels (reference counted). Options replace the channel's previous options
	 * and are resent on reconnect. Returns the matching unsubscribe.
	 */
	subscribe(
		channels: readonly EventChannel[],
		options: SubscribeOptions = {},
	): () => void {
		const unique = [...new Set(channels)]
		for (const c of unique)
			this.channelRefs.set(c, (this.channelRefs.get(c) ?? 0) + 1)
		if (options.spectrum) this.channelOptions.spectrum = options.spectrum
		this.sendSubscribe(unique, options)
		let done = false
		return () => {
			if (done) return
			done = true
			const left: EventChannel[] = []
			for (const c of unique) {
				const n = (this.channelRefs.get(c) ?? 0) - 1
				if (n > 0) this.channelRefs.set(c, n)
				else {
					this.channelRefs.delete(c)
					left.push(c)
					if (c === "spectrum") delete this.channelOptions.spectrum
				}
			}
			if (left.length > 0)
				this.sendJson({ type: "unsubscribe", channels: left })
		}
	}

	/** Changes the spectrum selection of a live `spectrum` subscription (resubscribes with the options). */
	setSpectrumOptions(options: SpectrumSubscribeOptions): void {
		this.channelOptions.spectrum = options
		if (this.channelRefs.has("spectrum"))
			this.sendSubscribe(["spectrum"], { spectrum: options })
	}

	/** Starts (or restarts) an activity feed; resumes from its last cursor after a reconnect. */
	subscribeActivity(
		id: string,
		query: ActivityQuery,
		cursor?: string,
	): () => void {
		this.feeds.set(id, { query, cursor })
		this.sendActivitySubscribe(id)
		return () => {
			if (!this.feeds.delete(id)) return
			this.sendJson({ type: "activity:unsubscribe", id })
		}
	}

	on<K extends EventType>(type: K, handler: EventHandler<K>): () => void {
		let set = this.handlers.get(type)
		if (!set) {
			set = new Set()
			this.handlers.set(type, set)
		}
		const wrapped = handler as (data: unknown, envelope: ServerEnvelope) => void
		set.add(wrapped)
		return () => {
			set.delete(wrapped)
		}
	}

	/** Every server message, before the typed handlers. */
	onAny(handler: (envelope: ServerEnvelope) => void): () => void {
		this.anyHandlers.add(handler)
		return () => {
			this.anyHandlers.delete(handler)
		}
	}

	onState(handler: (state: ConnectionState) => void): () => void {
		this.stateHandlers.add(handler)
		return () => {
			this.stateHandlers.delete(handler)
		}
	}

	/** Fires after a reconnect has resubscribed; refetch REST state here. */
	onReconnected(handler: () => void): () => void {
		this.reconnectHandlers.add(handler)
		return () => {
			this.reconnectHandlers.delete(handler)
		}
	}

	private open(): void {
		this.setState("connecting")
		let socket: SocketLike
		try {
			socket = this.createSocket(this.url)
		} catch {
			this.scheduleRetry()
			return
		}
		this.socket = socket
		socket.onopen = () => {
			if (this.socket !== socket) return
			const reconnect = this.everOpened
			this.everOpened = true
			this.attempt = 0
			this.setState("open")
			this.resubscribe()
			if (reconnect) for (const h of [...this.reconnectHandlers]) safely(h)
		}
		socket.onmessage = event => {
			if (this.socket !== socket) return
			this.dispatch(event.data)
		}
		socket.onerror = () => {
			// close follows; the retry is scheduled there.
		}
		socket.onclose = () => {
			if (this.socket !== socket) return
			this.socket = null
			this.setState("closed")
			if (this.wanted) this.scheduleRetry()
		}
	}

	private scheduleRetry(): void {
		if (!this.wanted || this.retryTimer) return
		const delay = backoffDelay(
			this.attempt,
			this.baseDelayMs,
			this.maxDelayMs,
			this.random,
		)
		this.attempt += 1
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null
			if (this.wanted) this.open()
		}, delay)
	}

	private resubscribe(): void {
		const channels = [...this.channelRefs.keys()]
		if (channels.length > 0) {
			const options: SubscribeOptions = {}
			if (channels.includes("spectrum") && this.channelOptions.spectrum)
				options.spectrum = this.channelOptions.spectrum
			this.sendSubscribe(channels, options)
		}
		for (const id of this.feeds.keys()) this.sendActivitySubscribe(id)
	}

	private sendSubscribe(
		channels: readonly EventChannel[],
		options: SubscribeOptions,
	): void {
		if (channels.length === 0) return
		const message: {
			type: "subscribe"
			channels: readonly EventChannel[]
			options?: SubscribeOptions
		} = {
			type: "subscribe",
			channels,
		}
		if (options.spectrum && channels.includes("spectrum"))
			message.options = { spectrum: options.spectrum }
		this.sendJson(message)
	}

	private sendActivitySubscribe(id: string): void {
		const feed = this.feeds.get(id)
		if (!feed) return
		this.sendJson(
			feed.cursor !== undefined
				? {
						type: "activity:subscribe",
						id,
						query: feed.query,
						cursor: feed.cursor,
					}
				: { type: "activity:subscribe", id, query: feed.query },
		)
	}

	private sendJson(message: unknown): void {
		const socket = this.socket
		if (!socket || socket.readyState !== OPEN) return
		try {
			socket.send(JSON.stringify(message))
		} catch {
			// The close handler reconnects.
		}
	}

	private dispatch(raw: unknown): void {
		if (typeof raw !== "string") return
		let envelope: ServerEnvelope
		try {
			const parsed = JSON.parse(raw) as unknown
			if (typeof parsed !== "object" || parsed === null) return
			const record = parsed as Record<string, unknown>
			if (typeof record["type"] !== "string") return
			envelope = {
				type: record["type"],
				data: record["data"],
				...(typeof record["channel"] === "string"
					? { channel: record["channel"] }
					: {}),
			}
		} catch {
			return
		}
		this.trackActivity(envelope)
		for (const h of [...this.anyHandlers]) safely(() => h(envelope))
		const set = this.handlers.get(envelope.type)
		if (!set) return
		for (const h of [...set]) safely(() => h(envelope.data, envelope))
	}

	/** Keeps each feed's resume cursor; a reset or a closed notice updates or drops it. */
	private trackActivity(envelope: ServerEnvelope): void {
		const data = envelope.data as {
			id?: unknown
			cursor?: unknown
			cursors?: unknown
		} | null
		if (!data || typeof data !== "object") return
		if (
			envelope.type === "activity:records" ||
			envelope.type === "activity:progress"
		) {
			const feed =
				typeof data.id === "string" ? this.feeds.get(data.id) : undefined
			if (feed && typeof data.cursor === "string") feed.cursor = data.cursor
		} else if (envelope.type === "activity:reset") {
			const feed =
				typeof data.id === "string" ? this.feeds.get(data.id) : undefined
			if (feed) feed.cursor = undefined
		} else if (
			envelope.type === "activity:closed" &&
			typeof data.cursors === "object" &&
			data.cursors
		) {
			for (const [id, cursor] of Object.entries(
				data.cursors as Record<string, unknown>,
			)) {
				const feed = this.feeds.get(id)
				if (feed && typeof cursor === "string") feed.cursor = cursor
			}
		}
	}

	private setState(state: ConnectionState): void {
		if (this.stateValue === state) return
		this.stateValue = state
		for (const h of [...this.stateHandlers]) safely(() => h(state))
	}
}

function safely(fn: () => void): void {
	try {
		fn()
	} catch (error) {
		// A failing handler must not break dispatch to the others.
		queueMicrotask(() => {
			throw error
		})
	}
}
