import type { IncomingMessage, ServerResponse } from "node:http"
import { z } from "zod"
import { WaveKitError } from "../utils/errors.js"
import { ConnectionLeases } from "./connection-leases.js"
import type { ConnectionLease } from "./connection-leases.js"
import { accessRequestFromHttp } from "./http-request.js"
import type { AccessPolicy } from "./policy.js"
import type { SessionStore } from "./sessions.js"
import type { AccessPrincipal, AccessResponseHeaders } from "./types.js"

export interface NodeHttpAccessOptions {
	policy: AccessPolicy
	sessions: SessionStore
	/** Borrowed: disposing this adapter releases its leases, not this manager. */
	leases?: ConnectionLeases
	/** Includes machine streams, which have no browser session lease. */
	maxStreams?: number
}

/** Opaque admission capability. No cookie, Authorization header or URL is exposed. */
export interface AudioAccessContext {
	readonly request: Readonly<{ method: string; remoteAddress: string }>
	readonly principal: Readonly<AccessPrincipal>
}

interface AdmissionState {
	request: IncomingMessage
	response: ServerResponse
	principal: AccessPrincipal
	headers: AccessResponseHeaders
}

export interface AcceptedAudioStream {
	kind: "accepted"
	/** Recheck after asynchronous setup and after client registration. */
	active(): boolean
	/** Normal completion ends the response and releases caller resources. */
	release(): void
}

export type AudioStreamAdmission = AcceptedAudioStream | { kind: "rejected" }

interface ActiveStream {
	close(destroyResponse: boolean): void
}

const optionsSchema = z.object({
	maxStreams: z.number().int().min(1).max(512).default(512),
})
const defaultHeaders = { "Cache-Control": "no-store", Vary: "Origin" }

/**
 * Unmounted Node HTTP audio/download boundary. Future AudioHttpServer.handle():
 * admit(req,res), resolve the route, leaseStream(context,res,cleanup), then
 * acceptAudioStream/register ONLY on accepted+active. cleanup closes the actual
 * registry client (registry.close(client, "Access closed", true)), never a tuner
 * or scanner job. Recheck active() after async setup/registration and explicitly
 * close any newly created resource when false: teardown may precede assignment
 * of the caller's client/producer, so its earlier cleanup cannot close that object.
 *
 * For a download, destroyProducer closes its Readable. The caller attaches the
 * producer's error handler to res.destroy(); this adapter owns response cleanup.
 * Neither IncomingMessage's normal "close" nor passive audio renews a session.
 */
export class NodeHttpAccessAdapter {
	#policy: AccessPolicy
	#leases: ConnectionLeases
	#ownsLeases: boolean
	#maxStreams: number
	#admissions = new WeakMap<AudioAccessContext, AdmissionState>()
	#streams = new Set<ActiveStream>()
	#disposed = false

	constructor(options: NodeHttpAccessOptions) {
		const parsed = optionsSchema.safeParse(options)
		if (
			!parsed.success ||
			!options.policy.usesSessionStore(options.sessions) ||
			(options.leases && !options.leases.usesSessionStore(options.sessions))
		)
			throw new WaveKitError(
				"Invalid HTTP access configuration",
				"ACCESS_CONFIG_INVALID",
			)
		this.#policy = options.policy
		this.#ownsLeases = options.leases === undefined
		this.#leases = options.leases ?? new ConnectionLeases(options.sessions)
		this.#maxStreams = parsed.data.maxStreams
	}

