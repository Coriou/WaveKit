/**
 * REST client for the core API. Same origin by default (the Vite dev server proxies /api, /ws
 * and /health). Protected-mode aware: cookie credentials, the access bootstrap (404 = legacy
 * core) and `X-WaveKit-CSRF` on unsafe methods once a CSRF token is known.
 */
import type { AccessBootstrapDto } from "@wavekit/api-types"

export const CSRF_HEADER = "X-WaveKit-CSRF"

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type QueryValue =
	| string
	| number
	| boolean
	| readonly (string | number)[]
	| undefined

export interface RequestOptions {
	query?: Readonly<Record<string, QueryValue>>
	signal?: AbortSignal
	headers?: Readonly<Record<string, string>>
}

/** `legacy`: no access layer (the bootstrap route is not mounted). */
export type AccessState =
	| { mode: "legacy" }
	| { mode: "protected"; bootstrap: AccessBootstrapDto }

/** A non-2xx answer, or a network failure (`status` 0). `code` is the core's stable error code. */
export class ApiError extends Error {
	readonly status: number
	readonly code: string | null
	readonly body: unknown
	readonly method: string
	readonly path: string

	constructor(init: {
		status: number
		code: string | null
		message: string
		body: unknown
		method: string
		path: string
	}) {
		super(init.message)
		this.name = "ApiError"
		this.status = init.status
		this.code = init.code
		this.body = init.body
		this.method = init.method
		this.path = init.path
	}
}

export function isApiError(error: unknown): error is ApiError {
	return error instanceof ApiError
}

export interface ApiClientOptions {
	/** Prefix for every path; "" means same origin. */
	baseUrl?: string
	fetch?: FetchLike
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"])

function errorFields(body: unknown): {
	code: string | null
	message: string | null
} {
	if (typeof body !== "object" || body === null)
		return { code: null, message: null }
	const record = body as Record<string, unknown>
	const code = typeof record["code"] === "string" ? record["code"] : null
	const message =
		typeof record["message"] === "string" ? record["message"] : null
	return { code, message }
}

function isBootstrap(body: unknown): body is AccessBootstrapDto {
	if (typeof body !== "object" || body === null) return false
	const record = body as Record<string, unknown>
	const access = record["access"]
	return (
		record["version"] === 1 &&
		typeof record["apiOrigin"] === "string" &&
		typeof record["webSocketUrl"] === "string" &&
		typeof access === "object" &&
		access !== null &&
		(access as Record<string, unknown>)["mode"] === "protected"
	)
}

export function buildQuery(
	query: Readonly<Record<string, QueryValue>> | undefined,
): string {
	if (!query) return ""
	const params = new URLSearchParams()
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const item of value as readonly (string | number)[])
				params.append(key, String(item))
		} else params.append(key, String(value))
	}
	const text = params.toString()
	return text ? `?${text}` : ""
}

export class ApiClient {
	private readonly baseUrl: string
	private readonly fetchImpl: FetchLike
	private csrfToken: string | null = null
	private accessState: AccessState | null = null

	constructor(options: ApiClientOptions = {}) {
		this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "")
		this.fetchImpl =
			options.fetch ?? ((input, init) => globalThis.fetch(input, init))
	}

	/** The CSRF token of the current browser session (protected mode); null clears it. */
	setCsrfToken(token: string | null): void {
		this.csrfToken = token
	}

	private bootstrapping: Promise<AccessState> | null = null

	get access(): AccessState | null {
		return this.accessState
	}

	/**
	 * Reads GET /api/access/bootstrap: 404 means a legacy core, 200 a protected one. Concurrent calls
	 * share one request (the in-flight promise); a call after it settles asks again.
	 */
	bootstrap(signal?: AbortSignal): Promise<AccessState> {
		if (this.bootstrapping) return this.bootstrapping
		const run = this.fetchBootstrap(signal).finally(() => {
			if (this.bootstrapping === run) this.bootstrapping = null
		})
		this.bootstrapping = run
		return run
	}

	private async fetchBootstrap(signal?: AbortSignal): Promise<AccessState> {
		try {
			const body = await this.get<unknown>(
				"/api/access/bootstrap",
				signal ? { signal } : {},
			)
			if (!isBootstrap(body))
				throw new ApiError({
					status: 200,
					code: "BOOTSTRAP_INVALID",
					message: "Invalid access bootstrap",
					body,
					method: "GET",
					path: "/api/access/bootstrap",
				})
			this.accessState = { mode: "protected", bootstrap: body }
		} catch (error) {
			if (!(error instanceof ApiError) || error.status !== 404) throw error
			this.accessState = { mode: "legacy" }
		}
		return this.accessState
	}

	get<T>(path: string, options: RequestOptions = {}): Promise<T> {
		return this.request<T>("GET", path, undefined, options)
	}

	post<T>(
		path: string,
		body?: unknown,
		options: RequestOptions = {},
	): Promise<T> {
		return this.request<T>("POST", path, body, options)
	}

	put<T>(
		path: string,
		body?: unknown,
		options: RequestOptions = {},
	): Promise<T> {
		return this.request<T>("PUT", path, body, options)
	}

	patch<T>(
		path: string,
		body?: unknown,
		options: RequestOptions = {},
	): Promise<T> {
		return this.request<T>("PATCH", path, body, options)
	}

	delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
		return this.request<T>("DELETE", path, undefined, options)
	}

	async request<T>(
		method: string,
		path: string,
		body: unknown,
		options: RequestOptions = {},
	): Promise<T> {
		const headers: Record<string, string> = {
			Accept: "application/json",
			...options.headers,
		}
		if (body !== undefined) headers["Content-Type"] = "application/json"
		if (UNSAFE.has(method) && this.csrfToken !== null)
			headers[CSRF_HEADER] = this.csrfToken
		const init: RequestInit = { method, headers, credentials: "include" }
		if (body !== undefined) init.body = JSON.stringify(body)
		if (options.signal) init.signal = options.signal
		let response: Response
		try {
			response = await this.fetchImpl(
				`${this.baseUrl}${path}${buildQuery(options.query)}`,
				init,
			)
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError")
				throw error
			throw new ApiError({
				status: 0,
				code: "NETWORK_ERROR",
				message: error instanceof Error ? error.message : "Network error",
				body: null,
				method,
				path,
			})
		}
		const text = await response.text()
		let parsed: unknown = null
		if (text.length > 0) {
			try {
				parsed = JSON.parse(text) as unknown
			} catch {
				parsed = text
			}
		}
		if (!response.ok) {
			const fields = errorFields(parsed)
			throw new ApiError({
				status: response.status,
				code: fields.code,
				message:
					fields.message ?? `${method} ${path} failed with ${response.status}`,
				body: parsed,
				method,
				path,
			})
		}
		return parsed as T
	}
}

/** A short human message for any thrown value. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	if (typeof error === "string") return error
	return "Unknown error"
}
