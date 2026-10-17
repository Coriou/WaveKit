import { createServer, request as httpRequest } from "node:http"
import type { IncomingMessage, ServerResponse, Server } from "node:http"
import { Readable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConnectionLeases } from "../../../src/access/connection-leases.js"
import type { LeaseTimers } from "../../../src/access/connection-leases.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { NodeHttpAccessAdapter } from "../../../src/access/node-http-adapter.js"
import type {
	AcceptedAudioStream,
	AudioAccessContext,
} from "../../../src/access/node-http-adapter.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"

const authority = "receiver.lan:9000"
const origin = `http://${authority}`
const pcm = Buffer.from("RIFF-pcm-payload")
const teardown: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of teardown.splice(0)) await close()
})

function timers() {
	let nextId = 0
	const callbacks = new Map<number, () => void>()
	const clear = vi.fn((id: unknown) => {
		callbacks.delete(id as number)
	})
	const scheduler: LeaseTimers = {
		set: callback => {
			const id = ++nextId
			callbacks.set(id, callback)
			return id
		},
		clear,
	}
	return {
		scheduler,
		count: () => callbacks.size,
		tick: () => {
			for (const [id, callback] of [...callbacks]) {
				callbacks.delete(id)
				callback()
			}
		},
	}
}

interface Live {
	request: IncomingMessage
	response: ServerResponse
	context: AudioAccessContext
	lease: AcceptedAudioStream
}

async function fixture(
	options: {
		live?: boolean
		maxListeners?: number
		maxConnections?: number
		maxStreams?: number
		cleanupThrows?: boolean
		producer?: Readable
		ownManager?: boolean
	} = {},
) {
	let elapsed = 0
	let failPersist = false
	let activeClients = 0
	let registrations = 0
	let random = 20
	const token = generateMachineToken(() => Buffer.alloc(32, 7))
	const digest = digestMachineToken(token)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: () =>
			failPersist
				? Promise.reject(new Error("SECRET-storage"))
				: Promise.resolve(),
		epochNow: () => 1_000_000,
		monotonicNow: () => elapsed,
		ttlMs: 1000,
		maxListenersPerSession: options.maxListeners ?? 16,
		random: size => Buffer.alloc(size, ++random),
	})
	const created = await sessions.create()
	if (created.kind !== "created") throw new Error("Expected session")
	const policy = new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: [authority],
		allowedOrigins: [origin],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
	const clock = timers()
	const manager = new ConnectionLeases(sessions, {
		timers: clock.scheduler,
		maxConnections: options.maxConnections ?? 512,
	})
	const adapter = new NodeHttpAccessAdapter({
		policy,
		sessions,
		...(options.ownManager ? {} : { leases: manager }),
		...(options.maxStreams === undefined
			? {}
			: { maxStreams: options.maxStreams }),
	})
	const live: Live[] = []
	const cleanup = vi.fn(() => {
		activeClients--
		if (options.cleanupThrows) throw new Error("Registry failure")
	})
	const destroyProducer = vi.fn(() => options.producer?.destroy())
	let handler = (req: IncomingMessage, res: ServerResponse) => {
		const context = adapter.admit(req, res)
		if (!context) return
		const lease = adapter.leaseStream(context, res, cleanup, destroyProducer)
		if (lease.kind === "rejected" || !lease.active()) return
		registrations++
		activeClients++
		live.push({ request: req, response: res, context, lease })
		if (options.producer) options.producer.on("error", () => res.destroy())
		res.writeHead(200, { "Content-Type": "audio/wav" })
		res.write(pcm)
		if (!options.live) res.end()
	}
	const server = createServer((req, res) => handler(req, res))
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject)
			resolve()
		})
	})
	const address = server.address()
	if (!address || typeof address === "string")
		throw new Error("Expected loopback address")
	teardown.push(async () => {
		adapter.dispose()
		manager.dispose()
		server.closeAllConnections()
		await closeServer(server)
	})
	return {
		token,
		policy,
		sessions,
		created,
		adapter,
		manager,
		clock,
		live,
		cleanup,
		destroyProducer,
		port: address.port,
		registrations: () => registrations,
		activeClients: () => activeClients,
		advance: (ms: number) => {
			elapsed += ms
		},
		fail: () => {
			failPersist = true
		},
		handle: (replacement: typeof handler) => {
			handler = replacement
		},
	}
}

