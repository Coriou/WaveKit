import { request as httpRequest } from "node:http"
import type { IncomingHttpHeaders } from "node:http"
import Fastify from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import { registerAccessRoutes } from "../../../src/access/access-routes.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { installAccessHooks } from "../../../src/access/fastify-adapter.js"
import { PairingService } from "../../../src/access/pairing.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionFlows } from "../../../src/access/session-flows.js"
import { SessionStore } from "../../../src/access/sessions.js"

const origin = "http://receiver.lan:9000"
const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => {
	await Promise.all(apps.splice(0).map(app => app.close()))
})

async function setup() {
	let elapsed = 0
	const persist = vi.fn(async () => {})
	const token = generateMachineToken()
	const digest = digestMachineToken(token)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist,
		monotonicNow: () => elapsed,
		epochNow: () => 1_000_000,
	})
	const policy = new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: ["receiver.lan:9000"],
		allowedOrigins: [origin],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
	const pairing = new PairingService({ policy, sessions })
	const flows = new SessionFlows({ policy, sessions })
	const app = Fastify({ logger: false })
	apps.push(app)
	installAccessHooks(app, { policy, sessions })
	registerAccessRoutes(app, { pairing, flows })
	const machine = {
		host: "receiver.lan:9000",
		authorization: `Bearer ${token}`,
	}
	const browser = { host: "receiver.lan:9000", origin }
	const pair = async () => {
		const issued = await app.inject({
			method: "POST",
			url: "/api/access/pairing-codes",
			headers: machine,
		})
		expect(issued.statusCode).toBe(201)
		const redeemed = await app.inject({
			method: "POST",
			url: "/api/access/pair",
			headers: browser,
			payload: { code: issued.json<{ code: string }>().code },
		})
		expect(redeemed.statusCode).toBe(201)
		const cookieHeader = redeemed.headers["set-cookie"]
		if (typeof cookieHeader !== "string") throw new Error("Expected cookie")
		const body = redeemed.json<{
			deviceId: string
			csrfToken: string
			expiresAt: number
		}>()
		return {
			body,
			headers: {
				...browser,
				cookie: cookieHeader.split(";")[0] ?? "",
				"x-wavekit-csrf": body.csrfToken,
			},
		}
	}
	return { app, sessions, persist, machine, browser, pair, token }
}

function wire(
	app: ReturnType<typeof Fastify>,
	options: { method?: string; url: string; headers: Record<string, string> },
) {
	const ready = app.server.listening
		? Promise.resolve()
		: app.listen({ host: "127.0.0.1", port: 0 })
	return ready.then(
		() =>
			new Promise<{
				statusCode: number
				headers: IncomingHttpHeaders
				body: string
			}>((resolve, reject) => {
				const address = app.addresses()[0]
				if (!address) {
					reject(new Error("Missing listener"))
					return
				}
				const request = httpRequest(
					{
						host: "127.0.0.1",
						port: address.port,
						path: options.url,
						method: options.method ?? "GET",
						headers: options.headers,
						agent: false,
					},
					response => {
						const chunks: Buffer[] = []
						response.on("data", (chunk: Buffer) => chunks.push(chunk))
						response.on("end", () =>
							resolve({
								statusCode: response.statusCode ?? 0,
								headers: response.headers,
								body: Buffer.concat(chunks).toString("utf8"),
							}),
						)
					},
				)
				request.on("error", reject)
				request.end()
			}),
	)
}

