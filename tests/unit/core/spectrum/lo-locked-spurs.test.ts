import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { LoLockedSpurs } from "../../../../src/core/spectrum/lo-locked-spurs.js"
import type { LoSighting } from "../../../../src/core/spectrum/lo-locked-spurs.js"
import {
	DQ_LO_LOCK_CENTRES_PER_RECORD,
	DQ_LO_LOCK_MIN_SEPARATION_HZ,
	DQ_LO_LOCK_OFFSET_HZ,
	DQ_LO_LOCK_OFFSETS_PER_SOURCE,
	DQ_LO_LOCK_RECORDS_PER_SOURCE,
	DQ_LO_LOCK_SOURCES_MAX,
	DQ_LO_LOCK_WIDTH_FLOOR_HZ,
	DQ_LO_LOCK_WIDTH_RATIO,
} from "../../../../src/core/scanner/detection-quality-contract.js"

// Synthetic frequencies only.
const C1 = 400_000_000
const C2 = 401_000_000
const SPUR = -500_000

const make = (
	over: Partial<ConstructorParameters<typeof LoLockedSpurs>[0]> = {},
) =>
	new LoLockedSpurs({
		offsetHz: DQ_LO_LOCK_OFFSET_HZ,
		minSeparationHz: DQ_LO_LOCK_MIN_SEPARATION_HZ,
		widthRatio: DQ_LO_LOCK_WIDTH_RATIO,
		widthFloorHz: DQ_LO_LOCK_WIDTH_FLOOR_HZ,
		recordsPerSource: DQ_LO_LOCK_RECORDS_PER_SOURCE,
		centresPerRecord: DQ_LO_LOCK_CENTRES_PER_RECORD,
		offsetsPerSource: DQ_LO_LOCK_OFFSETS_PER_SOURCE,
		sourcesMax: DQ_LO_LOCK_SOURCES_MAX,
		...over,
	})

const at = (tunedHz: number, offsetHz: number, obwHz = 1_000): LoSighting => ({
	sourceId: "rtl",
	tunedHz,
	centreHz: tunedHz + offsetHz,
	obwHz,
})
const all = () => true

