import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { AccessPolicy, CSRF_HEADER } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"
import type {
	AccessPolicyOptions,
	AccessRequest,
} from "../../../src/access/types.js"

const token = generateMachineToken(() => Buffer.alloc(32, 77))
const digest = digestMachineToken(token)
const allowedOrigin = "http://dashboard.lan:9000"
const bearer = ["Authorization", `Bearer ${token}`]

async function setup() {
	let counter = 0
	let elapsed = 0
	const persist = vi.fn(() => Promise.resolve())
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist,
		epochNow: () => 1_000_000,
		monotonicNow: () => elapsed,
		random: size => Buffer.alloc(size, ++counter),
	})
	const options: AccessPolicyOptions = {
		listenerScheme: "http",
		allowedAuthorities: ["receiver.lan:9000", "localhost:3000", "[::1]:3000"],
		allowedOrigins: [allowedOrigin],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	}
	const policy = new AccessPolicy(options)
	const request = (
		headers: string[] = [],
		overrides: Partial<AccessRequest> = {},
	): AccessRequest => ({
		method: "GET",
		rawTarget: "/api/status",
		rawHeaders: ["Host", "receiver.lan:9000", ...headers],
		transport: "http",
		surface: "api",
		remoteAddress: "127.0.0.1",
		...overrides,
	})
	return {
		sessions,
		policy,
		persist,
		options,
		request,
		advance: (value: number) => {
			elapsed += value
		},
	}
}

