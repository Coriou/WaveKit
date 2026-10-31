import Fastify from "fastify"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	BANDPLANS_ERROR_DEFINITIONS,
	BANDPLANS_LIMITS,
} from "@wavekit/api-types"
import type {
	BandPlanPackView,
	BandPlansErrorCode,
	BandPlanStackView,
	ExpectedToken,
	ImportPreview,
	ResolvedBandPlanView,
	ScanPresetJobView,
	ScanPresetListView,
} from "@wavekit/api-types"
import type { DeniedAdmission } from "../../../src/access/types.js"
import { bandPlanRoutes } from "../../../src/api/routes/bandplans.js"
import { BandPlansError } from "../../../src/core/bandplans/contract.js"
import type {
	BandPlanMutationResult,
	BandPlanService,
} from "../../../src/core/bandplans/contract.js"

const token: ExpectedToken = {
	storeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	revision: 0,
}
const presetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const importedId = "imported-0123456789ab"
const operatorBandId = "op-0123456789ab"
const band = {
	name: "Local",
	startHz: 145_000_000,
	endHz: 146_000_000,
	group: "amateur" as const,
	mode: null,
	bandwidthHz: null,
	stepHz: null,
	skip: null,
	channels: [],
	parentId: null,
	colourHint: null,
	registryRef: null,
}
const previewBody = {
	format: "sdrpp-json" as const,
	fileName: "plan.json",
	contentBase64: "",
	groupOverrides: [],
}
const commitBody = {
	...previewBody,
	expected: token,
	previewDigest: "ab".repeat(32),
	name: null,
	author: null,
	licence: null,
	keepColourHints: false,
	replacesPackId: null,
	addToStack: false,
}
const presetBody = {
	name: "Mine",
	job: {
		mode: null,
		bandplans: ["airband"],
		ranges: [],
		exclusions: [],
		protocols: [],
		sensitivity: null,
		thresholdDb: null,
		fftSize: null,
		integrationMs: null,
		dwellMs: null,
		settleMs: null,
	},
}
const stackView = {
	schemaVersion: 1,
	marker: "stack",
} as unknown as BandPlanStackView
const resolvedView = { marker: "resolved" } as unknown as ResolvedBandPlanView
const packView = { marker: "pack" } as unknown as BandPlanPackView
const presetsView = { marker: "presets" } as unknown as ScanPresetListView
const jobView = { marker: "job" } as unknown as ScanPresetJobView
const preview = { marker: "preview" } as unknown as ImportPreview
const writeResult: BandPlanMutationResult = {
	changed: true,
	view: stackView,
	createdId: "op-0123456789ab",
	delivery: "sent",
}

const apps: FastifyInstance[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const app of apps.splice(0)) await app.close()
})

function createService(): BandPlanService & {
	view: ReturnType<typeof vi.fn>
	resolved: ReturnType<typeof vi.fn>
	pack: ReturnType<typeof vi.fn>
	presets: ReturnType<typeof vi.fn>
	presetJob: ReturnType<typeof vi.fn>
	previewImport: ReturnType<typeof vi.fn>
	mutate: ReturnType<typeof vi.fn>
	close: ReturnType<typeof vi.fn>
} {
	return {
		view: vi.fn(() => stackView),
		resolved: vi.fn(() => resolvedView),
		pack: vi.fn(() => packView),
		presets: vi.fn(() => presetsView),
		presetJob: vi.fn(() => jobView),
		previewImport: vi.fn(() => preview),
		mutate: vi.fn(() => Promise.resolve(writeResult)),
		close: vi.fn(() => Promise.resolve()),
	}
}

