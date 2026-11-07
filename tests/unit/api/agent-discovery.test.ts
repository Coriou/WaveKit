/**
 * A fresh agent learns the API by reading it: the route index, the OpenAPI document, the
 * closed value lists and the 400s, through the real ApiServer composition.
 */
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	API_ENUMS_PATH,
	DECODER_INPUT_STATES,
	DECODER_RECEPTION_HINTS,
	DECODER_VERDICT_CODES,
	SCANNER_PASSIVE_REASONS,
	SCANNER_RECORDER_DECISIONS,
	SOURCE_DEVICE_FACTS,
	SOURCE_VERDICT_CODES,
	TUNER_CHANGE_ACTORS,
	TUNER_CHANGE_FIELDS,
	TUNE_RESTORE_CANCEL_REASONS,
	TUNE_RESTORE_STATUSES,
	TUNE_SETTINGS,
	TUNER_CHANGE_REASONS,
	BANDPLAN_SCANNER_PROTOCOLS,
	OPENAPI_DOCUMENT_PATH,
	RECORDING_INVENTORY_KINDS,
	RECORDINGS_PAGE_LIMIT_MAX,
} from "@wavekit/api-types"
import type { ApiEnums, ApiRouteIndex, ScanJobSpec } from "@wavekit/api-types"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeOptions } from "../../../src/access/runtime-context.js"
import { API_ENUMS } from "../../../src/api/routes/enums.js"
import {
	discoveryQuerySchema,
	protocolEnum,
	scanJobSpecSchema,
} from "../../../src/api/routes/scanner-schemas.js"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { DEFAULT_ACTIVITY_QUERY_LIMITS } from "../../../src/core/activity/query/service.js"
import { normaliseQuery } from "../../../src/core/activity/query/validate.js"
import { createRecordingInventory } from "../../../src/core/recordings/inventory.js"

// Compile-time: every ScanJobSpec key survives the unknown-field check on plan and job create.
const specKeysKnown: Exclude<
	keyof ScanJobSpec,
	keyof typeof scanJobSpecSchema.properties
> extends never
	? true
	: never = true
void specKeysKnown

const host = "receiver.lan:9000"
const origin = `http://${host}`
const logger = pino({ level: "silent" })
const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step()
})

function fakeScanner() {
	return Object.assign(new EventEmitter(), {
		settings: () => ({ ws: { maxMessagesPerSecond: 10 } }),
		preview: vi.fn(() => ({ issues: [] })),
		createJob: vi.fn(() => Promise.resolve({ id: "j_1" })),
		listDiscoveries: vi.fn(() => ({ items: [], nextCursor: null })),
		status: () => ({ enabled: true, engines: [] }),
	})
}

function dependencies(
	scanner: ReturnType<typeof fakeScanner>,
	extra: Partial<ApiServerDependencies> = {},
): ApiServerDependencies {
	return {
		logger,
		scanner,
		sourceManager: Object.assign(new EventEmitter(), {
			getAllStatus: () => [],
		}),
		decoderManager: Object.assign(new EventEmitter(), {
			getAllDecoders: () => [],
			getAllStatus: () => [],
			getAllHealth: () => new Map(),
		}),
		fanoutManager: Object.assign(new EventEmitter(), {
			getTelemetrySnapshot: () => ({
				timestamp: new Date().toISOString(),
				branches: [],
				backpressureActiveCount: 0,
				droppedBytesTotal: 0,
				droppedChunksTotal: 0,
			}),
		}),
		audioOutput: Object.assign(new EventEmitter(), {
			getConnectedClients: () => 0,
			getPort: () => 0,
		}),
		...extra,
	} as unknown as ApiServerDependencies
}

