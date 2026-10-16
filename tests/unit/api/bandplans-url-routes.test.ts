import Fastify from "fastify"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BANDPLANS_ERROR_DEFINITIONS } from "@wavekit/api-types"
import type {
	BandPlansErrorCode,
	BandPlanUpdateCheck,
	ExpectedToken,
	ImportUrlPreview,
} from "@wavekit/api-types"
import type { DeniedAdmission } from "../../../src/access/types.js"
import { bandPlanRoutes } from "../../../src/api/routes/bandplans.js"
import { BandPlansError } from "../../../src/core/bandplans/contract.js"
import type { BandPlanService } from "../../../src/core/bandplans/contract.js"

const token: ExpectedToken = {
	storeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	revision: 0,
}
const importedId = "imported-0123456789ab"
const urlPreview = { marker: "url-preview" } as unknown as ImportUrlPreview
const updateCheck = { marker: "update" } as unknown as BandPlanUpdateCheck
const urlBody = {
	url: "https://raw.githubusercontent.com/o/r/main/plan.json",
	format: "sdrpp-json",
	groupOverrides: [],
}
const denied: DeniedAdmission = {
	status: 401,
	code: "UNAUTHORIZED",
	headers: {},
} as unknown as DeniedAdmission

const apps: FastifyInstance[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const app of apps.splice(0)) await app.close()
})

function createService(withUrl = true) {
	const base = {
		view: vi.fn(),
		resolved: vi.fn(),
		pack: vi.fn(),
		presets: vi.fn(),
		presetJob: vi.fn(),
		previewImport: vi.fn(),
		mutate: vi.fn(() =>
			Promise.resolve({
				changed: true,
				view: {},
				createdId: importedId,
				delivery: "sent",
			}),
		),
		close: vi.fn(() => Promise.resolve()),
	}
	const previewImportUrl = vi.fn((_request: unknown) =>
		Promise.resolve(urlPreview),
	)
	const checkImportUpdate = vi.fn((_packId: string) =>
		Promise.resolve(updateCheck),
	)
	return {
		previewImportUrl,
		checkImportUpdate,
		mutate: base.mutate,
		service: (withUrl
			? { ...base, previewImportUrl, checkImportUpdate }
			: base) as unknown as BandPlanService,
	}
}

async function server(
	service: BandPlanService,
	authorizeMutation?: (request: FastifyRequest) => DeniedAdmission | undefined,
) {
	const app = Fastify({ logger: false })
	apps.push(app)
	await app.register(bandPlanRoutes, {
		service,
		...(authorizeMutation ? { authorizeMutation } : {}),
	})
	await app.ready()
	return app
}

const previewUrl = "/api/bandplans/imports/preview-url"
const checkUrl = `/api/bandplans/packs/${importedId}/check-update`

