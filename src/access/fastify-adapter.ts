import type { ServerResponse } from "node:http"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocket } from "ws"
import { WaveKitError } from "../utils/errors.js"
import { ConnectionLeases } from "./connection-leases.js"
import type {
	ConnectionLease,
	ConnectionLeaseResult,
} from "./connection-leases.js"
import { accessRequestFromHttp } from "./http-request.js"
import type { AccessPolicy } from "./policy.js"
import type { SessionStore } from "./sessions.js"
import type { AccessPrincipal } from "./types.js"

export interface FastifyAccessOptions {
	policy: AccessPolicy
	sessions: SessionStore
	leases?: ConnectionLeases
	webSocketCloseGraceMs?: number
}

interface UpgradeReservation {
	request: FastifyRequest
	lease?: ConnectionLease
	socket?: WebSocket
	timer?: ReturnType<typeof setTimeout>
	closed: boolean
	closing: boolean
	cleanup: () => void
}

export type DownloadLeaseResult =
	| { kind: "attached"; active: () => boolean; release: () => void }
	| Extract<ConnectionLeaseResult, { kind: "rejected" }>

/** Install directly on the root instance before routes and WebSocket plugins. */
export function installAccessHooks(
	app: FastifyInstance,
	options: FastifyAccessOptions,
): FastifyAccessController {
	const controller = new FastifyAccessController(options)
	const policy = options.policy
	app.addHook("onRequest", async (request, reply) => {
		const original = accessRequestFromHttp(request.raw, "api")
		const pair =
			original.method === "POST" && original.rawTarget === "/api/access/pair"
		const admission = pair
			? policy.validatePairingRequest(original)
			: policy.evaluate(original)
		for (const [name, value] of Object.entries(admission.headers))
			reply.header(name, value)
		if (admission.kind === "deny")
			return reply.code(admission.status).send({ code: admission.code })
		if (admission.kind === "preflight") return reply.code(204).send()
		if (admission.kind === "authenticated") {
			controller.admit(request, admission.principal)
			if (original.transport === "websocket") {
				const rejected = controller.reserveUpgrade(request)
				if (rejected)
					return reply.code(rejected.status).send({ code: rejected.code })
			}
		}
	})
	app.addHook("onResponse", async request => controller.finishRequest(request))
	// preClose precedes a WebSocket plugin's server-close wait; onClose is a fallback.
	app.addHook("preClose", async () => controller.dispose())
	app.addHook("onClose", async () => controller.dispose())
	return controller
}

/** Context contains admitted identities only; credentials stay in the raw request. */
export class FastifyAccessController {
	#sessions: SessionStore
	#leases: ConnectionLeases
	#ownsLeases: boolean
	#grace: number
	#principals = new WeakMap<FastifyRequest, AccessPrincipal>()
	#upgrades = new WeakMap<FastifyRequest, UpgradeReservation>()
	#pending = new Set<UpgradeReservation>()
	#downloads = new Set<() => void>()
	#disposed = false

	constructor(options: FastifyAccessOptions) {
		const grace = options.webSocketCloseGraceMs ?? 1000
		if (
			!options.policy.usesSessionStore(options.sessions) ||
			(options.leases && !options.leases.usesSessionStore(options.sessions)) ||
			!Number.isSafeInteger(grace) ||
			grace < 1 ||
			grace > 5000
		)
			throw new WaveKitError(
				"Invalid access adapter configuration",
				"ACCESS_CONFIG_INVALID",
			)
		this.#sessions = options.sessions
		this.#ownsLeases = options.leases === undefined
		this.#leases = options.leases ?? new ConnectionLeases(options.sessions)
		this.#grace = grace
	}

	admit(request: FastifyRequest, principal: AccessPrincipal): void {
		this.#principals.set(request, { ...principal })
	}

	principalOf(request: FastifyRequest): AccessPrincipal | undefined {
		const principal = this.#principals.get(request)
		return principal ? { ...principal } : undefined
	}

