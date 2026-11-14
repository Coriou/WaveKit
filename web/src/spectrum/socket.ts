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

/** No live frame for this long (ms) while subscribed counts as a stalled stream, at any rate. */
export const STALL_MIN_MS = 5000

/** How long the stream may stay silent before it is resubscribed: 4 frame periods, at least STALL_MIN_MS. */
export function stallTimeoutMs(hz: number | undefined | null): number {
	const period =
		hz !== undefined && hz !== null && hz > 0 ? Math.ceil(4000 / hz) : 0
	return Math.max(STALL_MIN_MS, period)
}

/** backoffDelay attempt index at its 10 s cap: the wait after a `rejected` ack. */
export const BACKOFF_CAP_ATTEMPT = 5

/** The backoff cap without jitter, ms (backoffDelay(BACKOFF_CAP_ATTEMPT) at its midpoint: 10 s). */
export const BACKOFF_CAP_MS = backoffDelay(BACKOFF_CAP_ATTEMPT, () => 0.5)

/**
 * While the page believes the receiver paused, the watchdog checks this often (ms): a resume the
 * page missed is streaming again within it. 3 backoff caps (30 s): each check is a subscribe the
 * core logs and answers with its ack and backfill, so a paused tab costs it 2 a minute.
 */
export const PAUSED_WATCH_MS = 3 * BACKOFF_CAP_MS

/**
 * A kick within this long (ms) of the last subscribe adds nothing: its ack and frames are still on
 * the way (one round trip). Covers a resume that changes the pause and the resync in one render.
 */
export const KICK_AFTER_SUBSCRIBE_MS = 1000

/** Connects that closed before opening, in a row, after which the session is checked as for a 1008. */
export const PROBE_AFTER_FAILED_CONNECTS = 3

/**
 * Whether a close may mean this browser lost its access, so the session is checked before giving
 * up. No close code is final by itself: a graceful stop closes with 1001, but older cores sent
 * 1008 "Access expired" then, so a 1008 is retried like any drop; if the reconnect fails as well, an
 * authenticated HTTP probe (authProbeUrl) decides, and only a 401 or 403 there ends the retries.
 */
export function closeNeedsAuthCheck(code: number): boolean {
	return code === 1008
}

/** The session route on the same host as the `/ws` URL: 401 there means this browser is not signed in. */
export function authProbeUrl(wsUrl: string): string {
	const url = new URL("/api/access/session", wsUrl)
	url.protocol = url.protocol === "wss:" ? "https:" : "http:"
	url.hash = ""
	url.search = ""
	return url.toString()
}

/** `lost`: the core answered 401 or 403. Anything else (network error, 5xx, 404 on a legacy core, 200) is not a loss. */
export interface AuthProbeResult {
	lost: boolean
	status: number | null
}

export type AuthProbe = () => Promise<AuthProbeResult>

/** GET `url` with the browser's cookie; a 401 or 403 is a lost session, anything else is not. */
export function fetchAuthProbe(url: string): AuthProbe {
	return async () => {
		try {
			const res = await fetch(url, {
				credentials: "include",
				cache: "no-store",
			})
			void res.body?.cancel().catch(() => {})
			return {
				lost: res.status === 401 || res.status === 403,
				status: res.status,
			}
		} catch {
			return { lost: false, status: null }
		}
	}
}

/** Link details posted with a state: `message` explains a "failed"; `attempts` counts tries without a live frame. */
export interface LinkInfo {
	message?: string
	attempts?: number
}

export interface SocketHandlers {
	message: (msg: SpectrumServerMessage) => void
	state: (state: SpectrumLinkState, info?: LinkInfo) => void
}

export interface SpectrumSocketOptions {
	/** Session check after a 1008 or repeated failed connects; default fetchAuthProbe(authProbeUrl(url)). */
	authProbe?: AuthProbe
}

function isReplay(frame: SpectrumFrameEventData): boolean {
	return frame.snapshot === true || frame.backfill === true
}

