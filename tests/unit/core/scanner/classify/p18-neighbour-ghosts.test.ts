import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { leakOrIntermod } from "../../../../../src/core/scanner/classify/classifier.js"
import type { TrackSnapshot } from "../../../../../src/core/spectrum/types.js"
import {
	addInto,
	fsk4Burst,
	gaussianNoise,
	intermodPair,
	mulberry32,
} from "../../../../mocks/scanner/signals.js"
import {
	CENTRE,
	FS,
	Harness,
	yieldToRpc,
} from "../../spectrum/pipeline-harness.js"

const SIGMA = 0.001
const RASTER = { spacingHz: 12_500, firstChannelHz: 446_006_250 }
const ampFor = (snrDb: number) =>
	Math.sqrt(10 ** (snrDb / 10) * SIGMA * SIGMA * (12_500 / FS))

function track(id: string, centreHz: number, peakDbfs: number): TrackSnapshot {
	return {
		trackId: id,
		sourceId: "s1",
		stream: 1,
		epoch: 1,
		startSample: 0,
		lastSample: 0,
		centreHz,
		obwHz: 2000,
		obwMethod: "-20dB",
		peakDbfs,
		meanDbfs: peakDbfs,
		snrDb: 30,
		floorDbfs: -90,
		thresholdDb: 4,
		blocks: 5,
		maxBlockSnrDb: 30,
		dutyCycle: 1,
		spectralShape: "narrow",
		flags: {
			overload: false,
			gap: false,
			truncated: false,
			edge: false,
			skirt: false,
			obwBiased: false,
			spur: false,
			burst: false,
		},
		tuningTrust: "commanded",
	}
}

describe("no neighbour ghosts", () => {
	it("a +60 dB emission produces no track in its neighbour raster channels", async () => {
		// Feature: signal-discovery-scanner, Property 18: No neighbour ghosts
		// Validates: spec § 6.2
		const channelArb = fc.constantFrom(-4, -3, -2, 2, 3, 4) // channel m sits at CENTRE + 6250 + 12500·(m − 1)
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 0x7fffffff }),
				channelArb,
				fc.integer({ min: 60, max: 66 }),
				async (seed, m, snr) => {
					await yieldToRpc()
					const rng = mulberry32(seed)
					const offset = 6250 + 12_500 * (m - 1)
					const n = Math.round(0.6 * FS)
					const iq = gaussianNoise(rng, n, SIGMA)
					addInto(iq, fsk4Burst(rng, n, FS, offset, ampFor(snr)))
					const h = new Harness({ format: "FLOAT32LE" })
					h.start({ rasters: [RASTER], inWindow: false, feed: false })
					h.push(iq, 8192)
					const main = CENTRE + offset
					const tracks = h.tracks()
					expect(
						tracks.some(
							t => Math.abs(t.centreHz - main) <= 2000 && t.blocks >= 2,
						),
					).toBe(true)
					// The 4FSK generator's own spectral regrowth sits ≈ 66 dB down about 23 kHz out; a hole in the
					// on-bins keeps it from merging, so the segmenter's far-skirt rule (Task 9) drops it: no track at all.
					for (const t of tracks) {
						for (const k of [-2, -1, 1, 2]) {
							expect(
								Math.abs(t.centreHz - (main + k * 12_500)),
							).toBeGreaterThan(5000)
						}
					}
				},
			),
			// fixed seed (spec § 13: statistical boundary); the example is the regrowth counterexample [seed 1, m 2, +60 dB]
			{ numRuns: 100, seed: 18_001, examples: [[1, 2, 60]] },
		)
	}, 120_000)

	it("an exact 2f1 − f2 product of two stronger tracks is flagged suspected-intermod", () => {
		// Feature: signal-discovery-scanner, Property 18: No neighbour ghosts
		// Validates: spec § 6.2
		fc.assert(
			fc.property(
				fc.integer({ min: 400_000_000, max: 470_000_000 }),
				fc.integer({ min: 12_500, max: 400_000 }),
				fc.integer({ min: -1000, max: 1000 }),
				fc.integer({ min: 21, max: 60 }),
				(f1, spacing, jitter, dbc) => {
					const f2 = f1 + spacing
					const product = 2 * f1 - f2 + jitter // within ±1 RBW (1 kHz)
					const others = [track("a", f1, -20), track("b", f2, -22)]
					expect(
						leakOrIntermod(track("p", product, -20 - dbc), others, () => []),
					).toBe("suspected-intermod")
					expect(
						leakOrIntermod(
							track("p", product + 2500, -20 - dbc),
							others,
							() => [],
						),
					).toBeUndefined()
					const weaker = [track("a", f1, -20), track("b", f2, -25 - dbc)]
					expect(
						leakOrIntermod(track("p", product, -20 - dbc), weaker, () => []),
					).toBeUndefined()
				},
			),
			{ numRuns: 100 },
		)
	})

	it("flags the intermod product found by the pipeline", () => {
		const rng = mulberry32(5)
		const n = Math.round(0.6 * FS)
		const iq = gaussianNoise(rng, n, SIGMA)
		addInto(iq, intermodPair(n, FS, 20_000, 45_000, 0.3, -40)) // products at −5 kHz and +70 kHz
		const h = new Harness({ format: "FLOAT32LE" })
		h.start({ feed: false })
		h.push(iq, 8192)
		const updates = h.of("track-update").map(e => e.track)
		const at = (hz: number) =>
			updates.find(t => Math.abs(t.centreHz - (CENTRE + hz)) <= 1000)
		const p = at(-5000)
		const a = at(20_000)
		const b = at(45_000)
		expect(p && a && b).toBeTruthy()
		if (!p || !a || !b) return
		expect(leakOrIntermod(p, [a, b], () => [])).toBe("suspected-intermod")
		expect(leakOrIntermod(a, [p, b], () => [])).toBeUndefined()
	})
})
