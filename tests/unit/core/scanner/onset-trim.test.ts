/**
 * The onset trim of a scanner analog file's head (onset-trim.ts): open-squelch static before the
 * carrier quiets is cut to at most 150 ms before the measured onset, never into it; a file that
 * opens on voice, or holds only static, is not cut; every file is faded in over 20 ms. All signals
 * are modelled (synthetic PCM at 8 kHz).
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	fadeIn,
	ONSET_BLOCK_SAMPLES,
	ONSET_DROP_DB,
	ONSET_FADE_SAMPLES,
	ONSET_HOLD_BLOCKS,
	ONSET_KEEP_SAMPLES,
	ONSET_MAX_SEARCH_SAMPLES,
	ONSET_MIN_STATIC_BLOCKS,
	ONSET_TRANSITION_BLOCKS,
	onsetSearchSamples,
	onsetTrim,
} from "../../../../src/core/scanner/channel/onset-trim.js"
import { mulberry32 } from "../../../mocks/scanner/signals.js"

const SEARCH = onsetSearchSamples(300)

/** Modelled open-squelch static: white noise near −8 dBFS. */
function staticPcm(n: number, seed = 1): Int16Array {
	const rng = mulberry32(seed)
	const out = new Int16Array(n)
	for (let i = 0; i < n; i++)
		out[i] = Math.round((rng() + rng() + rng() + rng() - 2) * 22_000)
	return out
}
/** Modelled quieted voice: 150 Hz pitch with harmonics to 900 Hz, a 4 Hz syllable envelope. */
function voicePcm(
	n: number,
	from = 0,
	pauseAt: number | null = null,
): Int16Array {
	const out = new Int16Array(n)
	for (let i = 0; i < n; i++) {
		const t = (from + i) / 8000
		if (pauseAt !== null && t >= pauseAt && t < pauseAt + 0.3) continue
		const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)
		let x = 0
		for (let k = 1; k <= 6; k++) x += Math.sin(2 * Math.PI * 150 * k * t) / k
		out[i] = Math.round(4_000 * env * x)
	}
	return out
}
const join = (...parts: Int16Array[]): Int16Array => {
	const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
	let o = 0
	for (const p of parts) {
		out.set(p, o)
		o += p.length
	}
	return out
}

