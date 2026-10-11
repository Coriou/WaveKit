import { EventEmitter, once } from "node:events"
import { get, request as httpRequest, IncomingMessage as RawRequest, ServerResponse } from "node:http"
import { Socket } from "node:net"
import type { IncomingMessage } from "node:http"
import Fastify from "fastify"
import type { FastifyRequest } from "fastify"
import websocket from "@fastify/websocket"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConnectionLeases } from "../../../src/access/connection-leases.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { accessRequestFromHttp } from "../../../src/access/http-request.js"
import { installAccessHooks } from "../../../src/access/fastify-adapter.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"

const origin = "http://receiver.lan:9000"
const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => {
	await Promise.all(apps.splice(0).map(app => app.close()))
})

async function setup(capacity = 32, publicBootstrap = false) {
	let elapsed = 0
	const token = generateMachineToken()
	const digest = digestMachineToken(token)
	const persist = vi.fn(async () => {})
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
	const app = Fastify({ logger: false })
	apps.push(app)
	const leases = new ConnectionLeases(sessions, {
		maxConnections: capacity,
		checkIntervalMs: 10,
	})
	const controller = installAccessHooks(app, {
		policy,
		sessions,
		leases,
		webSocketCloseGraceMs: 30,
		publicBootstrap,
	})
	app.addHook("onClose", async () => leases.dispose())
	const created = await sessions.create()
	if (created.kind !== "created") throw new Error("Expected session")
	const headers = {
		host: "receiver.lan:9000",
		origin,
		cookie: `wavekit_session=${created.cookieValue}`,
	}
	const machine = {
		host: "receiver.lan:9000",
		authorization: `Bearer ${token}`,
	}
	return {
		app,
		sessions,
		persist,
		policy,
		leases,
		controller,
		created,
		headers,
		machine,
		advance: (ms: number) => {
			elapsed += ms
		},
	}
}

async function listen(app: ReturnType<typeof Fastify>) {
	return await app.listen({ host: "127.0.0.1", port: 0 })
}

async function rejected(url: string, headers: Record<string, string>) {
	return await new Promise<{
		status: number
		body: string
		headers: Record<string, unknown>
	}>((resolve, reject) => {
		const socket = new WebSocket(url.replace("http:", "ws:") + "/ws", {
			headers,
		})
		socket.on("error", () => {})
		socket.on("open", () => {
			socket.terminate()
			reject(new Error("Unexpected upgrade"))
		})
		socket.on("unexpected-response", (_request, response) => {
			let body = ""
			response.setEncoding("utf8")
			response.on("data", (part: string) => {
				body += part
			})
			response.on("end", () => {
				socket.terminate()
				resolve({
					status: response.statusCode ?? 0,
					body,
					headers: response.headers,
				})
			})
			response.on("error", reject)
		})
	})
}

async function connect(url: string, headers: Record<string, string>) {
	const client = new WebSocket(url.replace("http:", "ws:") + "/ws", { headers })
	await once(client, "open")
	return client
}

async function addWs(env: Awaited<ReturnType<typeof setup>>) {
	await env.app.register(websocket)
	env.app.get("/ws", { websocket: true }, (socket, request) => {
		if (!env.controller.adoptWebSocket(request, socket)) return
		socket.on("message", () => socket.send("ok"))
	})
}

function fakeSocket(): WebSocket {
	return Object.assign(new EventEmitter(), {
		readyState: 1,
		close: vi.fn(),
		terminate: vi.fn(),
	}) as unknown as WebSocket
}

function reservedSocket(
	env: Awaited<ReturnType<typeof setup>>,
	machine = false,
) {
	const raw = new RawRequest(new Socket())
	raw.method = "GET"
	raw.url = "/ws"
	raw.rawHeaders = Object.entries(machine ? env.machine : env.headers).flatMap(
		([name, value]) => [name, value],
	)
	const request = { raw } as FastifyRequest
	const admission = env.policy.evaluate(accessRequestFromHttp(raw, "api"))
	if (admission.kind !== "authenticated")
		throw new Error("Missing test admission")
	env.controller.admit(request, admission.principal)
	expect(env.controller.reserveUpgrade(request)).toBeUndefined()
	return { request, socket: fakeSocket() }
}

