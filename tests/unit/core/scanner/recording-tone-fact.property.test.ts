/**
 * toneFactOf (recording-facts.ts) over arbitrary detector coverage, checked by invariants rather
 * than by recomputing its rule: tone-like evidence never reads "No tone heard" (null); more
 * evidence or more loud blocks never turn "not determined" into null and more quiet blocks never
 * turn null into "not determined"; null always has at most 2 loud blocks; a gated DCS code always wins, a settled CTCSS tone otherwise; and a table of
 * rows written out by hand (the oracle) agrees with it. Modelled counters only.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { toneFactOf } from "../../../../src/core/scanner/store/recording-facts.js"
import type { ToneCoverage } from "../../../../src/core/scanner/store/recording-facts.js"

const count = fc.oneof(
	fc.integer({ min: 0, max: 100_000 }),
	fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, -1),
)
const small = fc.integer({ min: 0, max: 40 })
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
	quietBlocks: count,
	dcsSamples: count,
	dcsChain: count,
	dcsLoneHits: count,
	dcsAnyChain: count,
	dcs,
	ownTone: fc.boolean(),
})
/** Coverage that often lands near the minimums, so null and absent both occur. */
const nearMinimums = fc.record({
	ctcssBlocks: fc.integer({ min: 0, max: 30 }),
	votedBlocks: fc.integer({ min: 0, max: 2 }),
	partialBlocks: fc.integer({ min: 0, max: 2 }),
	quietBlocks: fc.integer({ min: 0, max: 30 }),
	dcsSamples: fc.integer({ min: 0, max: 30 * 8000 }),
	dcsChain: fc.integer({ min: 0, max: 3 }),
	dcsLoneHits: fc.integer({ min: 0, max: 4 }),
	dcsAnyChain: fc.integer({ min: 0, max: 3 }),
	dcs: fc.constant(null),
	ownTone: fc.boolean(),
})

const isNull = (c: ToneCoverage) => toneFactOf(null, c).tone === null

