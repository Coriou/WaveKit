import { request as httpRequest } from "node:http"
import type { ServerResponse } from "node:http"
import { once } from "node:events"
import Fastify from "fastify"
import type { FastifyRequest, FastifyReply } from "fastify"
import websocket from "@fastify/websocket"
import { WebSocket } from "ws"
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

async function setup(beforeRoutes?: (app: ReturnType<typeof Fastify>) => void) {
	let elapsed = 0
	const persist = vi.fn(async () => {})
	const token = generateMachineToken()
	const digest = digestMachineToken(token)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist,
		monotonicNow: () => elapsed,
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
	const controller = installAccessHooks(app, { policy, sessions })
	beforeRoutes?.(app)
	const routes = registerAccessRoutes(app, { pairing, flows })
	const browser = { host: "receiver.lan:9000", origin }
	const machine = {
		host: "receiver.lan:9000",
		authorization: `Bearer ${token}`,
	}
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
			cookieHeader,
			headers: {
				...browser,
				cookie: cookieHeader.split(";")[0] ?? "",
				"x-wavekit-csrf": body.csrfToken,
			},
		}
	}
	return {
		app,
		controller,
		routes,
		sessions,
		policy,
		pairing,
		flows,
		browser,
		machine,
		persist,
		pair,
		advance: (ms: number) => {
			elapsed += ms
		},
	}
}

