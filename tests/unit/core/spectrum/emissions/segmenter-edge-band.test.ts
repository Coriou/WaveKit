import { describe, expect, it } from "vitest"
import { usableEdgeBins } from "../../../../../src/core/spectrum/detector.js"
import { segment } from "../../../../../src/core/spectrum/emissions/segmenter.js"
import type { SegmentOptions } from "../../../../../src/core/spectrum/emissions/segmenter.js"
import {
	DETECTION_USABLE_FRACTION,
	USABLE_FRACTION,
} from "../../../../../src/core/spectrum/spectrum-engine.js"

// The detection span (0.95) reaches past the usable span (0.8); segments in the band between
// keep the `edge` flag in window (`truncated` in sweeps).

const N = 256
const FLOOR = -60
const DETECT_EDGE = usableEdgeBins(N, DETECTION_USABLE_FRACTION) // 7
const FLAG_EDGE = usableEdgeBins(N, USABLE_FRACTION) // 26
const GAP = 2

function opts(over: Partial<SegmentOptions> = {}): SegmentOptions {
	return {
		gapBins: GAP,
		usableStartBin: DETECT_EDGE,
		usableEndBin: N - DETECT_EDGE + 1,
		edgeStartBin: FLAG_EDGE,
		edgeEndBin: N - FLAG_EDGE + 1,
		exclusionEdges: [],
		rasterBinEdges: [],
		skirtDb: 30,
		inWindow: true,
		...over,
	}
}

/** One 3-bin emission starting at `from`; returns its segments. */
function emission(from: number, over: Partial<SegmentOptions> = {}) {
	const power = new Float32Array(N).fill(FLOOR)
	const floor = new Float32Array(N).fill(FLOOR)
	const on = new Uint8Array(N)
	for (let i = from; i < from + 3; i++) {
		power[i] = -30
		on[i] = 1
	}
	return segment(on, power, floor, opts(over))
}

describe("detection span and edge band", () => {
	it("states the spans: 0.95 is ±486.4 kHz and 0.8 ±409.6 kHz at 1.024 Msps", () => {
		expect((DETECTION_USABLE_FRACTION * 1_024_000) / 2).toBeCloseTo(486_400, 6)
		expect((USABLE_FRACTION * 1_024_000) / 2).toBeCloseTo(409_600, 6)
		// 1024-point FFT at 1 kHz bins: 26 bins masked a side (512 − 486.4 = 25.6 → 26), was 103.
		expect(usableEdgeBins(1024, DETECTION_USABLE_FRACTION)).toBe(26)
		expect(usableEdgeBins(1024, USABLE_FRACTION)).toBe(103)
		expect(DETECT_EDGE).toBe(7)
		expect(FLAG_EDGE).toBe(26)
	})

	it("low side: a segment within gapBins of the 0.8 bound is edge, one bin further in is not", () => {
		expect(emission(FLAG_EDGE + GAP)[0]!.flags.edge).toBe(true)
		expect(emission(FLAG_EDGE + GAP + 1)[0]!.flags.edge).toBe(false)
	})

	it("high side: a segment ending within gapBins of the 0.8 bound is edge, one bin further in is not", () => {
		const end = N - FLAG_EDGE + 1 - GAP // the segment's exclusive end at the bound
		expect(emission(end - 3)[0]!.flags.edge).toBe(true)
		expect(emission(end - 4)[0]!.flags.edge).toBe(false)
	})

	it("the 0.95 bound: a segment at its first usable bin is kept and edge; bins past it are masked", () => {
		const at = emission(DETECT_EDGE)
		expect(at).toHaveLength(1)
		expect(at[0]!.startBin).toBe(DETECT_EDGE)
		expect(at[0]!.flags.edge).toBe(true)
		expect(emission(DETECT_EDGE - 3)).toHaveLength(0)
		const hi = N - DETECT_EDGE + 1
		expect(emission(hi - 3)).toHaveLength(1)
		expect(emission(hi)).toHaveLength(0)
	})

	it("edge-band segments are truncated, not edge, in a sweep", () => {
		const s = emission(FLAG_EDGE, { inWindow: false })[0]!
		expect([s.flags.truncated, s.flags.edge]).toEqual([true, false])
	})

	it("without an edge band the usable span's own bounds decide, as before", () => {
		const o = opts()
		delete o.edgeStartBin
		delete o.edgeEndBin
		const power = new Float32Array(N).fill(FLOOR)
		const floor = new Float32Array(N).fill(FLOOR)
		const on = new Uint8Array(N)
		for (const from of [DETECT_EDGE + GAP + 1, FLAG_EDGE])
			for (let i = from; i < from + 3; i++) {
				power[i] = -30
				on[i] = 1
			}
		expect(segment(on, power, floor, o).map(s => s.flags.edge)).toEqual([
			false,
			false,
		])
	})
})
