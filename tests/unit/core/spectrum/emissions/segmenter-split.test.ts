import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DIP_FLOOR_FRACTION,
	DIP_SPLIT_DB,
	segment,
} from "../../../../../src/core/spectrum/emissions/segmenter.js"
import type { SegmentOptions } from "../../../../../src/core/spectrum/emissions/segmenter.js"

// WG16 SC: the split rules of the segmenter, each at and just past its bound.

const N = 128
const FLOOR = -60

function spectrum(levels: (i: number) => number): {
	power: Float32Array
	floor: Float32Array
	on: Uint8Array
} {
	const power = new Float32Array(N)
	const floor = new Float32Array(N).fill(FLOOR)
	const on = new Uint8Array(N)
	for (let i = 0; i < N; i++) {
		power[i] = levels(i)
		on[i] = power[i]! > FLOOR + 4 ? 1 : 0
	}
	return { power, floor, on }
}

function opts(over: Partial<SegmentOptions> = {}): SegmentOptions {
	return {
		gapBins: 2,
		usableStartBin: 4,
		usableEndBin: 124,
		exclusionEdges: [],
		rasterBinEdges: [],
		skirtDb: 30,
		inWindow: true,
		...over,
	}
}

const spans = (s: ReturnType<typeof spectrum>, o: SegmentOptions) =>
	segment(s.on, s.power, s.floor, o).map(x => [x.startBin, x.endBin])

/** Two flat plateaus [30, 50) and [55, 75) at floor + height, a flat valley [50, 55) `dip` below. */
function plateaus(height: number, dip: number, rightExtraDb = 0) {
	return spectrum(i => {
		if (i >= 30 && i < 50) return FLOOR + height
		if (i >= 50 && i < 55) return FLOOR + height - dip
		if (i >= 55 && i < 75) return FLOOR + height + rightExtraDb
		return FLOOR
	})
}

