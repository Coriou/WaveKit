import type { AccessDeviceDto } from "@wavekit/api-types"
import { randomBytes } from "node:crypto"
import { performance } from "node:perf_hooks"
import { WaveKitError } from "../utils/errors.js"
import {
	digestMachineToken,
	generateMachineToken,
	isCanonicalToken,
} from "./credentials.js"
import type { AccessRandomBytes } from "./credentials.js"
import { sessionOptionsSchema, sessionSnapshotSchema } from "./schema.js"

export interface SessionRecord {
	deviceId: string
	tokenHash: string
	csrfToken: string
	createdAt: number
	renewedAt: number
	expiresAt: number
}

/** Sensitive private-storage payload. Never put this in config or logs. */
export interface SessionSnapshot {
	version: 1
	credentialBinding: string
	sessions: SessionRecord[]
}

export type ActiveDevicesSnapshot =
	| { kind: "active"; devices: AccessDeviceDto[] }
	| { kind: "missing" }

export interface SessionMetadata {
	principalId: string
	csrfToken: string
	expiresAt: number
}

export interface SessionStoreOptions {
	credentialBinding: string
	/** Must durably and atomically replace the private snapshot before resolving. */
	persist: (snapshot: SessionSnapshot) => Promise<void>
	/** Startup input only; never reload stale snapshots into a running store. */
	snapshot?: unknown
	ttlMs?: number
	maxSessions?: number
	maxListenersPerSession?: number
	epochNow?: () => number
	monotonicNow?: () => number
	random?: AccessRandomBytes
}

interface CreatedSession extends SessionMetadata {
	kind: "created"
	cookieValue: string
	cookieMaxAgeSeconds: number
}

export type SessionCreation =
	| CreatedSession
	| { kind: "capacity"; status: 429; code: "SESSION_CAPACITY" }

export type SessionRenewal =
	| ({ kind: "renewed"; cookieMaxAgeSeconds: number } & SessionMetadata)
	| { kind: "missing" }

interface AttachedSessionLease {
	kind: "attached"
	unsubscribe: () => void
	current: () => SessionMetadata | undefined
}

export type SessionLease =
	| AttachedSessionLease
	| { kind: "invalidated" | "capacity" }

/**
 * Committed-state authority, with explicit rolling renewal and no background timer.
 * Long-lived adapters attach a lease before writing stream headers/accepting WS,
 * and re-read lease.current() at expiry: renewal may have extended its deadline.
 * Drive pruneExpired() externally. Invalidation callbacks are synchronous cleanup;
 * one failing callback never prevents the others. Listener limits also close the
 * rejected lease immediately. Persistence failures latch unavailable until restart.
 */
export class SessionStore {
	#records = new Map<string, SessionRecord>()
	#listeners = new Map<string, Set<() => void>>()
	#binding: string
	#ttl: number
	#maxSessions: number
	#maxListeners: number
	#persist: (snapshot: SessionSnapshot) => Promise<void>
	#random: AccessRandomBytes
	#monotonic: () => number
	#anchorMonotonic: number
	#anchorEpoch: number
	#lastNow: number
	#unavailable = false
	#queue: Promise<void> = Promise.resolve()

