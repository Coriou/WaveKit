import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	placeDc,
	planHops,
} from "../../../../../src/core/scanner/plan/hop-planner.js"
import type {
	HopPlanInput,
	PlanItem,
} from "../../../../../src/core/scanner/plan/hop-planner.js"
import type {
	FreqRange,
	Raster,
} from "../../../../../src/core/spectrum/types.js"
import type { ScanRange } from "../../../../../src/core/scanner/types.js"

const TUNER = { startHz: 24_000_000, endHz: 1_766_000_000 }
const OBW = [4500, 9000, 11_000, 16_000]

const rangeArb = fc
	.record({
		startKhz: fc.integer({ min: 100_000, max: 900_000 }),
		widthKhz: fc.integer({ min: 10, max: 8000 }),
		raster: fc.constantFrom("none", "12k5", "6k25+12k5", "25k"),
		phase: fc.integer({ min: 0, max: 49 }),
		obw: fc.subarray(OBW),
	})
	.map(({ startKhz, widthKhz, raster, phase, obw }): ScanRange => {
		const startHz = startKhz * 1000
		const r = (spacingHz: number): Raster => ({
			spacingHz,
			firstChannelHz: startHz + ((phase * 500) % spacingHz),
		})
		const rasters =
			raster === "12k5"
				? [r(12_500)]
				: raster === "6k25+12k5"
					? [r(12_500), r(6250)]
					: raster === "25k"
						? [r(25_000)]
						: []
		return { startHz, endHz: startHz + widthKhz * 1000, rasters, obwHz: obw }
	})
const radioArb = fc.record({
	fs: fc.constantFrom(1_024_000, 2_048_000, 2_400_000),
	u: fc.constantFrom(0.7, 0.8, 0.9),
	ppm: fc.constantFrom(0, 2, 5),
})
function exclusionsFor(
	ranges: ScanRange[],
	picks: { at: number; widthKhz: number }[],
): FreqRange[] {
	return picks.map((p, i) => {
		const r = ranges[i % ranges.length]!
		const startHz = Math.round(r.startHz + p.at * (r.endHz - r.startHz))
		return { startHz, endHz: startHz + p.widthKhz * 1000 }
	})
}
const exclusionArb = fc.array(
	fc.record({
		at: fc.double({ min: 0, max: 1, noNaN: true }),
		widthKhz: fc.integer({ min: 1, max: 300 }),
	}),
	{ maxLength: 3 },
)

function rbwFor(fs: number): number {
	return fs / 2 ** Math.round(Math.log2(fs / 1000))
}
function hopInput(
	ranges: ScanRange[],
	exclusions: FreqRange[],
	radio: { fs: number; u: number; ppm: number },
): HopPlanInput {
	return {
		ranges,
		exclusions,
		sampleRateHz: radio.fs,
		usableFraction: radio.u,
		rbwHz: rbwFor(radio.fs),
		dcGuardHz: 1500,
		ppmMargin: radio.ppm,
		tunerRange: TUNER,
	}
}
const excluded = (hz: number, ex: FreqRange[]) =>
	ex.some(x => hz >= x.startHz && hz <= x.endHz)

/** Oracle: the spec's channel set with planning width and expected edge half-width. */
function channels(
	ranges: ScanRange[],
	ex: FreqRange[],
): Map<number, { w: number; e: number }> {
	const out = new Map<number, { w: number; e: number }>()
	for (const r of ranges) {
		for (const ra of r.rasters ?? []) {
			const classes = r.obwHz ?? []
			const fit = classes.filter(o => o <= ra.spacingHz)
			const obw =
				fit.length > 0
					? Math.max(...fit)
					: classes.length > 0
						? Math.min(...classes)
						: 0.72 * ra.spacingHz
			for (
				let k = Math.ceil(
					(r.startHz - ra.firstChannelHz) / ra.spacingHz - 1e-9,
				);
				ra.firstChannelHz + k * ra.spacingHz <= r.endHz;
				k++
			) {
				const hz = Math.round(ra.firstChannelHz + k * ra.spacingHz)
				if (excluded(hz, ex)) continue
				const prev = out.get(hz)
				out.set(hz, {
					w: Math.max(ra.spacingHz, prev?.w ?? 0),
					e: Math.max(obw / 2, prev?.e ?? 0),
				})
			}
		}
	}
	return out
}
const freeWidth = (r: ScanRange) => Math.max(0, ...(r.obwHz ?? [])) || 25_000

