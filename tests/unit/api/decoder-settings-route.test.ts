/** WG8 req 2.1-2.6: protected GET /api/decoders/:id/settings and PATCH /api/decoders/:id. */
import { Writable } from "node:stream"
import Fastify, { type FastifyInstance } from "fastify"
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	decoderRoutes,
	type DecoderRoutesOptions,
} from "../../../src/api/routes/decoders.js"
import {
	DecoderSettingsError,
	type DecoderSettingsService,
} from "../../../src/decoders/settings/contract.js"
import type { DeniedAdmission } from "../../../src/access/types.js"
import {
	DECODER_SETTINGS_BODY_MAX_BYTES,
	type DecoderSettingsUpdateResult,
	type DecoderSettingsView,
} from "@wavekit/api-types"

const SENTINEL = "s3ntinel-VALUE-zq"
const SENTINEL_KEY = "s3ntinelKEYzq"

const view: DecoderSettingsView = {
	decoderId: "d",
	type: "known",
	revision: 3,
	enabled: { value: true, source: "config" },
	options: [
		{
			key: "gain",
			source: "config",
			patchable: true,
			secret: false,
			present: true,
			value: 10,
		},
	],
	undocumentedKeys: 0,
	pendingRestart: false,
}
const result: DecoderSettingsUpdateResult = {
	settings: { ...view, revision: 4, pendingRestart: true },
	revision: 4,
	changed: ["gain"],
	pendingRestart: true,
}

let update: ReturnType<typeof vi.fn>
let viewFn: ReturnType<typeof vi.fn>
let denial: DeniedAdmission | undefined
let authorize: ReturnType<typeof vi.fn>
let getDecoder: ReturnType<typeof vi.fn>
let logLines: string[]
let app: FastifyInstance

function service(): DecoderSettingsService {
	return {
		revision: () => 3,
		view: viewFn,
		update,
		effectiveConfig: c => c,
		ignored: () => ({ orphans: 0, retyped: 0 }),
		close: async () => undefined,
	} as DecoderSettingsService
}

beforeEach(async () => {
	update = vi.fn(async () => result)
	viewFn = vi.fn((id: string) => (id === "d" ? view : undefined))
	denial = undefined
	authorize = vi.fn(() => denial)
	getDecoder = vi.fn((id: string) =>
		id === "d" || id === "probe" || id === "ghost" ? {} : undefined,
	)
	logLines = []
	const stream = new Writable({
		write(chunk: Buffer, _enc, cb) {
			logLines.push(chunk.toString())
			cb()
		},
	})
	app = Fastify({ logger: { level: "info", stream } })
	const options: DecoderRoutesOptions = {
		decoderManager: {
			getDecoder,
			getStatus: (id: string) =>
				id === "probe"
					? { owner: "scanner" }
					: id === "d"
						? { owner: "config" }
						: undefined,
		} as unknown as DecoderRoutesOptions["decoderManager"],
		settings: service(),
		authorizeSettings: authorize,
	}
	await app.register(decoderRoutes, options)
})
afterEach(async () => {
	await app.close()
})

const patch = (
	payload: unknown,
	opts: { id?: string; headers?: Record<string, string> } = {},
) =>
	app.inject({
		method: "PATCH",
		url: `/api/decoders/${opts.id ?? "d"}`,
		headers: opts.headers ?? {},
		...(payload === undefined ? {} : { payload: payload as string | object }),
	})

function expectNoEcho(body: string) {
	expect(body).not.toContain(SENTINEL)
	expect(body).not.toContain(SENTINEL_KEY)
}

