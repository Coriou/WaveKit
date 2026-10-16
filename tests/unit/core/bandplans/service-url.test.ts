import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BANDPLAN_URL_IMPORT_HOSTS } from "@wavekit/api-types"
import type { BandPlansErrorCode, ImportUrlPreview } from "@wavekit/api-types"
import {
	builtinPackIdFor,
	projectBuiltinPacks,
} from "../../../../src/core/bandplans/builtin-packs.js"
import { parseGqrxBandPlan } from "../../../../src/core/bandplans/import/gqrx.js"
import { parseSdrppBandPlan } from "../../../../src/core/bandplans/import/sdrpp.js"
import { parseSdrSharpBandPlan } from "../../../../src/core/bandplans/import/sdrsharp.js"
import { diffImportedBands } from "../../../../src/core/bandplans/import/update-diff.js"
import {
	builtinPresetsFor,
	presetIssuesFor,
	presetToJobSpec,
} from "../../../../src/core/bandplans/presets.js"
import { resolveBandPlans } from "../../../../src/core/bandplans/resolve.js"
import { createBandPlanService } from "../../../../src/core/bandplans/service.js"
import type { BandPlanServiceDeps } from "../../../../src/core/bandplans/service.js"
import { BandPlansError } from "../../../../src/core/bandplans/contract.js"
import type {
	BandPlanService,
	BandPlanServiceOptions,
	BandPlanUrlFetcher,
} from "../../../../src/core/bandplans/contract.js"
import {
	previewDigestFor,
	transition,
} from "../../../../src/core/bandplans/domain.js"

/** The barrel's deps plus the WG6 diff Main wires there. */
const DEPS: BandPlanServiceDeps = {
	projectBuiltinPacks,
	builtinPackIdFor,
	resolveBandPlans,
	transition,
	parseSdrppBandPlan,
	builtinPresetsFor,
	presetIssuesFor,
	presetToJobSpec,
	importParsers: {
		"sdrsharp-xml": parseSdrSharpBandPlan,
		"gqrx-csv": parseGqrxBandPlan,
	},
	diffImportedBands,
}
function openBandPlanService(
	options: BandPlanServiceOptions,
	deps: BandPlanServiceDeps = DEPS,
) {
	return createBandPlanService(options, deps)
}

const HOST = "plans.example.org"
const URL_A = `https://${HOST}/files/EU%20plan.json?rev=2`
const SECRET = "s3cret-sentinel"
const encoder = new TextEncoder()
const roots: string[] = []
const services: BandPlanService[] = []
afterEach(async () => {
	await Promise.all(services.splice(0).map(s => s.close()))
	await Promise.all(
		roots.splice(0).map(p => rm(p, { recursive: true, force: true })),
	)
})

function sdrpp(bands: [string, string, number, number][]): Uint8Array {
	return encoder.encode(
		JSON.stringify({
			name: "Test plan",
			bands: bands.map(([name, type, start, end]) => ({
				name,
				type,
				start,
				end,
			})),
		}),
	)
}
const V1 = sdrpp([
	["Alpha", "amateur", 1_000_000, 2_000_000],
	["Bravo", "amateur", 3_000_000, 4_000_000],
	["Charlie", "marine", 5_000_000, 6_000_000],
])
const V2 = sdrpp([
	["Alpha", "amateur", 1_000_000, 2_500_000],
	["Charlie", "marine", 5_000_000, 6_000_000],
	["Delta", "amateur", 500_000, 900_000],
])

