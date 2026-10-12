import { EventEmitter } from "node:events"
import { Socket } from "node:net"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { FastifyRequest } from "fastify"
import { WaveKitError } from "../../../src/utils/errors.js"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type {
	NamedAccessRuntimeContext,
	NamedAccessRuntimeOptions,
} from "../../../src/access/runtime-context.js"
import { createRegionalRegistration } from "../../../src/core/regional/data.js"
import { createRegionalRegistry } from "../../../src/core/regional/registry.js"
import type { RegionalRegistry } from "../../../src/core/regional/registry.js"
import {
	canonicalBytes,
	publicationDigest,
} from "../../../src/core/regional/types.js"
import type { RegionalChannelsResult } from "@wavekit/api-types"
import type { StoredDataset } from "../../../src/core/regional/types.js"

const origin = "http://receiver.lan:9000"
const browser = { host: "receiver.lan:9000", origin }
// Raw HTTP deliberately bypasses WHATWG URL normalization and HEAD-aware body
// collectors. The retained wireBody is every byte after the response headers.
interface WireResponse {
	statusCode: number
	headers: Record<string, string>
	wireBody: Buffer
}
function rawHttp(
	server: ApiServer,
	method: string,
	target: string,
	headers: Readonly<Record<string, string>> = {},
	payload = "",
): Promise<WireResponse> {
	const address = server.getApp().server.address()
	if (address === null || typeof address === "string")
		throw new Error("TEST missing TCP listener")
	return new Promise((resolve, reject) => {
		const socket = new Socket()
		const chunks: Buffer[] = []
		let size = 0
		let settled = false
		const finish = (error: Error | null, value?: WireResponse) => {
			if (settled) return
			settled = true
			socket.setTimeout(0)
			socket.removeListener("data", onData)
			socket.removeListener("end", onEnd)
			socket.removeListener("connect", onConnect)
			socket.removeListener("timeout", onTimeout)
			// Keep the error/close listeners through destroy; late errors are sunk.
			socket.destroy()
			if (error !== null) reject(error)
			else if (value !== undefined) resolve(value)
			else reject(new Error("TEST missing raw response"))
		}
		const onError = (error: Error) => finish(error)
		const onTimeout = () => finish(new Error("TEST raw HTTP timeout"))
		const onData = (chunk: Buffer) => {
			size += chunk.length
			if (size > 256 * 1024)
				finish(new Error("TEST raw HTTP response overflow"))
			else chunks.push(chunk)
		}
		const onEnd = () => {
			const bytes = Buffer.concat(chunks)
			const boundary = bytes.indexOf("\r\n\r\n")
			if (boundary < 0)
				return finish(new Error("TEST incomplete raw HTTP headers"))
			const lines = bytes.subarray(0, boundary).toString("latin1").split("\r\n")
			const status = /^HTTP\/1\.[01] ([0-9]{3})(?: |$)/.exec(
				lines.shift() ?? "",
			)
			if (status?.[1] === undefined)
				return finish(new Error("TEST invalid raw HTTP status"))
			const responseHeaders: Record<string, string> = {}
			for (const line of lines) {
				const colon = line.indexOf(":")
				if (colon < 1) return finish(new Error("TEST invalid raw HTTP header"))
				const name = line.slice(0, colon).toLowerCase()
				const value = line.slice(colon + 1).trim()
				responseHeaders[name] =
					responseHeaders[name] === undefined
						? value
						: `${responseHeaders[name]}, ${value}`
			}
			finish(null, {
				statusCode: Number(status[1]),
				headers: responseHeaders,
				wireBody: bytes.subarray(boundary + 4),
			})
		}
		const onConnect = () => {
			const fields = { host: "127.0.0.1", ...headers, connection: "close" }
			const request = `${method} ${target} HTTP/1.1\r\n${Object.entries(fields)
				.map(([name, value]) => `${name}: ${value}`)
				.join("\r\n")}\r\n\r\n${payload}`
			socket.write(request, "latin1")
		}
		const onClose = () => {
			if (!settled)
				finish(new Error("TEST raw HTTP closed before response end"))
			socket.removeListener("error", onError)
			socket.removeListener("close", onClose)
		}
		socket.on("error", onError)
		socket.once("close", onClose)
		socket.on("data", onData)
		socket.once("end", onEnd)
		socket.once("connect", onConnect)
		socket.once("timeout", onTimeout)
		socket.setTimeout(2000)
		socket.connect(address.port, "127.0.0.1")
	})
}