describe("LO-locked spurs from sightings", () => {
	it("states its bounds' arithmetic", () => {
		expect(DQ_LO_LOCK_OFFSET_HZ).toBe(1_200)
		expect(DQ_LO_LOCK_MIN_SEPARATION_HZ).toBe(12_500)
		expect(DQ_LO_LOCK_WIDTH_RATIO).toBe(2)
	})

	it("a line at one offset from two centres is LO-locked, the earlier record its partner", () => {
		const lo = make()
		lo.note("r1", at(C1, SPUR))
		const c = lo.check(at(C2, SPUR), all)
		expect(c).toEqual({ locked: true, partners: ["r1"] })
		// learned: back at C1 (the record gone) the line is still the spur
		lo.forget("r1")
		expect(lo.check(at(C1, SPUR), all).locked).toBe(true)
		expect(lo.learnedOffsets("rtl")).toEqual([SPUR])
	})

	it("a real emitter at one RF frequency seen from two centres is never LO-locked", () => {
		const lo = make()
		const rf = C1 - 300_000
		lo.note("real", at(C1, rf - C1))
		// at C2 it sits 1 MHz further from the centre: a different offset
		expect(lo.check(at(C2, rf - C2), all).locked).toBe(false)
	})

	it("offset tolerance: at the bound locked, past it not", () => {
		const lo = make()
		lo.note("r1", at(C1, SPUR))
		expect(lo.check(at(C2, SPUR + DQ_LO_LOCK_OFFSET_HZ + 1), all).locked).toBe(
			false,
		)
		expect(lo.check(at(C2, SPUR + DQ_LO_LOCK_OFFSET_HZ), all).locked).toBe(true)
	})

	it("centre separation: under 12.5 kHz the two centres are one", () => {
		const lo = make()
		lo.note("r1", at(C1, SPUR))
		const near = C1 + DQ_LO_LOCK_MIN_SEPARATION_HZ - 1
		expect(lo.check(at(near, SPUR), all).locked).toBe(false)
		expect(
			lo.check(at(C1 + DQ_LO_LOCK_MIN_SEPARATION_HZ, SPUR), all).locked,
		).toBe(true)
	})

	it("a record also sighted from the new centre is a real emitter in both windows", () => {
		const lo = make()
		lo.note("r1", at(C1, SPUR))
		lo.note("r1", at(C2, SPUR - (C2 - C1)))
		expect(lo.check(at(C2, SPUR), all).locked).toBe(false)
	})

	it("widths: within twice the floored width locked, past it not", () => {
		const lo = make()
		lo.note("r1", at(C1, SPUR, 1_000))
		// 1 kHz floors to 3 kHz: 6 kHz agrees, 6.001 kHz does not
		expect(lo.check(at(C2, SPUR, 6_001), all).locked).toBe(false)
		expect(lo.check(at(C2, SPUR, 6_000), all).locked).toBe(true)
	})

	it("an ineligible record (a decoded one) is no partner and teaches nothing", () => {
		const lo = make()
		lo.note("r1", at(C1, SPUR))
		expect(lo.check(at(C2, SPUR), () => false)).toEqual({
			locked: false,
			partners: [],
		})
		expect(lo.learnedOffsets("rtl")).toEqual([])
	})

	it("non-finite input is neither noted nor locked; sources past the cap are not remembered", () => {
		const lo = make({ sourcesMax: 1 })
		lo.note("r1", { ...at(C1, SPUR), centreHz: Number.NaN })
		expect(lo.check(at(C2, SPUR), all).locked).toBe(false)
		lo.note("r1", at(C1, SPUR))
		lo.note("x", { ...at(C1, SPUR), sourceId: "other" })
		expect(lo.check({ ...at(C2, SPUR), sourceId: "other" }, all).locked).toBe(
			false,
		)
		expect(lo.check({ ...at(C2, SPUR), tunedHz: Number.NaN }, all)).toEqual({
			locked: false,
			partners: [],
		})
	})

	it("bounds: records, centres per record and learned offsets drop their oldest", () => {
		const lo = make({
			recordsPerSource: 2,
			centresPerRecord: 2,
			offsetsPerSource: 1,
		})
		lo.note("a", at(C1, SPUR))
		lo.note("b", at(C1, SPUR + 50_000))
		lo.note("c", at(C1, SPUR + 100_000))
		// "a" was dropped at the third record
		expect(lo.check(at(C2, SPUR), all).partners).toEqual([])
		expect(lo.check(at(C2, SPUR + 100_000), all).partners).toEqual(["c"])
		expect(lo.check(at(C2, SPUR + 50_000), all).partners).toEqual(["b"])
		// one learned offset kept: the newest
		expect(lo.learnedOffsets("rtl")).toEqual([SPUR + 50_000])
		const r = make({ centresPerRecord: 2 })
		r.note("r", at(C1, 0 + 10_000))
		r.note("r", at(C1 + 100_000, 20_000))
		r.note("r", at(C1 + 200_000, 30_000))
		// the C1 centre fell out: the record no longer counts as sighted from C1
		expect(r.check(at(C1, 30_000), all).locked).toBe(true)
	})

	// Feature: scanner quiet-band quality, Property 1: a fixed RF emitter is never LO-locked
	// Validates: goal 1 (a real signal at a fixed absolute frequency seen from two centres)
	it("property: an emitter at a fixed RF frequency is never LO-locked by its own sightings", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: -900_000, max: 900_000 }),
				fc.array(fc.integer({ min: -40, max: 40 }), {
					minLength: 2,
					maxLength: 6,
				}),
				(offset, steps) => {
					const lo = make()
					const rf = C1 + offset
					for (const k of steps) {
						const tuned = C1 + k * DQ_LO_LOCK_MIN_SEPARATION_HZ
						const s = at(tuned, rf - tuned)
						if (lo.check(s, all).locked) return false
						lo.note("real", s)
					}
					return true
				},
			),
			{ numRuns: 200 },
		)
	})
})
