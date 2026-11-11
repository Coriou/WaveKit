import { describe, expect, it } from "vitest"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	tone,
} from "../../../mocks/scanner/signals.js"
import type { Iq } from "../../../mocks/scanner/signals.js"
import { BIN_HZ, BLOCK, CENTRE, FS, Harness, N } from "./pipeline-harness.js"

/**
 * Spec § 4.6 stale check against receiver lines: a line under every centre sits at the same
 * baseband bins after a retune, so its old track bins are no evidence that a block is stale.
 * Without that rule an unverified line cost STALE_MAX_MS (1 s = 20 blocks of 50 ms) on every
 * retune, and anything new in that second was discarded with it.
 */
const SIGMA = 0.005
const NOISE_BIN_POWER = (SIGMA * SIGMA * 1.5) / N
const toneAmp = (perBinSnrDb: number): number =>
	Math.sqrt(NOISE_BIN_POWER * 10 ** (perBinSnrDb / 10))
/** 20 dB in 12.5 kHz (the pipeline tests' SNR convention). */
const EMISSION_AMP = Math.sqrt((SIGMA * SIGMA * 12_500 * 100) / FS)
/**
 * The receiver line: 0.1 bin off a bin centre, 25 dB per bin. Its 12.5 kHz slot level is about
 * (13 + 1.5 × 10^2.5) / 13 ≈ 37.5, +15.7 dB, over the 6 dB bound: it never verifies, never masks.
 */
const LINE_HZ = (88 - N / 2 + 0.1) * BIN_HZ
const LINE_SNR_DB = 25
/** The provisional window the harness gives the pipeline: a 2 s stay makes the line a candidate. */
const WINDOW_MS = 1_000
const REAL_HZ = 30_000

function withLine(seed: number, n: number): Iq {
	const iq = gaussianNoise(mulberry32(seed), n, SIGMA)
	return addInto(iq, tone(n, FS, LINE_HZ, toneAmp(LINE_SNR_DB)))
}

function harness(): Harness {
	const h = new Harness(
		{ format: "FLOAT32LE" },
		{ provisionalWindowMs: WINDOW_MS },
	)
	h.start()
	return h
}

const spurRanges = (h: Harness) =>
	h.of("block-summary").flatMap(e => e.summary.masks.spurRanges)

describe("stale check and receiver lines", () => {
	it("a strong unverified line under every centre discards nothing, and a burst 100 ms after the retune is tracked", () => {
		const h = harness()
		h.push(withLine(1, 40 * BLOCK), 8192) // 2 s: the line is a provisional line (on 100 % of 1 s)
		const retuneSample = h.sample
		h.pending({ epoch: 2, centreHz: CENTRE + 1e6 }) // timer, zero allowance
		// 1 s at the new centre: the line again, and a real 150 ms tone from 100 ms (blocks 2 to 5)
		const fresh = withLine(2, 20 * BLOCK)
		addInto(
			fresh,
			tone(3 * BLOCK, FS, REAL_HZ, EMISSION_AMP),
			Math.round(0.1 * FS),
		)
		h.push(fresh, 8192)
		// was 20 discards (1 s of 50 ms blocks); the harness feeds no old samples, so 0 is right
		expect(h.of("stale-discard")).toEqual([])
		const ends = h
			.of("block-summary")
			.filter(e => e.summary.epoch === 2)
			.map(e => e.summary.endSample)
		expect(ends).toHaveLength(20)
		expect(ends[0]).toBe(retuneSample + BLOCK)
		const opened = h
			.of("track-open")
			.filter(e => e.track.epoch === 2)
			.map(e => e.track)
		const real = opened.filter(
			t => Math.abs(t.centreHz - (CENTRE + 1e6 + REAL_HZ)) <= 1_000,
		)
		expect(real).toHaveLength(1)
		// opened within the first 300 ms of the new centre
		expect(real[0]!.startSample - retuneSample).toBeLessThan(0.3 * FS)
		// the line itself is tracked as a signal under both centres, never masked
		expect(
			opened.some(
				t => Math.abs(t.centreHz - (CENTRE + 1e6 + LINE_HZ)) <= 1_000,
			),
		).toBe(true)
		expect(spurRanges(h)).toEqual([])
	})

	it("a real emitter at the old bins is still stale-discarded beside the line", () => {
		const h = harness()
		// 2 s of line; the real tone on for its last 0.5 s only (50 % of the 1 s window, under the
		// 95 % a provisional line needs), so it is a track and no line candidate
		const before = withLine(3, 40 * BLOCK)
		addInto(before, tone(10 * BLOCK, FS, REAL_HZ, EMISSION_AMP), 30 * BLOCK)
		h.push(before, 8192)
		h.pending({ epoch: 2, centreHz: CENTRE + 1e6 })
		// 3 blocks of the old centre's samples still in flight (line and tone), then the new centre
		const stale = withLine(4, 3 * BLOCK)
		addInto(stale, tone(3 * BLOCK, FS, REAL_HZ, EMISSION_AMP))
		h.push(stale, 8192)
		h.push(withLine(5, 6 * BLOCK), 8192)
		const discards = h.of("stale-discard")
		expect(discards).toHaveLength(3)
		expect(discards.every(d => d.epoch === 2 && d.blocks === 1)).toBe(true)
		expect(
			h
				.tracks()
				.filter(
					t =>
						t.epoch === 2 &&
						Math.abs(t.centreHz - (CENTRE + 1e6 + REAL_HZ)) <= 1_000,
				),
		).toEqual([])
	})
})
