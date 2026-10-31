/**
 * Every HTTP 400 validation answer names the failing field(s) and what each accepts, in
 * static text: the full API server is built with in-process fakes, every registered
 * POST/PUT/PATCH route and every GET route that reads a query (by schema or in its
 * handler) gets invalid input carrying a sentinel. Each 400 must name a field, every write
 * route must refuse with a 400, and no answer of any status may repeat the sentinel.
 */

import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { FastifyInstance, InjectOptions } from "fastify"
import {
	ApiServer,
	type ApiServerConfig,
	type ApiServerDependencies,
} from "../../../src/api/server.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import {
	openAccessRuntime,
	type NamedAccessRuntimeContext,
} from "../../../src/access/runtime-context.js"
import { BandGainSettingsError } from "../../../src/core/band-gain.js"
import { StationUpdateError } from "../../../src/core/station/errors.js"
import { RecordingInventoryError } from "../../../src/core/recordings/inventory.js"
import { ScannerApiError } from "../../../src/core/scanner/errors.js"
import { staticPlanIssues } from "../../../src/api/routes/scanner-plan-issues.js"
import { BAND_GAIN_MIN_HZ } from "@wavekit/api-types"
import { createLogger } from "../../../src/utils/logger.js"
import {
	ajvValidationFields,
	describeJsonSchema,
	unitFromName,
	zodValidationFields,
	MAX_VALIDATION_FIELDS,
	REFUSED_BY_RULE,
} from "../../../src/api/validation-errors.js"

const SENTINEL = "zq7-INJECTED-sentinel"

/**
 * Closed error contracts that name no field by design, out of scope here: the regional
 * registry and receiver capabilities answer one fixed byte-exact body typed in
 * @wavekit/api-types, and the access protocol answers a bare `{ code }`.
 */
const CLOSED_CONTRACTS = [
	"/api/regional",
	"/api/receiver-capabilities",
	"/api/access/",
]

/** Any method returns undefined; events work; never a thenable. */
function fake(base: object = new EventEmitter()): never {
	return new Proxy(base, {
		get(target, prop) {
			if (prop in target) {
				const value: unknown = Reflect.get(target, prop)
				return typeof value === "function"
					? (value as (...args: unknown[]) => unknown).bind(target)
					: value
			}
			if (prop === "then" || typeof prop === "symbol") return undefined
			return vi.fn(() => undefined)
		},
	}) as never
}

interface Route {
	method: string
	url: string
	schema: Record<string, unknown> | undefined
}

interface Answer {
	route: string
	request: string
	status: number
	body: string
}

/** Sends invalid input to every write route and every GET route with a query schema. */
async function sweep(
	app: FastifyInstance,
	routes: readonly Route[],
	headers: Record<string, string> = {},
): Promise<Answer[]> {
	const answers: Answer[] = []
	const send = async (
		route: Route,
		request: string,
		options: InjectOptions,
	) => {
		const res = await app.inject({
			...options,
			headers: { ...headers, ...options.headers },
		})
		answers.push({
			route: `${route.method} ${route.url}`,
			request,
			status: res.statusCode,
			body: res.body,
		})
	}

	for (const route of routes) {
		if (CLOSED_CONTRACTS.some(prefix => route.url.startsWith(prefix))) continue
		if (route.url.startsWith("/ws") || route.url.startsWith("/docs")) continue
		const url = pathFor(route.url)
		if (["POST", "PUT", "PATCH"].includes(route.method)) {
			const method = route.method as "POST" | "PUT" | "PATCH"
			const json = { "content-type": "application/json" }
			await send(route, "unknown key", {
				method,
				url,
				headers: json,
				payload: JSON.stringify({ [SENTINEL]: SENTINEL }),
			})
			await send(route, "string body", {
				method,
				url,
				headers: json,
				payload: JSON.stringify(SENTINEL),
			})
			await send(route, "malformed JSON", {
				method,
				url,
				headers: json,
				payload: `{"${SENTINEL}`,
			})
			const props = bodyProperties(route.schema)
			if (props.length > 0)
				await send(route, "every field the sentinel", {
					method,
					url,
					headers: json,
					payload: JSON.stringify(
						Object.fromEntries(props.map(p => [p, SENTINEL])),
					),
				})
		} else if (route.method === "GET") {
			// Routes with a declared query, and routes that parse their query in the
			// handler (no schema, or one that admits any parameter): both get the
			// sentinel, as an unknown parameter and under each name a handler reads.
			const declared = queryProperties(route.schema)
			if (!route.schema?.["querystring"] && route.url.includes("/:")) continue
			await send(route, "unknown parameter", {
				method: "GET",
				url: `${url}?${SENTINEL}=${SENTINEL}`,
			})
			const names =
				declared.length > 0 ? declared : [...HANDLER_QUERY_PARAMETERS]
			for (const prop of names)
				await send(route, `${prop}=sentinel`, {
					method: "GET",
					url: `${url}?${prop}=${SENTINEL}`,
				})
		}
	}
	return answers
}

