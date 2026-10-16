import { isAbsolute } from "node:path"
import { z } from "zod"
import {
	MACHINE_DEVICE_ROUTES,
	machineAccessDevicesDtoSchema,
} from "./machine-devices.js"
import type { MachineAccessDevicesDto } from "./machine-devices.js"
import { canonicalPairingOrigin } from "./pairing-client.js"
import { PrivateAccessStorage } from "./private-storage.js"

export const MACHINE_REQUEST_TIMEOUT_MS = 2000
const MAX_BODY_BYTES = 8192

const optionsSchema = z
	.object({
		apiOrigin: z.string().min(1).max(320),
		directory: z
			.string()
			.min(1)
			.max(4096)
			.refine(isAbsolute)
			.refine(value => !value.includes("\0")),
		timeoutMs: z
			.number()
			.int()
			.min(1)
			.max(30_000)
			.default(MACHINE_REQUEST_TIMEOUT_MS),
		signal: z
			.custom<AbortSignal>(value => value instanceof AbortSignal)
			.optional(),
	})
	.strict()
const deviceIdSchema = z.string().regex(/^device_[A-Za-z0-9_-]{43}$/)
const revokedSchema = z.object({ revoked: z.boolean() }).strict()
const revokedAllSchema = z.object({ revoked: z.literal(true) }).strict()

export interface MachineClientOptions {
	apiOrigin: string
	directory: string
	timeoutMs?: number
	signal?: AbortSignal
}
export type MachineClientFailureCode =
	| "ACCESS_COMMAND_INVALID"
	| "ACCESS_CREDENTIAL_UNAVAILABLE"
	| "MACHINE_SERVICE_UNAVAILABLE"
	| "MACHINE_INVALID_RESPONSE"
	| "MACHINE_REQUEST_TIMED_OUT"
	| "AUTH_REQUIRED"
	| "MACHINE_RATE_LIMITED"
	| "ACCESS_UNAVAILABLE"
export type MachineClientResult<T> =
	| { kind: "ok"; body: T }
	| { kind: "unavailable"; code: MachineClientFailureCode }

interface MachineRequest {
	method: "GET" | "POST"
	path: string
	body?: string
}

function unavailable(
	code: MachineClientFailureCode,
): MachineClientResult<never> {
	return { kind: "unavailable", code }
}

async function readBody<T>(
	response: Response,
	schema: z.ZodType<T>,
): Promise<MachineClientResult<T>> {
	const reader = response.body?.getReader()
	if (!reader) return unavailable("MACHINE_INVALID_RESPONSE")
	try {
		const chunks: Uint8Array[] = []
		let total = 0
		while (true) {
			const part = await reader.read()
			if (part.done) break
			total += part.value.byteLength
			if (total > MAX_BODY_BYTES) return unavailable("MACHINE_INVALID_RESPONSE")
			chunks.push(part.value)
		}
		const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
		const parsed = schema.safeParse(input)
		return parsed.success
			? { kind: "ok", body: parsed.data }
			: unavailable("MACHINE_INVALID_RESPONSE")
	} catch {
		return unavailable("MACHINE_INVALID_RESPONSE")
	} finally {
		await reader.cancel().catch(() => undefined)
		reader.releaseLock()
	}
}

function failureCode(status: number): MachineClientFailureCode {
	if (status === 401) return "AUTH_REQUIRED"
	if (status === 429) return "MACHINE_RATE_LIMITED"
	if (status === 503) return "ACCESS_UNAVAILABLE"
	return "MACHINE_SERVICE_UNAVAILABLE"
}

/**
 * One original request to the running core. A timeout may leave a revoke in
 * flight: do not retry automatically. Never log machine tokens, paths, native
 * errors, redirects or response bodies.
 */
