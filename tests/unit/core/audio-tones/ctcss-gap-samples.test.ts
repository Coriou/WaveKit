/**
 * CtcssBank.pushGapSample: a source gap's fill is analysed exactly as pushSample would (blocks,
 * votes and the answer unchanged), but any analysis block holding one such sample is never quiet,
 * and the samples are counted (gapSampleCount). Blocks are 4 000 samples ending every 2 000:
 * block j (0-based) holds samples 2 000 j + 1 .. 2 000 j + 4 000 (1-based). Modelled audio only.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { CtcssBank } from "../../../../src/core/audio-tones/ctcss.js"

const RATE = 8000
const N = 24_000
/** Quiet ceilings of 0: silence is quiet, anything else is not. */
const ZERO = { bandMax: 0, rawMax: 0 }

/** Silence with the 1-based samples in `gaps` pushed as gap fill. */
function silenceWithGaps(gaps: ReadonlySet<number>, n = N) {
	const bank = new CtcssBank(ZERO)
	for (let i = 1; i <= n; i++) {
		if (gaps.has(i)) bank.pushGapSample(0)
		else bank.pushSample(0)
	}
	return bank
}

/** Blocks of an `n`-sample run that hold 1-based sample `at`. */
function blocksHolding(at: number, n = N): number {
	let count = 0
	for (let j = 0; 2000 * j + 4000 <= n; j++)
		if (at >= 2000 * j + 1 && at <= 2000 * j + 4000) count++
	return count
}

describe("CtcssBank gap samples", () => {
	it("silence with no gap: all 11 blocks quiet, no gap sample", () => {
		const bank = silenceWithGaps(new Set())
		expect(bank.blockCount()).toBe(11)
		expect(bank.quietBlockCount()).toBe(11)
		expect(bank.gapSampleCount()).toBe(0)
	})

	it.each([
		[1, 10],
		[2000, 10],
		[2001, 9],
		[4000, 9],
		[4001, 9],
		[N - 2000, 9],
		[N - 1999, 10],
		[N, 10],
	])(
		"one gap sample at %i: the blocks holding it are loud (%i quiet)",
		(at, quiet) => {
			const bank = silenceWithGaps(new Set([at]))
			expect(bank.blockCount()).toBe(11)
			expect(bank.quietBlockCount()).toBe(quiet)
			expect(quiet).toBe(11 - blocksHolding(at))
			expect(bank.gapSampleCount()).toBe(1)
		},
	)

	// Feature: recording tone gaps, Property 1: a block holding any gap sample is never quiet
	// Validates: Requirements M1
	it("any set of gap samples: quiet blocks are exactly the blocks holding none", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer({ min: 1, max: N }), {
					minLength: 0,
					maxLength: 6,
				}),
				gaps => {
					const bank = silenceWithGaps(new Set(gaps))
					let loud = 0
					for (let j = 0; j < 11; j++) {
						const first = 2000 * j + 1
						if (gaps.some(g => g >= first && g < first + 4000)) loud++
					}
					expect(bank.quietBlockCount()).toBe(11 - loud)
					expect(bank.gapSampleCount()).toBe(gaps.length)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("gap samples are analysed as audio: the same blocks, votes and answer", () => {
		const tone = Array.from(
			{ length: N },
			(_, i) => 0.1 * Math.sin((2 * Math.PI * 100 * i) / RATE),
		)
		const plain = new CtcssBank(ZERO)
		const gap = new CtcssBank(ZERO)
		for (const x of tone) plain.pushSample(x)
		for (const x of tone) gap.pushGapSample(x)
		expect(gap.result()).toBe(100)
		expect(gap.result()).toBe(plain.result())
		expect(gap.blockCount()).toBe(plain.blockCount())
		expect(gap.votedBlockCount()).toBe(plain.votedBlockCount())
		expect(gap.partialBlockCount()).toBe(plain.partialBlockCount())
		expect(gap.sampleCount()).toBe(N)
		expect(gap.gapSampleCount()).toBe(N)
	})

	it("reset clears the gap count and the gap mark", () => {
		const bank = silenceWithGaps(new Set([N]))
		bank.reset()
		expect(bank.gapSampleCount()).toBe(0)
		for (let i = 0; i < N; i++) bank.pushSample(0)
		expect(bank.quietBlockCount()).toBe(11)
	})
})