/**
 * Query parameter names the handler-parsed GET routes read (Activity search, trails,
 * bandmap and timeline; coverage). Sent to every GET route without declared parameters.
 */
const HANDLER_QUERY_PARAMETERS = [
	"protocol",
	"protocols",
	"categories",
	"entityKey",
	"bucketMs",
	"frequencyMin",
	"producedFrom",
	"text",
	"refs",
	"order",
	"limit",
	"pageToken",
] as const

/** Routes that parse their query in the handler; each must refuse the sentinel with a 400. */
const HANDLER_PARSED_ROUTES = [
	"GET /api/coverage",
	"GET /api/activity",
	"GET /api/activity/trails",
	"GET /api/activity/bandmap",
	"GET /api/activity/timeline",
	"GET /api/recordings",
]

function pathFor(url: string): string {
	return url.replace(/:(\w+)/g, (_m, name: string) =>
		name === "sourceId" ? "rtl" : "x1",
	)
}

function bodyProperties(schema: Route["schema"]): string[] {
	const body = schema?.["body"] as { properties?: object } | undefined
	return body?.properties ? Object.keys(body.properties) : []
}

function queryProperties(schema: Route["schema"]): string[] {
	const query = schema?.["querystring"] as { properties?: object } | undefined
	return query?.properties ? Object.keys(query.properties) : []
}

/** Hz a test range sends: a plan issue message would quote it. */
const SENTINEL_HZ = 7_654_321

/**
 * The scanner's semantic refusals of a schema-valid job, worded as the core words them:
 * plan issues quote bandplan ids, range edges, the job name and the source id.
 */
async function rejectJob(spec: {
	kind?: string
	sourceId?: string
	name?: string
	bandplans?: string[]
	ranges?: { startHz: number; endHz: number }[]
}): Promise<never> {
	if (spec.kind === "monitor")
		throw new ScannerApiError(
			"Listen-scan jobs need the channelizer",
			"SCANNER_MONITOR_UNAVAILABLE",
			400,
		)
	if (spec.sourceId !== undefined)
		throw new ScannerApiError(
			`source ${spec.sourceId} is under external (relay) control`,
			"SCANNER_SOURCE_BUSY",
			409,
			{
				reason: "relay",
				issues: [
					{
						code: "source-busy",
						severity: "error",
						message: `source ${spec.sourceId} is under external (relay) control`,
						details: { sourceId: spec.sourceId },
					},
				],
			},
		)
	throw new ScannerApiError(
		"The job spec has errors",
		"SCANNER_PLAN_INVALID",
		400,
		{
			issues: [
				...(spec.bandplans ?? []).map(id => ({
					code: "range-empty",
					severity: "error",
					message: `bandplan ${id} is not available in region EU`,
					details: { bandplan: id },
				})),
				...(spec.ranges ?? []).map(r => ({
					code: "range-empty",
					severity: "error",
					message: `range ${r.startHz}-${r.endHz} Hz is empty or inverted`,
					details: { range: r },
				})),
				{
					code: "poi-low",
					severity: "warning",
					message: `detection POI is low for ${spec.name ?? "the job"}`,
				},
			],
		},
	)
}

/**
 * Schema-valid bodies a later rule refuses (a Zod refinement, the scanner plan preview),
 * each carrying the sentinel where the refusal could quote it. `protectedOnly` routes
 * mount with access configured.
 */
