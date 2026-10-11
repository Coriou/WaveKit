import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { segment } from "../../../../../src/core/spectrum/emissions/segmenter.js"
import type { SegmentOptions } from "../../../../../src/core/spectrum/emissions/segmenter.js"

const N = 256
const FLOOR = -60

function blank(): { power: Float32Array; floor: Float32Array; on: Uint8Array } {
	return {
		power: new Float32Array(N).fill(FLOOR),
		floor: new Float32Array(N).fill(FLOOR),
		on: new Uint8Array(N),
	}
}
function paint(p: Float32Array, from: number, levels: number[]): void {
	levels.forEach((db, j) => {
		p[from + j] = db
	})
}
function detect(power: Float32Array, floor: Float32Array, k = 4): Uint8Array {
	const on = new Uint8Array(N)
	for (let i = 0; i < N; i++)
		on[i] = (power[i] ?? 0) > (floor[i] ?? 0) + k ? 1 : 0
	return on
}
function opts(over: Partial<SegmentOptions> = {}): SegmentOptions {
	return {
		gapBins: 2,
		usableStartBin: 26,
		usableEndBin: 231,
		exclusionEdges: [],
		rasterBinEdges: [],
		skirtDb: 30,
		inWindow: false,
		...over,
	}
}

/** Synthetic measured spectrum: a weak rising skirt, a masked hole, and its strong parent. */
function maskedSkirt(
	over: {
		mirror?: boolean
		shift?: number
		rejection?: number
		prominence?: number
	} = {},
): { power: Float32Array; floor: Float32Array; on: Uint8Array } {
	const { power, floor, on } = blank()
	const rejection = over.rejection ?? 49.5
	const bin = (i: number) => (over.mirror ? N - 1 - i : i) + (over.shift ?? 0)
	const set = (i: number, db: number, active: boolean) => {
		power[bin(i)] = db
		on[bin(i)] = active ? 1 : 0
	}
	for (let i = 92; i <= 95; i++) set(i, -rejection - (95 - i) * 3, true)
	for (let i = 96; i <= 100; i++) set(i, -rejection + (i - 95) * 8, false)
	if ((over.prominence ?? 0) > 0) set(97, -rejection - over.prominence!, false)
	for (let i = 101; i <= 107; i++)
		set(i, i === 104 ? 0 : -Math.abs(104 - i), true)
	return { power, floor, on }
}
function skirtOpts(reachBins = 9): SegmentOptions {
	return opts({
		farSkirt: { reachBins, minDb: 50, dcBin: 128 },
		inWindow: true,
	})
}