	private constructor(options: SessionStoreOptions) {
		const parsed = sessionOptionsSchema.safeParse(options)
		if (
			!parsed.success ||
			typeof options.persist !== "function" ||
			(options.random !== undefined && typeof options.random !== "function") ||
			(options.epochNow !== undefined &&
				typeof options.epochNow !== "function") ||
			(options.monotonicNow !== undefined &&
				typeof options.monotonicNow !== "function")
		)
			throw new WaveKitError(
				"Invalid session configuration",
				"ACCESS_CONFIG_INVALID",
			)
		this.#binding = parsed.data.credentialBinding
		this.#ttl = parsed.data.ttlMs
		this.#maxSessions = parsed.data.maxSessions
		this.#maxListeners = parsed.data.maxListenersPerSession
		this.#persist = options.persist
		this.#random = options.random ?? randomBytes
		this.#monotonic = options.monotonicNow ?? (() => performance.now())
		try {
			this.#anchorEpoch = (options.epochNow ?? Date.now)()
			this.#anchorMonotonic = this.#monotonic()
			if (
				!Number.isSafeInteger(this.#anchorEpoch) ||
				this.#anchorEpoch < 0 ||
				this.#anchorEpoch > Number.MAX_SAFE_INTEGER - this.#ttl ||
				!Number.isFinite(this.#anchorMonotonic)
			)
				throw new WaveKitError("Invalid session clock", "ACCESS_CONFIG_INVALID")
		} catch {
			throw new WaveKitError("Invalid session clock", "ACCESS_CONFIG_INVALID")
		}
		this.#lastNow = this.#anchorEpoch
	}

	/** Await startup before handing this authority to any listener. */
	static async open(options: SessionStoreOptions): Promise<SessionStore> {
		const store = new SessionStore(options)
		if (options.snapshot !== undefined) {
			const snapshot = store.#validateSnapshot(options.snapshot)
			// Rotation invalidates old browsers durably before admission begins.
			if (snapshot.credentialBinding !== store.#binding) {
				await store.#commit(new Map())
			} else {
				store.#records = new Map(
					snapshot.sessions.map(record => [record.deviceId, { ...record }]),
				)
				await store.pruneExpired()
			}
		}
		return store
	}

	get credentialBinding(): string {
		return this.#binding
	}
	get unavailable(): boolean {
		return this.#unavailable
	}

	#validateSnapshot(input: unknown): SessionSnapshot {
		const parsed = sessionSnapshotSchema.safeParse(input)
		if (!parsed.success || parsed.data.sessions.length > this.#maxSessions)
			throw new WaveKitError(
				"Invalid session snapshot",
				"SESSION_SNAPSHOT_INVALID",
			)
		const ids = new Set<string>()
		const hashes = new Set<string>()
		for (const record of parsed.data.sessions) {
			if (
				ids.has(record.deviceId) ||
				hashes.has(record.tokenHash) ||
				!isCanonicalToken(record.csrfToken) ||
				!isCanonicalToken(record.deviceId.slice(7)) ||
				digestMachineToken(record.csrfToken).toString("hex") ===
					record.tokenHash ||
				record.createdAt > record.renewedAt ||
				record.renewedAt > this.#lastNow ||
				record.expiresAt <= record.renewedAt ||
				record.expiresAt - record.renewedAt > this.#ttl
			)
				throw new WaveKitError(
					"Invalid session snapshot",
					"SESSION_SNAPSHOT_INVALID",
				)
			ids.add(record.deviceId)
			hashes.add(record.tokenHash)
		}
		return parsed.data
	}

	#now(): number {
		let monotonic: number
		try {
			monotonic = this.#monotonic()
		} catch {
			monotonic = NaN
		}
		if (!Number.isFinite(monotonic)) {
			this.#failClosed()
			throw new WaveKitError(
				"Session authority unavailable",
				"ACCESS_UNAVAILABLE",
			)
		}
		this.#lastNow = Math.max(
			this.#lastNow,
			Math.floor(
				this.#anchorEpoch + Math.max(0, monotonic - this.#anchorMonotonic),
			),
		)
		if (
			!Number.isSafeInteger(this.#lastNow) ||
			this.#lastNow > Number.MAX_SAFE_INTEGER - this.#ttl
		) {
			this.#failClosed()
			throw new WaveKitError(
				"Session authority unavailable",
				"ACCESS_UNAVAILABLE",
			)
		}
		return this.#lastNow
	}