function fakeFetcher(bytes: () => Uint8Array) {
	return vi.fn<BandPlanUrlFetcher>(() =>
		Promise.resolve({ bytes: bytes(), contentType: "application/json" }),
	)
}
type LooseOptions = {
	[K in keyof BandPlanServiceOptions]?: BandPlanServiceOptions[K] | undefined
}
async function open(
	loose: LooseOptions = {},
	deps: BandPlanServiceDeps = DEPS,
): Promise<BandPlanService> {
	const stateDir = await mkdtemp(join(tmpdir(), "wavekit-bandplans-url-"))
	roots.push(stateDir)
	const options: BandPlanServiceOptions = {
		stateDir,
		context: { region: "EU", effectiveCountry: null },
		writable: loose.writable ?? true,
		domain: { now: () => "2026-10-16T00:00:00.000Z" },
	}
	// An explicit undefined drops the option (exactOptionalPropertyTypes).
	const hosts = "urlImportHosts" in loose ? loose.urlImportHosts : [HOST]
	const service = await openBandPlanService(
		{
			...options,
			...(hosts ? { urlImportHosts: hosts } : {}),
			...(loose.urlFetcher ? { urlFetcher: loose.urlFetcher } : {}),
		},
		deps,
	)
	services.push(service)
	return service
}
async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise
	} catch (error) {
		expect(error).toBeInstanceOf(BandPlansError)
		const message = error instanceof Error ? error.message : ""
		expect(message).not.toContain(SECRET)
		expect(message).not.toContain(HOST)
		return error instanceof BandPlansError ? (error.code ?? "") : "?"
	}
	return "resolved"
}
function previewUrl(service: BandPlanService, request: unknown) {
	if (!service.previewImportUrl) throw new Error("missing previewImportUrl")
	return service.previewImportUrl(request)
}
function checkUpdate(service: BandPlanService, packId: string) {
	if (!service.checkImportUpdate) throw new Error("missing checkImportUpdate")
	return service.checkImportUpdate(packId)
}
const request = (url = URL_A) => ({
	url,
	format: "sdrpp-json",
	groupOverrides: [],
})
function expected(service: BandPlanService) {
	const store = service.view().store
	if (store.state !== "available") throw new Error("store unavailable")
	return { storeId: store.storeId, revision: store.revision }
}
function commitOf(
	service: BandPlanService,
	preview: ImportUrlPreview,
	extra: Record<string, unknown> = {},
) {
	return {
		type: "commit-import",
		expected: expected(service),
		format: preview.format,
		fileName: preview.fileName,
		contentBase64: preview.contentBase64,
		groupOverrides: [],
		previewDigest: preview.previewDigest,
		name: null,
		author: null,
		licence: null,
		keepColourHints: true,
		replacesPackId: null,
		addToStack: false,
		sourceUrl: preview.sourceUrl,
		...extra,
	}
}
async function commitFromUrl(service: BandPlanService) {
	const preview = await previewUrl(service, request())
	const result = await service.mutate(commitOf(service, preview))
	if (!result.createdId) throw new Error("no pack created")
	return result.createdId
}

