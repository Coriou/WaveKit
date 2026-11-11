/**
 * Follows each tracked source's connections and says which receiver it reaches.
 *
 * Per connection: the identity is recomputed from its rtl_tcp header ("rtl-tcp-header"). When the
 * configured sdr-host describes the connected receiver (`sdrHostApplies`: the source is on its
 * primary endpoint), the identity waits up to `sdrHostWaitMs` for an sdr-host answer received
 * after the connection opened, then settles with what it has. A later answer only ever upgrades
 * it (model -> unit); a failed or malformed poll, or another unit key, never changes a settled
 * identity within the connection. "identity" fires when the settled key differs from the last one;
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
 * Default wait for the sdr-host after a header: one poll interval (3 s) plus the poll's request
 * timeout (2 s), the longest a poll started just before the header can take to answer after it.
 */
export const RECEIVER_SDR_HOST_WAIT_MS = 3000 + 2000

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
	/** Bounded wait for an sdr-host answer after a header (default RECEIVER_SDR_HOST_WAIT_MS). */
	sdrHostWaitMs?: number
}

interface Connection {
	header: { magic: string; tunerType: number; gainCount: number } | null
	headerSeen: boolean
	facts: SdrHostIdentityFacts | null
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

	constructor(private readonly options: ReceiverIdentityTrackerOptions) {
		super()
		this.log = createComponentLogger(options.logger, "ReceiverIdentity")
		this.waitMs = options.sdrHostWaitMs ?? RECEIVER_SDR_HOST_WAIT_MS
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

	/** A validated sdr-host answer for a source (SdrHostPoller "receiver-identity"). */
	noteSdrHostFacts(sourceId: string, facts: SdrHostIdentityFacts): void {
		if (this.stopped) return
		const conn = this.connections.get(sourceId)
		if (!conn || !this.options.sdrHostApplies(sourceId)) return
		conn.facts = facts
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
			conn.header,
			this.options.sdrHostApplies(sourceId) ? conn.facts : null,
		)
	}

	private onConnected(sourceId: string): void {
		this.clearTimer(sourceId)
		this.connections.set(sourceId, {
			header: null,
			headerSeen: false,
			facts: null,
			settled: null,
			timer: null,
			warnedConflict: false,
		})
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
		if (
			now.strength === "unit" ||
			now.strength === "unknown" ||
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
