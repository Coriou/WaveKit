import { accessDeviceLabelRequestSchema } from "@wavekit/api-types"
import type { AccessDevicesDto } from "@wavekit/api-types"
import { z } from "zod"
import { WaveKitError } from "../utils/errors.js"
import { projectAccessDevices } from "./device-projection.js"
import {
	admissionDenial,
	flowDenial,
	flowSuccess,
	SessionCookies,
} from "./cookies.js"
import type { AccessFlowResult } from "./cookies.js"
import { MachineDeviceAuthority } from "./machine-devices.js"
import type { MachineAccessDevicesDto } from "./machine-devices.js"
import type { PairedSession } from "./pairing.js"
import type { AccessPolicy } from "./policy.js"
import type { SessionStore } from "./sessions.js"
import type { AccessRequest, AuthenticatedAdmission } from "./types.js"

const revokeSchema = z
	.object({ deviceId: z.string().regex(/^device_[A-Za-z0-9_-]{43}$/) })
	.strict()

export interface SessionFlowsOptions {
	policy: AccessPolicy
	sessions: SessionStore
	/** Machine-administration budget only. Session clocks stay on the store. */
	monotonicNow?: () => number
}

/** Original requests are authorized at execution, including queued mutations. */
export class SessionFlows {
	#policy: AccessPolicy
	#sessions: SessionStore
	#cookies: SessionCookies
	#machines: MachineDeviceAuthority
	#queue: Promise<void> = Promise.resolve()

