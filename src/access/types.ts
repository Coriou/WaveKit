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
	/**
	 * Also admit a loopback Host (`127.0.0.1`, `localhost` or `[::1]`, any port) when the TCP
	 * peer itself is a loopback address. Only for listeners that bind loopback themselves
	 * (`exposure: local-http`): behind a container port mapping the peer address cannot tell a
	 * local client from a remote one. A remote peer never gains anything from it, and a
	 * rebinding name is not a loopback Host. Default false: the exact allowlist only.
	 */
	loopbackHostFromLoopbackPeer?: boolean
	allowedOrigins: readonly string[]
	sessionCookieName: string
	machineSecretDigest: Uint8Array
	sessions: SessionStore
	/**
	 * True once this process no longer owns the private state behind the digest and
	 * the sessions: another owner may have rotated them, so nothing in memory can
	 * still prove a credential is current. Latched by the storage owner.
	 */
	credentialAuthorityLost?: () => boolean
	/** Fires once at that latch, or at once if it already happened. Returns the unsubscribe. */
	onCredentialAuthorityLost?: (listener: () => void) => () => void
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

/** Public deployment metadata only; this carries no principal or transport authority. */
export type PublicBootstrapAdmission =
	| { kind: "public-bootstrap"; headers: AccessResponseHeaders }
	| DeniedAdmission
