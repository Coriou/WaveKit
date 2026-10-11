import { createServer, request } from "node:http"
import type { IncomingMessage } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConnectionLeases } from "../../../src/access/connection-leases.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"
import {
	AudioClientRegistry,
	AudioHttpServer,
	parseStreamPath,
} from "../../../src/core/audio-stream-server.js"
import { createLogger } from "../../../src/utils/logger.js"

const authority = "receiver.local:8081"
const origin = "http://receiver.local:8080"
const log = createLogger({ level: "fatal" })
const stream = { rate: 8000, format: "s16le" as const }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup()
	vi.restoreAllMocks()
})

async function freePort(): Promise<number> {
	const server = createServer()
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	if (!address || typeof address === "string")
		throw new Error("Missing address")
	await new Promise<void>(resolve => server.close(() => resolve()))
	return address.port
}

async function fixture() {
	const token = generateMachineToken()
	const digest = digestMachineToken(token)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: () => Promise.resolve(),
	})
	const session = await sessions.create()
	if (session.kind !== "created") throw new Error("Missing session")
	const policy = new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: [authority],
		allowedOrigins: [origin],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
	const leases = new ConnectionLeases(sessions)
	const registry = new AudioClientRegistry(log, {
		label: "Test audio",
		stream,
		stallTimeoutMs: 1000,
	})
	const resolve = vi.fn((req: IncomingMessage) => {
		const path = parseStreamPath(req.url)
		return path.base === "/stream" ? { registry, stream, wav: path.wav } : null
	})
	const server = new AudioHttpServer(log, "Test audio", resolve, vi.fn(), {
		policy,
		sessions,
		leases,
	})
	const port = await freePort()
	await server.start(port, "127.0.0.1")
	cleanups.push(async () => {
		await server.close()
		leases.dispose()
	})
	return {
		server,
		port,
		registry,
		resolve,
		leases,
		sessions,
		session,
		bearer: { Authorization: `Bearer ${token}` },
		cookie: {
			Cookie: `wavekit_session=${session.cookieValue}`,
			Origin: origin,
		},
	}
}

