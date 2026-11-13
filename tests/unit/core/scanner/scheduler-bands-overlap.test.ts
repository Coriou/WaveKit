/**
 * bandsOverlap: whether two tracks' occupied bands (centre ± obw / 2) overlap or touch. It tells a
 * voice track that took in a steady line beside it (the line's track and the voice's read as two
 * overlapping tracks) from a neighbour on another channel, so a check hearing the voice during a
 * hold of the line commits the visit to nothing (commitVoiceTrack).
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { bandsOverlap } from "../../../../src/core/scanner/scheduler.js"

const band = (centreHz: number, obwHz: number) => ({ centreHz, obwHz })

describe("bandsOverlap", () => {
	it("a 16 kHz voice track 9.8 kHz from a 7 kHz line overlaps it (8000 + 3500 = 11 500 Hz)", () => {
		expect(
			bandsOverlap(band(100_000_000, 16_000), band(100_009_800, 7_000)),
		).toBe(true)
	})

	it("at the bound (centres 11 500 Hz apart) the bands touch; past it (11 501 Hz) they do not", () => {
		expect(
			bandsOverlap(band(100_000_000, 16_000), band(100_011_500, 7_000)),
		).toBe(true)
		expect(
			bandsOverlap(band(100_000_000, 16_000), band(100_011_501, 7_000)),
		).toBe(false)
	})

	it("two 11 kHz tracks on adjacent 12.5 kHz channels do not overlap (5500 + 5500 = 11 000 Hz < 12 500 Hz)", () => {
		expect(
			bandsOverlap(band(100_000_000, 11_000), band(100_012_500, 11_000)),
		).toBe(false)
	})

	it("a non-finite centre or width, or a negative width, is never an overlap", () => {
		expect(
			bandsOverlap(band(Number.NaN, 7_000), band(100_000_000, 7_000)),
		).toBe(false)
		expect(
			bandsOverlap(band(100_000_000, Infinity), band(100_000_000, 7_000)),
		).toBe(false)
		expect(bandsOverlap(band(100_000_000, -1), band(100_000_000, 7_000))).toBe(
			false,
		)
	})

	// Feature: scanner, Property: band overlap is symmetric and matches the half-width sum
	it("is symmetric and true exactly when the centres lie within the sum of the half widths", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 50_000 }),
				fc.integer({ min: 0, max: 50_000 }),
				fc.integer({ min: -100_000, max: 100_000 }),
				(obwA, obwB, offset) => {
					const a = band(100_000_000, obwA)
					const b = band(100_000_000 + offset, obwB)
					const expected = Math.abs(offset) <= obwA / 2 + obwB / 2
					return (
						bandsOverlap(a, b) === expected && bandsOverlap(b, a) === expected
					)
				},
			),
			{ numRuns: 200 },
		)
	})
})