describe("unmounted root Fastify access hooks", () => {
	it.each(["revoke", "expiry", "stop"] as const)(
		"reevaluates root-admitted metadata immediately after %s with trusted denial headers",
		async reason => {
			const env = await setup()
			const mutate = vi.fn()
			env.app.addHook("preHandler", async () => {
				if (reason === "revoke")
					await env.sessions.revoke(env.created.principalId)
				if (reason === "expiry") env.advance(31 * 86400000)
				if (reason === "stop") env.controller.stopAdmission()
			})
			env.app.post(
				"/metadata",
				{
					schema: {
						response: {
							"4xx": {
								type: "object",
								required: ["saved"],
								properties: { saved: { type: "boolean" } },
							},
						},
					},
				},
				(request, reply) => {
					const denied = env.controller.authorizeMetadataMutation(request)
					if (denied) {
						for (const [name, value] of Object.entries(denied.headers))
							reply.header(name, value)
						return reply
							.serializer(value => JSON.stringify(value))
							.code(denied.status)
							.send({ code: denied.code })
					}
					mutate()
					return reply.send({ saved: true })
				},
			)
			const result = await env.app.inject({
				method: "POST",
				url: "/metadata",
				headers: { ...env.headers, "x-wavekit-csrf": env.created.csrfToken },
			})
			expect(result.statusCode).toBe(reason === "stop" ? 503 : 401)
			expect(result.json()).toEqual({
				code: reason === "stop" ? "ACCESS_UNAVAILABLE" : "AUTH_REQUIRED",
			})
			expect(result.headers["access-control-allow-origin"]).toBe(origin)
			expect(result.headers["cache-control"]).toBe("no-store")
			expect(mutate).not.toHaveBeenCalled()
		},
	)

	it("allows only current authenticated mutation requests, rejecting public and preflight outcomes", async () => {
		const env = await setup()
		const mutate = vi.fn()
		env.app.post("/metadata", (request, reply) => {
			const denied = env.controller.authorizeMetadataMutation(request)
			if (denied) return reply.code(denied.status).send({ code: denied.code })
			mutate()
			return reply.send({ saved: true })
		})
		for (const headers of [
			env.machine,
			{ ...env.headers, "x-wavekit-csrf": env.created.csrfToken },
		])
			expect(
				(await env.app.inject({ method: "POST", url: "/metadata", headers }))
					.statusCode,
			).toBe(200)
		expect(mutate).toHaveBeenCalledTimes(2)
		for (const [method, url, headers] of [
			["GET", "/health", { host: "receiver.lan:9000", origin }],
			[
				"OPTIONS",
				"/metadata",
				{
					host: "receiver.lan:9000",
					origin,
					"access-control-request-method": "POST",
				},
			],
		] as const) {
			const raw = new RawRequest(new Socket())
			raw.method = method
			raw.url = url
			raw.rawHeaders = Object.entries(headers).flatMap(([name, value]) => [
				name,
				value,
			])
			const request = { raw } as FastifyRequest
			expect(env.controller.authorizeMetadataMutation(request)).toMatchObject({
				kind: "deny",
				status: 503,
				code: "ACCESS_UNAVAILABLE",
			})
		}
	})

	it("retains allowed-Origin headers on stopped denial without reflecting hostile Origins", async () => {
		const env = await setup()
		env.controller.stopAdmission()
		for (const candidate of [origin, "http://evil.invalid"]) {
			const raw = new RawRequest(new Socket())
			raw.method = "POST"
			raw.url = "/metadata"
			raw.rawHeaders = ["Host", "receiver.lan:9000", "Origin", candidate]
			const denied = env.controller.authorizeMetadataMutation({
				raw,
			} as FastifyRequest)
			expect(denied).toMatchObject({ status: 503, code: "ACCESS_UNAVAILABLE" })
			expect(denied?.headers["Access-Control-Allow-Origin"]).toBe(
				candidate === origin ? origin : undefined,
			)
		}
	})

	it.each([
		{
			headers: ["Origin", origin, "Origin", origin],
			status: 400,
			code: "MALFORMED_REQUEST",
		},
		{
			headers: ["Origin", "http://evil.invalid"],
			status: 403,
			code: "ORIGIN_FORBIDDEN",
		},
		{
			headers: ["Origin", origin, "X-WaveKit-CSRF", "wrong"],
			status: 403,
			code: "CSRF_REQUIRED",
		},
	])(
		"preserves current raw policy denial $status/$code rather than cached admission",
		async ({ headers, status, code }) => {
			const env = await setup()
			const raw = new RawRequest(new Socket())
			raw.method = "POST"
			raw.url = "/metadata"
			raw.rawHeaders = [
				"Host",
				"receiver.lan:9000",
				"Cookie",
				`wavekit_session=${env.created.cookieValue}`,
				...headers,
			]
			const request = { raw } as FastifyRequest
			env.controller.admit(request, {
				kind: "session",
				id: env.created.principalId,
				expiresAt: null,
			})
			const denied = env.controller.authorizeMetadataMutation(request)
			expect(denied).toMatchObject({ kind: "deny", status, code })
			expect(denied?.headers["Cache-Control"]).toBe("no-store")
		},
	)

	it("requires an exactly adopted owned socket and retains current output across admission seal", async () => {
		const env = await setup()
		const fixture = reservedSocket(env)
		expect(
			env.controller.isWebSocketCurrent(fixture.request, fixture.socket),
		).toBe(false)
		expect(env.controller.adoptWebSocket(fixture.request, fixture.socket)).toBe(
			true,
		)
		expect(
			env.controller.isWebSocketCurrent(fixture.request, fixture.socket),
		).toBe(true)
		expect(
			env.controller.isWebSocketCurrent(
				{ raw: fixture.request.raw } as FastifyRequest,
				fixture.socket,
			),
		).toBe(false)
		expect(
			env.controller.isWebSocketCurrent(fixture.request, fakeSocket()),
		).toBe(false)
		env.controller.stopAdmission()
		expect(
			env.controller.isWebSocketCurrent(fixture.request, fixture.socket),
		).toBe(true)
		env.controller.dispose()
		expect(
			env.controller.isWebSocketCurrent(fixture.request, fixture.socket),
		).toBe(false)
	})

	it.each(["revoke", "expiry"] as const)(
		"rejects %s while the adopted socket's close handshake is delayed",
		async reason => {
			const env = await setup()
			const fixture = reservedSocket(env)
			expect(
				env.controller.adoptWebSocket(fixture.request, fixture.socket),
			).toBe(true)
			if (reason === "revoke")
				await env.sessions.revoke(env.created.principalId)
			else env.advance(31 * 86400000)
			expect(fixture.socket.readyState).toBe(1)
			expect(
				env.controller.isWebSocketCurrent(fixture.request, fixture.socket),
			).toBe(false)
			expect(fixture.socket.close).toHaveBeenCalledWith(1008, "Access expired")
		},
	)

	it("preserves machine output when session storage fails but never treats a missing lease as machine proof", async () => {
		const env = await setup()
		const machine = reservedSocket(env, true)
		expect(env.controller.adoptWebSocket(machine.request, machine.socket)).toBe(
			true,
		)
		const browser = reservedSocket(env)
		expect(env.controller.adoptWebSocket(browser.request, browser.socket)).toBe(
			true,
		)
		env.persist.mockRejectedValueOnce(new Error("private storage reason"))
		await expect(env.sessions.renew(env.created.principalId)).rejects.toThrow()
		expect(
			env.controller.isWebSocketCurrent(browser.request, browser.socket),
		).toBe(false)
		expect(
			env.controller.isWebSocketCurrent(machine.request, machine.socket),
		).toBe(true)
		env.controller.admit(machine.request, {
			kind: "session",
			id: env.created.principalId,
			expiresAt: 1,
		})
		expect(
			env.controller.isWebSocketCurrent(machine.request, machine.socket),
		).toBe(false)
	})

	it.each(["throw", "release", "dispose", "closing"] as const)(
		"fails closed after current() synchronously causes %s",
		async effect => {
			const env = await setup()
			let triggered = false
			let fixture: ReturnType<typeof reservedSocket> | undefined
			const attach = env.leases.attach.bind(env.leases)
			vi.spyOn(env.leases, "attach").mockImplementation((id, invalidated) => {
				const result = attach(id, invalidated)
				if (result.kind !== "attached") return result
				return {
					kind: "attached",
					lease: {
						release: result.lease.release,
						current: () => {
							const current = result.lease.current()
							if (triggered && fixture) {
								if (effect === "throw")
									throw new Error("private current detail")
								if (effect === "release")
									fixture.request.raw.socket.emit("close")
								if (effect === "dispose") env.controller.dispose()
								if (effect === "closing")
									Object.defineProperty(fixture.socket, "readyState", {
										value: 2,
									})
							}
							return current
						},
					},
				}
			})
			fixture = reservedSocket(env)
			expect(
				env.controller.adoptWebSocket(fixture.request, fixture.socket),
			).toBe(true)
			triggered = true
			expect(
				env.controller.isWebSocketCurrent(fixture.request, fixture.socket),
			).toBe(false)
		},
	)

	it.each(["stop", "dispose"] as const)(
		"%s gates health, ordinary, pair, preflight and real WebSocket admission",
		async mode => {
			const env = await setup()
			const handler = vi.fn(async () => ({ ok: true }))
			env.app.get("/health", handler)
			env.app.get("/api/status", handler)
			env.app.post("/api/access/pair", handler)
			await env.app.register(websocket)
			env.app.get("/ws", { websocket: true }, socket => {
				void handler()
				socket.terminate()
			})
			const address = await listen(env.app)
			if (mode === "stop") env.controller.stopAdmission()
			else env.controller.dispose()
			for (const request of [
				{ method: "GET" as const, url: "/health", headers: env.headers },
				{ method: "GET" as const, url: "/api/status", headers: env.headers },
				{
					method: "POST" as const,
					url: "/api/access/pair",
					headers: env.headers,
				},
				{
					method: "OPTIONS" as const,
					url: "/api/status",
					headers: {
						host: "receiver.lan:9000",
						origin,
						"access-control-request-method": "GET",
					},
				},
			]) {
				const result = await env.app.inject(request)
				expect(result.statusCode).toBe(503)
				expect(result.headers["access-control-allow-origin"]).toBe(origin)
			}
			const upgrade = await rejected(address, env.headers)
			expect(upgrade.status).toBe(503)
			expect(handler).not.toHaveBeenCalled()
		},
	)

	it("covers nested docs, unknown routes and exact public health before handlers", async () => {
		const env = await setup()
		const handler = vi.fn(() => ({ ok: true }))
		await env.app.register(async nested => {
			nested.get("/docs", handler)
		})
		env.app.get("/health", handler)
		env.app.get("/health/live", handler)
		for (const path of [
			"/docs",
			"/unknown",
			"/health/ready",
			"/healthanything",
			"/api/status",
		])
			expect(
				(
					await env.app.inject({
						url: path,
						headers: { host: "receiver.lan:9000" },
					})
				).statusCode,
			).toBe(401)
		expect(handler).not.toHaveBeenCalled()
		for (const path of ["/health", "/health/live?x=1"])
			expect(
				(
					await env.app.inject({
						url: path,
						headers: { host: "receiver.lan:9000" },
					})
				).statusCode,
			).toBe(200)
		expect(
			(
				await env.app.inject({
					url: "/health",
					headers: { host: "foreign.lan" },
				})
			).statusCode,
		).toBe(403)
		expect(
			(await env.app.inject({ url: "/unknown", headers: env.machine }))
				.statusCode,
		).toBe(404)
	})

	it("retains readable allowed-origin denials and finite preflight", async () => {
		const env = await setup()
		const denied = await env.app.inject({
			url: "/docs",
			headers: { host: "receiver.lan:9000", origin },
		})
		expect(denied.statusCode).toBe(401)
		expect(denied.headers).toMatchObject({
			"access-control-allow-origin": origin,
			"cache-control": "no-store",
		})
		const preflight = await env.app.inject({
			method: "OPTIONS",
			url: "/unknown",
			headers: {
				host: "receiver.lan:9000",
				origin,
				"access-control-request-method": "POST",
				"access-control-request-headers": "Authorization, X-WaveKit-CSRF",
			},
		})
		expect(preflight.statusCode).toBe(204)
		expect(preflight.body).toBe("")
		expect(
			(
				await env.app.inject({
					method: "OPTIONS",
					url: "/unknown",
					headers: {
						host: "receiver.lan:9000",
						origin,
						"access-control-request-method": "POST",
						"access-control-request-headers": "X-Secret",
					},
				})
			).statusCode,
		).toBe(403)
	})

	it("stores only safe copied principals, without cookie context or serialization", async () => {
		const env = await setup()
		env.app.get("/identity", async request => {
			const first = env.controller.principalOf(request)
			if (first) first.id = "changed"
			return {
				principal: env.controller.principalOf(request),
				controller: env.controller,
			}
		})
		const result = await env.app.inject({
			url: "/identity",
			headers: env.headers,
		})
		expect(result.statusCode).toBe(200)
		expect(result.json()).toEqual({
			principal: {
				kind: "session",
				id: env.created.principalId,
				expiresAt: env.created.expiresAt,
			},
			controller: {},
		})
		expect(result.body).not.toContain(env.created.cookieValue)
	})

	it("rejects mismatched policy and shared lease stores", async () => {
		const a = await setup()
		const b = await setup()
		expect(() =>
			installAccessHooks(Fastify(), { policy: a.policy, sessions: b.sessions }),
		).toThrow("Invalid access adapter configuration")
		expect(() =>
			installAccessHooks(Fastify(), {
				policy: a.policy,
				sessions: a.sessions,
				leases: b.leases,
			}),
		).toThrow("Invalid access adapter configuration")
	})

	it("sends real WebSocket 401 and 403 responses before 101, retaining CORS", async () => {
		const env = await setup()
		await addWs(env)
		const url = await listen(env.app)
		const unauthorized = await rejected(url, {
			host: "receiver.lan:9000",
			origin,
		})
		expect(unauthorized).toMatchObject({
			status: 401,
			headers: { "access-control-allow-origin": origin },
		})
		expect(JSON.parse(unauthorized.body)).toEqual({ code: "AUTH_REQUIRED" })
		expect(
			(await rejected(url, { ...env.machine, origin: "http://evil.lan" }))
				.status,
		).toBe(403)
		expect((await rejected(url, { ...env.headers, origin: "" })).status).toBe(
			400,
		)
	})

	it("rejects lease capacity before101 without destroying the denied response", async () => {
		const env = await setup(1)
		await addWs(env)
		const url = await listen(env.app)
		const first = await connect(url, env.headers)
		expect(await rejected(url, env.headers)).toMatchObject({
			status: 429,
			body: JSON.stringify({ code: "ACCESS_CAPACITY" }),
		})
		first.close()
		await once(first, "close")
		const next = await connect(url, env.headers)
		next.close()
		await once(next, "close")
	})

	it("closes admitted WebSockets1008 on revocation and refuses late adoption", async () => {
		const env = await setup()
		await addWs(env)
		const client = await connect(await listen(env.app), env.headers)
		const closed = once(client, "close")
		await env.sessions.revoke(env.created.principalId)
		expect((await closed)[0]).toBe(1008)
	})

	it("rechecks a revoked reservation before broadcaster adoption", async () => {
		const env = await setup()
		await env.app.register(websocket)
		const registered = vi.fn()
		env.app.addHook("preValidation", async request => {
			if (request.url === "/ws")
				await env.sessions.revoke(env.created.principalId)
		})
		env.app.get("/ws", { websocket: true }, (socket, request) => {
			if (env.controller.adoptWebSocket(request, socket)) registered()
		})
		const url = await listen(env.app)
		const client = new WebSocket(url.replace("http:", "ws:") + "/ws", {
			headers: env.headers,
		})
		client.on("error", () => {})
		await new Promise<void>(resolve => client.once("close", () => resolve()))
		expect(registered).not.toHaveBeenCalled()
	})

	it("keeps active WebSockets across renewal and closes after rolling expiry", async () => {
		const env = await setup()
		await addWs(env)
		const client = await connect(await listen(env.app), env.headers)
		env.advance(29 * 86400000)
		expect(await env.sessions.renew(env.created.principalId)).toMatchObject({
			kind: "renewed",
		})
		env.advance(2 * 86400000)
		const message = once(client, "message")
		client.send("probe")
		await message
		expect(
			env.sessions.lookupByPrincipal(env.created.principalId),
		).toBeDefined()
		const closed = once(client, "close")
		env.advance(30 * 86400000)
		expect((await closed)[0]).toBe(1008)
	})

	it("persistence failure closes browser sockets and responds503 while bearer works", async () => {
		const env = await setup()
		await addWs(env)
		const url = await listen(env.app)
		const client = await connect(url, env.headers)
		const closed = once(client, "close")
		env.persist.mockRejectedValueOnce(new Error("private"))
		await expect(env.sessions.renew(env.created.principalId)).rejects.toThrow()
		expect((await closed)[0]).toBe(1008)
		expect((await rejected(url, env.headers)).status).toBe(503)
		const machine = await connect(url, env.machine)
		machine.close()
		await once(machine, "close")
	})

	it("destroys a streaming producer and response on revoke, ignoring ordinary request close", async () => {
		const env = await setup()
		const destroy = vi.fn()
		let opened: () => void = () => {}
		const started = new Promise<void>(resolve => {
			opened = resolve
		})
		env.app.get("/download", (request, reply) => {
			const result = env.controller.leaseDownload(request, reply.raw, destroy)
			if (result.kind !== "attached") return reply.code(429).send()
			reply.hijack()
			request.raw.emit("close")
			reply.raw.writeHead(200)
			reply.raw.write("audio")
			opened()
			return undefined
		})
		const url = await listen(env.app)
		const response = await new Promise<IncomingMessage>((resolve, reject) => {
			const request = get(url + "/download", { headers: env.headers }, resolve)
			request.on("error", reject)
		})
		response.on("error", () => {})
		await started
		expect(destroy).not.toHaveBeenCalled()
		const closed = once(response, "close").catch(() => [])
		await env.sessions.revoke(env.created.principalId)
		await closed
		expect(destroy).toHaveBeenCalledTimes(1)
		env.controller.dispose()
		expect(destroy).toHaveBeenCalledTimes(1)
	})

	it("releases completed downloads and disposes accepted sockets without hanging server shutdown", async () => {
		const env = await setup(1)
		const destroy = vi.fn()
		env.app.get("/download", (request, reply) => {
			const lease = env.controller.leaseDownload(request, reply.raw, destroy)
			if (lease.kind !== "attached") return reply.code(429).send()
			return reply.send("done")
		})
		await addWs(env)
		expect(
			(await env.app.inject({ url: "/download", headers: env.headers }))
				.statusCode,
		).toBe(200)
		expect(destroy).toHaveBeenCalledTimes(1)
		const client = await connect(await listen(env.app), env.headers)
		const closed = once(client, "close")
		await env.app.close()
		await closed
		expect(client.readyState).toBe(WebSocket.CLOSED)
	})
	it("terminates an invalidated peer that ignores close frames within the bounded grace", async () => {
		const env = await setup()
		let serverSocket: WebSocket | undefined
		await env.app.register(websocket)
		env.app.get("/ws", { websocket: true }, (socket, request) => {
			if (env.controller.adoptWebSocket(request, socket)) serverSocket = socket
		})
		const client = await connect(await listen(env.app), env.headers)
		await vi.waitFor(() => expect(serverSocket).toBeDefined())
		const terminate = vi.spyOn(serverSocket as WebSocket, "terminate")
		client.pause()
		await env.sessions.revoke(env.created.principalId)
		await vi.waitFor(() => expect(terminate).toHaveBeenCalledTimes(1))
		const closed = once(client, "close")
		client.resume()
		await closed
		env.controller.dispose()
		expect(terminate).toHaveBeenCalledTimes(1)
	})

	it("cleans up an interrupted download once and refuses capacity before opening another", async () => {
		const env = await setup(1)
		const opened = vi.fn()
		const destroy = vi.fn(() => {
			throw new Error("producer detail")
		})
		env.app.get("/download", (request, reply) => {
			const lease = env.controller.leaseDownload(request, reply.raw, destroy)
			if (lease.kind !== "attached")
				return reply.code(429).send({ code: "ACCESS_CAPACITY" })
			opened()
			reply.hijack()
			reply.raw.writeHead(200)
			reply.raw.write("audio")
			return undefined
		})
		const url = await listen(env.app)
		const response = await new Promise<IncomingMessage>((resolve, reject) => {
			get(url + "/download", { headers: env.headers }, resolve).on(
				"error",
				reject,
			)
		})
		response.on("error", () => {})
		const denied = await env.app.inject({
			url: "/download",
			headers: env.headers,
		})
		expect(denied.statusCode).toBe(429)
		expect(opened).toHaveBeenCalledTimes(1)
		response.destroy()
		await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1))
		env.controller.dispose()
		expect(destroy).toHaveBeenCalledTimes(1)
		// This listener did not dispose the externally shared manager.
		const external = env.leases.attach(env.created.principalId, () => {})
		expect(external.kind).toBe("attached")
		if (external.kind === "attached") external.lease.release()
	})
	it("rejects wrong, started, completed and destroyed responses before producer side effects", async () => {
		const env = await setup(1)
		const destroy = vi.fn()
		env.app.get("/checks", (request, reply) => {
			const wrong = new ServerResponse(new RawRequest(new Socket()))
			expect(env.controller.leaseDownload(request, wrong, destroy)).toEqual({
				kind: "rejected",
				reason: "invalidated",
			})
			wrong.destroy()
			const destroyed = new ServerResponse(request.raw)
			destroyed.destroy()
			expect(
				env.controller.leaseDownload(request, destroyed, destroy).kind,
			).toBe("rejected")
			reply.hijack()
			reply.raw.writeHead(200)
			expect(
				env.controller.leaseDownload(request, reply.raw, destroy).kind,
			).toBe("rejected")
			reply.raw.end("done")
			expect(
				env.controller.leaseDownload(request, reply.raw, destroy).kind,
			).toBe("rejected")
		})
		const url = await listen(env.app)
		const body = await new Promise<string>((resolve, reject) => {
			get(url + "/checks", { headers: env.headers }, response => {
				let data = ""
				response.on("data", part => {
					data += String(part)
				})
				response.on("end", () => resolve(data))
				response.on("error", reject)
			}).on("error", reject)
		})
		expect(body).toBe("done")
		expect(destroy).not.toHaveBeenCalled()
		const free = env.leases.attach(env.created.principalId, () => {})
		expect(free.kind).toBe("attached")
		if (free.kind === "attached") free.lease.release()
	})

	it.each(["disconnect", "expiry"])(
		"rechecks delayed producer setup after %s and preserves the asynchronous error sink",
		async reason => {
			const env = await setup()
			const producerCleanup = vi.fn()
			const startWriting = vi.fn()
			let signalInvalidation: () => void = () => {}
			const invalidated = new Promise<void>(resolve => {
				signalInvalidation = resolve
			})
			let startSetup: () => void = () => {}
			let finishSetup: () => void = () => {}
			let stopSetup: () => void = () => {}
			const started = new Promise<void>(resolve => {
				startSetup = resolve
			})
			const ready = new Promise<void>(resolve => {
				finishSetup = resolve
			})
			const completed = new Promise<void>(resolve => {
				stopSetup = resolve
			})
			env.app.get("/delayed", async (request, reply) => {
				let producer: { destroy: () => void } | undefined
				const lease = env.controller.leaseDownload(request, reply.raw, () => {
					producer?.destroy()
					signalInvalidation()
					// A pipeline/destroy callback may report an error on the next microtask.
					queueMicrotask(() => {
						if (!reply.raw.closed)
							reply.raw.emit("error", new Error("private producer detail"))
					})
				})
				if (lease.kind !== "attached") return reply.code(429).send()
				reply.hijack()
				startSetup()
				await ready
				producer = { destroy: producerCleanup }
				if (!lease.active()) producer.destroy()
				else {
					startWriting()
					reply.raw.end("unexpected")
				}
				stopSetup()
			})
			const url = await listen(env.app)
			const request = get(url + "/delayed", { headers: env.headers })
			request.on("error", () => {})
			const disconnected = new Promise<void>(resolve =>
				request.once("close", resolve),
			)
			await started
			if (reason === "disconnect") request.destroy()
			else {
				env.advance(31 * 86400000)
				await env.sessions.pruneExpired()
			}
			// Await actual disconnect before letting asynchronous setup produce a resource.
			await disconnected
			await invalidated
			finishSetup()
			await completed
			expect(producerCleanup).toHaveBeenCalledTimes(1)
			expect(startWriting).not.toHaveBeenCalled()
		},
	)
})

