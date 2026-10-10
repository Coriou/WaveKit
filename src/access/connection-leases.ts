import { z } from "zod"
import { WaveKitError } from "../utils/errors.js"
import type { SessionLease, SessionMetadata, SessionStore } from "./sessions.js"

export interface LeaseTimers {
	set(callback: () => void, delayMs: number): unknown
	clear(handle: unknown): void
}

export interface ConnectionLeaseOptions {
	/** Maximum scheduled expiry-check delay; event-loop stalls can add delay. */
	checkIntervalMs?: number
	maxConnections?: number
	timers?: LeaseTimers
}

export interface ConnectionLease {
	current(): SessionMetadata | undefined
	/** Normal transport completion: unsubscribe without invoking invalidation. */
	release(): void
}

interface AttachedConnection {
	kind: "attached"
	lease: ConnectionLease
}

interface RejectedConnection {
	kind: "rejected"
	reason: "invalidated" | "capacity" | "unavailable" | "disposed"
}

export type ConnectionLeaseResult = AttachedConnection | RejectedConnection

interface Entry {
	authority: Extract<SessionLease, { kind: "attached" }> | undefined
	closed: boolean
	delivered: boolean
	onInvalidated: () => void
}

const optionsSchema = z.object({
	checkIntervalMs: z.number().int().min(1).max(1000).default(250),
	maxConnections: z.number().int().min(1).max(512).default(512),
})

const defaultTimers: LeaseTimers = {
	set(callback, delayMs) {
		const timer = setTimeout(callback, delayMs)
		timer.unref()
		return timer
	},
	clear(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>)
	},
}

/**
 * Unmounted transport lifetime manager. Admission remains the caller's job.
 * Polls the store's authoritative monotonic clock through current(), never a
 * wall-clock expiry calculation. One bounded timer serves all active leases.
 */
export class ConnectionLeases {
	#sessions: SessionStore
	#timers: LeaseTimers
	#interval: number
	#capacity: number
	#entries = new Set<Entry>()
	#timer: unknown
	#scheduled = false
	#disposed = false

	constructor(sessions: SessionStore, options: ConnectionLeaseOptions = {}) {
		const parsed = optionsSchema.safeParse(options)
		if (
			!parsed.success ||
			(options.timers !== undefined &&
				(typeof options.timers.set !== "function" ||
					typeof options.timers.clear !== "function"))
		)
			throw new WaveKitError(
				"Invalid lease configuration",
				"ACCESS_CONFIG_INVALID",
			)
		this.#sessions = sessions
		this.#timers = options.timers ?? defaultTimers
		this.#interval = parsed.data.checkIntervalMs
		this.#capacity = parsed.data.maxConnections
	}

	usesSessionStore(sessions: SessionStore): boolean {
		return this.#sessions === sessions
	}

	attach(
		principalId: string,
		onInvalidated: () => void,
	): ConnectionLeaseResult {
		if (this.#disposed) return { kind: "rejected", reason: "disposed" }
		if (this.#sessions.unavailable)
			return { kind: "rejected", reason: "unavailable" }
		if (this.#entries.size >= this.#capacity)
			return { kind: "rejected", reason: "capacity" }
		const entry: Entry = {
			authority: undefined,
			closed: false,
			delivered: false,
			onInvalidated,
		}
		const authority = this.#sessions.onInvalidated(principalId, () =>
			this.#close(entry, true),
		)
		if (authority.kind !== "attached")
			return {
				kind: "rejected",
				reason: this.#sessions.unavailable ? "unavailable" : authority.kind,
			}
		entry.authority = authority
		if (entry.closed || !authority.current()) {
			this.#close(entry, false)
			return {
				kind: "rejected",
				reason: this.#sessions.unavailable ? "unavailable" : "invalidated",
			}
		}
		this.#entries.add(entry)
		try {
			this.#schedule()
		} catch {
			this.#close(entry, false)
			throw new WaveKitError(
				"Lease scheduler unavailable",
				"ACCESS_UNAVAILABLE",
			)
		}
		entry.delivered = true
		return {
			kind: "attached",
			lease: {
				current: () => (entry.closed ? undefined : authority.current()),
				release: () => this.#close(entry, false),
			},
		}
	}

	#close(entry: Entry, invalidated: boolean): void {
		if (entry.closed) return
		entry.closed = true
		entry.authority?.unsubscribe()
		this.#entries.delete(entry)
		if (this.#entries.size === 0 && this.#scheduled) {
			this.#scheduled = false
			this.#timers.clear(this.#timer)
		}
		if (invalidated && entry.delivered) {
			try {
				entry.onInvalidated()
			} catch {
				/* A transport cleanup failure must not skip another connection. */
			}
		}
	}

	#schedule(): void {
		if (this.#scheduled || this.#disposed || this.#entries.size === 0) return
		this.#timer = this.#timers.set(() => {
			this.#scheduled = false
			for (const entry of [...this.#entries]) {
				if (!entry.authority?.current()) this.#close(entry, true)
			}
			try {
				this.#schedule()
			} catch {
				this.dispose()
			}
		}, this.#interval)
		this.#scheduled = true
	}

	/** Shutdown invalidates transports once and releases every timer/listener. */
	dispose(): void {
		if (this.#disposed) return
		this.#disposed = true
		for (const entry of [...this.#entries]) this.#close(entry, true)
	}
}
