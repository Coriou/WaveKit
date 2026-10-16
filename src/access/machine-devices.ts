import { performance } from "node:perf_hooks"
import {
	ACCESS_DEVICES_LIMITS,
	accessDeviceDtoSchema,
} from "@wavekit/api-types"
import { z } from "zod"
import { WaveKitError } from "../utils/errors.js"
import { admissionDenial, flowDenial, flowSuccess } from "./cookies.js"
import type { AccessFlowResult } from "./cookies.js"
import type { AccessPolicy } from "./policy.js"
import type { SessionStore } from "./sessions.js"
import type { AccessRequest, AccessResponseHeaders } from "./types.js"

export const MACHINE_DEVICE_ROUTES = Object.freeze({
	list: "/api/access/machine/devices",
	revoke: "/api/access/machine/devices/revoke",
	revokeAll: "/api/access/machine/devices/revoke-all",
})

const WINDOW_MS = 60_000
const MAX_ADDRESSES = 128
const ADDRESS_IDLE_MS = 10 * 60_000
const ADDRESS_LIMIT = 5
const GLOBAL_LIMIT = 60

const revokeSchema = z
	.object({ deviceId: z.string().regex(/^device_[A-Za-z0-9_-]{43}$/) })
	.strict()

/**
 * Same device row as the browser inventory. A machine principal is not a
 * remembered browser, so every `current` flag is false and the list may be empty.
 * The browser AccessDevicesDto still requires exactly one current requester.
 */
export const machineAccessDevicesDtoSchema = z
	.object({
		devices: z
			.array(accessDeviceDtoSchema)
			.max(ACCESS_DEVICES_LIMITS.maxDevices),
	})
	.strict()
	.superRefine(({ devices }, ctx) => {
		const ids = new Set<string>()
		for (let i = 0; i < devices.length; i++) {
			const device = devices[i]
			if (!device) continue
			if (device.current)
				ctx.addIssue({
					code: "custom",
					message: "Machine inventory has no requester",
				})
			const previous = devices[i - 1]
			if (
				ids.has(device.deviceId) ||
				(previous &&
					(previous.createdAt > device.createdAt ||
						(previous.createdAt === device.createdAt &&
							previous.deviceId >= device.deviceId)))
			)
				ctx.addIssue({
					code: "custom",
					message: "Invalid device ordering or identity",
				})
			ids.add(device.deviceId)
		}
	})

export type MachineAccessDevicesDto = z.infer<
	typeof machineAccessDevicesDtoSchema
>

/** Explicit projection: private session records never escape. */
export function projectMachineAccessDevices(
	input: unknown,
): MachineAccessDevicesDto {
	try {
		if (
			!Array.isArray(input) ||
			input.length > ACCESS_DEVICES_LIMITS.maxDevices
		)
			throw new WaveKitError(
				"Device inventory unavailable",
				"ACCESS_UNAVAILABLE",
			)
		const devices = input.map((value: unknown) => {
			if (!value || typeof value !== "object")
				throw new WaveKitError(
					"Device inventory unavailable",
					"ACCESS_UNAVAILABLE",
				)
			const row = value as Record<string, unknown>
			return {
				deviceId: row["deviceId"],
				createdAt: row["createdAt"],
				renewedAt: row["renewedAt"],
				expiresAt: row["expiresAt"],
				current: row["current"],
				name: "name" in row ? row["name"] : null,
				kind: "kind" in row ? row["kind"] : null,
				lastSeenAt: "lastSeenAt" in row ? row["lastSeenAt"] : null,
			}
		})
		const parsed = machineAccessDevicesDtoSchema.safeParse({ devices })
		if (!parsed.success)
			throw new WaveKitError(
				"Device inventory unavailable",
				"ACCESS_UNAVAILABLE",
			)
		return parsed.data
	} catch {
		throw new WaveKitError("Device inventory unavailable", "ACCESS_UNAVAILABLE")
	}
}

interface AddressBucket {
	attempts: number[]
	lastAt: number
}

type Prepared =
	| { kind: "ok"; headers: AccessResponseHeaders }
	| { kind: "deny"; denial: AccessFlowResult<never> }

export interface MachineDeviceAuthorityOptions {
	policy: AccessPolicy
	sessions: SessionStore
	monotonicNow?: () => number
	enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}

/**
 * Machine-bearer device administration. Cookie sessions are rejected, nothing
 * is renewed, and mutations share the session-flow queue. The request budget
 * matches pairing redemption: 5 attempts per minute per connection address,
 * 60 per minute globally, and 128 address buckets.
 */
export class MachineDeviceAuthority {
	#policy: AccessPolicy
	#sessions: SessionStore
	#enqueue: <T>(operation: () => Promise<T>) => Promise<T>
	#clock: () => number
	#lastNow = 0
	#unavailable = false
	#addresses = new Map<string, AddressBucket>()
	#globalAttempts: number[] = []

	constructor(options: MachineDeviceAuthorityOptions) {
		if (
			!options.policy.usesSessionStore(options.sessions) ||
			typeof options.enqueue !== "function" ||
			(options.monotonicNow !== undefined &&
				typeof options.monotonicNow !== "function")
		)
			throw new WaveKitError(
				"Invalid machine device configuration",
				"ACCESS_CONFIG_INVALID",
			)
		this.#policy = options.policy
		this.#sessions = options.sessions
		this.#enqueue = options.enqueue
		this.#clock = options.monotonicNow ?? (() => performance.now())
	}

