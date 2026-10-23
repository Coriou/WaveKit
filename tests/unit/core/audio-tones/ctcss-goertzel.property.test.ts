/**
 * The CTCSS bank evaluates several tones per Goertzel pass. Each tone must keep its own
 * operations in the original order, so every block's powers are bit-identical to a plain
 * one-tone-per-pass Goertzel over the block's 4 000 samples.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { CTCSS_HZ, CtcssBank } from "../../../../src/core/audio-tones/ctcss.js"

const RATE_HZ = 8_000
const BLOCK_SAMPLES = 4_000

/** One tone per pass, as the bank computed it before the multi-tone pass. */
function referencePowers(block: Float64Array): Float64Array {
	const out = new Float64Array(CTCSS_HZ.length)
	for (let tone = 0; tone < CTCSS_HZ.length; tone++) {
		const coeff = 2 * Math.cos((2 * Math.PI * (CTCSS_HZ[tone] ?? 0)) / RATE_HZ)
		let s1 = 0
		let s2 = 0
		for (let n = 0; n < BLOCK_SAMPLES; n++) {
			const s0 = (block[n] ?? 0) + coeff * s1 - s2
			s2 = s1
			s1 = s0
		}
		const power = s1 * s1 + s2 * s2 - coeff * s1 * s2
		out[tone] = power > 0 ? power : 0
	}
	return out
}

function signal(
	samples: number,
	toneIndex: number,
	amplitude: number,
	noise: number,
	seed: number,
): Float64Array {
	const out = new Float64Array(samples)
	const hz = CTCSS_HZ[toneIndex] ?? 100
	let state = seed >>> 0 || 1
	for (let i = 0; i < samples; i++) {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
		const r = state / 4_294_967_296 - 0.5
		out[i] =
			amplitude * Math.sin((2 * Math.PI * hz * i) / RATE_HZ) +
			noise * r +
			0.3 * Math.sin((2 * Math.PI * 700 * i) / RATE_HZ)
	}
	return out
}

describe("CtcssBank multi-tone Goertzel pass", () => {
	it("gives bit-identical block powers to one tone per pass", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: CTCSS_HZ.length - 1 }),
				fc.double({ min: 0, max: 0.5, noNaN: true }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.integer({ min: 1, max: 2 ** 31 - 1 }),
				(toneIndex, amplitude, noise, seed) => {
					const samples = signal(9_000, toneIndex, amplitude, noise, seed)
					const bank = new CtcssBank()
					const powers = (bank as unknown as { powers: Float64Array }).powers
					let blocks = 0
					for (let i = 0; i < samples.length; i++) {
						bank.pushSample(samples[i] ?? 0)
						if (bank.blockCount() === blocks) continue
						blocks = bank.blockCount()
						const block = samples.subarray(i + 1 - BLOCK_SAMPLES, i + 1)
						expect(Array.from(powers)).toEqual(
							Array.from(referencePowers(block)),
						)
					}
					expect(blocks).toBe(3)
				},
			),
			{ numRuns: 100 },
		)
	})
})
