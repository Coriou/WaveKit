import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { flagIqImages } from "../../../../../src/core/spectrum/emissions/iq-image.js"
import type {
	ImageCandidate,
	IqImageOptions,
} from "../../../../../src/core/spectrum/emissions/iq-image.js"

const C = 446_100_000
const OPTS: IqImageOptions = {
	rbwHz: 1000,
	toleranceHz: 1000,
	minRejectionDb: 20,
	maxRejectionDb: 65,
	dcGuardHz: 2000,
}
const cand = (
	trackId: string,
	offsetHz: number,
	obwHz: number,
	peakDbfs: number,
): ImageCandidate => ({ trackId, centreHz: C + offsetHz, obwHz, peakDbfs })

describe("flagIqImages", () => {
	it("flags mirrors 20–65 dB down, never independent emitters within 20 dB, never inside the DC guard", () => {
		// Feature: signal-discovery-scanner, Property 19: No IQ-image ghosts
		// Validates: spec § 4.9
		fc.assert(
			fc.property(
				fc.integer({ min: 3000, max: 100_000 }),
				fc.boolean(),
				fc.integer({ min: 1000, max: 16_000 }),
				fc.double({ min: -40, max: -5, noNaN: true }),
				fc.double({ min: 20.5, max: 64.5, noNaN: true }),
				fc.integer({ min: -400, max: 400 }),
				fc.double({ min: 0.8, max: 1.2, noNaN: true }),
				fc.double({ min: 0, max: 19.5, noNaN: true }),
				fc.integer({ min: -2000, max: 2000 }),
				(
					off,
					positive,
					obw,
					peak,
					rejection,
					jitter,
					obwScale,
					independentDb,
					dcOffset,
				) => {
					const x = positive ? off : -off
					const strong = cand("a", x, obw, peak)
					const mirror = cand(
						"b",
						-x + jitter,
						obw * obwScale,
						peak - rejection,
					)
					expect(flagIqImages([strong, mirror], C, OPTS)).toEqual(
						new Set(["b"]),
					)
					const independent = cand(
						"c",
						-x + jitter,
						obw * obwScale,
						peak - independentDb,
					)
					expect(flagIqImages([strong, independent], C, OPTS).size).toBe(0)
					const dcA = cand("d", dcOffset, obw, peak)
					const dcB = cand("e", -dcOffset, obw, peak - rejection)
					expect(flagIqImages([dcA, dcB], C, OPTS).size).toBe(0)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("rejects pairs outside the rejection window, with dissimilar OBW, or off the mirror point", () => {
		const a = cand("a", 30_000, 9000, -10)
		expect(flagIqImages([a, cand("b", -30_000, 9000, -80)], C, OPTS).size).toBe(
			0,
		) // 70 dB down
		expect(
			flagIqImages([a, cand("b", -30_000, 18_000, -40)], C, OPTS).size,
		).toBe(0) // twice as wide
		expect(flagIqImages([a, cand("b", -32_500, 9000, -40)], C, OPTS).size).toBe(
			0,
		) // 2.5 kHz off the mirror
		expect(flagIqImages([a, cand("b", -30_000, 9000, -40)], C, OPTS)).toEqual(
			new Set(["b"]),
		)
	})

	it("uses max(RBW, tolerance) and allows narrow tracks a 2-RBW OBW slack", () => {
		const tone = cand("a", 50_000, 1000, -6)
		expect(
			flagIqImages([tone, cand("b", -50_900, 2500, -50)], C, OPTS),
		).toEqual(new Set(["b"]))
		expect(
			flagIqImages([tone, cand("b", -51_200, 2500, -50)], C, OPTS).size,
		).toBe(0)
	})
})
