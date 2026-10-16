import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ImportUrlPreview } from "@wavekit/api-types"
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
import type {
	BandPlanService,
	BandPlanUrlFetcher,
} from "../../../../src/core/bandplans/contract.js"
import {
	previewDigestFor,
	transition,
} from "../../../../src/core/bandplans/domain.js"

// Feature: web-gaps-7, requirement 10.2: stored group overrides.

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
const HOST = "plans.example.org"
const URL_A = `https://${HOST}/files/plan.json`
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
const V1 = sdrpp([["Alpha", "amateur", 1_000_000, 2_000_000]])
const V2 = sdrpp([
	["Alpha", "amateur", 1_000_000, 2_500_000],
	["Bravo", "marine", 3_000_000, 4_000_000],
])
const B64 = Buffer.from(V1).toString("base64")
const OVERRIDES_UNSORTED = [
	{ sourceType: "marine", group: "other" },
	{ sourceType: "amateur", group: "marine" },
] as const
const OVERRIDES_SORTED = [
	{ sourceType: "amateur", group: "marine" },
	{ sourceType: "marine", group: "other" },
]

// Golden digests captured from the code before WG7 lane MIN changed it (V1 bytes).
const GOLDEN_UPLOAD_DIGEST =
	"e290658e87fcdca52d22d0c551f2bbcec61485d184aa98160de0e366b5c6ce8d"
const GOLDEN_URL_DIGEST =
	"555db1b8939eac855ce4b900cfd0a44b1fff24d9bc8eeddb39cd16140ecf6fd1"

let bytes: Uint8Array = V1
function fetcher() {
	return vi.fn<BandPlanUrlFetcher>(() =>
		Promise.resolve({ bytes, contentType: "application/json" }),
	)
}
async function open(stateDir?: string, f = fetcher()) {
	const dir = stateDir ?? (await mkdtemp(join(tmpdir(), "wavekit-ovr-")))
	if (stateDir === undefined) roots.push(dir)
	const service = createBandPlanService(
		{
			stateDir: dir,
			context: { region: "EU", effectiveCountry: null },
			writable: true,
			urlFetcher: f,
			urlImportHosts: [HOST],
		},
		DEPS,
	)
	const opened = await service
	services.push(opened)
	return { service: opened, dir, f }
}
function expected(service: BandPlanService) {
	const store = service.view().store
	if (store.state !== "available") throw new Error("store unavailable")
	return { storeId: store.storeId, revision: store.revision }
}
function commitBody(
	service: BandPlanService,
	preview: ImportUrlPreview | { previewDigest: string; contentBase64?: string },
	extra: Record<string, unknown>,
) {
	return {
		type: "commit-import",
		expected: expected(service),
		format: "sdrpp-json",
		fileName: "plan.json",
		contentBase64: B64,
		groupOverrides: [],
		previewDigest: preview.previewDigest,
		name: null,
		author: null,
		licence: null,
		keepColourHints: true,
		replacesPackId: null,
		addToStack: false,
		...extra,
	}
}
function provenanceOf(service: BandPlanService, packId: string) {
	const pack = service.view().packs.find(p => p.id === packId)
	if (!pack || pack.provenance.kind !== "imported")
		throw new Error("no imported pack")
	return pack.provenance
}
async function commitUrl(
	service: BandPlanService,
	groupOverrides: unknown[],
	replacesPackId: string | null = null,
) {
	const preview = await service.previewImportUrl?.({
		url: URL_A,
		format: "sdrpp-json",
		groupOverrides,
	})
	if (!preview) throw new Error("no preview")
	const result = await service.mutate(
		commitBody(service, preview, {
			contentBase64: preview.contentBase64,
			groupOverrides,
			sourceUrl: URL_A,
			replacesPackId,
		}),
	)
	return result.createdId ?? replacesPackId ?? ""
}

describe("stored group overrides (10.2)", () => {
	it("golden: digests of imports without overrides are unchanged", async () => {
		bytes = V1
		const { service } = await open()
		const upload = service.previewImport({
			format: "sdrpp-json",
			fileName: "plan.json",
			contentBase64: B64,
			groupOverrides: [],
		})
		expect(upload.previewDigest).toBe(GOLDEN_UPLOAD_DIGEST)
		const url = await service.previewImportUrl?.({
			url: URL_A,
			format: "sdrpp-json",
			groupOverrides: [],
		})
		expect(url?.previewDigest).toBe(GOLDEN_URL_DIGEST)
	})

	it("commit writes provenance.groupOverrides sorted as the digest sorts them", async () => {
		bytes = V1
		const { service } = await open()
		const id = await commitUrl(service, [...OVERRIDES_UNSORTED])
		expect(provenanceOf(service, id).groupOverrides).toEqual(OVERRIDES_SORTED)
	})

	it("an upload commit with overrides stores them too", async () => {
		const { service } = await open()
		const preview = service.previewImport({
			format: "sdrpp-json",
			fileName: "plan.json",
			contentBase64: B64,
			groupOverrides: [...OVERRIDES_UNSORTED],
		})
		const result = await service.mutate(
			commitBody(service, preview, {
				groupOverrides: [...OVERRIDES_UNSORTED],
			}),
		)
		expect(
			provenanceOf(service, result.createdId ?? "").groupOverrides,
		).toEqual(OVERRIDES_SORTED)
	})

	it("no overrides: the key is absent", async () => {
		bytes = V1
		const { service } = await open()
		const id = await commitUrl(service, [])
		expect("groupOverrides" in provenanceOf(service, id)).toBe(false)
	})

	it("the update check applies the stored overrides", async () => {
		bytes = V1
		const { service } = await open()
		const id = await commitUrl(service, [...OVERRIDES_UNSORTED])
		bytes = V2
		const check = await service.checkImportUpdate?.(id)
		const sha = check?.fetchedSha256 ?? ""
		expect(check?.preview?.previewDigest).toBe(
			previewDigestFor(sha, OVERRIDES_SORTED, URL_A),
		)
		expect(check?.preview?.previewDigest).not.toBe(
			previewDigestFor(sha, [], URL_A),
		)
	})

	it("pre-WG7 state (no key) checks with []", async () => {
		bytes = V1
		const { service } = await open()
		const id = await commitUrl(service, [])
		bytes = V2
		const check = await service.checkImportUpdate?.(id)
		expect(check?.preview?.previewDigest).toBe(
			previewDigestFor(check?.fetchedSha256 ?? "", [], URL_A),
		)
	})

	it("replacesPackId replaces the stored overrides with the commit's", async () => {
		bytes = V1
		const { service } = await open()
		const id = await commitUrl(service, [...OVERRIDES_UNSORTED])
		await commitUrl(service, [{ sourceType: "amateur", group: "other" }], id)
		expect(provenanceOf(service, id).groupOverrides).toEqual([
			{ sourceType: "amateur", group: "other" },
		])
		await commitUrl(service, [], id)
		expect("groupOverrides" in provenanceOf(service, id)).toBe(false)
	})
})
