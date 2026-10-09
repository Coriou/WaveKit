import WebSocket from "ws"
import { parseServerMessage } from "./guards.js"
import type { Inbound } from "./types.js"

export interface WsHandlers {
	open(): void
	message(text: string): void
	close(code: number, reason: string): void
	error(message: string): void
}
export interface WsHandle {
	send(text: string): void
	close(): void
}
export type WsFactory = (url: string, handlers: WsHandlers) => WsHandle

function rawToString(data: WebSocket.RawData): string {
	if (Buffer.isBuffer(data)) return data.toString("utf8")
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8")
	return Buffer.from(data).toString("utf8")
}

/** ws has no default handshake timeout; a silent server would hold CONNECTING forever. */
export const HANDSHAKE_TIMEOUT_MS = 2000
/** Frames above this close the socket with 1009 (ws's own default is 100 MiB). */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

/** Core pings every 30 s; this much silence after a ping means the socket is half-open. */
export const SILENCE_MS = 75_000
const WATCHDOG_CHECK_MS = 5_000

export interface NodeWsOptions {
	silenceMs?: number
	checkMs?: number
}

/**
 * Every socket gets error and close handlers; nothing is logged. Throws synchronously on
 * a bad URL. A liveness watchdog arms on the first server ping (older cores that never
 * ping are left alone) and terminates the socket after `silenceMs` without any frame,
 * ping or pong, so a half-open socket cannot look connected forever.
 */
export function createNodeWsFactory(opts: NodeWsOptions = {}): WsFactory {
	const silenceMs = opts.silenceMs ?? SILENCE_MS
	const checkMs = opts.checkMs ?? WATCHDOG_CHECK_MS
	return (url, h) => {
		const sock = new WebSocket(url, {
			handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
			maxPayload: MAX_PAYLOAD_BYTES,
		})
		let lastSeen = Date.now()
		let armed = false
		const seen = (): void => {
			lastSeen = Date.now()
		}
		const watchdog = setInterval(() => {
			if (!armed || Date.now() - lastSeen <= silenceMs) return
			clearInterval(watchdog)
			h.error(`no heartbeat from server in ${Math.round(silenceMs / 1000)}s`)
			sock.terminate()
		}, checkMs)
		watchdog.unref()
		sock.on("open", () => {
			seen()
			h.open()
		})
		sock.on("message", (data: WebSocket.RawData) => {
			seen()
			h.message(rawToString(data))
		})
		sock.on("ping", () => {
			armed = true
			seen()
		})
		sock.on("pong", seen)
		sock.on("error", (err: Error) => h.error(err.message))
		sock.on("close", (code: number, reason: Buffer) => {
			clearInterval(watchdog)
			h.close(code, reason.toString("utf8"))
		})
		return {
			send: text => {
				if (sock.readyState === WebSocket.OPEN) sock.send(text)
			},
			close: () => {
				clearInterval(watchdog)
				sock.terminate()
			},
		}
	}
}

export const nodeWsFactory: WsFactory = createNodeWsFactory()

export const CHANNELS = [
	"decoders",
	"health",
	"sources",
	"metrics",
	"fanout",
	"live-audio",
	"resources",
	"tuner",
	"aircraft",
] as const

export const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 15000] as const

export function backoffDelay(attempt: number, random: () => number): number {
	const base =
		BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)] ?? 15000
	return Math.round(base * (0.8 + 0.4 * random()))
}

export interface WsClientDeps {
	url: () => string | null
	factory: WsFactory
	emit: (item: Inbound) => void
	now: () => number
	random: () => number
	setTimeout: (fn: () => void, ms: number) => unknown
	clearTimeout: (handle: unknown) => void
}

export interface WsClient {
	start(): void
	stop(): void
	reconnectNow(): void
	/** True while a socket exists, connecting or open. */
	connected(): boolean
}

export function createWsClient(deps: WsClientDeps): WsClient {
	let generation = 0
	let handle: WsHandle | null = null
	let timer: unknown = null
	let attempt = 0
	let stopped = true
	let lastError = ""
	/** True between the subscribe ack (ws:open) and the socket's close. */
	let open = false

	function clearTimer(): void {
		if (timer !== null) deps.clearTimeout(timer)
		timer = null
	}

	function scheduleRetry(code: number, reason: string): void {
		const delay = backoffDelay(attempt, deps.random)
		attempt++
		const nextRetryAt = deps.now() + delay
		deps.emit({ kind: "ws:close", at: deps.now(), code, reason, nextRetryAt })
		clearTimer()
		timer = deps.setTimeout(() => {
			timer = null
			connect()
		}, delay)
	}

	function connect(): void {
		if (stopped) return
		const url = deps.url()
		const gen = ++generation
		if (url === null) {
			scheduleRetry(0, "no API target")
			return
		}
		lastError = ""
		deps.emit({ kind: "ws:connecting", at: deps.now(), attempt })
		let local: WsHandle | null = null
		try {
			local = deps.factory(url, {
				open: () => {
					if (gen !== generation) return
					local?.send(
						JSON.stringify({ type: "subscribe", channels: [...CHANNELS] }),
					)
				},
				message: text => {
					if (gen !== generation) return
					let raw: unknown
					try {
						raw = JSON.parse(text)
					} catch {
						deps.emit({ kind: "ws:invalid", at: deps.now() })
						return
					}
					const event = parseServerMessage(raw)
					if (!event) {
						deps.emit({ kind: "ws:invalid", at: deps.now() })
						return
					}
					if (event.type === "subscribed") {
						attempt = 0
						open = true
						deps.emit({ kind: "ws:open", at: deps.now() })
						return
					}
					deps.emit({ kind: "ws", event, at: deps.now() })
				},
				error: message => {
					if (gen !== generation) return
					lastError = message
				},
				close: (code, reason) => {
					if (gen !== generation) return
					handle = null
					open = false
					scheduleRetry(code, reason !== "" ? reason : lastError)
				},
			})
		} catch (err: unknown) {
			// A synchronous throw (e.g. a URL with a fragment) must not escape:
			// from the retry timer it would be an uncaught exception.
			handle = null
			scheduleRetry(0, err instanceof Error ? err.message : String(err))
			return
		}
		handle = local
	}

	return {
		start: () => {
			if (!stopped) return
			stopped = false
			connect()
		},
		stop: () => {
			stopped = true
			open = false
			generation++
			clearTimer()
			handle?.close()
			handle = null
		},
		reconnectNow: () => {
			stopped = false
			generation++
			clearTimer()
			if (open) {
				// The old socket's own close is ignored (generation), so record the
				// disconnect here; the reducer opens a gap on ws:close.
				open = false
				deps.emit({
					kind: "ws:close",
					at: deps.now(),
					code: 1000,
					reason: "reconnect requested",
					nextRetryAt: deps.now(),
				})
			}
			handle?.close()
			handle = null
			attempt = 0
			connect()
		},
		connected: () => handle !== null,
	}
}
