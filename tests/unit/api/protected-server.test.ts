import { EventEmitter, once } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type {
	NamedAccessRuntimeContext,
	NamedAccessRuntimeOptions,
} from "../../../src/access/runtime-context.js"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { ActivityQueryBusyError } from "../../../src/core/activity/query/errors.js"
import { WaveKitError } from "../../../src/utils/errors.js"

const origin = "http://receiver.lan:9000"
const browser = { host: "receiver.lan:9000", origin }
const servers: ApiServer[] = []
const contexts: NamedAccessRuntimeContext[] = []
const roots: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const server of servers.splice(0)) await server.stop()
	for (const context of contexts.splice(0)) await context.close()
	for (const root of roots.splice(0))
		await fs.rm(root, { recursive: true, force: true })
})

function runtimeOptions(directory: string): NamedAccessRuntimeOptions {
	return {
		directory,
		ownership: "single-host-pid-namespace",
		bootstrap: {
			mode: "protected",
			listenerScheme: "http",
			allowedAuthorities: ["receiver.lan:9000"],
			allowedOrigins: [origin],
			externalAudioOrigins: [
				"http://receiver.lan:9001",
				"http://receiver.lan:9002",
			],
		},
		audio: {
			analog: {
				listenerScheme: "http",
				allowedAuthorities: ["receiver.lan:9001"],
			},
			digital: {
				listenerScheme: "http",
				allowedAuthorities: ["receiver.lan:9002"],
			},
		},
	}
}

async function setup() {
	const root = await fs.mkdtemp(join(tmpdir(), "wavekit-protected-server-"))
	roots.push(root)
	const directory = join(root, "private")
	const provisioned = await PrivateAccessStorage.open({
		directory,
		mode: "provision",
		ownership: "single-host-pid-namespace",
	})
	const token = provisioned.useMachineCredential(value => value)
	await provisioned.close()
	const context = await openAccessRuntime(runtimeOptions(directory))
	contexts.push(context)
	const logs: string[] = []
	const logger = pino(
		{ level: "trace" },
		{
			write: line => {
				logs.push(line)
			},
		},
	)
	const sourceManager = Object.assign(new EventEmitter(), {
		connect: vi.fn(),
		disconnect: vi.fn(),
		getStatus: vi.fn(),
		getAllStatus: vi.fn(() => []),
		getStream: vi.fn(),
		getSourceAssignments: vi.fn(() => []),
		isSourceAvailable: vi.fn(() => true),
		assignDecoder: vi.fn(),
		unassignDecoder: vi.fn(),
		getAssignedSource: vi.fn(),
		getCaps: vi.fn(),
		isCompatible: vi.fn(() => true),
	})
	const decoderManager = Object.assign(new EventEmitter(), {
		createDecoder: vi.fn(),
		startDecoder: vi.fn(),
		stopDecoder: vi.fn(),
		restartDecoder: vi.fn(),
		getDecoder: vi.fn(),
		getAllDecoders: vi.fn(() => []),
		getStatus: vi.fn(),
		getAllStatus: vi.fn(() => []),
		getAllHealth: vi.fn(() => new Map()),
	})
	const fanoutManager = Object.assign(new EventEmitter(), {
		attachSource: vi.fn(),
		detachSource: vi.fn(),
		addBranch: vi.fn(),
		removeBranch: vi.fn(),
		getBranchIds: vi.fn(() => []),
		getBranchStatus: vi.fn(),
		getBranchTelemetry: vi.fn(),
		getTelemetrySnapshot: vi.fn(() => ({
			timestamp: new Date().toISOString(),
			branches: [],
			backpressureActiveCount: 0,
			droppedBytesTotal: 0,
			droppedChunksTotal: 0,
		})),
		destroy: vi.fn(),
	})
	const audioOutput = Object.assign(new EventEmitter(), {
		start: vi.fn(),
		stop: vi.fn(),
		attachSource: vi.fn(),
		detachSource: vi.fn(),
		getConnectedClients: vi.fn(() => 0),
		getPort: vi.fn(() => 8080),
	})
	const dependencies: ApiServerDependencies = {
		access: context,
		logger,
		sourceManager:
			sourceManager as unknown as ApiServerDependencies["sourceManager"],
		decoderManager:
			decoderManager as unknown as ApiServerDependencies["decoderManager"],
		fanoutManager:
			fanoutManager as unknown as ApiServerDependencies["fanoutManager"],
		audioOutput: audioOutput as unknown as ApiServerDependencies["audioOutput"],
	}
	const server = new ApiServer(dependencies, {
		host: "127.0.0.1",
		port: 0,
		accessBootstrap: runtimeOptions(directory).bootstrap,
		publicOrigins: {
			api: origin,
			analogAudio: "http://receiver.lan:9001",
			digitalAudio: "http://receiver.lan:9002",
		},
	})
	servers.push(server)
	const app = server.getApp()
	const machine = { host: browser.host, authorization: `Bearer ${token}` }
	const pair = async () => {
		const issued = await app.inject({
			method: "POST",
			url: "/api/access/pairing-codes",
			headers: machine,
		})
		expect(issued.statusCode).toBe(201)
		const paired = await app.inject({
			method: "POST",
			url: "/api/access/pair",
			headers: browser,
			payload: { code: issued.json<{ code: string }>().code },
		})
		expect(paired.statusCode).toBe(201)
		const cookie = paired.headers["set-cookie"]
		if (typeof cookie !== "string") throw new Error("Missing cookie")
		const body = paired.json<{
			deviceId: string
			expiresAt: number
			csrfToken: string
		}>()
		return {
			body,
			cookie,
			headers: {
				...browser,
				cookie: cookie.split(";")[0] ?? "",
				"x-wavekit-csrf": body.csrfToken,
			},
		}
	}
	return {
		server,
		app,
		context,
		directory,
		token,
		logs,
		sourceManager,
		decoderManager,
		machine,
		pair,
	}
}

