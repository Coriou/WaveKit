// WG9 lane PA: requirement 1.3 acceptance. A web app on its own 127.0.0.1 port (same scheme and
// hostname as the API) drives an actual protected server: pair, session, refresh, logout, CSRF,
// preflights, WebSocket, audio, and a foreign origin denied at each step. Also the https form
// (tls-termination exposure, no TLS on the wire), the 1.7 configuration refusal and the 1.9
// legacy check.
import type { IncomingHttpHeaders } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import {
	ACCESS_PREFLIGHT_MAX_AGE_SECONDS,
	accessDevicesDtoSchema,
	accessSessionDtoSchema,
} from "@wavekit/api-types"
import { validateProtectedRuntimeMapping } from "../../../src/access/runtime-config.js"
import {
	PREFLIGHT_HEADERS,
	PREFLIGHT_METHODS,
} from "../../../src/access/policy.js"
import { machinePost } from "../../helpers/access-browser/browser-client.js"
import type {
	BrowserClient,
	BrowserExchange,
} from "../../helpers/access-browser/browser-client.js"
import {
	rawRequest,
	startLegacyServer,
	startWebOriginStack,
} from "../../helpers/access-browser/web-origin-stack.js"
import type { WebOriginStack } from "../../helpers/access-browser/web-origin-stack.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function stack(scheme: "http" | "https"): Promise<WebOriginStack> {
	const env = await startWebOriginStack(scheme)
	cleanups.push(() => env.close())
	return env
}

function setCookies(headers: IncomingHttpHeaders): string[] {
	const value = headers["set-cookie"]
	return value === undefined ? [] : value
}

/** `Access-Control-Allow-*` and Max-Age: what would make a response readable or cached. */
function accessControlHeaders(headers: IncomingHttpHeaders): string[] {
	return Object.keys(headers).filter(
		name =>
			name.startsWith("access-control-allow-") ||
			name === "access-control-max-age",
	)
}

/** A foreign-origin refusal: 403 ORIGIN_FORBIDDEN, nothing CORS-readable, no cookie. */
function expectForeignDenied(response: {
	status: number
	headers: IncomingHttpHeaders
	networkBody?: string
	body?: string
}): void {
	expect(response.status).toBe(403)
	expect(JSON.parse(response.networkBody ?? response.body ?? "")).toEqual({
		code: "ORIGIN_FORBIDDEN",
	})
	expect(accessControlHeaders(response.headers)).toEqual([])
	expect(setCookies(response.headers)).toEqual([])
}

async function issueCode(env: WebOriginStack): Promise<string> {
	const issued = await machinePost(
		{ host: env.apiAuthority, port: env.apiPort },
		env.token,
		"/api/access/pairing-codes",
	)
	expect(issued.status).toBe(201)
	const code = (issued.json() as { code?: unknown }).code
	if (typeof code !== "string") throw new Error("Missing pairing code")
	return code
}

function expectCookieAttributes(
	paired: BrowserExchange,
	scheme: "http" | "https",
): void {
	const cookies = setCookies(paired.headers)
	expect(cookies).toHaveLength(1)
	const attributes = (cookies[0] ?? "")
		.split(";")
		.map(part => part.trim().split("=")[0]?.toLowerCase())
	expect(cookies[0]).toMatch(/^wavekit_session=[^;]+;/)
	expect(attributes).toContain("httponly")
	expect(cookies[0]).toMatch(/;\s*SameSite=Strict(;|$)/)
	expect(cookies[0]).toMatch(/;\s*Path=\/(;|$)/)
	expect(cookies[0]).toMatch(/;\s*Max-Age=2592000(;|$)/)
	expect(attributes).not.toContain("domain")
	if (scheme === "https") expect(attributes).toContain("secure")
	else expect(attributes).not.toContain("secure")
}

/** Cross-origin CORS answer for the web origin on an actual (non-preflight) response. */
function expectWebCors(env: WebOriginStack, headers: IncomingHttpHeaders) {
	expect(headers["access-control-allow-origin"]).toBe(env.webOrigin)
	expect(headers["access-control-allow-credentials"]).toBe("true")
}

