import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import {
	dcGuardBins,
	defaultK,
	Detector,
	K_TABLE,
	usableEdgeBins,
} from "../../../../src/core/spectrum/detector.js"
import { mulberry32 } from "../../../mocks/scanner/signals.js"

const N = 2048
const BIN_HZ = 1000

function detector(
	opts: { pinnedK?: number | null; faTarget?: number } = {},
): Detector {
	return new Detector({
		fftSize: N,
		hysteresisDb: 3,
		faTargetPerMhzMin: opts.faTarget ?? 1,
		pinnedK: opts.pinnedK ?? null,
		rbwHz: 1000,
		integrationMs: 50,
	})
}

function standardMasks(d: Detector, extra: Uint8Array | null = null): void {
	d.setMasks({
		dcGuardBins: dcGuardBins(1500, 1000, BIN_HZ),
		edgeBins: usableEdgeBins(N, 0.8),
		extra,
	})
}

function unmaskedMhz(d: Detector): number {
	return (d.unmasked().reduce((s, v) => s + v, 0) * BIN_HZ) / 1e6
}

describe("k table", () => {
	it("pins the measured table exactly", () => {
		expect(K_TABLE).toEqual([
			{ rbwHz: 1000, kDb: [5.5, 4.0, 3.5] },
			{ rbwHz: 500, kDb: [7.0, 5.0, 4.0] },
			{ rbwHz: 250, kDb: [9.0, 7.5, 5.5] },
		])
		for (const row of K_TABLE) {
			expect(defaultK(row.rbwHz, 20)).toBe(row.kDb[0])
			expect(defaultK(row.rbwHz, 50)).toBe(row.kDb[1])
			expect(defaultK(row.rbwHz, 100)).toBe(row.kDb[2])
		}
	})

	it("interpolates linearly in T and clamps outside 20–100 ms", () => {
		expect(defaultK(1000, 35)).toBeCloseTo(4.75, 10)
		expect(defaultK(1000, 75)).toBeCloseTo(3.75, 10)
		expect(defaultK(250, 80)).toBeCloseTo(6.3, 10)
		expect(defaultK(1000, 5)).toBe(5.5)
		expect(defaultK(1000, 500)).toBe(3.5)
	})

	it("uses the nearest RBW row in log frequency", () => {
		expect(defaultK(2_400_000 / 2048, 50)).toBe(4.0) // 1171.9 Hz → 1 kHz row
		expect(defaultK(700, 50)).toBe(5.0) // below √(500·1000) ≈ 707 → 500 Hz row
		expect(defaultK(720, 50)).toBe(4.0)
		expect(defaultK(353, 50)).toBe(7.5) // below √(250·500) ≈ 353.6 → 250 Hz row
		expect(defaultK(360, 50)).toBe(5.0)
		expect(defaultK(125, 50)).toBe(7.5)
		expect(defaultK(4000, 50)).toBe(4.0)
	})
})

describe("masks", () => {
	it("derives the DC guard and usable edge in bins", () => {
		expect(dcGuardBins(1500, 1000, 1000)).toBe(2)
		expect(dcGuardBins(1500, 500, 500)).toBe(3)
		expect(dcGuardBins(1500, 250, 250)).toBe(6)
		expect(dcGuardBins(1500, 1171.875, 1171.875)).toBe(2)
		expect(dcGuardBins(5000, 1000, 1000)).toBe(5)
		expect(usableEdgeBins(2048, 0.8)).toBe(205)
		expect(usableEdgeBins(2048, 0.75)).toBe(256)
		expect(usableEdgeBins(4096, 1)).toBe(0)
	})

	it("keeps masked bins off whatever their power, symmetric about DC", () => {
		const d = detector()
		const extra = new Uint8Array(N)
		extra[700] = 1
		standardMasks(d, extra)
		const m = d.unmasked()
		expect([m[204], m[205], m[1843], m[1844]]).toEqual([0, 1, 1, 0])
		expect([m[1021], m[1022], m[1024], m[1026], m[1027]]).toEqual([
			1, 0, 0, 0, 1,
		])
		expect(m[700]).toBe(0)
		const power = new Float32Array(N).fill(0)
		const floor = new Float32Array(N).fill(-60)
		const out = new Uint8Array(N)
		d.detect(power, floor, out)
		for (let i = 0; i < N; i++) expect(out[i]).toBe(m[i])
	})
})