async function protectedServer() {
	const root = await fs.mkdtemp(join(tmpdir(), "agent-discovery-"))
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
	const directory = join(root, "private")
	const options: NamedAccessRuntimeOptions = {
		directory,
		ownership: "single-host-pid-namespace",
		bootstrap: {
			mode: "protected",
			listenerScheme: "http",
			allowedAuthorities: [host],
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
	const storage = await PrivateAccessStorage.open({
		directory,
		mode: "provision",
		ownership: "single-host-pid-namespace",
	})
	const token = storage.useMachineCredential(value => value)
	await storage.close()
	const access = await openAccessRuntime(options)
	cleanup.push(() => access.close())
	const scanner = fakeScanner()
	const server = new ApiServer(
		dependencies(scanner, {
			access,
			recordingInventory: createRecordingInventory({
				dsdFmeDirs: () => [],
				scannerRecordingsDir: () => null,
				logger,
			}),
		}),
		{
			host: "127.0.0.1",
			port: 0,
			accessBootstrap: options.bootstrap,
			publicOrigins: {
				api: origin,
				analogAudio: "http://receiver.lan:9001",
				digitalAudio: "http://receiver.lan:9002",
			},
		},
	)
	cleanup.push(() => server.stop())
	await server.start()
	const app = server.getApp()
	const headers = { host, authorization: `Bearer ${token}` }
	return {
		app,
		scanner,
		token,
		headers,
		get: (url: string) => app.inject({ url, headers }),
		post: (url: string, payload: object) =>
			app.inject({ method: "POST", url, headers, payload }),
	}
}

interface OpenApiDoc {
	servers?: unknown
	security?: unknown
	components: { securitySchemes?: unknown }
	paths: Record<
		string,
		{
			get: {
				parameters?: { name: string; schema: { maximum?: number } }[]
				responses: Record<string, { content?: unknown }>
			}
		}
	>
}

const limitOf = (doc: OpenApiDoc, path: string) =>
	doc.paths[path]?.get.parameters?.find(p => p.name === "limit")?.schema.maximum

interface ErrorBody {
	code: string
	message: string
	fields: { field: string; expected: string }[]
}

describe("route index and OpenAPI document under access", () => {
	it("answers only with a credential: 401 without, 200 with the machine bearer", async () => {
		const env = await protectedServer()
		for (const url of ["/api", OPENAPI_DOCUMENT_PATH, API_ENUMS_PATH]) {
			const denied = await env.app.inject({ url, headers: { host } })
			expect(denied.statusCode).toBe(401)
			expect(denied.body).not.toContain("protocols")
			expect((await env.get(url)).statusCode).toBe(200)
		}
	})

	it("the index points at the OpenAPI document and the enums, and both resolve", async () => {
		const env = await protectedServer()
		const index = (await env.get("/api")).json<ApiRouteIndex>()
		expect(index.openapi).toBe(OPENAPI_DOCUMENT_PATH)
		expect(index.enums).toBe(API_ENUMS_PATH)
		expect(
			(await env.get(index.openapi)).json<OpenApiDoc>().paths,
		).toHaveProperty([API_ENUMS_PATH])
		expect((await env.get(index.enums)).json<ApiEnums>()).toEqual(
			JSON.parse(JSON.stringify(API_ENUMS)),
		)
		expect(index.routes).toContainEqual({
			method: "GET",
			path: API_ENUMS_PATH,
			summary: "Accepted values of the closed lists (static)",
			tags: ["system"],
		})
	})

	it("the document holds no credential and no bind address, and states the bearer scheme", async () => {
		const env = await protectedServer()
		const res = await env.get(OPENAPI_DOCUMENT_PATH)
		expect(res.body).not.toContain(env.token)
		expect(res.body).not.toContain("127.0.0.1")
		const doc = res.json<OpenApiDoc>()
		expect(doc.servers).toBeUndefined()
		expect(doc.components.securitySchemes).toEqual({
			machineToken: { type: "http", scheme: "bearer" },
		})
		expect(doc.security).toEqual([{ machineToken: [] }])
	})

	it("a core without access serves the same discovery with no bearer scheme", async () => {
		const server = new ApiServer(dependencies(fakeScanner()), {
			host: "127.0.0.1",
			port: 0,
		})
		cleanup.push(() => server.stop())
		await server.start()
		const app = server.getApp()
		const doc = (await app.inject(OPENAPI_DOCUMENT_PATH)).json<OpenApiDoc>()
		expect(doc.servers).toBeUndefined()
		expect(doc.security).toBeUndefined()
		expect((await app.inject(API_ENUMS_PATH)).statusCode).toBe(200)
		expect((await app.inject("/api")).json<ApiRouteIndex>().enums).toBe(
			API_ENUMS_PATH,
		)
	})
})

describe("GET /api/enums", () => {
	it("reuses the lists the routes validate against", () => {
		expect(API_ENUMS.scanner.protocols).toBe(protocolEnum)
		expect(API_ENUMS.scanner.jobModes).toBe(
			scanJobSpecSchema.properties.mode.enum,
		)
		expect(API_ENUMS.recordings.kinds).toBe(RECORDING_INVENTORY_KINDS)
		expect(API_ENUMS.tuner).toEqual({
			gainModes: ["manual", "agc"],
			directSamplingModes: ["off", "i", "q"],
			controlModes: ["internal", "external"],
			changeActors: TUNER_CHANGE_ACTORS,
			changeReasons: TUNER_CHANGE_REASONS,
			changeFields: TUNER_CHANGE_FIELDS,
			tuneSettings: TUNE_SETTINGS,
			tuneRestoreStatuses: TUNE_RESTORE_STATUSES,
			tuneRestoreCancelReasons: TUNE_RESTORE_CANCEL_REASONS,
		})
		expect(API_ENUMS.scanner.recorderDecisions).toBe(SCANNER_RECORDER_DECISIONS)
		expect(API_ENUMS.scanner.passiveReasons).toBe(SCANNER_PASSIVE_REASONS)
		expect(API_ENUMS.sources).toEqual({
			verdictCodes: SOURCE_VERDICT_CODES,
			deviceFacts: SOURCE_DEVICE_FACTS,
		})
		expect(API_ENUMS.decoders).toEqual({
			verdictCodes: DECODER_VERDICT_CODES,
			receptionHints: DECODER_RECEPTION_HINTS,
			inputStates: DECODER_INPUT_STATES,
		})
		expect([...protocolEnum].sort()).toEqual(
			[...BANDPLAN_SCANNER_PROTOCOLS].sort(),
		)
	})

	it("every activity kind and category is one the query validator accepts", () => {
		const { kinds, categories } = API_ENUMS.activity
		expect(
			normaliseQuery({ kinds, categories }, DEFAULT_ACTIVITY_QUERY_LIMITS)
				.kinds,
		).toEqual([...kinds].sort())
		expect(() =>
			normaliseQuery({ kinds: ["not-a-kind"] }, DEFAULT_ACTIVITY_QUERY_LIMITS),
		).toThrow()
	})

	it("the OpenAPI document states the values too", async () => {
		const env = await protectedServer()
		const res = await env.get(OPENAPI_DOCUMENT_PATH)
		const enums = JSON.stringify(
			res.json<OpenApiDoc>().paths[API_ENUMS_PATH]?.get.responses["200"],
		)
		for (const value of protocolEnum) expect(enums).toContain(`"${value}"`)
	})
})

describe.each([
	["/api/scanner/plan", 200, "preview"],
	["/api/scanner/jobs", 201, "createJob"],
] as const)("POST %s protocols", (url, okStatus, method) => {
	it("takes every accepted value; one past the list is a 400 listing them all", async () => {
		const env = await protectedServer()
		const all = await env.post(url, { protocols: [...protocolEnum] })
		expect(all.statusCode).toBe(okStatus)
		const res = await env.post(url, { protocols: ["ECHO-protocol"] })
		expect(res.statusCode).toBe(400)
		expect(res.body).not.toContain("ECHO-protocol")
		const body = res.json<ErrorBody>()
		expect(body.code).toBe("VALIDATION_ERROR")
		expect(body.fields[0]?.field).toBe("protocols.0")
		for (const value of protocolEnum)
			expect(body.fields[0]?.expected).toContain(`"${value}"`)
		expect(env.scanner[method]).toHaveBeenCalledTimes(1)
	})

	it("a value outside the list inside a range is a 400 at that range", async () => {
		const env = await protectedServer()
		const res = await env.post(url, {
			ranges: [{ startHz: 1, endHz: 2, protocols: ["ECHO-protocol"] }],
		})
		expect(res.statusCode).toBe(400)
		expect(res.json<ErrorBody>().fields[0]?.field).toBe("ranges.0.protocols.0")
	})

	it("absent protocols keep their meaning and reach the service absent", async () => {
		const env = await protectedServer()
		expect((await env.post(url, {})).statusCode).toBe(okStatus)
		expect(env.scanner[method]).toHaveBeenCalledWith({})
		expect((await env.post(url, { protocols: [] })).statusCode).toBe(okStatus)
		expect(env.scanner[method]).toHaveBeenLastCalledWith({ protocols: [] })
	})

	it("a misspelled top-level key is a 400 naming the accepted fields, not an absent one", async () => {
		const env = await protectedServer()
		const res = await env.post(url, { protocol: ["dmr"], "ECHO-key": 1 })
		expect(res.statusCode).toBe(400)
		expect(res.body).not.toContain("ECHO-key")
		const body = res.json<ErrorBody>()
		expect(body.code).toBe("VALIDATION_ERROR")
		expect(body.fields).toHaveLength(1)
		expect(body.fields[0]?.field).toBe("body")
		for (const name of Object.keys(scanJobSpecSchema.properties))
			expect(body.fields[0]?.expected).toContain(name)
		expect(env.scanner[method]).not.toHaveBeenCalled()
	})

	it("admission runs before the unknown-field check", async () => {
		const env = await protectedServer()
		const res = await env.app.inject({
			method: "POST",
			url,
			headers: { host },
			payload: { protocol: ["dmr"] },
		})
		expect(res.statusCode).toBe(401)
	})
})

describe("page limits are discoverable", () => {
	it("GET /api/recordings: at the maximum 200 with items, past it a 400 stating it", async () => {
		const env = await protectedServer()
		const at = await env.get(
			`/api/recordings?limit=${RECORDINGS_PAGE_LIMIT_MAX}`,
		)
		expect(at.statusCode).toBe(200)
		expect(at.json<{ items: unknown[] }>().items).toEqual([])
		for (const limit of [RECORDINGS_PAGE_LIMIT_MAX + 1, 500, 0]) {
			const past = await env.get(`/api/recordings?limit=${limit}`)
			expect(past.statusCode).toBe(400)
			const body = past.json<ErrorBody>()
			expect(body.code).toBe("RECORDINGS_QUERY_INVALID")
			expect(body.fields).toEqual([
				{
					field: "limit",
					expected: `integer (1 to ${RECORDINGS_PAGE_LIMIT_MAX}), one value`,
				},
			])
		}
	})

	it("GET /api/recordings: a denial still wins over a bad query", async () => {
		const env = await protectedServer()
		const res = await env.app.inject({
			url: `/api/recordings?limit=${RECORDINGS_PAGE_LIMIT_MAX + 1}`,
			headers: { host },
		})
		expect(res.statusCode).toBe(401)
	})

	it("GET /api/scanner/discoveries: at the maximum 200, past it a 400 stating it", async () => {
		const env = await protectedServer()
		const max = discoveryQuerySchema.properties.limit.maximum
		const at = await env.get(`/api/scanner/discoveries?limit=${max}`)
		expect(at.statusCode).toBe(200)
		expect(at.json<{ items: unknown[] }>().items).toEqual([])
		const past = await env.get(`/api/scanner/discoveries?limit=${max + 1}`)
		expect(past.statusCode).toBe(400)
		expect(past.json<ErrorBody>().fields).toEqual([
			{ field: "limit", expected: `integer (1 to ${max})` },
		])
	})

	it("the OpenAPI document states both maximums", async () => {
		const env = await protectedServer()
		const doc = (await env.get(OPENAPI_DOCUMENT_PATH)).json<OpenApiDoc>()
		expect(limitOf(doc, "/api/recordings")).toBe(RECORDINGS_PAGE_LIMIT_MAX)
		expect(limitOf(doc, "/api/scanner/discoveries")).toBe(
			discoveryQuerySchema.properties.limit.maximum,
		)
	})
})
