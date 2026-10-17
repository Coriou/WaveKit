/**
 * WG9 browser pairing contract (docs/specs/web-gaps-9, requirement 1): the request and response
 * shapes of the existing pairing and session routes, shared so a web app on another port of the
 * API hostname can pair, read, renew and end its session. No route, cookie or policy changes here.
 */
import { z } from "zod"
import {
	accessDeviceKindSchema,
	accessDeviceNameSchema,
} from "./access-devices.js"

/** WG9 req 1.4: the routes a paired browser uses (all exist before WG9). */
export const ACCESS_PAIR_ROUTE = "/api/access/pair"
export const ACCESS_SESSION_ROUTE = "/api/access/session"
export const ACCESS_SESSION_REFRESH_ROUTE = "/api/access/session/refresh"
export const ACCESS_SESSION_LOGOUT_ROUTE = "/api/access/session/logout"
/** Machine credential only (the CLI or an operator shell issues the code). */
export const ACCESS_PAIRING_CODES_ROUTE = "/api/access/pairing-codes"

/** The session cookie WaveKit sets (host-only, HttpOnly, SameSite=Strict, Path=/). */
export const ACCESS_SESSION_COOKIE_NAME = "wavekit_session"
/** Request header carrying the session's CSRF token on every unsafe cookie request. */
export const ACCESS_CSRF_HEADER = "X-WaveKit-CSRF"

/**
 * WG9 req 1.2: seconds a browser may cache a successful preflight
 * (`Access-Control-Max-Age`). 600 s is below every browser's own ceiling (Chromium 7 200 s,
 * Firefox 86 400 s), so the value is used as sent: at most one preflight per origin, URL,
 * method and header set every 10 minutes.
 */
export const ACCESS_PREFLIGHT_MAX_AGE_SECONDS = 600

/** A pairing code as issued (`ABCDE-FGHIJ`); the hyphen is optional on input. */
export const ACCESS_PAIRING_CODE = /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/

/**
 * WG9 req 1.5: body of `POST /api/access/pair`. `name` and `kind` are optional and follow the
 * device label rules (`accessDeviceNameSchema`, `ACCESS_DEVICE_KINDS`); an invalid value is a
 * 400 `MALFORMED_REQUEST` that does not consume the code. Unknown keys are refused.
 */
export const accessPairRequestSchema = z
	.object({
		code: z.string().regex(ACCESS_PAIRING_CODE),
		name: accessDeviceNameSchema.optional(),
		kind: accessDeviceKindSchema.optional(),
	})
	.strict()
export type AccessPairRequest = z.infer<typeof accessPairRequestSchema>

/**
 * `POST /api/access/pair` 201, `GET /api/access/session` 200 and
 * `POST /api/access/session/refresh` 200 body. `expiresAt` is integer milliseconds. The
 * `csrfToken` goes in `X-WaveKit-CSRF` on unsafe requests; keep it in memory only.
 */
export const accessSessionDtoSchema = z
	.object({
		deviceId: z.string().regex(/^device_[A-Za-z0-9_-]{43}$/),
		expiresAt: z.number().int().nonnegative().safe(),
		csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	})
	.strict()
export type AccessSessionDto = z.infer<typeof accessSessionDtoSchema>

/** `POST /api/access/session/logout` 200 body. */
export interface AccessLogoutResponse {
	revoked: true
}

/** `POST /api/access/pairing-codes` 201 body (machine credential only). */
export interface AccessPairingCodeResponse {
	code: string
	expiresInSeconds: number
}

/** Every `code` an access route or the access admission answers with (body `{ code }`). */
export type AccessErrorCode =
	| "MALFORMED_REQUEST"
	| "HOST_FORBIDDEN"
	| "ORIGIN_FORBIDDEN"
	| "CSRF_REQUIRED"
	| "PREFLIGHT_FORBIDDEN"
	| "AUTH_REQUIRED"
	| "ACCESS_UNAVAILABLE"
	| "SESSION_REQUIRED"
	| "MACHINE_REQUIRED"
	| "PAIRING_INVALID"
	| "PAIRING_RATE_LIMITED"
	| "PAIRING_CAPACITY"
	| "SESSION_CAPACITY"
	| "ACCESS_CAPACITY"

/** The access denial body: a code only, never a reason text, credential or header value. */
export interface AccessErrorBody {
	code: AccessErrorCode
}