describe("hysteresis", () => {
	it("turns on above floor + k and off below floor + k − 3 dB", () => {
		const d = detector()
		standardMasks(d)
		const floor = new Float32Array(N).fill(-60)
		const out = new Uint8Array(N)
		const step = (p: number): number => {
			const power = new Float32Array(N).fill(-80)
			power[500] = p
			d.detect(power, floor, out)
			return out[500]!
		}
		expect(step(-56)).toBe(0) // at threshold: not above
		expect(step(-55.9)).toBe(1)
		expect(step(-58.9)).toBe(1)
		expect(step(-59)).toBe(1)
		expect(step(-59.1)).toBe(0)
		expect(step(-56.5)).toBe(0)
		expect(step(-55)).toBe(1)
		d.reset()
		expect(step(-57)).toBe(0)
	})

	it("matches a two-threshold automaton for any power sequence", () => {
		fc.assert(
			fc.property(
				fc.array(fc.double({ min: -70, max: -45, noNaN: true }), {
					minLength: 1,
					maxLength: 60,
				}),
				seq => {
					const d = detector()
					standardMasks(d)
					const floor = new Float32Array(N).fill(-60)
					const out = new Uint8Array(N)
					let ref = false
					for (const p of seq) {
						const power = new Float32Array(N).fill(-80)
						power[600] = p
						d.detect(power, floor, out)
						ref = ref ? p >= -59 : p > -56
						expect(out[600] === 1).toBe(ref)
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	it("applies a pinned k everywhere and never adapts it", () => {
		const d = detector({ pinnedK: 10 })
		standardMasks(d)
		d.setCfarRanges([{ startBin: 300, endBin: 700, key: "r", burst: false }])
		expect(d.kFor(400)).toBe(10)
		expect(d.kFor(1500)).toBe(10)
		const rng = mulberry32(3)
		for (let c = 0; c < 120; c++) {
			const on = new Uint8Array(N)
			on[300 + Math.floor(rng() * 400)] = 1
			d.recordNoiseEdges(on, new Uint8Array(N), 0.5, unmaskedMhz(d))
		}
		expect(d.kFor(400)).toBe(10)
		expect(d.stats()).toEqual([
			{ key: "r", k: 10, faPerMhzMin: expect.any(Number) as number },
		])
	})
})

describe("adaptive CFAR", () => {
	/** Calls of `minutes` each; `blips(c)` returns the bins of 1-block rising edges in call c. */
	function run(
		d: Detector,
		calls: number,
		minutes: number,
		blips: (c: number) => number[],
		joined?: (c: number) => Uint8Array,
	): void {
		for (let c = 0; c < calls; c++) {
			const on = new Uint8Array(N)
			for (const b of blips(c)) on[b] = 1
			d.recordNoiseEdges(
				on,
				joined?.(c) ?? new Uint8Array(N),
				minutes,
				unmaskedMhz(d),
			)
		}
	}

	function setup(burst = false): Detector {
		const d = detector()
		standardMasks(d)
		// 400 kHz range: 0.4 MHz of the 1.633 MHz unmasked window
		d.setCfarRanges([{ startBin: 300, endBin: 700, key: "r", burst }])
		return d
	}

	const noisy = (c: number): number[] => [300 + ((c * 37) % 390)] // 2 edges/min = 5 /MHz/min in 0.4 MHz

	it("raises k by 0.5 dB per noisy 5-minute window up to table + 4 dB, only inside the range", () => {
		const d = setup()
		run(d, 9, 0.5, noisy) // 4.5 min: no complete window yet
		expect(d.kFor(400)).toBe(4)
		run(d, 2, 0.5, noisy) // window 1 completes
		expect(d.kFor(400)).toBe(4.5)
		expect(d.kFor(1500)).toBe(4)
		run(d, 120, 0.5, noisy) // one hour more
		expect(d.kFor(400)).toBe(8)
		expect(d.stats()[0]!.faPerMhzMin).toBeGreaterThan(1)
	})

	it("lowers k by 0.5 dB per quiet 30-minute window, never below the table", () => {
		const d = setup()
		run(d, 30, 0.5, noisy) // 15 min: +1.5 dB
		expect(d.kFor(400)).toBe(5.5)
		run(d, 59, 0.5, () => []) // 29.5 quiet minutes
		expect(d.kFor(400)).toBe(5.5)
		run(d, 1, 0.5, () => [])
		expect(d.kFor(400)).toBe(5)
		run(d, 600, 0.5, () => [])
		expect(d.kFor(400)).toBe(4)
	})

	it("does not raise at exactly the target rate", () => {
		const d = setup()
		// 0.4 MHz × 5 min = 2 MHz·min of exposure (share of the unmasked span): exactly target → 2 edges
		const share = 400 / d.unmasked().reduce((s, v) => s + v, 0)
		const exposure = unmaskedMhz(d) * share * 5
		const edges = Math.round(exposure) // ≈ 0.4·5 = 2
		run(d, 10, 0.5, c => (c < edges ? [310 + 20 * c] : []))
		expect(edges / exposure).toBeLessThanOrEqual(1.0001)
		expect(d.kFor(400)).toBe(4)
	})

	it("ignores wide edges, edges joining ≥ 2-block tracks, burst ranges and bins outside every range", () => {
		const wide = setup()
		run(wide, 20, 0.5, c => {
			const b = 300 + ((c * 37) % 380)
			return [b, b + 1, b + 2]
		})
		expect(wide.kFor(400)).toBe(4)

		const joined = setup()
		run(joined, 20, 0.5, noisy, c => {
			const j = new Uint8Array(N)
			j[noisy(c - 1)[0] ?? 0] = 1 // the previous call's edge continued into a 2-block track
			return j
		})
		expect(joined.kFor(400)).toBe(4)

		const burst = setup(true)
		run(burst, 20, 0.5, noisy)
		expect(burst.kFor(400)).toBe(4)

		const outside = setup()
		run(outside, 20, 0.5, c => [800 + ((c * 37) % 200)])
		expect(outside.kFor(400)).toBe(4)
	})

	it("counts only rising edges, not bins that stay on", () => {
		const d = setup()
		run(d, 20, 0.5, () => [450]) // a 1-bin carrier on in every block
		expect(d.kFor(400)).toBe(4)
	})

	it("keeps k per range key across window changes and round-trips it, clamped", () => {
		const d = setup()
		run(d, 11, 0.5, noisy)
		expect(d.kFor(400)).toBe(4.5)
		d.setCfarRanges([
			{ startBin: 900, endBin: 1000, key: "other", burst: false },
		])
		expect(d.kFor(400)).toBe(4)
		d.setCfarRanges([{ startBin: 300, endBin: 700, key: "r", burst: false }])
		expect(d.kFor(400)).toBe(4.5)
		const restored = detector()
		restored.importK([
			{ key: "r", k: 4.5 },
			{ key: "hi", k: 20 },
			{ key: "lo", k: 1 },
		])
		restored.setCfarRanges([
			{ startBin: 300, endBin: 700, key: "r", burst: false },
			{ startBin: 700, endBin: 800, key: "hi", burst: false },
			{ startBin: 800, endBin: 900, key: "lo", burst: false },
		])
		expect([
			restored.kFor(400),
			restored.kFor(750),
			restored.kFor(850),
		]).toEqual([4.5, 8, 4])
	})
})