	#metadata(record: SessionRecord): SessionMetadata {
		return {
			principalId: record.deviceId,
			csrfToken: record.csrfToken,
			expiresAt: record.expiresAt,
		}
	}

	#active(principalId: string): SessionRecord | undefined {
		if (this.#unavailable) return undefined
		const record = this.#records.get(principalId)
		let now: number
		try {
			now = this.#now()
		} catch {
			return undefined
		}
		if (record && record.expiresAt <= now) {
			this.#notify(principalId)
			return undefined
		}
		return record
	}

	lookup(cookieValue: string): SessionMetadata | undefined {
		if (this.#unavailable || !isCanonicalToken(cookieValue)) return undefined
		const hash = digestMachineToken(cookieValue).toString("hex")
		for (const record of this.#records.values()) {
			if (record.tokenHash === hash)
				return this.lookupByPrincipal(record.deviceId)
		}
		return undefined
	}

	lookupByPrincipal(principalId: string): SessionMetadata | undefined {
		const record = this.#active(principalId)
		return record ? this.#metadata(record) : undefined
	}

	/** Detached active committed inventory. Reads never queue, prune, persist or renew. */
	snapshotActiveDevices(requesterId: string): ActiveDevicesSnapshot {
		if (this.#unavailable)
			throw new WaveKitError(
				"Session authority unavailable",
				"ACCESS_UNAVAILABLE",
			)
		const now = this.#now()
		// The injected clock can reenter and invalidate authority. Capture only afterward.
		if (this.#unavailable)
			throw new WaveKitError(
				"Session authority unavailable",
				"ACCESS_UNAVAILABLE",
			)
		const records = this.#records
		const requester = records.get(requesterId)
		if (!requester || requester.expiresAt <= now) return { kind: "missing" }
		const devices: AccessDeviceDto[] = []
		for (const record of records.values()) {
			if (record.expiresAt <= now) continue
			devices.push({
				deviceId: record.deviceId,
				createdAt: record.createdAt,
				renewedAt: record.renewedAt,
				expiresAt: record.expiresAt,
				current: record.deviceId === requesterId,
			})
		}
		devices.sort(
			(a, b) =>
				a.createdAt - b.createdAt ||
				(a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0),
		)
		return { kind: "active", devices }
	}

	/** Explicit export is intentionally sensitive; instance JSON contains no state. */
	exportSnapshot(): SessionSnapshot {
		return this.#snapshot(this.#records)
	}

	#snapshot(records: Map<string, SessionRecord>): SessionSnapshot {
		return {
			version: 1,
			credentialBinding: this.#binding,
			sessions: [...records.values()].map(record => ({ ...record })),
		}
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const task = this.#queue.then(() => {
			if (this.#unavailable)
				throw new WaveKitError(
					"Session authority unavailable",
					"ACCESS_UNAVAILABLE",
				)
			return operation()
		})
		this.#queue = task.then(
			() => undefined,
			() => undefined,
		)
		return task
	}

	#remaining(now: number): Map<string, SessionRecord> {
		return new Map(
			[...this.#records].filter(([, record]) => record.expiresAt > now),
		)
	}

	async #commit(next: Map<string, SessionRecord>): Promise<void> {
		try {
			await this.#persist(this.#snapshot(next))
		} catch {
			this.#failClosed()
			throw new WaveKitError(
				"Session authority unavailable",
				"ACCESS_UNAVAILABLE",
			)
		}
		if (this.#unavailable)
			throw new WaveKitError(
				"Session authority unavailable",
				"ACCESS_UNAVAILABLE",
			)
		const previous = this.#records
		this.#records = next
		for (const id of previous.keys()) if (!next.has(id)) this.#notify(id)
	}

	#failClosed(): void {
		this.#unavailable = true
		for (const id of [...this.#listeners.keys()]) this.#notify(id)
	}

	#notify(principalId: string): void {
		const listeners = this.#listeners.get(principalId)
		this.#listeners.delete(principalId)
		const callbacks = listeners ? [...listeners] : []
		listeners?.clear()
		for (const callback of callbacks) this.#cleanup(callback)
	}

	#cleanup(callback: () => void): void {
		try {
			callback()
		} catch {
			/* Cleanup must continue for other leases. */
		}
	}

	create(
		options: { replacePrincipalId?: string } = {},
	): Promise<SessionCreation> {
		return this.#enqueue(async () => {
			const now = this.#now()
			const next = this.#remaining(now)
			if (options.replacePrincipalId) next.delete(options.replacePrincipalId)
			if (next.size >= this.#maxSessions)
				return { kind: "capacity", status: 429, code: "SESSION_CAPACITY" }
			for (let attempt = 0; attempt < 8; attempt++) {
				const cookieValue = generateMachineToken(this.#random)
				const tokenHash = digestMachineToken(cookieValue).toString("hex")
				const csrfToken = generateMachineToken(this.#random)
				const deviceId = `device_${generateMachineToken(this.#random)}`
				if (
					cookieValue === csrfToken ||
					this.#records.has(deviceId) ||
					[...this.#records.values()].some(
						record => record.tokenHash === tokenHash,
					)
				)
					continue
				const record: SessionRecord = {
					deviceId,
					tokenHash,
					csrfToken,
					createdAt: now,
					renewedAt: now,
					expiresAt: now + this.#ttl,
				}
				next.set(deviceId, record)
				await this.#commit(next)
				return {
					kind: "created",
					cookieValue,
					cookieMaxAgeSeconds: Math.ceil(this.#ttl / 1000),
					...this.#metadata(record),
				}
			}
			throw new WaveKitError(
				"Session generation failed",
				"SESSION_GENERATION_FAILED",
			)
		})
	}

	/** Called only by an authenticated, Origin+CSRF-checked refresh adapter. */
	renew(principalId: string): Promise<SessionRenewal> {
		return this.#enqueue(async () => {
			const now = this.#now()
			const next = this.#remaining(now)
			const record = next.get(principalId)
			if (!record) return { kind: "missing" }
			const renewed = { ...record, renewedAt: now, expiresAt: now + this.#ttl }
			next.set(principalId, renewed)
			await this.#commit(next)
			return {
				kind: "renewed",
				cookieMaxAgeSeconds: Math.ceil(this.#ttl / 1000),
				...this.#metadata(renewed),
			}
		})
	}

	revoke(principalId: string): Promise<boolean> {
		return this.#enqueue(async () => {
			const next = new Map(this.#records)
			if (!next.delete(principalId)) return false
			await this.#commit(next)
			return true
		})
	}

	revokeAll(): Promise<void> {
		return this.#enqueue(async () => {
			if (this.#records.size > 0) await this.#commit(new Map())
		})
	}

	pruneExpired(): Promise<number> {
		return this.#enqueue(async () => {
			const next = this.#remaining(this.#now())
			const removed = this.#records.size - next.size
			// Close expired leases even while persistence is pending.
			for (const id of this.#records.keys()) if (!next.has(id)) this.#notify(id)
			if (removed > 0) await this.#commit(next)
			return removed
		})
	}

	/** Rechecks validity to close admission→revocation→attachment races. */
	onInvalidated(principalId: string, callback: () => void): SessionLease {
		if (!this.#active(principalId)) {
			this.#cleanup(callback)
			return { kind: "invalidated" }
		}
		const listeners = this.#listeners.get(principalId) ?? new Set<() => void>()
		if (listeners.size >= this.#maxListeners) {
			this.#cleanup(callback)
			return { kind: "capacity" }
		}
		// A wrapper counts each attachment independently, even with shared callbacks.
		const listener = () => callback()
		listeners.add(listener)
		this.#listeners.set(principalId, listeners)
		return {
			kind: "attached",
			current: () => this.lookupByPrincipal(principalId),
			unsubscribe: () => {
				listeners.delete(listener)
				if (
					listeners.size === 0 &&
					this.#listeners.get(principalId) === listeners
				)
					this.#listeners.delete(principalId)
			},
		}
	}
}
