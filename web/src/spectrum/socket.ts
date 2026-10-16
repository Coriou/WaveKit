/** The spectrum worker's own `/ws` connection: spectrum channel only, reconnect with backoff, resubscribe. */

import type {
	SpectrumFrameEventData,
	SpectrumProfileEventData,
	SpectrumSubscribeOptions,
} from "@wavekit/api-types"
import type { SpectrumSubscription } from "./protocol.ts"
import { backoffDelay } from "./schedule.ts"

/** ws(s)://host/ws for a page (or worker script) URL. */
export function wsUrlFrom(href: string, path = "/ws"): string {
	const url = new URL(path, href)
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
	url.hash = ""
	return url.toString()
}

export type SpectrumServerMessage =
	| { type: "spectrum:frame"; data: SpectrumFrameEventData }
	| { type: "spectrum:profile"; data: SpectrumProfileEventData }

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null
}

function isFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v)
}

/** Parses a server message; null for anything that is not a well-formed spectrum frame or profile. */
export function parseServerMessage(text: string): SpectrumServerMessage | null {
	let msg: unknown
	try {
		msg = JSON.parse(text)
	} catch {
		return null
	}
	if (!isRecord(msg) || !isRecord(msg["data"])) return null
	const data = msg["data"]
	if (msg["type"] === "spectrum:frame") {
		if (
			typeof data["sourceId"] !== "string" ||
			typeof data["profile"] !== "string" ||
			typeof data["bins"] !== "string" ||
			data["binEncoding"] !== "u8-halfdb-127.5" ||
			!isFiniteNumber(data["epoch"]) ||
			!isFiniteNumber(data["startHz"]) ||
			!isFiniteNumber(data["binHz"]) ||
			!(data["binHz"] > 0) ||
			!isFiniteNumber(data["binCount"]) ||
			!isFiniteNumber(data["centerHz"])
		)
			return null
		return {
			type: "spectrum:frame",
			data: data as unknown as SpectrumFrameEventData,
		}
	}
	if (msg["type"] === "spectrum:profile") {
		if (
			typeof data["outcome"] !== "string" ||
			typeof data["selection"] !== "string"
		)
			return null
		return {
			type: "spectrum:profile",
			data: data as unknown as SpectrumProfileEventData,
		}
	}
	return null
}

export function subscribeMessage(sub: SpectrumSubscription): string {
	const spectrum: SpectrumSubscribeOptions = { sourceId: sub.sourceId }
	if (sub.hz !== undefined) spectrum.hz = sub.hz
	if (sub.bins !== undefined) spectrum.bins = sub.bins
	if (sub.backfillMs !== undefined) spectrum.backfillMs = sub.backfillMs
	return JSON.stringify({
		type: "subscribe",
		channels: ["spectrum"],
		options: { spectrum },
	})
}

export const UNSUBSCRIBE_MESSAGE = JSON.stringify({
	type: "unsubscribe",
	channels: ["spectrum"],
})

export interface SocketHandlers {
	message: (msg: SpectrumServerMessage) => void
	state: (state: "connecting" | "open" | "closed") => void
}

export class SpectrumSocket {
	private readonly url: string
	private readonly handlers: SocketHandlers
	private ws: WebSocket | null = null
	private subscription: SpectrumSubscription | null = null
	private attempt = 0
	private retryTimer: ReturnType<typeof setTimeout> | null = null
	private disposed = false

	constructor(url: string, handlers: SocketHandlers) {
		this.url = url
		this.handlers = handlers
	}

	/** Sets the selection; connects on the first one, unsubscribes on null. */
	setSubscription(sub: SpectrumSubscription | null): void {
		this.subscription = sub
		const ws = this.ws
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(sub ? subscribeMessage(sub) : UNSUBSCRIBE_MESSAGE)
			return
		}
		if (sub && !ws && this.retryTimer === null) this.connect()
	}

	dispose(): void {
		this.disposed = true
		if (this.retryTimer !== null) clearTimeout(this.retryTimer)
		this.retryTimer = null
		const ws = this.ws
		this.ws = null
		if (ws) {
			ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
			ws.close()
		}
	}

	private connect(): void {
		if (this.disposed) return
		this.handlers.state("connecting")
		let ws: WebSocket
		try {
			ws = new WebSocket(this.url)
		} catch {
			this.scheduleRetry()
			return
		}
		this.ws = ws
		ws.onopen = () => {
			this.attempt = 0
			this.handlers.state("open")
			if (this.subscription) ws.send(subscribeMessage(this.subscription))
		}
		ws.onmessage = event => {
			if (typeof event.data !== "string") return
			const msg = parseServerMessage(event.data)
			if (msg) this.handlers.message(msg)
		}
		ws.onerror = () => {
			// onclose follows and schedules the retry.
		}
		ws.onclose = () => {
			if (this.ws !== ws) return
			this.ws = null
			this.handlers.state("closed")
			this.scheduleRetry()
		}
	}

	private scheduleRetry(): void {
		if (this.disposed || this.retryTimer !== null) return
		const delay = backoffDelay(this.attempt++)
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null
			if (this.subscription) this.connect()
		}, delay)
	}
}