const headFrames = [
	{ name: "absent", headers: {}, payload: "", status: 405 },
	{
		name: "empty",
		headers: { "content-length": "0" },
		payload: "",
		status: 405,
	},
	{
		name: "positiveCL",
		headers: {
			"content-length": "1",
			"content-type": "application/x-regional-test",
		},
		payload: "x",
		status: 400,
	},
	{
		name: "emptyChunked",
		headers: {
			"transfer-encoding": "chunked",
			"content-type": "application/x-regional-test",
		},
		payload: "0\r\n\r\n",
		status: 400,
	},
] as const

const servers: ApiServer[] = []
const contexts: NamedAccessRuntimeContext[] = []
const roots: string[] = []
afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop()
	for (const context of contexts.splice(0)) await context.close()
	for (const root of roots.splice(0))
		await fs.rm(root, { recursive: true, force: true })
	vi.restoreAllMocks()
})
function runtimeOptions(directory: string): NamedAccessRuntimeOptions {
	return {
		directory,
		ownership: "single-host-pid-namespace",
		bootstrap: {
			mode: "protected",
			listenerScheme: "http",
			allowedAuthorities: [browser.host],
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
function synthetic(empty = false): RegionalRegistry {
	// Invented TEST values/evidence, never production/regulatory data.
	const stored: StoredDataset = {
		publication: {
			schemaVersion: 1,
			datasetId: "us-frs",
			datasetVersion: "test-1",
			dataContentSha256: "0".repeat(64),
			familyId: "frs",
			applicability: { kind: "national", countryCode: "US" },
			verifiedAsOf: "2026-01-01",
			sourceReferences: [
				{
					id: "test-source",
					organization: "TEST",
					documentId: "TEST",
					title: "TEST",
					edition: "test-1",
					publishedDate: null,
					retrievedDate: "2026-01-01",
					url: "https://example.invalid/test",
					documentSha256: "0".repeat(64),
					applicability: "US",
					redistribution: "facts-transcribed",
					locator: "TEST",
				},
			],
			rows: empty
				? []
				: [0, 1].map(index => ({
						id: `us-frs-test-${index}`,
						displayLabel: `TEST ${index}`,
						aliases: ["shared", `test ${index}`],
						frequency: { kind: "simplex", frequencyHz: index + 1 },
						display: {
							advisory: true,
							mode: null,
							bandwidthHz: null,
							stepHz: null,
						},
						sourceReferenceIds: ["test-source"],
					})),
		},
		collisions: empty
			? []
			: [{ alias: "shared", candidateIds: ["us-frs-test-0", "us-frs-test-1"] }],
	}
	stored.publication.dataContentSha256 = publicationDigest(stored)
	return createRegionalRegistry({
		schemaVersion: 1,
		registrations: [
			{
				manifest: {
					familyId: "frs",
					displayLabel: "TEST FRS",
					applicability: { kind: "national", countryCode: "US" },
					state: "verified",
					datasetVersion: "test-1",
					reason: null,
				},
				dataset: stored,
			},
		],
		coarseContext: null,
	})
}
function observe(registry: RegionalRegistry) {
	return {
		listFamilies: vi.fn(
			(region: Parameters<RegionalRegistry["listFamilies"]>[0]) =>
				registry.listFamilies(region),
		),
		listChannels: vi.fn(
			(input: Parameters<RegionalRegistry["listChannels"]>[0]) =>
				registry.listChannels(input),
		),
		resolveAlias: vi.fn(
			(input: Parameters<RegionalRegistry["resolveAlias"]>[0]) =>
				registry.resolveAlias(input),
		),
	}
}
async function setup(
	options: {
		registry?: RegionalRegistry | null
		unmounted?: boolean
		poison?: boolean
		parentPoison?: boolean
		rootFault?: boolean
	} = {},
) {
	const root = await fs.mkdtemp(join(tmpdir(), "wavekit-regional-access-"))
	roots.push(root)
	const directory = join(root, "private")
	const provisioned = await PrivateAccessStorage.open({
		directory,
		ownership: "single-host-pid-namespace",
		mode: "provision",
	})
	const token = provisioned.useMachineCredential(value => value)
	await provisioned.close()
	const context = await openAccessRuntime(runtimeOptions(directory))
	contexts.push(context)
	const registry =
		options.registry === undefined
			? observe(createRegionalRegistry(createRegionalRegistration()))
			: options.registry
	const operational = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		createDecoder: vi.fn(),
		startDecoder: vi.fn(),
		stopDecoder: vi.fn(),
		attachSource: vi.fn(),
		addBranch: vi.fn(),
	}
	const dependencies: ApiServerDependencies = {
		access: context,
		logger: pino({ level: "silent" }),
		...(options.unmounted ? {} : { regionalRegistry: registry }),
		sourceManager: Object.assign(new EventEmitter(), {
			connect: operational.connect,
			disconnect: operational.disconnect,
			getAllStatus: vi.fn(() => []),
			getStatus: vi.fn(),
			getStream: vi.fn(),
			getCaps: vi.fn(),
			getSourceAssignments: vi.fn(() => []),
		}) as unknown as ApiServerDependencies["sourceManager"],
		decoderManager: Object.assign(new EventEmitter(), {
			createDecoder: operational.createDecoder,
			startDecoder: operational.startDecoder,
			stopDecoder: operational.stopDecoder,
			getAllDecoders: vi.fn(() => []),
			getAllStatus: vi.fn(() => []),
			getAllHealth: vi.fn(() => new Map()),
		}) as unknown as ApiServerDependencies["decoderManager"],
		fanoutManager: Object.assign(new EventEmitter(), {
			attachSource: operational.attachSource,
			addBranch: operational.addBranch,
			getBranchIds: vi.fn(() => []),
			getTelemetrySnapshot: vi.fn(() => ({
				timestamp: new Date().toISOString(),
				branches: [],
				backpressureActiveCount: 0,
				droppedBytesTotal: 0,
				droppedChunksTotal: 0,
			})),
		}) as unknown as ApiServerDependencies["fanoutManager"],
		audioOutput: Object.assign(new EventEmitter(), {
			getConnectedClients: vi.fn(() => 0),
			getPort: vi.fn(() => 0),
		}) as unknown as ApiServerDependencies["audioOutput"],
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
	const parser = vi.fn(
		(
			_request: FastifyRequest,
			body: string,
			done: (error: Error | null, value?: unknown) => void,
		) => done(null, body),
	)
	app.addContentTypeParser(
		"application/x-regional-test",
		{ parseAs: "string" },
		parser,
	)
	if (options.poison)
		app.addHook("preHandler", async (_request, reply) => {
			reply.serializer(() => '{"private":"inherited poison"}')
		})
	if (options.parentPoison)
		app.setSerializerCompiler(
			() => () => '{"private":"inherited schema poison"}',
		)
	if (options.rootFault) {
		const inspected = server as unknown as { registerRoutes(): Promise<void> }
		const register = inspected.registerRoutes.bind(server)
		vi.spyOn(inspected, "registerRoutes").mockImplementation(async () => {
			// Actual startup logging/correlation hooks already exist here. Insert
			// this parent fault before delegating the REAL Main route mounts.
			app.addHook("onRequest", async request => {
				if (
					request.raw.url?.startsWith("/api/regional/") ||
					request.raw.url === "/__regional-parent-control"
				)
					throw new WaveKitError(
						"Parent fixture failure",
						"PARENT_FIXTURE_FAILURE",
					)
			})
			app.get("/__regional-parent-control", async () => ({ unreachable: true }))
			await register()
		})
	}
	await server.start()
	const machine = { host: browser.host, authorization: `Bearer ${token}` }
	async function pair() {
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
		const setCookie = paired.headers["set-cookie"]
		if (typeof setCookie !== "string") throw new Error("TEST missing cookie")
		const body = paired.json<{ csrfToken: string }>()
		return {
			...browser,
			cookie: setCookie.split(";")[0]!,
			"x-wavekit-csrf": body.csrfToken,
		}
	}
	return { server, app, context, registry, parser, machine, pair, operational }
}
function assertRoot(
	response: {
		statusCode: number
		body: string
		headers: Record<string, unknown>
	},
	status: number,
	code: string,
	expectedOrigin: string | null = null,
) {
	expect(response.statusCode).toBe(status)
	expect(response.body).toBe(JSON.stringify({ code }))
	expect(response.headers["cache-control"]).toBe("no-store")
	expect(response.headers["vary"]).toContain("Origin")
	expect(response.headers["allow"]).toBeUndefined()
	expect(response.headers["access-control-allow-origin"]).toBe(
		expectedOrigin ?? undefined,
	)
	expect(response.headers["access-control-allow-credentials"]).toBe(
		expectedOrigin === null ? undefined : "true",
	)
}
const urls = [
	"/api/regional/families?region=US",
	"/api/regional/channels?region=US&family=frs",
	"/api/regional/resolve?region=US&family=frs&alias=shared",
] as const

// Complete parent comparison: dynamic request identity/date/length are checked
// individually, not silently excluded from the contract.
function assertParent(
	control: {
		statusCode: number
		body: string
		headers: Record<string, unknown>
	},
	response: {
		statusCode: number
		body: string
		headers: Record<string, unknown>
	},
) {
	const expected: unknown = JSON.parse(control.body)
	const actual: unknown = JSON.parse(response.body)
	if (
		expected === null ||
		actual === null ||
		typeof expected !== "object" ||
		typeof actual !== "object"
	)
		throw new Error("TEST missing parent envelope")
	const expectedId =
		"correlationId" in expected ? expected.correlationId : undefined
	const actualId = "correlationId" in actual ? actual.correlationId : undefined
	if (
		typeof expectedId !== "string" ||
		typeof actualId !== "string" ||
		!expectedId ||
		!actualId
	)
		throw new Error("TEST missing parent correlation")
	expect(Object.keys(expected).sort()).toEqual([
		"code",
		"correlationId",
		"error",
		"message",
	])
	expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort())
	expect(actual).toEqual({ ...expected, correlationId: actualId })
	expect(response.statusCode).toBe(control.statusCode)
	expect(control.headers["x-correlation-id"]).toBe(expectedId)
	expect(response.headers["x-correlation-id"]).toBe(actualId)
	expect(
		response.body.replace(JSON.stringify(actualId), JSON.stringify(expectedId)),
	).toBe(control.body)
	for (const reply of [control, response]) {
		expect(reply.headers["content-type"]).toBe(
			"application/json; charset=utf-8",
		)
		expect(reply.headers["content-length"]).toBeDefined()
		expect(Number(reply.headers["content-length"])).toBe(
			Buffer.byteLength(reply.body, "utf8"),
		)
		expect(reply.body).not.toContain("poison")
	}
	const normalized = (headers: Record<string, unknown>) =>
		Object.fromEntries(
			Object.entries(headers).filter(
				([key]) =>
					!["date", "content-length", "x-correlation-id"].includes(key),
			),
		)
	expect(Object.keys(response.headers).sort()).toEqual(
		Object.keys(control.headers).sort(),
	)
	expect(normalized(response.headers)).toEqual(normalized(control.headers))
	for (const key of [
		"cache-control",
		"vary",
		"access-control-allow-origin",
		"access-control-allow-credentials",
		"allow",
		"content-type",
	])
		expect(response.headers[key]).toEqual(control.headers[key])
}

// Feature: regional-display-registry, Property 7: Admission ordering
// Validates: Requirements 4.1, 4.2, 4.5
// Actual ApiServer + real protected context/session authority, not handler mocks.
describe("regional actual protected admission", () => {
	it("root denials win before malformed queries/framing/denied methods and read zero", async () => {
		const registry = observe(synthetic())
		const { app, parser, machine } = await setup({ registry })
		const denied = [
			{ headers: { host: browser.host }, status: 401, code: "AUTH_REQUIRED" },
			{
				headers: { ...machine, authorization: "Bearer invalid" },
				status: 401,
				code: "AUTH_REQUIRED",
			},
			{
				headers: { ...machine, host: "foreign.invalid" },
				status: 403,
				code: "HOST_FORBIDDEN",
			},
			{
				headers: { ...machine, origin: "http://foreign.invalid" },
				status: 403,
				code: "ORIGIN_FORBIDDEN",
			},
			{
				headers: {
					...machine,
					authorization: `${machine.authorization}, Bearer invalid`,
				},
				status: 400,
				code: "MALFORMED_REQUEST",
			},
		]
		for (const test of denied) {
			for (const method of ["GET", "POST"] as const) {
				const response = await app.inject({
					method,
					url: "/api/regional/channels?%72egion=US&region=US&family=frs",
					headers: {
						...test.headers,
						"content-type": "application/x-regional-test",
					},
					payload: "{bad",
				})
				assertRoot(response, test.status, test.code)
			}
		}
		expect(parser).not.toHaveBeenCalled()
		for (const spy of Object.values(registry))
			expect(spy).not.toHaveBeenCalled()
	})
	it("null and unmounted do not create an admission exception", async () => {
		for (const options of [{ registry: null }, { unmounted: true }]) {
			const { app, machine } = await setup(options)
			assertRoot(
				await app.inject({ url: urls[0], headers: { host: browser.host } }),
				401,
				"AUTH_REQUIRED",
			)
			const admitted = await app.inject({ url: urls[0], headers: machine })
			expect(admitted.statusCode).toBe(options.unmounted ? 404 : 503)
		}
	})
	it("machine/session admitted reads cover every semantic state and independent national selection", async () => {
		for (const provider of [
			createRegionalRegistry(
				createRegionalRegistration({ code: "JP", source: "default" }),
			),
			synthetic(),
			synthetic(true),
		]) {
			const registry = observe(provider)
			const { app, machine, pair, operational } = await setup({ registry })
			const session = await pair()
			for (const headers of [machine, session]) {
				for (const region of [
					"EU",
					"US",
					"CA",
					"AU",
					"NZ",
					"JP",
					"CN",
				] as const) {
					for (const [url, expected] of [
						[
							`/api/regional/families?region=${region}`,
							provider.listFamilies(region),
						],
						[
							`/api/regional/channels?region=${region}&family=frs`,
							provider.listChannels({ region, family: "frs" }),
						],
						[
							`/api/regional/resolve?region=${region}&family=frs&alias=shared`,
							provider.resolveAlias({ region, family: "frs", alias: "shared" }),
						],
						[
							`/api/regional/resolve?region=${region}&family=frs&alias=test+0`,
							provider.resolveAlias({ region, family: "frs", alias: "test 0" }),
						],
						[
							`/api/regional/resolve?region=${region}&family=frs&alias=missing`,
							provider.resolveAlias({
								region,
								family: "frs",
								alias: "missing",
							}),
						],
					] as const) {
						const response = await app.inject({ url, headers })
						expect(response.statusCode).toBe(200)
						expect(response.body).toBe(
							canonicalBytes(expected).toString("utf8"),
						)
						expect(response.headers["cache-control"]).toBe("no-store")
					}
				}
			}
			for (const operation of Object.values(operational))
				expect(operation).not.toHaveBeenCalled()
		}
	})
	it("unsafe session CSRF/origin wins before framing; admitted session/machine gets local denial", async () => {
		const registry = observe(synthetic())
		const { app, machine, pair, parser } = await setup({ registry })
		const session = await pair()
		const noCsrf = {
			host: session.host,
			origin: session.origin,
			cookie: session.cookie,
		}
		const noOrigin = {
			host: session.host,
			cookie: session.cookie,
			"x-wavekit-csrf": session["x-wavekit-csrf"],
		}
		for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
			for (const headers of [noCsrf, noOrigin])
				assertRoot(
					await app.inject({
						method,
						url: "/api/regional/families?bad=invalid",
						headers,
						payload: "{bad",
					}),
					403,
					"CSRF_REQUIRED",
					headers === noCsrf ? origin : null,
				)
			for (const headers of [machine, session]) {
				const empty = await app.inject({
					method,
					url: "/api/regional/families?bad=invalid",
					headers: {
						...headers,
						"content-length": "0",
						"content-type": "application/x-regional-test",
					},
				})
				expect(empty.statusCode).toBe(405)
				expect(empty.json()).toEqual({
					error: "Method Not Allowed",
					code: "REGIONAL_METHOD_NOT_ALLOWED",
					message: "Regional registry method is not allowed",
				})
				expect(empty.headers.allow).toBe("GET")
				const framed = await app.inject({
					method,
					url: "/api/regional/families",
					headers: {
						...headers,
						"content-type": "application/x-regional-test",
					},
					payload: "{bad",
				})
				expect(framed.statusCode).toBe(400)
				expect(framed.json()).toEqual({
					error: "Bad Request",
					code: "REGIONAL_INVALID_REQUEST",
					message: "Invalid regional registry request",
				})
			}
		}
		expect(parser).not.toHaveBeenCalled()
		for (const spy of Object.values(registry))
			expect(spy).not.toHaveBeenCalled()
	})
	it.each(urls.flatMap(url => headFrames.map(frame => ({ url, ...frame }))))(
		"real protected HEAD wire $url/$name preserves framing-before-method",
		async ({ url, headers, payload, status }) => {
			const registry = observe(synthetic())
			const { server, machine, parser } = await setup({ registry })
			const response = await rawHttp(
				server,
				"HEAD",
				url,
				{ ...machine, ...headers },
				payload,
			)
			expect(response.statusCode).toBe(status)
			expect(response.headers["allow"]).toBe(status === 405 ? "GET" : undefined)
			expect(response.headers["cache-control"]).toBe("no-store")
			expect(response.wireBody.length).toBe(0)
			expect(parser).not.toHaveBeenCalled()
			for (const spy of Object.values(registry))
				expect(spy).not.toHaveBeenCalled()
		},
	)
	it.each([
		{ target: "/api/regional/unknown", authenticated: true, status: 404 },
		{ target: urls[0], authenticated: false, status: 401 },
	])(
		"real protected root HEAD $target/$status has no wire body",
		async ({ target, authenticated, status }) => {
			const registry = observe(synthetic())
			const { server, machine, parser } = await setup({ registry })
			const response = await rawHttp(
				server,
				"HEAD",
				target,
				authenticated ? machine : { host: browser.host },
			)
			expect(response.statusCode).toBe(status)
			expect(response.wireBody.length).toBe(0)
			expect(response.headers["allow"]).toBeUndefined()
			if (status === 401) {
				expect(response.headers["cache-control"]).toBe("no-store")
				expect(response.headers["vary"]).toContain("Origin")
			}
			for (const spy of Object.values(registry))
				expect(spy).not.toHaveBeenCalled()
			expect(parser).not.toHaveBeenCalled()
		},
	)
	it("malformed percent targets remain root400 before unsafe CSRF or feature method/framing", async () => {
		const registry = observe(synthetic())
		const { app, machine, pair, parser } = await setup({ registry })
		const session = await pair()
		const noCsrf = {
			host: session.host,
			origin: session.origin,
			cookie: session.cookie,
		}
		const noOrigin = {
			host: session.host,
			cookie: session.cookie,
			"x-wavekit-csrf": session["x-wavekit-csrf"],
		}
		for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
			for (const headers of [machine, session, noCsrf, noOrigin]) {
				assertRoot(
					await app.inject({
						method,
						url: "/api/regional/families?bad=%GG",
						headers,
						payload: "{bad",
					}),
					400,
					"MALFORMED_REQUEST",
					headers === session || headers === noCsrf ? origin : null,
				)
			}
		}
		expect(parser).not.toHaveBeenCalled()
		for (const spy of Object.values(registry))
			expect(spy).not.toHaveBeenCalled()
	})
	it("literal raw fragment is refused by protected root before the regional hook", async () => {
		const registry = observe(synthetic())
		const { server, machine, parser } = await setup({ registry })
		const response = await rawHttp(
			server,
			"GET",
			"/api/regional/resolve?region=US&family=frs&alias=a#b",
			{ ...machine, origin },
		)
		expect(response.statusCode).toBe(400)
		expect(response.wireBody.toString("utf8")).toBe(
			JSON.stringify({ code: "MALFORMED_REQUEST" }),
		)
		expect(response.headers["cache-control"]).toBe("no-store")
		expect(response.headers["vary"]).toContain("Origin")
		expect(response.headers["access-control-allow-origin"]).toBe(origin)
		expect(response.headers["access-control-allow-credentials"]).toBe("true")
		expect(response.headers["allow"]).toBeUndefined()
		expect(parser).not.toHaveBeenCalled()
		for (const spy of Object.values(registry))
			expect(spy).not.toHaveBeenCalled()
	})
	it("protected preflight stays root-owned and never calls provider", async () => {
		const registry = observe(synthetic())
		const { app } = await setup({ registry })
		const accepted = await app.inject({
			method: "OPTIONS",
			url: "/api/regional/channels",
			headers: {
				...browser,
				"access-control-request-method": "GET",
				"access-control-request-headers": "authorization",
			},
		})
		expect(accepted.statusCode).toBe(204)
		expect(accepted.body).toBe("")
		expect(accepted.headers["access-control-allow-origin"]).toBe(origin)
		const bad = await app.inject({
			method: "OPTIONS",
			url: "/api/regional/channels",
			headers: {
				host: browser.host,
				origin: "http://foreign.invalid",
				"access-control-request-method": "GET",
			},
		})
		assertRoot(bad, 403, "ORIGIN_FORBIDDEN")
		for (const spy of Object.values(registry))
			expect(spy).not.toHaveBeenCalled()
	})
	it("normal storage/session unavailable and synchronous shutdown gates preserve root503", async () => {
		const registry = observe(synthetic())
		const { app, context, machine, pair, server } = await setup({ registry })
		const session = await pair()
		await context.close()
		await expect(context.api.sessions.create()).rejects.toMatchObject({
			code: "ACCESS_UNAVAILABLE",
		})
		assertRoot(
			await app.inject({ url: urls[0], headers: session }),
			503,
			"ACCESS_UNAVAILABLE",
			origin,
		)
		// Machine authentication does not depend on session storage, as in root.
		expect(
			(await app.inject({ url: urls[0], headers: machine })).statusCode,
		).toBe(200)
		for (const spy of Object.values(registry)) spy.mockClear()
		server.stopAdmission()
		assertRoot(
			await app.inject({ url: urls[0], headers: machine }),
			503,
			"ACCESS_UNAVAILABLE",
		)
		for (const spy of Object.values(registry))
			expect(spy).not.toHaveBeenCalled()
	})
	it("protected GET framing/query rejections and unknown family have exact local outcomes", async () => {
		const registry = observe(synthetic())
		const { app, machine, parser } = await setup({ registry })
		for (const query of [
			"region=US&%72egion=US",
			"region=US&x=a",
			"region=%C0%AF",
			"region=US&",
			"region=US=CA",
		]) {
			const response = await app.inject({
				url: `/api/regional/families?${query}`,
				headers: machine,
			})
			expect(response.statusCode).toBe(400)
			expect(response.json()).toEqual({
				error: "Bad Request",
				code: "REGIONAL_INVALID_REQUEST",
				message: "Invalid regional registry request",
			})
		}
		const empty = await app.inject({
			url: urls[0],
			headers: { ...machine, "content-length": "0" },
		})
		expect(empty.statusCode).toBe(200)
		registry.listFamilies.mockClear()
		for (const headers of [
			{
				...machine,
				"content-length": "1",
				"content-type": "application/x-regional-test",
			},
			{ ...machine, "transfer-encoding": "chunked" },
		]) {
			const response = await app.inject({
				url: urls[0],
				headers,
				...("content-length" in headers ? { payload: "x" } : {}),
			})
			expect(response.statusCode).toBe(400)
			expect(response.json()).toMatchObject({
				code: "REGIONAL_INVALID_REQUEST",
			})
		}
		const unknown = await app.inject({
			url: "/api/regional/channels?region=US&family=unknown",
			headers: machine,
		})
		expect(unknown.statusCode).toBe(404)
		expect(unknown.json()).toEqual({
			error: "Not Found",
			code: "REGIONAL_FAMILY_NOT_FOUND",
			message: "Regional family not found",
		})
		expect(parser).not.toHaveBeenCalled()
		for (const spy of Object.values(registry))
			expect(spy).not.toHaveBeenCalled()
	})
	it("faulty output and valid-shaped byte overflow fail closed in protected mode too", async () => {
		const real = synthetic()
		const registry = observe(real)
		const { app, machine } = await setup({ registry })
		const base = real.listChannels({ region: "US", family: "frs" })
		if (base.state !== "verified") throw new Error("TEST verified expected")
		registry.listChannels.mockReturnValue({
			...base,
			private: "secret",
		} as RegionalChannelsResult)
		const bad = await app.inject({ url: urls[1], headers: machine })
		expect(bad.statusCode).toBe(503)
		expect(bad.json()).toEqual({
			error: "Service Unavailable",
			code: "REGIONAL_UNAVAILABLE",
			message: "Regional registry is unavailable",
		})
		const sourceReferences = Array.from({ length: 4 }, (_, index) => ({
			...base.dataset.sourceReferences[0]!,
			id: `test-source-${index}-`.padEnd(64, "x"),
		}))
		const rows = Array.from({ length: 128 }, (_, index) => ({
			...base.rows[0]!,
			id: `us-frs-test-${index}-`.padEnd(64, "x"),
			displayLabel: "😀".repeat(80),
			aliases: Array.from({ length: 8 }, (_, alias) =>
				`test-${index}-${alias}-`.padEnd(32, "x"),
			).sort(),
			frequency: { kind: "simplex" as const, frequencyHz: index + 1 },
			sourceReferenceIds: sourceReferences.map(source => source.id).sort(),
		})).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		const large: RegionalChannelsResult = {
			...base,
			dataset: { ...base.dataset, sourceReferences },
			rows,
			total: 128,
			offset: 0,
			limit: 128,
			nextOffset: null,
		}
		expect(Buffer.byteLength(JSON.stringify(large), "utf8")).toBeGreaterThan(
			128 * 1024,
		)
		registry.listChannels.mockReturnValue(large)
		const over = await app.inject({
			url: "/api/regional/channels?region=US&family=frs&limit=128",
			headers: machine,
		})
		expect(over.statusCode).toBe(503)
		expect(over.json()).toEqual({
			error: "Service Unavailable",
			code: "REGIONAL_UNAVAILABLE",
			message: "Regional registry is unavailable",
		})
		expect(over.headers["cache-control"]).toBe("no-store")
	})
	it.each(
		["families", "channels", "resolve"].flatMap(path =>
			[false, true].map(parentPoison => ({ path, parentPoison })),
		),
	)(
		"complete protected parent envelope $path/schemaPoison=$parentPoison",
		async ({ path, parentPoison }) => {
			const registry = observe(synthetic())
			const { app, machine, parser, operational } = await setup({
				registry,
				rootFault: true,
				parentPoison,
			})
			const headers = { ...machine, origin }
			const control = await app.inject({
				url: "/__regional-parent-control",
				headers,
			})
			const response = await app.inject({
				url: `/api/regional/${path}?region=US&family=frs&alias=shared`,
				headers,
			})
			expect(control.statusCode).toBe(400)
			expect(control.json()).toMatchObject({
				code: "PARENT_FIXTURE_FAILURE",
				error: "WaveKitError",
				message: "Request failed",
			})
			assertParent(control, response)
			expect(control.headers["cache-control"]).toBe("no-store")
			expect(control.headers["vary"]).toContain("Origin")
			expect(control.headers["access-control-allow-origin"]).toBe(origin)
			expect(control.headers["access-control-allow-credentials"]).toBe("true")
			expect(parser).not.toHaveBeenCalled()
			for (const spy of Object.values(registry))
				expect(spy).not.toHaveBeenCalled()
			for (const operation of Object.values(operational))
				expect(operation).not.toHaveBeenCalled()
		},
	)
	it("local serialization is safe under inherited poison, while root bodies remain forced code-only", async () => {
		const registry = observe(synthetic())
		const { app, machine } = await setup({ registry, poison: true })
		assertRoot(
			await app.inject({ url: urls[0], headers: { host: browser.host } }),
			401,
			"AUTH_REQUIRED",
		)
		const healthy = await app.inject({ url: urls[0], headers: machine })
		expect(healthy.statusCode).toBe(200)
		expect(healthy.body).toBe(
			canonicalBytes(synthetic().listFamilies("US")).toString("utf8"),
		)
		registry.listFamilies.mockImplementation(() => {
			throw new Error("secret inherited path/alias")
		})
		const faulty = await app.inject({ url: urls[0], headers: machine })
		expect(faulty.statusCode).toBe(503)
		expect(faulty.json()).toEqual({
			error: "Service Unavailable",
			code: "REGIONAL_UNAVAILABLE",
			message: "Regional registry is unavailable",
		})
		expect(faulty.body).not.toMatch(/secret|private|poison|correlationId/)
	})
})
