import { WaveKitError } from "../utils/errors.js"
import { normalizeAuthority, normalizeOrigin } from "./authority.js"
import { sessionCredentialBinding, verifyMachineToken } from "./credentials.js"
import { accessPolicySchema, accessRequestSchema } from "./schema.js"
import { SessionStore } from "./sessions.js"
import type {
	AccessDenialCode,
	AccessPolicyOptions,
	AccessRequest,
	Admission,
	AuthenticatedAdmission,
	DeniedAdmission,
	PairingAdmission,
	PublicBootstrapAdmission,
} from "./types.js"

export const CSRF_HEADER = "X-WaveKit-CSRF"
export const PREFLIGHT_METHODS = [
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
] as const
export const PREFLIGHT_HEADERS = [
	"Authorization",
	"Content-Type",
	CSRF_HEADER,
	"X-Correlation-Id",
	"Range",
] as const

const sensitiveHeaders = new Set([
	"host",
	"origin",
	"authorization",
	"x-wavekit-csrf",
	"sec-fetch-site",
	"access-control-request-method",
	"access-control-request-headers",
	"upgrade",
])
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

interface ParsedHeaders {
	values: Map<string, string>
	cookie: string | undefined
}

interface CheckedBoundary extends ParsedHeaders {
	kind: "checked"
	input: AccessRequest
	origin: string | undefined
	headers: Record<string, string>
}

function parseHeaders(
	raw: readonly string[],
	cookieName: string,
): ParsedHeaders | null {
	if (
		raw.length % 2 !== 0 ||
		raw.reduce((sum, value) => sum + value.length, 0) > 65536
	)
		return null
	const values = new Map<string, string>()
	let cookie: string | undefined
	for (let i = 0; i < raw.length; i += 2) {
		const name = raw[i]
		const value = raw[i + 1]
		if (
			!name ||
			value === undefined ||
			!headerName.test(name) ||
			/[^\x20-\x7e\t]/.test(value)
		)
			return null
		const key = name.toLowerCase()
		if (sensitiveHeaders.has(key) && values.has(key)) return null
		if (key === "cookie") {
			for (const pair of value.split(";")) {
				const trimmed = pair.trim()
				const equals = trimmed.indexOf("=")
				if (equals < 1) return null
				const pairName = trimmed.slice(0, equals)
				const pairValue = trimmed.slice(equals + 1)
				if (
					!headerName.test(pairName) ||
					!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(pairValue)
				)
					return null
				if (pairName === cookieName) {
					if (cookie !== undefined) return null
					cookie = pairValue
				}
			}
		} else {
			values.set(key, value)
		}
	}
	return { values, cookie }
}