describe("segment", () => {
	it("returns one segment with its peak and power-weighted centroid", () => {
		const { power, floor } = blank()
		paint(power, 100, [-40, -30, -20, -30, -40])
		const segs = segment(detect(power, floor), power, floor, opts())
		expect(segs).toHaveLength(1)
		const s = segs[0]!
		expect([s.startBin, s.endBin, s.peakBin, s.peakDb]).toEqual([
			100, 105, 102, -20,
		])
		expect(s.centroidBin).toBeCloseTo(102, 5)
		expect(s.flags).toEqual({ truncated: false, skirt: false, edge: false })
	})

	it("joins runs separated by at most gapBins off-bins and splits wider holes", () => {
		const { power, floor } = blank()
		paint(power, 60, [-30, -30, FLOOR, FLOOR, -30, -30]) // hole of 2 → joined
		paint(power, 120, [-30, -30, FLOOR, FLOOR, FLOOR, -30, -30]) // hole of 3 → split
		const segs = segment(detect(power, floor), power, floor, opts())
		expect(segs.map(s => [s.startBin, s.endBin])).toEqual([
			[60, 66],
			[120, 122],
			[125, 127],
		])
	})

	it("splits two emissions at a raster edge when each has its own peak", () => {
		const { power, floor } = blank()
		// two channels of 12 bins, raster edge at bin 112, 15 dB dip between the peaks
		paint(
			power,
			100,
			[-40, -30, -25, -20, -20, -20, -25, -30, -35, -40, -45, -45],
		)
		paint(
			power,
			112,
			[-45, -45, -40, -35, -30, -25, -22, -22, -25, -30, -35, -40],
		)
		const segs = segment(
			detect(power, floor),
			power,
			floor,
			opts({ rasterBinEdges: [88, 112, 124] }),
		)
		expect(segs.map(s => [s.startBin, s.endBin, s.flags.skirt])).toEqual([
			[100, 112, false],
			[112, 124, false],
		])
	})

	it("merges a monotone skirt across a raster edge into the parent and flags it", () => {
		const { power, floor } = blank()
		// +60 dB emission at bins 100..108, phase-noise skirt falling into the next channel
		paint(power, 100, [-10, -2, 0, 0, 0, 0, 0, -2, -10])
		paint(power, 109, [-20, -25, -30, -33, -36, -39, -42, -45, -48, -51, -54])
		const segs = segment(
			detect(power, floor),
			power,
			floor,
			opts({ rasterBinEdges: [109] }),
		)
		expect(segs).toHaveLength(1)
		expect([segs[0]!.startBin, segs[0]!.endBin, segs[0]!.flags.skirt]).toEqual([
			100,
			120,
			true,
		])
		expect(segs[0]!.peakDb).toBe(0)
	})

	it("merges a neighbour with its own peak when it is more than skirtDb below the parent", () => {
		const { power, floor } = blank()
		paint(power, 100, [-5, 0, 0, 0, -5, -20])
		paint(power, 106, [-48, -36, -48, -50]) // own peak (12 dB prominence) but 36 dB below the parent
		const segs = segment(
			detect(power, floor),
			power,
			floor,
			opts({ rasterBinEdges: [106] }),
		)
		expect(segs).toHaveLength(1)
		expect(segs[0]!.flags.skirt).toBe(true)
	})

	it("marks segments touching the usable span or an exclusion edge: truncated in sweeps, edge in-window", () => {
		const { power, floor } = blank()
		paint(power, 26, [-30, -30, -30]) // touches usableStartBin
		paint(power, 150, [-30, -30, -30]) // ends next to an exclusion starting at bin 153
		paint(power, 190, [-30, -30, -30]) // free
		const on = detect(power, floor)
		const sweep = segment(
			on,
			power,
			floor,
			opts({ exclusionEdges: [153, 160] }),
		)
		expect(
			sweep.map(s => [s.startBin, s.flags.truncated, s.flags.edge]),
		).toEqual([
			[26, true, false],
			[150, true, false],
			[190, false, false],
		])
		const inWindow = segment(
			on,
			power,
			floor,
			opts({ exclusionEdges: [153, 160], inWindow: true }),
		)
		expect(
			inWindow.map(s => [s.startBin, s.flags.truncated, s.flags.edge]),
		).toEqual([
			[26, false, true],
			[150, false, true],
			[190, false, false],
		])
	})

	it("ignores on-bins outside the usable span", () => {
		const { power, floor } = blank()
		paint(power, 5, [-30, -30])
		paint(power, 240, [-30, -30])
		expect(segment(detect(power, floor), power, floor, opts())).toEqual([])
	})

	it("drops a separate segment more than minDb below a strong one within reach (far skirt), never its DC mirror", () => {
		const run = (weakDb: number, far?: SegmentOptions["farSkirt"]) => {
			const { power, floor } = blank()
			paint(power, 100, [-5, 0, 0, 0, -5]) // strong emission, peak bin 101
			paint(power, 126, [weakDb]) // separate run 25 bins away: regrowth seen through a hole in the on-bins
			paint(power, 171, [weakDb]) // 70 bins away: beyond reach
			const o = far === undefined ? opts() : opts({ farSkirt: far })
			return segment(detect(power, floor), power, floor, o).map(s => [
				s.startBin,
				s.flags.skirt,
			])
		}
		const far = { reachBins: 31, minDb: 50, dcBin: 128 }
		expect(run(-55, far)).toEqual([
			[100, true],
			[171, false],
		])
		expect(run(-45, far)).toEqual([
			[100, false],
			[126, false],
			[171, false],
		]) // only 45 dB down: an emitter (or an intermod product) of its own
		expect(run(-50, far)).toEqual([
			[100, false],
			[126, false],
			[171, false],
		]) // exactly minDb: retain the independent peak
		expect(run(-50.01, far)).toEqual([
			[100, true],
			[171, false],
		])
		expect(run(-55, { ...far, dcBin: 113.5 })).toEqual([
			[100, false],
			[126, false],
			[171, false],
		]) // 101 + 126 = 2 × 113.5: an IQ image, left to Task 11a
		expect(run(-55)).toEqual([
			[100, false],
			[126, false],
			[171, false],
		]) // off without farSkirt
	})

	it.each([false, true])(
		"drops a 49.5 dB mask-separated skirt with no independent peak (mirror=%s)",
		mirror => {
			const { power, floor, on } = maskedSkirt({ mirror })
			const segs = segment(on, power, floor, skirtOpts())
			expect(segs).toHaveLength(1)
			expect(segs[0]?.peakDb).toBe(0)
			expect(segs[0]?.flags.skirt).toBe(true)
		},
	)

	it.each([
		[30, 9, 0, 2], // exactly skirtDb: retain
		[30.01, 9, 0, 1],
		[49.5, 8, 0, 2], // beyond reach: retain
		[49.5, 9, 0, 1], // exactly reach: reject
		[49.5, 9, 6, 2], // exactly PROMINENCE_DB: retain
		[49.5, 9, 6.01, 2],
		[49.5, 9, 5.99, 1],
	])(
		"respects rejection/prominence/reach boundaries (%s dB, %s bins, %s dB valley)",
		(rejection, reach, prominence, count) => {
			const { power, floor, on } = maskedSkirt({ rejection, prominence })
			expect(segment(on, power, floor, skirtOpts(reach))).toHaveLength(count)
		},
	)

	it.each([false, true])(
		"a masked DC spike alone cannot erase an independent weak peak (mirror=%s)",
		mirror => {
			const { power, floor, on } = maskedSkirt({ mirror, prominence: 6 })
			// The masked first bin rises above the weak boundary, but the next valley
			// retains the independent emitter's 6 dB prominence before the parent.
			const spike = mirror ? N - 1 - 96 : 96
			power[spike] = 10
			const segs = segment(on, power, floor, skirtOpts())
			expect(segs).toHaveLength(2)
			expect(segs.every(s => !s.flags.skirt)).toBe(true)
		},
	)

	it.each([NaN, Infinity, -Infinity, FLOOR])(
		"retains a weak peak when gap power is unknown or reaches the noise floor (%s)",
		gapPower => {
			const { power, floor, on } = maskedSkirt()
			power[98] = gapPower
			expect(segment(on, power, floor, skirtOpts())).toHaveLength(2)
		},
	)

	it("does not apply boundary rejection without far-skirt geometry", () => {
		const { power, floor, on } = maskedSkirt()
		expect(segment(on, power, floor, opts())).toHaveLength(2)
	})

	it.each([-49.5, -50])(
		"retains a boundary peak when the next masked bin does not keep rising (%s)",
		gapPower => {
			const { power, floor, on } = maskedSkirt()
			power[96] = gapPower
			expect(segment(on, power, floor, skirtOpts())).toHaveLength(2)
		},
	)

	it("keeps real weak local peaks, including IQ mirrors and intermod-strength emitters", () => {
		for (const rejection of [40, 49.5, 55]) {
			const { power, floor, on } = maskedSkirt({ rejection })
			power[94] = -rejection + 1 // own interior peak, not a mask boundary maximum
			const geometry = skirtOpts()
			geometry.farSkirt!.dcBin = (94 + 104) / 2
			expect(segment(on, power, floor, geometry)).toHaveLength(2)
		}
	})

	it("rejects only the peakless side of a masked hole across translated and mirrored spectra", () => {
		// Feature: signal-discovery-scanner, Property 18: No neighbour ghosts
		// Validates: spec § 6.2
		fc.assert(
			fc.property(
				fc.integer({ min: -40, max: 40 }),
				fc.boolean(),
				fc.double({ min: 31, max: 49.5, noNaN: true }),
				fc.double({ min: 6, max: 10, noNaN: true }),
				(shift, mirror, rejection, prominence) => {
					for (const valley of [0, prominence]) {
						const { power, floor, on } = maskedSkirt({
							shift,
							mirror,
							rejection,
							prominence: valley,
						})
						const segs = segment(on, power, floor, skirtOpts())
						expect(segs).toHaveLength(valley === 0 ? 1 : 2)
						if (valley === 0) expect(segs[0]?.flags.skirt).toBe(true)
					}
				},
			),
			{ numRuns: 100, seed: 20261011 },
		)
	})

	it("partitions every usable on-bin into exactly one disjoint, ordered segment", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 1 }), {
					minLength: N,
					maxLength: N,
				}),
				fc.array(fc.float({ min: -55, max: 0, noNaN: true }), {
					minLength: N,
					maxLength: N,
				}),
				fc.uniqueArray(fc.integer({ min: 27, max: 230 }), { maxLength: 12 }),
				fc.integer({ min: 0, max: 3 }),
				(bits, levels, edges, gapBins) => {
					const on = Uint8Array.from(bits)
					const power = Float32Array.from(
						levels.map((l, i) => (bits[i] === 1 ? l : FLOOR)),
					)
					const floor = new Float32Array(N).fill(FLOOR)
					const o = opts({ rasterBinEdges: edges, gapBins })
					const segs = segment(on, power, floor, o)
					let prevEnd = -1
					for (const s of segs) {
						expect(s.startBin).toBeGreaterThan(prevEnd - 1)
						expect(s.startBin).toBeLessThan(s.endBin)
						expect(s.startBin).toBeGreaterThanOrEqual(o.usableStartBin)
						expect(s.endBin).toBeLessThanOrEqual(o.usableEndBin)
						expect(s.peakBin).toBeGreaterThanOrEqual(s.startBin)
						expect(s.peakBin).toBeLessThan(s.endBin)
						expect(on[s.startBin]).toBe(1)
						expect(on[s.endBin - 1]).toBe(1)
						prevEnd = s.endBin
					}
					for (let i = o.usableStartBin; i < o.usableEndBin; i++) {
						if (on[i] !== 1) continue
						expect(
							segs.filter(s => i >= s.startBin && i < s.endBin),
						).toHaveLength(1)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
