/** The spectrum worker's own `/ws` connection: spectrum channel only, reconnect with backoff, resubscribe on a drop or a stall. */

import type {
	SpectrumFrameEventData,
	SpectrumProfileEventData,
	SpectrumSubscribeOptions,
} from "@wavekit/api-types"
import type { SpectrumLinkState, SpectrumSubscription } from "./protocol.ts"
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

/** No frame for this long (ms) while subscribed counts as a stalled stream, at any rate. */
export const STALL_MIN_MS = 5000

/** How long the stream may stay silent before it is resubscribed: 4 frame periods, at least STALL_MIN_MS. */
export function stallTimeoutMs(hz: number | undefined): number {
	const period = hz !== undefined && hz > 0 ? Math.ceil(4000 / hz) : 0
	return Math.max(STALL_MIN_MS, period)
}

/**
 * Close codes that mean "do not retry": 1008 (policy: the core's "Access expired") and the
 * application range 4400–4499 (an HTTP 4xx refusal). Anything else is retried with backoff.
 */
export function closeIsFinal(code: number): boolean {
	return code === 1008 || (code >= 4400 && code <= 4499)
}

export interface SocketHandlers {
	message: (msg: SpectrumServerMessage) => void
	/** The link changed; `message` explains a "failed". */
	state: (state: SpectrumLinkState, message?: string) => void
}

/**
 * Connects, subscribes, and keeps the stream flowing by itself:
 * - a dropped socket reconnects with backoff and resubscribes to the same selection;
 * - a silent stream (the source paused, its spectrum engine gone) is resubscribed on the same
 *   socket, spaced by the backoff, until frames flow again; a socket that answers nothing at all
 *   (not even the ack) is dropped and reconnected;
 * - a do-not-retry close (closeIsFinal) stops and reports "failed".
 * State: "connecting" until the first frame, "live" while frames flow, "reconnecting" after a
 * drop or a stall until frames flow again.
 */
export class SpectrumSocket {
	private readonly url: string
	private readonly handlers: SocketHandlers
	private ws: WebSocket | null = null
	private subscription: SpectrumSubscription | null = null
	private attempt = 0
	private retryTimer: ReturnType<typeof setTimeout> | null = null
	private stallTimer: ReturnType<typeof setTimeout> | null = null
	private disposed = false
	private failed = false
	private everLive = false
	private link: SpectrumLinkState | null = null
	/** Date.now() of the newest frame (or of the subscribe that started the wait). */
	private lastFrameAt = 0
	/** Resubscribes sent since the last frame. */
	private resubscribes = 0
	/** Any message since the last resubscribe (the socket still answers). */
	private heard = false

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
			this.restartWatch()
			return
		}
		if (sub && !ws && this.retryTimer === null) {
			// A new selection after a refusal tries once more.
			this.failed = false
			this.connect()
		}
	}

	dispose(): void {
		this.disposed = true
		if (this.retryTimer !== null) clearTimeout(this.retryTimer)
		this.retryTimer = null
		this.clearStall()
		this.detach()
	}

	private setLink(state: SpectrumLinkState, message?: string): void {
		if (state === this.link && message === undefined) return
		this.link = state
		if (message === undefined) this.handlers.state(state)
		else this.handlers.state(state, message)
	}

	private connect(): void {
		if (this.disposed || this.failed) return
		this.setLink(this.everLive ? "reconnecting" : "connecting")
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
			if (this.subscription) ws.send(subscribeMessage(this.subscription))
			this.restartWatch()
		}
		ws.onmessage = event => {
			if (typeof event.data !== "string") return
			const msg = parseServerMessage(event.data)
			if (!msg) return
			this.heard = true
			if (msg.type === "spectrum:frame") {
				this.lastFrameAt = Date.now()
				this.resubscribes = 0
				this.everLive = true
				this.setLink("live")
			}
			this.handlers.message(msg)
		}
		ws.onerror = () => {
			// onclose follows and schedules the retry.
		}
		ws.onclose = event => {
			if (this.ws !== ws) return
			this.ws = null
			this.clearStall()
			if (closeIsFinal(event.code)) {
				this.failed = true
				const why = event.reason ? `: ${event.reason}` : ""
				this.setLink(
					"failed",
					`The core refused the spectrum stream${why} (code ${event.code}). Reload the page to try again.`,
				)
				return
			}
			this.setLink(this.everLive ? "reconnecting" : "connecting")
			this.scheduleRetry()
		}
	}

	/** Closes the current socket without waiting for its close event. */
	private detach(): void {
		const ws = this.ws
		this.ws = null
		if (ws) {
			ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
			try {
				ws.close()
			} catch {
				// Already closing.
			}
		}
	}

	private scheduleRetry(): void {
		if (this.disposed || this.failed || this.retryTimer !== null) return
		const delay = backoffDelay(this.attempt++)
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null
			if (this.subscription) this.connect()
		}, delay)
	}

	/** A (re)subscribe was sent: frames are due within the stall timeout from now. */
	private restartWatch(): void {
		this.lastFrameAt = Date.now()
		this.resubscribes = 0
		this.heard = false
		this.armStall(stallTimeoutMs(this.subscription?.hz))
	}

	private armStall(ms: number): void {
		this.clearStall()
		if (!this.subscription || this.disposed) return
		this.stallTimer = setTimeout(() => {
			this.stallTimer = null
			this.checkStall()
		}, ms)
	}

	private clearStall(): void {
		if (this.stallTimer !== null) clearTimeout(this.stallTimer)
		this.stallTimer = null
	}

	private checkStall(): void {
		const ws = this.ws
		const sub = this.subscription
		if (!ws || !sub || ws.readyState !== WebSocket.OPEN) return
		const timeout = stallTimeoutMs(sub.hz)
		const silent = Date.now() - this.lastFrameAt
		if (this.resubscribes === 0 && silent < timeout) {
			this.armStall(timeout - silent)
			return
		}
		this.setLink(this.everLive ? "reconnecting" : "connecting")
		if (this.resubscribes > 0 && !this.heard) {
			// Not even the ack came back: the socket is dead without having closed.
			this.detach()
			this.scheduleRetry()
			return
		}
		ws.send(subscribeMessage(sub))
		this.resubscribes++
		this.heard = false
		this.armStall(Math.max(timeout, backoffDelay(this.resubscribes)))
	}
}