describe("isolated access HTTP routes", () => {
	it.each(["pair", "refresh"] as const)(
		"rejects %s admitted before shutdown but paused before its handler",
		async flow => {
			let pause = false
			let arrived = () => {}
			const atHandler = new Promise<void>(resolve => {
				arrived = resolve
			})
			let resume = () => {}
			const gate = new Promise<void>(resolve => {
				resume = resolve
			})
			const env = await setup(app => {
				app.addHook("preHandler", async () => {
					if (pause) {
						arrived()
						await gate
					}
				})
			})
			const paired = await env.pair()
			if (flow === "refresh") {
				// Admission records this hour before the route handler. Commit it
				// first so a paused refresh cannot be mistaken for a last-seen write.
				expect(
					env.sessions.lookupByPrincipal(paired.body.deviceId),
				).toBeDefined()
				await env.sessions.noteSeen(
					paired.body.deviceId,
					env.sessions.observedAt(),
				)
			}
			const issued = await env.app.inject({
				method: "POST",
				url: "/api/access/pairing-codes",
				headers: env.machine,
			})
			const redeem = vi.spyOn(env.pairing, "redeem")
			const refresh = vi.spyOn(env.flows, "refresh")
			env.persist.mockClear()
			pause = true
			const pending = env.app.inject({
				method: "POST",
				url:
					flow === "pair" ? "/api/access/pair" : "/api/access/session/refresh",
				headers: flow === "pair" ? env.browser : paired.headers,
				...(flow === "pair"
					? { payload: { code: issued.json<{ code: string }>().code } }
					: {}),
			})
			await atHandler
			env.controller.stopAdmission()
			env.routes.stopAdmission()
			await env.routes.drain()
			resume()
			const denied = await pending
			expect(denied.statusCode).toBe(503)
			expect(denied.headers["access-control-allow-origin"]).toBe(origin)
			expect(denied.headers["set-cookie"]).toBeUndefined()
			expect(redeem).not.toHaveBeenCalled()
			expect(refresh).not.toHaveBeenCalled()
			expect(env.persist).not.toHaveBeenCalled()
		},
	)

	it("drains actual refresh persistence even after its HTTP response closes", async () => {
		let response: ServerResponse | undefined
		const env = await setup(app => {
			app.addHook(
				"preHandler",
				async (request: FastifyRequest, reply: FastifyReply) => {
					if (request.url === "/api/access/session/refresh")
						response = reply.raw
				},
			)
		})
		const paired = await env.pair()
		env.advance(86400000)
		// The admission hook records last-seen before the route persists. Commit
		// that hour first so the held write is the refresh, which starts after
		// preHandler has captured the response.
		expect(env.sessions.lookupByPrincipal(paired.body.deviceId)).toBeDefined()
		await env.sessions.noteSeen(paired.body.deviceId, env.sessions.observedAt())
		let started = () => {}
		const persisting = new Promise<void>(resolve => {
			started = resolve
		})
		let release = () => {}
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		env.persist.mockImplementationOnce(async () => {
			started()
			await gate
		})
		const address = await env.app.listen({ host: "127.0.0.1", port: 0 })
		const client = httpRequest(address + "/api/access/session/refresh", {
			method: "POST",
			headers: paired.headers,
		})
		const clientClosed = new Promise<void>(resolve => {
			client.once("error", () => resolve())
			client.once("response", incoming => {
				incoming.resume()
				incoming.once("end", () => resolve())
			})
		})
		client.end()
		await persisting
		if (!response) throw new Error("Missing actual response")
		const responseClosed = once(response, "close")
		response.destroy()
		await responseClosed
		env.controller.stopAdmission()
		env.routes.stopAdmission()
		const draining = env.routes.drain()
		expect(env.routes.drain()).toBe(draining)
		let completed = false
		void draining.then(() => {
			completed = true
		})
		await Promise.resolve()
		expect(completed).toBe(false)
		try {
			const denied = await env.app.inject({
				method: "POST",
				url: "/api/access/session/refresh",
				headers: paired.headers,
			})
			expect(denied.statusCode).toBe(503)
		} finally {
			release()
		}
		await draining
		await clientClosed
		expect(completed).toBe(true)
		expect(
			env.sessions.lookupByPrincipal(paired.body.deviceId)?.expiresAt,
		).toBe(paired.body.expiresAt + 86400000)
	})

	it("pairs, reads status, refreshes remembered browser and logs out through real handlers", async () => {
		const env = await setup()
		const paired = await env.pair()
		expect(paired.cookieHeader).toContain(
			"HttpOnly; SameSite=Strict; Max-Age=2592000",
		)
		expect(paired.cookieHeader).not.toContain("Secure")
		const status = await env.app.inject({
			url: "/api/access/session",
			headers: paired.headers,
		})
		expect(status.json()).toEqual(paired.body)
		expect(status.headers["set-cookie"]).toBeUndefined()
		expect(status.body).not.toContain(paired.headers.cookie.split("=")[1])
		env.advance(29 * 86400000)
		const refresh = await env.app.inject({
			method: "POST",
			url: "/api/access/session/refresh",
			headers: paired.headers,
		})
		expect(refresh.statusCode).toBe(200)
		expect(refresh.json<{ expiresAt: number }>().expiresAt).toBe(
			paired.body.expiresAt + 29 * 86400000,
		)
		expect(refresh.headers["set-cookie"]).toBe(paired.cookieHeader)
		const logout = await env.app.inject({
			method: "POST",
			url: "/api/access/session/logout",
			headers: paired.headers,
		})
		expect(logout.statusCode).toBe(200)
		expect(logout.headers["set-cookie"]).toContain(
			"wavekit_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
		)
		expect(
			(
				await env.app.inject({
					url: "/api/access/session",
					headers: paired.headers,
				})
			).statusCode,
		).toBe(401)
	})

	it("exempts only exact POST pairing and refuses originless pairing and unauthorized issue", async () => {
		const env = await setup()
		for (const url of [
			"/api/access/pair?code=unused",
			"/api/access/pair/",
			"/api/access/anything",
			"/api/access/pairing-codes",
		])
			expect(
				(
					await env.app.inject({
						method: "POST",
						url,
						headers: env.browser,
						payload: { code: "00000-00000" },
					})
				).statusCode,
			).toBe(401)
		expect(
			(await env.app.inject({ url: "/api/access/pair", headers: env.browser }))
				.statusCode,
		).toBe(401)
		expect(
			(
				await env.app.inject({
					method: "POST",
					url: "/api/access/pair",
					headers: { host: "receiver.lan:9000" },
					payload: { code: "00000-00000" },
				})
			).statusCode,
		).toBe(403)
		expect(env.persist).not.toHaveBeenCalled()
	})

	it("strictly validates pairing/revoke bodies and applies bounded payload parsing", async () => {
		const env = await setup()
		const issued = await env.app.inject({
			method: "POST",
			url: "/api/access/pairing-codes",
			headers: env.machine,
		})
		const code = issued.json<{ code: string }>().code
		const malformed = await env.app.inject({
			method: "POST",
			url: "/api/access/pair",
			headers: env.browser,
			payload: { code, extra: "secret" },
		})
		expect(malformed.statusCode).toBe(400)
		expect(malformed.body).not.toContain("secret")
		const oversized = await env.app.inject({
			method: "POST",
			url: "/api/access/pair",
			headers: env.browser,
			payload: { code, junk: "s".repeat(2000) },
		})
		expect(oversized.statusCode).toBe(413)
		expect(oversized.json()).toEqual({ code: "PAYLOAD_TOO_LARGE" })
		expect(oversized.headers["access-control-allow-origin"]).toBe(origin)
		const invalidJson = await env.app.inject({
			method: "POST",
			url: "/api/access/pair",
			headers: { ...env.browser, "content-type": "application/json" },
			payload: '{"code":"private',
		})
		expect(invalidJson.statusCode).toBe(400)
		expect(invalidJson.body).not.toContain("private")
		expect(env.persist).not.toHaveBeenCalled()
	})

	it("does not parse or mutate on an unauthorized oversized session request", async () => {
		const env = await setup()
		const result = await env.app.inject({
			method: "POST",
			url: "/api/access/devices/revoke",
			headers: env.browser,
			payload: { deviceId: "s".repeat(2000) },
		})
		expect(result.statusCode).toBe(401)
		expect(env.persist).not.toHaveBeenCalled()
	})

	it("requires original origin and CSRF for refresh and device revocation", async () => {
		const env = await setup()
		const paired = await env.pair()
		const headers = { ...paired.headers, "x-wavekit-csrf": "wrong" }
		for (const url of [
			"/api/access/session/refresh",
			"/api/access/session/logout",
			"/api/access/devices/revoke-all",
		])
			expect(
				(await env.app.inject({ method: "POST", url, headers })).statusCode,
			).toBe(403)
		const revoke = await env.app.inject({
			method: "POST",
			url: "/api/access/devices/revoke",
			headers: paired.headers,
			payload: { deviceId: paired.body.deviceId },
		})
		expect(revoke.json()).toEqual({ revoked: true })
		expect(revoke.headers["set-cookie"]).toContain("Max-Age=0")
		expect(env.sessions.lookupByPrincipal(paired.body.deviceId)).toBeUndefined()
	})

	it("durable failure returns503 with no successful cookie or credential exposure", async () => {
		const env = await setup()
		const paired = await env.pair()
		// Admission may spend one failed last-seen write without latching.
		// The logout write is the one that must fail closed.
		env.persist.mockRejectedValue(new Error("private storage detail"))
		const result = await env.app.inject({
			method: "POST",
			url: "/api/access/session/logout",
			headers: paired.headers,
		})
		expect(result.statusCode).toBe(503)
		expect(result.headers["set-cookie"]).toBeUndefined()
		expect(result.json()).toEqual({ code: "ACCESS_UNAVAILABLE" })
		expect(result.headers["access-control-allow-origin"]).toBe(origin)
		expect(JSON.stringify(result.json())).not.toContain("private")
	})
	it("logout closes the browser's actual WebSocket and leaves the machine identity usable", async () => {
		const env = await setup()
		await env.app.register(websocket)
		env.app.get("/ws", { websocket: true }, (socket, request) => {
			env.controller.adoptWebSocket(request, socket)
		})
		const paired = await env.pair()
		const url = await env.app.listen({ host: "127.0.0.1", port: 0 })
		const client = new WebSocket(url.replace("http:", "ws:") + "/ws", {
			headers: paired.headers,
		})
		await once(client, "open")
		const closed = once(client, "close")
		const logout = await env.app.inject({
			method: "POST",
			url: "/api/access/session/logout",
			headers: paired.headers,
		})
		expect(logout.statusCode).toBe(200)
		expect((await closed)[0]).toBe(1008)
		const issued = await env.app.inject({
			method: "POST",
			url: "/api/access/pairing-codes",
			headers: env.machine,
		})
		expect(issued.statusCode).toBe(201)
	})
})

