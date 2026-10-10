import { isIP } from "node:net"
import { performance } from "node:perf_hooks"
import WebSocket from "ws"
import { z } from "zod"
import { CliAccessError, MachineCredential } from "./access-credentials.js"
import type { CredentialProvider } from "./access-credentials.js"
import type { FetchLike } from "./config.js"
import {
	HANDSHAKE_TIMEOUT_MS,
	MAX_PAYLOAD_BYTES,
	SILENCE_MS,
} from "./ws-client.js"
import type { WsFactory } from "./ws-client.js"

export interface CliCredentialPolicy {
	/** Explicit HTTP(S) origin, never a discovery candidate or WS URL. */
	origin: string
	credentials: CredentialProvider
}
interface TransportOptions {
	policy?: CliCredentialPolicy
}

function authority(value: string, secure: boolean): string {
	let host: string
	let port: string | undefined
	if (value.startsWith("[")) {
		const match = /^\[([0-9a-fA-F:.]+)\](?::([0-9]+))?$/.exec(value)
		if (!match || isIP(match[1]!) !== 6)
			throw new CliAccessError("ACCESS_DESTINATION_FORBIDDEN")
		host = new URL(`http://[${match[1]}]`).hostname
		port = match[2]
	} else {
		const match = /^([a-zA-Z0-9.-]+)(?::([0-9]+))?$/.exec(value)
		if (!match) throw new CliAccessError("ACCESS_DESTINATION_FORBIDDEN")
		host = match[1]!.toLowerCase()
		port = match[2]
		if (
			/^[0-9.]+$/.test(host)
				? isIP(host) !== 4
				: host.length > 253 ||
					host
						.split(".")
						.some(
							label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
						)
		)
			throw new CliAccessError("ACCESS_DESTINATION_FORBIDDEN")
	}
	if (host === "0.0.0.0" || host === "[::]")
		throw new CliAccessError("ACCESS_DESTINATION_FORBIDDEN")
	const effective = port === undefined ? (secure ? 443 : 80) : Number(port)
	if (!Number.isInteger(effective) || effective < 1 || effective > 65535)
		throw new CliAccessError("ACCESS_DESTINATION_FORBIDDEN")
	return `${host}:${effective}`
}

