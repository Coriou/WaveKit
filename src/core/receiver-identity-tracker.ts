/**
 * Follows each tracked source's connections and says which receiver it reaches.
 *
 * Per connection: the identity is recomputed from its rtl_tcp header ("rtl-tcp-header"). When the
 * configured sdr-host describes the connected receiver (`sdrHostApplies`: the source is on its
 * primary endpoint), the identity waits for the first sdr-host poll RESULT of this connection
 * (an answer or a failure; `noteSdrHostResult`), event-driven: the connection kicks a poll
 * (`kickSdrHostPoll`) and settles as soon as the result is in, with the header seen. Epoch rule:
 * a result belongs to the connection when its poll's request started at or after the
 * connection opened (`startedAt >= openedAt`, both performance.now(): monotonic, so a wall-clock
 * step cannot misplace a result); an older one (a boot poll that
 * answered before the connect) is ignored, and the kicked poll answers instead. The hard bound
 * `sdrHostWaitMs` is only a safety net (see RECEIVER_SDR_HOST_WAIT_MS); past it the identity
 * settles with what it has. A later answer only ever upgrades it (model -> unit); a failed or
 * malformed poll, or another unit key, never changes a settled identity within the connection.
 * A failed result ends the wait at once, except when a unit answer is expected (`sdrHostExpected`:
 * the configured sdr-host has answered before, or is configured explicitly, or the source's last
 * settled key is a `unit:` one): a Pi reboot or an sdr-host restart has rtlmux listening before the
 * sdr-host API, so the first polls of the reconnect fail. Then the connection keeps waiting (the
 * learned state stays pending, read-only) and asks for another poll every
 * RECEIVER_SDR_HOST_RETRY_MS (`kickSdrHostPoll(id, true)`: brought forward past any failure
 * backoff, its failure does not grow the backoff) until an answer or the hard bound; only at the
 * bound does it settle on the source-scoped model.
 * "identity" fires when the settled key differs from the last one;
 * "settled" fires on every settle (also the same receiver again after a reconnect), and
 * "connection" on every connection boundary (a disconnect or a new connection), so the learned
 * state can stop applying the previous receiver's before the next identity is known.
 */
import { EventEmitter } from "node:events"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import {
	resolveReceiverIdentity,
	STRENGTH_RANK,
	type ReceiverIdentity,
	type SdrHostIdentityFacts,
} from "./receiver-identity.js"

/**
 * Hard bound on the wait for the first sdr-host result of a connection, from its header (a safety
 * net: the result normally ends the wait). The connection kicks a poll; if one is running then
 * (at most its `/api/status` request, timeout T, then its `/api/host` request, timeout T) the
 * kicked one starts right after and its `/api/status` takes at most T more: 3 x T after the
 * connect, earlier than the header. With the default T = 2 s: 3 x 2000 + 1000 ms slack = 7 s.
 */
export function receiverSdrHostWaitMs(requestTimeoutMs: number): number {
	return 3 * requestTimeoutMs + 1000
}
export const RECEIVER_SDR_HOST_WAIT_MS = receiverSdrHostWaitMs(2000)

/**
 * The gap between the retry polls of a connection that expects a unit answer after a failed one.
 * Arithmetic with the default T = 2 s and the 7 s bound (3 x T + 1 s, from the header, about the
 * connect): a refused poll fails at once, so the attempts start at about 0, 1, 2, ... 6 s; a poll
 * that times out costs T + 1 s per attempt (attempts at about 0, 3 and 6 s). Either way an
 * attempt starts at about 6 s, so an sdr-host API up by then is heard before the bound when its
 * `/api/status` answers within the last second (a LAN answer takes milliseconds). Past the bound
 * the identity settles on the model, and the first later answer upgrades it (one swap).
 */
export const RECEIVER_SDR_HOST_RETRY_MS = 1000

/** One sdr-host poll's outcome (SdrHostPoller "identity-result"). */
export interface SdrHostResult {
	startedAt: number
	ok: boolean
	facts: SdrHostIdentityFacts | null
}

export interface ReceiverIdentitySources {
	on(event: "connected", fn: (sourceId: string) => void): unknown
	on(event: "disconnected", fn: (sourceId: string) => void): unknown
	on(
		event: "rtl-tcp-header",
		fn: (
			sourceId: string,
			info: { magic: string; tunerType: number; gainCount: number } | null,
		) => void,
	): unknown
	on(event: "removed", fn: (sourceId: string) => void): unknown
}

