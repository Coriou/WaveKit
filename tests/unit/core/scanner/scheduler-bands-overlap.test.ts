/**
 * bandsOverlap: whether two tracks read as one signal's: their occupied bands (centre ± obw / 2)
 * overlap or touch, and their centres lie under JOINED_TRACKS_BELOW_HZ (10 000 Hz) apart. It tells
 * a voice track that took in a steady line beside it (the line's track and the voice's read as two
 * overlapping tracks) from a neighbour on another channel, so a check hearing the voice during a
 * hold of the line commits the visit to nothing (commitVoiceTrack), and tracks one 12.5 kHz raster
 * step apart are never joined however wide they read.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	bandsOverlap,
	JOINED_TRACKS_BELOW_HZ,
} from "../../../../src/core/scanner/scheduler.js"

const band = (centreHz: number, obwHz: number) => ({ centreHz, obwHz })

describe("bandsOverlap", () => {
	it("a 16 kHz voice track 9.8 kHz from a 7 kHz line overlaps it (8000 + 3500 = 11 500 Hz, 9800 < 10 000)", () => {
		expect(
			bandsOverlap(band(100_000_000, 16_000), band(100_009_800, 7_000)),
		).toBe(true)
	})

	it("at the half-width bound (centres 6000 Hz apart for 5 and 7 kHz tracks) the bands touch; past it (6001 Hz) they do not", () => {
		expect(
			bandsOverlap(band(100_000_000, 5_000), band(100_006_000, 7_000)),
		).toBe(true)
		expect(
			bandsOverlap(band(100_000_000, 5_000), band(100_006_001, 7_000)),
		).toBe(false)
	})

	it("centres 9999 Hz apart, bands overlapping, are joined; at JOINED_TRACKS_BELOW_HZ (10 000 Hz) they are not", () => {
		expect(JOINED_TRACKS_BELOW_HZ).toBe(10_000)
		expect(
			bandsOverlap(band(100_000_000, 16_000), band(100_009_999, 7_000)),
		).toBe(true)
		expect(
			bandsOverlap(band(100_000_000, 16_000), band(100_010_000, 7_000)),
		).toBe(false)
	})

	it("two 11 kHz tracks on adjacent 12.5 kHz channels do not overlap (5500 + 5500 = 11 000 Hz < 12 500 Hz)", () => {
		expect(
			bandsOverlap(band(100_000_000, 11_000), band(100_012_500, 11_000)),
		).toBe(false)
	})

	it("a 16 kHz ID and an 11 kHz neighbour one 12.5 kHz step apart are not joined, though their bands overlap (8000 + 5500 = 13 500 Hz)", () => {
		expect(
			bandsOverlap(band(100_000_000, 16_000), band(100_012_500, 11_000)),
		).toBe(false)
		expect(
			bandsOverlap(band(100_000_000, 16_000), band(99_987_500, 11_000)),
		).toBe(false)
		// Nor two 40 kHz tracks a step apart.
		expect(
			bandsOverlap(band(100_000_000, 40_000), band(100_012_500, 40_000)),
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

	// Feature: scanner, Property: band overlap is symmetric, matches the half-width sum and never
	// joins centres a 12.5 kHz raster step apart
	it("is symmetric and true exactly when the centres lie within the sum of the half widths and under 10 000 Hz apart", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 50_000 }),
				fc.integer({ min: 0, max: 50_000 }),
				fc.integer({ min: -100_000, max: 100_000 }),
				(obwA, obwB, offset) => {
					const a = band(100_000_000, obwA)
					const b = band(100_000_000 + offset, obwB)
					const expected =
						Math.abs(offset) <= obwA / 2 + obwB / 2 &&
						Math.abs(offset) < JOINED_TRACKS_BELOW_HZ
					return (
						bandsOverlap(a, b) === expected && bandsOverlap(b, a) === expected
					)
				},
			),
			{ numRuns: 200 },
		)
	})
})