describe("segmenter split rules (WG16 SC)", () => {
	it("dip split: a 6 dB valley splits a 12 dB plateau, 5.9 dB does not", () => {
		const o = opts({ dipSplit: { smoothBins: 3 } })
		// The cut is the first bin of the smoothed minimum (bin 50 still averages bin 49 in).
		expect(spans(plateaus(12, DIP_SPLIT_DB), o)).toEqual([
			[30, 51],
			[51, 75],
		])
		expect(spans(plateaus(12, DIP_SPLIT_DB - 0.1), o)).toEqual([[30, 75]])
		// Off without the option: one run, one segment.
		expect(spans(plateaus(12, 7), opts())).toEqual([[30, 75]])
	})

	it("dip split: the valley must sit in the lower half of the height above the floor", () => {
		const o = opts({ dipSplit: { smoothBins: 3 } })
		// 20 dB plateaus: a valley 10 dB down sits at exactly half the height and splits.
		expect(spans(plateaus(20, 20 * DIP_FLOOR_FRACTION), o)).toHaveLength(2)
		// 9.9 dB down sits above half the height: one emitter (two lobes of one carrier).
		expect(spans(plateaus(20, 20 * DIP_FLOOR_FRACTION - 0.1), o)).toHaveLength(
			1,
		)
	})

	it("channel edges: a prominence merge never crosses a coarse channel edge; a far-weaker skirt does", () => {
		// Two flat pieces cut at bin 50 by a raster edge, the right 1 dB higher, no valley.
		const s = spectrum(i =>
			i >= 30 && i < 50 ? -30 : i >= 50 && i < 70 ? -29 : FLOOR,
		)
		const base = { rasterBinEdges: [50] }
		// Bin 50 is a fine edge only: the pieces merge.
		expect(spans(s, opts({ ...base, channelEdges: [] }))).toEqual([[30, 70]])
		expect(spans(s, opts({ ...base, channelEdges: [29, 70] }))).toEqual([
			[30, 70],
		])
		// Bin 50 is a channel edge: they stay apart; an edge one bin inside a piece too.
		expect(spans(s, opts({ ...base, channelEdges: [50] }))).toEqual([
			[30, 50],
			[50, 70],
		])
		expect(spans(s, opts({ ...base, channelEdges: [31] }))).toEqual([
			[30, 50],
			[50, 70],
		])
		// A skirt more than skirtDb (30 dB) down still joins across a channel edge.
		const skirted = spectrum(i =>
			i >= 50 && i < 70 ? -20 : i >= 70 && i < 90 ? -51 : FLOOR,
		)
		expect(
			spans(skirted, opts({ rasterBinEdges: [70], channelEdges: [70] })),
		).toEqual([[50, 90]])
	})

	/** A carrier at -20 dBFS on bins [60, 64) and a narrow piece [x, x + 3) `down` dB under it. */
	function carrierAndPiece(at: number, down: number) {
		return spectrum(i => {
			if (i >= 60 && i < 64) return -20
			if (i >= at && i < at + 3) return -20 - down
			if (i > Math.min(at, 60) && i < Math.max(at + 3, 64)) return FLOOR + 6 // on, deep valley
			return FLOOR
		})
	}

	it("sidebands: a piece more than 10 dB under a carrier within reach joins it; 10 dB does not", () => {
		const o = (reachBins: number) =>
			opts({ rasterBinEdges: [56], sideband: { db: 10, reachBins } })
		// Piece peak at bin 52, carrier peak at bin 60: 8 bins apart.
		expect(spans(carrierAndPiece(52, 10.5), o(8))).toEqual([[52, 64]])
		expect(spans(carrierAndPiece(52, 10), o(8))).toEqual([
			[52, 56],
			[56, 64],
		])
		// Reach: 8 bins apart joins at reach 8, not at reach 7.
		expect(spans(carrierAndPiece(52, 15), o(7))).toEqual([
			[52, 56],
			[56, 64],
		])
	})

	it("one channel: equal lobes 9 bins apart join below a 10-bin channel, not at 9", () => {
		const lobes = spectrum(i => {
			if (i === 60 || i === 69) return -14
			if (i > 57 && i < 72) return -40
			return FLOOR
		})
		const o = (minPeakBins: number) =>
			opts({ rasterBinEdges: [64], channel: { minPeakBins } })
		expect(spans(lobes, o(10))).toEqual([[58, 72]])
		expect(spans(lobes, o(9))).toEqual([
			[58, 64],
			[64, 72],
		])
	})

	// Feature: detection-quality, Property 26: Split rules only cut, never lose bins
	// Validates: Requirements 1.13
	it("with every rule on, segments stay disjoint, ordered and inside the on-runs of the plain segmenter", () => {
		fc.assert(
			fc.property(
				fc.array(fc.double({ min: -60, max: -10, noNaN: true }), {
					minLength: N,
					maxLength: N,
				}),
				fc.integer({ min: 1, max: 9 }),
				fc.integer({ min: 0, max: 60 }),
				(levels, smooth, cap) => {
					const s = spectrum(i => levels[i]!)
					const edges = [20, 40, 60, 80, 100]
					const plain = spans(
						s,
						opts({ rasterBinEdges: edges, skirtDb: 1_000 }),
					)
					const ruled = spans(
						s,
						opts({
							rasterBinEdges: edges,
							skirtDb: 1_000,
							dipSplit: { smoothBins: smooth | 1 },
							channelEdges: cap > 0 ? [cap, cap + 40] : [],
							sideband: { db: 10, reachBins: 8 },
							channel: { minPeakBins: 5 },
						}),
					)
					for (let k = 1; k < ruled.length; k++)
						expect(ruled[k]![0]!).toBeGreaterThanOrEqual(ruled[k - 1]![1]!)
					for (const [a, b] of ruled) {
						expect(b!).toBeGreaterThan(a!)
						for (let i = a!; i < b!; i++)
							if (s.on[i] === 1)
								expect(plain.some(([x, y]) => i >= x! && i < y!)).toBe(true)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
