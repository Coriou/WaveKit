import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { BUILTIN_BANDPLANS } from "../../../../src/core/scanner/bandplan/builtin.js"
import { narrowRasterAt } from "../../../../src/core/scanner/narrow-digital.js"
import type { ScanRange } from "../../../../src/core/scanner/types.js"

const r = (startHz: number, endHz: number, spacings: number[]): ScanRange => ({
	startHz,
	endHz,
	rasters: spacings.map(spacingHz => ({ spacingHz, firstChannelHz: startHz })),
})

const planRanges = (id: string): ScanRange[] =>
	BUILTIN_BANDPLANS.find(p => p.id === id)?.ranges ?? []

describe("narrowRasterAt (WG11 1.3)", () => {
	const lo = 446_000_000
	const hi = 446_200_000
	it("is true at a 6 250 Hz raster and false at 6 251 and 12 500 Hz", () => {
		expect(narrowRasterAt([r(lo, hi, [6250])], 446_100_000)).toBe(true)
		expect(narrowRasterAt([r(lo, hi, [6251])], 446_100_000)).toBe(false)
		expect(narrowRasterAt([r(lo, hi, [12_500])], 446_100_000)).toBe(false)
		expect(narrowRasterAt([r(lo, hi, [12_500, 6250])], 446_100_000)).toBe(true)
	})

	it("includes both range edges and nothing outside every range", () => {
		const ranges = [r(lo, hi, [6250])]
		expect(narrowRasterAt(ranges, lo)).toBe(true)
		expect(narrowRasterAt(ranges, hi)).toBe(true)
		expect(narrowRasterAt(ranges, lo - 1)).toBe(false)
		expect(narrowRasterAt(ranges, hi + 1)).toBe(false)
		expect(narrowRasterAt(ranges, 100_000_000)).toBe(false)
	})

	it("needs the narrow raster on a range that contains the frequency", () => {
		const ranges = [r(lo, hi, [12_500]), r(400_000_000, 401_000_000, [6250])]
		expect(narrowRasterAt(ranges, 446_100_000)).toBe(false)
		expect(narrowRasterAt(ranges, 400_500_000)).toBe(true)
	})

	it("is false on malformed input", () => {
		const ok = [r(lo, hi, [6250])]
		expect(narrowRasterAt([], 446_100_000)).toBe(false)
		expect(narrowRasterAt(ok, Number.NaN)).toBe(false)
		expect(narrowRasterAt(ok, Number.POSITIVE_INFINITY)).toBe(false)
		expect(narrowRasterAt([r(lo, hi, [Number.NaN])], 446_100_000)).toBe(false)
		expect(narrowRasterAt([r(lo, hi, [0])], 446_100_000)).toBe(false)
		expect(narrowRasterAt([r(lo, hi, [-6250])], 446_100_000)).toBe(false)
		expect(narrowRasterAt([r(lo, hi, [])], 446_100_000)).toBe(false)
		expect(narrowRasterAt([{ startHz: lo, endHz: hi }], 446_100_000)).toBe(
			false,
		)
		expect(narrowRasterAt([r(Number.NaN, hi, [6250])], 446_100_000)).toBe(false)
		expect(narrowRasterAt([r(lo, Number.NaN, [6250])], 446_100_000)).toBe(false)
	})

	it("holds for the built-in 446.0-446.2 MHz plans and a uhf-land-mobile 6.25 kHz grid frequency", () => {
		for (const id of ["pmr446", "dpmr446"]) {
			const ranges = planRanges(id)
			expect(ranges.length).toBeGreaterThan(0)
			expect(narrowRasterAt(ranges, 446_003_125)).toBe(true)
			expect(narrowRasterAt(ranges, 446_196_875)).toBe(true)
		}
		const uhf = planRanges("uhf-land-mobile")
		expect(uhf.length).toBeGreaterThan(0)
		// 6.25 kHz grid point outside PMR446: 400.003125 MHz + 7 200 × 6.25 kHz = 445.003125 MHz
		expect(narrowRasterAt(uhf, 445_003_125)).toBe(true)
		expect(narrowRasterAt(planRanges("pmr446"), 445_003_125)).toBe(false)
	})

	// Feature: web-gaps-11, Property 3: Narrow modes where the raster says so
	// Validates: Requirements 1.3
	it("property: true iff a containing range lists a raster in (0, 6 250] Hz", () => {
		const spacing = fc.oneof(
			fc.integer({ min: -100, max: 30_000 }),
			fc.constantFrom(6250, 6251, 12_500, Number.NaN, Number.POSITIVE_INFINITY),
		)
		const range = fc
			.tuple(
				fc.integer({ min: 0, max: 1_000_000 }),
				fc.integer({ min: 0, max: 200_000 }),
				fc.array(spacing, { maxLength: 3 }),
			)
			.map(([s, w, sp]) => r(s, s + w, sp))
		fc.assert(
			fc.property(
				fc.array(range, { maxLength: 5 }),
				fc.integer({ min: -10, max: 1_300_000 }),
				(ranges, hz) => {
					const oracle = ranges.some(
						x =>
							hz >= x.startHz &&
							hz <= x.endHz &&
							(x.rasters ?? []).some(
								q =>
									Number.isFinite(q.spacingHz) &&
									q.spacingHz > 0 &&
									q.spacingHz <= 6250,
							),
					)
					expect(narrowRasterAt(ranges, hz)).toBe(oracle)
				},
			),
			{ numRuns: 200 },
		)
	})
})