const SEMANTIC_BODIES: readonly {
	route: string
	request: string
	method: "POST" | "PUT" | "PATCH"
	url: string
	payload: unknown
	protectedOnly?: boolean
}[] = [
	{
		route: "POST /api/scanner/jobs",
		request: "monitor job without the channelizer",
		method: "POST",
		url: "/api/scanner/jobs",
		payload: { kind: "monitor", name: SENTINEL },
	},
	{
		route: "POST /api/scanner/jobs",
		request: "unknown bandplan, inverted range",
		method: "POST",
		url: "/api/scanner/jobs",
		payload: {
			name: SENTINEL,
			bandplans: [SENTINEL],
			ranges: [{ startHz: SENTINEL_HZ, endHz: SENTINEL_HZ - 1 }],
		},
	},
	{
		route: "POST /api/sources",
		request: "reserved delivery",
		method: "POST",
		url: "/api/sources",
		payload: {
			id: SENTINEL,
			type: "rtl_tcp",
			host: SENTINEL,
			caps: { kind: "iq", sampleRate: 1, format: "U8_IQ", exclusive: false },
			delivery: "channels",
		},
	},
	{
		route: "POST /api/sources",
		request: "gain with agc",
		method: "POST",
		url: "/api/sources",
		payload: {
			id: SENTINEL,
			type: "rtl_tcp",
			caps: { kind: "iq", sampleRate: 1, format: "U8_IQ", exclusive: false },
			tuner: { gainMode: "agc", gainDb: 1 },
		},
	},
	{
		route: "PATCH /api/live-audio/config",
		request: "noise squelch on a refused modulation",
		method: "PATCH",
		url: "/api/live-audio/config",
		payload: { squelchMode: "noise" },
	},
	{
		route: "PUT /api/decoders/:id/band",
		request: "empty override",
		method: "PUT",
		url: "/api/decoders/x1/band",
		payload: {},
	},
	{
		route: "PUT /api/decoders/:id/band",
		request: "inverted range",
		method: "PUT",
		url: "/api/decoders/x1/band",
		payload: { rangesHz: [{ minHz: SENTINEL_HZ, maxHz: SENTINEL_HZ - 1 }] },
	},
	{
		route: "PUT /api/tuner-band-gain",
		request: "overlapping and inverted entries",
		method: "PUT",
		url: "/api/tuner-band-gain",
		payload: {
			applyToMyTuning: false,
			entries: [
				{
					minHz: BAND_GAIN_MIN_HZ + 10,
					maxHz: BAND_GAIN_MIN_HZ + 20,
					gain: "keep",
					label: SENTINEL,
				},
				{
					minHz: BAND_GAIN_MIN_HZ + 15,
					maxHz: BAND_GAIN_MIN_HZ + 30,
					gain: "keep",
					label: SENTINEL,
				},
				{
					minHz: BAND_GAIN_MIN_HZ + 50,
					maxHz: BAND_GAIN_MIN_HZ + 40,
					gain: "keep",
				},
			],
		},
		protectedOnly: true,
	},
]

async function sendSemantic(
	target: FastifyInstance,
	headers: Record<string, string>,
	protectedMode: boolean,
): Promise<Answer[]> {
	const out: Answer[] = []
	for (const body of SEMANTIC_BODIES) {
		if (body.protectedOnly === true && !protectedMode) continue
		const res = await target.inject({
			method: body.method,
			url: body.url,
			payload: JSON.stringify(body.payload),
			headers: { ...headers, "content-type": "application/json" },
		})
		out.push({
			route: body.route,
			request: body.request,
			status: res.statusCode,
			body: res.body,
		})
	}
	return out
}

/** A budget service whose writes are never reached by invalid bodies. */
const efficiencyBudget = fake({ view: () => ({ cpuBudgetCores: "auto" }) })

function fakeDependencies(): ApiServerDependencies {
	const decoderManager = fake(
		Object.assign(new EventEmitter(), {
			getAllStatus: () => [],
			getAllHealth: () => new Map(),
			getDecoder: (id: string) =>
				id === "x1"
					? fake(
							Object.assign(new EventEmitter(), {
								getStatus: () => ({ running: false }),
							}),
						)
					: undefined,
			getStatus: () => undefined,
			efficiencyBudget: () => efficiencyBudget,
		}),
	)
	const sourceManager = fake(
		Object.assign(new EventEmitter(), {
			getAllStatus: () => [],
			getStatus: () => undefined,
			getSourceAssignments: () => [],
		}),
	)
	const fanoutManager = fake(
		Object.assign(new EventEmitter(), {
			getTelemetrySnapshot: () => ({
				timestamp: new Date().toISOString(),
				branches: [],
				backpressureActiveCount: 0,
				droppedBytesTotal: 0,
				droppedChunksTotal: 0,
			}),
		}),
	)
	return {
		sourceManager,
		fanoutManager,
		decoderManager,
		audioOutput: fake(),
		tunerController: fake(
			Object.assign(new EventEmitter(), {
				getState: () => undefined,
				getAllStates: () => [],
				bandGainSettings: () => ({
					view: () => ({}),
					put: async () => {
						throw new BandGainSettingsError(
							"Invalid band gain settings",
							"BAND_GAIN_INVALID",
							400,
						)
					},
				}),
			}),
		),
		liveDemod: fake(
			Object.assign(new EventEmitter(), {
				reconfigure: async (updates: { squelchMode?: unknown }) => {
					// The core refinement path: a custom issue whose message could quote the value.
					if (updates.squelchMode !== undefined)
						throw new z.ZodError([
							{
								code: "custom",
								path: ["squelchMode"],
								message: `squelch ${String(updates.squelchMode)} needs nfm or wfm`,
							},
						])
					throw new z.ZodError([
						{
							code: "invalid_type",
							expected: "number",
							received: "string",
							path: ["bandwidth"],
							message: `Expected number, received ${SENTINEL}`,
						},
					])
				},
			}),
		),
		scanner: fake(
			Object.assign(new EventEmitter(), {
				settings: () => ({ ws: { maxMessagesPerSecond: 10 } }),
				createJob: rejectJob,
			}),
		),
		spectrum: fake(),
		vesselTracker: fake(),
		meshTracker: fake(),
		aprsTracker: fake(),
		aircraftTracker: fake(),
		coverage: fake(),
		digitalVoice: fake(),
		resourceAggregator: fake(),
		activity: fake({
			status: "ready",
			service: fake(),
			bindSubscriptions: () => undefined,
		}),
		logger: createLogger({ level: "fatal" }),
	}
}