describe("machine device HTTP routes", () => {
	it("admits only the machine bearer and never renews or sets a cookie", async () => {
		const env = await setup()
		const paired = await env.pair()
		env.persist.mockClear()
		const listed = await env.app.inject({
			method: "GET",
			url: "/api/access/machine/devices",
			headers: env.machine,
		})
		expect(listed.statusCode).toBe(200)
		expect(listed.headers["cache-control"]).toBe("no-store")
		expect(listed.headers["set-cookie"]).toBeUndefined()
		expect(listed.json()).toEqual({
			devices: [
				{
					deviceId: paired.body.deviceId,
					createdAt: 1_000_000,
					renewedAt: 1_000_000,
					expiresAt: paired.body.expiresAt,
					current: false,
				},
			],
		})
		expect(env.persist).not.toHaveBeenCalled()
		const alongside = await env.app.inject({
			method: "GET",
			url: "/api/access/machine/devices",
			headers: { ...env.machine, cookie: paired.headers.cookie },
		})
		expect(alongside.statusCode).toBe(200)
		expect(alongside.headers["set-cookie"]).toBeUndefined()
		expect(alongside.json()).toMatchObject({
			devices: [expect.objectContaining({ current: false })],
		})
		const missingOrigin = await env.app.inject({
			method: "GET",
			url: "/api/access/machine/devices",
			headers: { host: "receiver.lan:9000", cookie: paired.headers.cookie },
		})
		expect(missingOrigin.statusCode).toBe(403)
		expect(missingOrigin.json()).toEqual({ code: "ORIGIN_FORBIDDEN" })
		const cookieOnly = await env.app.inject({
			method: "GET",
			url: "/api/access/machine/devices",
			headers: {
				host: "receiver.lan:9000",
				origin,
				cookie: paired.headers.cookie,
				"x-wavekit-csrf": paired.body.csrfToken,
			},
		})
		expect(cookieOnly.statusCode).toBe(403)
		expect(cookieOnly.json()).toEqual({ code: "MACHINE_REQUIRED" })
		expect(
			(
				await env.app.inject({
					method: "GET",
					url: "/api/access/machine/devices",
					headers: { host: "receiver.lan:9000" },
				})
			).statusCode,
		).toBe(401)
		expect(
			(
				await env.app.inject({
					method: "GET",
					url: "/api/access/machine/devices",
					headers: {
						host: "receiver.lan:9000",
						authorization: "Bearer not-a-credential",
					},
				})
			).json(),
		).toEqual({ code: "AUTH_REQUIRED" })
		expect(
			(
				await env.app.inject({
					method: "GET",
					url: "/api/access/machine/devices",
					headers: {
						host: "evil.lan:9000",
						authorization: env.machine.authorization,
					},
				})
			).json(),
		).toEqual({ code: "HOST_FORBIDDEN" })
		expect(
			(
				await env.app.inject({
					method: "POST",
					url: "/api/access/machine/devices/revoke",
					headers: {
						...env.machine,
						origin: "http://evil.lan",
					},
					payload: { deviceId: paired.body.deviceId },
				})
			).json(),
		).toEqual({ code: "ORIGIN_FORBIDDEN" })
		expect(
			(
				await env.app.inject({
					method: "GET",
					url: "/api/access/machine/devices?x=1",
					headers: env.machine,
				})
			).json(),
		).toEqual({ code: "MALFORMED_REQUEST" })
	})

	it("sends no HEAD body and revokes through the same lease path as a session", async () => {
		const env = await setup()
		const paired = await env.pair()
		const closed = vi.fn()
		env.sessions.onInvalidated(paired.body.deviceId, closed)
		const headers = {
			host: "receiver.lan:9000",
			authorization: env.machine.authorization,
		}
		const get = await wire(env.app, {
			method: "GET",
			url: "/api/access/machine/devices",
			headers,
		})
		const head = await wire(env.app, {
			method: "HEAD",
			url: "/api/access/machine/devices",
			headers,
		})
		expect(get.statusCode).toBe(200)
		expect(head.statusCode).toBe(200)
		expect(head.body).toBe("")
		expect(head.headers["content-type"]).toBe(get.headers["content-type"])
		expect(head.headers["content-length"]).toBe(get.headers["content-length"])
		expect(Number(head.headers["content-length"])).toBe(
			Buffer.byteLength(get.body),
		)
		expect(head.headers["cache-control"]).toBe("no-store")
		expect(head.headers["set-cookie"]).toBeUndefined()
		const denied = await wire(env.app, {
			method: "HEAD",
			url: "/api/access/machine/devices",
			headers: {
				host: "evil.lan:9000",
				authorization: env.machine.authorization,
			},
		})
		expect(denied.statusCode).toBe(403)
		expect(denied.body).toBe("")
		const revoked = await env.app.inject({
			method: "POST",
			url: "/api/access/machine/devices/revoke",
			headers: env.machine,
			payload: { deviceId: paired.body.deviceId },
		})
		expect(revoked.statusCode).toBe(200)
		expect(revoked.json()).toEqual({ revoked: true })
		expect(revoked.headers["set-cookie"]).toBeUndefined()
		expect(closed).toHaveBeenCalledOnce()
		expect(env.sessions.lookupByPrincipal(paired.body.deviceId)).toBeUndefined()
		const again = await env.app.inject({
			method: "POST",
			url: "/api/access/machine/devices/revoke-all",
			headers: env.machine,
		})
		expect(again.statusCode).toBe(200)
		expect(again.json()).toEqual({ revoked: true })
		expect(again.headers["set-cookie"]).toBeUndefined()
	})

	it("returns a safe 503 and closes leases when revocation cannot persist", async () => {
		const env = await setup()
		const paired = await env.pair()
		const closed = vi.fn()
		env.sessions.onInvalidated(paired.body.deviceId, closed)
		env.persist.mockRejectedValueOnce(new Error("secret-volume"))
		const revoked = await env.app.inject({
			method: "POST",
			url: "/api/access/machine/devices/revoke",
			headers: env.machine,
			payload: { deviceId: paired.body.deviceId },
		})
		expect(revoked.statusCode).toBe(503)
		expect(revoked.json()).toEqual({ code: "ACCESS_UNAVAILABLE" })
		expect(revoked.body).not.toContain("secret-volume")
		expect(closed).toHaveBeenCalledOnce()
		const listed = await env.app.inject({
			method: "GET",
			url: "/api/access/machine/devices",
			headers: env.machine,
		})
		expect(listed.statusCode).toBe(503)
		expect(listed.json()).toEqual({ code: "ACCESS_UNAVAILABLE" })
	})
})
