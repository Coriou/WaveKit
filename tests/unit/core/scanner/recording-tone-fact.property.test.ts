/**
 * toneFactOf (recording-facts.ts) over arbitrary detector coverage: "No tone heard" (null) only
 * when both detectors analysed their minimums and heard nothing tone-like on a file not kept for
 * its own tone; a gated DCS code always wins; a settled CTCSS tone wins otherwise.
 * Modelled counters only.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DCS_LONE_HIT_SECONDS,
	DCS_LONE_HITS_MIN,
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
	dcsLoneHits: count,
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
				// Lone DCS hits at chance only: under the minimum or under one per 3 s analysed.
				expect(Number.isFinite(c.dcsLoneHits)).toBe(true)
				expect(
					c.dcsLoneHits < DCS_LONE_HITS_MIN ||
						c.dcsLoneHits * DCS_LONE_HIT_SECONDS * 8000 < c.dcsSamples,
				).toBe(true)
				expect(c.ownTone).toBe(false)
			}),
			{ numRuns: 300 },
		)
	})

	// Feature: recording facts tone, Property 2: precedence of the measured tones
	// Validates: Requirements R1
	it("a gated DCS code always wins, a settled CTCSS otherwise; a DCS answer is a standard code with a known polarity", () => {
		fc.assert(
			fc.property(coverage, fc.constantFrom(67, 88.5, 254.1), (c, hz) => {
				const withTone = toneFactOf(hz, c)
				const noTone = toneFactOf(null, c)
				if (noTone.tone?.kind === "dcs") expect(withTone).toEqual(noTone)
				else expect(withTone).toEqual({ tone: { kind: "ctcss", hz } })
				const fact = noTone
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
