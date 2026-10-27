/**
 * WG8 req 2.1: legacy-mode PATCH /api/decoders/:id and GET /api/decoders/:id/settings are
 * byte-identical to the frozen code (30f17b43). Bodies below were recorded from it.
 * Fail closed: the protected routes mount only when BOTH `settings` and `authorizeSettings`
 * are given; either one alone is legacy.
 */
import Fastify, { type FastifyInstance } from "fastify"
import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
	decoderRoutes,
	type DecoderRoutesOptions,
} from "../../../src/api/routes/decoders.js"
import type { DecoderSettingsService } from "../../../src/decoders/settings/contract.js"

const JSON_CT = "application/json; charset=utf-8"
const NOT_FOUND = (id: string) =>
	`{"error":"NotFound","code":"DECODER_NOT_FOUND","message":"Decoder with id '${id}' not found"}`
const NO_FIELDS =
	'{"error":"BadRequest","code":"NO_UPDATE_FIELDS","message":"At least one field (enabled or options) must be provided"}'
const UNSUPPORTED =
	'{"error":"NotImplemented","code":"DECODER_CONFIG_UPDATE_UNSUPPORTED","message":"Runtime decoder configuration updates are not implemented. Edit the YAML configuration and restart WaveKit; use the start/stop endpoints for lifecycle control."}'
const validation = (message: string) =>
	`{"error":"Bad Request","code":"FST_ERR_VALIDATION","message":"${message}"}`
const INVALID_JSON =
	'{"error":"Bad Request","code":"FST_ERR_CTP_INVALID_JSON_BODY","message":"Body is not valid JSON but content-type is set to \'application/json\'"}'
const TOO_LARGE =
	'{"statusCode":413,"code":"FST_ERR_CTP_BODY_TOO_LARGE","error":"Payload Too Large","message":"Request body is too large"}'
const routeNotFound = (url: string) =>
	`{"message":"Route GET:${url} not found","error":"Not Found","statusCode":404}`

function throwingService(): DecoderSettingsService {
	const fail = () => {
		throw new Error("settings service must not be reached in legacy mode")
	}
	return {
		revision: fail,
		view: fail,
		update: fail,
		effectiveConfig: fail,
		ignored: fail,
		close: fail,
	} as unknown as DecoderSettingsService
}

type Variant = "none" | "settings-only" | "authorize-only"
const variants: Variant[] = ["none", "settings-only", "authorize-only"]
const authorize = vi.fn(() => undefined)

async function legacyApp(variant: Variant): Promise<FastifyInstance> {
	const app = Fastify()
	const options: DecoderRoutesOptions = {
		decoderManager: {
			getDecoder: (id: string) =>
				id === "d" || id === "probe" ? {} : undefined,
			getStatus: (id: string) =>
				id === "probe" ? { owner: "scanner" } : undefined,
		} as unknown as DecoderRoutesOptions["decoderManager"],
	}
	if (variant === "settings-only") options.settings = throwingService()
	if (variant === "authorize-only") options.authorizeSettings = authorize
	await app.register(decoderRoutes, options)
	return app
}

interface Case {
	name: string
	url: string
	method?: "PATCH" | "GET"
	payload?: unknown
	contentType?: string
	status: number
	body: string
}

const cases: Case[] = [
	{
		name: "404 unknown id",
		url: "/api/decoders/nope",
		payload: { enabled: true },
		status: 404,
		body: NOT_FOUND("nope"),
	},
	{
		name: "404 before the empty-body check",
		url: "/api/decoders/nope",
		payload: {},
		status: 404,
		body: NOT_FOUND("nope"),
	},
	{
		name: "400 empty body",
		url: "/api/decoders/d",
		payload: {},
		status: 400,
		body: NO_FIELDS,
	},
	{
		name: "unknown key stripped then 400",
		url: "/api/decoders/d",
		payload: { zap: 1 },
		status: 400,
		body: NO_FIELDS,
	},
	{
		name: "501 enabled",
		url: "/api/decoders/d",
		payload: { enabled: true },
		status: 501,
		body: UNSUPPORTED,
	},
	{
		name: "501 options",
		url: "/api/decoders/d",
		payload: { options: { a: 1 } },
		status: 501,
		body: UNSUPPORTED,
	},
	{
		name: "501 coerced enabled string",
		url: "/api/decoders/d",
		payload: { enabled: "true" },
		status: 501,
		body: UNSUPPORTED,
	},
	{
		name: "501 coerced enabled null",
		url: "/api/decoders/d",
		payload: { enabled: null },
		status: 501,
		body: UNSUPPORTED,
	},
	{
		name: "501 on a probe (legacy has no 409)",
		url: "/api/decoders/probe",
		payload: { enabled: true },
		status: 501,
		body: UNSUPPORTED,
	},
	{
		name: "schema 400 enabled",
		url: "/api/decoders/d",
		payload: { enabled: "x" },
		status: 400,
		body: validation("body/enabled must be boolean"),
	},
	{
		name: "schema 400 options",
		url: "/api/decoders/d",
		payload: { options: 5 },
		status: 400,
		body: validation("body/options must be object"),
	},
	{
		name: "schema 400 array",
		url: "/api/decoders/d",
		payload: [1],
		status: 400,
		body: validation("body must be object"),
	},
	{
		name: "schema 400 no body",
		url: "/api/decoders/d",
		status: 400,
		body: validation("body must be object"),
	},
	{
		name: "schema 400 text/plain",
		url: "/api/decoders/d",
		payload: "hi",
		contentType: "text/plain",
		status: 400,
		body: validation("body must be object"),
	},
	{
		name: "invalid JSON",
		url: "/api/decoders/d",
		payload: "{bad",
		contentType: "application/json",
		status: 400,
		body: INVALID_JSON,
	},
	{
		name: "413 over the 1 MiB default",
		url: "/api/decoders/d",
		payload: { options: { a: "x".repeat(2_000_000) } },
		status: 413,
		body: TOO_LARGE,
	},
	{
		name: "GET settings of a known id",
		method: "GET",
		url: "/api/decoders/d/settings",
		status: 404,
		body: routeNotFound("/api/decoders/d/settings"),
	},
	{
		name: "GET settings of an unknown id",
		method: "GET",
		url: "/api/decoders/nope/settings",
		status: 404,
		body: routeNotFound("/api/decoders/nope/settings"),
	},
]