async function server(
	service: BandPlanService,
	authorizeMutation?: (request: FastifyRequest) => DeniedAdmission | undefined,
) {
	const app = Fastify({ logger: false })
	apps.push(app)
	app.setErrorHandler((_error, _request, reply) => {
		void reply.code(400).send({ global: true })
	})
	await app.register(bandPlanRoutes, {
		service,
		...(authorizeMutation ? { authorizeMutation } : {}),
	})
	await app.ready()
	return app
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

function inject(
	app: FastifyInstance,
	method: HttpMethod,
	url: string,
	payload?: object,
) {
	return app.inject({
		method,
		url,
		...(payload === undefined ? {} : { payload }),
	})
}

function errorBody(response: { json: () => unknown }) {
	return response.json() as {
		error: string
		code: string
		message: string
		details?: { current: ExpectedToken }
	}
}

describe("band-plan routes", () => {
	it("registers every read and the design's write routes only with authorizeMutation", async () => {
		const service = createService()
		const limits = new Map<string, number | undefined>()
		const registered: string[] = []
		const app = Fastify({ logger: false })
		apps.push(app)
		app.addHook("onRoute", route => {
			if (route.method === "HEAD") return
			const method = String(route.method)
			registered.push(`${method} ${route.url}`)
			limits.set(`${method} ${route.url}`, route.bodyLimit)
		})
		await app.register(bandPlanRoutes, {
			service,
			authorizeMutation: () => undefined,
		})
		await app.ready()
		expect(registered).toEqual([
			"GET /api/bandplans",
			"GET /api/bandplans/resolved",
			"GET /api/bandplans/packs/:packId",
			"GET /api/bandplans/presets",
			"GET /api/bandplans/presets/:presetId/job",
			"PUT /api/bandplans/stack",
			"DELETE /api/bandplans/stack",
			"PATCH /api/bandplans/packs/:packId/bands/:bandId/edit",
			"DELETE /api/bandplans/packs/:packId/bands/:bandId/edit",
			"DELETE /api/bandplans/packs/:packId/edits",
			"DELETE /api/bandplans/packs/:packId",
			"POST /api/bandplans/operator-bands",
			"PUT /api/bandplans/operator-bands/:bandId",
			"DELETE /api/bandplans/operator-bands/:bandId",
			"POST /api/bandplans/imports/preview",
			"POST /api/bandplans/imports",
			"POST /api/bandplans/presets",
			"PUT /api/bandplans/presets/:presetId",
			"DELETE /api/bandplans/presets/:presetId",
		])
		expect(limits.get("PUT /api/bandplans/stack")).toBe(
			BANDPLANS_LIMITS.requestBytes,
		)
		expect(limits.get("POST /api/bandplans/imports/preview")).toBe(
			BANDPLANS_LIMITS.importRequestBytes,
		)
		expect(limits.get("POST /api/bandplans/imports")).toBe(
			BANDPLANS_LIMITS.importRequestBytes,
		)
		expect(limits.get("POST /api/bandplans/presets")).toBe(
			BANDPLANS_LIMITS.requestBytes,
		)
	})

	it("registers GET routes only when authorizeMutation is omitted", async () => {
		const service = createService()
		const registered: string[] = []
		const app = Fastify({ logger: false })
		apps.push(app)
		app.setErrorHandler((_error, _request, reply) => {
			void reply.code(400).send({ global: true })
		})
		app.addHook("onRoute", route => {
			if (route.method !== "HEAD")
				registered.push(`${String(route.method)} ${route.url}`)
		})
		await app.register(bandPlanRoutes, { service })
		await app.ready()
		expect(registered).toEqual([
			"GET /api/bandplans",
			"GET /api/bandplans/resolved",
			"GET /api/bandplans/packs/:packId",
			"GET /api/bandplans/presets",
			"GET /api/bandplans/presets/:presetId/job",
		])
		const read = await app.inject({ method: "GET", url: "/api/bandplans" })
		expect(read.statusCode).toBe(200)
		expect(read.json()).toEqual(stackView)
		const denied = await app.inject({
			method: "POST",
			url: "/api/bandplans/presets",
			payload: { expected: token, preset: presetBody },
		})
		expect(denied.statusCode).not.toBe(201)
		expect(service.mutate).not.toHaveBeenCalled()
		expect(service.previewImport).not.toHaveBeenCalled()
	})

	it("serves every route and forwards service results without internal fields", async () => {
		const service = createService()
		const authorize = vi.fn(() => undefined)
		const app = await server(service, authorize)
		const reads: ReadonlyArray<readonly [string, unknown]> = [
			["/api/bandplans", stackView],
			["/api/bandplans/resolved", resolvedView],
			["/api/bandplans/packs/builtin-eu", packView],
			[`/api/bandplans/packs/${importedId}`, packView],
			["/api/bandplans/packs/operator", packView],
			["/api/bandplans/presets", presetsView],
			["/api/bandplans/presets/builtin-airband/job", jobView],
			["/api/bandplans/presets/builtin-combo-ism-srd/job", jobView],
			[`/api/bandplans/presets/${presetId}/job`, jobView],
		]
		for (const [url, body] of reads) {
			const response = await inject(app, "GET", url)
			expect(response.statusCode, url).toBe(200)
			expect(response.json()).toEqual(body)
			expect(authorize).not.toHaveBeenCalled()
		}
		expect(service.pack).toHaveBeenCalledWith("builtin-eu")
		expect(service.pack).toHaveBeenCalledWith(importedId)
		expect(service.pack).toHaveBeenCalledWith("operator")
		expect(service.presetJob).toHaveBeenCalledWith("builtin-airband")
		expect(service.presetJob).toHaveBeenCalledWith("builtin-combo-ism-srd")
		expect(service.presetJob).toHaveBeenCalledWith(presetId)

		const writes: ReadonlyArray<
			readonly [HttpMethod, string, object, 200 | 201, string]
		> = [
			[
				"PUT",
				"/api/bandplans/stack",
				{ expected: token, entries: [{ packId: "builtin-eu", enabled: true }] },
				200,
				"set-stack",
			],
			[
				"DELETE",
				"/api/bandplans/stack",
				{ expected: token },
				200,
				"reset-stack",
			],
			[
				"PATCH",
				"/api/bandplans/packs/builtin-eu/bands/airband/edit",
				{ expected: token, set: { name: "Tower" } },
				200,
				"patch-band-edit",
			],
			[
				"DELETE",
				"/api/bandplans/packs/builtin-eu/bands/airband/edit",
				{ expected: token },
				200,
				"reset-band-edits",
			],
			[
				"DELETE",
				"/api/bandplans/packs/builtin-eu/edits",
				{ expected: token },
				200,
				"reset-pack-edits",
			],
			[
				"DELETE",
				`/api/bandplans/packs/${importedId}`,
				{ expected: token },
				200,
				"delete-pack",
			],
			[
				"POST",
				"/api/bandplans/operator-bands",
				{ expected: token, band },
				201,
				"create-operator-band",
			],
			[
				"PUT",
				`/api/bandplans/operator-bands/${operatorBandId}`,
				{ expected: token, band },
				200,
				"replace-operator-band",
			],
			[
				"DELETE",
				`/api/bandplans/operator-bands/${operatorBandId}`,
				{ expected: token },
				200,
				"delete-operator-band",
			],
			["POST", "/api/bandplans/imports", commitBody, 201, "commit-import"],
			[
				"POST",
				"/api/bandplans/presets",
				{ expected: token, preset: presetBody },
				201,
				"create-preset",
			],
			[
				"PUT",
				`/api/bandplans/presets/${presetId}`,
				{ expected: token, preset: presetBody },
				200,
				"replace-preset",
			],
			[
				"DELETE",
				`/api/bandplans/presets/${presetId}`,
				{ expected: token },
				200,
				"delete-preset",
			],
		]
		for (const [method, url, payload, status, type] of writes) {
			service.mutate.mockClear()
			const response = await inject(app, method, url, payload)
			expect(response.statusCode, `${method} ${url}`).toBe(status)
			expect(response.json()).toEqual({
				view: stackView,
				createdId: writeResult.createdId,
			})
			expect(
				Object.keys(response.json<Record<string, unknown>>()).sort(),
			).toEqual(["createdId", "view"])
			expect(service.mutate).toHaveBeenCalledOnce()
			expect(service.mutate.mock.calls[0]?.[0]).toMatchObject({ type })
		}
		const previewResponse = await app.inject({
			method: "POST",
			url: "/api/bandplans/imports/preview",
			payload: previewBody,
		})
		expect(previewResponse.statusCode).toBe(200)
		expect(previewResponse.json()).toEqual(preview)
		expect(service.previewImport).toHaveBeenCalledWith(previewBody)
		expect(service.mutate).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "preview" }),
		)
		expect(service.close).not.toHaveBeenCalled()
	})

	it("supplies patch defaults and path ids, and preserves a null createdId", async () => {
		const service = createService()
		service.mutate.mockResolvedValue({ ...writeResult, createdId: null })
		const app = await server(service, () => undefined)
		const response = await app.inject({
			method: "PATCH",
			url: "/api/bandplans/packs/builtin-eu/bands/airband/edit",
			payload: { expected: token, set: { name: "Tower" } },
		})
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({ view: stackView, createdId: null })
		expect(service.mutate).toHaveBeenCalledWith({
			type: "patch-band-edit",
			expected: token,
			packId: "builtin-eu",
			bandId: "airband",
			set: { name: "Tower" },
			reset: [],
		})
	})

	it("rejects extra keys, bad path ids and empty edits before authorization", async () => {
		const service = createService()
		const authorize = vi.fn(() => undefined)
		const app = await server(service, authorize)
		const cases: ReadonlyArray<
			readonly [HttpMethod, string, object | undefined]
		> = [
			[
				"PUT",
				"/api/bandplans/stack",
				{ expected: token, entries: [], extra: true },
			],
			["PUT", "/api/bandplans/stack", []],
			[
				"PUT",
				"/api/bandplans/stack",
				{ entries: [{ packId: "builtin-eu", enabled: true }], expected: null },
			],
			[
				"DELETE",
				`/api/bandplans/packs/${importedId}`,
				{ expected: token, packId: importedId },
			],
			[
				"PATCH",
				"/api/bandplans/packs/builtin-eu/bands/airband/edit",
				{ expected: token },
			],
			[
				"PATCH",
				"/api/bandplans/packs/builtin-eu/bands/airband/edit",
				{ expected: token, set: { name: "Tower" }, reset: ["name"] },
			],
			[
				"PATCH",
				"/api/bandplans/packs/builtin-eu/bands/Airband/edit",
				{ expected: token, set: { name: "Tower" } },
			],
			[
				"PATCH",
				"/api/bandplans/packs/nope/bands/airband/edit",
				{ expected: token, set: { name: "Tower" } },
			],
			[
				"DELETE",
				"/api/bandplans/packs/imported-ZZZZZZZZZZZZ",
				{ expected: token },
			],
			["DELETE", "/api/bandplans/packs/operator", { expected: token }],
			["PUT", `/api/bandplans/operator-bands/Bad`, { expected: token, band }],
			[
				"POST",
				"/api/bandplans/imports/preview",
				{ ...previewBody, expected: token },
			],
			[
				"POST",
				"/api/bandplans/imports/preview",
				{
					...previewBody,
					groupOverrides: [
						{ sourceType: "a", group: "air" },
						{ sourceType: "a", group: "marine" },
					],
				},
			],
			[
				"PUT",
				`/api/bandplans/presets/${presetId.toUpperCase()}`,
				{ expected: token, preset: presetBody },
			],
			[
				"PUT",
				"/api/bandplans/presets/not-a-uuid",
				{ expected: token, preset: presetBody },
			],
			["GET", "/api/bandplans/packs/Nope", undefined],
			["GET", "/api/bandplans/packs/builtin-nope", undefined],
			["GET", "/api/bandplans/presets/not-a-preset/job", undefined],
			["GET", "/api/bandplans/presets/Builtin-airband/job", undefined],
		]
		for (const [method, url, payload] of cases) {
			authorize.mockClear()
			const response = await inject(app, method, url, payload)
			expect(response.statusCode, `${method} ${url}`).toBe(400)
			expect(errorBody(response).code).toBe("BANDPLANS_INVALID")
			expect(authorize).not.toHaveBeenCalled()
		}
		expect(service.mutate).not.toHaveBeenCalled()
		expect(service.pack).not.toHaveBeenCalled()
		expect(service.presetJob).not.toHaveBeenCalled()
		expect(service.previewImport).not.toHaveBeenCalled()
	})

	it("rejects previewSha256 as an unknown key", async () => {
		const service = createService()
		const authorize = vi.fn(() => undefined)
		const app = await server(service, authorize)
		const digest = "ab".repeat(32)
		const cases = [
			[
				"/api/bandplans/imports/preview",
				{ ...previewBody, previewSha256: digest },
			],
			["/api/bandplans/imports", { ...commitBody, previewSha256: digest }],
		] as const
		for (const [url, payload] of cases) {
			const response = await app.inject({ method: "POST", url, payload })
			expect(response.statusCode, url).toBe(400)
			expect(errorBody(response).code).toBe("BANDPLANS_INVALID")
		}
		expect(authorize).not.toHaveBeenCalled()
		expect(service.previewImport).not.toHaveBeenCalled()
		expect(service.mutate).not.toHaveBeenCalled()
	})

	it("returns read-only for builtin write ids before body validation", async () => {
		const service = createService()
		const authorize = vi.fn(() => undefined)
		const app = await server(service, authorize)
		const cases: ReadonlyArray<
			readonly [HttpMethod, string, object | undefined]
		> = [
			["DELETE", "/api/bandplans/packs/builtin-eu", undefined],
			["DELETE", "/api/bandplans/packs/builtin-not-real", { extra: true }],
			["PUT", "/api/bandplans/presets/builtin-airband", { extra: true }],
			["DELETE", "/api/bandplans/presets/builtin-", undefined],
			["DELETE", "/api/bandplans/presets/builtin-Air", {}],
		]
		for (const [method, url, payload] of cases) {
			const response = await inject(app, method, url, payload)
			expect(response.statusCode, `${method} ${url}`).toBe(409)
			expect(errorBody(response)).toMatchObject({
				error: "BandPlansError",
				code: "BANDPLANS_READ_ONLY",
				message: "Built-in band plans and presets are read-only.",
			})
		}
		expect(authorize).not.toHaveBeenCalled()
		expect(service.mutate).not.toHaveBeenCalled()
	})

	it("rejects operator as an edit pack before body validation", async () => {
		const service = createService()
		const authorize = vi.fn(() => undefined)
		const app = await server(service, authorize)
		const cases = [
			["PATCH", "/api/bandplans/packs/operator/bands/local/edit"],
			["DELETE", "/api/bandplans/packs/operator/bands/airband/edit"],
			["DELETE", "/api/bandplans/packs/operator/edits"],
		] as const
		for (const [method, url] of cases) {
			const response = await app.inject({ method, url, payload: {} })
			expect(response.statusCode, url).toBe(400)
			expect(errorBody(response).code).toBe("BANDPLANS_INVALID")
		}
		expect(authorize).not.toHaveBeenCalled()
		expect(service.mutate).not.toHaveBeenCalled()
	})

	it.each([
		[
			"PUT",
			"/api/bandplans/stack",
			{ entries: [{ packId: "builtin-eu", enabled: true }] },
		],
		["POST", "/api/bandplans/presets", { preset: presetBody }],
		["POST", "/api/bandplans/imports", { ...commitBody, expected: undefined }],
		["DELETE", `/api/bandplans/packs/${importedId}`, {}],
	] as const)(
		"requires the expected token before authorization (%s %s)",
		async (method, url, payload) => {
			const service = createService()
			const authorize = vi.fn(() => undefined)
			const app = await server(service, authorize)
			const response = await app.inject({ method, url, payload })
			expect(response.statusCode).toBe(428)
			expect(errorBody(response)).toMatchObject({
				error: "BandPlansError",
				code: "BANDPLANS_PRECONDITION_REQUIRED",
				message: "An expected band-plan token is required.",
			})
			expect(authorize).not.toHaveBeenCalled()
			expect(service.mutate).not.toHaveBeenCalled()
		},
	)

	it("maps every band-plan error code, including conflict details", async () => {
		const service = createService()
		let thrown: unknown = new BandPlansError("BANDPLANS_INVALID")
		service.view.mockImplementation(() => {
			throw thrown
		})
		const app = await server(service, () => undefined)
		for (const code of Object.keys(
			BANDPLANS_ERROR_DEFINITIONS,
		) as BandPlansErrorCode[]) {
			thrown = new BandPlansError(code)
			const response = await app.inject({
				method: "GET",
				url: "/api/bandplans",
			})
			expect(response.statusCode, code).toBe(
				BANDPLANS_ERROR_DEFINITIONS[code][0],
			)
			expect(response.json()).toEqual({
				error: "BandPlansError",
				code,
				message: BANDPLANS_ERROR_DEFINITIONS[code][1],
				// A service-side refusal names the body; route parses name their field.
				...(code === "BANDPLANS_INVALID"
					? {
							fields: [
								{
									field: "body",
									expected: "a band-plan request as documented in docs/API.md",
								},
							],
						}
					: {}),
			})
			expect(response.json()).not.toHaveProperty("global")
		}
		thrown = new BandPlansError("BANDPLANS_CONFLICT", token)
		const conflict = await app.inject({ method: "GET", url: "/api/bandplans" })
		expect(conflict.statusCode).toBe(409)
		expect(conflict.json()).toEqual({
			error: "BandPlansError",
			code: "BANDPLANS_CONFLICT",
			message: "Band plans changed; fetch the current state.",
			details: { current: token },
		})
		thrown = new BandPlansError("BANDPLANS_CONFLICT", {
			storeId: "nope",
			revision: -1,
		} as ExpectedToken)
		const hidden = await app.inject({ method: "GET", url: "/api/bandplans" })
		expect(hidden.statusCode).toBe(409)
		expect(hidden.body).not.toContain("nope")
		expect(hidden.json()).not.toHaveProperty("details")
		service.mutate.mockRejectedValue(new BandPlansError("BANDPLANS_BUSY"))
		const busy = await app.inject({
			method: "DELETE",
			url: "/api/bandplans/stack",
			payload: { expected: token },
		})
		expect(busy.statusCode).toBe(503)
		expect(errorBody(busy).code).toBe("BANDPLANS_BUSY")
		expect(errorBody(busy).message).toBe("Band plans are busy.")
	})

	it("maps parser failures and body limits, with a larger import limit", async () => {
		const service = createService()
		const authorize = vi.fn(() => undefined)
		const app = await server(service, authorize)
		const broken = await app.inject({
			method: "PUT",
			url: "/api/bandplans/stack",
			headers: { "content-type": "application/json" },
			payload: "{broken",
		})
		expect(broken.statusCode).toBe(400)
		expect(errorBody(broken).code).toBe("BANDPLANS_INVALID")
		const unsupported = await app.inject({
			method: "PUT",
			url: "/api/bandplans/stack",
			headers: { "content-type": "application/x-unsupported" },
			payload: "plain",
		})
		expect(unsupported.statusCode).toBe(400)
		expect(errorBody(unsupported).code).toBe("BANDPLANS_INVALID")
		const oversized = await app.inject({
			method: "PUT",
			url: "/api/bandplans/stack",
			headers: { "content-type": "application/json" },
			payload: " ".repeat(BANDPLANS_LIMITS.requestBytes + 1),
		})
		expect(oversized.statusCode).toBe(409)
		expect(errorBody(oversized).code).toBe("BANDPLANS_QUOTA")
		const importTooLarge = await app.inject({
			method: "POST",
			url: "/api/bandplans/imports/preview",
			headers: { "content-type": "application/json" },
			payload: " ".repeat(BANDPLANS_LIMITS.importRequestBytes + 1),
		})
		expect(importTooLarge.statusCode).toBe(413)
		expect(errorBody(importTooLarge).code).toBe("BANDPLANS_IMPORT_TOO_LARGE")
		expect(authorize).not.toHaveBeenCalled()
		const contentBase64 = "A".repeat(1024 * 1024)
		const largePreview = await app.inject({
			method: "POST",
			url: "/api/bandplans/imports/preview",
			payload: { ...previewBody, contentBase64 },
		})
		expect(largePreview.statusCode).toBe(200)
		expect(service.previewImport).toHaveBeenCalledOnce()
		expect(authorize).toHaveBeenCalledOnce()
	})

	it("hides unknown failures and leaves sibling handling alone", async () => {
		const service = createService()
		service.view.mockImplementation(() => {
			throw new Error("secret /tmp/state.json")
		})
		const app = await server(service, () => undefined)
		const response = await app.inject({ method: "GET", url: "/api/bandplans" })
		expect(response.statusCode).toBe(503)
		expect(response.json()).toEqual({
			error: "BandPlansError",
			code: "BANDPLANS_UNAVAILABLE",
			message: "Band-plan storage is unavailable.",
		})
		expect(response.body).not.toContain("secret")
		const sibling = Fastify({ logger: false })
		apps.push(sibling)
		sibling.setErrorHandler((_error, _request, reply) => {
			void reply.code(418).send({ sibling: true })
		})
		sibling.get("/sibling", () => {
			throw new Error("sibling secret")
		})
		const other = await sibling.inject({ method: "GET", url: "/sibling" })
		expect(other.statusCode).toBe(418)
		expect(other.json()).toEqual({ sibling: true })
	})

	it.each([400, 401, 403, 429, 503] as const)(
		"sends owner denial %i before admission",
		async status => {
			const service = createService()
			const authorize = vi.fn((request: FastifyRequest) => {
				expect(request.raw.url).toBe("/api/bandplans/stack")
				expect(request.raw.headers["authorization"]).toBe("Bearer original")
				const denied: DeniedAdmission = {
					kind: "deny",
					status,
					code: "AUTH_REQUIRED",
					headers: { "cache-control": "no-store", "retry-after": "1" },
				}
				return denied
			})
			const app = await server(service, authorize)
			const response = await app.inject({
				method: "PUT",
				url: "/api/bandplans/stack",
				headers: { authorization: "Bearer original" },
				payload: {
					expected: token,
					entries: [{ packId: "builtin-eu", enabled: true }],
				},
			})
			expect(response.statusCode).toBe(status)
			expect(response.json()).toEqual({ code: "AUTH_REQUIRED" })
			expect(response.headers["cache-control"]).toBe("no-store")
			expect(response.headers["retry-after"]).toBe("1")
			expect(service.mutate).not.toHaveBeenCalled()
		},
	)

	it("denies import preview before the service sees the file", async () => {
		const service = createService()
		const app = await server(service, () => ({
			kind: "deny",
			status: 401,
			code: "AUTH_REQUIRED",
			headers: {},
		}))
		const response = await app.inject({
			method: "POST",
			url: "/api/bandplans/imports/preview",
			payload: previewBody,
		})
		expect(response.statusCode).toBe(401)
		expect(service.previewImport).not.toHaveBeenCalled()
		expect(service.mutate).not.toHaveBeenCalled()
	})

	it("admits mutation and preview in the same turn as authorization", async () => {
		const service = createService()
		let revoked = false
		const app = await server(service, () => {
			queueMicrotask(() => {
				revoked = true
			})
			return undefined
		})
		service.mutate.mockImplementation(() => {
			expect(revoked).toBe(false)
			return Promise.resolve(writeResult)
		})
		service.previewImport.mockImplementation(() => {
			expect(revoked).toBe(false)
			return preview
		})
		const write = await app.inject({
			method: "DELETE",
			url: "/api/bandplans/stack",
			payload: { expected: token },
		})
		expect(write.statusCode).toBe(200)
		revoked = false
		const imported = await app.inject({
			method: "POST",
			url: "/api/bandplans/imports/preview",
			payload: previewBody,
		})
		expect(imported.statusCode).toBe(200)
		expect(service.mutate).toHaveBeenCalledOnce()
		expect(service.previewImport).toHaveBeenCalledOnce()
	})
})