describe("band plan service: URL import (WG6 lane U)", () => {
	describe("disabled", () => {
		it.each([
			["no fetcher", { urlFetcher: undefined }],
			["empty hosts", { urlImportHosts: [] }],
			["not writable", { writable: false }],
		])("%s: 403 DISABLED, capabilities.urlImportHosts []", async (_, extra) => {
			const fetcher = fakeFetcher(() => V1)
			const service = await open({ urlFetcher: fetcher, ...extra })
			expect(service.view().capabilities.urlImportHosts).toEqual([])
			expect(await codeOf(previewUrl(service, request()))).toBe(
				"BANDPLANS_URL_IMPORT_DISABLED",
			)
			expect(await codeOf(checkUpdate(service, "imported-000000000000"))).toBe(
				"BANDPLANS_URL_IMPORT_DISABLED",
			)
			expect(fetcher).not.toHaveBeenCalled()
		})
		it("check-update without the injected diff is DISABLED", async () => {
			const fetcher = fakeFetcher(() => V1)
			const { diffImportedBands: _, ...rest } = DEPS
			const service = await open({ urlFetcher: fetcher }, rest)
			expect(await codeOf(checkUpdate(service, "imported-000000000000"))).toBe(
				"BANDPLANS_URL_IMPORT_DISABLED",
			)
			expect(fetcher).not.toHaveBeenCalled()
		})
		it("advertises the hosts when on, defaulting to BANDPLAN_URL_IMPORT_HOSTS", async () => {
			const on = await open({ urlFetcher: fakeFetcher(() => V1) })
			expect(on.view().capabilities.urlImportHosts).toEqual([HOST])
			const fallback = await open({
				urlFetcher: fakeFetcher(() => V1),
				urlImportHosts: undefined,
			})
			expect(fallback.view().capabilities.urlImportHosts).toEqual(
				BANDPLAN_URL_IMPORT_HOSTS.length > 0
					? [...BANDPLAN_URL_IMPORT_HOSTS]
					: [],
			)
		})
	})

	describe("previewImportUrl", () => {
		it("fetches once and answers an ImportUrlPreview bound to the URL", async () => {
			const fetcher = fakeFetcher(() => V1)
			const service = await open({ urlFetcher: fetcher })
			const preview = await previewUrl(service, request())
			expect(fetcher).toHaveBeenCalledTimes(1)
			expect(fetcher).toHaveBeenCalledWith(URL_A, [HOST])
			const sha = createHash("sha256").update(V1).digest("hex")
			expect(preview).toMatchObject({
				format: "sdrpp-json",
				fileName: "EU plan.json",
				bytes: V1.byteLength,
				sha256: sha,
				sourceUrl: URL_A,
				contentBase64: Buffer.from(V1).toString("base64"),
				trust: "community-unverified",
			})
			expect(preview.previewDigest).toBe(previewDigestFor(sha, [], URL_A))
			expect(preview.previewDigest).not.toBe(previewDigestFor(sha, []))
			expect(preview.bands.map(b => b.id)).toEqual([
				"alpha",
				"bravo",
				"charlie",
			])
			// Nothing persisted.
			expect(service.view().store).toMatchObject({ revision: 0 })
		})
		it.each([
			["https://plans.example.org/", "band-plan"],
			["https://plans.example.org/a/%E0%A4%A", "band-plan"],
			["https://plans.example.org/a/%0Abad", "band-plan"],
			[`https://plans.example.org/${"x".repeat(200)}`, "x".repeat(128)],
			["https://plans.example.org/dir/plan.json", "plan.json"],
		])("fileName for %s", async (url, fileName) => {
			const service = await open({ urlFetcher: fakeFetcher(() => V1) })
			expect((await previewUrl(service, request(url))).fileName).toBe(fileName)
		})
		it.each([
			["not an object", "nope"],
			["http URL", request("http://plans.example.org/a.json")],
			["port", request("https://plans.example.org:8443/a.json")],
			["userinfo", request(`https://u:${SECRET}@plans.example.org/a.json`)],
			["fragment", request("https://plans.example.org/a.json#x")],
			["unknown format", { ...request(), format: "csv" }],
			["extra key", { ...request(), extra: 1 }],
			["missing overrides", { url: URL_A, format: "sdrpp-json" }],
		])("400 INVALID for %s", async (_, body) => {
			const fetcher = fakeFetcher(() => V1)
			const service = await open({ urlFetcher: fetcher })
			expect(await codeOf(previewUrl(service, body))).toBe("BANDPLANS_INVALID")
			expect(fetcher).not.toHaveBeenCalled()
		})
		it.each([
			"https://evil.example.org/a.json",
			"https://sub.plans.example.org/a.json",
			"https://plans.example.org./a.json",
			"https://127.0.0.1/a.json",
		])(
			"REFUSED before fetching a host outside the allowlist: %s",
			async url => {
				const fetcher = fakeFetcher(() => V1)
				const service = await open({ urlFetcher: fetcher })
				expect(await codeOf(previewUrl(service, request(url)))).toBe(
					"BANDPLANS_URL_REFUSED",
				)
				expect(fetcher).not.toHaveBeenCalled()
			},
		)
		it.each<BandPlansErrorCode>([
			"BANDPLANS_URL_REFUSED",
			"BANDPLANS_URL_FETCH_FAILED",
			"BANDPLANS_URL_TIMEOUT",
			"BANDPLANS_IMPORT_TOO_LARGE",
			"BANDPLANS_BUSY",
		])("propagates fetcher %s", async code => {
			const service = await open({
				urlFetcher: () => Promise.reject(new BandPlansError(code)),
			})
			expect(await codeOf(previewUrl(service, request()))).toBe(code)
		})
		it("maps a foreign fetcher error to FETCH_FAILED without echoing it", async () => {
			const service = await open({
				urlFetcher: () => Promise.reject(new TypeError(`${SECRET} ${HOST}`)),
			})
			expect(await codeOf(previewUrl(service, request()))).toBe(
				"BANDPLANS_URL_FETCH_FAILED",
			)
		})
		it("rejects oversized fetched bytes as TOO_LARGE", async () => {
			const service = await open({
				urlFetcher: fakeFetcher(() => new Uint8Array(1024 * 1024 + 1)),
			})
			expect(await codeOf(previewUrl(service, request()))).toBe(
				"BANDPLANS_IMPORT_TOO_LARGE",
			)
		})
		it("rejects unparseable fetched bytes as IMPORT_INVALID without echoing them", async () => {
			const service = await open({
				urlFetcher: fakeFetcher(() => encoder.encode(`{"bands":"${SECRET}"}`)),
			})
			expect(await codeOf(previewUrl(service, request()))).toBe(
				"BANDPLANS_IMPORT_INVALID",
			)
		})
	})

	describe("commit with sourceUrl", () => {
		it("stores provenance.sourceUrl", async () => {
			const service = await open({ urlFetcher: fakeFetcher(() => V1) })
			const packId = await commitFromUrl(service)
			const pack = service.pack(packId).pack
			expect(pack.provenance).toMatchObject({
				kind: "imported",
				sourceUrl: URL_A,
				sourceName: "EU plan.json",
			})
		})
		it.each([
			["altered", { sourceUrl: "https://plans.example.org/other.json" }],
			["omitted", { sourceUrl: undefined }],
			["null", { sourceUrl: null }],
		])("MISMATCH when the URL is %s", async (_, extra) => {
			const service = await open({ urlFetcher: fakeFetcher(() => V1) })
			const preview = await previewUrl(service, request())
			const body = commitOf(service, preview, extra)
			if (extra.sourceUrl === undefined)
				Reflect.deleteProperty(body, "sourceUrl")
			expect(await codeOf(service.mutate(body))).toBe(
				"BANDPLANS_IMPORT_MISMATCH",
			)
		})
		it("upload digests are unchanged (no sourceUrl key, null sourceUrl)", async () => {
			const service = await open({ urlFetcher: fakeFetcher(() => V1) })
			const sha = createHash("sha256").update(V1).digest("hex")
			const upload = service.previewImport({
				format: "sdrpp-json",
				fileName: "plan.json",
				contentBase64: Buffer.from(V1).toString("base64"),
				groupOverrides: [],
			})
			expect(upload.previewDigest).toBe(previewDigestFor(sha, []))
			const body: Record<string, unknown> = {
				...commitOf(service, {
					...upload,
					sourceUrl: "",
					contentBase64: Buffer.from(V1).toString("base64"),
				}),
				sourceUrl: null,
			}
			const result = await service.mutate(body)
			expect(result.createdId).not.toBeNull()
			const pack = service.pack(result.createdId ?? "").pack
			expect(pack.provenance).not.toHaveProperty("sourceUrl")
		})
		it("refuses a sourceUrl whose host is not allowed, and any sourceUrl when off", async () => {
			const on = await open({ urlFetcher: fakeFetcher(() => V1) })
			const preview = await previewUrl(on, request())
			const evil = "https://evil.example.org/a.json"
			const sha = preview.sha256
			expect(
				await codeOf(
					on.mutate(
						commitOf(on, preview, {
							sourceUrl: evil,
							previewDigest: previewDigestFor(sha, [], evil),
						}),
					),
				),
			).toBe("BANDPLANS_URL_REFUSED")
			const off = await open({ urlFetcher: undefined })
			expect(await codeOf(off.mutate(commitOf(off, preview)))).toBe(
				"BANDPLANS_URL_IMPORT_DISABLED",
			)
		})
	})

	describe("checkImportUpdate", () => {
		it("404 for an unknown or operator pack", async () => {
			const service = await open({ urlFetcher: fakeFetcher(() => V1) })
			expect(await codeOf(checkUpdate(service, "imported-000000000000"))).toBe(
				"BANDPLANS_NOT_FOUND",
			)
			expect(await codeOf(checkUpdate(service, "operator"))).toBe(
				"BANDPLANS_NOT_FOUND",
			)
		})
		it("400 INVALID for a built-in or an uploaded pack without sourceUrl", async () => {
			const fetcher = fakeFetcher(() => V1)
			const service = await open({ urlFetcher: fetcher })
			expect(await codeOf(checkUpdate(service, "builtin-eu"))).toBe(
				"BANDPLANS_INVALID",
			)
			const upload = service.previewImport({
				format: "sdrpp-json",
				fileName: "plan.json",
				contentBase64: Buffer.from(V1).toString("base64"),
				groupOverrides: [],
			})
			const body: Record<string, unknown> = commitOf(service, {
				...upload,
				sourceUrl: "",
				contentBase64: Buffer.from(V1).toString("base64"),
			})
			delete body["sourceUrl"]
			const result = await service.mutate(body)
			expect(await codeOf(checkUpdate(service, result.createdId ?? ""))).toBe(
				"BANDPLANS_INVALID",
			)
			expect(fetcher).not.toHaveBeenCalled()
		})
		it("REFUSED when the stored host left the current allowlist", async () => {
			const first = await open({ urlFetcher: fakeFetcher(() => V1) })
			const packId = await commitFromUrl(first)
			const stateDir = roots[roots.length - 1] ?? ""
			await first.close()
			const fetcher = fakeFetcher(() => V2)
			const reopened = await openBandPlanService({
				stateDir,
				context: { region: "EU", effectiveCountry: null },
				writable: true,
				urlFetcher: fetcher,
				urlImportHosts: ["other.example.org"],
			})
			services.push(reopened)
			expect(await codeOf(checkUpdate(reopened, packId))).toBe(
				"BANDPLANS_URL_REFUSED",
			)
			expect(fetcher).not.toHaveBeenCalled()
		})
		it("up to date: same sha, empty lists, null preview, nothing persisted", async () => {
			const service = await open({ urlFetcher: fakeFetcher(() => V1) })
			const packId = await commitFromUrl(service)
			const revision = expected(service).revision
			const sha = createHash("sha256").update(V1).digest("hex")
			expect(await checkUpdate(service, packId)).toEqual({
				packId,
				sourceUrl: URL_A,
				checkedAt: "2026-10-16T00:00:00.000Z",
				currentSha256: sha,
				fetchedSha256: sha,
				upToDate: true,
				added: [],
				removed: [],
				changed: [],
				preview: null,
			})
			expect(expected(service).revision).toBe(revision)
		})
		it("changed: diff by id and a preview that commits as a replacement", async () => {
			let bytes = V1
			const service = await open({ urlFetcher: fakeFetcher(() => bytes) })
			const packId = await commitFromUrl(service)
			bytes = V2
			const check = await checkUpdate(service, packId)
			expect(check.upToDate).toBe(false)
			expect(check.fetchedSha256).toBe(
				createHash("sha256").update(V2).digest("hex"),
			)
			expect(check.added).toEqual([
				{ id: "delta", name: "Delta", startHz: 500_000, endHz: 900_000 },
			])
			expect(check.removed).toEqual([
				{ id: "bravo", name: "Bravo", startHz: 3_000_000, endHz: 4_000_000 },
			])
			expect(check.changed).toEqual([
				{
					id: "alpha",
					name: "Alpha",
					startHz: 1_000_000,
					endHz: 2_500_000,
					fields: ["endHz"],
				},
			])
			const preview = check.preview
			if (!preview) throw new Error("expected a preview")
			expect(preview.sourceUrl).toBe(URL_A)
			const result = await service.mutate(
				commitOf(service, preview, { replacesPackId: packId }),
			)
			expect(result.changed).toBe(true)
			const pack = service.pack(packId).pack
			expect(pack.bands.map(b => b.id).sort()).toEqual([
				"alpha",
				"charlie",
				"delta",
			])
			expect(pack.provenance).toMatchObject({ sourceUrl: URL_A })
			expect((await checkUpdate(service, packId)).upToDate).toBe(true)
		})
		it("propagates fetch errors and parse failures", async () => {
			let fail: Error | null = null
			let bytes = V1
			const service = await open({
				urlFetcher: () =>
					fail
						? Promise.reject(fail)
						: Promise.resolve({ bytes, contentType: null }),
			})
			const packId = await commitFromUrl(service)
			fail = new BandPlansError("BANDPLANS_URL_TIMEOUT")
			expect(await codeOf(checkUpdate(service, packId))).toBe(
				"BANDPLANS_URL_TIMEOUT",
			)
			fail = null
			bytes = encoder.encode(SECRET)
			expect(await codeOf(checkUpdate(service, packId))).toBe(
				"BANDPLANS_IMPORT_INVALID",
			)
		})
	})
})