async function open(
	port: number,
	headers: Record<string, string> = {},
	path = "/stream.wav",
	method = "GET",
) {
	return new Promise<{
		response: IncomingMessage
		chunks: Buffer[]
		ended: Promise<void>
	}>((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path,
				method,
				headers: { Host: authority, Connection: "close", ...headers },
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

describe("mounted protected HTTP audio", () => {
	it("denies before route resolution, stream headers, WAV bytes or registry admission", async () => {
		const env = await fixture()
		for (const path of ["/stream", "/stream.wav", "/unknown", "/health"]) {
			const denied = await open(env.port, {}, path)
			await denied.ended
			expect(denied.response.statusCode).toBe(401)
			expect(denied.response.headers["x-audio-format"]).toBeUndefined()
			expect(Buffer.concat(denied.chunks).toString()).toBe(
				'{"code":"AUTH_REQUIRED"}',
			)
		}
		expect(env.resolve).not.toHaveBeenCalled()
		expect(env.registry.size).toBe(0)
	})

	it.each(["bearer", "cookie"] as const)(
		"streams real WAV/PCM for %s with policy CORS",
		async kind => {
			const env = await fixture()
			const opened = await open(env.port, { ...env[kind], Origin: origin })
			expect(opened.response.statusCode).toBe(200)
			expect(opened.response.headers["access-control-allow-origin"]).toBe(
				origin,
			)
			expect(opened.response.headers["access-control-allow-credentials"]).toBe(
				"true",
			)
			expect(
				opened.response.headers["access-control-expose-headers"],
			).toContain("X-Audio-Format")
			expect(
				opened.response.headers["access-control-expose-headers"],
			).toContain("Retry-After")
			const pcm = Buffer.from([1, 2, 3, 4])
			env.registry.write(pcm)
			await vi.waitFor(() =>
				expect(Buffer.concat(opened.chunks).subarray(44)).toEqual(pcm),
			)
			expect(Buffer.concat(opened.chunks).subarray(0, 4).toString()).toBe(
				"RIFF",
			)
			opened.response.destroy()
			await vi.waitFor(() => expect(env.registry.size).toBe(0))
		},
	)

	it("handles preflight and denies foreign origins before the resolver", async () => {
		const env = await fixture()
		const preflight = await open(
			env.port,
			{ Origin: origin, "Access-Control-Request-Method": "GET" },
			"/stream",
			"OPTIONS",
		)
		await preflight.ended
		expect(preflight.response.statusCode).toBe(204)
		const denied = await open(env.port, {
			...env.bearer,
			Origin: "http://evil.local",
		})
		await denied.ended
		expect(denied.response.statusCode).toBe(403)
		expect(
			denied.response.headers["access-control-allow-origin"],
		).toBeUndefined()
		expect(env.resolve).not.toHaveBeenCalled()
	})

	it("closes browser clients on logout while preserving machine clients", async () => {
		const env = await fixture()
		const browser = await open(env.port, env.cookie)
		const machine = await open(env.port, env.bearer)
		await env.sessions.revoke(env.session.principalId)
		await browser.ended
		expect(env.registry.size).toBe(1)
		expect(machine.response.destroyed).toBe(false)
		machine.response.destroy()
		await vi.waitFor(() => expect(env.registry.size).toBe(0))
	})

	it("cleans a client assigned after synchronous invalidation in registry callbacks", async () => {
		const env = await fixture()
		const close = vi.spyOn(env.registry, "close")
		env.registry.once("client-connected", () => env.leases.dispose())
		// Headers may be destroyed before reaching the remote client.
		await open(env.port, env.cookie)
			.then(opened => opened.ended)
			.catch(() => undefined)
		await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
		expect(close.mock.calls[0]?.slice(1)).toEqual(["Access closed", true])
		expect(env.registry.size).toBe(0)
	})

	it("cuts admissions synchronously and restarts with a fresh guarded adapter and shared leases", async () => {
		const env = await fixture()
		const otherCleanup = vi.fn()
		const other = env.leases.attach(env.session.principalId, otherCleanup)
		const browser = await open(env.port, env.cookie)
		env.server.stopAdmission()
		await browser.ended
		expect(env.registry.size).toBe(0)
		expect(otherCleanup).not.toHaveBeenCalled()
		const denied = await open(env.port, env.bearer)
		await denied.ended
		expect(denied.response.statusCode).toBe(503)
		await env.server.close()
		await env.server.start(env.port, "127.0.0.1")
		const again = await open(env.port, env.cookie)
		expect(again.response.statusCode).toBe(200)
		again.response.destroy()
		await vi.waitFor(() => expect(env.registry.size).toBe(0))
		if (other.kind === "attached") other.lease.release()
		expect(env.leases.attach(env.session.principalId, otherCleanup).kind).toBe(
			"attached",
		)
	})

	it("permanently fences late restarts during composition shutdown", async () => {
		const env = await fixture()
		const browser = await open(env.port, env.cookie)
		env.server.shutdownAdmission()
		await browser.ended
		await expect(env.server.start(env.port, "127.0.0.1")).rejects.toMatchObject(
			{ code: "ACCESS_UNAVAILABLE" },
		)
		await env.server.close()
		await expect(env.server.start(env.port, "127.0.0.1")).rejects.toMatchObject(
			{ code: "ACCESS_UNAVAILABLE" },
		)
		expect(env.registry.size).toBe(0)
	})

	it("releases leases after normal registry completion and listener close", async () => {
		const env = await fixture()
		const opened = await open(env.port, env.cookie)
		env.registry.closeAll("complete", false)
		await opened.ended
		expect(env.registry.size).toBe(0)
		const next = await open(env.port, env.cookie)
		await env.server.close()
		await next.ended
		expect(env.registry.size).toBe(0)
	})
})
