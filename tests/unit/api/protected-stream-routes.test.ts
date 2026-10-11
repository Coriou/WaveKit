import type * as NodeFs from "node:fs"
import { once } from "node:events"
import { request as httpRequest } from "node:http"
import { PassThrough } from "node:stream"
import Fastify from "fastify"
import websocket from "@fastify/websocket"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConnectionLeases } from "../../../src/access/connection-leases.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { installAccessHooks } from "../../../src/access/fastify-adapter.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"
import { scannerRoutes } from "../../../src/api/routes/scanner.js"
import type { ScannerRouteService } from "../../../src/api/routes/scanner.js"
import { WebSocketEventBroadcaster } from "../../../src/api/websocket/events.js"
import { createLogger } from "../../../src/utils/logger.js"

const { readStream } = vi.hoisted(() => ({ readStream: vi.fn() }))
vi.mock("node:fs", async importOriginal => ({
	...(await importOriginal<typeof NodeFs>()),
	createReadStream: readStream,
}))
const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => {
	await Promise.all(apps.splice(0).map(app => app.close()))
	vi.restoreAllMocks()
	readStream.mockReset()
})

async function setup(maxConnections = 512) {
	const digest = digestMachineToken(generateMachineToken())
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: async () => {},
	})
	const policy = new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: ["receiver.lan:9000"],
		allowedOrigins: ["http://receiver.lan:9000"],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
	const app = Fastify({ logger: false })
	apps.push(app)
	const leases = new ConnectionLeases(sessions, { maxConnections })
	const access = installAccessHooks(app, { policy, sessions, leases })
	app.addHook("onClose", async () => leases.dispose())
	const session = await sessions.create()
	if (session.kind !== "created") throw new Error("Missing session")
	const headers = {
		host: "receiver.lan:9000",
		origin: "http://receiver.lan:9000",
		cookie: `wavekit_session=${session.cookieValue}`,
	}
	return { app, sessions, access, session, headers }
}

function scanner(overrides: Partial<ScannerRouteService> = {}) {
	return {
		recordingPath: vi.fn(() => "/private/recording.wav"),
		evidencePath: vi.fn(async () => "/private/evidence.json"),
		capturePath: vi.fn(() => "/private/capture.cu8"),
		...overrides,
	} as unknown as ScannerRouteService
}

const downloads = [
	"/api/scanner/recordings/d_abc~sample.wav",
	"/api/scanner/discoveries/d_abc/evidence/psd",
	"/api/scanner/discoveries/d_abc/evidence/iq",
	"/api/scanner/captures/cap_abc.cu8",
	"/api/scanner/captures/cap_abc.json",
]

function beginDownload(
	address: string,
	path: string,
	headers: Record<string, string>,
) {
	const request = httpRequest(address + path, { headers })
	const completed = new Promise<void>(resolve => {
		request.once("error", () => resolve())
		request.once("response", response => {
			response.resume()
			response.once("end", () => resolve())
			response.once("close", () => resolve())
		})
	})
	request.end()
	return completed
}