	#safe(callback: () => void): void {
		try {
			callback()
		} catch {
			/* Cleanup failures must not skip another resource. */
		}
	}

	#deny(
		response: ServerResponse,
		status: number,
		code: string,
		headers: AccessResponseHeaders,
	): void {
		if (response.destroyed || response.writableEnded) return
		if (response.headersSent) {
			this.#safe(() => response.destroy())
			return
		}
		this.#safe(() => {
			for (const [name, value] of Object.entries(headers))
				response.setHeader(name, value)
			response.statusCode = status
			response.setHeader("Content-Type", "application/json; charset=utf-8")
			response.end(JSON.stringify({ code }))
		})
	}

	admit(
		request: IncomingMessage,
		response: ServerResponse,
	): AudioAccessContext | undefined {
		if (
			response.req !== request ||
			response.headersSent ||
			response.writableEnded ||
			response.destroyed ||
			request.aborted
		) {
			this.#deny(response, 400, "MALFORMED_REQUEST", defaultHeaders)
			return undefined
		}
		const original = accessRequestFromHttp(request, "audio")
		const admission = this.#policy.evaluate(original)
		if (this.#disposed) {
			// WG9 1.2: a shutdown 503 must not tell the browser to cache a preflight.
			const { "Access-Control-Max-Age": _maxAge, ...headers } =
				admission.headers
			this.#deny(response, 503, "ACCESS_UNAVAILABLE", headers)
			return undefined
		}
		if (admission.kind === "deny") {
			this.#deny(response, admission.status, admission.code, admission.headers)
			return undefined
		}
		for (const [name, value] of Object.entries(admission.headers))
			response.setHeader(name, value)
		if (admission.kind === "preflight") {
			response.statusCode = admission.status
			response.end()
			return undefined
		}
		if (admission.kind !== "authenticated" || original.transport !== "http") {
			this.#deny(response, 400, "MALFORMED_REQUEST", admission.headers)
			return undefined
		}
		const principal = Object.freeze({ ...admission.principal })
		const context: AudioAccessContext = Object.freeze({
			request: Object.freeze({
				method: original.method,
				remoteAddress: original.remoteAddress,
			}),
			principal,
		})
		this.#admissions.set(context, {
			request,
			response,
			principal,
			headers: admission.headers,
		})
		return context
	}

	leaseStream(
		context: AudioAccessContext,
		response: ServerResponse,
		cleanup: () => void,
		destroyProducer?: () => void,
	): AudioStreamAdmission {
		const state = this.#admissions.get(context)
		if (!state || state.response !== response) {
			this.#deny(response, 400, "MALFORMED_REQUEST", defaultHeaders)
			return { kind: "rejected" }
		}
		this.#admissions.delete(context)
		const reject = (status: number, code: string): AudioStreamAdmission => {
			this.#deny(response, status, code, state.headers)
			return { kind: "rejected" }
		}
		if (this.#disposed) return reject(503, "ACCESS_UNAVAILABLE")
		if (
			response.headersSent ||
			response.writableEnded ||
			response.destroyed ||
			state.request.aborted
		)
			return reject(400, "MALFORMED_REQUEST")
		if (this.#streams.size >= this.#maxStreams)
			return reject(429, "ACCESS_CAPACITY")
		let closed = false
		let lease: ConnectionLease | undefined
		const finish = () => stream.close(false)
		const abort = () => stream.close(true)
		const detach = () => {
			response.off("finish", finish)
			response.off("close", onClose)
			response.off("error", abort)
			state.request.off("aborted", abort)
			state.request.off("error", abort)
		}
		const onClose = () => {
			stream.close(true)
			detach()
		}
		const stream: ActiveStream = {
			close: destroyResponse => {
				if (closed) return
				closed = true
				this.#streams.delete(stream)
				response.off("finish", finish)
				state.request.off("aborted", abort)
				if (lease) this.#safe(() => lease?.release())
				if (destroyProducer) this.#safe(destroyProducer)
				this.#safe(cleanup)
				this.#safe(() => {
					if (destroyResponse) response.destroy()
					else if (!response.writableEnded && !response.destroyed)
						response.end()
				})
			},
		}
		if (state.principal.kind === "session") {
			try {
				const attached = this.#leases.attach(state.principal.id, abort)
				if (attached.kind === "rejected") {
					if (attached.reason === "capacity")
						return reject(429, "ACCESS_CAPACITY")
					const unavailable =
						attached.reason === "unavailable" || attached.reason === "disposed"
					return reject(
						unavailable ? 503 : 401,
						unavailable ? "ACCESS_UNAVAILABLE" : "AUTH_REQUIRED",
					)
				}
				lease = attached.lease
			} catch {
				return reject(503, "ACCESS_UNAVAILABLE")
			}
		}
		this.#streams.add(stream)
		response.once("finish", finish)
		response.once("close", onClose)
		// Retain error handlers until actual close, including destroy()'s async errors.
		response.on("error", abort)
		state.request.once("aborted", abort)
		state.request.on("error", abort)
		const active = () => {
			if (closed) return false
			if (
				response.destroyed ||
				response.writableEnded ||
				state.request.aborted
			) {
				abort()
				return false
			}
			if (lease && !lease.current()) {
				abort()
				return false
			}
			return true
		}
		return { kind: "accepted", active, release: finish }
	}

	/** Close this adapter's streams only; borrowed managers remain usable. */
	dispose(): void {
		if (this.#disposed) return
		this.#disposed = true
		for (const stream of [...this.#streams])
			this.#safe(() => stream.close(true))
		if (this.#ownsLeases) this.#safe(() => this.#leases.dispose())
	}
}