describe("protected GET settings", () => {
	it("200 view with no-store and no authorizeSettings call", async () => {
		const res = await app.inject("/api/decoders/d/settings")
		expect(res.statusCode).toBe(200)
		expect(res.json()).toEqual(view)
		expect(res.headers["cache-control"]).toBe("no-store")
		expect(authorize).not.toHaveBeenCalled()
	})
	it("404 unknown id with the existing body", async () => {
		const res = await app.inject("/api/decoders/nope/settings")
		expect(res.statusCode).toBe(404)
		expect(res.body).toBe(
			`{"error":"NotFound","code":"DECODER_NOT_FOUND","message":"Decoder with id 'nope' not found"}`,
		)
		expect(viewFn).not.toHaveBeenCalled()
	})
	it("409 probe without calling view", async () => {
		const res = await app.inject("/api/decoders/probe/settings")
		expect(res.statusCode).toBe(409)
		expect(res.json()).toMatchObject({ code: "DECODER_OWNED_BY_SCANNER" })
		expect(viewFn).not.toHaveBeenCalled()
	})
	it("404 when the service has no view (fail closed)", async () => {
		const res = await app.inject("/api/decoders/ghost/settings")
		expect(res.statusCode).toBe(404)
		expect(res.json()).toMatchObject({ code: "DECODER_NOT_FOUND" })
	})
})