/** Starts a server, recording every route it registers. */
async function started(
	dependencies: ApiServerDependencies,
	config: ApiServerConfig,
): Promise<{ server: ApiServer; app: FastifyInstance; routes: Route[] }> {
	const server = new ApiServer(dependencies, config)
	servers.push(server)
	const app = server.getApp()
	const routes: Route[] = []
	app.addHook("onRoute", route => {
		for (const method of Array.isArray(route.method)
			? route.method
			: [route.method])
			routes.push({
				method,
				url: route.url,
				schema: route.schema as Route["schema"],
			})
	})
	await server.start()
	return { server, app, routes }
}

const servers: ApiServer[] = []
const contexts: NamedAccessRuntimeContext[] = []
const roots: string[] = []
let app: FastifyInstance
const answers: Answer[] = []
const protectedAnswers: Answer[] = []
const semanticAnswers: Answer[] = []

const origin = "http://receiver.lan:9000"

beforeAll(async () => {
	const legacy = await started(fakeDependencies(), {
		host: "127.0.0.1",
		port: 0,
	})
	app = legacy.app
	answers.push(...(await sweep(app, legacy.routes)))
	semanticAnswers.push(...(await sendSemantic(app, {}, false)))
	answers.push(...semanticAnswers)

	// Access configured: the write routes that mount only in protected mode.
	const root = await fs.mkdtemp(join(tmpdir(), "wavekit-validation-"))
	roots.push(root)
	const directory = join(root, "private")
	const provisioned = await PrivateAccessStorage.open({
		directory,
		mode: "provision",
		ownership: "single-host-pid-namespace",
	})
	const token = provisioned.useMachineCredential(value => value)
	await provisioned.close()
	const bootstrap = {
		mode: "protected" as const,
		listenerScheme: "http" as const,
		allowedAuthorities: ["receiver.lan:9000"],
		allowedOrigins: [origin],
		externalAudioOrigins: [
			"http://receiver.lan:9001",
			"http://receiver.lan:9002",
		],
	}
	const context = await openAccessRuntime({
		directory,
		ownership: "single-host-pid-namespace",
		bootstrap,
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
	})
	contexts.push(context)
	const stationIdentity = {
		name: { value: null, provenance: "default" },
		lat: { value: null, provenance: "default" },
		lon: { value: null, provenance: "default" },
		altM: { value: null, provenance: "default" },
		callsign: { value: null, provenance: "default" },
		country: { value: null, provenance: "default" },
		effectiveCountry: null,
		region: "EU",
	}
	const protectedServer = await started(
		{
			...fakeDependencies(),
			access: context,
			iqSnapshotFanoutFor: () => fake(),
			station: stationIdentity as never,
			stationService: fake({
				identity: () => stationIdentity,
				update: async () => {
					// The core message lists the client's unknown keys: never sent.
					throw new StationUpdateError(
						"STATION_UPDATE_INVALID",
						`Unknown station field(s): ${SENTINEL}`,
					)
				},
			}),
			decoderSettings: fake(),
			recordingInventory: fake({
				list: async () => {
					throw new RecordingInventoryError("RECORDINGS_QUERY_INVALID")
				},
			}),
		},
		{
			host: "127.0.0.1",
			port: 0,
			accessBootstrap: bootstrap,
			publicOrigins: {
				api: origin,
				analogAudio: "http://receiver.lan:9001",
				digitalAudio: "http://receiver.lan:9002",
			},
		},
	)
	const machine = {
		host: "receiver.lan:9000",
		authorization: `Bearer ${token}`,
	}
	protectedAnswers.push(
		...(await sweep(protectedServer.app, protectedServer.routes, machine)),
	)
	const protectedSemantic = await sendSemantic(
		protectedServer.app,
		machine,
		true,
	)
	semanticAnswers.push(...protectedSemantic)
	protectedAnswers.push(...protectedSemantic)
	const recordings = await protectedServer.app.inject({
		method: "GET",
		url: `/api/recordings?limit=${SENTINEL}&${SENTINEL}=1`,
		headers: machine,
	})
	protectedAnswers.push({
		route: "GET /api/recordings",
		request: "bad limit and unknown parameter",
		status: recordings.statusCode,
		body: recordings.body,
	})
}, 60_000)

