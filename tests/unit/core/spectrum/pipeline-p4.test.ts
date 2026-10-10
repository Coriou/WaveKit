import fc from "fast-check"
import { beforeEach, describe, expect, it } from "vitest"
import {
	addInto,
	fsk4Burst,
	gaussianNoise,
	heavyTailedNoise,
	mulberry32,
	narrowbandPsd,
	obwBelowPeakHz,
	tone,
} from "../../../mocks/scanner/signals.js"
import type { Iq } from "../../../mocks/scanner/signals.js"
import { CENTRE, FS, Harness, yieldToRpc } from "./pipeline-harness.js"

const SIGMA = 0.01
const RBW = 1000
const LEAD = Math.round(0.1 * FS)
const SIGNAL = Math.round(0.5 * FS)
const TOTAL = Math.round(1.2 * FS)

/** Amplitude whose power over the noise in 12.5 kHz equals `snrDb`. */
function ampFor(snrDb: number): number {
	return Math.sqrt(10 ** (snrDb / 10) * SIGMA * SIGMA * (12_500 / FS))
}
const offsetArb = fc
	.tuple(fc.boolean(), fc.integer({ min: 150, max: 800 }))
	.map(([neg, h]) => (neg ? -1 : 1) * h * 100)

function runWith(seed: number, signal: Iq): Harness {
	const rng = mulberry32(seed)
	const iq = gaussianNoise(rng, TOTAL, SIGMA)
	addInto(iq, signal, LEAD)
	const h = new Harness({ format: "FLOAT32LE" })
	h.start({ feed: false })
	h.push(iq, 8192)
	return h
}

describe("detector on synthetic signals", () => {
	beforeEach(yieldToRpc)

	it("opens a track within 1 RBW of a tone at SNR ≥ 3 dB", () => {
		// Feature: signal-discovery-scanner, Property 4: Detector on synthetic signals
		// Validates: spec § 4.5, § 7.2
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 0x7fffffff }),
				fc.integer({ min: 3, max: 25 }),
				offsetArb,
				(seed, snr, offset) => {
					const h = runWith(seed, tone(SIGNAL, FS, offset, ampFor(snr)))
					const hits = h
						.tracks()
						.filter(t => Math.abs(t.centreHz - (CENTRE + offset)) <= RBW)
					expect(hits.length).toBeGreaterThan(0)
				},
			),
			{ numRuns: 100, seed: 4_001 }, // fixed (spec § 13): 3 dB sits on the statistical boundary
		)
	}, 120_000)

	it("opens a track within 2 RBW of a 9 kHz 4FSK burst at SNR ≥ 3 dB", () => {
		// Feature: signal-discovery-scanner, Property 4: Detector on synthetic signals
		// Validates: spec § 4.5, § 7.2
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 0x7fffffff }),
				fc.integer({ min: 3, max: 25 }),
				offsetArb,
				(seed, snr, offset) => {
					const sig = fsk4Burst(
						mulberry32(seed ^ 0x5a5a),
						SIGNAL,
						FS,
						offset,
						ampFor(snr),
					)
					const h = runWith(seed, sig)
					const hits = h
						.tracks()
						.filter(t => Math.abs(t.centreHz - (CENTRE + offset)) <= 2 * RBW)
					expect(hits.length).toBeGreaterThan(0)
				},
			),
			{ numRuns: 100, seed: 4_002 },
		)
	}, 120_000)

	it("measures the −20 dB OBW of a 4FSK burst within ±25 % at SNR ≥ 30 dB", async () => {
		// Feature: signal-discovery-scanner, Property 4: Detector on synthetic signals
		// Validates: spec § 4.5, § 6.2
		// async with a yield per run: this property alone takes 19–48 s on the loaded Mac
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 0x7fffffff }),
				fc.integer({ min: 30, max: 45 }),
				offsetArb,
				async (seed, snr, offset) => {
					await yieldToRpc()
					const sig = fsk4Burst(
						mulberry32(seed ^ 0x5a5a),
						SIGNAL,
						FS,
						offset,
						ampFor(snr),
					)
					const truth = obwBelowPeakHz(
						narrowbandPsd(sig, FS, offset, { decimation: 4, nfft: 512 }),
						20,
					)
					const h = runWith(seed, sig)
					// the burst's last block can leave a 1-block, 1 kHz fragment near the centre; P4 is about the emission's track
					const closed = h
						.of("track-close")
						.filter(
							c =>
								Math.abs(c.track.centreHz - (CENTRE + offset)) <= 2 * RBW &&
								c.track.blocks >= h.config.minSurfaceBlocks,
						)
					expect(closed).toHaveLength(1)
					const t = closed[0]!.track
					expect(t.obwMethod).toBe("-20dB")
					expect(Math.abs(t.obwHz - truth)).toBeLessThanOrEqual(0.25 * truth)
				},
			),
			{ numRuns: 100, seed: 4_003, examples: [[28, 30, -66_000]] }, // the example once left a second, 1-block fragment
		)
	}, 120_000)

	function heavyTail(seed: number, eventsPerMhzMin: number): Harness {
		const rng = mulberry32(seed)
		const h = new Harness({ format: "FLOAT32LE" })
		h.start({ feed: false })
		for (let s = 0; s < 60; s++) {
			const iq = heavyTailedNoise(rng, FS, SIGMA, {
				fs: FS,
				eventsPerMhzSec: eventsPerMhzMin / 60,
				excessDb: 13,
				eventMs: 5,
			})
			h.push(iq, 16_384)
		}
		return h
	}

	it.each([1, 2, 3])(
		"never builds a surfacing-length track from calibrated heavy-tailed noise in 60 s (seed %i)",
		seed => {
			// Feature: signal-discovery-scanner, Property 4: Detector on synthetic signals
			// Validates: spec § 4.5, § 7.2
			const h = heavyTail(seed, 1)
			expect(
				h.tracks().filter(t => t.blocks >= h.config.minSurfaceBlocks),
			).toEqual([])
		},
		60_000,
	)

	it("sees the heavy-tail events as single-block edges when they are 60× more frequent", () => {
		const h = heavyTail(4, 60)
		const opened = h.of("track-open").length
		// most events split across two blocks and stay below k; at this seed 2 cross it (measured on the Task 10 code)
		expect(opened).toBeGreaterThanOrEqual(1)
		const long = h
			.tracks()
			.filter(t => t.blocks >= h.config.minSurfaceBlocks).length
		expect(long / opened).toBeLessThanOrEqual(0.1)
	}, 60_000)
})