/**
 * Connects, subscribes, and keeps the stream flowing by itself:
 * - a dropped socket reconnects with backoff and resubscribes to the same selection;
 * - a stream without live frames (the source paused, its spectrum engine gone) is resubscribed on
 *   the same socket, spaced by a backoff growing to its 10 s cap (at once after a `rejected` ack);
 *   a socket that answers nothing at all (not even the ack) is dropped and reconnected;
 * - while the page believes the receiver paused (setSourcePaused) the socket still reconnects and
 *   the watchdog still runs, only spaced at the backoff cap: that belief can be stale (a missed
 *   resume), and a socket that waited on it would never come back; the resume resubscribes at once;
 * - kick() (the tab became visible, the feed or the tuning changed) resubscribes at once a stream
 *   with no recent live frame, reconnects at once a dropped socket, and retries even after "failed";
 * - a 1008 close followed by another failed connect, or PROBE_AFTER_FAILED_CONNECTS connects in a
 *   row that never opened, checks the session over HTTP; only a 401 or 403 there stops the
 *   retries and reports "failed".
 * Only live frames count: the ack's backfill and snapshot frames (sent on every subscribe) are
 * passed on but neither make the link live nor reset the backoff.
 * State: "connecting" until the first live frame, "live" while live frames flow, "reconnecting"
 * after a drop or a stall until they flow again; `attempts` grows with each try in between.
 */
export class SpectrumSocket {
	private readonly url: string
	private readonly handlers: SocketHandlers
	private readonly authProbe: AuthProbe
	private ws: WebSocket | null = null
	private subscription: SpectrumSubscription | null = null
	/** Connects since the last live frame (the reconnect backoff index). */
	private attempt = 0
	/** Connects in a row that closed before opening. */
	private failedConnects = 0
	private retryTimer: ReturnType<typeof setTimeout> | null = null
	private stallTimer: ReturnType<typeof setTimeout> | null = null
	private disposed = false
	private failed = false
	private everLive = false
	private sourcePaused = false
	private probing = false
	/**
	 * Bumped by every kick(): a session check started before it answers for a link that is gone,
	 * so its result (a stale 401) is ignored and never fails the new socket.
	 */
	private generation = 0
	/** The reason of a 1008 close since the last live frame: the next failed connect checks the session. */
	private accessSuspect: string | null = null
	private link: SpectrumLinkState | null = null
	private linkAttempts = -1
	/** Date.now() of the newest live frame (or of the subscribe that started the wait). */
	private lastFrameAt = 0
	/** Date.now() of the newest live frame only. */
	private lastLiveAt = 0
	/** Date.now() of the newest subscribe sent. */
	private lastSubscribeAt = 0
	/** Resubscribes sent since the last live frame. */
	private resubscribes = 0
	/** The last ack was `rejected`: the next resubscribe waits the backoff cap. */
	private rejected = false
	/** Frame rate the core acked for this subscription (effectiveHz); null until an ack says. */
	private ackedHz: number | null = null
	/** Any message since the last resubscribe (the socket still answers). */
	private heard = false

	constructor(
		url: string,
		handlers: SocketHandlers,
		options: SpectrumSocketOptions = {},
	) {
		this.url = url
		this.handlers = handlers
		this.authProbe = options.authProbe ?? fetchAuthProbe(authProbeUrl(url))
	}

	/** Sets the selection; connects on the first one, unsubscribes on null. */
	setSubscription(sub: SpectrumSubscription | null): void {
		this.subscription = sub
		this.ackedHz = null
		const ws = this.ws
		if (ws && ws.readyState === WebSocket.OPEN) {
			if (sub) this.sendSubscribe(ws, sub)
			else ws.send(UNSUBSCRIBE_MESSAGE)
			this.restartWatch()
			return
		}
		if (sub && !ws && this.retryTimer === null) {
			// A new selection after a refusal tries once more.
			this.failed = false
			this.connect()
		}
	}

	/**
	 * The page believes the receiver of the subscribed source paused (no frames are due): the
	 * watchdog resubscribes only every PAUSED_WATCH_MS and the link is not reported as stalled. The
	 * socket stays connected and subscribed, so a resume the page never hears of still streams.
	 * Unpausing resubscribes once at once (or connects at once when the socket is gone).
	 */
	setSourcePaused(paused: boolean): void {
		if (paused === this.sourcePaused) return
		this.sourcePaused = paused
		if (paused) {
			if (this.stallTimer !== null) this.armStall(this.stallTimeout())
			return
		}
		this.resync()
	}