afterAll(async () => {
	for (const server of servers.splice(0)) await server.stop()
	for (const context of contexts.splice(0)) await context.close()
	for (const root of roots.splice(0))
		await fs.rm(root, { recursive: true, force: true })
})

describe("HTTP 400 validation answers", () => {
	it("exercises the write and query routes of every mounted family", () => {
		const families = new Set(
			answers
				.filter(a => a.status === 400)
				.map(a => a.route.split(" ")[1]?.split("/")[2]),
		)
		for (const family of [
			"tuner",
			"sources",
			"decoders",
			"scanner",
			"live-audio",
			"activity",
			"spectrum",
		])
			expect(families, family).toContain(family)
		// Enough 400s that the sweep is real: well over one per family.
		expect(answers.filter(a => a.status === 400).length).toBeGreaterThan(40)
	})

	it("with access configured, sweeps the protected write routes too", () => {
		const routes = new Set(
			protectedAnswers.filter(a => a.status === 400).map(a => a.route),
		)
		for (const route of [
			"PATCH /api/station",
			"PATCH /api/decoders/:id",
			"PUT /api/decoders/efficiency/budget",
			"POST /api/sources/:sourceId/iq-snapshot",
			"GET /api/recordings",
			"PUT /api/tuner-band-gain",
		])
			expect(routes, route).toContain(route)
	})

	it("every 400 names at least one field with what it accepts", () => {
		const failures: string[] = []
		for (const answer of [...answers, ...protectedAnswers].filter(
			a => a.status === 400,
		)) {
			const body = JSON.parse(answer.body) as {
				message?: unknown
				fields?: unknown
			}
			const fields = Array.isArray(body.fields) ? body.fields : []
			const named =
				fields.length > 0 &&
				fields.every(
					f =>
						typeof f === "object" &&
						f !== null &&
						typeof (f as { field?: unknown }).field === "string" &&
						(f as { field: string }).field.length > 0 &&
						typeof (f as { expected?: unknown }).expected === "string" &&
						(f as { expected: string }).expected.length > 0,
				)
			// PATCH /api/station keeps its existing contract: `fields` lists station field
			// names (the web form marks them) and the message states what each accepts.
			const station =
				answer.route === "PATCH /api/station" &&
				typeof body.message === "string" &&
				/expected/.test(body.message)
			if (!(named || station) || typeof body.message !== "string")
				failures.push(`${answer.route} (${answer.request}): ${answer.body}`)
		}
		expect(failures).toEqual([])
	})

	it("no answer of any status repeats the submitted input", () => {
		const echoes = [...answers, ...protectedAnswers]
			.filter(a => a.body.includes(SENTINEL))
			.map(a => `${a.route} (${a.request}) ${a.status}: ${a.body}`)
		expect(echoes).toEqual([])
	})

	it("every swept write route refuses at least one invalid body with a 400", () => {
		const swept = new Map<string, boolean>()
		for (const answer of [...answers, ...protectedAnswers]) {
			if (!/^(POST|PUT|PATCH) /.test(answer.route)) continue
			swept.set(
				answer.route,
				(swept.get(answer.route) ?? false) || answer.status === 400,
			)
		}
		expect(swept.size).toBeGreaterThan(20)
		const never = [...swept].filter(([, refused]) => !refused).map(([r]) => r)
		expect(never).toEqual([])
	})

	it("routes that parse their query in the handler refuse the sentinel with a 400", () => {
		const refused = new Set(
			[...answers, ...protectedAnswers]
				.filter(a => a.status === 400)
				.map(a => a.route),
		)
		for (const route of HANDLER_PARSED_ROUTES)
			expect(refused, route).toContain(route)
	})

	it("refuses every schema-valid but semantically invalid body with a static 400", () => {
		// Every body without access configured, every body again with it.
		expect(semanticAnswers).toHaveLength(
			2 * SEMANTIC_BODIES.length -
				SEMANTIC_BODIES.filter(b => b.protectedOnly === true).length,
		)
		const wrong = semanticAnswers
			.filter(
				a =>
					a.status !== 400 ||
					a.body.includes(SENTINEL) ||
					a.body.includes(String(SENTINEL_HZ)) ||
					a.body.includes(String(SENTINEL_HZ - 1)),
			)
			.map(a => `${a.route} (${a.request}) ${a.status}: ${a.body}`)
		expect(wrong).toEqual([])
	})

	it("a monitor job without the channelizer names kind and what it accepts", () => {
		const answer = semanticAnswers.find(a => a.request.startsWith("monitor"))
		expect(JSON.parse(answer?.body ?? "null")).toEqual({
			error: "ScannerApiError",
			code: "SCANNER_MONITOR_UNAVAILABLE",
			message: 'Listen-scan jobs need the channelizer: send kind "discover"',
			fields: [
				{
					field: "kind",
					expected:
						'"discover" ("monitor" needs the channelizer, which this receiver does not run)',
				},
			],
		})
	})

	it("an invalid plan keeps details.issues with static messages and names the fields", () => {
		const answer = semanticAnswers.find(a =>
			a.request.startsWith("unknown bandplan"),
		)
		const body = JSON.parse(answer?.body ?? "null") as {
			code: string
			message: string
			fields: { field: string; expected: string }[]
			details: { issues: unknown[] }
		}
		expect(body.code).toBe("SCANNER_PLAN_INVALID")
		// The web app reads details.issues[].code/severity/message.
		expect(body.details.issues).toEqual([
			{
				code: "range-empty",
				severity: "error",
				message: "a requested bandplan is not available in this region",
			},
			{
				code: "range-empty",
				severity: "error",
				message: "a range is empty or inverted, or the sweep has no range",
			},
			{
				code: "poi-low",
				severity: "warning",
				message: "the detection probability for a typical transmission is low",
			},
		])
		expect(body.fields.map(f => f.field)).toEqual(["bandplans", "ranges"])
		expect(body.message).toMatch(/^The job spec has errors; bandplans: /)
	})

	it("a 409 refusal carrying plan issues answers their static form", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/scanner/jobs",
			payload: { sourceId: SENTINEL },
		})
		expect(res.statusCode).toBe(409)
		expect(res.json()).toEqual({
			error: "ScannerApiError",
			code: "SCANNER_SOURCE_BUSY",
			message: "the source is under external (relay) control",
			details: {
				reason: "relay",
				issues: [
					{
						code: "source-busy",
						severity: "error",
						message: "the source is under external (relay) control",
					},
				],
			},
		})
	})

	it("a refused enum value is not advertised as accepted", () => {
		const answer = semanticAnswers.find(a => a.request === "reserved delivery")
		const body = JSON.parse(answer?.body ?? "null") as {
			fields: { field: string; expected: string }[]
		}
		expect(body.fields).toEqual([
			{
				field: "delivery",
				expected:
					'one of "raw" | "auto" (default "auto"); "channels" is reserved and refused',
			},
		])
	})

	it("refinements answer the static rule of their field", () => {
		const fieldsOf = (request: string) =>
			(
				JSON.parse(
					semanticAnswers.find(a => a.request === request)?.body ?? "null",
				) as { fields: { field: string; expected: string }[] }
			).fields
		expect(fieldsOf("gain with agc")).toEqual([
			{
				field: "tuner.gainDb",
				expected:
					'number (0 to 50), dB; a multiple of 0.1 dB; required when tuner.gainMode is "manual", not allowed when it is "agc"',
			},
		])
		expect(fieldsOf("noise squelch on a refused modulation")).toEqual([
			{
				field: "squelchMode",
				expected: expect.stringMatching(
					/; "noise" needs modulation "nfm" or "wfm"$/,
				) as string,
			},
		])
		expect(fieldsOf("empty override")).toEqual([
			{
				field: "body",
				expected: expect.stringMatching(
					/; at least one of rangesHz, targetsHz, region, bandSuspension/,
				) as string,
			},
		])
		expect(fieldsOf("inverted range")).toEqual([
			{
				field: "rangesHz.0",
				expected: expect.stringMatching(
					/; minHz must not exceed maxHz$/,
				) as string,
			},
		])
		expect(fieldsOf("overlapping and inverted entries")).toEqual([
			{
				field: "entries.2.maxHz",
				expected: expect.stringMatching(/; above minHz$/) as string,
			},
			{
				field: "entries.1",
				expected: expect.stringMatching(
					/; ranges are inclusive and must not overlap another entry$/,
				) as string,
			},
		])
	})

	it("POST tuner gain with a wrong gain names gain and tenthsDb in tenths of a dB", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/tuner/rtl/gain",
			payload: { gain: SENTINEL },
		})
		expect(res.statusCode).toBe(400)
		const body = res.json<{
			code: string
			fields: { field: string; expected: string }[]
		}>()
		expect(body.code).toBe("VALIDATION_ERROR")
		expect(body.fields[0]?.field).toBe("gain")
		expect(body.fields[0]?.expected).toContain('"tenthsDb"')
		expect(body.fields[0]?.expected).toContain("tenths of a dB")
		expect(res.body).not.toContain(SENTINEL)
	})

	it("a schema 400 from the global handler names the field and its bounds", async () => {
		const res = await app.inject({
			method: "GET",
			url: `/api/spectrum/occupancy?sourceId=rtl&startHz=1&endHz=${SENTINEL}`,
		})
		expect(res.statusCode).toBe(400)
		expect(res.json()).toMatchObject({
			error: "ValidationError",
			code: "VALIDATION_ERROR",
			fields: [{ field: "endHz" }],
		})
		expect(res.json().message).toContain("endHz")
	})
})