describe("one shared admission policy for API, WS and HTTP audio", () => {
	it("enforces exact authority/origin trust independently of valid credentials", async () => {
		const { policy, request } = await setup()
		// Feature: core-access-policy, Property 1: Exact trust boundary
		// Validates: Requirements 2.1, 2.2, 2.3
		fc.assert(
			fc.property(fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/), prefix => {
				for (const host of [
					`${prefix}.receiver.lan:9000`,
					`receiver.lan.${prefix}:9000`,
					"receiver.lan:3000",
					"receiver.lan:80",
				]) {
					expect(
						policy.evaluate(
							request(bearer, { rawHeaders: ["Host", host, ...bearer] }),
						),
					).toMatchObject({ kind: "deny", status: 403, code: "HOST_FORBIDDEN" })
				}
				for (const origin of [
					`http://${prefix}.dashboard.lan:9000`,
					`http://dashboard.lan.${prefix}:9000`,
					"https://dashboard.lan:9000",
					"http://dashboard.lan:3000",
				]) {
					expect(
						policy.evaluate(request([...bearer, "Origin", origin])),
					).toMatchObject({
						kind: "deny",
						status: 403,
						code: "ORIGIN_FORBIDDEN",
					})
				}
			}),
			{ numRuns: 100 },
		)
		for (const host of [
			"RECEIVER.LAN:9000",
			"localhost:3000",
			"[0:0:0:0:0:0:0:1]:3000",
		]) {
			expect(
				policy.evaluate(request([], { rawHeaders: ["Host", host, ...bearer] }))
					.kind,
			).toBe("authenticated")
		}
		expect(
			policy.evaluate(
				request(bearer, {
					rawHeaders: [
						"Host",
						"evil.lan:9000",
						"X-Forwarded-Host",
						"receiver.lan:9000",
						...bearer,
					],
				}),
			),
		).toMatchObject({ code: "HOST_FORBIDDEN" })
	})

	it.each([
		"Host",
		"Origin",
		"Authorization",
		CSRF_HEADER,
		"Sec-Fetch-Site",
		"Access-Control-Request-Method",
		"Access-Control-Request-Headers",
	])("rejects duplicate sensitive %s headers", async name => {
		const { policy, request } = await setup()
		const duplicates = [name, "x", name.toLowerCase(), "x"]
		expect(policy.evaluate(request(duplicates))).toMatchObject({
			kind: "deny",
			status: 400,
			code: "MALFORMED_REQUEST",
		})
	})

	it("rejects malformed header arrays, controls, duplicate session cookies and malformed cookie syntax", async () => {
		const { policy, request } = await setup()
		for (const headers of [
			["Unpaired"],
			["Bad Header", "value"],
			["Authorization", `Bearer ${token}\r\nX: x`],
			["Cookie", "wavekit_session=a; wavekit_session=b"],
			["Cookie", "wavekit_session=a", "Cookie", "other=x; wavekit_session=b"],
			["Cookie", "missing-equals"],
			["Cookie", "wavekit_session=a,b"],
			["Origin", `${allowedOrigin} http://evil.lan`],
			["Origin", `${allowedOrigin},http://evil.lan`],
		])
			expect(policy.evaluate(request(headers))).toMatchObject({
				kind: "deny",
				status: 400,
			})
		expect(
			policy.evaluate(request(["Origin", "null", ...bearer])),
		).toMatchObject({ status: 403, code: "ORIGIN_FORBIDDEN" })
	})

	it("gives bearer precedence without falling back to a valid browser cookie", async () => {
		const { policy, sessions, request } = await setup()
		const session = await sessions.create()
		if (session.kind !== "created") throw new Error("Expected session")
		const browser = [
			"Cookie",
			`wavekit_session=${session.cookieValue}`,
			"Origin",
			allowedOrigin,
		]
		expect(
			policy.evaluate(request([...browser, ...bearer], { method: "DELETE" })),
		).toMatchObject({
			kind: "authenticated",
			principal: { kind: "machine", id: "machine", expiresAt: null },
		})
		for (const auth of [
			"Basic abc",
			"Bearer invalid",
			`Bearer ${token}=`,
			`Bearer ${generateMachineToken(() => Buffer.alloc(32, 88))}`,
		]) {
			expect(
				policy.evaluate(request([...browser, "Authorization", auth])),
			).toMatchObject({ kind: "deny", status: 401, code: "AUTH_REQUIRED" })
		}
		expect(
			policy.evaluate(request([...bearer, "Origin", "http://evil.lan"])),
		).toMatchObject({ status: 403 })
	})

	it("requires explicit browser Origin/CSRF proof for unsafe HTTP and Origin for every cookie WS upgrade", async () => {
		const { policy, sessions, request } = await setup()
		const session = await sessions.create()
		if (session.kind !== "created") throw new Error("Expected session")
		const cookie = ["Cookie", `other=x; wavekit_session=${session.cookieValue}`]
		for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
			for (const proof of [
				[],
				["Origin", allowedOrigin],
				[CSRF_HEADER, session.csrfToken],
				["Origin", allowedOrigin, CSRF_HEADER, "wrong"],
			]) {
				expect(
					policy.evaluate(request([...cookie, ...proof], { method })),
				).toMatchObject({ status: 403, code: "CSRF_REQUIRED" })
			}
			expect(
				policy.evaluate(
					request(
						[
							...cookie,
							"Origin",
							allowedOrigin,
							CSRF_HEADER,
							session.csrfToken,
						],
						{ method },
					),
				).kind,
			).toBe("authenticated")
		}
		expect(
			policy.evaluate(
				request([...cookie, "Sec-Fetch-Site", "same-origin"], {
					transport: "websocket",
				}),
			),
		).toMatchObject({ status: 403, code: "ORIGIN_FORBIDDEN" })
		expect(
			policy.evaluate(
				request([...cookie, "Origin", allowedOrigin], {
					transport: "websocket",
					surface: "audio",
				}),
			).kind,
		).toBe("authenticated")
		expect(
			policy.evaluate(request(bearer, { transport: "websocket" })).kind,
		).toBe("authenticated")
	})

	it("permits cookie safe reads without Origin only with positive fetch metadata, and never renews implicitly", async () => {
		const { policy, sessions, request, advance, persist } = await setup()
		const session = await sessions.create()
		if (session.kind !== "created") throw new Error("Expected session")
		const cookie = ["Cookie", `wavekit_session=${session.cookieValue}`]
		advance(29 * 24 * 60 * 60 * 1000)
		for (const method of ["GET", "HEAD"]) {
			for (const metadata of [
				[],
				["Sec-Fetch-Site", "same-site"],
				["Sec-Fetch-Site", "cross-site"],
			])
				expect(
					policy.evaluate(request([...cookie, ...metadata], { method })),
				).toMatchObject({ status: 403 })
			for (const metadata of [
				["Origin", allowedOrigin],
				["Sec-Fetch-Site", "same-origin"],
				["Sec-Fetch-Site", "none"],
			])
				expect(
					policy.evaluate(
						request([...cookie, ...metadata], { method, surface: "audio" }),
					).kind,
				).toBe("authenticated")
		}
		expect(sessions.lookup(session.cookieValue)?.expiresAt).toBe(
			session.expiresAt,
		)
		expect(persist).toHaveBeenCalledOnce()
		advance(24 * 60 * 60 * 1000)
		expect(
			policy.evaluate(request([...cookie, "Origin", allowedOrigin])),
		).toMatchObject({ status: 401, code: "AUTH_REQUIRED" })
	})

	it("limits public health to exact API GET/HEAD paths after host and origin validation", async () => {
		const { policy, request } = await setup()
		for (const rawTarget of ["/health", "/health/live", "/health?probe=1"])
			for (const method of ["GET", "HEAD"])
				expect(policy.evaluate(request([], { rawTarget, method })).kind).toBe(
					"public-health",
				)
		for (const rawTarget of [
			"/health/ready",
			"/healthanything",
			"/health/live/",
			"/health/../live",
			"/%68ealth",
			"/api/status",
			"/docs",
			"/recordings/x",
			"/unknown",
		]) {
			expect(policy.evaluate(request([], { rawTarget }))).toMatchObject({
				status: 401,
			})
			expect(policy.evaluate(request(bearer, { rawTarget })).kind).toBe(
				"authenticated",
			)
		}
		for (const override of [
			{ method: "POST" },
			{ surface: "audio" },
			{ transport: "websocket" },
		] as const)
			expect(
				policy.evaluate(request([], { rawTarget: "/health", ...override })),
			).toMatchObject({ status: 401 })
		expect(
			policy.evaluate(
				request(["Origin", "http://evil.lan"], { rawTarget: "/health" }),
			),
		).toMatchObject({ status: 403 })
		expect(
			policy.evaluate(
				request([], { rawTarget: "/health", rawHeaders: ["Host", "evil.lan"] }),
			),
		).toMatchObject({ status: 403 })
	})

	it("admits only finite credential-free preflight and leaves actual requests protected", async () => {
		const { policy, request } = await setup()
		const preflight = [
			"Origin",
			allowedOrigin,
			"Access-Control-Request-Method",
			"POST",
			"Access-Control-Request-Headers",
			"authorization, content-type, x-wavekit-csrf, range",
		]
		const admission = policy.evaluate(
			request(preflight, { method: "OPTIONS", surface: "audio" }),
		)
		expect(admission).toMatchObject({
			kind: "preflight",
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": allowedOrigin,
				"Access-Control-Allow-Credentials": "true",
				"Cache-Control": "no-store",
				Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
			},
		})
		for (const denied of [
			["Origin", allowedOrigin, "Access-Control-Request-Method", "TRACE"],
			["Access-Control-Request-Method", "GET"],
			[
				...preflight.slice(0, 4),
				"Access-Control-Request-Headers",
				"X-Arbitrary",
			],
			[
				...preflight.slice(0, 4),
				"Access-Control-Request-Headers",
				"Range,Range",
			],
			[...preflight.slice(0, 4), "Access-Control-Request-Headers", ""],
		])
			expect(
				policy.evaluate(request(denied, { method: "OPTIONS" })),
			).toMatchObject({ status: 403, code: "PREFLIGHT_FORBIDDEN" })
		expect(
			policy.evaluate(
				request(["Origin", allowedOrigin], { method: "OPTIONS" }),
			),
		).toMatchObject({ status: 401 })
		expect(
			policy.evaluate(request(["Origin", allowedOrigin], { method: "POST" })),
		).toMatchObject({ status: 401 })
	})

	it("does not authenticate URL/subprotocol credentials or echo malformed targets", async () => {
		const { policy, request } = await setup()
		for (const rawTarget of [
			`/api/status?token=${token}`,
			`/api/status?authorization=Bearer%20${token}`,
		]) {
			const admission = policy.evaluate(request([], { rawTarget }))
			expect(admission).toMatchObject({ status: 401 })
			expect(JSON.stringify(admission)).not.toContain(token)
		}
		expect(
			policy.evaluate(
				request(["Sec-WebSocket-Protocol", token], { transport: "websocket" }),
			),
		).toMatchObject({ status: 401 })
		for (const rawTarget of [
			`http://user:${token}@receiver.lan/api/status`,
			"//receiver.lan/api/status",
			"/api/%zz",
			"/api/status#fragment",
			"/api\\status",
			"/api/status\n",
		])
			expect(policy.evaluate(request(bearer, { rawTarget }))).toMatchObject({
				status: 400,
			})
	})

	it("returns readable no-store failures only to allowed origins, and never serializes secrets", async () => {
		const { policy, request } = await setup()
		for (const headers of [
			["Origin", allowedOrigin],
			["Origin", allowedOrigin, "Authorization", "invalid"],
			[
				"Origin",
				allowedOrigin,
				"Authorization",
				"invalid",
				"authorization",
				"invalid",
			],
		]) {
			expect(policy.evaluate(request(headers))).toMatchObject({
				kind: "deny",
				headers: {
					"Cache-Control": "no-store",
					"Access-Control-Allow-Origin": allowedOrigin,
					"Access-Control-Allow-Credentials": "true",
				},
			})
		}
		for (const headers of [
			[],
			["Origin", "http://evil.lan"],
			["Origin", allowedOrigin, "Origin", allowedOrigin],
		])
			expect(
				policy.evaluate(request(headers)).headers[
					"Access-Control-Allow-Origin"
				],
			).toBeUndefined()
		expect(JSON.stringify(policy)).toBe("{}")
		expect(JSON.stringify(policy.evaluate(request(bearer)))).not.toContain(
			token,
		)
	})

	it("returns 503 after browser persistence fails while machine access remains available", async () => {
		const { policy, sessions, request, persist } = await setup()
		const session = await sessions.create()
		if (session.kind !== "created") throw new Error("Expected session")
		persist.mockRejectedValueOnce(new Error("storage failed"))
		await expect(sessions.renew(session.principalId)).rejects.toMatchObject({
			code: "ACCESS_UNAVAILABLE",
		})
		expect(
			policy.evaluate(
				request([
					"Origin",
					allowedOrigin,
					"Cookie",
					`wavekit_session=${session.cookieValue}`,
				]),
			),
		).toMatchObject({ status: 503, code: "ACCESS_UNAVAILABLE" })
		expect(policy.evaluate(request(bearer))).toMatchObject({
			kind: "authenticated",
			principal: { kind: "machine" },
		})
	})

	it("keeps the exact pairing boundary separate from normal authenticated admission", async () => {
		const { policy, request } = await setup()
		const original = request(["Origin", allowedOrigin], {
			method: "POST",
			rawTarget: "/api/access/pair",
		})
		expect(policy.validatePairingRequest(original)).toMatchObject({
			kind: "pairing",
		})
		expect(policy.evaluate(original)).toMatchObject({
			kind: "deny",
			status: 401,
		})
		for (const rawTarget of [
			"/health",
			"/api/access/pair?code=x",
			"/api/access/pair/",
			"/api/access/%70air",
			"/api/access/session",
		])
			expect(
				policy.validatePairingRequest({ ...original, rawTarget }),
			).toMatchObject({ kind: "deny", status: 400 })
		expect(
			policy.validatePairingRequest(
				request([], { method: "POST", rawTarget: "/api/access/pair" }),
			),
		).toMatchObject({ kind: "deny", status: 403 })
	})

	it("rejects duplicate or contradictory Upgrade facts before cookie admission", async () => {
		const { policy, request } = await setup()
		for (const headers of [
			["Upgrade", "websocket", "upgrade", "websocket"],
			["Upgrade", "websocket, h2c"],
			["Upgrade", "h2c"],
		])
			expect(
				policy.evaluate(
					request([...bearer, ...headers], { transport: "websocket" }),
				),
			).toMatchObject({ kind: "deny", status: 400 })
		expect(
			policy.evaluate(request([...bearer, "Upgrade", "websocket"])),
		).toMatchObject({ kind: "deny", status: 400 })
		expect(
			policy.evaluate(
				request([...bearer, "Upgrade", "WebSocket"], {
					transport: "websocket",
				}),
			),
		).toMatchObject({ kind: "authenticated" })
	})

	it("exposes only the original validated cookie privately for renewal", async () => {
		const { policy, sessions, request } = await setup()
		const session = await sessions.create()
		if (session.kind !== "created") throw new Error("Expected session")
		const admission = policy.evaluate(
			request([
				"Cookie",
				`wavekit_session=${session.cookieValue}`,
				"Origin",
				allowedOrigin,
			]),
		)
		expect(admission.kind).toBe("authenticated")
		if (admission.kind === "authenticated")
			expect(admission.sessionCookie).toBe(session.cookieValue)
		expect(JSON.stringify(admission)).not.toContain(session.cookieValue)
		expect(policy.sessionCookieName).toBe("wavekit_session")
		expect(policy.listenerScheme).toBe("http")
		expect(policy.usesSessionStore(sessions)).toBe(true)
	})

	it("rejects wildcard/bind-all authority config, bad digest lengths and incompatible session binding safely", async () => {
		const { options } = await setup()
		for (const invalid of [
			{ allowedAuthorities: ["0.0.0.0:9000"] },
			{ allowedAuthorities: ["[::]:9000"] },
			{ allowedAuthorities: ["*.lan:9000"] },
			{ allowedOrigins: ["http://dashboard.lan/path"] },
			{ machineSecretDigest: Buffer.alloc(31) },
			{ machineSecretDigest: Buffer.alloc(32, 88) },
		]) {
			expect(() => new AccessPolicy({ ...options, ...invalid })).toThrowError(
				"Invalid access policy configuration",
			)
		}
	})
})