async function send(
	target: FastifyInstance,
	c: Omit<Case, "name" | "status" | "body">,
) {
	const headers: Record<string, string> = {}
	if (c.contentType) headers["content-type"] = c.contentType
	return target.inject({
		method: c.method ?? "PATCH",
		url: c.url,
		headers,
		...(c.payload === undefined
			? {}
			: { payload: c.payload as string | object }),
	})
}

describe.each(variants)("legacy decoder PATCH goldens (%s)", variant => {
	let app: FastifyInstance
	beforeAll(async () => {
		// These legacy routes never mutate the fake manager. Compile the same
		// schemas once per variant, rather than booting 18 identical Fastify apps.
		app = await legacyApp(variant)
		await app.ready()
	})
	afterAll(async () => {
		await app.close()
	})
	it.each(cases)("$name", async c => {
		const res = await send(app, c)
		expect(res.statusCode).toBe(c.status)
		expect(res.body).toBe(c.body)
		expect(res.headers["content-type"]).toBe(JSON_CT)
		expect(res.headers["cache-control"]).toBeUndefined()
		expect(authorize).not.toHaveBeenCalled()
	})
})

// Cover every JSON type and two nesting levels without generating large random
// payloads. The explicit 413 golden already covers the 1 MiB boundary.
const jsonScalar = fc.oneof(
	fc.constant(null),
	fc.boolean(),
	fc.double({ noNaN: true, noDefaultInfinity: true }),
	fc.string({ maxLength: 32 }),
)
const jsonLeaf = fc.oneof(
	jsonScalar,
	fc.array(jsonScalar, { maxLength: 4 }),
	fc.dictionary(fc.string({ maxLength: 8 }), jsonScalar, { maxKeys: 4 }),
)
const boundedJson = fc.oneof(
	jsonLeaf,
	fc.array(jsonLeaf, { maxLength: 4 }),
	fc.dictionary(fc.string({ maxLength: 8 }), jsonLeaf, { maxKeys: 4 }),
)

const legacyBody = fc.oneof(
	fc.dictionary(fc.string({ maxLength: 8 }), boundedJson, {
		maxKeys: 4,
	}),
	fc.record(
		{
			enabled: fc.oneof(
				fc.boolean(),
				fc.constant(null),
				fc.string({ maxLength: 4 }),
				fc.integer(),
			),
			options: fc.oneof(
				fc.dictionary(fc.string({ maxLength: 8 }), jsonLeaf, { maxKeys: 4 }),
				fc.integer(),
				fc.string({ maxLength: 4 }),
			),
		},
		{ requiredKeys: [] },
	),
)

describe("legacy property", () => {
	// Feature: web-gaps-8, Property 7: Legacy unchanged
	// Validates: Requirements 2.1
	it("random PATCH bodies get the frozen legacy answer in every legacy variant", async () => {
		const apps = await Promise.all(variants.map(legacyApp))
		try {
			await fc.assert(
				fc.asyncProperty(
					legacyBody,
					fc.constantFrom("d", "nope", "probe"),
					async (payload, id) => {
						const answers = await Promise.all(
							apps.map(a => send(a, { url: `/api/decoders/${id}`, payload })),
						)
						const first = answers[0]!
						for (const a of answers) {
							expect(a.statusCode).toBe(first.statusCode)
							expect(a.body).toBe(first.body)
						}
						const allowed =
							id === "nope" ? [NOT_FOUND("nope")] : [NO_FIELDS, UNSUPPORTED]
						if (
							first.statusCode === 400 &&
							first.body.includes("FST_ERR_VALIDATION")
						)
							return
						expect(allowed).toContain(first.body)
					},
				),
				// Keep all body/id variants and shrinking, with 100 × 3 route injections
				// instead of repeating another 150 injections under worker contention.
				{ numRuns: 100 },
			)
		} finally {
			await Promise.all(apps.map(a => a.close()))
		}
		expect(authorize).not.toHaveBeenCalled()
	})
})