describe("device inventory route admission", () => {
	it("uses an explicit safe serializer for session inventory and sanitized service faults", async () => {
		const env = await setup(app => {
			app.setReplySerializer(() => '"private inherited serializer"')
		})
		// Provision directly: inherited serializers intentionally poison unrelated existing routes.
		const session = await env.sessions.create()
		if (session.kind !== "created") throw new Error("Missing session")
		const headers = {
			...env.browser,
			cookie: `wavekit_session=${session.cookieValue}`,
		}
		const success = await env.app.inject({
			method: "GET",
			url: "/api/access/devices",
			headers,
		})
		expect(success.statusCode).toBe(200)
		expect(success.json()).toMatchObject({
			devices: [{ deviceId: session.principalId, current: true }],
		})
		vi.spyOn(env.sessions, "snapshotActiveDevices").mockImplementation(() => {
			throw new Error("private fault")
		})
		const failed = await env.app.inject({
			method: "GET",
			url: "/api/access/devices",
			headers,
		})
		expect(failed.statusCode).toBe(503)
		expect(failed.json()).toEqual({ code: "ACCESS_UNAVAILABLE" })
	})

	it("rechecks session authority after an earlier root admission", async () => {
		let revoke = false
		let id = ""
		let sessions: SessionStore | undefined
		const env = await setup(app => {
			app.addHook("preHandler", async (request: FastifyRequest) => {
				if (revoke && request.url === "/api/access/devices")
					await sessions?.revoke(id)
			})
		})
		sessions = env.sessions
		const paired = await env.pair()
		id = paired.body.deviceId
		revoke = true
		const response = await env.app.inject({
			method: "GET",
			url: "/api/access/devices",
			headers: paired.headers,
		})
		expect(response.statusCode).toBe(401)
		expect(response.json()).toEqual({ code: "AUTH_REQUIRED" })
	})

	it("shares the existing 512 active-flow bound and drains accepted persistence after sealing reads", async () => {
		const env = await setup()
		const paired = await env.pair()
		let release = () => {}
		let entered = () => {}
		const atPersist = new Promise<void>(resolve => {
			entered = resolve
		})
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		env.persist.mockImplementationOnce(async () => {
			entered()
			await gate
		})
		const original = env.flows.refresh.bind(env.flows)
		let calls = 0
		let full = () => {}
		const atCapacity = new Promise<void>(resolve => {
			full = resolve
		})
		vi.spyOn(env.flows, "refresh").mockImplementation(request => {
			if (++calls === 512) full()
			return original(request)
		})
		const pending = Array.from({ length: 512 }, () =>
			env.app
				.inject({
					method: "POST",
					url: "/api/access/session/refresh",
					headers: paired.headers,
				})
				.then(response => response.statusCode),
		)
		await atPersist
		await atCapacity
		try {
			const overloaded = await env.app.inject({
				method: "GET",
				url: "/api/access/devices",
				headers: paired.headers,
			})
			expect(overloaded.statusCode).toBe(429)
			expect(overloaded.json()).toEqual({ code: "ACCESS_CAPACITY" })
			const draining = env.routes.drain()
			let settled = false
			void draining.then(() => {
				settled = true
			})
			const sealed = await env.app.inject({
				method: "HEAD",
				url: "/api/access/devices",
				headers: paired.headers,
			})
			expect(sealed.statusCode).toBe(503)
			expect(settled).toBe(false)
			release()
			expect(await Promise.all(pending)).toEqual(
				Array.from({ length: 512 }, () => 200),
			)
			await draining
			expect(settled).toBe(true)
		} finally {
			release()
			await Promise.all(pending)
		}
	})
})

