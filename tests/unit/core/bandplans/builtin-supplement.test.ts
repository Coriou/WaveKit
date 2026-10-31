// The built-in catalogue: the legacy scanner plans plus the band-plan supplement (pager-fr),
// with the legacy table untouched.
import { describe, expect, it } from "vitest"
import type { Band, BandRegion } from "@wavekit/api-types"
import {
	BUILTIN_SUPPLEMENT,
	builtinBandplansFor,
	resolveBuiltinBandplan,
} from "../../../../src/core/bandplans/builtin-supplement.js"
import { projectBuiltinPacks } from "../../../../src/core/bandplans/builtin-packs.js"
import { resolveBandPlans } from "../../../../src/core/bandplans/resolve.js"
import { createScannerBandplanProvider } from "../../../../src/core/bandplans/scanner-feed.js"
import {
	bandplansFor,
	resolveBandplan,
} from "../../../../src/core/scanner/bandplan/index.js"
import { pagingRasterRanges } from "../../../../src/decoders/enablement/paging-plan.js"

const REGIONS = [
	"EU",
	"US",
	"CA",
	"AU",
	"NZ",
	"JP",
	"CN",
] as const satisfies readonly BandRegion[]

/** The US/CA 700/800/900 MHz land mobile plans, one per allocation, in frequency order. */
const LMR_IDS = [
	"land-mobile-700-base",
	"land-mobile-700-mobile",
	"land-mobile-800-mobile",
	"land-mobile-800-base",
	"land-mobile-900-mobile",
	"land-mobile-900-base",
]

function lowerBand(id: string, startHz: number, endHz: number): Band {
	return {
		id,
		name: id,
		startHz,
		endHz,
		group: "other",
		mode: null,
		bandwidthHz: null,
		stepHz: null,
		skip: null,
		channels: [],
		parentId: null,
		colourHint: null,
		registryRef: null,
		scan: null,
		provenance: { kind: "imported" },
	}
}