	/**
	 * The page has a reason to expect frames now (the tab became visible, the feed went live, the
	 * tuning changed): a stream with no live frame within the stall timeout is resubscribed at
	 * once, a dropped socket reconnects at once, and a "failed" link tries again.
	 */
	kick(): void {
		if (this.disposed || !this.subscription) return
		this.generation++
		// a check in flight belongs to the previous generation: the new one may run its own
		this.probing = false
		if (this.failed) {
			this.failed = false
			this.accessSuspect = null
			this.failedConnects = 0
		} else {
			const now = Date.now()
			if (
				this.link === "live" &&
				now - this.lastLiveAt <
					stallTimeoutMs(this.ackedHz ?? this.subscription.hz)
			)
				return
			// The last subscribe is still in flight, or the core refused it: wait as the watchdog does.
			const wait = this.rejected ? BACKOFF_CAP_MS : KICK_AFTER_SUBSCRIBE_MS
			if (
				this.ws?.readyState === WebSocket.OPEN &&
				now - this.lastSubscribeAt < wait
			)
				return
		}
		this.resync()
	}

	/** Resubscribes at once on an open socket, or connects at once without one. */
	private resync(): void {
		const sub = this.subscription
		if (this.disposed || this.failed || !sub) return
		const ws = this.ws
		if (ws) {
			if (ws.readyState === WebSocket.OPEN) {
				this.sendSubscribe(ws, sub)
				this.restartWatch()
			}
			// CONNECTING: onopen subscribes; CLOSING: onclose reconnects.
			return
		}
		if (this.retryTimer !== null) clearTimeout(this.retryTimer)
		this.retryTimer = null
		this.connect()
	}

	dispose(): void {
		this.disposed = true
		if (this.retryTimer !== null) clearTimeout(this.retryTimer)
		this.retryTimer = null
		this.clearStall()
		this.detach()
	}

	/** Tries without a live frame: failed connects plus resubscribes. */
	private get attempts(): number {
		return this.attempt + this.resubscribes
	}

	private setLink(state: SpectrumLinkState, message?: string): void {
		const attempts = state === "live" || state === "failed" ? 0 : this.attempts
		if (
			state === this.link &&
			attempts === this.linkAttempts &&
			message === undefined
		)
			return
		this.link = state
		this.linkAttempts = attempts
		const info: LinkInfo = {}
		if (message !== undefined) info.message = message
		if (state === "connecting" || state === "reconnecting")
			info.attempts = attempts
		this.handlers.state(state, info)
	}

	private notLive(): void {
		this.setLink(this.everLive ? "reconnecting" : "connecting")
	}

	private connect(): void {
		if (this.disposed || this.failed) return
		this.notLive()
		let ws: WebSocket
		try {
			ws = new WebSocket(this.url)
		} catch {
			this.failedConnects++
			this.scheduleRetry()
			return
		}
		this.ws = ws
		let opened = false
		ws.onopen = () => {
			opened = true
			this.failedConnects = 0
			if (this.subscription) this.sendSubscribe(ws, this.subscription)
			this.restartWatch()
		}
		ws.onmessage = event => {
			if (typeof event.data !== "string") return
			const msg = parseServerMessage(event.data)
			if (!msg) return
			this.heard = true
			if (msg.type === "spectrum:frame") {
				if (!isReplay(msg.data)) this.onLiveFrame()
			} else this.onAck(msg.data)
			this.handlers.message(msg)
		}
		ws.onerror = () => {
			// onclose follows and schedules the retry.
		}
		ws.onclose = event => {
			if (this.ws !== ws) return
			this.ws = null
			this.clearStall()
			if (!opened) this.failedConnects++
			this.scheduleRetry()
			// After a 1008 the session is checked only once the next connect fails too: a graceful
			// core stop sends 1001, but older cores sent 1008 while their access controller was
			// already gone, so a check right away could read a 401 from a core that is merely
			// restarting.
			const suspect = this.accessSuspect
			if (closeNeedsAuthCheck(event.code) && suspect === null)
				this.accessSuspect = event.reason || `close code ${event.code}`
			else if (suspect !== null) this.checkAccess(suspect)
			else if (this.failedConnects >= PROBE_AFTER_FAILED_CONNECTS)
				this.checkAccess(null)
		}
	}