async function closeServer(server: Server) {
	await new Promise<void>(resolve => server.close(() => resolve()))
}

async function open(
	port: number,
	headers: string[] = [],
	path = "/stream.wav",
	method = "GET",
) {
	return new Promise<{
		response: IncomingMessage
		chunks: Buffer[]
		ended: Promise<void>
	}>((resolve, reject) => {
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port,
				path,
				method,
				headers: ["Host", authority, "Connection", "close", ...headers],
			},
			response => {
				const chunks: Buffer[] = []
				response.on("data", (chunk: Buffer) => chunks.push(chunk))
				const ended = new Promise<void>(done => {
					response.once("end", done)
					response.once("close", done)
					response.on("error", () => done())
				})
				resolve({ response, chunks, ended })
			},
		)
		req.on("error", reject)
		req.end()
	})
}

async function read(
	port: number,
	headers: string[] = [],
	path = "/stream.wav",
	method = "GET",
) {
	const stream = await open(port, headers, path, method)
	await stream.ended
	return {
		status: stream.response.statusCode,
		headers: stream.response.headers,
		body: Buffer.concat(stream.chunks),
	}
}

function bearer(token: string) {
	return ["Authorization", `Bearer ${token}`]
}
function cookie(value: string) {
	return ["Cookie", `wavekit_session=${value}`, "Origin", origin]
}