export interface ReceiverIdentityTrackerOptions {
	sources: ReceiverIdentitySources
	logger: Logger
	/** True when the source's configured sdr-host describes the receiver it is connected to now. */
	sdrHostApplies: (sourceId: string) => boolean
	/** Hard bound on the wait for the first sdr-host result after a header (default RECEIVER_SDR_HOST_WAIT_MS). */
	sdrHostWaitMs?: number
	/**
	 * Asks for an sdr-host poll now (SdrHostPoller.pollNow); called at every connection, and with
	 * `retry` true for the retries of a connection that expects a unit answer.
	 */
	kickSdrHostPoll?: (sourceId: string, retry?: boolean) => void
	/**
	 * True when a unit answer is expected from the source's sdr-host (configured explicitly, or it
	 * answered before): a failed result then does not end the wait (default: only when the last
	 * settled key is a `unit:` one).
	 */
	sdrHostExpected?: (sourceId: string) => boolean
	/** The gap between retry polls (default RECEIVER_SDR_HOST_RETRY_MS). */
	sdrHostRetryMs?: number
	/** Monotonic clock of the epoch rule (default performance.now, the poller's clock). */
	now?: () => number
}

interface Connection {
	openedAt: number
	header: { magic: string; tunerType: number; gainCount: number } | null
	headerSeen: boolean
	facts: SdrHostIdentityFacts | null
	/** A result of this connection's epoch came in (an answer or a failure). */
	resulted: boolean
	settled: ReceiverIdentity | null
	timer: ReturnType<typeof setTimeout> | null
	/** The next retry poll of a connection that expects a unit answer. */
	retryTimer: ReturnType<typeof setTimeout> | null
	warnedConflict: boolean
}

export interface ReceiverIdentityEvents {
	identity: (
		sourceId: string,
		identity: ReceiverIdentity,
		previous: ReceiverIdentity | undefined,
	) => void
	settled: (
		sourceId: string,
		identity: ReceiverIdentity,
		previous: ReceiverIdentity | undefined,
	) => void
	/** `kind`: "close" for a disconnect, "open" for a new connection. */
	connection: (sourceId: string, kind: "open" | "close") => void
}

export class ReceiverIdentityTracker extends EventEmitter {
	private readonly log: Logger
	private readonly waitMs: number
	private readonly connections = new Map<string, Connection>()
	private readonly last = new Map<string, ReceiverIdentity>()
	private stopped = false
	private readonly now: () => number
	private readonly retryMs: number

	constructor(private readonly options: ReceiverIdentityTrackerOptions) {
		super()
		this.log = createComponentLogger(options.logger, "ReceiverIdentity")
		this.waitMs = options.sdrHostWaitMs ?? RECEIVER_SDR_HOST_WAIT_MS
		this.now = options.now ?? (() => performance.now())
		this.retryMs = options.sdrHostRetryMs ?? RECEIVER_SDR_HOST_RETRY_MS
		options.sources.on("connected", id => {
			this.onConnected(id)
			if (!this.stopped) this.emit("connection", id, "open")
		})
		options.sources.on("disconnected", id => {
			this.clearTimer(id)
			this.connections.delete(id)
			if (!this.stopped) this.emit("connection", id, "close")
		})
		options.sources.on("rtl-tcp-header", (id, info) => this.onHeader(id, info))
		options.sources.on("removed", id => this.clearTimer(id))
	}

	/** The last settled identity of a source; undefined before its first. */
	current(sourceId: string): ReceiverIdentity | undefined {
		const id = this.last.get(sourceId)
		return id ? { ...id } : undefined
	}

	/**
	 * The current connection's identity from what it has now (header and any sdr-host answer
	 * since it opened); undefined before its header. Read by the tuner at the first payload.
	 */
	provisional(sourceId: string): ReceiverIdentity | undefined {
		const conn = this.connections.get(sourceId)
		if (!conn?.headerSeen) return undefined
		return conn.settled ?? this.combine(sourceId, conn)
	}

	/**
	 * One sdr-host poll's result for a source (SdrHostPoller "identity-result"). Used only by the
	 * connection whose epoch it belongs to (its poll started at or after the connection opened).
	 */
	noteSdrHostResult(sourceId: string, result: SdrHostResult): void {
		if (this.stopped) return
		const conn = this.connections.get(sourceId)
		if (!conn || !this.options.sdrHostApplies(sourceId)) return
		if (result.startedAt < conn.openedAt) return
		// A unit answer is expected: a failure (an sdr-host API not up yet) asks again soon instead.
		if (
			!result.ok &&
			result.facts === null &&
			conn.settled === null &&
			conn.facts === null &&
			this.expectsUnit(sourceId)
		) {
			this.scheduleRetry(sourceId, conn)
			return
		}
		conn.resulted = true
		// A failure keeps what an earlier answer of this connection said (never a downgrade).
		if (result.facts !== null) conn.facts = result.facts
		if (!conn.headerSeen) return
		const next = this.combine(sourceId, conn)
		if (conn.settled === null) {
			this.settle(sourceId, conn, next)
			return
		}
		if (STRENGTH_RANK[next.strength] > STRENGTH_RANK[conn.settled.strength]) {
			this.settle(sourceId, conn, next)
			return
		}
		if (next.key !== conn.settled.key && !conn.warnedConflict) {
			conn.warnedConflict = true
			this.log.warn(
				{ sourceId, strength: next.strength },
				"The sdr-host reports another receiver than this connection settled on; kept until the next connection",
			)
		}
	}

