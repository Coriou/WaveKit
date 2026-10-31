/**
 * Every HTTP 400 validation answer names the failing field(s) and what each accepts, in
 * static text: the full API server is built with in-process fakes, every registered
 * POST/PUT/PATCH route (and every GET route with a query schema) gets invalid input
 * carrying a sentinel, and each 400 must name a field and never repeat the sentinel.
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
import { createLogger } from "../../../src/utils/logger.js"
import {
	ajvValidationFields,
	describeJsonSchema,
	unitFromName,
	zodValidationFields,
	MAX_VALIDATION_FIELDS,
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
		} else if (route.method === "GET" && route.schema?.["querystring"]) {
			await send(route, "unknown parameter", {
				method: "GET",
				url: `${url}?${SENTINEL}=${SENTINEL}`,
			})
			for (const prop of queryProperties(route.schema))
				await send(route, `${prop}=sentinel`, {
					method: "GET",
					url: `${url}?${prop}=${SENTINEL}`,
				})
		}
	}
	return answers
}

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
				reconfigure: async () => {
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

const origin = "http://receiver.lan:9000"

beforeAll(async () => {
	const legacy = await started(fakeDependencies(), {
		host: "127.0.0.1",
		port: 0,
	})
	app = legacy.app
	answers.push(...(await sweep(app, legacy.routes)))

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

	it("no 400 repeats the submitted input", () => {
		const echoes = [...answers, ...protectedAnswers]
			.filter(a => a.status === 400 && a.body.includes(SENTINEL))
			.map(a => `${a.route} (${a.request}): ${a.body}`)
		expect(echoes).toEqual([])
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

	it("keeps a plain refinement message and drops one that could carry a value", () => {
		const schema = z
			.object({ mode: z.string(), note: z.string() })
			.superRefine((value, ctx) => {
				ctx.addIssue({
					code: "custom",
					path: ["mode"],
					message: "mode requires a note",
				})
				ctx.addIssue({
					code: "custom",
					path: ["note"],
					message: `note ${value.note} is not allowed`,
				})
			})
		const input = { mode: "fm", note: SENTINEL }
		const parsed = schema.safeParse(input)
		if (parsed.success) throw new Error("expected a failure")
		expect(zodValidationFields(parsed.error, schema, { input })).toEqual([
			{ field: "mode", expected: "string; mode requires a note" },
			{ field: "note", expected: "string" },
		])
		// Without the submitted input nothing vouches for the message.
		expect(zodValidationFields(parsed.error, schema)).toEqual([
			{ field: "mode", expected: "string" },
			{ field: "note", expected: "string" },
		])
		// Digits, quotes or markup never pass, even when not from this request.
		const stored = z.string().refine(() => false, "limit 9999 <b>")
		const failed = stored.safeParse("x")
		if (failed.success) throw new Error("expected a failure")
		expect(zodValidationFields(failed.error, stored, { input: "x" })).toEqual([
			{ field: "body", expected: "string" },
		])
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