describe("toneFactOf properties", () => {
	// Feature: recording facts tone, Property 1: tone-like evidence never reads null
	// Validates: Requirements R2
	it("a voted or leaned block, an own-tone keep, gap fill or a two-word DCS chain never reads null", () => {
		fc.assert(
			fc.property(
				coverage,
				fc.constantFrom(
					"votedBlocks",
					"partialBlocks",
					"dcsChain",
					"dcsAnyChain",
					"ownTone",
					"gapSamples",
				),
				fc.integer({ min: 1, max: 1000 }),
				(c, field, n) => {
					const evidence =
						field === "ownTone"
							? { ...c, ownTone: true }
							: field === "dcsChain" || field === "dcsAnyChain"
								? { ...c, [field]: 1 + n }
								: { ...c, [field]: n }
					expect(isNull(evidence)).toBe(false)
				},
			),
			{ numRuns: 300 },
		)
	})

	// Feature: recording facts tone, Property 2: monotonicity of evidence and of quiet coverage
	// Validates: Requirements R2
	it("more evidence never makes null; more quiet blocks never undo null", () => {
		fc.assert(
			fc.property(
				nearMinimums,
				small,
				fc.constantFrom(
					"votedBlocks",
					"partialBlocks",
					"dcsChain",
					"dcsAnyChain",
					"dcsLoneHits",
				),
				(c, more, field) => {
					const raised = { ...c, [field]: c[field] + more }
					if (isNull(raised)) expect(isNull(c)).toBe(true)
					// Quiet blocks are counted among the bank's blocks: raise both together.
					const quieter = {
						...c,
						quietBlocks: c.quietBlocks + more,
						ctcssBlocks: c.ctcssBlocks + more,
					}
					if (isNull(c)) expect(isNull(quieter)).toBe(true)
					// More loud blocks (blocks raised, quiet ones not) never make null.
					const louder = { ...c, ctcssBlocks: c.ctcssBlocks + more }
					if (c.quietBlocks <= c.ctcssBlocks && isNull(louder))
						expect(isNull(c)).toBe(true)
				},
			),
			{ numRuns: 300 },
		)
	})

	// Feature: recording facts tone, Property 5: null needs at most 2 loud blocks
	// Validates: Requirements R2
	it("null only with at least 10 quiet blocks and at most 2 loud ones, whatever the length", () => {
		fc.assert(
			fc.property(fc.oneof(coverage, nearMinimums), c => {
				if (!isNull(c)) return
				expect(c.quietBlocks).toBeGreaterThanOrEqual(10)
				expect(c.quietBlocks).toBeLessThanOrEqual(c.ctcssBlocks)
				expect(c.ctcssBlocks - c.quietBlocks).toBeLessThanOrEqual(2)
			}),
			{ numRuns: 300 },
		)
	})

	// Feature: recording facts tone, Property 3: precedence of the measured tones
	// Validates: Requirements R1
	it("a gated DCS code always wins, a settled CTCSS otherwise; a DCS answer is a standard code with a known polarity", () => {
		fc.assert(
			fc.property(coverage, fc.constantFrom(67, 88.5, 254.1), (c, hz) => {
				const withTone = toneFactOf(hz, c)
				const noTone = toneFactOf(null, c)
				if (noTone.tone?.kind === "dcs") expect(withTone).toEqual(noTone)
				else expect(withTone).toEqual({ tone: { kind: "ctcss", hz } })
				if (noTone.tone?.kind !== "dcs") return
				expect(["023", "047", "754"]).toContain(noTone.tone.code)
				expect(c.dcs).toEqual({
					code: noTone.tone.code,
					polarity: noTone.tone.polarity,
				})
			}),
			{ numRuns: 300 },
		)
	})

	// Feature: recording facts tone, Property 4: rows written out by hand agree
	// Validates: Requirements R2
	it("hand-written rows: null only with 10 quiet blocks, few loud ones, 6 000 DCS samples and nothing tone-like", () => {
		/** A 6 s untoned carrier: 21 quiet blocks of 23, its keying edge and tail loud: "No tone heard". */
		const base: ToneCoverage = {
			ctcssBlocks: 23,
			votedBlocks: 0,
			partialBlocks: 0,
			quietBlocks: 21,
			dcsSamples: 48_000,
			dcsChain: 1,
			dcsLoneHits: 1,
			dcsAnyChain: 1,
			dcs: null,
			ownTone: false,
		}
		const rows: [string, Partial<ToneCoverage>, "null" | "absent"][] = [
			["the base row", {}, "null"],
			["10 quiet blocks of 10", { ctcssBlocks: 10, quietBlocks: 10 }, "null"],
			["10 quiet blocks of 12", { ctcssBlocks: 12, quietBlocks: 10 }, "null"],
			["10 quiet blocks of 13", { ctcssBlocks: 13, quietBlocks: 10 }, "absent"],
			[
				"12 quiet blocks of 23 (a talker's pauses)",
				{ quietBlocks: 12 },
				"absent",
			],
			["20 quiet blocks of 23 (3 loud)", { quietBlocks: 20 }, "absent"],
			[
				"28 quiet blocks of 30 (2 loud)",
				{ ctcssBlocks: 30, quietBlocks: 28 },
				"null",
			],
			[
				"27 quiet blocks of 30 (3 loud)",
				{ ctcssBlocks: 30, quietBlocks: 27 },
				"absent",
			],
			[
				"98 quiet blocks of 100 (2 loud)",
				{ ctcssBlocks: 100, quietBlocks: 98 },
				"null",
			],
			[
				"97 quiet blocks of 100 (3 loud)",
				{ ctcssBlocks: 100, quietBlocks: 97 },
				"absent",
			],
			[
				"90 quiet blocks of 100 (a 2.5 s toned burst on a carrier)",
				{ ctcssBlocks: 100, quietBlocks: 90 },
				"absent",
			],
			[
				"26 quiet blocks of 29 (3 loud)",
				{ ctcssBlocks: 29, quietBlocks: 26 },
				"absent",
			],
			["more quiet blocks than blocks", { quietBlocks: 24 }, "absent"],
			["9 quiet blocks", { ctcssBlocks: 9, quietBlocks: 9 }, "absent"],
			["no quiet block (speech throughout)", { quietBlocks: 0 }, "absent"],
			["9 blocks in all", { ctcssBlocks: 9, quietBlocks: 9 }, "absent"],
			["5 999 DCS samples", { dcsSamples: 5_999 }, "absent"],
			["6 000 DCS samples", { dcsSamples: 6_000 }, "null"],
			["one voted block", { votedBlocks: 1 }, "absent"],
			["one leaned block", { partialBlocks: 1 }, "absent"],
			["a two-word DCS chain", { dcsChain: 2 }, "absent"],
			["a two-word non-standard chain", { dcsAnyChain: 2 }, "absent"],
			["2 lone hits in 6 s", { dcsLoneHits: 2 }, "absent"],
			["kept for its own tone", { ownTone: true }, "absent"],
			["no gap fill", { gapSamples: 0 }, "null"],
			["one gap-fill sample", { gapSamples: 1 }, "absent"],
			["0.95 s of gap fill", { gapSamples: 7_600 }, "absent"],
			["gap fill not a number", { gapSamples: Number.NaN }, "absent"],
			["quiet blocks not a number", { quietBlocks: Number.NaN }, "absent"],
		]
		for (const [, change, want] of rows) {
			const fact = toneFactOf(null, { ...base, ...change })
			if (want === "null") expect(fact).toEqual({ tone: null })
			else expect(fact).toEqual({})
		}
	})
})