async function pair(
	env: WebOriginStack,
	client: BrowserClient,
	label: { name?: string; kind?: string } = {},
): Promise<BrowserExchange> {
	const code = await issueCode(env)
	const paired = await client.fetch(`${env.apiOrigin}/api/access/pair`, {
		method: "POST",
		json: { code, ...label },
	})
	expect(paired.status).toBe(201)
	// application/json from another origin is not a simple request: the browser preflights.
	expect(paired.preflight?.status).toBe(204)
	expect(paired.corsBlocked).toBe(false)
	expectWebCors(env, paired.headers)
	accessSessionDtoSchema.parse(paired.json())
	expectCookieAttributes(paired, env.scheme)
	expect(client.documentCookie()).toBe("")
	return paired
}

function preflightHeaders(origin: string): Record<string, string> {
	return {
		Origin: origin,
		"Access-Control-Request-Method": "POST",
		"Access-Control-Request-Headers": "content-type, x-wavekit-csrf",
	}
}

async function runLifecycle(env: WebOriginStack): Promise<void> {
	const host = { Host: env.apiAuthority }
	const web = env.browser()
	expect(web.documentOrigin).not.toBe(env.apiOrigin)

	// Bootstrap is readable from the web origin; it sets no cookie.
	const bootstrap = await web.fetch(`${env.apiOrigin}/api/access/bootstrap`)
	expect(bootstrap.status).toBe(200)
	expect(bootstrap.corsBlocked).toBe(false)
	expect(setCookies(bootstrap.headers)).toEqual([])

	// Pairing without a label, then the session read and refresh.
	const paired = await pair(env, web)
	const session = accessSessionDtoSchema.parse(paired.json())
	const read = await web.fetch(`${env.apiOrigin}/api/access/session`)
	expect(read.status).toBe(200)
	expect(read.corsBlocked).toBe(false)
	expectWebCors(env, read.headers)
	expect(accessSessionDtoSchema.parse(read.json())).toEqual(session)
	const refreshed = await web.refresh()
	expect(refreshed.status).toBe(200)
	expect(refreshed.preflight?.status).toBe(204)
	expect(accessSessionDtoSchema.parse(refreshed.json()).deviceId).toBe(
		session.deviceId,
	)

	// A REST mutation with the CSRF header succeeds; without it, 403 CSRF_REQUIRED.
	const labelled = await web.fetch(
		`${env.apiOrigin}/api/access/devices/label`,
		{
			method: "POST",
			json: { deviceId: session.deviceId, kind: "desktop" },
		},
	)
	expect(labelled.status).toBe(200)
	expect(labelled.preflight?.status).toBe(204)
	expect(labelled.json()).toEqual({ updated: true })
	const noCsrf = await web.fetch(`${env.apiOrigin}/api/access/devices/label`, {
		method: "POST",
		json: { deviceId: session.deviceId, kind: "phone" },
		csrf: false,
	})
	expect(noCsrf.sent).toBe(true)
	expect(noCsrf.status).toBe(403)
	expect(noCsrf.json()).toEqual({ code: "CSRF_REQUIRED" })
	expectWebCors(env, noCsrf.headers)

	// Preflights: allowed (with cached age), foreign, Origin null, no request method.
	const allowed = await rawRequest(
		env.apiPort,
		"OPTIONS",
		"/api/access/devices/label",
		{ ...host, ...preflightHeaders(env.webOrigin) },
	)
	expect(allowed.status).toBe(204)
	expect(allowed.headers["access-control-allow-origin"]).toBe(env.webOrigin)
	expect(allowed.headers["access-control-allow-credentials"]).toBe("true")
	expect(allowed.headers["access-control-max-age"]).toBe(
		String(ACCESS_PREFLIGHT_MAX_AGE_SECONDS),
	)
	expect(ACCESS_PREFLIGHT_MAX_AGE_SECONDS).toBe(600)
	expect(allowed.headers["access-control-allow-methods"]).toBe(
		PREFLIGHT_METHODS.join(", "),
	)
	expect(allowed.headers["access-control-allow-headers"]).toBe(
		PREFLIGHT_HEADERS.join(", "),
	)
	expect(
		allowed.headers["access-control-allow-private-network"],
	).toBeUndefined()
	expect(setCookies(allowed.headers)).toEqual([])
	for (const origin of [env.foreignPortOrigin, env.foreignHostOrigin, "null"]) {
		const denied = await rawRequest(
			env.apiPort,
			"OPTIONS",
			"/api/access/devices/label",
			{ ...host, ...preflightHeaders(origin) },
		)
		expectForeignDenied(denied)
		expect(denied.headers["access-control-max-age"]).toBeUndefined()
	}
	const noMethod = await rawRequest(
		env.apiPort,
		"OPTIONS",
		"/api/access/devices/label",
		{ ...host, Origin: env.webOrigin },
	)
	expect(noMethod.headers["access-control-max-age"]).toBeUndefined()
	expect(noMethod.headers["access-control-allow-methods"]).toBeUndefined()

	// WebSocket with the cookie and the web Origin; a foreign Origin is refused.
	const wsUrl = `${env.apiOrigin.replace(/^http/, "ws")}/ws`
	const socket = await web.openSocket(wsUrl)
	expect(socket.opened).toBe(true)
	for (const origin of [env.foreignPortOrigin, env.foreignHostOrigin]) {
		const refused = await web.openSocket(wsUrl, { origin })
		expect(refused.opened).toBe(false)
		expect(refused.status).toBe(403)
	}

	// Audio on the audio origin, credentialed, from the web page.
	const audio = await web.openStream(`${env.analogOrigin}/stream.wav`)
	expect(audio.status).toBe(200)
	expect(audio.corsBlocked).toBe(false)
	expect(audio.headers["access-control-allow-origin"]).toBe(env.webOrigin)
	expect(audio.headers["access-control-allow-credentials"]).toBe("true")
	expect(audio.body.startsWith("RIFF")).toBe(true)
	const foreignAudio = await web.openStream(`${env.analogOrigin}/stream.wav`, {
		origin: env.foreignPortOrigin,
	})
	expect(foreignAudio.status).toBe(403)
	expect(foreignAudio.body).toContain("ORIGIN_FORBIDDEN")
	expect(accessControlHeaders(foreignAudio.headers)).toEqual([])
	foreignAudio.close()

	// A foreign page denied at every REST step (the live cookie is offered where it would be).
	for (const origin of [env.foreignPortOrigin, env.foreignHostOrigin]) {
		const code = await issueCode(env)
		const pairing = await rawRequest(
			env.apiPort,
			"POST",
			"/api/access/pair",
			{ ...host, Origin: origin, "Content-Type": "application/json" },
			JSON.stringify({ code }),
		)
		expectForeignDenied(pairing)
		const cookie = web.jar.cookieHeader(
			`${env.apiOrigin}/api/access/session`,
			env.webOrigin,
		)
		if (!cookie) throw new Error("Missing session cookie")
		const sessionRead = await rawRequest(
			env.apiPort,
			"GET",
			"/api/access/session",
			{ ...host, Origin: origin, Cookie: cookie },
		)
		expectForeignDenied(sessionRead)
		const mutation = await rawRequest(
			env.apiPort,
			"POST",
			"/api/access/devices/label",
			{
				...host,
				Origin: origin,
				Cookie: cookie,
				"Content-Type": "application/json",
				"X-WaveKit-CSRF": session.csrfToken,
			},
			JSON.stringify({ deviceId: session.deviceId, kind: "phone" }),
		)
		expectForeignDenied(mutation)
		// The code a foreign page tried is still usable by the web app.
		const other = env.browser()
		const retry = await other.fetch(`${env.apiOrigin}/api/access/pair`, {
			method: "POST",
			json: { code },
		})
		expect(retry.status).toBe(201)
		await other.fetch(`${env.apiOrigin}/api/access/session/logout`, {
			method: "POST",
		})
	}
	// The foreign attempts changed nothing: the label is still the CSRF-checked one.
	const devices = accessDevicesDtoSchema.parse(
		(await web.fetch(`${env.apiOrigin}/api/access/devices`)).json(),
	)
	expect(
		devices.devices.find(device => device.deviceId === session.deviceId),
	).toMatchObject({ kind: "desktop", current: true })

	// Pairing with a name and kind (req 1.5) shows them in the device list.
	const named = env.browser()
	const namedPaired = await pair(env, named, {
		name: "Web dashboard",
		kind: "browser",
	})
	const namedId = accessSessionDtoSchema.parse(namedPaired.json()).deviceId
	const listed = accessDevicesDtoSchema.parse(
		(await named.fetch(`${env.apiOrigin}/api/access/devices`)).json(),
	)
	expect(
		listed.devices.find(device => device.deviceId === namedId),
	).toMatchObject({ name: "Web dashboard", kind: "browser", current: true })

	// Logout from the web origin ends the session and closes the transports.
	const logout = await web.fetch(`${env.apiOrigin}/api/access/session/logout`, {
		method: "POST",
	})
	expect(logout.status).toBe(200)
	expect(logout.json()).toEqual({ revoked: true })
	expectWebCors(env, logout.headers)
	expect(await socket.closeCode).toBe(1008)
	await audio.closed
	const after = await web.fetch(`${env.apiOrigin}/api/access/session`)
	expect(after.status).toBe(401)
	expect(after.json()).toEqual({ code: "AUTH_REQUIRED" })
}

