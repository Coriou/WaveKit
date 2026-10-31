// The built-in catalogue: the legacy scanner plans plus the band-plan supplement (pager-fr, adsb),
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
	it("keeps every legacy plan object in order, adds pager-fr in the EU only, before pmr446, and adsb last everywhere", () => {
		for (const region of REGIONS) {
			const legacy = bandplansFor(region)
			const catalogue = builtinBandplansFor(region)
			const kept = catalogue.filter(p => p.id !== "pager-fr" && p.id !== "adsb")
			expect(kept).toHaveLength(legacy.length)
			kept.forEach((plan, i) => expect(plan).toBe(legacy[i]))
			const ids = catalogue.map(p => p.id)
			expect(ids.filter(id => id === "adsb")).toHaveLength(1)
			expect(ids.at(-1)).toBe("adsb")
			if (region === "EU") {
				expect(ids.filter(id => id === "pager-fr")).toHaveLength(1)
				expect(ids.indexOf("pager-fr")).toBe(ids.indexOf("pmr446") - 1)
			} else expect(catalogue.slice(0, -1)).toEqual(legacy)
		}
		expect(resolveBandplan("adsb", "EU")).toBeUndefined()
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
		expect(BUILTIN_SUPPLEMENT.map(s => s.plan.id)).toEqual(["pager-fr", "adsb"])
	})

	it("adsb: 1089-1091 MHz in every region, with no scan protocol, OBW or raster", () => {
		for (const region of REGIONS) {
			const plan = resolveBuiltinBandplan("adsb", region)
			expect(plan?.region).toBe("all")
			expect(plan?.ranges).toEqual([
				{
					startHz: 1_089_000_000,
					endHz: 1_091_000_000,
					obwHz: [],
					protocols: [],
					bandplanId: "adsb",
				},
			])
		}
		// no paging raster, so the pager decoders never reach it
		expect(
			REGIONS.some(region =>
				pagingRasterRanges(region).some(r => r.maxHz >= 1_089_000_000),
			),
		).toBe(false)
	})

	it("the band view projects adsb as an air band, raw and skipped (decoded elsewhere by readsb)", () => {
		for (const pack of projectBuiltinPacks()) {
			const band = pack.bands.find(b => b.id === "adsb")
			expect(band).toMatchObject({
				group: "air",
				mode: "raw",
				skip: { reason: "Decoded elsewhere · readsb" },
				startHz: 1_089_000_000,
				endHz: 1_091_000_000,
				bandwidthHz: null,
				stepHz: null,
			})
			// every other built-in band stays as before: no mode, no skip
			for (const other of pack.bands.filter(b => b.id !== "adsb")) {
				expect(other.mode).toBeNull()
				expect(other.skip).toBeNull()
			}
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
