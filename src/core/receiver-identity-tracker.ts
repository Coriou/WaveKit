/**
 * Follows each tracked source's connections and says which receiver it reaches.
 *
 * Per connection: the identity is recomputed from its rtl_tcp header ("rtl-tcp-header"). When the
 * configured sdr-host describes the connected receiver (`sdrHostApplies`: the source is on its
 * primary endpoint), the identity waits for the first sdr-host poll RESULT of this connection
 * (an answer or a failure; `noteSdrHostResult`), event-driven: the connection kicks a poll
 * (`kickSdrHostPoll`) and settles as soon as the result is in, with the header seen. Epoch rule:
 * a result belongs to the connection when its poll's request started at or after the
 * connection opened (`startedAt >= openedAt`, both Date.now()); an older one (a boot poll that
 * answered before the connect) is ignored, and the kicked poll answers instead. The hard bound
 * `sdrHostWaitMs` is only a safety net (see RECEIVER_SDR_HOST_WAIT_MS); past it the identity
 * settles with what it has. A later answer only ever upgrades it (model -> unit); a failed or
 * malformed poll, or another unit key, never changes a settled identity within the connection.
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
	/** Asks for an sdr-host poll now (SdrHostPoller.pollNow); called at every connection. */
	kickSdrHostPoll?: (sourceId: string) => void
	/** Clock of the epoch rule (default Date.now, the poller's clock). */
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
	connection: (sourceId: string) => void
}

export class ReceiverIdentityTracker extends EventEmitter {
	private readonly log: Logger
	private readonly waitMs: number
	private readonly connections = new Map<string, Connection>()
	private readonly last = new Map<string, ReceiverIdentity>()
	private stopped = false
	private readonly now: () => number

	constructor(private readonly options: ReceiverIdentityTrackerOptions) {
		super()
		this.log = createComponentLogger(options.logger, "ReceiverIdentity")
		this.waitMs = options.sdrHostWaitMs ?? RECEIVER_SDR_HOST_WAIT_MS
		this.now = options.now ?? Date.now
		options.sources.on("connected", id => {
			this.onConnected(id)
			if (!this.stopped) this.emit("connection", id)
		})
		options.sources.on("disconnected", id => {
			this.clearTimer(id)
			this.connections.delete(id)
			if (!this.stopped) this.emit("connection", id)
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
		if (conn) conn.timer = null
	}
}