describe("protected mounted stream routes", () => {
	it("denies every download before lookup/producer creation", async () => {
		const env = await setup()
		const service = scanner()
		await env.app.register(scannerRoutes, {
			scanner: service,
			access: env.access,
		})
		for (const url of downloads) {
			const result = await env.app.inject({
				url,
				headers: {
					host: "receiver.lan:9000",
					origin: "http://receiver.lan:9000",
				},
			})
			expect(result.statusCode).toBe(401)
		}
		expect(service.recordingPath).not.toHaveBeenCalled()
		expect(service.evidencePath).not.toHaveBeenCalled()
		expect(service.capturePath).not.toHaveBeenCalled()
		expect(readStream).not.toHaveBeenCalled()
	})

	it("revocation while asynchronous evidence lookup waits prevents late producer/headers", async () => {
		const env = await setup()
		let release = () => {}
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		let entered = () => {}
		const started = new Promise<void>(resolve => {
			entered = resolve
		})
		const service = scanner({
			evidencePath: vi.fn(async () => {
				entered()
				await gate
				return "/private/evidence.json"
			}),
		})
		await env.app.register(scannerRoutes, {
			scanner: service,
			access: env.access,
		})
		const address = await env.app.listen({ host: "127.0.0.1", port: 0 })
		const finished = beginDownload(
			address,
			"/api/scanner/discoveries/d_abc/evidence/psd",
			env.headers,
		)
		await started
		await env.sessions.revoke(env.session.principalId)
		release()
		await finished
		await vi.waitFor(() => expect(service.evidencePath).toHaveBeenCalledOnce())
		expect(readStream).not.toHaveBeenCalled()
	})

	it("destroys a producer constructed during synchronous transport invalidation", async () => {
		const env = await setup()
		const stream = new PassThrough()
		readStream.mockImplementationOnce(() => {
			env.access.dispose()
			return stream
		})
		await env.app.register(scannerRoutes, {
			scanner: scanner(),
			access: env.access,
		})
		const address = await env.app.listen({ host: "127.0.0.1", port: 0 })
		await beginDownload(
			address,
			"/api/scanner/recordings/d_abc~sample.wav",
			env.headers,
		)
		expect(readStream).toHaveBeenCalledOnce()
		expect(stream.destroyed).toBe(true)
	})

	it("releases failed lookups after readable denials and permits later download at capacity one", async () => {
		const env = await setup(1)
		const lookup = vi.fn<ScannerRouteService["evidencePath"]>()
		lookup
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(
				new Error("private credential or filesystem detail"),
			)
			.mockResolvedValueOnce("/private/evidence.json")
		await env.app.register(scannerRoutes, {
			scanner: scanner({ evidencePath: lookup }),
			access: env.access,
		})
		const missing = await env.app.inject({
			url: "/api/scanner/discoveries/d_abc/evidence/psd",
			headers: env.headers,
		})
		expect(missing.statusCode).toBe(404)
		const failed = await env.app.inject({
			url: "/api/scanner/discoveries/d_abc/evidence/psd",
			headers: env.headers,
		})
		expect(failed.statusCode).toBe(503)
		expect(failed.body).not.toContain("private")
		readStream.mockImplementationOnce(() => {
			const stream = new PassThrough()
			stream.end('{"ok":true}')
			return stream
		})
		const success = await env.app.inject({
			url: "/api/scanner/discoveries/d_abc/evidence/psd",
			headers: env.headers,
		})
		expect(success.statusCode).toBe(200)
		expect(success.json()).toEqual({ ok: true })
	})

	it("adopts the original WebSocket request before registering and cleans subscriptions on revoke", async () => {
		const env = await setup()
		const broadcaster = new WebSocketEventBroadcaster(
			createLogger({ level: "fatal" }),
		)
		const unsubscribed = vi.fn()
		broadcaster.observeChannel("scanner", { subscribed: vi.fn(), unsubscribed })
		const adopt = vi.spyOn(env.access, "adoptWebSocket")
		await env.app.register(websocket)
		broadcaster.registerRoute(env.app, env.access)
		const address = await env.app.listen({ host: "127.0.0.1", port: 0 })
		const socket = new WebSocket(address.replace("http:", "ws:") + "/ws", {
			headers: env.headers,
		})
		await once(socket, "open")
		const subscribed = once(socket, "message")
		socket.send(JSON.stringify({ type: "subscribe", channels: ["scanner"] }))
		await subscribed
		expect(broadcaster.getConnectedClients()).toBe(1)
		expect(adopt).toHaveBeenCalledOnce()
		expect(adopt.mock.calls[0]?.[0].raw.headers.cookie).toBe(env.headers.cookie)
		const closed = once(socket, "close")
		await env.sessions.revoke(env.session.principalId)
		expect((await closed)[0]).toBe(1008)
		await vi.waitFor(() => expect(broadcaster.getConnectedClients()).toBe(0))
		expect(unsubscribed).toHaveBeenCalledOnce()
		broadcaster.closeAll()
	})

	it("never registers a WebSocket when admission stops after root reservation", async () => {
		const env = await setup()
		const broadcaster = new WebSocketEventBroadcaster(
			createLogger({ level: "fatal" }),
		)
		env.app.addHook("preHandler", async () => env.access.stopAdmission())
		await env.app.register(websocket)
		broadcaster.registerRoute(env.app, env.access)
		const address = await env.app.listen({ host: "127.0.0.1", port: 0 })
		const socket = new WebSocket(address.replace("http:", "ws:") + "/ws", {
			headers: env.headers,
		})
		socket.on("error", () => {})
		await once(socket, "close")
		expect(broadcaster.getConnectedClients()).toBe(0)
	})
})