describe("validation field helpers", () => {
	it("names units by field-name convention", () => {
		expect(unitFromName("nearHz")).toBe("Hz")
		expect(unitFromName("hz")).toBe("Hz")
		expect(unitFromName("tenthsDb")).toBe("tenths of a dB")
		expect(unitFromName("timeoutMs")).toBe("milliseconds")
		expect(unitFromName("ppm")).toBe("ppm")
		expect(unitFromName("name")).toBeNull()
	})

	it("describes JSON schema types, enums and bounds", () => {
		expect(
			describeJsonSchema({ type: "integer", minimum: 0, maximum: 500 }),
		).toBe("integer (0 to 500)")
		expect(describeJsonSchema({ enum: ["a", "b"] })).toBe('one of "a" | "b"')
		expect(
			describeJsonSchema({ type: "integer", exclusiveMinimum: 0 }, "nearHz"),
		).toBe("integer (> 0), Hz")
	})

	it("states which field to send when oneOf branches only require fields", () => {
		expect(
			describeJsonSchema({
				type: "object",
				properties: {
					frequencyHz: { type: "number" },
					all: { type: "boolean" },
				},
				oneOf: [{ required: ["frequencyHz"] }, { required: ["all"] }],
			}),
		).toBe(
			"object with fields frequencyHz, all; exactly one of frequencyHz or all",
		)
	})

	it("never names an additional property the client chose", () => {
		const fields = ajvValidationFields(
			[
				{
					keyword: "additionalProperties",
					instancePath: "",
					schemaPath: "#/additionalProperties",
					params: { additionalProperty: SENTINEL },
					message: "must NOT have additional properties",
				},
			],
			"body",
			{ type: "object", properties: { hz: { type: "integer" } } },
		)
		expect(fields).toEqual([{ field: "body", expected: "only the fields hz" }])
	})

	it("replaces a record key with * and drops Zod's own message", () => {
		const schema = z.object({
			gains: z.record(z.number().int().min(0).max(500)),
		})
		const parsed = schema.safeParse({ gains: { [SENTINEL]: SENTINEL } })
		expect(parsed.success).toBe(false)
		if (parsed.success) return
		const fields = zodValidationFields(parsed.error, schema)
		expect(fields).toEqual([
			{ field: "gains.*", expected: "integer (0 to 500)" },
		])
		expect(JSON.stringify(fields)).not.toContain(SENTINEL)
	})

	it("names an unknown key as its parent object, never the key", () => {
		const schema = z.object({ pin: z.boolean().optional() }).strict()
		const parsed = schema.safeParse({ [SENTINEL]: 1 })
		expect(parsed.success).toBe(false)
		if (parsed.success) return
		expect(zodValidationFields(parsed.error, schema)).toEqual([
			{ field: "body", expected: "only the fields pin" },
		])
	})

	it("never uses a refinement message: a static rule or a refusal note instead", () => {
		const schema = z
			.object({ mode: z.string(), note: z.string().trim() })
			.superRefine((value, ctx) => {
				ctx.addIssue({
					code: "custom",
					path: ["mode"],
					message: "mode requires a note",
				})
				// Quotes the parsed (trimmed) value: no filter on the raw input could catch it.
				ctx.addIssue({
					code: "custom",
					path: ["note"],
					message: `note ${value.note} is not allowed`,
				})
			})
		const parsed = schema.safeParse({ mode: "fm", note: `  ${SENTINEL}  ` })
		if (parsed.success) throw new Error("expected a failure")
		expect(zodValidationFields(parsed.error, schema)).toEqual([
			{ field: "mode", expected: `string; ${REFUSED_BY_RULE}` },
			{ field: "note", expected: `string; ${REFUSED_BY_RULE}` },
		])
		expect(
			zodValidationFields(parsed.error, schema, {
				rules: { mode: "needs a note" },
			}),
		).toEqual([
			{ field: "mode", expected: "string; needs a note" },
			{ field: "note", expected: `string; ${REFUSED_BY_RULE}` },
		])
		expect(
			JSON.stringify(zodValidationFields(parsed.error, schema)),
		).not.toContain(SENTINEL)
	})

	it("keys rules and overrides of array items by * and replaces a refused enum", () => {
		const schema = z.object({
			list: z.array(
				z
					.object({ lo: z.number(), hi: z.number() })
					.refine(v => v.lo <= v.hi, { message: "lo above hi", path: ["hi"] }),
			),
			pick: z.enum(["a", "b"]).refine(v => v !== "b", "b is reserved"),
		})
		const parsed = schema.safeParse({
			list: [
				{ lo: 1, hi: 2 },
				{ lo: 3, hi: 2 },
			],
			pick: "b",
		})
		if (parsed.success) throw new Error("expected a failure")
		expect(
			zodValidationFields(parsed.error, schema, {
				rules: { "list.*.hi": "at least lo" },
				expected: { pick: '"a" ("b" is reserved)' },
			}),
		).toEqual([
			{ field: "list.1.hi", expected: "number; at least lo" },
			{ field: "pick", expected: '"a" ("b" is reserved)' },
		])
	})

	it("plan issues keep only the checked range-locked details", () => {
		const { issues, fields } = staticPlanIssues([
			{
				code: "range-locked",
				severity: "error",
				message: `range 1: ${SENTINEL} cannot change`,
				details: { index: 1, fields: ["endHz"], note: SENTINEL },
			},
			{
				code: "range-locked",
				severity: "warning",
				message: SENTINEL,
				details: {
					reason: "range-live-stale",
					dropped: [0, 2],
					expected: 3,
					received: 3,
				},
			},
			// A field name or reason outside the fixed sets is dropped, not echoed.
			{
				code: "range-locked",
				severity: "error",
				message: SENTINEL,
				details: { reason: SENTINEL, fields: [SENTINEL], index: -1 },
			},
			{ code: SENTINEL, severity: SENTINEL, message: SENTINEL },
			SENTINEL,
		])
		expect(issues).toEqual([
			{
				code: "range-locked",
				severity: "error",
				message:
					"a running job's ranges cannot change; stop it to change edges or channel spacing",
				details: { index: 1, fields: ["endHz"] },
			},
			{
				code: "range-locked",
				severity: "warning",
				message:
					"a running job's ranges cannot change; stop it to change edges or channel spacing",
				details: {
					reason: "range-live-stale",
					dropped: [0, 2],
					expected: 3,
					received: 3,
				},
			},
			{
				code: "range-locked",
				severity: "error",
				message:
					"a running job's ranges cannot change; stop it to change edges or channel spacing",
			},
			{
				code: "unknown",
				severity: "error",
				message: "the job spec has an error",
			},
		])
		expect(fields.map(f => f.field)).toEqual(["ranges"])
		expect(JSON.stringify({ issues, fields })).not.toContain(SENTINEL)
		expect(staticPlanIssues(SENTINEL).fields.map(f => f.field)).toEqual([
			"body",
		])
	})

	it("plan issue guidance follows the checked details: all ranges disabled, plan changed since read", () => {
		const { issues, fields } = staticPlanIssues([
			{
				code: "range-empty",
				severity: "error",
				message: SENTINEL,
				details: { disabled: 2 },
			},
			{
				code: "range-locked",
				severity: "error",
				message: SENTINEL,
				details: {
					reason: "range-plan-changed",
					dropped: [1],
					expected: 2,
					received: 2,
				},
			},
			// A malformed count falls back to the generic text.
			{
				code: "range-empty",
				severity: "error",
				message: SENTINEL,
				details: { disabled: SENTINEL },
			},
		])
		expect(issues.map(i => i.message)).toEqual([
			"every range is disabled",
			"the job's ranges changed since they were read; reread the job and resend",
			"a range is empty or inverted, or the sweep has no range",
		])
		expect(issues[1]?.details).toEqual({
			reason: "range-plan-changed",
			dropped: [1],
			expected: 2,
			received: 2,
		})
		expect(fields).toEqual([
			{
				field: "ranges",
				expected: "at least one range with enabled true (or enabled omitted)",
			},
		])
		const stale = staticPlanIssues([
			{
				code: "range-locked",
				severity: "error",
				message: SENTINEL,
				details: { reason: "range-plan-changed" },
			},
		])
		expect(stale.fields[0]?.expected).toMatch(/fresh GET/)
		expect(JSON.stringify({ issues, fields, stale })).not.toContain(SENTINEL)
	})

	it(`names at most ${MAX_VALIDATION_FIELDS} fields, at and past the bound`, () => {
		const shape = (n: number) =>
			z.object(
				Object.fromEntries(
					Array.from({ length: n }, (_, i) => [`f${i}`, z.number()]),
				),
			)
		for (const n of [MAX_VALIDATION_FIELDS, MAX_VALIDATION_FIELDS + 5]) {
			const schema = shape(n)
			const parsed = schema.safeParse(
				Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, "x"])),
			)
			if (parsed.success) throw new Error("expected a failure")
			expect(zodValidationFields(parsed.error, schema)).toHaveLength(
				MAX_VALIDATION_FIELDS,
			)
		}
	})
})