function address(server: ApiServer): string {
	const bound = server.getApp().addresses()[0]
	if (!bound) throw new Error("Missing listener")
	return `http://127.0.0.1:${bound.port}`
}

describe("actual protected ApiServer mount", () => {
	it("projects capabilities only after actual listener mount and never claims operator data", async () => {
		const env = await setup()
		expect(env.server.getAccessBootstrap()).toMatchObject({
			access: {
				mode: "protected",
				sessionAvailable: false,
				pairingAvailable: false,
			},
			capabilities: {
				analogAudioAvailable: false,
				digitalAudioAvailable: false,
				operatorDataAvailable: false,
			},
		})
		await env.server.start()
		expect(env.server.getAccessBootstrap()).toMatchObject({
			apiOrigin: origin,
			webSocketUrl: "ws://receiver.lan:9000/ws",
			analogAudioOrigin: "http://receiver.lan:9001",
			digitalAudioOrigin: "http://receiver.lan:9002",
			access: {
				mode: "protected",
				sessionAvailable: true,
				pairingAvailable: true,
			},
			capabilities: {
				analogAudioAvailable: false,
				digitalAudioAvailable: false,
				operatorDataAvailable: false,
			},
		})
		env.server.stopAdmission()
		expect(env.server.getAccessBootstrap()).toMatchObject({
			access: {
				mode: "protected",
				sessionAvailable: false,
				pairingAvailable: false,
			},
			capabilities: {
				operatorDataAvailable: false,
			},
		})
	})

	it("exposes Retry-After on a busy Activity 429 to the allowed browser origin", async () => {
		const env = await setup()
		env.app.get("/api/test-activity-busy", async () => {
			throw new ActivityQueryBusyError()
		})
		await env.server.start()
		const response = await env.app.inject({
			url: "/api/test-activity-busy",
			headers: { ...env.machine, origin },
		})
		expect(response.statusCode).toBe(429)
		expect(response.headers["retry-after"]).toBe("1")
		expect(response.headers["access-control-allow-origin"]).toBe(origin)
		expect(response.headers["access-control-expose-headers"]).toBe(
			"Retry-After",
		)
	})

	it("validates health Host and protects real status/source/docs/unknown handlers before side effects", async () => {
		const env = await setup()
		await env.server.start()
		expect(
			(
				await env.app.inject({
					url: "/health",
					headers: { host: browser.host },
				})
			).statusCode,
		).toBe(200)
		expect(
			(
				await env.app.inject({
					url: "/health",
					headers: { host: "receiver.lan:9001" },
				})
			).statusCode,
		).toBe(403)
		env.sourceManager.getAllStatus.mockClear()
		env.decoderManager.getAllStatus.mockClear()
		for (const url of [
			"/api/status",
			"/health/ready",
			"/docs",
			"/docs/json",
			"/api/sources",
			"/unknown",
		]) {
			const result = await env.app.inject({ url, headers: browser })
			expect(result.statusCode).toBe(401)
			expect(result.headers["access-control-allow-origin"]).toBe(origin)
		}
		const mutation = await env.app.inject({
			method: "POST",
			url: "/api/sources",
			headers: browser,
			payload: { id: "private", junk: "x".repeat(10000) },
		})
		expect(mutation.statusCode).toBe(401)
		expect(env.sourceManager.connect).not.toHaveBeenCalled()
		expect(env.sourceManager.getAllStatus).not.toHaveBeenCalled()
		expect(env.decoderManager.getAllStatus).not.toHaveBeenCalled()
		const hostile = await env.app.inject({
			url: "/api/status",
			headers: { ...env.machine, origin: "http://evil.invalid" },
		})
		expect(hostile.statusCode).toBe(403)
		expect(hostile.headers["access-control-allow-origin"]).toBeUndefined()
	})

	it("pairs through mounted services with exact CORS and requires CSRF for stable-cookie refresh/logout", async () => {
		const env = await setup()
		await env.server.start()
		const preflight = await env.app.inject({
			method: "OPTIONS",
			url: "/api/access/session/refresh",
			headers: {
				...browser,
				"access-control-request-method": "POST",
				"access-control-request-headers": "x-wavekit-csrf",
			},
		})
		expect(preflight.statusCode).toBe(204)
		expect(preflight.headers["access-control-allow-credentials"]).toBe("true")
		const paired = await env.pair()
		expect(paired.cookie).toContain("HttpOnly; SameSite=Strict")
		const status = await env.app.inject({
			url: "/api/access/session",
			headers: paired.headers,
		})
		expect(status.statusCode).toBe(200)
		expect(status.json()).toEqual(paired.body)
		const noCsrf = await env.app.inject({
			method: "POST",
			url: "/api/access/session/refresh",
			headers: { ...paired.headers, "x-wavekit-csrf": "wrong" },
		})
		expect(noCsrf.statusCode).toBe(403)
		const renewed = await env.app.inject({
			method: "POST",
			url: "/api/access/session/refresh",
			headers: paired.headers,
		})
		expect(renewed.statusCode).toBe(200)
		expect(renewed.headers["set-cookie"]).toBe(paired.cookie)
		const logout = await env.app.inject({
			method: "POST",
			url: "/api/access/session/logout",
			headers: paired.headers,
		})
		expect(logout.statusCode).toBe(200)
		expect(logout.headers["set-cookie"]).toContain("Max-Age=0")
		expect(
			(
				await env.app.inject({
					url: "/api/access/session",
					headers: paired.headers,
				})
			).statusCode,
		).toBe(401)
		expect(
			(await env.app.inject({ url: "/api/status", headers: env.machine }))
				.statusCode,
		).toBe(200)
	})

	it("revokes an actual server WebSocket through mounted logout", async () => {
		const env = await setup()
		await env.server.start()
		const paired = await env.pair()
		const socket = new WebSocket(
			address(env.server).replace("http:", "ws:") + "/ws",
			{ headers: paired.headers },
		)
		await once(socket, "open")
		const message = once(socket, "message")
		socket.send(JSON.stringify({ type: "subscribe", channels: ["decoders"] }))
		await message
		const closed = once(socket, "close")
		const logout = await env.app.inject({
			method: "POST",
			url: "/api/access/session/logout",
			headers: paired.headers,
		})
		expect(logout.statusCode).toBe(200)
		expect((await closed)[0]).toBe(1008)
	})

	it("gates all new admissions synchronously when the server stops admission", async () => {
		const env = await setup()
		await env.server.start()
		env.server.stopAdmission()
		for (const url of ["/health", "/api/status", "/api/access/session"])
			expect(
				(await env.app.inject({ url, headers: env.machine })).statusCode,
			).toBe(503)
		const pair = await env.app.inject({
			method: "POST",
			url: "/api/access/pair",
			headers: browser,
			payload: { code: "00000-00000" },
		})
		expect(pair.statusCode).toBe(503)
		expect(pair.headers["access-control-allow-origin"]).toBe(origin)
	})

	it("keeps private URL/error/header values out of response bodies and captured logs", async () => {
		const env = await setup()
		const secret = "private-credential-marker"
		env.app.get("/test-error", async () => {
			throw new WaveKitError(`${secret} ${env.directory}`, "TEST_FAILURE")
		})
		await env.server.start()
		const unknown = await env.app.inject({
			url: `/unknown?credential=${secret}`,
			headers: { ...env.machine, "x-correlation-id": `${secret};invalid` },
		})
		expect(unknown.statusCode).toBe(404)
		expect(unknown.body).not.toContain(secret)
		expect(unknown.headers["x-correlation-id"]).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
		const error = await env.app.inject({
			url: `/test-error?credential=${secret}`,
			headers: { ...env.machine, "x-correlation-id": "safe-id" },
		})
		expect(error.statusCode).toBe(400)
		expect(error.json()).toMatchObject({
			code: "TEST_FAILURE",
			message: "Request failed",
			correlationId: "safe-id",
		})
		const output = env.logs.join("")
		for (const value of [secret, env.token, env.directory]) {
			expect(output).not.toContain(value)
			expect(error.body).not.toContain(value)
		}
	})

	it("server stop waits for actual durable refresh before private runtime ownership can close", async () => {
		const env = await setup()
		await env.server.start()
		const paired = await env.pair()
		let release = () => {}
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		let entered = () => {}
		const persisting = new Promise<void>(resolve => {
			entered = resolve
		})
		const rename = fs.rename
		vi.spyOn(fs, "rename").mockImplementationOnce(async (oldPath, newPath) => {
			entered()
			await gate
			await rename(oldPath, newPath)
		})
		const pending = env.app.inject({
			method: "POST",
			url: "/api/access/session/refresh",
			headers: paired.headers,
		})
		await persisting
		let stopped = false
		const stopping = env.server.stop().then(() => {
			stopped = true
		})
		try {
			await Promise.resolve()
			expect(stopped).toBe(false)
			expect(
				(await env.app.inject({ url: "/health", headers: env.machine }))
					.statusCode,
			).toBe(503)
			await expect(
				PrivateAccessStorage.open({
					directory: env.directory,
					mode: "load",
					ownership: "single-host-pid-namespace",
				}),
			).rejects.toMatchObject({ code: "ACCESS_STORAGE_BUSY" })
		} finally {
			release()
		}
		expect((await pending).statusCode).toBe(200)
		await stopping
		expect(stopped).toBe(true)
		expect(
			env.context.api.sessions.lookupByPrincipal(paired.body.deviceId),
		).toBeDefined()
	})
})