	reserveUpgrade(
		request: FastifyRequest,
	): { status: 401 | 429 | 503; code: string } | undefined {
		const principal = this.#principals.get(request)
		if (this.#disposed) return { status: 503, code: "ACCESS_UNAVAILABLE" }
		if (!principal) return { status: 401, code: "AUTH_REQUIRED" }
		// Bound machine reservations too, including close fallback timers.
		if (this.#pending.size >= 512)
			return { status: 429, code: "ACCESS_CAPACITY" }
		const reservation: UpgradeReservation = {
			request,
			closed: false,
			closing: false,
			cleanup: () => {},
		}
		if (principal.kind === "session") {
			let result: ConnectionLeaseResult
			try {
				result = this.#leases.attach(principal.id, () =>
					this.#invalidate(reservation),
				)
			} catch {
				return { status: 503, code: "ACCESS_UNAVAILABLE" }
			}
			if (result.kind === "rejected")
				return result.reason === "capacity"
					? { status: 429, code: "ACCESS_CAPACITY" }
					: result.reason === "invalidated"
						? { status: 401, code: "AUTH_REQUIRED" }
						: { status: 503, code: "ACCESS_UNAVAILABLE" }
			reservation.lease = result.lease
		}
		const raw = request.raw.socket
		const release = () => this.#release(reservation)
		raw.once("close", release)
		raw.once("error", release)
		reservation.cleanup = () => {
			raw.off("close", release)
			raw.off("error", release)
		}
		this.#upgrades.set(request, reservation)
		this.#pending.add(reservation)
		return undefined
	}

	/** Call synchronously before registering the socket with any broadcaster. */
	adoptWebSocket(request: FastifyRequest, socket: WebSocket): boolean {
		const entry = this.#upgrades.get(request)
		if (!entry || entry.closed || entry.socket || this.#disposed) {
			socket.terminate()
			return false
		}
		entry.socket = socket
		const release = () => this.#release(entry)
		socket.once("close", release)
		socket.once("error", release)
		const rawCleanup = entry.cleanup
		entry.cleanup = () => {
			rawCleanup()
			socket.off("close", release)
			socket.off("error", release)
		}
		if (entry.closing || (entry.lease && !entry.lease.current())) {
			this.#invalidate(entry)
			return false
		}
		return true
	}

	finishRequest(request: FastifyRequest): void {
		const entry = this.#upgrades.get(request)
		if (entry && !entry.socket) this.#release(entry)
		// Denial can stop the plugin's onRequest hook, so request.ws is not reliable.
		// onResponse runs after the complete HTTP denial has been flushed.
		if (
			!entry?.socket &&
			accessRequestFromHttp(request.raw, "api").transport === "websocket"
		)
			request.raw.socket.destroy()
	}

	#invalidate(entry: UpgradeReservation): void {
		if (entry.closed || entry.closing) return
		entry.closing = true
		entry.lease?.release()
		if (!entry.socket) {
			entry.request.raw.socket.destroy()
			this.#release(entry)
			return
		}
		try {
			entry.socket.close(1008, "Access expired")
		} catch {
			entry.socket.terminate()
		}
		if (!entry.closed) {
			entry.timer = setTimeout(() => {
				entry.socket?.terminate()
				this.#release(entry)
			}, this.#grace)
			entry.timer.unref()
		}
	}

	#release(entry: UpgradeReservation): void {
		if (entry.closed) return
		entry.closed = true
		if (entry.timer) clearTimeout(entry.timer)
		entry.cleanup()
		entry.lease?.release()
		this.#pending.delete(entry)
		this.#upgrades.delete(entry.request)
	}

	/**
	 * Reserve before opening a producer or sending headers. After asynchronous setup,
	 * check active() before writing; dispose a newly created producer yourself if an
	 * earlier invalidation ran before it existed. release() cancels the transport.
	 * Normal request close is ignored; response finish also stops the producer.
	 */
	leaseDownload(
		request: FastifyRequest,
		response: ServerResponse,
		destroyProducer: () => void,
	): DownloadLeaseResult {
		if (
			response.req !== request.raw ||
			response.headersSent ||
			response.writableEnded ||
			response.destroyed ||
			request.raw.aborted
		)
			return { kind: "rejected", reason: "invalidated" }
		const principal = this.#principals.get(request)
		if (this.#disposed) return { kind: "rejected", reason: "disposed" }
		if (!principal) return { kind: "rejected", reason: "invalidated" }
		if (this.#downloads.size >= 512)
			return { kind: "rejected", reason: "capacity" }
		let lease: ConnectionLease | undefined
		let released = false
		const finish = () => {
			if (released) return
			released = true
			lease?.release()
			request.raw.off("aborted", stopped)
			response.off("finish", finish)
			try {
				destroyProducer()
			} catch {
				/* Producer failures must not escape transport event handlers. */
			}
		}
		const stopped = () => {
			finish()
			response.destroy()
		}
		const closed = () => {
			finish()
			response.off("finish", finish)
			response.off("error", stopped)
			response.off("close", closed)
			this.#downloads.delete(stopped)
		}
		const active = () => {
			if (released) return false
			if (
				this.#disposed ||
				response.destroyed ||
				response.writableEnded ||
				request.raw.aborted ||
				(lease && !lease.current())
			) {
				stopped()
				return false
			}
			return !released
		}
		if (principal.kind === "session") {
			let result: ConnectionLeaseResult
			try {
				result = this.#leases.attach(principal.id, stopped)
			} catch {
				return { kind: "rejected", reason: "unavailable" }
			}
			if (result.kind === "rejected") return result
			lease = result.lease
		}
		response.once("finish", finish)
		// Keep the error sink through asynchronous destroy/pipeline errors until close.
		response.on("error", stopped)
		response.once("close", closed)
		request.raw.once("aborted", stopped)
		this.#downloads.add(stopped)
		if (!active())
			return {
				kind: "rejected",
				reason: this.#sessions.unavailable ? "unavailable" : "invalidated",
			}
		return { kind: "attached", active, release: stopped }
	}

	/** Does not dispose an injected shared lease manager; releases only this listener's leases. */
	dispose(): void {
		if (this.#disposed) return
		this.#disposed = true
		for (const entry of [...this.#pending]) {
			if (entry.socket) {
				try {
					entry.socket.close(1008, "Access expired")
				} catch {
					/* Continue disposal even if a closing transport rejects close(). */
				} finally {
					entry.socket.terminate()
				}
			} else entry.request.raw.socket.destroy()
			this.#release(entry)
		}
		for (const stop of [...this.#downloads]) {
			try {
				stop()
			} catch {
				/* Continue cleanup after a producer failure. */
			}
		}
		if (this.#ownsLeases) this.#leases.dispose()
	}
}
