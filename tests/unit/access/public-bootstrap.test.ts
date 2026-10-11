import Fastify from "fastify"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	ACCESS_BOOTSTRAP_LIMITS,
	accessBootstrapDtoSchema,
} from "@wavekit/api-types"
import {
	projectAccessBootstrap,
	encodeAccessBootstrap,
} from "../../../src/access/public-bootstrap.js"
import { accessBootstrapRoutes } from "../../../src/api/routes/access-bootstrap.js"
import { installAccessHooks } from "../../../src/access/fastify-adapter.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"

function source(apiOrigin = "https://receiver.lan") {
	return {
		version: 1,
		apiOrigin,
		webSocketUrl: `${apiOrigin.replace(/^http/, "ws")}/ws`,
		analogAudioOrigin: "https://receiver.lan:9001",
		digitalAudioOrigin: "https://receiver.lan:9002",
		access: {
			mode: "protected",
			sessionAvailable: true,
			pairingAvailable: true,
		},
		capabilities: {
			analogAudioAvailable: true,
			digitalAudioAvailable: false,
			operatorDataAvailable: false,
		},
	}
}

const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => {
	await Promise.all(apps.splice(0).map(app => app.close()))
})

async function routes(provideBootstrap: () => unknown, optIn = true) {
	const token = generateMachineToken()
	const digest = digestMachineToken(token)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: async () => {},
	})
	const policy = new AccessPolicy({
		listenerScheme: "https",
		allowedAuthorities: ["receiver.lan"],
		allowedOrigins: ["https://receiver.lan"],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
	const app = Fastify({ logger: false })
	apps.push(app)
	const controller = installAccessHooks(app, {
		policy,
		sessions,
		publicBootstrap: optIn,
	})
	// A route must not inherit a serializer that leaks internal data.
	app.addHook("preHandler", async (_request, reply) => {
		reply.serializer(() =>
			JSON.stringify({ secret: "private serialization poison" }),
		)
	})
	app.setErrorHandler((_error, _request, reply) =>
		reply.code(400).send({ secret: "global error poison" }),
	)
	await app.register(accessBootstrapRoutes, {
		policy,
		controller,
		provideBootstrap,
	})
	return { app, controller, policy, sessions, token }
}

const headers = { host: "receiver.lan", origin: "https://receiver.lan" }

describe("closed canonical public bootstrap projection", () => {
	it("copies only explicit detached fields without reading extras or toJSON", () => {
		const input = source()
		const dto = projectAccessBootstrap({
			...input,
			access: { ...input.access, secret: "private" },
			capabilities: { ...input.capabilities, nativeReady: true },
			get privateState() {
				throw new Error("must not read")
			},
			toJSON: () => {
				throw new Error("must not call")
			},
		})
		expect(dto).toEqual(input)
		input.access.sessionAvailable = false
		expect(dto.access.sessionAvailable).toBe(true)
		expect(
			accessBootstrapDtoSchema.safeParse({ ...dto, secret: "private" }).success,
		).toBe(false)
		expect(
			accessBootstrapDtoSchema.safeParse({
				...dto,
				access: { ...dto.access, secret: "private" },
			}).success,
		).toBe(false)
		expect(
			accessBootstrapDtoSchema.safeParse({
				...dto,
				capabilities: { ...dto.capabilities, nativeReady: true },
			}).success,
		).toBe(false)
	})

	it.each([
		"http://127.0.0.1",
		"http://[::1]",
		"http://localhost:9000",
		"https://receiver.lan",
		"https://receiver.lan:9443",
	])("retains configured canonical origins and API-derived WS for %s", api => {
		expect(projectAccessBootstrap(source(api))).toEqual(source(api))
	})

	it.each([
		"http://127.1",
		"http://127.0.0.1:80",
		"http://[0:0:0:0:0:0:0:1]",
		"https://RECEIVER.lan",
		"https://receiver.lan/",
		"https://receiver.lan?x=1",
		"https://user:secret@receiver.lan",
		"https://receiver.lan#fragment",
		"file:///private",
		"http://0.0.0.0",
		"http://[::]",
		"http://receiver.lan:0",
		"https://receiver.lan.",
		"https://bad_host.lan",
		"https://*.lan",
		" https://receiver.lan",
		"null",
	])("rejects noncanonical/untrusted origin %s with a fixed fault", api => {
		expect(() => projectAccessBootstrap(source(api))).toThrowError(
			"Access bootstrap is unavailable",
		)
	})

	it("rejects inconsistent WS, legacy mode, invalid flags and provider getters without exposing causes", () => {
		for (const input of [
			null,
			undefined,
			[],
			Promise.resolve(source()),
			{ ...source(), webSocketUrl: "wss://foreign.lan/ws" },
			{ ...source(), webSocketUrl: "wss://receiver.lan/ws?secret=x" },
			{ ...source(), version: 2 },
			{
				...source(),
				access: {
					mode: "legacy",
					sessionAvailable: false,
					pairingAvailable: false,
				},
			},
			{
				...source(),
				access: {
					mode: "protected",
					sessionAvailable: false,
					pairingAvailable: true,
				},
			},
			{
				...source(),
				capabilities: {
					analogAudioAvailable: "true",
					digitalAudioAvailable: false,
					operatorDataAvailable: false,
				},
			},
			{
				...source(),
				get access() {
					throw new Error("secret storage path")
				},
			},
		]) {
			try {
				projectAccessBootstrap(input)
				expect.fail("Expected unavailable")
			} catch (error) {
				expect(error).toMatchObject({
					code: "ACCESS_UNAVAILABLE",
					message: "Access bootstrap is unavailable",
				})
				expect(JSON.stringify(error)).not.toContain("secret storage path")
			}
		}
	})

	it("measures the complete DTO body and preserves independently mounted flags", () => {
		const host = [
			"a".repeat(63),
			"b".repeat(63),
			"c".repeat(63),
			"d".repeat(61),
		].join(".")
		const origin = `https://${host}:65535`
		const input = {
			...source(origin),
			analogAudioOrigin: origin,
			digitalAudioOrigin: origin,
		}
		const body = encodeAccessBootstrap(input)
		expect(JSON.parse(body)).toEqual(input)
		expect(Buffer.byteLength(body)).toBeLessThanOrEqual(
			ACCESS_BOOTSTRAP_LIMITS.bodyBytes,
		)
		expect(() =>
			projectAccessBootstrap(source("https://" + "a".repeat(321))),
		).toThrow()
		// Feature: core-access-policy, Property 5: No implicit privilege
		// Validates: Requirements 3.6, 6.1
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				(session, analog, digital, operator) => {
					const value = {
						...source(),
						access: {
							mode: "protected",
							sessionAvailable: session,
							pairingAvailable: session,
						},
						capabilities: {
							analogAudioAvailable: analog,
							digitalAudioAvailable: digital,
							operatorDataAvailable: operator,
						},
					}
					expect(JSON.parse(encodeAccessBootstrap(value))).toEqual(value)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("bootstrap module routes (actual ApiServer assembly remains a separate gate)", () => {
	it.each(["GET", "HEAD"] as const)(
		"delivers %s safely without a principal despite invalid credentials",
		async method => {
			const provider = vi.fn(() => source())
			const env = await routes(provider)
			const lookup = vi.spyOn(env.sessions, "lookup")
			const admit = vi.spyOn(env.controller, "admit")
			const result = await env.app.inject({
				method,
				url: "/api/access/bootstrap",
				headers: {
					...headers,
					authorization: "Bearer wrong",
					cookie: "wavekit_session=expired",
				},
			})
			expect(result.statusCode).toBe(200)
			expect(result.headers["cache-control"]).toBe("no-store")
			expect(result.headers.vary).toBe("Origin")
			expect(result.headers["access-control-allow-origin"]).toBe(headers.origin)
			expect(result.headers["set-cookie"]).toBeUndefined()
			if (method === "GET") expect(result.json()).toEqual(source())
			else expect(result.body).toBe("")
			expect(provider).toHaveBeenCalledOnce()
			expect(lookup).not.toHaveBeenCalled()
			expect(admit).not.toHaveBeenCalled()
		},
	)

	it.each(["GET", "HEAD"] as const)(
		"maps missing/throwing/malformed providers to sanitized %s 503",
		async method => {
			for (const provider of [
				() => null,
				() => {
					throw new Error("secret disk path")
				},
				() => ({ ...source(), apiOrigin: "https://foreign.lan" }),
			]) {
				const env = await routes(provider)
				const result = await env.app.inject({
					method,
					url: "/api/access/bootstrap",
					headers,
				})
				expect(result.statusCode).toBe(503)
				expect(result.headers["cache-control"]).toBe("no-store")
				expect(result.headers["access-control-allow-origin"]).toBe(
					headers.origin,
				)
				if (method === "GET")
					expect(result.json()).toEqual({ code: "ACCESS_UNAVAILABLE" })
				else expect(result.body).toBe("")
				expect(result.body).not.toContain("secret")
			}
		},
	)

	it("preserves normal admission without opt-in, and rejects authenticated query/upgrade delivery", async () => {
		const provider = vi.fn(() => source())
		const env = await routes(provider, false)
		const denied = await env.app.inject({
			url: "/api/access/bootstrap",
			headers,
		})
		expect(denied.statusCode).toBe(401)
		expect(provider).not.toHaveBeenCalled()
		const authorized = { ...headers, authorization: `Bearer ${env.token}` }
		for (const [url, extra] of [
			["/api/access/bootstrap?x=1", {}],
			["/api/access/bootstrap", { upgrade: "websocket" }],
		] as const) {
			const result = await env.app.inject({
				url,
				headers: { ...authorized, ...extra },
			})
			expect(result.statusCode).toBe(400)
			expect(result.json()).toEqual({ code: "MALFORMED_REQUEST" })
		}
		expect(provider).not.toHaveBeenCalled()
	})

	it("keeps validated preflight separate and bars forbidden origins before provider access", async () => {
		const provider = vi.fn(() => source())
		const env = await routes(provider)
		const preflight = await env.app.inject({
			method: "OPTIONS",
			url: "/api/access/bootstrap",
			headers: { ...headers, "access-control-request-method": "GET" },
		})
		expect(preflight.statusCode).toBe(204)
		expect(preflight.body).toBe("")
		for (const method of ["GET", "HEAD"] as const) {
			const denied = await env.app.inject({
				method,
				url: "/api/access/bootstrap",
				headers: { ...headers, origin: "https://evil.lan" },
			})
			expect(denied.statusCode).toBe(403)
			expect(denied.headers["access-control-allow-origin"]).toBeUndefined()
			if (method === "HEAD") expect(denied.body).toBe("")
		}
		expect(provider).not.toHaveBeenCalled()
	})

	it("suppresses delivery when provider synchronously seals admission", async () => {
		let stop = () => {}
		const env = await routes(() => {
			stop()
			return source()
		})
		stop = () => env.controller.stopAdmission()
		const result = await env.app.inject({
			url: "/api/access/bootstrap",
			headers,
		})
		expect(result.statusCode).toBe(503)
		expect(result.json()).toEqual({ code: "ACCESS_UNAVAILABLE" })
	})
})