describe("device label route", () => {
	it("labels a session device and leaves GET/HEAD inventory commit-free", async () => {
		const env = await setup()
		const paired = await env.pair()
		env.persist.mockClear()
		const labeled = await env.app.inject({
			method: "POST",
			url: "/api/access/devices/label",
			headers: paired.headers,
			payload: {
				deviceId: paired.body.deviceId,
				name: "Radio",
				kind: "browser",
			},
		})
		expect(labeled.statusCode).toBe(200)
		expect(labeled.json()).toEqual({ updated: true })
		const calls = env.persist.mock.calls.length
		const listed = await env.app.inject({
			method: "GET",
			url: "/api/access/devices",
			headers: paired.headers,
		})
		expect(listed.statusCode).toBe(200)
		expect(listed.json()).toMatchObject({
			devices: [
				{
					deviceId: paired.body.deviceId,
					name: "Radio",
					kind: "browser",
					current: true,
				},
			],
		})
		const head = await env.app.inject({
			method: "HEAD",
			url: "/api/access/devices",
			headers: paired.headers,
		})
		expect(head.statusCode).toBe(200)
		// inject() returns the pre-transport payload; the wire HEAD body is empty.
		expect(head.headers["content-length"]).toBe(
			String(Buffer.byteLength(listed.body)),
		)
		expect(env.persist.mock.calls.length).toBe(calls)
		const rejected = await env.app.inject({
			method: "POST",
			url: "/api/access/devices/label",
			headers: paired.headers,
			payload: { deviceId: paired.body.deviceId, name: "a".repeat(65) },
		})
		expect(rejected.statusCode).toBe(400)
		expect(rejected.json()).toEqual({ code: "MALFORMED_REQUEST" })
		const machine = await env.app.inject({
			method: "POST",
			url: "/api/access/devices/label",
			headers: env.machine,
			payload: { deviceId: paired.body.deviceId, name: "Nope" },
		})
		expect(machine.statusCode).toBe(403)
		expect(machine.json()).toEqual({ code: "SESSION_REQUIRED" })
		const absent = await env.app.inject({
			method: "POST",
			url: "/api/access/machine/devices/label",
			headers: env.machine,
			payload: { deviceId: paired.body.deviceId, name: "Nope" },
		})
		expect(absent.statusCode).toBe(404)
		expect(env.sessions.exportSnapshot().sessions[0]?.name).toBe("Radio")
	})
})
