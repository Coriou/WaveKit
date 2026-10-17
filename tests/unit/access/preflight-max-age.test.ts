import fc from "fast-check"
import { ACCESS_PREFLIGHT_MAX_AGE_SECONDS } from "@wavekit/api-types"
import { describe, expect, it } from "vitest"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import {
	AccessPolicy,
	PREFLIGHT_HEADERS,
	PREFLIGHT_METHODS,
} from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"
import type { AccessRequest } from "../../../src/access/types.js"

const origin = "http://receiver.lan:9000"

async function policy(): Promise<AccessPolicy> {
	const digest = digestMachineToken(
		generateMachineToken(() => Buffer.alloc(32, 7)),
	)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: () => Promise.resolve(),
		epochNow: () => 1_000_000,
		monotonicNow: () => 0,
		random: size => Buffer.alloc(size, 3),
	})
	return new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: ["receiver.lan:9000"],
		allowedOrigins: [origin],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
}

const request = (method: string, headers: string[]): AccessRequest => ({
	method,
	rawTarget: "/api/status",
	rawHeaders: ["Host", "receiver.lan:9000", ...headers],
	transport: "http",
	surface: "api",
	remoteAddress: "127.0.0.1",
})

const base = { "Cache-Control": "no-store", Vary: "Origin" }
const reflected = {
	...base,
	"Access-Control-Allow-Origin": origin,
	"Access-Control-Allow-Credentials": "true",
}

describe("preflight Access-Control-Max-Age (WG9 req 1.2)", () => {
	it("adds Max-Age only to the allowed 204; goldens otherwise unchanged", async () => {
		const p = await policy()
		expect(ACCESS_PREFLIGHT_MAX_AGE_SECONDS).toBe(600)
		expect(
			p.evaluate(
				request("OPTIONS", [
					"Origin",
					origin,
					"Access-Control-Request-Method",
					"POST",
					"Access-Control-Request-Headers",
					"content-type, x-wavekit-csrf",
				]),
			),
		).toStrictEqual({
			kind: "preflight",
			status: 204,
			headers: {
				"Cache-Control": "no-store",
				Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
				"Access-Control-Allow-Origin": origin,
				"Access-Control-Allow-Credentials": "true",
				"Access-Control-Allow-Methods":
					"GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
				"Access-Control-Allow-Headers":
					"Authorization, Content-Type, X-WaveKit-CSRF, X-Correlation-Id, Range",
				"Access-Control-Max-Age": "600",
			},
		})
		const golden: [string, string[], number, string, Record<string, string>][] =
			[
				[
					"OPTIONS",
					[
						"Origin",
						"http://evil.example",
						"Access-Control-Request-Method",
						"POST",
					],
					403,
					"ORIGIN_FORBIDDEN",
					base,
				],
				[
					"OPTIONS",
					["Origin", "null", "Access-Control-Request-Method", "POST"],
					403,
					"ORIGIN_FORBIDDEN",
					base,
				],
				[
					"OPTIONS",
					["Access-Control-Request-Method", "POST"],
					403,
					"PREFLIGHT_FORBIDDEN",
					base,
				],
				[
					"OPTIONS",
					["Origin", origin, "Access-Control-Request-Method", "TRACE"],
					403,
					"PREFLIGHT_FORBIDDEN",
					reflected,
				],
				[
					"OPTIONS",
					[
						"Origin",
						origin,
						"Access-Control-Request-Method",
						"GET",
						"Access-Control-Request-Headers",
						"x-evil",
					],
					403,
					"PREFLIGHT_FORBIDDEN",
					reflected,
				],
				[
					"OPTIONS",
					[
						"Origin",
						origin,
						"Access-Control-Request-Method",
						"GET",
						"Access-Control-Request-Headers",
						"range, Range",
					],
					403,
					"PREFLIGHT_FORBIDDEN",
					reflected,
				],
				["OPTIONS", ["Origin", origin], 401, "AUTH_REQUIRED", reflected],
				["GET", ["Origin", origin], 401, "AUTH_REQUIRED", reflected],
				["POST", ["Origin", origin], 401, "AUTH_REQUIRED", reflected],
			]
		for (const [method, headers, status, code, expected] of golden)
			expect(p.evaluate(request(method, headers))).toStrictEqual({
				kind: "deny",
				status,
				code,
				headers: expected,
			})
	})

	// Feature: web-gaps-9, Property 1: Preflight cache only on success
	// Validates: Requirements 1.2, 1.9
	it("Max-Age appears exactly on allowed 204 preflights", async () => {
		const p = await policy()
		const origins = fc.oneof(
			fc.constant(origin),
			fc.constant("null"),
			fc.constant("http://evil.example"),
			fc.constant("http://receiver.lan:9000/"),
			fc.constant("HTTP://RECEIVER.LAN:9000"),
			fc.string({ maxLength: 40 }),
		)
		const methods = fc.oneof(
			fc.constantFrom(...PREFLIGHT_METHODS),
			fc.constantFrom("TRACE", "CONNECT", "get", ""),
			fc.string({ maxLength: 10 }),
		)
		const requested = fc.oneof(
			fc
				.subarray([...PREFLIGHT_HEADERS])
				.map(list => list.map(value => value.toLowerCase()).join(", ")),
			fc.constantFrom("x-evil", "range, Range", "", ","),
			fc.string({ maxLength: 30 }),
		)
		fc.assert(
			fc.property(
				fc.option(origins, { nil: undefined }),
				fc.option(methods, { nil: undefined }),
				fc.option(requested, { nil: undefined }),
				fc.constantFrom("OPTIONS", "GET", "POST"),
				(o, m, h, verb) => {
					const headers: string[] = []
					if (o !== undefined) headers.push("Origin", o)
					if (m !== undefined) headers.push("Access-Control-Request-Method", m)
					if (h !== undefined) headers.push("Access-Control-Request-Headers", h)
					const result = p.evaluate(request(verb, headers))
					const has = "Access-Control-Max-Age" in result.headers
					if (result.kind === "preflight") {
						expect(result.status).toBe(204)
						expect(result.headers["Access-Control-Max-Age"]).toBe("600")
						const { "Access-Control-Max-Age": _maxAge, ...rest } =
							result.headers
						expect(rest).toStrictEqual({
							"Cache-Control": "no-store",
							Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
							"Access-Control-Allow-Origin": o,
							"Access-Control-Allow-Credentials": "true",
							"Access-Control-Allow-Methods": PREFLIGHT_METHODS.join(", "),
							"Access-Control-Allow-Headers": PREFLIGHT_HEADERS.join(", "),
						})
					} else expect(has).toBe(false)
					expect(
						Object.keys(result.headers).some(key =>
							/private-network/i.test(key),
						),
					).toBe(false)
				},
			),
			{ numRuns: 300 },
		)
	})
})