describe("hop planner properties", () => {
	it("covers every non-excluded channel and free point with hops inside the tuner range", () => {
		// Feature: signal-discovery-scanner, Property 1: Hop coverage
		// Validates: spec § 5.3
		fc.assert(
			fc.property(
				fc.array(rangeArb, { minLength: 1, maxLength: 3 }),
				exclusionArb,
				radioArb,
				(ranges, picks, radio) => {
					const ex = exclusionsFor(ranges, picks)
					const plan = planHops(hopInput(ranges, ex, radio))
					const H = plan.usableHalfSpanHz
					const covers = (x: number, w: number) =>
						plan.hops.some(h => Math.abs(x - h.centreHz) + w / 2 <= H + 1e-6)
					for (const [hz, { w }] of channels(ranges, ex))
						expect(covers(hz, w), `channel ${hz}`).toBe(true)
					for (const r of ranges) {
						if ((r.rasters ?? []).length > 0) continue
						const w = freeWidth(r)
						for (
							let p = Math.ceil(r.startHz / 1000) * 1000;
							p <= r.endHz;
							p += 1000
						) {
							if (!excluded(p, ex))
								expect(covers(p, w), `point ${p}`).toBe(true)
						}
					}
					for (const h of plan.hops) {
						expect(h.centreHz).toBeGreaterThanOrEqual(TUNER.startHz)
						expect(h.centreHz).toBeLessThanOrEqual(TUNER.endHz)
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000) // ≈ 10 s: a 1 kHz free-point walk over up to three ranges, 100 times

	it("overlaps consecutive hops by at least w_max over a contiguous range", () => {
		// Feature: signal-discovery-scanner, Property 1: Hop coverage
		// Validates: spec § 5.3
		fc.assert(
			fc.property(rangeArb, radioArb, (range, radio) => {
				const plan = planHops(hopInput([range], [], radio))
				const ch = channels([range], [])
				const wMax =
					(range.rasters ?? []).length > 0
						? Math.max(...[...ch.values()].map(c => c.w))
						: freeWidth(range)
				for (let i = 1; i < plan.hops.length; i++) {
					const gap = plan.hops[i]!.centreHz - plan.hops[i - 1]!.centreHz
					expect(2 * plan.usableHalfSpanHz - gap).toBeGreaterThanOrEqual(
						wMax - 1e-6,
					)
				}
			}),
			{ numRuns: 100 },
		)
	})

	it("reports exactly the covered channels whose edge is within g + m, and the true minimum edge", () => {
		// Feature: signal-discovery-scanner, Property 2: DC safety
		// Validates: spec § 5.3
		fc.assert(
			fc.property(
				fc.array(rangeArb, { minLength: 1, maxLength: 3 }),
				exclusionArb,
				radioArb,
				(ranges, picks, radio) => {
					const ex = exclusionsFor(ranges, picks)
					const inp = hopInput(ranges, ex, radio)
					const plan = planHops(inp)
					const g = Math.max(1500, 2 * inp.rbwHz)
					const ch = channels(ranges, ex)
					for (const hop of plan.hops) {
						const m = radio.ppm * 1e-6 * hop.centreHz
						let min = plan.usableHalfSpanHz
						const adjacent: number[] = []
						for (const [hz, { w, e }] of ch) {
							const d = Math.abs(hz - hop.centreHz)
							if (d + w / 2 > plan.usableHalfSpanHz + 1e-6) continue
							min = Math.min(min, d - e)
							if (d - e < g + m) adjacent.push(hz)
						}
						expect(hop.dcMinEdgeHz).toBeCloseTo(min, 6)
						expect(hop.dcAdjacentChannelsHz).toEqual(
							adjacent.sort((a, b) => a - b),
						)
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	it("places DC at the 100 Hz grid point that maximises the minimum edge distance", () => {
		// Feature: signal-discovery-scanner, Property 2: DC safety
		// Validates: spec § 5.3
		const main: Raster = { spacingHz: 12_500, firstChannelHz: 446_006_250 }
		const itemArb = fc.record({
			offset: fc.integer({ min: -60_000, max: 60_000 }),
			edge: fc.integer({ min: 1000, max: 8000 }),
		})
		fc.assert(
			fc.property(
				fc.integer({ min: 445_000_000, max: 447_000_000 }),
				fc.constantFrom(6250, 12_500, 25_000),
				fc.array(itemArb, { minLength: 1, maxLength: 20 }),
				(greedy, slack, raw) => {
					const items: PlanItem[] = raw.map(r => ({
						hz: greedy + r.offset,
						widthHz: 12_500,
						edgeHalfHz: r.edge,
					}))
					const objective = (h: number) =>
						Math.min(...items.map(i => Math.abs(i.hz - h) - i.edgeHalfHz))
					const isHalf = (h: number) =>
						(((h - main.firstChannelHz) % 12_500) + 12_500) % 12_500 === 6250
					const grid: number[] = []
					for (
						let h = Math.ceil((greedy - slack) / 100) * 100;
						h <= greedy + slack;
						h += 100
					)
						grid.push(h)
					const best = Math.max(...grid.map(objective))
					const winners = grid.filter(
						h => Math.abs(objective(h) - best) <= 1e-6,
					)
					const r = placeDc(greedy, slack, items, main, TUNER)
					expect(r.centreHz % 100).toBe(0)
					expect(Math.abs(r.centreHz - greedy)).toBeLessThanOrEqual(slack)
					expect(r.minEdgeHz).toBeCloseTo(best, 6)
					expect(objective(r.centreHz)).toBeCloseTo(best, 6)
					const halfWinners = winners.filter(isHalf)
					const pool = halfWinners.length > 0 ? halfWinners : winners
					expect(pool).toContain(r.centreHz)
					expect(Math.abs(r.centreHz - greedy)).toBe(
						Math.min(...pool.map(h => Math.abs(h - greedy))),
					)
				},
			),
			{ numRuns: 100 },
		)
	})
})
