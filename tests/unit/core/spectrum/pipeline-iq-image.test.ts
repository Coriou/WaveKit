import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	tone,
} from "../../../mocks/scanner/signals.js"
import type { Iq } from "../../../mocks/scanner/signals.js"
import { CENTRE, FS, Harness, yieldToRpc } from "./pipeline-harness.js"

const SIGMA = 0.001
const N_SAMPLES = Math.round(0.4 * FS)
const AMP = 0.5

/** An IQ-imbalance image: the conjugate of the signal, `rejectionDb` down (mirrored about the LO). */
function mirror(sig: Iq, rejectionDb: number): Iq {
	const g = 10 ** (-rejectionDb / 20)
	return { re: sig.re.map(v => v * g), im: sig.im.map(v => -v * g) }
}
function run(seed: number, parts: Iq[]): Harness {
	const iq = gaussianNoise(mulberry32(seed), N_SAMPLES, SIGMA)
	for (const p of parts) addInto(iq, p)
	const h = new Harness({ format: "FLOAT32LE" })
	h.start({ feed: false })
	h.push(iq, 8192)
	return h
}
const at = (h: Harness, hz: number) =>
	h.tracks().filter(t => Math.abs(t.centreHz - (CENTRE + hz)) <= 1000)
const offsetArb = fc
	.tuple(fc.boolean(), fc.integer({ min: 150, max: 900 }))
	.map(([neg, k]) => (neg ? -1 : 1) * k * 100)

describe("IQ images in the pipeline", () => {
	it("flags a strong emission's mirror 22–62 dB down in every snapshot and leaves independent emitters alone", async () => {
		// Feature: signal-discovery-scanner, Property 19: No IQ-image ghosts
		// Validates: spec § 4.9
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 0x7fffffff }),
				offsetArb,
				fc.integer({ min: 22, max: 62 }),
				fc.integer({ min: 0, max: 15 }),
				fc.integer({ min: -3, max: 3 }),
				async (seed, x, rejection, independentDb, nudge) => {
					await yieldToRpc()
					const strong = tone(N_SAMPLES, FS, x, AMP)
					const withImage = run(seed, [strong, mirror(strong, rejection)])
					const images = at(withImage, -x)
					expect(images.length).toBeGreaterThan(0)
					expect(images.every(t => t.flags.iqImage)).toBe(true)
					expect(at(withImage, x).every(t => !t.flags.iqImage)).toBe(true)

					const other = tone(
						N_SAMPLES,
						FS,
						-x + nudge * 100,
						AMP * 10 ** (-independentDb / 20),
					)
					const independent = run(seed, [strong, other])
					expect(independent.tracks().every(t => !t.flags.iqImage)).toBe(true)
				},
			),
			{ numRuns: 100, seed: 19_001 }, // fixed (spec § 13): pipeline noise drives the property
		)
	}, 120_000)
})
