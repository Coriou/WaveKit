/**
 * REST client for the core API. Same origin by default (the Vite dev server proxies /api, /ws
 * and /health). Protected-mode aware: cookie credentials, the access bootstrap (404 = legacy
 * core) and `X-WaveKit-CSRF` on unsafe methods once a CSRF token is known. The token comes from the
 * session routes (read, pair, refresh) and lives in memory only; a 401 clears it.
 */
import {
	ACCESS_PAIR_ROUTE,
	ACCESS_SESSION_LOGOUT_ROUTE,
	ACCESS_SESSION_REFRESH_ROUTE,
	ACCESS_SESSION_ROUTE,
	accessSessionDtoSchema,
	operatorDataReadDtoSchema,
	operatorDataWriteDtoSchema,
} from "@wavekit/api-types"
import type {
	AccessBootstrapDto,
	AccessDeviceKind,
	AccessSessionDto,
	ExpectedToken,
	OperatorDataReadDto,
	OperatorDataWriteDto,
	PreferenceKey,
	PreferenceOverrides,
	SavedFrequencyInput,
} from "@wavekit/api-types"

export const CSRF_HEADER = "X-WaveKit-CSRF"

// docs/API.md › remembered devices (session routes; the core exports no constants for them)
export const ACCESS_DEVICES_ROUTE = "/api/access/devices"
export const ACCESS_DEVICES_LABEL_ROUTE = "/api/access/devices/label"
export const ACCESS_DEVICES_REVOKE_ROUTE = "/api/access/devices/revoke"
export const ACCESS_DEVICES_REVOKE_ALL_ROUTE = "/api/access/devices/revoke-all"

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
	/** Retry on 429 (rateLimitWait); default: the Activity reads (retriesOn429). */
	retry429?: boolean
	/** Called with the response headers of a successful answer (a 204 has nothing else). */
	onHeaders?: (headers: Headers) => void
}

// ---- 429 (docs/specs/2026-10-25-band-inspection-ux.md req 2.1)

/** At most this many retries after a 429. */
export const RATE_LIMIT_RETRIES = 3
/** A server wait longer than this is not waited for: the error says when to try again. */
export const RATE_LIMIT_MAX_WAIT_MS = 10_000
/** No retry sooner than this, whatever the header says. */
export const RATE_LIMIT_MIN_WAIT_MS = 250
/** Fallback delay without a usable Retry-After: 500 × 2^attempt ms. */
export const RATE_LIMIT_BASE_MS = 500
/** Additive jitter: up to this share of the delay on top, never earlier. */
export const RATE_LIMIT_JITTER = 0.2

/** Activity reads (GET /api/activity…, the facets query) retry on 429; nothing else does by default. */
export function retriesOn429(method: string, path: string): boolean {
	if (method === "GET")
		return path === "/api/activity" || path.startsWith("/api/activity/")
	return method === "POST" && path === "/api/activity/facets"
}

/**
 * The delay a `Retry-After` value asks for, in ms: whole seconds (non-negative integer) or an HTTP
 * date minus `now` (a past date: 0). Null when absent or malformed.
 */
export function retryAfterMs(
	header: string | null | undefined,
	now: number,
): number | null {
	if (header === null || header === undefined) return null
	const text = header.trim()
	if (text === "") return null
	if (/^\d+$/.test(text)) {
		const seconds = Number(text)
		return Number.isSafeInteger(seconds) ? seconds * 1000 : null
	}
	// an HTTP date names a weekday and a month ("Wed, 21 Oct 2026 07:28:00 GMT"); refuse bare numbers
	if (!/[a-z]/i.test(text)) return null
	const at = Date.parse(text)
	return Number.isFinite(at) ? Math.max(0, at - now) : null
}

export type RateLimitDecision =
	| { retry: true; waitMs: number }
	| { retry: false; retryInS: number | null }