describe(
	"web origin on another port of the API hostname (WG9 1.3)",
	{ timeout: 15_000 },
	() => {
		it("pairs, reads, refreshes, mutates with CSRF, streams and logs out over http; foreign origins denied", async () => {
			const env = await stack("http")
			expect(new URL(env.webOrigin).hostname).toBe(
				new URL(env.apiOrigin).hostname,
			)
			await runLifecycle(env)
		})

		it("https form (tls-termination, plaintext listener behind a terminator stand-in) sets Secure and the same CORS", async () => {
			const env = await stack("https")
			expect(env.access.exposure).toBe("tls-termination")
			expect(env.webOrigin.startsWith("https://127.0.0.1:")).toBe(true)
			await runLifecycle(env)
			// A Secure cookie is never offered to the http form of the same host.
			const client = env.browser()
			await pair(env, client)
			expect(
				client.jar.cookieHeader(
					`${env.apiOrigin.replace(/^https/, "http")}/api/access/session`,
					env.webOrigin.replace(/^https/, "http"),
				),
			).toBeUndefined()
		})

		it("keeps refusing a web origin on another hostname or scheme in the configuration check (1.7)", async () => {
			const env = await stack("http")
			const base = env.access
			const api = { host: "127.0.0.1", port: env.apiPort }
			const ports = {
				analog: env.analogPort,
				digital: Number(new URL(env.digitalOrigin).port),
			}
			for (const extra of [
				env.foreignHostOrigin,
				env.webOrigin.replace(/^http/, "https"),
				"http://receiver.example:9446",
			])
				expect(() =>
					validateProtectedRuntimeMapping(
						{ ...base, allowedOrigins: [...base.allowedOrigins, extra] },
						api,
						ports,
					),
				).toThrow(expect.objectContaining({ code: "ACCESS_CONFIG_INVALID" }))
		})
	},
)