describe("built-in catalogue (legacy plans plus the supplement)", () => {
	it("keeps every legacy plan object in order and adds each supplement plan to its regions only", () => {
		const added: Record<(typeof REGIONS)[number], string[]> = {
			EU: ["pager-fr"],
			US: [...LMR_IDS],
			CA: [...LMR_IDS],
			AU: ["aprs"],
			NZ: ["aprs"],
			JP: ["aprs"],
			CN: ["aprs"],
		}
		const supplement = new Set(BUILTIN_SUPPLEMENT.map(s => s.plan))
		for (const region of REGIONS) {
			const legacy = bandplansFor(region)
			const catalogue = builtinBandplansFor(region)
			const kept = catalogue.filter(p => !supplement.has(p))
			expect(kept).toHaveLength(legacy.length)
			kept.forEach((plan, i) => expect(plan).toBe(legacy[i]))
			const extra = catalogue.filter(p => supplement.has(p)).map(p => p.id)
			expect(extra).toEqual(added[region])
			// No plan id appears twice in a region.
			const ids = catalogue.map(p => p.id)
			expect(new Set(ids).size).toBe(ids.length)
			if (region === "EU")
				expect(ids.indexOf("pager-fr")).toBe(ids.indexOf("pmr446") - 1)
			if (region === "US" || region === "CA") {
				const at = ids.indexOf("amateur-2m") - LMR_IDS.length
				expect(ids.slice(at, at + LMR_IDS.length)).toEqual(LMR_IDS)
			}
			if (added[region].includes("aprs"))
				expect(ids.indexOf("aprs")).toBe(ids.indexOf("pager-vhf") - 1)
		}
		// the legacy table itself does not know the band
		expect(resolveBandplan("pager-fr", "EU")).toBeUndefined()
		expect(resolveBuiltinBandplan("pager-fr", "EU")?.id).toBe("pager-fr")
		expect(resolveBuiltinBandplan("pager-fr", "US")).toBeUndefined()
	})

	it("pager-fr: 466.025-466.230 MHz and 446.5325 MHz, POCSAG on a 12.5 kHz raster", () => {
		const plan = resolveBuiltinBandplan("pager-fr", "EU")
		expect(plan?.region).toBe("EU")
		expect(plan?.ranges).toEqual([
			{
				startHz: 466_025_000,
				endHz: 466_230_000,
				rasters: [{ spacingHz: 12_500, firstChannelHz: 466_025_000 }],
				obwHz: [12_000],
				protocols: ["pocsag"],
				bandplanId: "pager-fr",
			},
			{
				startHz: 446_526_250,
				endHz: 446_538_750,
				rasters: [{ spacingHz: 12_500, firstChannelHz: 446_532_500 }],
				obwHz: [12_000],
				protocols: ["pocsag"],
				bandplanId: "pager-fr",
			},
		])
		expect(BUILTIN_SUPPLEMENT.map(s => s.plan.id)).toEqual([
			"pager-fr",
			...LMR_IDS,
			"aprs",
			"aprs",
			"aprs",
			"aprs",
		])
	})

	it("land mobile 700/800/900: one plan per US/CA allocation", () => {
		const digital = ["dmr", "p25p1", "p25p2", "nxdn48", "nxdn96"]
		const r6k25 = (first: number) => [
			{ spacingHz: 6250, firstChannelHz: first },
			{ spacingHz: 12_500, firstChannelHz: first + 3125 },
		]
		const r12k5 = (first: number) => [
			{ spacingHz: 12_500, firstChannelHz: first },
			{ spacingHz: 6250, firstChannelHz: first - 3125 },
		]
		const expected = [
			[769e6, 775e6, r6k25(769_003_125), digital],
			[799e6, 805e6, r6k25(799_003_125), digital],
			[806e6, 824e6, r12k5(806_012_500), [...digital, "analog-fm"]],
			[851e6, 869e6, r12k5(851_012_500), [...digital, "analog-fm"]],
			[896e6, 901e6, r12k5(896_012_500), [...digital, "analog-fm"]],
			[935e6, 940e6, r12k5(935_012_500), [...digital, "analog-fm"]],
		]
		for (const region of ["US", "CA"] as const) {
			LMR_IDS.forEach((id, i) => {
				const plan = resolveBuiltinBandplan(id, region)
				// One contiguous range per plan, tagged with its own plan id.
				expect(plan?.ranges).toHaveLength(1)
				expect(plan?.ranges[0]?.bandplanId).toBe(id)
				expect(
					plan?.ranges.map(r => [r.startHz, r.endHz, r.rasters, r.protocols]),
				).toEqual([expected[i]])
				// Raster channels are whole Hz (no float residue from the MHz literals).
				for (const r of plan?.ranges ?? [])
					for (const x of r.rasters ?? [])
						expect(Number.isInteger(x.firstChannelHz)).toBe(true)
			})
		}
		for (const region of ["EU", "AU", "NZ", "JP", "CN"] as const)
			for (const id of LMR_IDS)
				expect(resolveBuiltinBandplan(id, region)).toBeUndefined()
	})

	it("land mobile 700/800/900: the band view leaves the gaps between allocations free", () => {
		const us = projectBuiltinPacks().find(p => p.id === "builtin-us")
		const lmr = (us?.bands ?? []).filter(b => b.id.startsWith("land-mobile-"))
		expect(lmr.map(b => [b.id, b.startHz, b.endHz])).toEqual([
			["land-mobile-700-base", 769e6, 775e6],
			["land-mobile-700-mobile", 799e6, 805e6],
			["land-mobile-800-mobile", 806e6, 824e6],
			["land-mobile-800-base", 851e6, 869e6],
			["land-mobile-900-mobile", 896e6, 901e6],
			["land-mobile-900-base", 935e6, 940e6],
		])
		// A lower-priority pack: 902-928 MHz ISM and two bands inside the
		// 775-799 and 824-851 MHz gaps.
		const lower = {
			id: "imported-000000000001",
			kind: "imported" as const,
			name: "lower",
			region: null,
			provenance: { kind: "builtin" as const },
			bands: [
				lowerBand("ism-915", 902e6, 928e6),
				lowerBand("gap-700", 776e6, 798e6),
				lowerBand("gap-800", 824e6, 851e6),
			],
		}
		const resolved = resolveBandPlans({
			packs: new Map([
				["builtin-us", us!],
				[lower.id, lower],
			]),
			stack: [
				{ packId: "builtin-us", enabled: true },
				{ packId: lower.id, enabled: true },
			],
			operatorBands: [],
			edits: [],
		})
		const at = (hz: number) =>
			resolved.bands
				.filter(b => b.segments.some(s => s.startHz <= hz && hz <= s.endHz))
				.map(b => b.bandId)
		// 915 MHz and the gap frequencies resolve to the lower pack's bands.
		expect(at(915e6)).toEqual(["ism-915"])
		expect(at(787e6)).toEqual(["gap-700"])
		expect(at(840e6)).toEqual(["gap-800"])
		expect(resolved.shadowed).not.toContain(`${lower.id}/ism-915`)
		// Allocation edges are in; one Hz past them is out.
		for (const [id, lo, hi] of [
			["land-mobile-700-base", 769e6, 775e6],
			["land-mobile-700-mobile", 799e6, 805e6],
			["land-mobile-800-mobile", 806e6, 824e6],
			["land-mobile-800-base", 851e6, 869e6],
			["land-mobile-900-mobile", 896e6, 901e6],
			["land-mobile-900-base", 935e6, 940e6],
		] as const) {
			expect(at(lo)).toContain(id)
			expect(at(hi)).toContain(id)
			expect(at(lo - 1)).not.toContain(id)
			expect(at(hi + 1)).not.toContain(id)
		}
		// The shared 824 / 851 MHz edges go to the higher-priority built-in band.
		expect(at(824e6)).toEqual(["land-mobile-800-mobile"])
		expect(at(824e6 + 1)).toEqual(["gap-800"])
		expect(at(851e6 - 1)).toEqual(["gap-800"])
		expect(at(851e6)).toEqual(["land-mobile-800-base"])
		expect(at(901e6 + 1)).toEqual([])
		expect(at(902e6)).toEqual(["ism-915"])
	})

	it("aprs: each region's national 2 m APRS channel, ±8 kHz", () => {
		const aprs: Record<(typeof REGIONS)[number], number> = {
			EU: 144_800_000,
			US: 144_390_000,
			CA: 144_390_000,
			AU: 145_175_000,
			NZ: 144_575_000,
			JP: 144_660_000,
			CN: 144_640_000,
		}
		for (const region of REGIONS) {
			const plan = resolveBuiltinBandplan("aprs", region)
			expect(plan?.ranges).toEqual([
				{
					startHz: aprs[region] - 8000,
					endHz: aprs[region] + 8000,
					rasters: [{ spacingHz: 25_000, firstChannelHz: aprs[region] }],
					obwHz: [16_000],
					protocols: ["aprs"],
					bandplanId: "aprs",
				},
			])
		}
	})

	it("the band view and the scanner both see it", () => {
		const eu = projectBuiltinPacks().find(p => p.id === "builtin-eu")
		const band = eu?.bands.find(b => b.id === "pager-fr")
		expect(band).toMatchObject({
			group: "pagers",
			startHz: 446_526_250,
			endHz: 466_230_000,
		})
		expect(band?.scan?.ranges).toEqual(
			resolveBuiltinBandplan("pager-fr", "EU")?.ranges,
		)
		// the scanner's provider before the band-plan service opens, and on a failing read
		expect(
			createScannerBandplanProvider(() => undefined, "EU")().some(
				p => p.id === "pager-fr",
			),
		).toBe(true)
		expect(
			createScannerBandplanProvider(() => {
				throw new Error("view")
			}, "EU")().some(p => p.id === "pager-fr"),
		).toBe(true)
	})

	it("the pager decoder's paging band includes the 446.5325 MHz channel", () => {
		expect(pagingRasterRanges("EU")).toContainEqual({
			minHz: 446_526_250,
			maxHz: 446_538_750,
			spacingHz: 12_500,
			firstChannelHz: 446_532_500,
		})
		expect(
			pagingRasterRanges("US").some(r => r.firstChannelHz === 446_532_500),
		).toBe(false)
	})
})
