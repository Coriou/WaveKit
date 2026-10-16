import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	bandplansFor,
	frequencyKey,
	gridToleranceHz,
	priorsFor,
	rasterToleranceHz,
	rasterUnion,
	resolveBandplan,
	snapToRaster,
} from "../../../../../src/core/scanner/bandplan/index.js"
import type { Bandplan } from "../../../../../src/core/scanner/bandplan/index.js"

import { rasterItems } from "../../../../../src/core/scanner/plan/hop-planner.js"

const MHz = (x: number) => Math.round(x * 1e6)
function plan(id: string, region: "EU" | "US" = "EU"): Bandplan {
	const p = resolveBandplan(id, region)
	if (!p) throw new Error(`missing ${id}`)
	return p
}

describe("built-in bandplans (spec § 5.1)", () => {
	it("PMR446: 446.0–446.2 MHz, 12.5/6.25 kHz rasters, 16 analogue channels", () => {
		const r = plan("pmr446").ranges
		expect(r).toEqual([
			{
				startHz: MHz(446.0),
				endHz: MHz(446.2),
				rasters: [
					{ spacingHz: 12_500, firstChannelHz: MHz(446.00625) },
					{ spacingHz: 6250, firstChannelHz: MHz(446.003125) },
				],
				obwHz: [9000, 11_000],
				protocols: ["analog-fm", "dmr", "dpmr"],
				bandplanId: "pmr446",
			},
		])
	})
	it("PMR446 rasters cover 16 analogue and 32 digital carrier frequencies", () => {
		const r = plan("pmr446").ranges[0]!
		const counts = r.rasters!.map(
			raster =>
				Math.floor((r.endHz - raster.firstChannelHz) / raster.spacingHz) + 1,
		)
		expect(counts).toEqual([16, 32])
		expect(plan("vhf-land-mobile").name).toBe("VHF land mobile")
		expect(bandplansFor("EU").some(p => /tetra/i.test(p.id))).toBe(false)
	})

	it("dPMR446 and the land-mobile plans carry their rasters, sub-rasters and OBW classes", () => {
		expect(plan("dpmr446").ranges[0]).toMatchObject({
			startHz: MHz(446.0),
			endHz: MHz(446.2),
			rasters: [{ spacingHz: 6250, firstChannelHz: MHz(446.003125) }],
			obwHz: [4500],
		})
		const uhf = plan("uhf-land-mobile").ranges[0]!
		expect([uhf.startHz, uhf.endHz]).toEqual([MHz(400), MHz(470)])
		expect(uhf.rasters).toEqual([
			{ spacingHz: 12_500, firstChannelHz: MHz(400.00625) },
			{ spacingHz: 6250, firstChannelHz: MHz(400.003125) },
		])
		expect(uhf.obwHz).toEqual([9000, 11_000, 4500])
		expect(uhf.protocols).toEqual([
			"dmr",
			"analog-fm",
			"p25p1",
			"nxdn48",
			"nxdn96",
		])
		const vhf = plan("vhf-land-mobile").ranges[0]!
		expect([vhf.startHz, vhf.endHz]).toEqual([MHz(136), MHz(174)])
		expect(vhf.rasters?.[1]).toEqual({
			spacingHz: 6250,
			firstChannelHz: MHz(136.003125),
		})
		expect(vhf.protocols).toContain("pocsag")
	})
	it("amateur and APRS plans differ by region", () => {
		expect(plan("amateur-2m", "EU").ranges[0]).toMatchObject({
			startHz: MHz(144),
			endHz: MHz(146),
			rasters: [{ spacingHz: 12_500 }],
		})
		expect(
			plan("amateur-2m", "US").ranges[0]!.rasters?.map(r => r.spacingHz),
		).toEqual([15_000, 20_000])
		expect(plan("amateur-2m", "US").ranges[0]!.endHz).toBe(MHz(148))
		expect([
			plan("amateur-70cm", "EU").ranges[0]!.startHz,
			plan("amateur-70cm", "EU").ranges[0]!.endHz,
		]).toEqual([MHz(430), MHz(440)])
		expect([
			plan("amateur-70cm", "US").ranges[0]!.startHz,
			plan("amateur-70cm", "US").ranges[0]!.endHz,
		]).toEqual([MHz(420), MHz(450)])
		const eu = plan("aprs", "EU").ranges[0]!
		expect(eu.startHz).toBeLessThan(MHz(144.8))
		expect(eu.endHz).toBeGreaterThan(MHz(144.8))
		expect(eu.rasters).toEqual([
			{ spacingHz: 25_000, firstChannelHz: MHz(144.8) },
		])
		expect(plan("aprs", "US").ranges[0]!.rasters?.[0]?.firstChannelHz).toBe(
			MHz(144.39),
		)
	})
	it("ISM plans are free ranges; pager and marine plans have their rasters", () => {
		expect(plan("ism-433").ranges[0]).toMatchObject({
			startHz: MHz(433.05),
			endHz: MHz(434.79),
			obwHz: [],
			protocols: ["ism"],
		})
		expect(plan("ism-433").ranges[0]!.rasters ?? []).toEqual([])
		expect(plan("ism-868").ranges[0]).toMatchObject({
			startHz: MHz(863),
			endHz: MHz(870),
		})
		expect(plan("pager-vhf", "US").ranges[0]).toMatchObject({
			startHz: MHz(137),
			endHz: MHz(174),
			obwHz: [12_000],
			protocols: ["pocsag", "flex"],
		})
	})
	it("airband uses actual carrier frequencies with exact thirds of 25 kHz", () => {
		const r = plan("airband").ranges[0]!
		expect([r.startHz, r.endHz]).toEqual([MHz(118), MHz(137)])
		expect(r.protocols).toEqual(["analog-am"])
		expect(r.rasters).toEqual([
			{ spacingHz: 25_000, firstChannelHz: MHz(118) },
			{ spacingHz: 25_000 / 3, firstChannelHz: MHz(118) },
		])
		const channels = rasterItems([r], [])
		expect(channels).toHaveLength(2281)
		expect(channels.every(channel => Number.isInteger(channel.hz))).toBe(true)
		for (let k = 0; k <= 2280; k++) {
			const expected = Math.round(MHz(118) + k * (25_000 / 3))
			const snapped = snapToRaster(expected, r.rasters!, 0)
			expect(snapped).toEqual({ hz: expected, snapped: true })
			expect(frequencyKey(snapped.hz, snapped.snapped, 6000)).toBe(
				`r:${expected}`,
			)
		}
	})
	it("CB represents exactly 40 CEPT carriers, excluding the five gaps", () => {
		const ranges = plan("cb").ranges
		const carriers = ranges.flatMap(r => {
			const raster = r.rasters![0]!
			const out: number[] = []
			for (
				let hz = raster.firstChannelHz;
				hz <= r.endHz;
				hz += raster.spacingHz
			)
				out.push(hz)
			return out
		})
		expect(carriers).toHaveLength(40)
		expect(carriers[0]).toBe(MHz(26.965))
		expect(carriers.at(-1)).toBe(MHz(27.405))
		for (const gap of [26.995, 27.045, 27.095, 27.145, 27.195])
			expect(carriers).not.toContain(MHz(gap))
		for (const r of ranges)
			expect(r.protocols).toEqual(["analog-am", "analog-fm"])
	})
	it("EU paging excludes only metering, preserving the non-EU fallback", () => {
		const ranges = plan("pager-vhf").ranges
		const inside = (hz: number) =>
			ranges.some(r => hz >= r.startHz && hz <= r.endHz)
		for (const mhz of [169.4, 169.475]) expect(inside(MHz(mhz))).toBe(false)
		expect(inside(MHz(169.4) - 1)).toBe(true)
		expect(inside(MHz(169.475) + 1)).toBe(true)
		expect(inside(MHz(169.65))).toBe(true)
		expect(bandplansFor("EU").filter(p => p.id === "pager-vhf")).toHaveLength(1)
		expect(plan("pager-vhf", "US").ranges[0]).toMatchObject({
			startHz: MHz(137),
			endHz: MHz(174),
		})
		expect(plan("ism-169").ranges[0]).toMatchObject({
			startHz: MHz(169.4),
			endHz: MHz(169.475),
			protocols: ["ism"],
		})
	})

	it("marine VHF never covers the AIS channels but keeps 162.000 MHz", () => {
		const ranges = plan("marine-vhf").ranges
		const inside = (hz: number) =>
			ranges.some(r => hz >= r.startHz && hz <= r.endHz)
		expect(inside(MHz(161.975))).toBe(false)
		expect(inside(MHz(162.025))).toBe(false)
		expect(inside(MHz(162.0))).toBe(true)
		expect(inside(MHz(156.8))).toBe(true)
	})
	it("offers EU-only plans in the EU, US variants in the US and Canada, and only global plans elsewhere", () => {
		const ids = (r: Parameters<typeof bandplansFor>[0]) =>
			bandplansFor(r)
				.map(p => p.id)
				.sort()
		expect(ids("EU")).toEqual([
			"airband",
			"amateur-2m",
			"amateur-70cm",
			"aprs",
			"cb",
			"dpmr446",
			"ism-169",
			"ism-433",
			"ism-868",
			"marine-vhf",
			"pager-vhf",
			"pmr446",
			"uhf-land-mobile",
			"vhf-land-mobile",
		])
		expect(ids("US")).toEqual([
			"amateur-2m",
			"amateur-70cm",
			"aprs",
			"marine-vhf",
			"pager-vhf",
			"uhf-land-mobile",
			"vhf-land-mobile",
		])
		expect(ids("CA")).toEqual(ids("US"))
		expect(ids("JP")).toEqual([
			"marine-vhf",
			"pager-vhf",
			"uhf-land-mobile",
			"vhf-land-mobile",
		])
		expect(resolveBandplan("pmr446", "US")).toBeUndefined()
		expect(resolveBandplan("nope", "EU")).toBeUndefined()
		for (const p of bandplansFor("EU"))
			for (const r of p.ranges) expect(r.bandplanId).toBe(p.id)
	})
})

