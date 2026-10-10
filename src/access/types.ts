import type { SessionStore } from "./sessions.js"

export interface AccessRequest {
	method: string
	rawTarget: string
	/** Node's alternating header-name/header-value array, before coalescing. */
	rawHeaders: readonly string[]
	transport: "http" | "websocket"
	surface: "api" | "audio"
	remoteAddress: string
}

export interface AccessPolicyOptions {
	/** Explicit external listener context; never inferred from request headers. */
	listenerScheme: "http" | "https"
	allowedAuthorities: readonly string[]
	allowedOrigins: readonly string[]
	sessionCookieName: string
	machineSecretDigest: Uint8Array
	sessions: SessionStore
}

export interface AccessPrincipal {
	kind: "machine" | "session"
	id: string
	expiresAt: number | null
}

export type AccessDenialCode =
	| "MALFORMED_REQUEST"
	| "HOST_FORBIDDEN"
	| "ORIGIN_FORBIDDEN"
	| "CSRF_REQUIRED"
	| "PREFLIGHT_FORBIDDEN"
	| "AUTH_REQUIRED"
	| "ACCESS_UNAVAILABLE"

export type AccessResponseHeaders = Readonly<Record<string, string>>

export interface AuthenticatedAdmission {
	kind: "authenticated"
	principal: AccessPrincipal
	headers: AccessResponseHeaders
	/** Validated cookie for refresh only; non-enumerable, never public JSON. */
	readonly sessionCookie?: string
}

export interface DeniedAdmission {
	kind: "deny"
	status: 400 | 401 | 403 | 429 | 503
	code: AccessDenialCode
	headers: AccessResponseHeaders
}

/** Pairing authority is limited to the exchange, never general admission. */
export type PairingAdmission =
	| { kind: "pairing"; headers: AccessResponseHeaders }
	| DeniedAdmission

export type Admission =
	| { kind: "public-health"; headers: AccessResponseHeaders }
	| { kind: "preflight"; status: 204; headers: AccessResponseHeaders }
	| AuthenticatedAdmission
	| DeniedAdmission
