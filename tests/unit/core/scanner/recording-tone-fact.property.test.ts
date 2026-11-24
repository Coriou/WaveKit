/**
 * toneFactOf (recording-facts.ts) over arbitrary detector coverage: "No tone heard" (null) only
 * when both detectors analysed their minimums and heard nothing tone-like on a file not kept for
 * its own tone; a settled CTCSS tone always wins; a gated DCS code beats an unsettled CTCSS.
 * Modelled counters only.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DCS_MEASURED_MIN_SAMPLES,
	DCS_PARTIAL_WORDS,
	TONE_MEASURED_MIN_BLOCKS,
	toneFactOf,
} from "../../../../src/core/scanner/store/recording-facts.js"

const count = fc.oneof(
	fc.integer({ min: 0, max: 100_000 }),
	fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, -1),
)
const dcs = fc.oneof(
	fc.constant(null),
	fc.record({
		code: fc.constantFrom("023", "047", "754", "024", "9xx"),
		polarity: fc.constantFrom("normal", "inverted", "up"),
	}),
)
const coverage = fc.record({
	ctcssBlocks: count,
	votedBlocks: count,
	partialBlocks: count,
	dcsSamples: count,
	dcsChain: count,
	dcs,
	ownTone: fc.boolean(),
})

describe("toneFactOf properties", () => {
	// Feature: recording facts tone, Property 1: null only from enough analysed, empty evidence
	// Validates: Requirements R2
	it("null implies both minimums, no tone-like evidence and no own-tone keep", () => {
		fc.assert(
			fc.property(coverage, c => {
				const fact = toneFactOf(null, c)
				if (fact.tone !== null) return
				expect(c.ctcssBlocks).toBeGreaterThanOrEqual(TONE_MEASURED_MIN_BLOCKS)
				expect(c.dcsSamples).toBeGreaterThanOrEqual(DCS_MEASURED_MIN_SAMPLES)
				expect(Number.isFinite(c.ctcssBlocks)).toBe(true)
				expect(Number.isFinite(c.dcsSamples)).toBe(true)
				expect(c.votedBlocks).toBe(0)
				expect(c.partialBlocks).toBe(0)
				expect(c.dcsChain).toBeLessThan(DCS_PARTIAL_WORDS)
				expect(c.ownTone).toBe(false)
			}),
			{ numRuns: 300 },
		)
	})

	// Feature: recording facts tone, Property 2: precedence of the measured tones
	// Validates: Requirements R1
	it("a settled CTCSS always wins; a DCS answer is a standard code with a known polarity", () => {
		fc.assert(
			fc.property(coverage, fc.constantFrom(67, 88.5, 254.1), (c, hz) => {
				expect(toneFactOf(hz, c)).toEqual({ tone: { kind: "ctcss", hz } })
				const fact = toneFactOf(null, c)
				if (fact.tone?.kind !== "dcs") return
				expect(c.dcsSamples).toBeGreaterThanOrEqual(DCS_MEASURED_MIN_SAMPLES)
				expect(["023", "047", "754"]).toContain(fact.tone.code)
				expect(c.dcs).toEqual({
					code: fact.tone.code,
					polarity: (fact.tone as { polarity?: string }).polarity,
				})
			}),
			{ numRuns: 300 },
		)
	})
})
