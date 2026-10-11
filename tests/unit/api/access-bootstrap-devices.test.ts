import { EventEmitter } from "node:events"
import { Socket } from "node:net"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import type { FastifyListenOptions } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	ACCESS_BOOTSTRAP_LIMITS,
	accessBootstrapDtoSchema,
} from "@wavekit/api-types"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type {
	NamedAccessRuntimeContext,
	NamedAccessRuntimeOptions,
} from "../../../src/access/runtime-context.js"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { OperatorDataService } from "../../../src/operator-data/service.js"
import { WaveKitError } from "../../../src/utils/errors.js"

const origin = "http://receiver.lan:9000"
const browser = { host: "receiver.lan:9000", origin }
const servers: ApiServer[] = []
const contexts: NamedAccessRuntimeContext[] = []
const roots: string[] = []
const services: OperatorDataService[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const server of servers.splice(0)) await server.stop()
	for (const service of services.splice(0)) await service.close()
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

async function setup(
	options: { legacy?: boolean; mapping?: boolean; operator?: boolean } = {},
) {
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
	const analog = { running: false }
	const digital = { running: false }
	const dependencies: ApiServerDependencies = {
		...(options.legacy ? {} : { access: context }),
		logger,
		liveDemod: {
			getStatus: () => analog,
		} as unknown as ApiServerDependencies["liveDemod"],
		digitalVoice: {
			getStatus: () => digital,
		} as unknown as ApiServerDependencies["digitalVoice"],
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
		...(options.mapping === false
			? {}
			: {
					publicOrigins: {
						api: origin,
						analogAudio: "http://receiver.lan:9001",
						digitalAudio: "http://receiver.lan:9002",
					},
				}),
	})
	servers.push(server)
	let operator: OperatorDataService | undefined
	if (options.operator) {
		operator = await OperatorDataService.open({ stateDir: root })
		services.push(operator)
		server.mountOperatorData(operator)
	}
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
		analog,
		digital,
		operator,
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

// Raw sockets prove HEAD sends zero bytes after CRLFCRLF; unlike inject() or an
// HTTP client's HEAD parser they do not suppress body bytes on our behalf.
async function wire(
	server: ApiServer,
	method = "GET",
	target = "/api/access/bootstrap",
	headers: readonly string[] = ["Host", browser.host, "Origin", origin],
) {
	const bound = server.getApp().addresses()[0]
	if (!bound) throw new Error("Missing listener")
	return await new Promise<{
		status: number
		headers: Record<string, string>
		body: string
	}>((resolve, reject) => {
		const socket = new Socket()
		const chunks: Buffer[] = []
		socket.setTimeout(2000, () =>
			socket.destroy(new Error("Wire request timeout")),
		)
		socket.on("error", reject)
		socket.on("data", (chunk: Buffer) => chunks.push(chunk))
		socket.on("end", () => {
			const bytes = Buffer.concat(chunks)
			const split = bytes.indexOf("\r\n\r\n")
			if (split < 0) {
				reject(new Error("Missing HTTP headers"))
				return
			}
			const lines = bytes.subarray(0, split).toString("ascii").split("\r\n")
			const status = Number(lines.shift()?.split(" ")[1])
			const responseHeaders: Record<string, string> = {}
			for (const line of lines) {
				const colon = line.indexOf(":")
				if (colon > 0)
					responseHeaders[line.slice(0, colon).toLowerCase()] = line
						.slice(colon + 1)
						.trim()
			}
			resolve({
				status,
				headers: responseHeaders,
				body: bytes.subarray(split + 4).toString("utf8"),
			})
		})
		socket.connect(bound.port, "127.0.0.1", () => {
			const explicitConnection = headers.some(
				(name, i) => i % 2 === 0 && name.toLowerCase() === "connection",
			)
			let request = `${method} ${target} HTTP/1.1\r\n${explicitConnection ? "" : "Connection: close\r\n"}`
			for (let i = 0; i < headers.length; i += 2)
				request += `${headers[i]}: ${headers[i + 1]}\r\n`
			socket.write(request + "\r\n")
		})
	})
}

