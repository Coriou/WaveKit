import { EventEmitter } from "node:events"
import { Socket } from "node:net"
import pino from "pino"
import type { FastifyRequest } from "fastify"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { createRegionalRegistry } from "../../../src/core/regional/registry.js"
import type { RegionalRegistry } from "../../../src/core/regional/registry.js"
import { createRegionalRegistration } from "../../../src/core/regional/data.js"
import {
	canonicalBytes,
	publicationDigest,
} from "../../../src/core/regional/types.js"
import type { StoredDataset } from "../../../src/core/regional/types.js"
import type {
	RegionalChannelsResult,
	RegionalFamiliesResult,
	RegionalResolveResult,
} from "@wavekit/api-types"
import { WaveKitError } from "../../../src/utils/errors.js"

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
afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop()
	vi.restoreAllMocks()
})
// Deliberately invented TEST rows/evidence; no accepted RF or numerical dataset.
function synthetic(count = 3, shared = false): RegionalRegistry {
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
					title: "TEST only",
					edition: "test-1",
					publishedDate: null,
					retrievedDate: "2026-01-01",
					url: "https://example.invalid/test",
					documentSha256: "0".repeat(64),
					applicability: "US",
					redistribution: "facts-transcribed",
					locator: "TEST fixture",
				},
			],
			rows: Array.from({ length: count }, (_, index) => ({
				id: `us-frs-test-${index}`,
				displayLabel: `TEST ${index}`,
				aliases: [
					`test ${index}`,
					...(shared ? ["shared"] : []),
					...(index === 0 ? ["a+b", "%2b", "a&b=c", "frs 01"] : []),
				],
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
		collisions: shared
			? [
					{
						alias: "shared",
						candidateIds: Array.from(
							{ length: count },
							(_, index) => `us-frs-test-${index}`,
						),
					},
				]
			: [],
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
function unrelatedDependencies(): ApiServerDependencies {
	return {
		logger: pino({ level: "silent" }),
		sourceManager: Object.assign(new EventEmitter(), {
			getAllStatus: vi.fn(() => []),
			getStatus: vi.fn(),
			getStream: vi.fn(),
			getCaps: vi.fn(),
			getSourceAssignments: vi.fn(() => []),
			getAssignedSource: vi.fn(),
			connect: vi.fn(),
			disconnect: vi.fn(),
		}) as unknown as ApiServerDependencies["sourceManager"],
		decoderManager: Object.assign(new EventEmitter(), {
			getAllDecoders: vi.fn(() => []),
			getAllStatus: vi.fn(() => []),
			getAllHealth: vi.fn(() => new Map()),
		}) as unknown as ApiServerDependencies["decoderManager"],
		fanoutManager: Object.assign(new EventEmitter(), {
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
	const registry =
		options.registry === undefined
			? observe(createRegionalRegistry(createRegionalRegistration()))
			: options.registry
	// This announced dependency is deliberately not hidden by a cast: Main adds
	// the real field/mount before any dependency-complete test or type window.
	const dependencies: ApiServerDependencies = {
		...unrelatedDependencies(),
		...(options.unmounted ? {} : { regionalRegistry: registry }),
	}
	const server = new ApiServer(dependencies, { host: "127.0.0.1", port: 0 })
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
			reply.serializer(() => '{"secret":"inherited poison"}')
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
	return { server, app, parser, registry }
}
const invalid = {
	error: "Bad Request",
	code: "REGIONAL_INVALID_REQUEST",
	message: "Invalid regional registry request",
}
const unavailable = {
	error: "Service Unavailable",
	code: "REGIONAL_UNAVAILABLE",
	message: "Regional registry is unavailable",
}
const denied = {
	error: "Method Not Allowed",
	code: "REGIONAL_METHOD_NOT_ALLOWED",
	message: "Regional registry method is not allowed",
}
function assertLocal(
	response: {
		statusCode: number
		body: string
		headers: Record<string, unknown>
	},
	status: number,
	body: unknown,
) {
	expect(response.statusCode).toBe(status)
	expect(JSON.parse(response.body)).toEqual(body)
	expect(response.body).toBe(canonicalBytes(body).toString("utf8"))
	expect(response.headers["cache-control"]).toBe("no-store")
	expect(response.headers["etag"]).toBeUndefined()
}

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

describe("regional routes on actual legacy ApiServer", () => {
	it("production unavailable and all six unsupported regions remain normal successful states", async () => {
		const { app } = await setup()
		for (const region of ["EU", "US", "CA", "AU", "NZ", "JP", "CN"]) {
			const families = await app.inject(
				`/api/regional/families?region=${region}`,
			)
			expect(families.statusCode).toBe(200)
			const body = families.json<RegionalFamiliesResult>()
			expect(body.selection).toEqual({
				requestedRegion: region,
				source: "query",
				coarseContext: null,
			})
			if (region === "US")
				expect(body).toMatchObject({
					state: "available",
					families: [
						{
							state: "unavailable",
							datasetVersion: null,
							reason: "evidence-pending",
						},
					],
				})
			else expect(body).toMatchObject({ state: "unsupported", families: [] })
			for (const [route, query] of [
				["channels", ""],
				["resolve", "&alias=test"],
			]) {
				const response = await app.inject(
					`/api/regional/${route}?region=${region}&family=frs${query}`,
				)
				expect(response.statusCode).toBe(200)
				expect(response.json()).toMatchObject({
					state: region === "US" ? "unavailable" : "unsupported",
				})
				expect(response.json()).not.toHaveProperty("rows")
				expect(response.json()).not.toHaveProperty("dataset")
				expect(response.headers["cache-control"]).toBe("no-store")
			}
		}
	})
	it("synthetic verified/empty pages and matched/ambiguous/miss use exact canonical bytes", async () => {
		for (const provider of [synthetic(0), synthetic(3, true)]) {
			const observed = observe(provider)
			const { app } = await setup({ registry: observed })
			for (const [url, expected] of [
				["/api/regional/families?region=US", provider.listFamilies("US")],
				[
					"/api/regional/channels?region=US&family=frs",
					provider.listChannels({ region: "US", family: "frs" }),
				],
				[
					"/api/regional/channels?region=US&family=frs&offset=1&limit=1",
					provider.listChannels({
						region: "US",
						family: "frs",
						offset: 1,
						limit: 1,
					}),
				],
				[
					"/api/regional/resolve?region=US&family=frs&alias=test+0",
					provider.resolveAlias({
						region: "US",
						family: "frs",
						alias: "test 0",
					}),
				],
				[
					"/api/regional/resolve?region=US&family=frs&alias=shared",
					provider.resolveAlias({
						region: "US",
						family: "frs",
						alias: "shared",
					}),
				],
				[
					"/api/regional/resolve?region=US&family=frs&alias=missing",
					provider.resolveAlias({
						region: "US",
						family: "frs",
						alias: "missing",
					}),
				],
			] as const)
				assertLocal(await app.inject(url), 200, expected)
			expect(observed.listChannels).toHaveBeenCalledWith({
				region: "US",
				family: "frs",
				offset: 0,
				limit: 64,
			})
		}
	})
	it("null, absent mount and syntactically unknown family remain distinct", async () => {
		const absent = await setup({ unmounted: true })
		expect(
			(await absent.app.inject("/api/regional/families?region=US")).statusCode,
		).toBe(404)
		const missing = await setup({ registry: null })
		assertLocal(
			await missing.app.inject(
				"/api/regional/channels?region=US&family=unknown",
			),
			503,
			unavailable,
		)
		const present = await setup()
		assertLocal(
			await present.app.inject(
				"/api/regional/channels?region=US&family=unknown",
			),
			404,
			{
				error: "Not Found",
				code: "REGIONAL_FAMILY_NOT_FOUND",
				message: "Regional family not found",
			},
		)
	})
	it("strict once-only form decoding preserves plus/percent/delimiters/zeros", async () => {
		const registry = observe(synthetic())
		const { app } = await setup({ registry })
		for (const [encoded, expected] of [
			["++TEST+++0++", "test 0"],
			["a%2Bb", "a+b"],
			["%252B", "%2b"],
			["a%26b%3Dc", "a&b=c"],
			["FRS+01", "frs 01"],
		]) {
			const response = await app.inject(
				`/api/regional/resolve?region=US&family=frs&alias=${encoded}`,
			)
			expect(response.statusCode).toBe(200)
			expect(response.json()).toMatchObject({
				normalizedAlias: expected,
				result: "matched",
			})
			expect(registry.resolveAlias).toHaveBeenLastCalledWith({
				region: "US",
				family: "frs",
				alias: expected,
			})
		}
	})
	it.each([
		"",
		"?",
		"?region=",
		"?region=us",
		"?region=XX",
		"?region=US&region=US",
		"?region=US&%72egion=US",
		"?%78=US&region=US",
		"?region=US&",
		"?&region=US",
		"?region=US&&family=frs",
		"?region=US=CA",
		"?=US",
		"?region",
		"?region=US&family=frs&extra=x",
		"?region=%",
		"?region=%0",
		"?region=%GG",
		"?region=%C0%AF",
		"?region=%ED%A0%80",
		"?region=%F4%90%80%80",
		"?region=%E2%82",
		"?region=US%00",
		"?region=US&region=US&region=US&region=US&region=US",
		`?region=US&x=${"a".repeat(1024)}`,
	])("families rejects raw query %s before provider work", async suffix => {
		const registry = observe(
			createRegionalRegistry(createRegionalRegistration()),
		)
		const { app, parser } = await setup({ registry })
		assertLocal(
			await app.inject(`/api/regional/families${suffix}`),
			400,
			invalid,
		)
		expect(registry.listFamilies).not.toHaveBeenCalled()
		expect(parser).not.toHaveBeenCalled()
	})
	it.each([
		"region=US",
		"region=US&family=FRS",
		"region=US&family=frs&offset=00",
		"region=US&family=frs&offset=1025",
		"region=US&family=frs&offset=-1",
		"region=US&family=frs&offset=1.5",
		"region=US&family=frs&offset=1e2",
		"region=US&family=frs&offset=+1",
		"region=US&family=frs&limit=0",
		"region=US&family=frs&limit=129",
		"region=US&family=frs&limit=064",
		"region=US&family=frs&limit=1&limit=2",
	])("channels rejects strict bounds %s without coercion", async query => {
		const registry = observe(synthetic())
		const { app } = await setup({ registry })
		assertLocal(
			await app.inject(`/api/regional/channels?${query}`),
			400,
			invalid,
		)
		expect(registry.listChannels).not.toHaveBeenCalled()
	})
	it.each([
		"",
		"+",
		"%00",
		"%7F",
		"%C3%A9",
		"%ED%A0%80",
		"%F4%90%80%80",
		"a".repeat(33),
	])("resolve rejects decoded alias %s before provider", async alias => {
		const registry = observe(synthetic())
		const { app } = await setup({ registry })
		assertLocal(
			await app.inject(
				`/api/regional/resolve?region=US&family=frs&alias=${alias}`,
			),
			400,
			invalid,
		)
		expect(registry.resolveAlias).not.toHaveBeenCalled()
	})
	// Feature: regional-display-registry, Property 4: Bounds
	// Validates: Requirements 3.3, 3.5
	it("100 generated canonical offset/limit pairs agree with the actual provider page", async () => {
		const registry = synthetic(12)
		const { app } = await setup({ registry })
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 1024 }),
				fc.integer({ min: 1, max: 128 }),
				async (offset, limit) => {
					assertLocal(
						await app.inject(
							`/api/regional/channels?region=US&family=frs&offset=${offset}&limit=${limit}`,
						),
						200,
						registry.listChannels({
							region: "US",
							family: "frs",
							offset,
							limit,
						}),
					)
				},
			),
			{ numRuns: 100 },
		)
	})
	it("framing precedes exact method denial and parsers/provider remain unused", async () => {
		const registry = observe(synthetic())
		const { app, parser } = await setup({ registry })
		for (const path of ["families", "channels", "resolve"]) {
			for (const method of [
				"HEAD",
				"POST",
				"PUT",
				"PATCH",
				"DELETE",
			] as const) {
				const response = await app.inject({
					method,
					url: `/api/regional/${path}?bad=%GG`,
					headers: {
						"content-length": "0",
						"content-type": "application/x-regional-test",
					},
				})
				expect(response.statusCode).toBe(405)
				expect(response.headers.allow).toBe("GET")
				expect(response.headers["cache-control"]).toBe("no-store")
				if (method !== "HEAD") expect(response.json()).toEqual(denied)
				// Injection is routing evidence, not HEAD wire-body evidence.
				const framed = await app.inject({
					method,
					url: `/api/regional/${path}`,
					headers: { "content-type": "application/x-regional-test" },
					payload: "{bad",
				})
				expect(framed.statusCode).toBe(400)
				expect(framed.headers.allow).toBeUndefined()
				if (method !== "HEAD") expect(framed.json()).toEqual(invalid)
			}
		}
		expect(parser).not.toHaveBeenCalled()
		expect(registry.listFamilies).not.toHaveBeenCalled()
		expect(registry.listChannels).not.toHaveBeenCalled()
		expect(registry.resolveAlias).not.toHaveBeenCalled()
	})
	it.each(
		["families", "channels", "resolve"].flatMap(path =>
			headFrames.map(frame => ({ path, ...frame })),
		),
	)(
		"real HEAD wire $path/$name preserves framing-before-method",
		async ({ path, headers, payload, status }) => {
			const registry = observe(synthetic())
			const { server, parser } = await setup({ registry })
			const response = await rawHttp(
				server,
				"HEAD",
				`/api/regional/${path}?bad=invalid`,
				headers,
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
	it.each(["/api/regional/anything", "/api/regional/families/extra"])(
		"real unmatched HEAD %s retains root404 with no wire body",
		async target => {
			const registry = observe(synthetic())
			const { server, parser } = await setup({ registry })
			const response = await rawHttp(server, "HEAD", target)
			expect(response.statusCode).toBe(404)
			expect(response.wireBody.length).toBe(0)
			expect(response.headers["allow"]).toBeUndefined()
			expect(parser).not.toHaveBeenCalled()
			for (const spy of Object.values(registry))
				expect(spy).not.toHaveBeenCalled()
		},
	)
	it("literal raw fragment reaches the legacy mounted hook and rejects without provider/parser work", async () => {
		const registry = observe(synthetic())
		const { server, parser } = await setup({ registry })
		const response = await rawHttp(
			server,
			"GET",
			"/api/regional/resolve?region=US&family=frs&alias=a#b",
		)
		expect(response.statusCode).toBe(400)
		expect(response.wireBody.toString("utf8")).toBe(
			canonicalBytes(invalid).toString("utf8"),
		)
		expect(response.headers["cache-control"]).toBe("no-store")
		expect(parser).not.toHaveBeenCalled()
		for (const spy of Object.values(registry))
			expect(spy).not.toHaveBeenCalled()
	})
	it("GET accepts CL0 but rejects positive framing/TE even empty chunked", async () => {
		const registry = observe(synthetic())
		const { app, parser } = await setup({ registry })
		const url = "/api/regional/families?region=US"
		expect(
			(await app.inject({ url, headers: { "content-length": "0" } }))
				.statusCode,
		).toBe(200)
		registry.listFamilies.mockClear()
		for (const headers of [
			{ "content-length": "1", "content-type": "application/x-regional-test" },
			{ "transfer-encoding": "chunked" },
		]) {
			const response = await app.inject({
				url,
				headers,
				...("content-length" in headers ? { payload: "x" } : {}),
			})
			assertLocal(response, 400, invalid)
		}
		expect(registry.listFamilies).not.toHaveBeenCalled()
		expect(parser).not.toHaveBeenCalled()
	})
	it("accepted noncanonical CL and framed unsupported media/JSON reject before parser", async () => {
		const registry = observe(synthetic())
		const { app, parser } = await setup({ registry })
		assertLocal(
			await app.inject({
				url: "/api/regional/families?region=US",
				headers: { "content-length": "00" },
			}),
			400,
			invalid,
		)
		for (const contentType of [
			"application/json",
			"application/unsupported-test",
		]) {
			assertLocal(
				await app.inject({
					method: "POST",
					url: "/api/regional/families?region=US",
					headers: { "content-type": contentType },
					payload: "{bad",
				}),
				400,
				invalid,
			)
		}
		assertLocal(
			await app.inject("/api/regional/resolve?region=US&family=frs&alias=a=b"),
			400,
			invalid,
		)
		expect(parser).not.toHaveBeenCalled()
		for (const spy of Object.values(registry))
			expect(spy).not.toHaveBeenCalled()
	})
	it("unmatched HEAD/extra segments and OPTIONS retain existing legacy behavior", async () => {
		const registry = observe(synthetic())
		const { app } = await setup({ registry })
		for (const url of [
			"/api/regional/anything",
			"/api/regional/families/extra",
		]) {
			const response = await app.inject({ method: "HEAD", url })
			expect(response.statusCode).toBe(404)
		}
		const preflight = await app.inject({
			method: "OPTIONS",
			url: "/api/regional/families",
			headers: {
				origin: "http://test.invalid",
				"access-control-request-method": "GET",
			},
		})
		expect(preflight.statusCode).toBe(204)
		expect(preflight.headers["access-control-allow-origin"]).toBeDefined()
		expect(registry.listFamilies).not.toHaveBeenCalled()
	})
	it("provider throws and inherited poison cannot leak through feature serialization", async () => {
		const registry = observe(synthetic())
		const { app } = await setup({ registry, poison: true })
		assertLocal(
			await app.inject("/api/regional/families?region=US"),
			200,
			synthetic().listFamilies("US"),
		)
		registry.listFamilies.mockImplementation(() => {
			throw new WaveKitError("secret path/alias", "PRIVATE_PROVIDER_FAILURE")
		})
		assertLocal(
			await app.inject("/api/regional/families?region=US"),
			503,
			unavailable,
		)
	})
	it.each(
		["families", "channels", "resolve"].flatMap(path =>
			[false, true].map(parentPoison => ({ path, parentPoison })),
		),
	)(
		"complete legacy parent envelope $path/schemaPoison=$parentPoison",
		async ({ path, parentPoison }) => {
			const registry = observe(synthetic())
			const { app, parser } = await setup({
				registry,
				rootFault: true,
				parentPoison,
			})
			const control = await app.inject("/__regional-parent-control")
			const response = await app.inject(
				`/api/regional/${path}?region=US&family=frs&alias=shared`,
			)
			expect(control.statusCode).toBe(400)
			expect(control.json()).toMatchObject({
				code: "PARENT_FIXTURE_FAILURE",
				error: "WaveKitError",
				message: "Parent fixture failure",
			})
			assertParent(control, response)
			expect(parser).not.toHaveBeenCalled()
			for (const spy of Object.values(registry))
				expect(spy).not.toHaveBeenCalled()
		},
	)
	it("faulty closed/semantic channels outputs reject before publication", async () => {
		const real = synthetic()
		const registry = observe(real)
		const { app } = await setup({ registry })
		const good = real.listChannels({ region: "US", family: "frs" })
		if (good.state !== "verified") throw new Error("TEST verified expected")
		const faults: unknown[] = [
			{ ...good, private: "secret" },
			{ ...good, selection: { ...good.selection, requestedRegion: "CA" } },
			{ ...good, rows: [good.rows[0], good.rows[0], good.rows[2]] },
			{ ...good, total: 129 },
			{ ...good, nextOffset: 3 },
			{ ...good, limit: 1 },
			{ ...good, dataset: { ...good.dataset, private: true } },
			{
				...good,
				rows: [
					{
						...good.rows[0],
						frequency: {
							kind: "duplex",
							stationReceiveHz: 1,
							stationTransmitHz: 2,
							endpoint: "subscriber",
						},
					},
					...good.rows.slice(1),
				],
			},
			{
				...good,
				rows: [
					{ ...good.rows[0], sourceReferenceIds: ["missing"] },
					...good.rows.slice(1),
				],
			},
			{ ...good, rows: [...good.rows].reverse() },
			{ ...good, huge: "x".repeat(128 * 1024) },
		]
		for (const fault of faults) {
			registry.listChannels.mockReturnValue(fault as RegionalChannelsResult)
			assertLocal(
				await app.inject("/api/regional/channels?region=US&family=frs"),
				503,
				unavailable,
			)
		}
		let calls = 0
		const getter = Object.defineProperty({}, "selection", {
			enumerable: true,
			get() {
				calls++
				return good.selection
			},
		})
		registry.listChannels.mockReturnValue(getter as RegionalChannelsResult)
		assertLocal(
			await app.inject("/api/regional/channels?region=US&family=frs"),
			503,
			unavailable,
		)
		expect(calls).toBe(0)
	})
	it("a closed valid-shaped oversized page fails its actual byte cap rather than an extra field", async () => {
		const real = synthetic()
		const registry = observe(real)
		const { app } = await setup({ registry })
		const base = real.listChannels({ region: "US", family: "frs" })
		if (base.state !== "verified") throw new Error("TEST verified expected")
		const source = base.dataset.sourceReferences[0]!
		const sourceReferences = Array.from({ length: 4 }, (_, index) => ({
			...source,
			id: `test-source-${index}-`.padEnd(64, "x"),
		}))
		const citations = sourceReferences.map(reference => reference.id).sort()
		const rows = Array.from({ length: 128 }, (_, index) => ({
			...base.rows[0]!,
			id: `us-frs-test-${index}-`.padEnd(64, "x"),
			displayLabel: "😀".repeat(80),
			aliases: Array.from({ length: 8 }, (_, alias) =>
				`test-${index}-${alias}-`.padEnd(32, "x"),
			).sort(),
			frequency: { kind: "simplex" as const, frequencyHz: index + 1 },
			sourceReferenceIds: citations,
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
		assertLocal(
			await app.inject("/api/regional/channels?region=US&family=frs&limit=128"),
			503,
			unavailable,
		)
		expect(registry.listChannels).toHaveBeenCalledTimes(1)
	})
	it("faulty families/resolve cardinality, alias, citations and state cannot escape", async () => {
		const real = synthetic(3, true)
		const registry = observe(real)
		const { app } = await setup({ registry })
		const families = real.listFamilies("US")
		for (const fault of [
			{ ...families, families: [] },
			{ ...families, extra: true },
			{
				...families,
				state: "unsupported",
				reason: "region-not-covered",
				families: [],
			},
		]) {
			registry.listFamilies.mockReturnValue(fault as RegionalFamiliesResult)
			assertLocal(
				await app.inject("/api/regional/families?region=US"),
				503,
				unavailable,
			)
		}
		const resolved = real.resolveAlias({
			region: "US",
			family: "frs",
			alias: "shared",
		})
		if (resolved.state !== "verified") throw new Error("TEST verified expected")
		for (const fault of [
			{ ...resolved, result: "matched" },
			{ ...resolved, normalizedAlias: "other" },
			{ ...resolved, candidates: [] },
			{
				...resolved,
				candidates: resolved.candidates.map(row => ({
					...row,
					aliases: ["other"],
				})),
			},
			{ ...resolved, selection: { ...resolved.selection, extra: true } },
		]) {
			registry.resolveAlias.mockReturnValue(fault as RegionalResolveResult)
			assertLocal(
				await app.inject(
					"/api/regional/resolve?region=US&family=frs&alias=shared",
				),
				503,
				unavailable,
			)
		}
	})
})