function destination(
	input: string,
	websocket: boolean,
): { url: string; identity: string } {
	const parsed = z.string().min(1).max(8192).safeParse(input)
	if (!parsed.success || /[\s\\#\x00-\x1f\x7f]/.test(input))
		throw new CliAccessError("ACCESS_DESTINATION_FORBIDDEN")
	const match = /^(https?|wss?):\/\/([^/?#]+)(?:[/?].*)?$/.exec(input)
	if (
		!match ||
		(websocket ? !/^wss?$/.test(match[1]!) : !/^https?$/.test(match[1]!))
	)
		throw new CliAccessError("ACCESS_DESTINATION_FORBIDDEN")
	const secure = match[1] === "https" || match[1] === "wss"
	const identity = `${secure ? "https" : "http"}://${authority(match[2]!, secure)}`
	try {
		const url = new URL(input)
		// WHATWG accepts legacy numeric IPv4 aliases (hex/octal/short forms).
		// Refuse any host rewrite rather than trusting the rewritten destination.
		if (
			`${secure ? "https" : "http"}://${authority(url.host, secure)}` !==
			identity
		)
			throw new CliAccessError("ACCESS_DESTINATION_FORBIDDEN")
		return { url: url.toString(), identity }
	} catch {
		throw new CliAccessError("ACCESS_DESTINATION_FORBIDDEN")
	}
}

function bindPolicy(
	policy: CliCredentialPolicy | undefined,
): { identity: string; credentials: CredentialProvider } | undefined {
	if (policy === undefined) return undefined
	if (
		!z
			.object({ origin: z.string(), credentials: z.function() })
			.strict()
			.safeParse(policy).success ||
		!/^(https?):\/\/[^/?#]+$/.test(policy.origin)
	)
		throw new CliAccessError("ACCESS_DESTINATION_FORBIDDEN")
	return {
		identity: destination(policy.origin, false).identity,
		credentials: policy.credentials,
	}
}

function safeHeaders(
	input: Record<string, string> | undefined,
): Record<string, string> {
	const parsed = z.record(z.string()).safeParse(input ?? {})
	if (!parsed.success) throw new CliAccessError("ACCESS_HEADERS_FORBIDDEN")
	for (const name of Object.keys(parsed.data)) {
		if (/^(authorization|cookie|host|forwarded|x-forwarded-.*)$/i.test(name))
			throw new CliAccessError("ACCESS_HEADERS_FORBIDDEN")
	}
	return parsed.data
}

function cancelledCredential(): CliAccessError {
	const failure = new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE")
	failure.name = "AbortError"
	return failure
}

async function authorization(
	provider: CredentialProvider,
	signal?: AbortSignal,
	deadlineMs?: number,
): Promise<string> {
	// This bounds observable waiting only. It does not cancel filesystem I/O;
	// late fulfillment/rejection is handled but cannot create a connection.
	const credential = await new Promise<MachineCredential>((resolve, reject) => {
		if (signal?.aborted) {
			reject(cancelledCredential())
			return
		}
		let settled = false
		let timer: ReturnType<typeof setTimeout> | undefined
		const finish = (
			value?: MachineCredential,
			failure?: CliAccessError,
		): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener("abort", abort)
			if (failure) reject(failure)
			else resolve(value!)
		}
		const abort = (): void => finish(undefined, cancelledCredential())
		signal?.addEventListener("abort", abort, { once: true })
		if (deadlineMs !== undefined) {
			timer = setTimeout(
				() =>
					finish(
						undefined,
						new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE"),
					),
				deadlineMs,
			)
			timer.unref()
		}
		try {
			void provider().then(
				value => finish(value),
				() =>
					finish(
						undefined,
						new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE"),
					),
			)
		} catch {
			finish(undefined, new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE"))
		}
	})
	try {
		if (!(credential instanceof MachineCredential))
			throw new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE")
		return credential.use(token => `Bearer ${token}`)
	} catch {
		throw new CliAccessError("ACCESS_CREDENTIAL_UNAVAILABLE")
	}
}

function transportFailure(error: unknown): CliAccessError {
	const failure = new CliAccessError("ACCESS_TRANSPORT_FAILED")
	// The existing CLI treats timeout/abort as an uncertain write outcome. Keep
	// this classification without forwarding messages, request options or causes.
	if (error instanceof Error) {
		if (error.name === "TimeoutError" || error.name === "AbortError")
			failure.name = error.name
		else {
			const cause: unknown = error.cause
			const reset = z
				.object({
					code: z.enum([
						"ECONNRESET",
						"EPIPE",
						"UND_ERR_SOCKET",
						"UND_ERR_CLOSED",
					]),
				})
				.passthrough()
				.safeParse(cause)
			if (reset.success) failure.name = "AbortError"
		}
	}
	return failure
}

const denialCodeSchema = z.object({
	code: z.enum([
		"MALFORMED_REQUEST",
		"HOST_FORBIDDEN",
		"ORIGIN_FORBIDDEN",
		"CSRF_REQUIRED",
		"PREFLIGHT_FORBIDDEN",
		"AUTH_REQUIRED",
		"ACCESS_UNAVAILABLE",
		"ACCESS_CAPACITY",
		"MACHINE_REQUIRED",
		"SESSION_REQUIRED",
		"SESSION_CAPACITY",
		"PAIRING_CAPACITY",
		"PAIRING_RATE_LIMITED",
		"PAIRING_INVALID",
	]),
})

async function boundedErrorBody(response: Response): Promise<unknown> {
	const reader = response.body?.getReader()
	if (!reader) return undefined
	try {
		const chunks: Uint8Array[] = []
		let size = 0
		while (true) {
			const read = await reader.read()
			if (read.done) break
			size += read.value.byteLength
			if (size > 4096) return undefined
			chunks.push(read.value)
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
	} catch {
		return undefined
	} finally {
		await reader.cancel().catch(() => undefined)
		reader.releaseLock()
	}
}

/** Optional policy preserves uncredentialed legacy use; mounting remains separate. */
function createFetch(
	options: TransportOptions & { fetch?: typeof fetch } = {},
	probe = false,
): FetchLike {
	const policy = bindPolicy(options.policy)
	const request = options.fetch ?? fetch
	return async (input, init) => {
		const target = destination(input, false)
		if (policy && target.identity !== policy.identity)
			throw new CliAccessError("ACCESS_DESTINATION_FORBIDDEN")
		const headers = safeHeaders(init?.headers)
		if (policy)
			headers["Authorization"] = await authorization(
				policy.credentials,
				init?.signal,
			)
		try {
			const response = await request(target.url, {
				...init,
				headers,
				redirect: "error",
				credentials: "omit",
			})
			return {
				ok: response.ok,
				status: response.status,
				statusText: "",
				json: async (): Promise<unknown> => {
					// Existing API clients render error-body messages verbatim. Do not
					// let a server/redirect diagnostic echo the reusable bearer token.
					if (!response.ok) {
						const body = await boundedErrorBody(response)
						// Legacy discovery accepts 503 /health as an answered core.
						// Only the credential-free probe projects this one public fact.
						const url = new URL(target.url)
						if (
							probe &&
							response.status === 503 &&
							(init?.method ?? "GET") === "GET" &&
							url.pathname === "/health" &&
							url.search === "" &&
							z.object({ status: z.literal("ok") }).safeParse(body).success
						)
							return { status: "ok" }
						const parsed = denialCodeSchema.safeParse(body)
						const code = parsed.success ? parsed.data.code : undefined
						return {
							message: `HTTP ${response.status}`,
							...(code ? { code } : {}),
						}
					}
					try {
						return (await response.json()) as unknown
					} catch (error) {
						if (error instanceof SyntaxError) return undefined
						throw transportFailure(error)
					}
				},
			}
		} catch (error) {
			throw transportFailure(error)
		}
	}
}

/** Optional policy preserves uncredentialed legacy use; mounting remains separate. */
export function createCliFetch(
	options: TransportOptions & { fetch?: typeof fetch } = {},
): FetchLike {
	return createFetch(options)
}

/** Discovery deliberately has no credential/provider parameter. */
export function createCliProbeFetch(request: typeof fetch = fetch): FetchLike {
	return createFetch({ fetch: request }, true)
}

/**
 * Existing synchronous WsFactory contract, with deferred credential acquisition.
 * Sends before open are dropped (no buffer); cancellation prevents a later socket.
 * Retry/backoff remains owned by WsClient. No raw ws errors, HTTP bodies or close
 * reasons escape into terminal events, which may otherwise disclose credentials.
 */
export function createCliWsFactory(options: TransportOptions = {}): WsFactory {
	const policy = bindPolicy(options.policy)
	return (input, handlers) => {
		const target = destination(input, true)
		if (policy && target.identity !== policy.identity)
			throw new CliAccessError("ACCESS_DESTINATION_FORBIDDEN")
		let socket: WebSocket | undefined
		let cancelled = false
		const cancellation = new AbortController()
		let closed = false
		let watchdog: ReturnType<typeof setInterval> | undefined
		const finish = (code: number): void => {
			if (closed) return
			closed = true
			clearInterval(watchdog)
			if (!cancelled) handlers.close(code, "")
		}
		void (async () => {
			try {
				const headers = policy
					? {
							Authorization: await authorization(
								policy.credentials,
								cancellation.signal,
								HANDSHAKE_TIMEOUT_MS,
							),
						}
					: undefined
				if (cancelled) return
				socket = new WebSocket(target.url, {
					headers,
					followRedirects: false,
					handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
					maxPayload: MAX_PAYLOAD_BYTES,
				})
				let seen = performance.now()
				let armed = false
				const touch = (): void => {
					seen = performance.now()
				}
				watchdog = setInterval(() => {
					if (!armed || performance.now() - seen <= SILENCE_MS || cancelled)
						return
					handlers.error("CLI access transport failed")
					socket?.terminate()
				}, 5000)
				watchdog.unref()
				socket.on("open", () => {
					if (!cancelled) {
						touch()
						handlers.open()
					}
				})
				socket.on("message", (data: WebSocket.RawData) => {
					touch()
					if (!cancelled)
						handlers.message(
							(Buffer.isBuffer(data)
								? data
								: Array.isArray(data)
									? Buffer.concat(data)
									: Buffer.from(data)
							).toString("utf8"),
						)
				})
				socket.on("ping", () => {
					armed = true
					touch()
				})
				socket.on("pong", touch)
				socket.on("error", () => {
					if (!cancelled) handlers.error("CLI access transport failed")
				})
				socket.on("close", (code: number) => finish(code))
			} catch {
				if (!cancelled) handlers.error("CLI access transport failed")
				finish(0)
			}
		})()
		return {
			send: text => {
				if (!cancelled && socket?.readyState === WebSocket.OPEN)
					socket.send(text, error => {
						if (error && !cancelled)
							handlers.error("CLI access transport failed")
					})
			},
			close: () => {
				cancelled = true
				cancellation.abort()
				clearInterval(watchdog)
				socket?.terminate()
			},
		}
	}
}