function assertParity(
	get: Awaited<ReturnType<typeof wire>>,
	head: Awaited<ReturnType<typeof wire>>,
) {
	expect(head.status).toBe(get.status)
	for (const name of [
		"content-type",
		"content-length",
		"cache-control",
		"vary",
		"access-control-allow-origin",
		"access-control-allow-credentials",
	])
		expect(head.headers[name]).toBe(get.headers[name])
	expect(head.body).toBe("")
}

describe("assembled ApiServer protected bootstrap (A3 bootstrap only)", () => {
	it("publishes one strict bounded DTO on the real listener without reading/writing session authority", async () => {
		const env = await setup()
		await env.server.start()
		const paired = await env.pair()
		const before = await fs.readFile(join(env.directory, "access-state.json"))
		const snapshot = env.context.api.sessions.exportSnapshot()
		const lookup = vi.spyOn(env.context.api.sessions, "lookup")
		const ordinary = vi.spyOn(env.context.api.policy, "evaluate")
		const headers = [
			"Host",
			browser.host,
			"Origin",
			origin,
			"Authorization",
			"Basic invalid",
			"Cookie",
			paired.headers.cookie,
		]
		const get = await wire(env.server, "GET", undefined, headers)
		const head = await wire(env.server, "HEAD", undefined, headers)
		expect(get.status).toBe(200)
		const dto: unknown = JSON.parse(get.body)
		expect(typeof dto).toBe("object")
		expect(accessBootstrapDtoSchema.safeParse(dto).success).toBe(true)
		expect(dto).toEqual(env.server.getAccessBootstrap())
		expect(Buffer.byteLength(get.body)).toBeLessThanOrEqual(
			ACCESS_BOOTSTRAP_LIMITS.bodyBytes,
		)
		expect(get.headers["set-cookie"]).toBeUndefined()
		expect(get.body).not.toContain(env.token)
		expect(get.body).not.toContain(paired.body.deviceId)
		expect(get.body).not.toContain(paired.headers.cookie)
		assertParity(get, head)
		const noOrigin = await wire(env.server, "GET", undefined, [
			"Host",
			browser.host,
		])
		expect(noOrigin.status).toBe(200)
		expect(JSON.parse(noOrigin.body)).toEqual(dto)
		expect(noOrigin.headers["access-control-allow-origin"]).toBeUndefined()
		expect(lookup).not.toHaveBeenCalled()
		expect(ordinary).not.toHaveBeenCalled()
		expect(env.context.api.sessions.exportSnapshot()).toEqual(snapshot)
		expect(await fs.readFile(join(env.directory, "access-state.json"))).toEqual(
			before,
		)
		const protectedStatus = await wire(env.server, "GET", "/api/status")
		expect(protectedStatus.status).toBe(401)
	})

	it("keeps legacy absence distinct from protected missing mapping with normal admission precedence", async () => {
		for (const options of [{ legacy: true }, { mapping: false }]) {
			const env = await setup(options)
			await env.server.start()
			const noCredential = await wire(env.server)
			const invalid = await wire(env.server, "GET", undefined, [
				"Host",
				browser.host,
				"Authorization",
				"Basic wrong",
			])
			const valid = await wire(env.server, "GET", undefined, [
				"Host",
				browser.host,
				"Authorization",
				`Bearer ${env.token}`,
			])
			expect(noCredential.status).toBe(options.legacy ? 404 : 401)
			expect(invalid.status).toBe(options.legacy ? 404 : 401)
			expect(valid.status).toBe(404)
			const absentHeads = [
				await wire(env.server, "HEAD"),
				await wire(env.server, "HEAD", undefined, [
					"Host",
					browser.host,
					"Authorization",
					"Basic wrong",
				]),
				await wire(env.server, "HEAD", undefined, [
					"Host",
					browser.host,
					"Authorization",
					`Bearer ${env.token}`,
				]),
			]
			for (const [index, get] of [noCredential, invalid, valid].entries()) {
				const head = absentHeads[index]
				if (!head) throw new Error("Missing HEAD response")
				if (options.legacy) {
					// Ordinary legacy 404 includes the method in its message; HEAD is
					// one byte longer than GET, with no protected-header parity promise.
					expect(head.status).toBe(404)
					expect(head.body).toBe("")
					expect(head.headers["content-type"]).toBe(get.headers["content-type"])
					expect(Number(head.headers["content-length"])).toBe(
						Number(get.headers["content-length"]) + 1,
					)
				} else assertParity(get, head)
			}
			if (!options.legacy) {
				const foreign = await wire(env.server, "GET", undefined, [
					"Host",
					"evil.lan:9000",
				])
				expect(foreign.status).toBe(403)
				const duplicate = await wire(env.server, "GET", undefined, [
					"Host",
					browser.host,
					"Authorization",
					"one",
					"Authorization",
					"two",
				])
				expect(duplicate.status).toBe(400)
				await env.context.close()
				await expect(env.context.api.sessions.create()).rejects.toMatchObject({
					code: "ACCESS_UNAVAILABLE",
				})
				expect((await wire(env.server)).status).toBe(503)
				expect(
					(
						await wire(env.server, "GET", undefined, [
							"Host",
							browser.host,
							"Authorization",
							`Bearer ${env.token}`,
						])
					).status,
				).toBe(404)
			}
		}
	})

	it("holds public readiness until the actual listen promise settles, then advertises current flags", async () => {
		const env = await setup()
		let announce = () => {}
		const listening = new Promise<void>(resolve => {
			announce = resolve
		})
		let release = () => {}
		const barrier = new Promise<void>(resolve => {
			release = resolve
		})
		const original = env.app.listen.bind(env.app)
		// ApiServer calls the Promise overload, never the callback overload.
		const delayed = ((options: FastifyListenOptions) =>
			original(options).then(async address => {
				announce()
				await barrier
				return address
			})) as typeof env.app.listen
		env.app.listen = delayed
		const startup = env.server.start()
		try {
			await listening
			const get = await wire(env.server)
			const head = await wire(env.server, "HEAD")
			expect(get.status).toBe(503)
			expect(JSON.parse(get.body)).toEqual({ code: "ACCESS_UNAVAILABLE" })
			assertParity(get, head)
		} finally {
			release()
			await startup
			env.app.listen = original
		}
		expect((await wire(env.server)).status).toBe(200)
	})

	it("sanitizes provider faults through poisoned inherited serializers and global error mapping", async () => {
		const env = await setup()
		env.app.addHook("preHandler", async (_request, reply) => {
			reply.serializer(() => JSON.stringify({ secret: "inherited poison" }))
		})
		await env.server.start()
		const healthy = await wire(env.server)
		expect(
			accessBootstrapDtoSchema.safeParse(JSON.parse(healthy.body)).success,
		).toBe(true)
		for (const fault of ["missing", "throw", "malformed"] as const) {
			const spy = vi.spyOn(env.server, "getAccessBootstrap")
			if (fault === "missing") spy.mockReturnValue(null)
			else if (fault === "throw")
				spy.mockImplementation(() => {
					throw new WaveKitError("secret disk path", "PRIVATE_FAULT")
				})
			else {
				const value = healthy.body
				spy.mockReturnValue({
					...(JSON.parse(value) as NonNullable<
						ReturnType<ApiServer["getAccessBootstrap"]>
					>),
					webSocketUrl: "ws://foreign.lan/ws",
				})
			}
			try {
				const get = await wire(env.server)
				const head = await wire(env.server, "HEAD")
				expect(get.status).toBe(503)
				expect(JSON.parse(get.body)).toEqual({ code: "ACCESS_UNAVAILABLE" })
				expect(get.body).not.toContain("secret")
				assertParity(get, head)
			} finally {
				spy.mockRestore()
			}
		}
	})

	it("preserves independent running audio/operator flags when the real session store latches unavailable", async () => {
		const env = await setup({ operator: true })
		await env.server.start()
		env.analog.running = true
		env.digital.running = false
		const initial = await wire(env.server)
		expect(JSON.parse(initial.body)).toMatchObject({
			access: { sessionAvailable: true, pairingAvailable: true },
			capabilities: {
				analogAudioAvailable: true,
				digitalAudioAvailable: false,
				operatorDataAvailable: true,
			},
		})
		await env.context.close()
		await expect(env.context.api.sessions.create()).rejects.toMatchObject({
			code: "ACCESS_UNAVAILABLE",
		})
		const unavailable = await wire(env.server)
		expect(unavailable.status).toBe(200)
		expect(JSON.parse(unavailable.body)).toMatchObject({
			access: { sessionAvailable: false, pairingAvailable: false },
			capabilities: {
				analogAudioAvailable: true,
				digitalAudioAvailable: false,
				operatorDataAvailable: true,
			},
		})
		if (!env.operator) throw new Error("Missing operator fixture")
		await env.operator.close()
		expect(JSON.parse((await wire(env.server)).body)).toMatchObject({
			capabilities: { operatorDataAvailable: false },
		})
	})

	it("excludes unauthenticated and authenticated normalized targets, methods and upgrades from DTO delivery", async () => {
		const env = await setup()
		await env.server.start()
		for (const target of [
			"/api/access/bootstrap?x=1",
			"/api/access/bootstrap/",
			"/api/access/%62ootstrap",
			"/prefix/api/access/bootstrap",
			"/api/access/../access/bootstrap",
		]) {
			const ordinary = await wire(env.server, "GET", target)
			expect(ordinary.status).toBe(401)
			const valid = await wire(env.server, "GET", target, [
				"Host",
				browser.host,
				"Authorization",
				`Bearer ${env.token}`,
			])
			expect([400, 404]).toContain(valid.status)
			expect(valid.body).not.toContain("apiOrigin")
		}
		for (const extra of [
			[],
			[
				"Connection",
				"Upgrade",
				"Upgrade",
				"websocket",
				"Sec-WebSocket-Version",
				"13",
				"Sec-WebSocket-Key",
				"dGhlIHNhbXBsZSBub25jZQ==",
			],
		]) {
			const method = extra.length ? "GET" : "POST"
			const result = await wire(env.server, method, undefined, [
				"Host",
				browser.host,
				"Authorization",
				`Bearer ${env.token}`,
				...extra,
			])
			expect([400, 404]).toContain(result.status)
			expect(result.body).not.toContain("apiOrigin")
		}
		const preflight = await wire(env.server, "OPTIONS", undefined, [
			"Host",
			browser.host,
			"Origin",
			origin,
			"Access-Control-Request-Method",
			"GET",
		])
		expect(preflight.status).toBe(204)
		expect(preflight.body).toBe("")
	})

	it("checks raw duplicate security headers and real GET/HEAD denial parity before provider access", async () => {
		const env = await setup()
		await env.server.start()
		const provider = vi.spyOn(env.server, "getAccessBootstrap")
		for (const headers of [
			["Host", browser.host, "host", browser.host],
			["Host", browser.host, "Authorization", "one", "authorization", "two"],
			["Host", browser.host, "Origin", origin, "origin", origin],
			["Host", browser.host, "Cookie", "wavekit_session=a; wavekit_session=b"],
			["Host", browser.host, "Cookie", "malformed"],
		]) {
			const get = await wire(env.server, "GET", undefined, headers)
			const head = await wire(env.server, "HEAD", undefined, headers)
			expect(get.status).toBe(400)
			assertParity(get, head)
		}
		for (const headers of [
			["Host", "evil.lan:9000"],
			["Host", browser.host, "Origin", "http://evil.lan"],
		]) {
			const get = await wire(env.server, "GET", undefined, headers)
			const head = await wire(env.server, "HEAD", undefined, headers)
			expect(get.status).toBe(403)
			assertParity(get, head)
		}
		expect(provider).not.toHaveBeenCalled()
		env.server.stopAdmission()
		const get = await wire(env.server)
		const head = await wire(env.server, "HEAD")
		expect(get.status).toBe(503)
		expect(JSON.parse(get.body)).toEqual({ code: "ACCESS_UNAVAILABLE" })
		assertParity(get, head)
		expect(provider).not.toHaveBeenCalled()
	})
})
