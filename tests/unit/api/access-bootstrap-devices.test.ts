import { EventEmitter } from "node:events"
import { Socket } from "node:net"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import type { FastifyListenOptions, FastifyRequest } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	ACCESS_BOOTSTRAP_LIMITS,
	accessBootstrapDtoSchema,
	accessDevicesDtoSchema,
} from "@wavekit/api-types"
import { SessionStore } from "../../../src/access/sessions.js"
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
const deviceAuthorityCleanups: (() => void)[] = []
afterEach(async () => {
	// Release test-only persistence ownership before real server/flow shutdown drains.
	for (const cleanup of deviceAuthorityCleanups.splice(0)) cleanup()
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

describe("assembled ApiServer session-only devices (A3 devices)", () => {
	it("returns committed ID/clock metadata on the real listener with GET/HEAD parity and no read writes", async () => {
		const env = await setup()
		await env.server.start()
		const first = await env.pair()
		const second = await env.pair()
		const before = await fs.readFile(join(env.directory, "access-state.json"))
		const privateBefore = env.context.api.sessions.exportSnapshot()
		const headers = [
			"Host",
			browser.host,
			"Origin",
			origin,
			"Cookie",
			first.headers.cookie,
		]
		const get = await wire(env.server, "GET", "/api/access/devices", headers)
		const head = await wire(env.server, "HEAD", "/api/access/devices", headers)
		assertParity(get, head)
		expect(get.status).toBe(200)
		const dto = accessDevicesDtoSchema.parse(JSON.parse(get.body) as unknown)
		expect(dto.devices).toHaveLength(2)
		expect(
			dto.devices.filter(row => row.current).map(row => row.deviceId),
		).toEqual([first.body.deviceId])
		expect(dto.devices.some(row => row.deviceId === second.body.deviceId)).toBe(
			true,
		)
		for (const row of dto.devices) {
			// WG2 access amendment 4.9, 4.12: labels start null; lastSeenAt is an hour or null.
			expect(Object.keys(row).sort()).toEqual([
				"createdAt",
				"current",
				"deviceId",
				"expiresAt",
				"kind",
				"lastSeenAt",
				"name",
				"renewedAt",
			])
			expect(row.name).toBeNull()
			expect(row.kind).toBeNull()
			if (row.lastSeenAt !== null && row.lastSeenAt !== undefined)
				expect(row.lastSeenAt % 3_600_000).toBe(0)
		}
		expect(get.headers["cache-control"]).toBe("no-store")
		expect(get.headers["set-cookie"]).toBeUndefined()
		expect(await fs.readFile(join(env.directory, "access-state.json"))).toEqual(
			before,
		)
		expect(env.context.api.sessions.exportSnapshot()).toEqual(privateBefore)
	})

	it("has real-wire session-only, Host/Origin, unavailable and sealed HEAD denial parity", async () => {
		const env = await setup()
		await env.server.start()
		const paired = await env.pair()
		const cases: { headers: string[]; status: number }[] = [
			{ headers: ["Host", browser.host, "Origin", origin], status: 401 },
			{
				headers: [
					"Host",
					browser.host,
					"Authorization",
					`Bearer ${env.token}`,
					"Cookie",
					paired.headers.cookie,
				],
				status: 403,
			},
			{
				headers: ["Host", "foreign.invalid", "Cookie", paired.headers.cookie],
				status: 403,
			},
			{
				headers: [
					"Host",
					browser.host,
					"Origin",
					"http://foreign.invalid",
					"Cookie",
					paired.headers.cookie,
				],
				status: 403,
			},
		]
		for (const test of cases) {
			const get = await wire(
				env.server,
				"GET",
				"/api/access/devices",
				test.headers,
			)
			const head = await wire(
				env.server,
				"HEAD",
				"/api/access/devices",
				test.headers,
			)
			assertParity(get, head)
			expect(get.status).toBe(test.status)
			expect(get.body).not.toContain("devices")
		}
		const headers = [
			"Host",
			browser.host,
			"Origin",
			origin,
			"Cookie",
			paired.headers.cookie,
		]
		const spy = vi
			.spyOn(env.context.api.sessions, "snapshotActiveDevices")
			.mockImplementation(() => {
				throw new Error("private state path")
			})
		const fault = await wire(env.server, "GET", "/api/access/devices", headers)
		assertParity(
			fault,
			await wire(env.server, "HEAD", "/api/access/devices", headers),
		)
		expect(fault.status).toBe(503)
		expect(JSON.parse(fault.body)).toEqual({ code: "ACCESS_UNAVAILABLE" })
		spy.mockRestore()
		env.server.stopAdmission()
		const sealed = await wire(env.server, "GET", "/api/access/devices", headers)
		assertParity(
			sealed,
			await wire(env.server, "HEAD", "/api/access/devices", headers),
		)
		expect(sealed.status).toBe(503)
	})

	it("does not expose inventory through authenticated normalized paths, duplicate headers or upgrade interception", async () => {
		const env = await setup()
		await env.server.start()
		const paired = await env.pair()
		const headers = [
			"Host",
			browser.host,
			"Origin",
			origin,
			"Cookie",
			paired.headers.cookie,
		]
		for (const target of [
			"/api/access/devices?x=1",
			"/api/access/devices/",
			"/api/access/%64evices",
			"/api/access/../access/devices",
		]) {
			const result = await wire(env.server, "GET", target, headers)
			expect([400, 404]).toContain(result.status)
			expect(result.body).not.toContain("createdAt")
		}
		const duplicate = await wire(env.server, "GET", "/api/access/devices", [
			...headers,
			"Cookie",
			paired.headers.cookie,
		])
		expect(duplicate.status).toBe(400)
		const upgrade = await wire(env.server, "GET", "/api/access/devices", [
			...headers,
			"Connection",
			"Upgrade",
			"Upgrade",
			"websocket",
			"Sec-WebSocket-Version",
			"13",
			"Sec-WebSocket-Key",
			"dGhlIHNhbXBsZSBub25jZQ==",
		])
		expect(upgrade.status).toBe(400)
		expect(upgrade.body).not.toContain("createdAt")
	})

	it("rechecks a committed revoke after root admission on the assembled server", async () => {
		const env = await setup()
		let target: string | undefined
		env.app.addHook("preHandler", async request => {
			if (target && request.url === "/api/access/devices")
				await env.context.api.sessions.revoke(target)
		})
		await env.server.start()
		const paired = await env.pair()
		target = paired.body.deviceId
		const result = await wire(env.server, "GET", "/api/access/devices", [
			"Host",
			browser.host,
			"Origin",
			origin,
			"Cookie",
			paired.headers.cookie,
		])
		expect(result.status).toBe(401)
		expect(JSON.parse(result.body)).toEqual({ code: "AUTH_REQUIRED" })
	})
})

describe("assembled device authority failure isolation", () => {
	it("uses safe device serialization and reports actual uncertain storage as 503 on GET and HEAD", async () => {
		const env = await setup()
		env.app.addHook("preHandler", async (request, reply) => {
			if (request.url === "/api/access/devices")
				reply.serializer(() => JSON.stringify({ private: "poison" }))
		})
		await env.server.start()
		const paired = await env.pair()
		const headers = [
			"Host",
			browser.host,
			"Origin",
			origin,
			"Cookie",
			paired.headers.cookie,
		]
		const healthy = await wire(
			env.server,
			"GET",
			"/api/access/devices",
			headers,
		)
		expect(
			accessDevicesDtoSchema.safeParse(JSON.parse(healthy.body)).success,
		).toBe(true)
		expect(healthy.body).not.toContain("poison")
		await env.context.close()
		await expect(env.context.api.sessions.create()).rejects.toMatchObject({
			code: "ACCESS_UNAVAILABLE",
		})
		const unavailable = await wire(
			env.server,
			"GET",
			"/api/access/devices",
			headers,
		)
		expect(unavailable.status).toBe(503)
		expect(JSON.parse(unavailable.body)).toEqual({ code: "ACCESS_UNAVAILABLE" })
		assertParity(
			unavailable,
			await wire(env.server, "HEAD", "/api/access/devices", headers),
		)
	})
})

/** Test-only delegation; the runtime still owns the actual private persist callback. */
async function setupDeviceAuthority() {
	const open = SessionStore.open.bind(SessionStore)
	let elapsed = 0
	let store: SessionStore | undefined
	let requester = ""
	let phase: "ordinary" | "snapshot" | "nested-failure" = "ordinary"
	let fault: "none" | "expired" | "invalid" | "reentrant" = "none"
	let returnedValidAfterReentry = false
	const clockReads: string[] = []
	const barriers: {
		entered: Promise<void>
		signalEntered: () => void
		gate: Promise<void>
		release: () => void
		held: boolean
	}[] = []
	let nextBarrier: (typeof barriers)[number] | undefined
	const construction = vi
		.spyOn(SessionStore, "open")
		.mockImplementationOnce(options =>
			open({
				...options,
				epochNow: () => 1_000_000,
				monotonicNow: () => {
					clockReads.push(phase)
					if (phase === "nested-failure") return NaN
					if (phase === "snapshot" && fault === "expired")
						elapsed += 30 * 24 * 60 * 60 * 1000
					if (phase === "snapshot" && fault === "invalid") return NaN
					if (phase === "snapshot" && fault === "reentrant") {
						phase = "nested-failure"
						try {
							store?.lookupByPrincipal(requester)
						} finally {
							phase = "snapshot"
						}
						returnedValidAfterReentry = true
					}
					return elapsed
				},
				persist: async snapshot => {
					const barrier = nextBarrier
					nextBarrier = undefined
					if (barrier) {
						barrier.signalEntered()
						await barrier.gate
					}
					await options.persist(snapshot)
				},
			}),
		)
	let env: Awaited<ReturnType<typeof setup>>
	try {
		env = await setup()
		expect(construction).toHaveBeenCalledTimes(1)
	} finally {
		construction.mockRestore()
	}
	store = env.context.api.sessions
	const snapshot = store.snapshotActiveDevices.bind(store)
	// This wrapper labels clock scope only; it delegates all real snapshot logic/outcomes.
	const snapshotScope = vi
		.spyOn(store, "snapshotActiveDevices")
		.mockImplementation(id => {
			requester = id
			phase = "snapshot"
			try {
				return snapshot(id)
			} finally {
				phase = "ordinary"
			}
		})
	deviceAuthorityCleanups.push(() => {
		for (const barrier of barriers) barrier.release()
		snapshotScope.mockRestore()
	})
	const holdNextPersist = () => {
		if (nextBarrier)
			throw new Error("An unconsumed persistence barrier already exists")
		let signalEntered = () => {}
		let releaseGate = () => {}
		const entered = new Promise<void>(resolve => {
			signalEntered = resolve
		})
		const gate = new Promise<void>(resolve => {
			releaseGate = resolve
		})
		const barrier = {
			entered,
			signalEntered,
			gate,
			held: true,
			release: () => {
				barrier.held = false
				releaseGate()
			},
		}
		barriers.push(barrier)
		nextBarrier = barrier
		return barrier
	}
	return {
		...env,
		clockReads,
		snapshotScope,
		holdNextPersist,
		advance: (ms: number) => {
			elapsed += ms
		},
		setFault: (value: "none" | "expired" | "invalid" | "reentrant") => {
			fault = value
		},
		returnedValidAfterReentry: () => returnedValidAfterReentry,
		releaseBarriers: () => {
			for (const barrier of barriers) barrier.release()
		},
	}
}

const devicePath = "/api/access/devices"
/** WG2 access amendment 4.11: `lastSeenAt` is the start of the admission's UTC hour. */
const HOUR_OF = (ms: number): number => ms - (ms % 3_600_000)
function deviceHeaders(cookie: string): string[] {
	return ["Host", browser.host, "Origin", origin, "Cookie", cookie]
}

async function deviceRead(
	env: Awaited<ReturnType<typeof setupDeviceAuthority>>,
	cookie: string,
) {
	const get = await wire(env.server, "GET", devicePath, deviceHeaders(cookie))
	const head = await wire(env.server, "HEAD", devicePath, deviceHeaders(cookie))
	assertParity(get, head)
	expect(get.status).toBe(200)
	return accessDevicesDtoSchema.parse(JSON.parse(get.body) as unknown)
}

describe("assembled device persistence and snapshot-clock schedules", () => {
	it("completes GET/HEAD against old committed rows while an actual create persist is held", async () => {
		const env = await setupDeviceAuthority()
		await env.server.start()
		const first = await env.pair()
		const before = await deviceRead(env, first.headers.cookie)
		const durable = await fs.readFile(join(env.directory, "access-state.json"))
		const barrier = env.holdNextPersist()
		let completed = false
		const pending = env.pair().then(result => {
			completed = true
			return result
		})
		try {
			await barrier.entered
			const held = await deviceRead(env, first.headers.cookie)
			expect(held).toEqual(before)
			expect(barrier.held).toBe(true)
			expect(completed).toBe(false)
			expect(
				await fs.readFile(join(env.directory, "access-state.json")),
			).toEqual(durable)
			barrier.release()
			const second = await pending
			expect(
				await fs.readFile(join(env.directory, "access-state.json")),
			).not.toEqual(durable)
			const committed = await deviceRead(env, first.headers.cookie)
			expect(committed.devices).toHaveLength(2)
			expect(
				committed.devices.find(row => row.deviceId === second.body.deviceId),
			).toMatchObject({ current: false })
			expect(committed.devices.find(row => row.current)?.deviceId).toBe(
				first.body.deviceId,
			)
		} finally {
			env.releaseBarriers()
			await pending
			env.snapshotScope.mockRestore()
		}
	})

	it("completes GET/HEAD with previous clocks while actual refresh persistence is held", async () => {
		const env = await setupDeviceAuthority()
		await env.server.start()
		const paired = await env.pair()
		// WG2 req 11: commit this hour's last-seen first (its own non-latching write), so the
		// held write below is the refresh alone.
		await env.context.api.sessions.noteSeen(paired.body.deviceId, 1_000_000)
		const before = await deviceRead(env, paired.headers.cookie)
		const durable = await fs.readFile(join(env.directory, "access-state.json"))
		env.advance(1000)
		const barrier = env.holdNextPersist()
		let completed = false
		const pending = env.app
			.inject({
				method: "POST",
				url: "/api/access/session/refresh",
				headers: paired.headers,
			})
			.then(result => {
				completed = true
				return result
			})
		try {
			await barrier.entered
			expect(await deviceRead(env, paired.headers.cookie)).toEqual(before)
			expect(barrier.held).toBe(true)
			expect(completed).toBe(false)
			expect(
				await fs.readFile(join(env.directory, "access-state.json")),
			).toEqual(durable)
			barrier.release()
			expect((await pending).statusCode).toBe(200)
			expect(
				await fs.readFile(join(env.directory, "access-state.json")),
			).not.toEqual(durable)
			const committed = await deviceRead(env, paired.headers.cookie)
			expect(committed.devices[0]).toEqual({
				...before.devices[0],
				renewedAt: 1_001_000,
				expiresAt: paired.body.expiresAt + 1000,
			})
			expect(committed.devices[0]?.lastSeenAt).toBe(HOUR_OF(1_001_000))
		} finally {
			env.releaseBarriers()
			await pending
			env.snapshotScope.mockRestore()
		}
	})

	it("completes GET/HEAD with the old peer row while actual revoke persistence is held", async () => {
		const env = await setupDeviceAuthority()
		await env.server.start()
		const requester = await env.pair()
		const peer = await env.pair()
		await env.context.api.sessions.noteSeen(requester.body.deviceId, 1_000_000)
		const before = await deviceRead(env, requester.headers.cookie)
		const durable = await fs.readFile(join(env.directory, "access-state.json"))
		const barrier = env.holdNextPersist()
		let completed = false
		const pending = env.app
			.inject({
				method: "POST",
				url: "/api/access/devices/revoke",
				headers: requester.headers,
				payload: { deviceId: peer.body.deviceId },
			})
			.then(result => {
				completed = true
				return result
			})
		try {
			await barrier.entered
			expect(await deviceRead(env, requester.headers.cookie)).toEqual(before)
			expect(barrier.held).toBe(true)
			expect(completed).toBe(false)
			expect(
				await fs.readFile(join(env.directory, "access-state.json")),
			).toEqual(durable)
			barrier.release()
			const result = await pending
			expect(result.statusCode).toBe(200)
			expect(result.json()).toEqual({ revoked: true })
			expect(
				await fs.readFile(join(env.directory, "access-state.json")),
			).not.toEqual(durable)
			const committed = await deviceRead(env, requester.headers.cookie)
			expect(committed.devices).toEqual(
				before.devices.filter(row => row.deviceId !== peer.body.deviceId),
			)
		} finally {
			env.releaseBarriers()
			await pending
			env.snapshotScope.mockRestore()
		}
	})

	it("expires the requester after actual root admission and returns wire GET/HEAD 401 parity", async () => {
		const responses: Awaited<ReturnType<typeof wire>>[] = []
		for (const method of ["GET", "HEAD"]) {
			const env = await setupDeviceAuthority()
			let admitted = false
			env.app.addHook("preHandler", async (request: FastifyRequest) => {
				if (request.url === devicePath) {
					admitted = true
					env.setFault("expired")
				}
			})
			try {
				await env.server.start()
				const paired = await env.pair()
				env.clockReads.length = 0
				const result = await wire(
					env.server,
					method,
					devicePath,
					deviceHeaders(paired.headers.cookie),
				)
				expect(admitted).toBe(true)
				expect(result.status).toBe(401)
				expect(result.headers["set-cookie"]).toBeUndefined()
				expect(result.body).not.toContain("devices")
				expect(env.clockReads).toEqual(["ordinary", "ordinary", "snapshot"])
				expect(env.snapshotScope).toHaveBeenCalledTimes(1)
				expect(env.context.api.sessions.unavailable).toBe(false)
				responses.push(result)
			} finally {
				env.releaseBarriers()
				env.snapshotScope.mockRestore()
			}
		}
		const [get, head] = responses
		if (!get || !head) throw new Error("Missing wire responses")
		expect(JSON.parse(get.body)).toEqual({ code: "AUTH_REQUIRED" })
		assertParity(get, head)
	})

	it.each(["invalid", "reentrant"] as const)(
		"fails closed only at the actual snapshot clock (%s), with wire GET/HEAD 503 parity",
		async fault => {
			const responses: Awaited<ReturnType<typeof wire>>[] = []
			for (const method of ["GET", "HEAD"]) {
				const env = await setupDeviceAuthority()
				try {
					await env.server.start()
					const paired = await env.pair()
					env.clockReads.length = 0
					env.setFault(fault)
					const result = await wire(
						env.server,
						method,
						devicePath,
						deviceHeaders(paired.headers.cookie),
					)
					expect(env.snapshotScope).toHaveBeenCalledTimes(1)
					expect(env.clockReads).toEqual(
						fault === "reentrant"
							? ["ordinary", "ordinary", "snapshot", "nested-failure"]
							: ["ordinary", "ordinary", "snapshot"],
					)
					expect(env.context.api.sessions.unavailable).toBe(true)
					expect(env.returnedValidAfterReentry()).toBe(fault === "reentrant")
					expect(result.status).toBe(503)
					expect(result.headers["set-cookie"]).toBeUndefined()
					expect(result.body).not.toContain("devices")
					expect(result.body).not.toContain("tokenHash")
					expect(result.body).not.toContain("csrfToken")
					responses.push(result)
				} finally {
					env.releaseBarriers()
					env.snapshotScope.mockRestore()
				}
			}
			const [get, head] = responses
			if (!get || !head) throw new Error("Missing wire responses")
			expect(JSON.parse(get.body)).toEqual({ code: "ACCESS_UNAVAILABLE" })
			assertParity(get, head)
		},
	)
})
