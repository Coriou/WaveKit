// The built-in catalogue: the legacy scanner plans plus the band-plan supplement (pager-fr),
// with the legacy table untouched.
import { describe, expect, it } from "vitest"
import type { BandRegion } from "@wavekit/api-types"
import {
	BUILTIN_SUPPLEMENT,
	builtinBandplansFor,
	resolveBuiltinBandplan,
} from "../../../../src/core/bandplans/builtin-supplement.js"
import { projectBuiltinPacks } from "../../../../src/core/bandplans/builtin-packs.js"
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

describe("built-in catalogue (legacy plans plus the supplement)", () => {
	it("keeps every legacy plan object in order and adds each supplement plan to its regions only", () => {
		const added: Record<(typeof REGIONS)[number], string[]> = {
			EU: ["pager-fr"],
			US: ["land-mobile-700-900"],
			CA: ["land-mobile-700-900"],
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
			if (region === "US" || region === "CA")
				expect(ids.indexOf("land-mobile-700-900")).toBe(
					ids.indexOf("amateur-2m") - 1,
				)
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
			"land-mobile-700-900",
			"aprs",
			"aprs",
			"aprs",
			"aprs",
		])
	})

	it("land-mobile-700-900: the US/CA 700, 800 and 900 MHz land mobile allocations", () => {
		for (const region of ["US", "CA"] as const) {
			const plan = resolveBuiltinBandplan("land-mobile-700-900", region)
			expect(
				plan?.ranges.map(r => [r.startHz, r.endHz, r.rasters, r.protocols]),
			).toEqual([
				[
					769_000_000,
					775_000_000,
					[
						{ spacingHz: 6250, firstChannelHz: 769_003_125 },
						{ spacingHz: 12_500, firstChannelHz: 769_006_250 },
					],
					["dmr", "p25p1", "p25p2", "nxdn48", "nxdn96"],
				],
				[
					799_000_000,
					805_000_000,
					[
						{ spacingHz: 6250, firstChannelHz: 799_003_125 },
						{ spacingHz: 12_500, firstChannelHz: 799_006_250 },
					],
					["dmr", "p25p1", "p25p2", "nxdn48", "nxdn96"],
				],
				...(
					[
						[806, 806_012_500],
						[851, 851_012_500],
						[896, 896_012_500],
						[935, 935_012_500],
					] as const
				).map(([mhz, first]) => [
					mhz * 1e6,
					mhz === 806 ? 824e6 : mhz === 851 ? 869e6 : (mhz + 5) * 1e6,
					[
						{ spacingHz: 12_500, firstChannelHz: first },
						{ spacingHz: 6250, firstChannelHz: first - 3125 },
					],
					["dmr", "p25p1", "p25p2", "nxdn48", "nxdn96", "analog-fm"],
				]),
			])
			// Raster channels are whole Hz (no float residue from the MHz literals).
			for (const r of plan?.ranges ?? [])
				for (const x of r.rasters ?? [])
					expect(Number.isInteger(x.firstChannelHz)).toBe(true)
		}
		for (const region of ["EU", "AU", "NZ", "JP", "CN"] as const)
			expect(
				resolveBuiltinBandplan("land-mobile-700-900", region),
			).toBeUndefined()
	})

	it("aprs: each region's national 2 m APRS channel, ±8 kHz", () => {
		const aprs: Record<(typeof REGIONS)[number], number> = {
			EU: 144_800_000,
			US: 144_390_000,
			CA: 144_390_000,
			AU: 145_175_000,
			NZ: 144_575_000,
			JP: 144_640_000,
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