describe("band-plan URL routes", () => {
	it("are absent without authorizeMutation", async () => {
		const f = createService()
		const app = await server(f.service)
		const a = await app.inject({
			method: "POST",
			url: previewUrl,
			payload: urlBody,
		})
		const b = await app.inject({ method: "POST", url: checkUrl })
		expect(a.statusCode).toBe(404)
		expect(b.statusCode).toBe(404)
		expect(f.previewImportUrl).not.toHaveBeenCalled()
		expect(f.checkImportUpdate).not.toHaveBeenCalled()
	})

	it("refuses unauthorized callers without calling the service", async () => {
		const f = createService()
		const app = await server(f.service, () => denied)
		const a = await app.inject({
			method: "POST",
			url: previewUrl,
			payload: urlBody,
		})
		const b = await app.inject({ method: "POST", url: checkUrl })
		expect(a.statusCode).toBe(401)
		expect(b.statusCode).toBe(401)
		expect(f.previewImportUrl).not.toHaveBeenCalled()
		expect(f.checkImportUpdate).not.toHaveBeenCalled()
	})

	it("re-authorizes after the body is parsed, immediately before the service", async () => {
		const f = createService()
		const authorize = vi.fn((_r: FastifyRequest) => denied)
		const app = await server(f.service, authorize)
		const res = await app.inject({
			method: "POST",
			url: previewUrl,
			payload: urlBody,
		})
		expect(res.statusCode).toBe(401)
		expect(authorize).toHaveBeenCalledTimes(1)
		expect(f.previewImportUrl).not.toHaveBeenCalled()
		// A malformed body fails before authorization is consulted.
		const bad = await app.inject({
			method: "POST",
			url: previewUrl,
			payload: { url: "x", extra: 1 },
		})
		expect(bad.statusCode).toBe(400)
		expect(authorize).toHaveBeenCalledTimes(1)
	})

	it("returns the preview and update-check shapes", async () => {
		const f = createService()
		const app = await server(f.service, () => undefined)
		const a = await app.inject({
			method: "POST",
			url: previewUrl,
			payload: urlBody,
		})
		expect(a.statusCode).toBe(200)
		expect(a.json()).toEqual(urlPreview)
		expect(f.previewImportUrl).toHaveBeenCalledWith(urlBody)
		const b = await app.inject({ method: "POST", url: checkUrl })
		expect(b.statusCode).toBe(200)
		expect(b.json()).toEqual(updateCheck)
		expect(f.checkImportUpdate).toHaveBeenCalledWith(importedId)
	})

	it("rejects an invalid packId before the service", async () => {
		const f = createService()
		const app = await server(f.service, () => undefined)
		const res = await app.inject({
			method: "POST",
			url: "/api/bandplans/packs/NOT%20A%20PACK/check-update",
		})
		expect(res.statusCode).toBe(400)
		expect(f.checkImportUpdate).not.toHaveBeenCalled()
	})

	it.each([
		"BANDPLANS_URL_IMPORT_DISABLED",
		"BANDPLANS_URL_REFUSED",
		"BANDPLANS_URL_FETCH_FAILED",
		"BANDPLANS_URL_TIMEOUT",
		"BANDPLANS_IMPORT_TOO_LARGE",
		"BANDPLANS_BUSY",
		"BANDPLANS_INVALID",
		"BANDPLANS_NOT_FOUND",
	] as BandPlansErrorCode[])("maps %s on both routes", async code => {
		const f = createService()
		f.previewImportUrl.mockRejectedValue(new BandPlansError(code))
		f.checkImportUpdate.mockRejectedValue(new BandPlansError(code))
		const app = await server(f.service, () => undefined)
		const status = BANDPLANS_ERROR_DEFINITIONS[code][0]
		for (const res of [
			await app.inject({ method: "POST", url: previewUrl, payload: urlBody }),
			await app.inject({ method: "POST", url: checkUrl }),
		]) {
			expect(res.statusCode).toBe(status)
			expect(res.json()).toMatchObject({ error: "BandPlansError", code })
		}
	})

	it("maps an unknown pack to 404", async () => {
		const f = createService()
		f.checkImportUpdate.mockRejectedValue(
			new BandPlansError("BANDPLANS_NOT_FOUND"),
		)
		const app = await server(f.service, () => undefined)
		const res = await app.inject({ method: "POST", url: checkUrl })
		expect(res.statusCode).toBe(404)
	})

	it("answers 413 for an oversize preview-url body", async () => {
		const f = createService()
		const app = await server(f.service, () => undefined)
		const res = await app.inject({
			method: "POST",
			url: previewUrl,
			payload: { ...urlBody, url: "a".repeat(70 * 1024) },
		})
		expect(res.statusCode).toBe(413)
		expect(res.json()).toMatchObject({ code: "BANDPLANS_IMPORT_TOO_LARGE" })
		expect(f.previewImportUrl).not.toHaveBeenCalled()
	})

	it("does not register the routes when the service lacks the optional methods", async () => {
		const f = createService(false)
		const app = await server(f.service, () => undefined)
		for (const res of [
			await app.inject({ method: "POST", url: previewUrl, payload: urlBody }),
			await app.inject({ method: "POST", url: checkUrl }),
		])
			expect(res.statusCode).toBe(404)
	})

	it("forwards sourceUrl on commit", async () => {
		const f = createService()
		const app = await server(f.service, () => undefined)
		const sourceUrl = urlBody.url
		const res = await app.inject({
			method: "POST",
			url: "/api/bandplans/imports",
			payload: {
				format: "sdrpp-json",
				fileName: "plan.json",
				contentBase64: "",
				groupOverrides: [],
				expected: token,
				previewDigest: "ab".repeat(32),
				name: null,
				author: null,
				licence: null,
				keepColourHints: false,
				replacesPackId: null,
				addToStack: false,
				sourceUrl,
			},
		})
		expect(res.statusCode).toBe(201)
		expect(f.mutate).toHaveBeenCalledWith(
			expect.objectContaining({ type: "commit-import", sourceUrl }),
		)
	})
})