describe("unmounted original-request Node HTTP audio boundary", () => {
	it("denies anonymous audio and audio /health before WAV bytes or client admission", async () => {
		const env = await fixture()
		for (const path of ["/stream", "/stream.wav", "/health", "/health/live"]) {
			const result = await read(env.port, [], path)
			expect(result.status).toBe(401)
			expect(JSON.parse(result.body.toString())).toEqual({
				code: "AUTH_REQUIRED",
			})
			expect(result.headers["cache-control"]).toBe("no-store")
			expect(result.body.includes(Buffer.from("RIFF"))).toBe(false)
		}
		expect(env.registrations()).toBe(0)
		expect(env.cleanup).not.toHaveBeenCalled()
		expect(env.destroyProducer).not.toHaveBeenCalled()
		expect(env.clock.count()).toBe(0)
	})

	it.each(["machine", "browser"])(
		"admits a real %s request and preserves PCM and readable CORS headers",
		async kind => {
			const env = await fixture()
			const result = await read(
				env.port,
				kind === "machine"
					? bearer(env.token)
					: cookie(env.created.cookieValue),
			)
			expect(result.status).toBe(200)
			expect(result.body).toEqual(pcm)
			expect(env.registrations()).toBe(1)
			await vi.waitFor(() => expect(env.cleanup).toHaveBeenCalledOnce())
			expect(env.activeClients()).toBe(0)
			expect(env.destroyProducer).toHaveBeenCalledOnce()
			expect(env.clock.count()).toBe(0)
			if (kind === "browser") {
				expect(result.headers["access-control-allow-origin"]).toBe(origin)
				expect(result.headers["access-control-allow-credentials"]).toBe("true")
			}
		},
	)

	it("allows validated credential-free preflight with no streaming side effects", async () => {
		const env = await fixture()
		const result = await read(
			env.port,
			[
				"Origin",
				origin,
				"Access-Control-Request-Method",
				"GET",
				"Access-Control-Request-Headers",
				"Authorization, Range",
			],
			"/stream",
			"OPTIONS",
		)
		expect(result.status).toBe(204)
		expect(result.body).toHaveLength(0)
		expect(result.headers["access-control-allow-origin"]).toBe(origin)
		expect(env.registrations()).toBe(0)
		expect(env.clock.count()).toBe(0)
	})

	it("caches an allowed preflight for 600 s but never a shutdown 503 preflight (WG9 1.2)", async () => {
		const env = await fixture()
		const preflight = [
			"Origin",
			origin,
			"Access-Control-Request-Method",
			"GET",
			"Access-Control-Request-Headers",
			"Range",
		]
		const allowed = await read(env.port, preflight, "/stream", "OPTIONS")
		expect(allowed.status).toBe(204)
		expect(allowed.headers["access-control-max-age"]).toBe("600")
		env.adapter.dispose()
		const stopped = await read(env.port, preflight, "/stream", "OPTIONS")
		expect(stopped.status).toBe(503)
		expect(JSON.parse(stopped.body.toString())).toEqual({
			code: "ACCESS_UNAVAILABLE",
		})
		expect(stopped.headers["access-control-allow-origin"]).toBe(origin)
		expect(stopped.headers["access-control-max-age"]).toBeUndefined()
		expect(env.registrations()).toBe(0)
	})

	it.each([
		["wrong host", ["Host", "evil.lan:9000"], 400],
		["wrong origin", ["Origin", "http://evil.lan:9000"], 403],
		["opaque origin", ["Origin", "null"], 403],
		["duplicate origin", ["Origin", origin, "origin", origin], 400],
		["duplicate authorization", ["Authorization", "Bearer wrong"], 400],
		[
			"duplicate cookie",
			["Cookie", "wavekit_session=a; wavekit_session=b"],
			400,
		],
	] as const)(
		"rejects original raw %s despite valid bearer",
		async (_label, headers, status) => {
			const env = await fixture()
			const result = await read(env.port, [...bearer(env.token), ...headers])
			expect(result.status).toBe(status)
			expect(env.registrations()).toBe(0)
			expect(result.body.includes(pcm)).toBe(false)
		},
	)

	it("rejects a genuinely wrong Host rather than trusting forwarded headers", async () => {
		const env = await fixture()
		const result = await new Promise<{
			status: number | undefined
			body: string
		}>((resolve, reject) => {
			const req = httpRequest(
				{
					host: "127.0.0.1",
					port: env.port,
					path: "/stream",
					headers: {
						Host: "evil.lan:9000",
						Authorization: `Bearer ${env.token}`,
						"X-Forwarded-Host": authority,
					},
				},
				res => {
					let body = ""
					res.on("data", (chunk: Buffer) => {
						body += chunk.toString()
					})
					res.on("error", reject)
					res.on("end", () => resolve({ status: res.statusCode, body }))
				},
			)
			req.on("error", reject)
			req.end()
		})
		expect(result).toMatchObject({ status: 403 })
		expect(result.body).not.toContain("evil.lan")
		expect(env.registrations()).toBe(0)
	})

	it("permits browser navigation metadata, rejects no-Origin cookies and opaque origins", async () => {
		const env = await fixture()
		const base = ["Cookie", `wavekit_session=${env.created.cookieValue}`]
		expect((await read(env.port, base)).status).toBe(403)
		expect(
			(await read(env.port, [...base, "Sec-Fetch-Site", "same-origin"])).body,
		).toEqual(pcm)
		expect(
			(await read(env.port, [...base, "Sec-Fetch-Site", "none"])).body,
		).toEqual(pcm)
	})

	it("rechecks revocation between admission and lease without registering a client", async () => {
		const env = await fixture()
		let saved:
			| { context: AudioAccessContext; response: ServerResponse }
			| undefined
		env.handle((req, res) => {
			const context = env.adapter.admit(req, res)
			if (context) saved = { context, response: res }
		})
		const response = read(env.port, cookie(env.created.cookieValue))
		await vi.waitFor(() => expect(saved).toBeDefined())
		await env.sessions.revoke(env.created.principalId)
		if (!saved) throw new Error("Expected admission")
		expect(
			env.adapter.leaseStream(
				saved.context,
				saved.response,
				env.cleanup,
				env.destroyProducer,
			),
		).toEqual({ kind: "rejected" })
		expect((await response).status).toBe(401)
		expect(env.cleanup).not.toHaveBeenCalled()
		expect(env.destroyProducer).not.toHaveBeenCalled()
		expect(env.clock.count()).toBe(0)
	})

	it("rejects a cookie already durably logged out before admission", async () => {
		const env = await fixture()
		await env.sessions.revoke(env.created.principalId)
		expect((await read(env.port, cookie(env.created.cookieValue))).status).toBe(
			401,
		)
		expect(env.registrations()).toBe(0)
	})

	it("closes an active browser stream immediately on durable revocation without appending JSON", async () => {
		const env = await fixture({ live: true })
		const stream = await open(env.port, cookie(env.created.cookieValue))
		await vi.waitFor(() => expect(Buffer.concat(stream.chunks)).toEqual(pcm))
		await env.sessions.revoke(env.created.principalId)
		await stream.ended
		expect(Buffer.concat(stream.chunks)).toEqual(pcm)
		expect(env.cleanup).toHaveBeenCalledOnce()
		expect(env.destroyProducer).toHaveBeenCalledOnce()
		expect(env.activeClients()).toBe(0)
		expect(env.clock.count()).toBe(0)
	})

	it.each(["listener", "global"])(
		"enforces %s lease capacity and restores it after disconnect",
		async bound => {
			const env = await fixture({
				live: true,
				...(bound === "listener" ? { maxListeners: 1 } : { maxConnections: 1 }),
			})
			const first = await open(env.port, cookie(env.created.cookieValue))
			const denied = await read(env.port, cookie(env.created.cookieValue))
			expect(denied.status).toBe(429)
			expect(denied.body.toString()).toBe('{"code":"ACCESS_CAPACITY"}')
			expect(env.registrations()).toBe(1)
			first.response.destroy()
			await vi.waitFor(() => expect(env.activeClients()).toBe(0))
			const again = await open(env.port, cookie(env.created.cookieValue))
			expect(again.response.statusCode).toBe(200)
			again.response.destroy()
			await vi.waitFor(() => expect(env.clock.count()).toBe(0))
		},
	)

	it("bounds machine streams independently of browser session capacity", async () => {
		const env = await fixture({ live: true, maxStreams: 1 })
		const first = await open(env.port, bearer(env.token))
		expect((await read(env.port, bearer(env.token))).status).toBe(429)
		first.response.destroy()
		await vi.waitFor(() => expect(env.activeClients()).toBe(0))
		const next = await open(env.port, bearer(env.token))
		expect(next.response.statusCode).toBe(200)
		next.response.destroy()
	})

	it("follows committed renewal through the original deadline and expires through the authority clock", async () => {
		const env = await fixture({ live: true })
		const stream = await open(env.port, cookie(env.created.cookieValue))
		env.advance(900)
		await env.sessions.renew(env.created.principalId)
		env.advance(200)
		env.clock.tick()
		expect(env.cleanup).not.toHaveBeenCalled()
		expect(env.clock.count()).toBe(1)
		expect(env.live[0]?.lease.active()).toBe(true)
		env.advance(800)
		env.clock.tick()
		await stream.ended
		expect(env.cleanup).toHaveBeenCalledOnce()
		expect(env.clock.count()).toBe(0)
	})

	it("destroys a caller Readable on disconnect even when registry cleanup throws", async () => {
		const producer = new Readable({ read() {} })
		const env = await fixture({ live: true, producer, cleanupThrows: true })
		const stream = await open(env.port, cookie(env.created.cookieValue))
		stream.response.destroy()
		await vi.waitFor(() => expect(env.cleanup).toHaveBeenCalledOnce())
		expect(producer.destroyed).toBe(true)
		expect(env.clock.count()).toBe(0)
	})

	it("handles producer and response errors through response destruction and releases leases", async () => {
		const producer = new Readable({ read() {} })
		const env = await fixture({ live: true, producer })
		const stream = await open(env.port, cookie(env.created.cookieValue))
		producer.destroy(new Error("Producer failed"))
		await stream.ended
		expect(env.cleanup).toHaveBeenCalledOnce()
		expect(env.clock.count()).toBe(0)
		const next = await open(env.port, cookie(env.created.cookieValue))
		env.live[1]?.response.emit("error", new Error("Response failed"))
		await next.ended
		expect(env.cleanup).toHaveBeenCalledTimes(2)
		expect(env.clock.count()).toBe(0)
	})

	it("finishes normally through release() and ignores IncomingMessage's ordinary close", async () => {
		const env = await fixture({ live: true })
		const stream = await open(env.port, cookie(env.created.cookieValue))
		const live = env.live[0]
		if (!live) throw new Error("Expected live stream")
		live.request.emit("close")
		expect(live.lease.active()).toBe(true)
		live.lease.release()
		live.lease.release()
		await stream.ended
		expect(Buffer.concat(stream.chunks)).toEqual(pcm)
		expect(env.cleanup).toHaveBeenCalledOnce()
		expect(env.clock.count()).toBe(0)
	})

	it("detects a destroyed response before its close event releases the stream", async () => {
		const env = await fixture({ live: true })
		const response = await open(env.port, cookie(env.created.cookieValue))
		const live = env.live[0]
		if (!live) throw new Error("Expected live stream")
		live.response.destroy()
		expect(live.lease.active()).toBe(false)
		expect(env.cleanup).toHaveBeenCalledOnce()
		expect(env.clock.count()).toBe(0)
		await response.ended
	})

	it("closes browser leases on storage failure but keeps machine access distinct", async () => {
		const env = await fixture({ live: true })
		const stream = await open(env.port, cookie(env.created.cookieValue))
		env.fail()
		await expect(
			env.sessions.renew(env.created.principalId),
		).rejects.toMatchObject({ code: "ACCESS_UNAVAILABLE" })
		await stream.ended
		expect(env.clock.count()).toBe(0)
		expect((await read(env.port, cookie(env.created.cookieValue))).status).toBe(
			503,
		)
		const machine = await open(env.port, bearer(env.token))
		expect(machine.response.statusCode).toBe(200)
		machine.response.destroy()
	})

	it("disposes its streams idempotently while preserving a borrowed manager's other owner", async () => {
		const env = await fixture({ live: true, cleanupThrows: true })
		const otherCleanup = vi.fn()
		const other = env.manager.attach(env.created.principalId, otherCleanup)
		const first = await open(env.port, cookie(env.created.cookieValue))
		const second = await open(env.port, bearer(env.token))
		env.adapter.dispose()
		env.adapter.dispose()
		await Promise.all([first.ended, second.ended])
		expect(env.cleanup).toHaveBeenCalledTimes(2)
		expect(otherCleanup).not.toHaveBeenCalled()
		expect(env.clock.count()).toBe(1)
		if (other.kind === "attached") other.lease.release()
		expect(env.clock.count()).toBe(0)
		expect(env.manager.attach(env.created.principalId, otherCleanup).kind).toBe(
			"attached",
		)
		expect((await read(env.port, bearer(env.token))).status).toBe(503)
	})

	it("disposes its internally created manager and all active transports", async () => {
		const dispose = vi.spyOn(ConnectionLeases.prototype, "dispose")
		const env = await fixture({ live: true, ownManager: true })
		const stream = await open(env.port, cookie(env.created.cookieValue))
		env.adapter.dispose()
		await stream.ended
		expect(dispose).toHaveBeenCalledOnce()
		expect(env.cleanup).toHaveBeenCalledOnce()
		dispose.mockRestore()
	})

	it("rejects forged or cross-response contexts and rejects shared-manager authority mismatch", async () => {
		const env = await fixture()
		env.handle((_req, res) => {
			expect(
				env.adapter.leaseStream(
					{
						request: { method: "GET", remoteAddress: "127.0.0.1" },
						principal: { kind: "machine", id: "machine", expiresAt: null },
					},
					res,
					env.cleanup,
				),
			).toEqual({ kind: "rejected" })
		})
		expect((await read(env.port, bearer(env.token))).status).toBe(400)
		expect(env.cleanup).not.toHaveBeenCalled()
		const other = await fixture()
		expect(
			() =>
				new NodeHttpAccessAdapter({
					policy: env.policy,
					sessions: other.sessions,
				}),
		).toThrow("Invalid HTTP access configuration")
		expect(
			() =>
				new NodeHttpAccessAdapter({
					policy: env.policy,
					sessions: env.sessions,
					leases: other.manager,
				}),
		).toThrow("Invalid HTTP access configuration")
		for (const maxStreams of [0, 513, NaN])
			expect(
				() =>
					new NodeHttpAccessAdapter({
						policy: env.policy,
						sessions: env.sessions,
						maxStreams,
					}),
			).toThrow("Invalid HTTP access configuration")
	})

	it("keeps original query/credentials out of context JSON and denial bodies", async () => {
		const env = await fixture()
		expect(
			(await read(env.port, bearer(env.token), "/stream?token=SECRET-query"))
				.status,
		).toBe(200)
		expect(JSON.stringify(env.live[0]?.context)).not.toContain("SECRET")
		expect(JSON.stringify(env.live[0]?.context)).not.toContain(env.token)
		expect(JSON.stringify(env.live[0]?.context)).not.toContain("headers")
		const denied = await read(env.port, [], "/stream?token=SECRET-query")
		expect(denied.body.toString()).not.toContain("SECRET")
	})
})