	constructor(options: SessionFlowsOptions) {
		if (!options.policy.usesSessionStore(options.sessions))
			throw new WaveKitError(
				"Invalid session flow configuration",
				"ACCESS_CONFIG_INVALID",
			)
		this.#policy = options.policy
		this.#sessions = options.sessions
		this.#cookies = new SessionCookies(options.policy)
		this.#machines = new MachineDeviceAuthority({
			policy: options.policy,
			sessions: options.sessions,
			enqueue: operation => this.#enqueue(operation),
			...(options.monotonicNow === undefined
				? {}
				: { monotonicNow: options.monotonicNow }),
		})
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const task = this.#queue.then(operation)
		this.#queue = task.then(
			() => undefined,
			() => undefined,
		)
		return task
	}

	#admit(
		request: AccessRequest,
		method: string,
		path: string,
	): AuthenticatedAdmission | AccessFlowResult<never> {
		const admission = this.#policy.evaluate(request)
		if (admission.kind === "deny") return admissionDenial(admission)
		if (
			request.surface !== "api" ||
			request.transport !== "http" ||
			request.method !== method ||
			request.rawTarget !== path
		)
			return flowDenial(400, "MALFORMED_REQUEST", admission.headers)
		if (
			admission.kind !== "authenticated" ||
			admission.principal.kind !== "session" ||
			!admission.sessionCookie
		)
			return flowDenial(403, "SESSION_REQUIRED", admission.headers)
		return admission
	}

	#missing(admission: AuthenticatedAdmission): AccessFlowResult<never> {
		return flowDenial(
			this.#sessions.unavailable ? 503 : 401,
			this.#sessions.unavailable ? "ACCESS_UNAVAILABLE" : "AUTH_REQUIRED",
			admission.headers,
		)
	}

	#metadata(admission: AuthenticatedAdmission): PairedSession | undefined {
		const session = this.#sessions.lookupByPrincipal(admission.principal.id)
		return session
			? {
					deviceId: session.principalId,
					expiresAt: session.expiresAt,
					csrfToken: session.csrfToken,
				}
			: undefined
	}

	#mutate<T>(
		request: AccessRequest,
		path: string,
		operation: (
			admission: AuthenticatedAdmission,
		) => Promise<AccessFlowResult<T>>,
	): Promise<AccessFlowResult<T>> {
		// Capture request facts before queueing, never retain caller-mutable headers.
		const original = { ...request, rawHeaders: [...request.rawHeaders] }
		return this.#enqueue(async () => {
			const admission = this.#admit(original, "POST", path)
			if (admission.kind !== "authenticated") return admission
			try {
				return await operation(admission)
			} catch {
				return flowDenial(503, "ACCESS_UNAVAILABLE", admission.headers)
			}
		})
	}

	machineDevices(
		request: AccessRequest,
	): AccessFlowResult<MachineAccessDevicesDto> {
		return this.#machines.devices(request)
	}

	machineRevoke(
		request: AccessRequest,
		body: unknown,
	): Promise<AccessFlowResult<{ revoked: boolean }>> {
		return this.#machines.revoke(request, body)
	}

	machineRevokeAll(
		request: AccessRequest,
	): Promise<AccessFlowResult<{ revoked: true }>> {
		return this.#machines.revokeAll(request)
	}

	status(request: AccessRequest): AccessFlowResult<PairedSession> {
		const admission = this.#admit(request, "GET", "/api/access/session")
		if (admission.kind !== "authenticated") return admission
		const metadata = this.#metadata(admission)
		return metadata
			? flowSuccess(metadata, admission.headers)
			: this.#missing(admission)
	}

	devices(request: AccessRequest): AccessFlowResult<AccessDevicesDto> {
		const admission = this.#admit(
			request,
			request.method === "HEAD" ? "HEAD" : "GET",
			"/api/access/devices",
		)
		if (admission.kind !== "authenticated") return admission
		try {
			// Original request authorization immediately precedes synchronous authority revalidation.
			const snapshot = this.#sessions.snapshotActiveDevices(
				admission.principal.id,
			)
			return snapshot.kind === "active"
				? flowSuccess(projectAccessDevices(snapshot.devices), admission.headers)
				: this.#missing(admission)
		} catch {
			return flowDenial(503, "ACCESS_UNAVAILABLE", admission.headers)
		}
	}

	refresh(request: AccessRequest): Promise<AccessFlowResult<PairedSession>> {
		return this.#mutate(
			request,
			"/api/access/session/refresh",
			async admission => {
				const renewed = await this.#sessions.renew(admission.principal.id)
				if (renewed.kind === "missing") return this.#missing(admission)
				const metadata = this.#metadata(admission)
				if (!metadata || !admission.sessionCookie)
					return this.#missing(admission)
				return flowSuccess(
					metadata,
					admission.headers,
					this.#cookies.issue(
						admission.sessionCookie,
						renewed.cookieMaxAgeSeconds,
					),
				)
			},
		)
	}

	logout(request: AccessRequest): Promise<AccessFlowResult<{ revoked: true }>> {
		return this.#mutate(
			request,
			"/api/access/session/logout",
			async admission => {
				await this.#sessions.revoke(admission.principal.id)
				return flowSuccess(
					{ revoked: true as const },
					admission.headers,
					this.#cookies.clear(),
				)
			},
		)
	}

	label(
		request: AccessRequest,
		body: unknown,
	): Promise<AccessFlowResult<{ updated: boolean }>> {
		// Parse before asynchronous queueing so a later mutation of the body
		// cannot change the name, kind or device.
		const parsed = accessDeviceLabelRequestSchema.safeParse(body)
		return this.#mutate(
			request,
			"/api/access/devices/label",
			async admission => {
				if (!parsed.success)
					return flowDenial(400, "MALFORMED_REQUEST", admission.headers)
				const updated = await this.#sessions.label(parsed.data.deviceId, {
					...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
					...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
				})
				if (!this.#metadata(admission)) return this.#missing(admission)
				return flowSuccess({ updated }, admission.headers)
			},
		)
	}

	revoke(
		request: AccessRequest,
		body: unknown,
	): Promise<AccessFlowResult<{ revoked: boolean }>> {
		// Parse before asynchronous queueing so mutation cannot change the target.
		const parsed = revokeSchema.safeParse(body)
		return this.#mutate(
			request,
			"/api/access/devices/revoke",
			async admission => {
				if (!parsed.success)
					return flowDenial(400, "MALFORMED_REQUEST", admission.headers)
				const revoked = await this.#sessions.revoke(parsed.data.deviceId)
				if (parsed.data.deviceId === admission.principal.id)
					return flowSuccess(
						{ revoked },
						admission.headers,
						this.#cookies.clear(),
					)
				if (!this.#metadata(admission)) return this.#missing(admission)
				return flowSuccess({ revoked }, admission.headers)
			},
		)
	}

	revokeAll(
		request: AccessRequest,
	): Promise<AccessFlowResult<{ revoked: true }>> {
		return this.#mutate(
			request,
			"/api/access/devices/revoke-all",
			async admission => {
				await this.#sessions.revokeAll()
				return flowSuccess(
					{ revoked: true as const },
					admission.headers,
					this.#cookies.clear(),
				)
			},
		)
	}
}