describe("onset trim", () => {
	it("states its bounds: 20 ms blocks, 150 ms kept, 20 ms fade, 300 + 1 000 ms searched, 2 s at most", () => {
		expect(ONSET_BLOCK_SAMPLES).toBe(160)
		expect(ONSET_KEEP_SAMPLES).toBe(1200)
		expect(ONSET_FADE_SAMPLES).toBe(160)
		expect(SEARCH).toBe(10_400)
		expect(ONSET_MAX_SEARCH_SAMPLES).toBe(16_000)
		// At and past the search bound: a 1 000 ms pre-roll reaches it, a longer one stays at it.
		expect(onsetSearchSamples(1_000)).toBe(16_000)
		expect(onsetSearchSamples(10_000)).toBe(16_000)
		expect(onsetSearchSamples(999)).toBe(15_992)
		expect(onsetSearchSamples(Number.NaN)).toBe(8_000)
	})

	it("1.1 s of static then voice: cut to 150 ms before the onset", () => {
		const head = join(staticPcm(8_800), voicePcm(8_000))
		const t = onsetTrim(head, SEARCH)
		expect(t.onsetSamples).not.toBeNull()
		expect(Math.abs(t.onsetSamples! - 8_800)).toBeLessThanOrEqual(160)
		expect(t.cutSamples).toBe(t.onsetSamples! - ONSET_KEEP_SAMPLES)
	})

	it("an onset under 150 ms in: nothing is cut", () => {
		const head = join(staticPcm(960), voicePcm(12_000))
		expect(onsetTrim(head, SEARCH).cutSamples).toBe(0)
	})

	it("all static: no onset, no cut", () => {
		expect(onsetTrim(staticPcm(SEARCH), SEARCH)).toEqual({
			cutSamples: 0,
			onsetSamples: null,
		})
	})

	it("a voice that opens the file, with a pause in the window, loses nothing", () => {
		for (const from of [0, 1234, 8000]) {
			const head = voicePcm(SEARCH, from, 0.5)
			expect(onsetTrim(head, SEARCH).cutSamples).toBe(0)
		}
	})

	it("an onset past the searched window is not found", () => {
		const head = join(staticPcm(SEARCH), voicePcm(4_000))
		expect(onsetTrim(head, SEARCH).cutSamples).toBe(0)
	})

	it("too little audio: no cut", () => {
		expect(onsetTrim(new Int16Array(0), SEARCH).cutSamples).toBe(0)
		expect(onsetTrim(staticPcm(1_000), SEARCH).cutSamples).toBe(0)
	})

	it("fadeIn: a raised cosine over 20 ms, 0 first, the input unchanged", () => {
		const pcm = new Int16Array(400).fill(10_000)
		const out = fadeIn(pcm)
		expect(out[0]).toBe(0)
		expect(out[80]).toBe(5_000)
		expect(out[159]).toBeGreaterThan(9_990)
		expect(out[160]).toBe(10_000)
		expect(pcm[0]).toBe(10_000)
		for (let i = 1; i < 160; i++)
			expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!)
		expect(fadeIn(new Int16Array(10).fill(100))[0]).toBe(0)
	})

	// Feature: noise-recordings, Property 3: onset trim bounds
	// Validates: Requirements 3
	it("property: 0 <= cut <= search window, never past onset - 150 ms, and the cut start is onset-relative", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 14_000 }),
				fc.integer({ min: 0, max: 12_000 }),
				fc.integer({ min: 1, max: 1_000 }),
				fc.integer({ min: 0, max: 3_000 }),
				(staticN, voiceN, seed, preRoll) => {
					const search = onsetSearchSamples(preRoll)
					const head = join(staticPcm(staticN, seed), voicePcm(voiceN))
					const t = onsetTrim(head, search)
					expect(t.cutSamples).toBeGreaterThanOrEqual(0)
					expect(t.cutSamples).toBeLessThanOrEqual(search)
					if (t.onsetSamples === null) expect(t.cutSamples).toBe(0)
					else
						expect(t.cutSamples).toBeLessThanOrEqual(
							Math.max(0, t.onsetSamples - ONSET_KEEP_SAMPLES),
						)
					// Never into the voice: the cut stays at least 150 ms before where it begins
					// (or nothing is cut).
					if (t.cutSamples > 0)
						expect(t.cutSamples).toBeLessThanOrEqual(
							staticN - ONSET_KEEP_SAMPLES + 160,
						)
				},
			),
			{ numRuns: 150 },
		)
	})

	describe("block bounds (modelled block levels)", () => {
		/**
		 * One 20 ms block per level (dB under the static's level): an alternating ±A pattern, whose
		 * second difference is ±4A each sample, so each block's level is exact (the sign keeps
		 * alternating across blocks: only a block's first two samples see its neighbour).
		 */
		const STATIC_A = 8_000
		function blocks(levelsDb: readonly number[]): Int16Array {
			const out = new Int16Array(levelsDb.length * ONSET_BLOCK_SAMPLES)
			for (const [b, db] of levelsDb.entries()) {
				const a = Math.round(STATIC_A * 10 ** (-db / 20))
				for (let i = 0; i < ONSET_BLOCK_SAMPLES; i++) {
					const at = b * ONSET_BLOCK_SAMPLES + i
					out[at] = at % 2 === 0 ? a : -a
				}
			}
			return out
		}
		const run = (n: number, db: number): number[] => Array<number>(n).fill(db)
		const QUIET = 40
		const MID = 6
		const trim = (levels: number[]) =>
			onsetTrim(blocks(levels), levels.length * ONSET_BLOCK_SAMPLES)

		it("states them: 10 dB drop, 5 blocks held, a 10-block static prefix, 10 blocks of transition", () => {
			expect(ONSET_DROP_DB).toBe(10)
			expect(ONSET_HOLD_BLOCKS).toBe(5)
			expect(ONSET_MIN_STATIC_BLOCKS).toBe(10)
			expect(ONSET_TRANSITION_BLOCKS).toBe(10)
		})

		it("static prefix: 9 blocks no cut, 10 blocks cut", () => {
			const nine = trim([...run(9, 0), ...run(40, QUIET)])
			expect(nine).toEqual({ cutSamples: 0, onsetSamples: 9 * 160 })
			const ten = trim([...run(10, 0), ...run(40, QUIET)])
			expect(ten).toEqual({
				cutSamples: 10 * 160 - ONSET_KEEP_SAMPLES,
				onsetSamples: 10 * 160,
			})
		})

		it("the quieting held: 4 blocks no onset, 5 blocks an onset", () => {
			expect(trim([...run(12, 0), ...run(4, QUIET), ...run(40, 0)])).toEqual({
				cutSamples: 0,
				onsetSamples: null,
			})
			expect(trim([...run(12, 0), ...run(5, QUIET), ...run(40, 0)])).toEqual({
				cutSamples: 12 * 160 - ONSET_KEEP_SAMPLES,
				onsetSamples: 12 * 160,
			})
		})

		it("transition after the static prefix: 10 blocks cut (never past the prefix), 11 blocks no cut", () => {
			const ten = trim([...run(12, 0), ...run(10, MID), ...run(40, QUIET)])
			// onset − 150 ms = 22 × 160 − 1 200 = 2 320 > the prefix (1 920): the prefix bounds it.
			expect(ten).toEqual({ cutSamples: 12 * 160, onsetSamples: 22 * 160 })
			const eleven = trim([...run(12, 0), ...run(11, MID), ...run(40, QUIET)])
			expect(eleven).toEqual({ cutSamples: 0, onsetSamples: 23 * 160 })
		})

		it("weak voice under 10 dB below the static (9.5 dB): no onset, no cut", () => {
			expect(trim([...run(12, 0), ...run(60, 9.5)])).toEqual({
				cutSamples: 0,
				onsetSamples: null,
			})
			// 10.5 dB under it is a quieted block (the bound is 10 dB).
			expect(trim([...run(12, 0), ...run(60, 10.5)]).onsetSamples).toBe(
				12 * 160,
			)
		})
	})

	it("RESIDUAL LIMIT: a static-level fricative (250 ms of HF noise) right before the voiced onset keeps only its last 150 ms", () => {
		// A fricative with the static's high-frequency level is static to this measure: the 150 ms
		// kept before the onset is the static-level stretch closest to it, so 100 ms of the
		// fricative's start is cut. Frozen so a rule change that moves it shows here (SCANNER.md).
		const fricative = 2_000
		const head = join(
			staticPcm(6_400),
			staticPcm(fricative, 7),
			voicePcm(8_000),
		)
		const t = onsetTrim(head, SEARCH)
		expect(t.onsetSamples).not.toBeNull()
		expect(Math.abs(t.onsetSamples! - 8_400)).toBeLessThanOrEqual(160)
		expect(t.cutSamples).toBe(t.onsetSamples! - ONSET_KEEP_SAMPLES)
		const fricativeCut = t.cutSamples - 6_400
		expect(fricativeCut).toBeGreaterThan(0)
		expect(fricativeCut).toBeLessThanOrEqual(
			fricative - ONSET_KEEP_SAMPLES + 160,
		)
	})
})
