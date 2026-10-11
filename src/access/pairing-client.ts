import { isAbsolute } from "node:path"
import { z } from "zod"
import { WaveKitError } from "../utils/errors.js"
import { normalizeAuthority, normalizeOrigin } from "./authority.js"
import { PrivateAccessStorage } from "./private-storage.js"

export const PAIRING_REQUEST_TIMEOUT_MS = 2000
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
			.default(PAIRING_REQUEST_TIMEOUT_MS),
		signal: z
			.custom<AbortSignal>(value => value instanceof AbortSignal)
			.optional(),
	})
	.strict()
const issuedSchema = z
	.object({
		code: z
			.string()
			.regex(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/),
		expiresInSeconds: z.number().int().min(1).max(600),
	})
	.strict()

export interface PairingClientOptions {
	apiOrigin: string
	directory: string
	timeoutMs?: number
	signal?: AbortSignal
}
export type PairingClientFailureCode =
	| "ACCESS_COMMAND_INVALID"
	| "ACCESS_CREDENTIAL_UNAVAILABLE"
	| "PAIRING_SERVICE_UNAVAILABLE"
	| "PAIRING_INVALID_RESPONSE"
	| "PAIRING_REQUEST_TIMED_OUT"
	| "AUTH_REQUIRED"
	| "PAIRING_CAPACITY"
export type PairingClientResult =
	| { kind: "issued"; code: string; expiresInSeconds: number }
	| { kind: "unavailable"; code: PairingClientFailureCode }

/** Strict explicit origin; no wildcard/unspecified host or WHATWG host aliases. */
export function canonicalPairingOrigin(input: string): string {
	const parsed = z.string().min(1).max(320).safeParse(input)
	const origin = parsed.success ? normalizeOrigin(parsed.data) : null
	if (!origin)
		throw new WaveKitError("Invalid access command", "ACCESS_COMMAND_INVALID")
	try {
		const url = new URL(origin)
		if (
			url.origin !== origin ||
			url.hostname === "0.0.0.0" ||
			url.hostname === "[::]" ||
			!normalizeAuthority(
				url.host,
				url.protocol === "https:" ? "https" : "http",
			)
		)
			throw new WaveKitError("Invalid access command", "ACCESS_COMMAND_INVALID")
		return origin
	} catch {
		throw new WaveKitError("Invalid access command", "ACCESS_COMMAND_INVALID")
	}
}

function unavailable(code: PairingClientFailureCode): PairingClientResult {
	return { kind: "unavailable", code }
}

async function issuedBody(response: Response): Promise<PairingClientResult> {
	const reader = response.body?.getReader()
	if (!reader) return unavailable("PAIRING_INVALID_RESPONSE")
	try {
		const chunks: Uint8Array[] = []
		let total = 0
		while (true) {
			const part = await reader.read()
			if (part.done) break
			total += part.value.byteLength
			if (total > 1024) return unavailable("PAIRING_INVALID_RESPONSE")
			chunks.push(part.value)
		}
		const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
		const parsed = issuedSchema.safeParse(input)
		return parsed.success
			? { kind: "issued", ...parsed.data }
			: unavailable("PAIRING_INVALID_RESPONSE")
	} catch {
		return unavailable("PAIRING_INVALID_RESPONSE")
	} finally {
		await reader.cancel().catch(() => undefined)
		reader.releaseLock()
	}
}

/**
 * One original POST to the running core, never a second in-memory code issuer.
 * A timeout may leave an outstanding server code: do not retry automatically.
 * The deadline bounds observable waiting, not filesystem cancellation. Late
 * read completion checks the same abort signal before sending credentials.
 * Issued codes are deliberately for operator display; never log machine tokens,
 * paths, native errors, redirects, response diagnostics or request options.
 */
export async function requestPairingCode(
	options: PairingClientOptions,
	dependencies: { fetch?: typeof fetch } = {},
): Promise<PairingClientResult> {
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
	if (signal?.aborted) return unavailable("PAIRING_REQUEST_TIMED_OUT")
	signal?.addEventListener("abort", abort, { once: true })
	const timer = setTimeout(abort, parsed.data.timeoutMs)
	timer.unref()
	let releaseAbort: (() => void) | undefined
	try {
		const timedOut = new Promise<PairingClientResult>(resolve => {
			const onAbort = (): void =>
				resolve(unavailable("PAIRING_REQUEST_TIMED_OUT"))
			cancellation.signal.addEventListener("abort", onAbort, { once: true })
			releaseAbort = () =>
				cancellation.signal.removeEventListener("abort", onAbort)
		})
		const operation = PrivateAccessStorage.readMachineCredential(
			{ directory: parsed.data.directory },
			async token => {
				if (cancellation.signal.aborted)
					return unavailable("PAIRING_REQUEST_TIMED_OUT")
				try {
					const response = await request(`${origin}/api/access/pairing-codes`, {
						method: "POST",
						headers: { Authorization: `Bearer ${token}` },
						redirect: "error",
						credentials: "omit",
						signal: cancellation.signal,
					})
					if (response.status !== 201) {
						await response.body?.cancel().catch(() => undefined)
						return unavailable(
							response.status === 401
								? "AUTH_REQUIRED"
								: response.status === 429
									? "PAIRING_CAPACITY"
									: "PAIRING_SERVICE_UNAVAILABLE",
						)
					}
					return await issuedBody(response)
				} catch {
					return unavailable(
						cancellation.signal.aborted
							? "PAIRING_REQUEST_TIMED_OUT"
							: "PAIRING_SERVICE_UNAVAILABLE",
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