/**
 * What to do after a 429 on retry number `attempt` (0 for the first 429): wait
 * max(d, 250) × (1 + j), j in [0, 0.2] (`random` in [0, 1)), never earlier than the server asked;
 * no retry when d exceeds 10 s or after RATE_LIMIT_RETRIES retries.
 */
export function rateLimitWait(
	header: string | null | undefined,
	attempt: number,
	now: number,
	random: number,
): RateLimitDecision {
	const asked = retryAfterMs(header, now)
	const d = asked ?? RATE_LIMIT_BASE_MS * 2 ** Math.max(0, attempt)
	if (d > RATE_LIMIT_MAX_WAIT_MS)
		return { retry: false, retryInS: Math.ceil(d / 1000) }
	if (attempt >= RATE_LIMIT_RETRIES)
		return {
			retry: false,
			retryInS: asked === null ? null : Math.ceil(d / 1000),
		}
	const j = Math.min(1, Math.max(0, random)) * RATE_LIMIT_JITTER
	return { retry: true, waitMs: Math.max(d, RATE_LIMIT_MIN_WAIT_MS) * (1 + j) }
}

function abortError(): DOMException {
	return new DOMException("The operation was aborted.", "AbortError")
}

/** Resolves after `ms`, or rejects with an AbortError as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError())
			return
		}
		const onAbort = () => {
			clearTimeout(timer)
			reject(abortError())
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort)
			resolve()
		}, ms)
		signal?.addEventListener("abort", onAbort, { once: true })
	})
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
	/** A 429's Retry-After header (null when absent); undefined on other answers. */
	retryAfter?: string | null

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
	/** Waits between 429 retries (tests); default a timer that an abort cuts short. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
	/** Clock for HTTP-date Retry-After values, ms since the epoch. */
	now?: () => number
	/** Jitter source in [0, 1). */
	random?: () => number
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
	private readonly sleepImpl: (
		ms: number,
		signal?: AbortSignal,
	) => Promise<void>
	private readonly now: () => number
	private readonly random: () => number
	private csrfToken: string | null = null
	private accessState: AccessState | null = null

	constructor(options: ApiClientOptions = {}) {
		this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "")
		this.fetchImpl =
			options.fetch ?? ((input, init) => globalThis.fetch(input, init))
		this.sleepImpl = options.sleep ?? sleep
		this.now = options.now ?? (() => Date.now())
		this.random = options.random ?? (() => Math.random())
	}

	/** The CSRF token of the current browser session (protected mode); null clears it. */
	setCsrfToken(token: string | null): void {
		this.csrfToken = token
	}

	private readonly sessionLostHandlers = new Set<() => void>()

	/** Fires when a request with a session token answers 401 (the session is gone). */
	onSessionLost(handler: () => void): () => void {
		this.sessionLostHandlers.add(handler)
		return () => this.sessionLostHandlers.delete(handler)
	}

	// ---- browser session (docs/API.md › Browser pairing; protected mode only)

	/** GET /api/access/session: the session of this browser's cookie, or null on 401 (not paired). */
	async getSession(signal?: AbortSignal): Promise<AccessSessionDto | null> {
		try {
			const body = await this.get<unknown>(
				ACCESS_SESSION_ROUTE,
				signal ? { signal } : {},
			)
			return this.adoptSession(body, "GET", ACCESS_SESSION_ROUTE)
		} catch (error) {
			if (error instanceof ApiError && error.status === 401) {
				this.csrfToken = null
				return null
			}
			throw error
		}
	}

	/** POST /api/access/pair (201): redeems a one-time code; the cookie comes with the answer. */
	async pair(input: {
		code: string
		name?: string
		kind?: AccessDeviceKind
	}): Promise<AccessSessionDto> {
		const body = await this.post<unknown>(ACCESS_PAIR_ROUTE, {
			code: input.code,
			...(input.name !== undefined ? { name: input.name } : {}),
			...(input.kind !== undefined ? { kind: input.kind } : {}),
		})
		return this.adoptSession(body, "POST", ACCESS_PAIR_ROUTE)
	}

	/** POST /api/access/session/refresh: a new `expiresAt` (and the token again). */
	async refreshSession(): Promise<AccessSessionDto> {
		const body = await this.post<unknown>(ACCESS_SESSION_REFRESH_ROUTE)
		return this.adoptSession(body, "POST", ACCESS_SESSION_REFRESH_ROUTE)
	}

	/** POST /api/access/devices/revoke-all: ends every remembered session, this one too (token cleared). */
	async revokeAllDevices(): Promise<void> {
		try {
			await this.post<unknown>(ACCESS_DEVICES_REVOKE_ALL_ROUTE)
		} finally {
			this.csrfToken = null
		}
	}

	/** POST /api/access/session/logout: ends the session; the token is cleared whatever the answer. */
	async logout(): Promise<void> {
		try {
			await this.post<unknown>(ACCESS_SESSION_LOGOUT_ROUTE)
		} finally {
			this.csrfToken = null
		}
	}

	private adoptSession(
		body: unknown,
		method: string,
		path: string,
	): AccessSessionDto {
		const session = validated(accessSessionDtoSchema, body, method, path)
		this.csrfToken = session.csrfToken
		return session
	}

	private bootstrapping: Promise<AccessState> | null = null

	/** The absolute (or same-origin) URL of a core path, for links and downloads. */
	url(path: string, query?: Readonly<Record<string, QueryValue>>): string {
		return `${this.baseUrl}${path}${buildQuery(query)}`
	}

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

	/**
	 * GET of a binary body (a recording file): same credentials as JSON requests, the error body
	 * parsed as JSON when it is. Rejects with an ApiError like request().
	 */
	async blob(path: string, options: RequestOptions = {}): Promise<Blob> {
		const init: RequestInit = { method: "GET", credentials: "include" }
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
				method: "GET",
				path,
			})
		}
		if (response.ok) return response.blob()
		const text = await response.text()
		let parsed: unknown = text
		try {
			parsed = JSON.parse(text) as unknown
		} catch {
			// not JSON: keep the text
		}
		const fields = errorFields(parsed)
		throw new ApiError({
			status: response.status,
			code: fields.code,
			message: fields.message ?? `GET ${path} failed with ${response.status}`,
			body: parsed,
			method: "GET",
			path,
		})
	}

	// ---- operator data (src/operator-data/routes.ts; protected mode only, 404 on a legacy core)

	/** GET /api/operator-data, validated. */
	async getOperatorData(signal?: AbortSignal): Promise<OperatorDataReadDto> {
		const path = "/api/operator-data"
		const body = await this.get<unknown>(path, signal ? { signal } : {})
		return validated(operatorDataReadDtoSchema, body, "GET", path)
	}

	/** POST /api/operator-data/saved-frequencies (201): the new snapshot and the new id. */
	createSavedFrequency(
		expected: ExpectedToken,
		frequency: SavedFrequencyInput,
	): Promise<OperatorDataWriteDto> {
		return this.operatorWrite("POST", "/api/operator-data/saved-frequencies", {
			expected,
			frequency,
		})
	}

	/** PUT /api/operator-data/saved-frequencies/:id: replaces every field (rename included). */
	replaceSavedFrequency(
		id: string,
		expected: ExpectedToken,
		frequency: SavedFrequencyInput,
	): Promise<OperatorDataWriteDto> {
		return this.operatorWrite(
			"PUT",
			`/api/operator-data/saved-frequencies/${encodeURIComponent(id)}`,
			{ expected, frequency },
		)
	}

	/** DELETE /api/operator-data/saved-frequencies/:id (the token travels in the body). */
	deleteSavedFrequency(
		id: string,
		expected: ExpectedToken,
	): Promise<OperatorDataWriteDto> {
		return this.operatorWrite(
			"DELETE",
			`/api/operator-data/saved-frequencies/${encodeURIComponent(id)}`,
			{ expected },
		)
	}

	/**
	 * PATCH /api/operator-data/preferences (`patch-preferences`): `set` overrides, `reset` returns
	 * keys to core's defaults; nonempty, a key in at most one of them.
	 */
	patchPreferences(
		expected: ExpectedToken,
		change: { set?: PreferenceOverrides; reset?: readonly PreferenceKey[] },
	): Promise<OperatorDataWriteDto> {
		return this.operatorWrite("PATCH", "/api/operator-data/preferences", {
			expected,
			...(change.set !== undefined ? { set: change.set } : {}),
			...(change.reset !== undefined ? { reset: change.reset } : {}),
		})
	}

	private async operatorWrite(
		method: "POST" | "PUT" | "PATCH" | "DELETE",
		path: string,
		body: unknown,
	): Promise<OperatorDataWriteDto> {
		const answer = await this.request<unknown>(method, path, body)
		return validated(operatorDataWriteDtoSchema, answer, method, path)
	}

	async request<T>(
		method: string,
		path: string,
		body: unknown,
		options: RequestOptions = {},
	): Promise<T> {
		const retry = options.retry429 ?? retriesOn429(method, path)
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.send<T>(method, path, body, options)
			} catch (error) {
				if (!retry || !(error instanceof ApiError) || error.status !== 429)
					throw error
				const header = error.retryAfter === undefined ? null : error.retryAfter
				const decision = rateLimitWait(
					header,
					attempt,
					this.now(),
					this.random(),
				)
				if (!decision.retry) throw rateLimited(error, decision.retryInS)
				await this.sleepImpl(decision.waitMs, options.signal)
			}
		}
	}

	private async send<T>(
		method: string,
		path: string,
		body: unknown,
		options: RequestOptions,
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
		if (response.ok) options.onHeaders?.(response.headers)
		let parsed: unknown = null
		if (text.length > 0) {
			try {
				parsed = JSON.parse(text) as unknown
			} catch {
				parsed = text
			}
		}
		if (!response.ok) {
			if (response.status === 401 && this.csrfToken !== null) {
				this.csrfToken = null
				for (const handler of this.sessionLostHandlers) handler()
			}
			const fields = errorFields(parsed)
			const error = new ApiError({
				status: response.status,
				code: fields.code,
				message:
					fields.message ?? `${method} ${path} failed with ${response.status}`,
				body: parsed,
				method,
				path,
			})
			if (response.status === 429)
				error.retryAfter = response.headers.get("Retry-After")
			throw error
		}
		return parsed as T
	}
}