	devices(request: AccessRequest): AccessFlowResult<MachineAccessDevicesDto> {
		const method = request.method === "HEAD" ? "HEAD" : "GET"
		const prepared = this.#prepare(
			request,
			method,
			MACHINE_DEVICE_ROUTES.list,
			true,
		)
		if (prepared.kind === "deny") return prepared.denial
		try {
			return flowSuccess(
				projectMachineAccessDevices(this.#sessions.snapshotRememberedDevices()),
				prepared.headers,
			)
		} catch {
			return flowDenial(503, "ACCESS_UNAVAILABLE", prepared.headers)
		}
	}

	revoke(
		request: AccessRequest,
		body: unknown,
	): Promise<AccessFlowResult<{ revoked: boolean }>> {
		const original = copyRequest(request)
		const parsed = revokeSchema.safeParse(body)
		const prepared = this.#prepare(
			original,
			"POST",
			MACHINE_DEVICE_ROUTES.revoke,
			true,
		)
		if (prepared.kind === "deny") return Promise.resolve(prepared.denial)
		return this.#enqueue(async () => {
			const again = this.#prepare(
				original,
				"POST",
				MACHINE_DEVICE_ROUTES.revoke,
				false,
			)
			if (again.kind === "deny") return again.denial
			if (!parsed.success)
				return flowDenial(400, "MALFORMED_REQUEST", again.headers)
			try {
				const revoked = await this.#sessions.revoke(parsed.data.deviceId)
				return flowSuccess({ revoked }, again.headers)
			} catch {
				return flowDenial(503, "ACCESS_UNAVAILABLE", again.headers)
			}
		})
	}

	revokeAll(
		request: AccessRequest,
	): Promise<AccessFlowResult<{ revoked: true }>> {
		const original = copyRequest(request)
		const prepared = this.#prepare(
			original,
			"POST",
			MACHINE_DEVICE_ROUTES.revokeAll,
			true,
		)
		if (prepared.kind === "deny") return Promise.resolve(prepared.denial)
		return this.#enqueue(async () => {
			const again = this.#prepare(
				original,
				"POST",
				MACHINE_DEVICE_ROUTES.revokeAll,
				false,
			)
			if (again.kind === "deny") return again.denial
			try {
				await this.#sessions.revokeAll()
				return flowSuccess({ revoked: true as const }, again.headers)
			} catch {
				return flowDenial(503, "ACCESS_UNAVAILABLE", again.headers)
			}
		})
	}

	#prepare(
		request: AccessRequest,
		method: string,
		path: string,
		rateLimit: boolean,
	): Prepared {
		const admission = this.#policy.evaluate(request)
		if (admission.kind === "deny")
			return { kind: "deny", denial: admissionDenial(admission) }
		const headers = admission.headers
		if (
			request.surface !== "api" ||
			request.transport !== "http" ||
			request.method !== method ||
			request.rawTarget !== path
		)
			return {
				kind: "deny",
				denial: flowDenial(400, "MALFORMED_REQUEST", headers),
			}
		if (
			admission.kind !== "authenticated" ||
			admission.principal.kind !== "machine"
		)
			return {
				kind: "deny",
				denial: flowDenial(403, "MACHINE_REQUIRED", headers),
			}
		if (this.#sessions.unavailable || this.#unavailable)
			return {
				kind: "deny",
				denial: flowDenial(503, "ACCESS_UNAVAILABLE", headers),
			}
		if (!rateLimit) return { kind: "ok", headers }
		let now: number
		try {
			now = this.#now()
		} catch {
			return {
				kind: "deny",
				denial: flowDenial(503, "ACCESS_UNAVAILABLE", headers),
			}
		}
		this.#prune(now)
		if (!this.#allowAttempt(request.remoteAddress, now))
			return {
				kind: "deny",
				denial: flowDenial(429, "MACHINE_RATE_LIMITED", {
					...headers,
					"Retry-After": "60",
				}),
			}
		return { kind: "ok", headers }
	}

	#now(): number {
		try {
			const now = this.#clock()
			if (!Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER)
				throw new WaveKitError(
					"Machine device administration unavailable",
					"ACCESS_UNAVAILABLE",
				)
			this.#lastNow = Math.max(this.#lastNow, now)
			return this.#lastNow
		} catch {
			this.#unavailable = true
			throw new WaveKitError(
				"Machine device administration unavailable",
				"ACCESS_UNAVAILABLE",
			)
		}
	}

	#prune(now: number): void {
		this.#globalAttempts = this.#globalAttempts.filter(
			at => at > now - WINDOW_MS,
		)
		for (const [address, bucket] of this.#addresses) {
			if (bucket.lastAt <= now - ADDRESS_IDLE_MS)
				this.#addresses.delete(address)
			else bucket.attempts = bucket.attempts.filter(at => at > now - WINDOW_MS)
		}
	}

	#allowAttempt(address: string, now: number): boolean {
		const existing = this.#addresses.get(address)
		if (
			this.#globalAttempts.length >= GLOBAL_LIMIT ||
			(existing?.attempts.length ?? 0) >= ADDRESS_LIMIT ||
			(!existing && this.#addresses.size >= MAX_ADDRESSES)
		)
			return false
		const bucket = existing ?? { attempts: [], lastAt: now }
		bucket.attempts.push(now)
		bucket.lastAt = now
		this.#addresses.set(address, bucket)
		this.#globalAttempts.push(now)
		return true
	}
}

function copyRequest(request: AccessRequest): AccessRequest {
	return { ...request, rawHeaders: [...request.rawHeaders] }
}