async function bootstrapWire(
	app: ReturnType<typeof Fastify>,
	options: { method: "GET" | "HEAD"; url: string; headers: Record<string, string> },
) {
	if (!app.server.listening) await listen(app)
	const bound = app.addresses()[0]
	if (!bound) throw new Error("Missing listener")
	return await new Promise<{ statusCode: number; body: string; headers: import("node:http").IncomingHttpHeaders; json: () => unknown }>((resolve, reject) => {
		const request = httpRequest({ host: "127.0.0.1", port: bound.port, path: options.url, method: options.method, headers: options.headers, agent: false }, response => {
			let body = ""
			response.setEncoding("utf8")
			response.on("data", (chunk: string) => { body += chunk })
			response.on("error", reject)
			response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body, json: () => JSON.parse(body) as unknown }))
		})
		request.on("error", reject)
		request.setTimeout(2000, () => request.destroy(new Error("Wire request timeout")))
		request.end()
	})
}

describe("root bootstrap opt-in dispatch", () => {
	it("leaves missing opt-in protected and admits no public principal when enabled", async () => {
		for (const enabled of [false, true]) {
			const env = await setup(32, enabled)
			const reserve = vi.spyOn(env.controller, "reserveUpgrade")
			const handler = vi.fn((request: FastifyRequest) => ({
				principal: env.controller.principalOf(request) ?? null,
			}))
			env.app.get("/api/access/bootstrap", { exposeHeadRoute: false }, handler)
			const result = await env.app.inject({
				url: "/api/access/bootstrap",
				headers: {
					host: "receiver.lan:9000",
					origin,
					authorization: "Basic stale",
				},
			})
			expect(result.statusCode).toBe(enabled ? 200 : 401)
			if (enabled) expect(result.json()).toEqual({ principal: null })
			else expect(handler).not.toHaveBeenCalled()
			expect(reserve).not.toHaveBeenCalled()
		}
	})

	it("keeps query, encoded, trailing, POST and raw Upgrade requests on ordinary policy", async () => {
		const env = await setup(32, true)
		const handler = vi.fn(() => ({ unexpected: true }))
		env.app.route({
			method: ["GET", "POST"],
			url: "/api/access/bootstrap",
			handler,
		})
		for (const [url, method, extra] of [
			["/api/access/bootstrap?x=1", "GET", {}],
			["/api/access/%62ootstrap", "GET", {}],
			["/api/access/bootstrap/", "GET", {}],
			["/api/access/bootstrap", "POST", {}],
			["/api/access/bootstrap", "GET", { upgrade: "websocket" }],
		] as const) {
			const result = await env.app.inject({
				url,
				method,
				headers: { host: "receiver.lan:9000", ...extra },
			})
			expect(result.statusCode).toBe(401)
		}
		expect(handler).not.toHaveBeenCalled()
	})

	it("retains HEAD boundary denial and sealed503 with safe serializer and no handler", async () => {
		const env = await setup(32, true)
		const handler = vi.fn(() => ({ unexpected: true }))
		env.app.route({
			method: ["GET", "HEAD"],
			exposeHeadRoute: false,
			url: "/api/access/bootstrap",
			handler,
		})
		env.app.addHook("onRequest", async (_request, reply) => {
			reply.serializer(() => "secret serializer")
		})
		const denied = await bootstrapWire(env.app, {
			method: "HEAD",
			url: "/api/access/bootstrap",
			headers: { host: "evil.lan:9000" },
		})
		expect(denied.statusCode).toBe(403)
		expect(denied.body).toBe("")
		env.controller.stopAdmission()
		for (const method of ["GET", "HEAD"] as const) {
			const result = await bootstrapWire(env.app, {
				method,
				url: "/api/access/bootstrap",
				headers: { host: "receiver.lan:9000", origin },
			})
			expect(result.statusCode).toBe(503)
			expect(result.headers["cache-control"]).toBe("no-store")
			expect(result.headers["access-control-allow-origin"]).toBe(origin)
			if (method === "GET")
				expect(result.json()).toEqual({ code: "ACCESS_UNAVAILABLE" })
			else expect(result.body).toBe("")
		}
		expect(handler).not.toHaveBeenCalled()
	})
})