describe("protected PATCH", () => {
	it("documents the body schema but never validates or coerces it", async () => {
		const schemas: unknown[] = []
		const docApp = Fastify()
		docApp.addHook("onRoute", route => {
			if (route.method === "PATCH" && route.url === "/api/decoders/:id")
				schemas.push(route.schema?.body)
		})
		await docApp.register(decoderRoutes, {
			decoderManager: {} as DecoderRoutesOptions["decoderManager"],
			settings: service(),
			authorizeSettings: authorize,
		})
		await docApp.ready()
		await docApp.close()
		expect(schemas).toEqual([
			{
				type: "object",
				properties: {
					enabled: { type: ["boolean", "null"] },
					options: { type: "object", additionalProperties: true },
					mode: {
						type: ["string", "null"],
						enum: ["auto", "always", "off", null],
					},
				},
				additionalProperties: false,
			},
		])

		for (const body of [{ enabled: "true" }, { enabled: true, extra: 1 }]) {
			const res = await patch(body)
			expect(res.statusCode).toBe(400)
			expect(res.json()).toMatchObject({ code: "DECODER_OPTIONS_INVALID" })
		}
		expect(update).not.toHaveBeenCalled()
		// An empty id is a fixed 400 in the settings shape, no echo.
		const empty = await app.inject({ method: "PATCH", url: "/api/decoders/" })
		expect(empty.statusCode).toBe(400)
		expect(empty.json()).toEqual({
			error: "Bad Request",
			code: "DECODER_OPTIONS_INVALID",
			message: "Decoder id is required",
			fields: [{ field: "id", expected: "a decoder id, at least 1 character" }],
		})
	})
	it("deny precedes lookup, parsing and the service", async () => {
		denial = {
			kind: "deny",
			status: 403,
			code: "ACCESS_DENIED" as DeniedAdmission["code"],
			headers: { "x-test": "1" },
		}
		for (const payload of [
			{ enabled: true },
			"{bad",
			{ options: { a: "x".repeat(20_000) } },
		]) {
			const res = await patch(payload, {
				id: "nope",
				headers: { "content-type": "application/json" },
			})
			expect(res.statusCode).toBe(403)
			expect(res.body).toBe('{"code":"ACCESS_DENIED"}')
			expect(res.headers["x-test"]).toBe("1")
		}
		expect(getDecoder).not.toHaveBeenCalled()
		expect(update).not.toHaveBeenCalled()
	})
	it("404 unknown id, service never called", async () => {
		const res = await patch({ enabled: true }, { id: "nope" })
		expect(res.statusCode).toBe(404)
		expect(res.body).toBe(
			`{"error":"NotFound","code":"DECODER_NOT_FOUND","message":"Decoder with id 'nope' not found"}`,
		)
		expect(authorize).toHaveBeenCalledTimes(1)
		expect(update).not.toHaveBeenCalled()
	})
	it("409 probe, service never called", async () => {
		const res = await patch({ enabled: true }, { id: "probe" })
		expect(res.statusCode).toBe(409)
		expect(res.json()).toMatchObject({ code: "DECODER_OWNED_BY_SCANNER" })
		expect(update).not.toHaveBeenCalled()
	})
	it("200 result with no-store, raw body and no If-Match passed", async () => {
		const body = { enabled: null, options: { gain: 12 } }
		const res = await patch(body)
		expect(res.statusCode).toBe(200)
		expect(res.json()).toEqual(result)
		expect(res.headers["cache-control"]).toBe("no-store")
		expect(update).toHaveBeenCalledWith("d", body, undefined)
	})
	it.each([
		['W/"7"', 7],
		['"7"', 7],
		["7", 7],
		[" 0 ", 0],
		[String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
	])("If-Match %s parses", async (header, value) => {
		const res = await patch(
			{ enabled: true },
			{ headers: { "if-match": header } },
		)
		expect(res.statusCode).toBe(200)
		expect(update).toHaveBeenCalledWith(
			"d",
			{ enabled: true },
			{ ifMatch: value },
		)
	})
	it.each([
		"garbage",
		`W/${SENTINEL}`,
		"*",
		"-1",
		"1.5",
		'w/"1"',
		'"1',
		"9007199254740992",
		"9999999999999999999",
		"",
	])("If-Match %j is 400 with fixed text", async header => {
		const res = await patch(
			{ enabled: true },
			{ headers: { "if-match": header } },
		)
		expect(res.statusCode).toBe(400)
		expect(res.json()).toEqual({
			error: "Bad Request",
			code: "DECODER_OPTIONS_INVALID",
			message: "If-Match must be a revision",
			fields: [
				{
					field: "If-Match",
					expected:
						'a settings revision, a non-negative integer (quoted "7" or bare 7)',
				},
			],
		})
		expectNoEcho(res.body)
		expect(update).not.toHaveBeenCalled()
	})
	it.each([
		["array", [SENTINEL]],
		["number", 5],
		["null", null],
		["string", SENTINEL],
		["unknown key", { [SENTINEL_KEY]: SENTINEL }],
		["enabled string", { enabled: SENTINEL }],
		["enabled number", { enabled: 1 }],
		["options array", { options: [SENTINEL] }],
		["options string", { options: SENTINEL }],
		["options null", { options: null }],
	])("non-conforming body (%s) is 400 without echo", async (_name, payload) => {
		const res = await app.inject({
			method: "PATCH",
			url: "/api/decoders/d",
			headers: { "content-type": "application/json" },
			payload: JSON.stringify(payload),
		})
		expect(res.statusCode).toBe(400)
		expect(res.json()).toMatchObject({ code: "DECODER_OPTIONS_INVALID" })
		expectNoEcho(res.body)
		expect(update).not.toHaveBeenCalled()
	})
	it("text/plain body is 400 settings shape (parsed as a string)", async () => {
		const res = await patch(SENTINEL, {
			headers: { "content-type": "text/plain" },
		})
		expect(res.statusCode).toBe(400)
		expect(res.json()).toMatchObject({ code: "DECODER_OPTIONS_INVALID" })
		expectNoEcho(res.body)
	})
	it("unsupported media type keeps Fastify's 415", async () => {
		const res = await patch(`<x>${SENTINEL}</x>`, {
			headers: { "content-type": "application/xml" },
		})
		expect(res.statusCode).toBe(415)
		expect(res.json()).toMatchObject({ code: "FST_ERR_CTP_INVALID_MEDIA_TYPE" })
		expectNoEcho(res.body)
		expect(update).not.toHaveBeenCalled()
	})
	it("invalid JSON keeps Fastify's 400", async () => {
		const res = await patch(`{"${SENTINEL_KEY}":`, {
			headers: { "content-type": "application/json" },
		})
		expect(res.statusCode).toBe(400)
		expect(res.json()).toMatchObject({ code: "FST_ERR_CTP_INVALID_JSON_BODY" })
		expectNoEcho(res.body)
		expect(update).not.toHaveBeenCalled()
	})

	const sized = (bytes: number) => {
		const base = JSON.stringify({ options: { gain: "" } })
		const out = JSON.stringify({
			options: { gain: "x".repeat(bytes - base.length) },
		})
		expect(Buffer.byteLength(out)).toBe(bytes)
		return out
	}
	it("body of exactly 16 KiB reaches the service", async () => {
		const res = await patch(sized(DECODER_SETTINGS_BODY_MAX_BYTES), {
			headers: { "content-type": "application/json" },
		})
		expect(res.statusCode).toBe(200)
		expect(update).toHaveBeenCalledTimes(1)
	})
	it("one byte past 16 KiB is 413 DECODER_SETTINGS_LIMIT", async () => {
		const res = await patch(sized(DECODER_SETTINGS_BODY_MAX_BYTES + 1), {
			headers: { "content-type": "application/json" },
		})
		expect(res.statusCode).toBe(413)
		expect(res.json()).toEqual({
			error: "Payload Too Large",
			code: "DECODER_SETTINGS_LIMIT",
			message: "Body is too large",
		})
		expect(update).not.toHaveBeenCalled()
	})

	it.each([
		[
			new DecoderSettingsError(
				"DECODER_SETTINGS_REVISION_MISMATCH",
				"Revision mismatch",
			),
			412,
		],
		[
			new DecoderSettingsError("DECODER_OPTIONS_INVALID", "Invalid", {
				issues: [{ path: "gain", code: "invalid-value", message: "too big" }],
			}),
			400,
		],
		[
			new DecoderSettingsError(
				"DECODER_OPTION_NOT_PATCHABLE",
				"Not patchable",
				{ keys: ["mode"], unknownKeys: 2 },
			),
			400,
		],
		[new DecoderSettingsError("DECODER_SETTINGS_LIMIT", "Too many keys"), 413],
		[
			new DecoderSettingsError(
				"DECODER_SETTINGS_STORE_UNAVAILABLE",
				"Store unavailable",
			),
			503,
		],
	])("maps %s to its status and body", async (error, status) => {
		update.mockRejectedValueOnce(error)
		const res = await patch({ options: { [SENTINEL_KEY]: SENTINEL } })
		expect(res.statusCode).toBe(status)
		// A 400 adds `fields`: option paths below options, never a submitted key.
		const { fields, ...rest } = res.json<{ fields?: unknown }>()
		expect(rest).toEqual(error.toBody())
		expect(fields).toEqual(
			status !== 400
				? undefined
				: error.code === "DECODER_OPTIONS_INVALID"
					? [
							{
								field: "options.gain",
								expected:
									"a value of the documented option type and bounds (GET /api/decoders/:id/settings)",
							},
						]
					: [
							{
								field: "options",
								expected:
									"only options this decoder can change at runtime (GET /api/decoders/:id/settings marks them)",
							},
						],
		)
		expectNoEcho(res.body)
	})

	it("any other throw is a fixed 500 and the log carries safe fields only", async () => {
		const err = Object.assign(
			new Error(`boom ${SENTINEL} /etc/${SENTINEL_KEY}`),
			{
				code: "EACCES",
				path: `/srv/${SENTINEL}`,
			},
		)
		update.mockRejectedValueOnce(err)
		const res = await patch({ options: { [SENTINEL_KEY]: SENTINEL } })
		expect(res.statusCode).toBe(500)
		expect(res.json()).toEqual({
			error: "Internal Server Error",
			code: "DECODER_SETTINGS_UPDATE_FAILED",
			message: "Decoder settings update failed",
		})
		const logs = logLines.join("")
		expect(logs).toContain("decoder settings update failed")
		expect(logs).toContain('"code":"EACCES"')
		expect(logs).not.toContain("boom")
		expect(logs).not.toContain('"stack"')
		expectNoEcho(logs)
		expectNoEcho(res.body)
	})

	// No-echo property (common brief 7b): WG8 requirements 2.2, 2.6
	it("random bodies never echo a key or value in protected responses or logs", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.dictionary(
					fc.constantFrom("enabled", "options", SENTINEL_KEY),
					fc.oneof(
						fc.constant(SENTINEL),
						fc.boolean(),
						fc.constant(null),
						fc.dictionary(fc.constant(SENTINEL_KEY), fc.constant(SENTINEL)),
						fc.array(fc.constant(SENTINEL), { maxLength: 2 }),
					),
				),
				fc.constantFrom("d", "nope", "probe"),
				fc.boolean(),
				async (payload, id, reject) => {
					update.mockReset()
					update.mockImplementation(async () => {
						if (reject) throw new Error(SENTINEL)
						return result
					})
					const res = await patch(payload, { id })
					expectNoEcho(res.body)
					expectNoEcho(logLines.join(""))
					if (id !== "d") expect(update).not.toHaveBeenCalled()
					expect([200, 400, 404, 409, 500]).toContain(res.statusCode)
				},
			),
			{ numRuns: 120 },
		)
	})
})
