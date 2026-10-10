import { describe, expect, it } from "vitest"
import {
	describeHop,
	planHops,
} from "../../../../../src/core/scanner/plan/hop-planner.js"
import type { HopPlanInput } from "../../../../../src/core/scanner/plan/hop-planner.js"

const MHz = (x: number) => Math.round(x * 1e6)
function input(over: Partial<HopPlanInput>): HopPlanInput {
	return {
		ranges: [],
		exclusions: [],
		sampleRateHz: 2_048_000,
		usableFraction: 0.8,
		rbwHz: 1000,
		dcGuardHz: 1500,
		ppmMargin: 2,
		tunerRange: { startHz: 24_000_000, endHz: 1_766_000_000 },
		...over,
	}
}
const pmr = (obwHz: number[]) => [
	{
		startHz: MHz(446.0),
		endHz: MHz(446.2),
		rasters: [{ spacingHz: 12_500, firstChannelHz: MHz(446.00625) }],
		obwHz,
	},
]

describe("planHops worked examples", () => {
	it("covers 400–470 MHz at 2.048 Msps with a 12.5 kHz raster in 44 hops", () => {
		const plan = planHops(
			input({
				ranges: [
					{
						startHz: MHz(400),
						endHz: MHz(470),
						rasters: [{ spacingHz: 12_500, firstChannelHz: MHz(400.00625) }],
						obwHz: [9000],
					},
				],
			}),
		)
		expect(plan.hops).toHaveLength(44)
		expect(plan.usableHalfSpanHz).toBe(819_200)
		expect(plan.dcGuardHz).toBe(2000)
		expect(plan.hops.map(h => h.index)).toEqual(
			Array.from({ length: 44 }, (_, i) => i),
		)
		for (let i = 1; i < 44; i++)
			expect(
				plan.hops[i]!.centreHz - plan.hops[i - 1]!.centreHz,
			).toBeLessThanOrEqual(2 * 819_200 - 12_500)
		expect(
			plan.hops.reduce((n, h) => n + h.channelCount, 0),
		).toBeGreaterThanOrEqual(5600)
		expect(plan.ppmMarginHz).toBeCloseTo(2e-6 * plan.hops[43]!.centreHz, 6)
	})

	it("plans PMR446 as one hop with DC between channels and reports the analog-class neighbours", () => {
		const plan = planHops(input({ ranges: pmr([9000, 11_000]) }))
		expect(plan.hops).toHaveLength(1)
		const hop = plan.hops[0]!
		expect(hop.centreHz).toBe(MHz(446.1))
		expect((hop.centreHz - MHz(446.00625)) % 12_500).toBe(6250)
		expect(hop.channelCount).toBe(16)
		expect(hop.dcMinEdgeHz).toBe(750)
		expect(hop.dcAdjacentChannelsHz).toEqual([MHz(446.09375), MHz(446.10625)])
	})

	it("gives 1.75 kHz for 9 kHz digital: clears g but not g + m at 446 MHz", () => {
		const withMargin = planHops(input({ ranges: pmr([9000]), rbwHz: 500 }))
			.hops[0]!
		expect(withMargin.dcMinEdgeHz).toBe(1750)
		expect(withMargin.dcAdjacentChannelsHz).toEqual([
			MHz(446.09375),
			MHz(446.10625),
		])
		const noMargin = planHops(
			input({ ranges: pmr([9000]), rbwHz: 500, ppmMargin: 0 }),
		).hops[0]!
		expect(noMargin.dcAdjacentChannelsHz).toEqual([])
	})

	it("uses the coarse-RBW guard at 2.4 Msps", () => {
		const plan = planHops(
			input({
				ranges: pmr([9000]),
				sampleRateHz: 2_400_000,
				rbwHz: 2_400_000 / 2048,
			}),
		)
		expect(plan.dcGuardHz).toBeCloseTo(2343.75, 6)
	})

	it("drops all-excluded windows and reports exclusions clipped to each hop", () => {
		const ranges = [
			{
				startHz: MHz(400),
				endHz: MHz(410),
				rasters: [{ spacingHz: 12_500, firstChannelHz: MHz(400.00625) }],
				obwHz: [9000],
			},
		]
		const full = planHops(input({ ranges }))
		const cut = planHops(
			input({
				ranges,
				exclusions: [{ startHz: MHz(401.5), endHz: MHz(408.5) }],
			}),
		)
		expect(cut.hops.length).toBeLessThan(full.hops.length)
		for (const h of cut.hops) expect(h.channelCount).toBeGreaterThan(0)
		const withEx = cut.hops.filter(h => h.excluded.length > 0)
		expect(withEx.length).toBeGreaterThan(0)
		for (const h of withEx) {
			for (const x of h.excluded) {
				expect(x.startHz).toBeGreaterThanOrEqual(h.covered.startHz)
				expect(x.endHz).toBeLessThanOrEqual(h.covered.endHz)
			}
		}
	})

	it("keeps every hop centre inside the tuner range", () => {
		const plan = planHops(
			input({
				ranges: [
					{
						startHz: MHz(400.0),
						endHz: MHz(400.1),
						rasters: [{ spacingHz: 12_500, firstChannelHz: MHz(400.00625) }],
						obwHz: [9000],
					},
				],
				tunerRange: { startHz: MHz(400.06), endHz: MHz(1766) },
			}),
		)
		expect(plan.hops).toHaveLength(1)
		expect(plan.hops[0]!.centreHz).toBeGreaterThanOrEqual(MHz(400.06))
	})

	it("returns no hops when a channel is wider than the usable span", () => {
		const plan = planHops(
			input({
				ranges: [
					{
						startHz: MHz(400),
						endHz: MHz(410),
						rasters: [{ spacingHz: 2_000_000, firstChannelHz: MHz(401) }],
					},
				],
			}),
		)
		expect(plan.hops).toEqual([])
	})

	it("covers a free ISM range with 25 kHz planning width", () => {
		const plan = planHops(
			input({
				ranges: [{ startHz: MHz(433.05), endHz: MHz(434.79), obwHz: [] }],
			}),
		)
		expect(plan.hops).toHaveLength(2)
		for (let p = MHz(433.05); p <= MHz(434.79); p += 1000) {
			expect(
				plan.hops.some(
					h =>
						Math.abs(p - h.centreHz) + 12_500 <= plan.usableHalfSpanHz + 1e-6,
				),
			).toBe(true)
		}
		expect(
			plan.hops.every(
				h => h.channelCount === 0 && h.dcMinEdgeHz === plan.usableHalfSpanHz,
			),
		).toBe(true)
	})

	it("describeHop reports a fixed in-window centre with the same rules", () => {
		const hop = describeHop(
			0,
			MHz(446.1),
			input({ ranges: pmr([9000, 11_000]) }),
		)
		expect(hop).toEqual(
			planHops(input({ ranges: pmr([9000, 11_000]) })).hops[0],
		)
	})
})