describe("separate non-authenticating bootstrap admission", () => {
	it("ignores unambiguous credentials without session lookup, persistence or principal", async () => {
		const { policy, sessions, request, persist } = await setup()
		const lookup = vi.spyOn(sessions, "lookup")
		for (const method of ["GET", "HEAD"])
			for (const credentials of [[], bearer, ["Authorization", "Basic invalid"], ["Authorization", "Bearer wrong"], ["Cookie", "wavekit_session=expired"]]) {
				const input = request(credentials, { method, rawTarget: "/api/access/bootstrap" })
				const before = lookup.mock.calls.length
				expect(policy.validatePublicBootstrapRequest(input)).toEqual({ kind: "public-bootstrap", headers: { "Cache-Control": "no-store", Vary: "Origin" } })
				expect(lookup.mock.calls.length).toBe(before)
				if (credentials !== bearer) expect(policy.evaluate(input).kind).toBe("deny")
			}
		expect(lookup).toHaveBeenCalledTimes(2) // Default evaluate still performs ordinary cookie lookup for GET/HEAD.
		expect(persist).not.toHaveBeenCalled()
	})

	it("limits the exception to the exact raw tuple while default evaluate stays protected", async () => {
		const { policy, request } = await setup()
		const bootstrap = request([], { rawTarget: "/api/access/bootstrap" })
		// Feature: core-access-policy, Property 5: No implicit privilege
		// Validates: Requirements 3.3, 3.4, 3.5, 3.6, 6.1
		fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 30 }), suffix => {
			expect(policy.validatePublicBootstrapRequest({ ...bootstrap, rawTarget: bootstrap.rawTarget + "?" + encodeURIComponent(suffix) }).kind).toBe("deny")
		}), { numRuns: 100 })
		for (const override of [
			{ rawTarget: "/api/access/bootstrap/" }, { rawTarget: "/api/access/%62ootstrap" },
			{ rawTarget: "/prefix/api/access/bootstrap" }, { method: "POST" },
			{ method: "OPTIONS" }, { surface: "audio" }, { transport: "websocket" },
		] as const) expect(policy.validatePublicBootstrapRequest({ ...bootstrap, ...override })).toMatchObject({ kind: "deny", status: 400 })
		expect(policy.evaluate(bootstrap)).toMatchObject({ kind: "deny", status: 401 })
		expect(policy.evaluate({ ...bootstrap, rawHeaders: [...bootstrap.rawHeaders, ...bearer] }).kind).toBe("authenticated")
	})

	it("retains raw Host/Origin/header validation before public admission", async () => {
		const { policy, request } = await setup()
		for (const headers of [
			["Authorization", "Bearer one,two"], ["Authorization", "one", "authorization", "two"],
			["Cookie", "wavekit_session=a; wavekit_session=b"], ["Cookie", "missing-equals"],
			["Upgrade", "websocket"],
		]) expect(policy.validatePublicBootstrapRequest(request(headers, { rawTarget: "/api/access/bootstrap" }))).toMatchObject({ kind: "deny", status: 400 })
		expect(policy.validatePublicBootstrapRequest(request(["Origin", allowedOrigin], { rawTarget: "/api/access/bootstrap" }))).toMatchObject({ kind: "public-bootstrap", headers: { "Access-Control-Allow-Origin": allowedOrigin, "Access-Control-Allow-Credentials": "true" } })
		expect(policy.validatePublicBootstrapRequest(request(["Origin", "null"], { rawTarget: "/api/access/bootstrap" }))).toMatchObject({ status: 403 })
		expect(policy.validatePublicBootstrapRequest(request([], { rawTarget: "/api/access/bootstrap", rawHeaders: ["Host", "evil.lan", "X-Forwarded-Host", "receiver.lan:9000"] }))).toMatchObject({ status: 403, code: "HOST_FORBIDDEN" })
	})

	it("allows public metadata when session storage fails without conferring session authority", async () => {
		const { policy, sessions, persist, request } = await setup()
		const created = await sessions.create()
		if (created.kind !== "created") throw new Error("Expected session")
		persist.mockRejectedValueOnce(new Error("private storage fault"))
		await expect(sessions.renew(created.principalId)).rejects.toMatchObject({ code: "ACCESS_UNAVAILABLE" })
		const input = request(["Cookie", `wavekit_session=${created.cookieValue}`], { rawTarget: "/api/access/bootstrap" })
		expect(policy.validatePublicBootstrapRequest(input).kind).toBe("public-bootstrap")
		expect(policy.evaluate(input)).toMatchObject({ status: 503 })
	})
})