describe("rasterUnion", () => {
	it("deduplicates rasters by spacing and phase and keeps the first as the main raster", () => {
		const union = rasterUnion([
			{
				startHz: 0,
				endHz: 1,
				rasters: [{ spacingHz: 12_500, firstChannelHz: MHz(446.00625) }],
			},
			{
				startHz: 0,
				endHz: 1,
				rasters: [
					{ spacingHz: 12_500, firstChannelHz: MHz(400.00625) },
					{ spacingHz: 6250, firstChannelHz: MHz(400.003125) },
				],
			},
			{ startHz: 0, endHz: 1 },
		])
		expect(union).toEqual([
			{ spacingHz: 12_500, firstChannelHz: MHz(446.00625) },
			{ spacingHz: 6250, firstChannelHz: MHz(400.003125) },
		])
	})
})

describe("snapToRaster and frequency keys (spec § 5.2)", () => {
	const main = { spacingHz: 12_500, firstChannelHz: MHz(446.00625) }
	const sub = { spacingHz: 6250, firstChannelHz: MHz(446.003125) }
	it("snaps within max(1 kHz, spacing/4) and keeps the measured centre beyond it", () => {
		expect(rasterToleranceHz(12_500)).toBe(3125)
		expect(rasterToleranceHz(2500)).toBe(1000)
		expect(snapToRaster(MHz(446.09375) + 3125, [main], 0)).toEqual({
			hz: MHz(446.09375),
			snapped: true,
		})
		expect(snapToRaster(MHz(446.09375) + 3126, [main], 0)).toEqual({
			hz: MHz(446.09375) + 3126,
			snapped: false,
		})
	})
	it("applies the frequency-error correction before snapping", () => {
		expect(snapToRaster(MHz(446.09375) + 4000, [main], 1500)).toEqual({
			hz: MHz(446.09375),
			snapped: true,
		})
		expect(snapToRaster(MHz(446.09375) + 4000, [main], -1500)).toEqual({
			hz: MHz(446.09375) + 5500,
			snapped: false,
		})
	})
	it("picks the nearest channel of the raster union", () => {
		expect(snapToRaster(MHz(446.0975), [main, sub], 0)).toEqual({
			hz: MHz(446.096875),
			snapped: true,
		})
		expect(snapToRaster(MHz(446.0942), [main, sub], 0)).toEqual({
			hz: MHz(446.09375),
			snapped: true,
		})
	})
	it("keys raster channels by channel and free emissions by a fixed grid", () => {
		expect(frequencyKey(MHz(446.09375), true, 9000)).toBe("r:446093750")
		expect(gridToleranceHz(9000)).toBe(2500)
		expect(gridToleranceHz(4000)).toBe(2000)
		expect(gridToleranceHz(16_000)).toBe(4000)
		expect(frequencyKey(433_920_400, false, 9000)).toBe("g:433920000")
	})
	it("grid keys are a pure function of the centre, within tol/2 of it", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 24_000_000, max: 1_766_000_000 }),
				fc.integer({ min: 0, max: 200_000 }),
				(hz, obw) => {
					const tol = gridToleranceHz(obw)
					expect(tol % 500).toBe(0)
					expect(tol).toBeGreaterThanOrEqual(2000)
					const key = frequencyKey(hz, false, obw)
					expect(key).toBe(frequencyKey(hz, false, obw))
					expect(Math.abs(Number(key.slice(2)) - hz)).toBeLessThanOrEqual(
						tol / 2,
					)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("priorsFor", () => {
	it("weights listed protocols at 1, others at 0.25, generic ones at 1, and is empty outside plans", () => {
		const ranges = plan("pmr446").ranges
		const p = priorsFor(ranges, MHz(446.1))
		expect(p.dmr).toBe(1)
		expect(p["analog-fm"]).toBe(1)
		expect(p.ism).toBe(0.25)
		expect(p.carrier).toBe(1)
		expect(priorsFor(ranges, MHz(447))).toEqual({})
		expect(priorsFor([{ startHz: 0, endHz: MHz(1000) }], MHz(446))).toEqual({})
	})
})