async function machineRequest<T>(
	options: MachineClientOptions,
	requestSpec: MachineRequest,
	schema: z.ZodType<T>,
	dependencies: { fetch?: typeof fetch } = {},
): Promise<MachineClientResult<T>> {
	const parsed = optionsSchema.safeParse(options)
	if (!parsed.success) return unavailable("ACCESS_COMMAND_INVALID")
	let origin: string
	try {
		origin = canonicalPairingOrigin(parsed.data.apiOrigin)
	} catch {
		return unavailable("ACCESS_COMMAND_INVALID")
	}
	const request = dependencies.fetch ?? fetch
	if (typeof request !== "function")
		return unavailable("ACCESS_COMMAND_INVALID")
	const cancellation = new AbortController()
	const abort = (): void => cancellation.abort()
	const signal = parsed.data.signal
	if (signal?.aborted) return unavailable("MACHINE_REQUEST_TIMED_OUT")
	signal?.addEventListener("abort", abort, { once: true })
	const timer = setTimeout(abort, parsed.data.timeoutMs)
	timer.unref()
	let releaseAbort: (() => void) | undefined
	try {
		const timedOut = new Promise<MachineClientResult<T>>(resolve => {
			const onAbort = (): void =>
				resolve(unavailable("MACHINE_REQUEST_TIMED_OUT"))
			cancellation.signal.addEventListener("abort", onAbort, { once: true })
			releaseAbort = () =>
				cancellation.signal.removeEventListener("abort", onAbort)
		})
		const operation = PrivateAccessStorage.readMachineCredential(
			{ directory: parsed.data.directory },
			async token => {
				if (cancellation.signal.aborted)
					return unavailable("MACHINE_REQUEST_TIMED_OUT")
				try {
					const headers: Record<string, string> = {
						Authorization: `Bearer ${token}`,
					}
					if (requestSpec.body !== undefined)
						headers["Content-Type"] = "application/json"
					const response = await request(`${origin}${requestSpec.path}`, {
						method: requestSpec.method,
						headers,
						redirect: "error",
						credentials: "omit",
						signal: cancellation.signal,
						...(requestSpec.body === undefined
							? {}
							: { body: requestSpec.body }),
					})
					if (response.status !== 200) {
						await response.body?.cancel().catch(() => undefined)
						return unavailable(failureCode(response.status))
					}
					return await readBody(response, schema)
				} catch {
					return unavailable(
						cancellation.signal.aborted
							? "MACHINE_REQUEST_TIMED_OUT"
							: "MACHINE_SERVICE_UNAVAILABLE",
					)
				}
			},
		).catch(() => unavailable("ACCESS_CREDENTIAL_UNAVAILABLE"))
		return await Promise.race([operation, timedOut])
	} finally {
		clearTimeout(timer)
		signal?.removeEventListener("abort", abort)
		releaseAbort?.()
	}
}

export function requestMachineDevices(
	options: MachineClientOptions,
	dependencies: { fetch?: typeof fetch } = {},
): Promise<MachineClientResult<MachineAccessDevicesDto>> {
	return machineRequest(
		options,
		{ method: "GET", path: MACHINE_DEVICE_ROUTES.list },
		machineAccessDevicesDtoSchema,
		dependencies,
	)
}

export function revokeMachineDevice(
	options: MachineClientOptions & { deviceId: string },
	dependencies: { fetch?: typeof fetch } = {},
): Promise<MachineClientResult<{ revoked: boolean }>> {
	if (!deviceIdSchema.safeParse(options.deviceId).success)
		return Promise.resolve(unavailable("ACCESS_COMMAND_INVALID"))
	const client: MachineClientOptions = {
		apiOrigin: options.apiOrigin,
		directory: options.directory,
		...(options.timeoutMs === undefined
			? {}
			: { timeoutMs: options.timeoutMs }),
		...(options.signal === undefined ? {} : { signal: options.signal }),
	}
	return machineRequest(
		client,
		{
			method: "POST",
			path: MACHINE_DEVICE_ROUTES.revoke,
			body: JSON.stringify({ deviceId: options.deviceId }),
		},
		revokedSchema,
		dependencies,
	)
}

export function revokeAllMachineDevices(
	options: MachineClientOptions,
	dependencies: { fetch?: typeof fetch } = {},
): Promise<MachineClientResult<{ revoked: true }>> {
	return machineRequest(
		options,
		{ method: "POST", path: MACHINE_DEVICE_ROUTES.revokeAll },
		revokedAllSchema,
		dependencies,
	)
}