	stop(): void {
		this.stopped = true
		for (const id of this.connections.keys()) this.clearTimer(id)
	}

	private expectsUnit(sourceId: string): boolean {
		if (this.last.get(sourceId)?.key.startsWith("unit:") === true) return true
		try {
			return this.options.sdrHostExpected?.(sourceId) === true
		} catch {
			return false
		}
	}

	/**
	 * One retry poll RECEIVER_SDR_HOST_RETRY_MS from now, while the connection is current and not
	 * settled. Before its header the retries stop after the bound (the header's timer settles).
	 */
	private scheduleRetry(sourceId: string, conn: Connection): void {
		if (conn.retryTimer !== null || this.stopped) return
		if (!conn.headerSeen && this.now() - conn.openedAt > this.waitMs) {
			conn.resulted = true
			return
		}
		conn.retryTimer = setTimeout(() => {
			conn.retryTimer = null
			if (
				this.stopped ||
				this.connections.get(sourceId) !== conn ||
				conn.settled !== null
			)
				return
			try {
				this.options.kickSdrHostPoll?.(sourceId, true)
			} catch (err) {
				this.log.warn(
					{ err, sourceId },
					"Asking the sdr-host for a poll failed",
				)
			}
		}, this.retryMs)
		conn.retryTimer.unref?.()
	}

	private combine(sourceId: string, conn: Connection): ReceiverIdentity {
		return resolveReceiverIdentity(
			sourceId,
			conn.header,
			this.options.sdrHostApplies(sourceId) ? conn.facts : null,
		)
	}

	private onConnected(sourceId: string): void {
		this.clearTimer(sourceId)
		this.connections.set(sourceId, {
			openedAt: this.now(),
			header: null,
			headerSeen: false,
			facts: null,
			resulted: false,
			settled: null,
			timer: null,
			retryTimer: null,
			warnedConflict: false,
		})
		if (this.stopped || !this.options.sdrHostApplies(sourceId)) return
		try {
			this.options.kickSdrHostPoll?.(sourceId)
		} catch (err) {
			this.log.warn({ err, sourceId }, "Asking the sdr-host for a poll failed")
		}
	}

	private onHeader(
		sourceId: string,
		info: { magic: string; tunerType: number; gainCount: number } | null,
	): void {
		if (this.stopped) return
		let conn = this.connections.get(sourceId)
		if (!conn) {
			this.onConnected(sourceId)
			conn = this.connections.get(sourceId)!
		}
		conn.header = info
		conn.headerSeen = true
		const now = this.combine(sourceId, conn)
		// Settled now: no sdr-host for this endpoint, or this connection's result is already in.
		if (
			conn.resulted ||
			!this.options.sdrHostApplies(sourceId) ||
			this.waitMs <= 0
		) {
			this.settle(sourceId, conn, now)
			return
		}
		const settleConn = conn
		conn.timer = setTimeout(() => {
			settleConn.timer = null
			if (this.connections.get(sourceId) !== settleConn) return
			if (settleConn.settled === null)
				this.settle(sourceId, settleConn, this.combine(sourceId, settleConn))
		}, this.waitMs)
		conn.timer.unref?.()
	}

	private settle(
		sourceId: string,
		conn: Connection,
		identity: ReceiverIdentity,
	): void {
		if (conn.timer) clearTimeout(conn.timer)
		conn.timer = null
		if (conn.retryTimer) clearTimeout(conn.retryTimer)
		conn.retryTimer = null
		conn.settled = identity
		const previous = this.last.get(sourceId)
		this.last.set(sourceId, identity)
		this.emit("settled", sourceId, { ...identity }, previous)
		if (previous?.key === identity.key) return
		this.emit("identity", sourceId, { ...identity }, previous)
	}

	private clearTimer(sourceId: string): void {
		const conn = this.connections.get(sourceId)
		if (conn?.timer) clearTimeout(conn.timer)
		if (conn?.retryTimer) clearTimeout(conn.retryTimer)
		if (conn) {
			conn.timer = null
			conn.retryTimer = null
		}
	}
}