/** The 429 the caller sees once retrying stops: "rate limited, retry in N s". */
function rateLimited(error: ApiError, retryInS: number | null): ApiError {
	const out = new ApiError({
		status: 429,
		code: error.code ?? "RATE_LIMITED",
		message:
			retryInS === null
				? "rate limited, retry later"
				: `rate limited, retry in ${retryInS} s`,
		body: error.body,
		method: error.method,
		path: error.path,
	})
	out.retryAfter = error.retryAfter ?? null
	return out
}

interface SafeParser<T> {
	safeParse(
		value: unknown,
	):
		| { success: true; data: T }
		| { success: false; error: { issues: { message: string }[] } }
}

/** Zod at the boundary: a body that does not match the DTO is an ApiError (`RESPONSE_INVALID`). */
export function validated<T>(
	schema: SafeParser<T>,
	body: unknown,
	method: string,
	path: string,
): T {
	const result = schema.safeParse(body)
	if (result.success) return result.data
	throw new ApiError({
		status: 200,
		code: "RESPONSE_INVALID",
		message: `Unexpected answer from ${path}: ${result.error.issues[0]?.message ?? "invalid"}`,
		body,
		method,
		path,
	})
}

/** A short human message for any thrown value. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	if (typeof error === "string") return error
	return "Unknown error"
}