	private onLiveFrame(): void {
		this.lastFrameAt = this.lastLiveAt = Date.now()
		this.resubscribes = 0
		this.attempt = 0
		this.rejected = false
		this.accessSuspect = null
		this.everLive = true
		this.setLink("live")
	}

	private onAck(data: SpectrumProfileEventData): void {
		if (data.outcome === "rejected") {
			// The core could not serve the request (e.g. it failed to start the engine): wait the cap.
			this.rejected = true
			if (this.stallTimer !== null && this.ws)
				this.armStall(
					Math.max(this.stallTimeout(), backoffDelay(BACKOFF_CAP_ATTEMPT)),
				)
			return
		}
		if (
			data.selection === "source" &&
			data.sourceId === this.subscription?.sourceId &&
			data.effectiveHz !== null &&
			Number.isFinite(data.effectiveHz) &&
			data.effectiveHz > 0
		)
			this.ackedHz = data.effectiveHz
	}

	/** An HTTP check of this browser's session; a 401/403 (and still no live frame) ends the retries. */
	private checkAccess(closeReason: string | null): void {
		if (this.probing || this.disposed || this.failed) return
		this.probing = true
		const generation = this.generation
		this.authProbe().then(
			result => {
				if (generation !== this.generation) return
				this.probing = false
				if (!result.lost || this.disposed || this.failed) return
				if (this.link === "live") return
				const why = closeReason ? ` (${closeReason})` : ""
				this.fail(
					`Spectrum stream closed${why}: the core answers HTTP ${result.status ?? "401"}, so this browser is no longer signed in. Pair it again, then return to this tab or reload the page.`,
				)
			},
			() => {
				if (generation === this.generation) this.probing = false
			},
		)
	}

	private fail(message: string): void {
		this.failed = true
		if (this.retryTimer !== null) clearTimeout(this.retryTimer)
		this.retryTimer = null
		this.clearStall()
		this.detach()
		this.setLink("failed", message)
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
		this.notLive()
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null
			// Also while the page believes the receiver paused: that belief may be stale.
			if (this.subscription) this.connect()
		}, delay)
	}

	/** Silence that counts as a stall; while the page believes the receiver paused, PAUSED_WATCH_MS. */
	private stallTimeout(): number {
		const live = stallTimeoutMs(this.ackedHz ?? this.subscription?.hz)
		return this.sourcePaused ? Math.max(live, PAUSED_WATCH_MS) : live
	}

	private sendSubscribe(ws: WebSocket, sub: SpectrumSubscription): void {
		ws.send(subscribeMessage(sub))
		this.lastSubscribeAt = Date.now()
	}

	/** A (re)subscribe was sent: live frames are due within the stall timeout from now. */
	private restartWatch(): void {
		this.lastFrameAt = Date.now()
		this.resubscribes = 0
		this.rejected = false
		this.heard = false
		this.armStall(this.stallTimeout())
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
		if (!ws || !sub) return
		if (ws.readyState !== WebSocket.OPEN) {
			// CLOSING without its close event yet: drop it and reconnect rather than wait on it.
			this.detach()
			this.scheduleRetry()
			return
		}
		const timeout = this.stallTimeout()
		const silent = Date.now() - this.lastFrameAt
		if (this.resubscribes === 0 && !this.rejected && silent < timeout) {
			this.armStall(timeout - silent)
			return
		}
		if (this.resubscribes > 0 && !this.heard) {
			// Not even the ack came back: the socket is dead without having closed.
			this.detach()
			this.scheduleRetry()
			return
		}
		this.sendSubscribe(ws, sub)
		this.resubscribes++
		this.heard = false
		// A paused receiver sends nothing: that is not a stalled link.
		if (!this.sourcePaused) this.notLive()
		const step = this.rejected ? BACKOFF_CAP_ATTEMPT : this.resubscribes
		this.armStall(Math.max(timeout, backoffDelay(step)))
	}
}