function validTarget(raw: string): boolean {
	return (
		raw.startsWith("/") &&
		!raw.startsWith("//") &&
		!/[\x00-\x20\x7f-\uffff#\\]/.test(raw) &&
		!/%(?![0-9a-fA-F]{2})/.test(raw)
	)
}

/** Pure admission boundary. Adapters must apply headers and attach session leases. */
export class AccessPolicy {
	#authorities: Set<string>
	#origins: Set<string>
	#scheme: "http" | "https"
	#cookieName: string
	#digest: Uint8Array
	#sessions: SessionStore

	constructor(options: AccessPolicyOptions) {
		const parsed = accessPolicySchema.safeParse(options)
		if (!parsed.success || !(options.sessions instanceof SessionStore))
			throw new WaveKitError(
				"Invalid access policy configuration",
				"ACCESS_CONFIG_INVALID",
			)
		const config = parsed.data
		const authorities = config.allowedAuthorities.map(value =>
			normalizeAuthority(value, config.listenerScheme),
		)
		const origins = config.allowedOrigins.map(normalizeOrigin)
		if (
			authorities.some(
				value =>
					value === null ||
					value.startsWith("0.0.0.0:") ||
					value.startsWith("[::]:"),
			) ||
			origins.some(value => value === null)
		)
			throw new WaveKitError(
				"Invalid access policy configuration",
				"ACCESS_CONFIG_INVALID",
			)
		this.#authorities = new Set(authorities as string[])
		this.#origins = new Set(origins as string[])
		this.#scheme = config.listenerScheme
		this.#cookieName = config.sessionCookieName
		this.#digest = Uint8Array.from(config.machineSecretDigest)
		if (
			options.sessions.credentialBinding !==
			sessionCredentialBinding(this.#digest)
		)
			throw new WaveKitError(
				"Invalid access policy configuration",
				"ACCESS_CONFIG_INVALID",
			)
		this.#sessions = options.sessions
	}

	get sessionCookieName(): string {
		return this.#cookieName
	}

	get listenerScheme(): "http" | "https" {
		return this.#scheme
	}

	/** Flow composition must share this exact committed-state authority. */
	usesSessionStore(sessions: SessionStore): boolean {
		return this.#sessions === sessions
	}

	#validateBoundary(request: AccessRequest): CheckedBoundary | DeniedAdmission {
		const headers: Record<string, string> = {
			"Cache-Control": "no-store",
			Vary: "Origin",
		}
		const deny = (
			status: 400 | 401 | 403 | 503,
			code: AccessDenialCode,
		): DeniedAdmission => ({ kind: "deny", status, code, headers })
		const parsed = accessRequestSchema.safeParse(request)
		if (!parsed.success) return deny(400, "MALFORMED_REQUEST")
		const input = parsed.data
		// Preserve readable CORS denials when other headers are malformed, but
		// never reflect an ambiguous or disallowed Origin.
		const originValues: string[] = []
		for (let i = 0; i + 1 < input.rawHeaders.length; i += 2) {
			if (input.rawHeaders[i]?.toLowerCase() === "origin")
				originValues.push(input.rawHeaders[i + 1] ?? "")
		}
		if (originValues.length === 1) {
			const candidate = originValues[0]
			const normalized =
				candidate === undefined ? null : normalizeOrigin(candidate)
			if (
				candidate !== undefined &&
				normalized &&
				this.#origins.has(normalized)
			) {
				headers["Access-Control-Allow-Origin"] = candidate
				headers["Access-Control-Allow-Credentials"] = "true"
			}
		}
		const raw = parseHeaders(input.rawHeaders, this.#cookieName)
		if (!raw) return deny(400, "MALFORMED_REQUEST")
		const { values, cookie } = raw
		const originRaw = values.get("origin")
		let origin: string | undefined
		if (originRaw !== undefined) {
			if (originRaw === "null") return deny(403, "ORIGIN_FORBIDDEN")
			const normalized = normalizeOrigin(originRaw)
			if (!normalized) return deny(400, "MALFORMED_REQUEST")
			if (!this.#origins.has(normalized)) return deny(403, "ORIGIN_FORBIDDEN")
			origin = normalized
			headers["Access-Control-Allow-Origin"] = originRaw
			headers["Access-Control-Allow-Credentials"] = "true"
		}
		const host = values.get("host")
		const authority =
			host === undefined ? null : normalizeAuthority(host, this.#scheme)
		if (!authority) return deny(400, "MALFORMED_REQUEST")
		if (!this.#authorities.has(authority)) return deny(403, "HOST_FORBIDDEN")
		if (!validTarget(input.rawTarget)) return deny(400, "MALFORMED_REQUEST")
		if (values.get("authorization")?.includes(","))
			return deny(400, "MALFORMED_REQUEST")
		const upgrade = values.get("upgrade")
		if (
			upgrade !== undefined &&
			(upgrade.toLowerCase() !== "websocket" || input.transport !== "websocket")
		)
			return deny(400, "MALFORMED_REQUEST")
		return { kind: "checked", input, values, cookie, origin, headers }
	}

	/** Opt-in adapters only: exact public metadata, with no credential verification. */
	validatePublicBootstrapRequest(request: AccessRequest): PublicBootstrapAdmission {
		const boundary = this.#validateBoundary(request)
		if (boundary.kind === "deny") return boundary
		const { input, headers } = boundary
		if (
			input.surface !== "api" || input.transport !== "http" ||
			(input.method !== "GET" && input.method !== "HEAD") ||
			input.rawTarget !== "/api/access/bootstrap"
		)
			return { kind: "deny", status: 400, code: "MALFORMED_REQUEST", headers }
		return { kind: "public-bootstrap", headers }
	}

	/** Exact pair-code exchange boundary; this never authenticates an API principal. */
	validatePairingRequest(request: AccessRequest): PairingAdmission {
		const boundary = this.#validateBoundary(request)
		if (boundary.kind === "deny") return boundary
		const { input, origin, headers } = boundary
		if (
			input.surface !== "api" ||
			input.transport !== "http" ||
			input.method !== "POST" ||
			input.rawTarget !== "/api/access/pair"
		)
			return { kind: "deny", status: 400, code: "MALFORMED_REQUEST", headers }
		if (!origin)
			return { kind: "deny", status: 403, code: "ORIGIN_FORBIDDEN", headers }
		return { kind: "pairing", headers }
	}

	evaluate(request: AccessRequest): Admission {
		const boundary = this.#validateBoundary(request)
		if (boundary.kind === "deny") return boundary
		const { input, values, cookie, origin, headers } = boundary
		const deny = (
			status: 400 | 401 | 403 | 503,
			code: AccessDenialCode,
		): DeniedAdmission => ({ kind: "deny", status, code, headers })

		if (
			input.transport === "http" &&
			input.method === "OPTIONS" &&
			values.has("access-control-request-method")
		) {
			if (!origin) return deny(403, "PREFLIGHT_FORBIDDEN")
			const method = values.get("access-control-request-method")
			if (!PREFLIGHT_METHODS.some(allowed => allowed === method))
				return deny(403, "PREFLIGHT_FORBIDDEN")
			const requested = values.get("access-control-request-headers")
			const requestedHeaders =
				requested === undefined
					? []
					: requested.split(",").map(value => value.trim().toLowerCase())
			if (
				requestedHeaders.length > PREFLIGHT_HEADERS.length ||
				requestedHeaders.some(
					value =>
						!PREFLIGHT_HEADERS.some(allowed => allowed.toLowerCase() === value),
				) ||
				new Set(requestedHeaders).size !== requestedHeaders.length
			)
				return deny(403, "PREFLIGHT_FORBIDDEN")
			headers["Vary"] =
				"Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
			headers["Access-Control-Allow-Methods"] = PREFLIGHT_METHODS.join(", ")
			headers["Access-Control-Allow-Headers"] = PREFLIGHT_HEADERS.join(", ")
			return { kind: "preflight", status: 204, headers }
		}

		const path = input.rawTarget.split("?", 1)[0]
		const safe = input.method === "GET" || input.method === "HEAD"
		if (
			input.transport === "http" &&
			input.surface === "api" &&
			safe &&
			(path === "/health" || path === "/health/live")
		)
			return { kind: "public-health", headers }
		const authorization = values.get("authorization")
		if (authorization !== undefined) {
			if (authorization.includes(",")) return deny(400, "MALFORMED_REQUEST")
			const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization)
			if (!match?.[1] || !verifyMachineToken(match[1], this.#digest))
				return deny(401, "AUTH_REQUIRED")
			return {
				kind: "authenticated",
				principal: { kind: "machine", id: "machine", expiresAt: null },
				headers,
			}
		}
		if (this.#sessions.unavailable) return deny(503, "ACCESS_UNAVAILABLE")
		const session =
			cookie === undefined ? undefined : this.#sessions.lookup(cookie)
		if (this.#sessions.unavailable) return deny(503, "ACCESS_UNAVAILABLE")
		if (!session) return deny(401, "AUTH_REQUIRED")
		if (input.transport === "websocket") {
			if (!origin) return deny(403, "ORIGIN_FORBIDDEN")
		} else if (!safe) {
			if (!origin || values.get("x-wavekit-csrf") !== session.csrfToken)
				return deny(403, "CSRF_REQUIRED")
		} else if (
			!origin &&
			values.get("sec-fetch-site") !== "same-origin" &&
			values.get("sec-fetch-site") !== "none"
		) {
			return deny(403, "ORIGIN_FORBIDDEN")
		}
		const admission: AuthenticatedAdmission = {
			kind: "authenticated",
			principal: {
				kind: "session",
				id: session.principalId,
				expiresAt: session.expiresAt,
			},
			headers,
		}
		Object.defineProperty(admission, "sessionCookie", { value: cookie })
		return admission
	}
}
