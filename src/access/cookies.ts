import { WaveKitError } from "../utils/errors.js"
import { isCanonicalToken } from "./credentials.js"
import type { AccessPolicy } from "./policy.js"
import type { AccessResponseHeaders, DeniedAdmission } from "./types.js"

/** Private transport metadata, never an HTTP response body. */
export interface CookieDirective {
	readonly name: string
	readonly value: string
	readonly path: "/"
	readonly httpOnly: true
	readonly sameSite: "strict"
	readonly secure: boolean
	readonly maxAgeSeconds: number
}

interface SuccessfulFlow<T> {
	kind: "success"
	status: 200 | 201
	body: T
	headers: AccessResponseHeaders
	readonly cookie?: CookieDirective
}

interface DeniedFlow {
	kind: "deny"
	status: 400 | 401 | 403 | 429 | 503
	body: { code: string }
	headers: AccessResponseHeaders
}

export type AccessFlowResult<T> = SuccessfulFlow<T> | DeniedFlow

/** Adapters serialize ONLY result.body and handle the cookie separately. */
export function flowSuccess<T>(
	body: T,
	headers: AccessResponseHeaders,
	cookie?: CookieDirective,
	status: 200 | 201 = 200,
): AccessFlowResult<T> {
	const result: AccessFlowResult<T> = { kind: "success", status, body, headers }
	if (cookie) Object.defineProperty(result, "cookie", { value: cookie })
	return result
}

export function flowDenial(
	status: 400 | 401 | 403 | 429 | 503,
	code: string,
	headers: AccessResponseHeaders,
): AccessFlowResult<never> {
	return { kind: "deny", status, body: { code }, headers }
}

export function admissionDenial(
	admission: DeniedAdmission,
): AccessFlowResult<never> {
	return flowDenial(admission.status, admission.code, admission.headers)
}

/** Configuration comes from the exact policy, never from inbound headers. */
export class SessionCookies {
	#name: string
	#secure: boolean

	constructor(policy: AccessPolicy) {
		this.#name = policy.sessionCookieName
		this.#secure = policy.listenerScheme === "https"
		if (
			(this.#name.startsWith("__Host-") || this.#name.startsWith("__Secure-")) &&
			!this.#secure
		)
			throw new WaveKitError(
				"Invalid cookie configuration",
				"ACCESS_CONFIG_INVALID",
			)
	}

	issue(value: string, maxAgeSeconds: number): CookieDirective {
		if (
			!isCanonicalToken(value) ||
			!Number.isSafeInteger(maxAgeSeconds) ||
			maxAgeSeconds < 1 ||
			maxAgeSeconds > 30 * 24 * 60 * 60
		)
			throw new WaveKitError("Invalid session cookie", "ACCESS_COOKIE_INVALID")
		return this.#directive(value, maxAgeSeconds)
	}

	clear(): CookieDirective {
		return this.#directive("", 0)
	}

	#directive(value: string, maxAgeSeconds: number): CookieDirective {
		const directive = {
			name: this.#name,
			path: "/" as const,
			httpOnly: true as const,
			sameSite: "strict" as const,
			secure: this.#secure,
			maxAgeSeconds,
		} as CookieDirective
		Object.defineProperty(directive, "value", { value })
		return Object.freeze(directive)
	}
}

export function serializeSessionCookie(cookie: CookieDirective): string {
	return `${cookie.name}=${cookie.value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cookie.maxAgeSeconds}${cookie.secure ? "; Secure" : ""}`
}