describe("legacy mode stays as before (WG9 1.9)", () => {
	it("mounts no access routes and sends no Access-Control-Max-Age", async () => {
		const legacy = await startLegacyServer()
		cleanups.push(() => legacy.close())
		const origin = "http://127.0.0.1:24999"
		const host = { Host: `127.0.0.1:${legacy.port}` }
		for (const path of [
			"/api/access/pair",
			"/api/access/session/refresh",
			"/api/access/session/logout",
		]) {
			const response = await rawRequest(
				legacy.port,
				"POST",
				path,
				{ ...host, Origin: origin, "Content-Type": "application/json" },
				"{}",
			)
			expect(response.status).toBe(404)
			expect(setCookies(response.headers)).toEqual([])
		}
		const session = await rawRequest(
			legacy.port,
			"GET",
			"/api/access/session",
			{
				...host,
				Origin: origin,
			},
		)
		expect(session.status).toBe(404)
		const preflight = await rawRequest(
			legacy.port,
			"OPTIONS",
			"/api/access/pair",
			{ ...host, ...preflightHeaders(origin) },
		)
		// @fastify/cors as registered in server.ts: reflect the Origin, credentials, no maxAge.
		expect(preflight.status).toBe(204)
		expect(preflight.headers["access-control-allow-origin"]).toBe(origin)
		expect(preflight.headers["access-control-allow-credentials"]).toBe("true")
		expect(preflight.headers["access-control-allow-methods"]).toBe(
			"GET, POST, PUT, PATCH, DELETE, OPTIONS",
		)
		expect(preflight.headers["access-control-allow-headers"]).toBe(
			"Content-Type, Authorization",
		)
		expect(preflight.headers["access-control-max-age"]).toBeUndefined()
		expect(setCookies(preflight.headers)).toEqual([])
	})
})
