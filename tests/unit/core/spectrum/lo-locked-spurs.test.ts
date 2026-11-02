import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { LoLockedSpurs } from "../../../../src/core/spectrum/lo-locked-spurs.js"
import type { LoSighting } from "../../../../src/core/spectrum/lo-locked-spurs.js"
import { USABLE_FRACTION } from "../../../../src/core/spectrum/spectrum-engine.js"
import {
	DQ_DC_ADMIT_HZ,
	DQ_LO_LOCK_CENTRES_PER_RECORD,
	DQ_LO_LOCK_DC_GUARD_HZ,
	DQ_LO_LOCK_DWELL_MS,
	DQ_LO_LOCK_DWELLS_PER_SOURCE,
	DQ_LO_LOCK_LINES_PER_DWELL,
	DQ_LO_LOCK_MIN_SEPARATION_HZ,
	DQ_LO_LOCK_OFFSET_HZ,
	DQ_LO_LOCK_OFFSETS_PER_SOURCE,
	DQ_LO_LOCK_RECORDS_PER_SOURCE,
	DQ_LO_LOCK_SOURCES_MAX,
	DQ_LO_LOCK_TTL_MS,
	DQ_LO_LOCK_USABLE_FRACTION,
	DQ_LO_LOCK_WIDTH_FLOOR_HZ,
	DQ_LO_LOCK_WIDTH_RATIO,
} from "../../../../src/core/scanner/detection-quality-contract.js"

// Synthetic frequencies only.
const RATE = 1_024_000
const HALF = (DQ_LO_LOCK_USABLE_FRACTION * RATE) / 2
const C1 = 400_000_000
const C2 = C1 + 200_000
const SPUR = -150_000
const T0 = 1_000_000

const make = (
	over: Partial<ConstructorParameters<typeof LoLockedSpurs>[0]> = {},
) =>
	new LoLockedSpurs({
		offsetHz: DQ_LO_LOCK_OFFSET_HZ,
		minSeparationHz: DQ_LO_LOCK_MIN_SEPARATION_HZ,
		widthRatio: DQ_LO_LOCK_WIDTH_RATIO,
		widthFloorHz: DQ_LO_LOCK_WIDTH_FLOOR_HZ,
		usableFraction: DQ_LO_LOCK_USABLE_FRACTION,
		dcGuardHz: DQ_LO_LOCK_DC_GUARD_HZ,
		dwellMs: DQ_LO_LOCK_DWELL_MS,
		ttlMs: DQ_LO_LOCK_TTL_MS,
		dwellsPerSource: DQ_LO_LOCK_DWELLS_PER_SOURCE,
		linesPerDwell: DQ_LO_LOCK_LINES_PER_DWELL,
		recordsPerSource: DQ_LO_LOCK_RECORDS_PER_SOURCE,
		centresPerRecord: DQ_LO_LOCK_CENTRES_PER_RECORD,
		offsetsPerSource: DQ_LO_LOCK_OFFSETS_PER_SOURCE,
		sourcesMax: DQ_LO_LOCK_SOURCES_MAX,
		...over,
	})

const at = (
	tunedHz: number,
	offsetHz: number,
	atMs: number,
	over: Partial<LoSighting> = {},
): LoSighting => ({
	sourceId: "rtl",
	tunedHz,
	sampleRateHz: RATE,
	centreHz: tunedHz + offsetHz,
	obwHz: 1_000,
	steady: true,
	atMs,
	...over,
})
const all = () => true

/** Logs a line once a second over [from, from + ms] (the last sighting exactly at the end). */
function dwellOn(
	lo: LoLockedSpurs,
	tunedHz: number,
	offsetHz: number,
	from: number,
	ms: number,
	opts: { id?: string; real?: boolean; over?: Partial<LoSighting> } = {},
): number {
	const times: number[] = []
	for (let t = from; t < from + ms; t += 1_000) times.push(t)
	times.push(from + ms)
	for (const t of times) {
		const s = at(tunedHz, offsetHz, t, opts.over)
		lo.observe(s, opts.real ?? false)
		if (opts.id !== undefined) lo.note(opts.id, s)
	}
	return from + ms
}

/** A spur-shaped first dwell at C1 (10 s, record `r1`), then the sighting at `c2` checked after `ms`. */
function pair(
	lo: LoLockedSpurs,
	c2: number,
	offsetHz: number,
	ms = DQ_LO_LOCK_DWELL_MS,
	over: Partial<LoSighting> = {},
) {
	const end = dwellOn(lo, C1, offsetHz, T0, 10_000, { id: "r1" })
	const t2 = end + 500
	lo.observe(at(c2, offsetHz, t2, over), false)
	const s = at(c2, offsetHz, t2 + ms, over)
	const res = lo.check(s, all)
	lo.observe(s, false)
	return res
}

describe("LO-locked spurs from sightings", () => {
	it("states its bounds' arithmetic", () => {
		expect(DQ_LO_LOCK_OFFSET_HZ).toBe(1_200)
		expect(DQ_LO_LOCK_MIN_SEPARATION_HZ).toBe(12_500)
		expect(DQ_LO_LOCK_WIDTH_RATIO).toBe(1.5)
		// two steady lines floored at 3 kHz and under 4 kHz differ by at most 4 / 3
		expect(4_000 / DQ_LO_LOCK_WIDTH_FLOOR_HZ).toBeLessThan(
			DQ_LO_LOCK_WIDTH_RATIO,
		)
		expect(DQ_LO_LOCK_USABLE_FRACTION).toBe(USABLE_FRACTION)
		expect(HALF).toBe(409_600)
		expect(DQ_LO_LOCK_DC_GUARD_HZ).toBe(DQ_DC_ADMIT_HZ)
		// gate on-time 300 ms + a first ingest up to 1 s late + two throttled ingests
		expect(DQ_LO_LOCK_DWELL_MS).toBe(3_000)
		expect(DQ_LO_LOCK_TTL_MS).toBe(10 * 60_000)
	})

	it("a steady line at one offset, each window seeing the other position empty: pending until the dwell, then locked", () => {
		const lo = make()
		const end = dwellOn(lo, C1, SPUR, T0, 10_000, { id: "r1" })
		const t2 = end + 500
		expect(lo.check(at(C2, SPUR, t2), all).verdict).toBe("pending")
		lo.observe(at(C2, SPUR, t2), false)
		expect(
			lo.check(at(C2, SPUR, t2 + DQ_LO_LOCK_DWELL_MS - 1), all).verdict,
		).toBe("pending")
		expect(lo.check(at(C2, SPUR, t2 + DQ_LO_LOCK_DWELL_MS), all)).toEqual({
			verdict: "locked",
			partners: ["r1"],
		})
		expect(lo.learnedOffsets("rtl")).toEqual([SPUR])
		expect(lo.suppressed("rtl")).toBe(1)
		// back at C1 (the record gone): the C2 dwell saw C1's position empty, so it locks again
		lo.forget("r1")
		const t3 = dwellOn(lo, C2, SPUR, t2, 8_000) + 500
		lo.observe(at(C1, SPUR, t3), false)
		expect(lo.check(at(C1, SPUR, t3 + DQ_LO_LOCK_DWELL_MS), all).verdict).toBe(
			"locked",
		)
	})

	it("repro: two real emitters at one offset, the first window not covering the second: clear", () => {
		// 1.024 Msps, ±409.6 kHz usable: 400.1 MHz under 400 MHz, then 402.1 MHz under 402 MHz
		const lo = make()
		const a = 400_000_000
		const b = 402_000_000
		const end = dwellOn(lo, a, 100_000, T0, 10_000, { id: "r1" })
		lo.observe(at(b, 100_000, end + 500), false)
		for (const dt of [0, DQ_LO_LOCK_DWELL_MS, 60_000])
			expect(lo.check(at(b, 100_000, end + 500 + dt), all)).toEqual({
				verdict: "clear",
				partners: [],
			})
		expect(lo.learnedOffsets("rtl")).toEqual([])
	})

	it("repro: a learned offset does not hide a real narrow emitter a day later under another centre", () => {
		const lo = make()
		expect(pair(lo, C2, 100_000).verdict).toBe("locked")
		const day = T0 + 24 * 3_600_000
		const c3 = 410_000_000
		lo.observe(at(c3, 100_000, day, { obwHz: 5_000, steady: false }), false)
		expect(
			lo.check(
				at(c3, 100_000, day + DQ_LO_LOCK_DWELL_MS, {
					obwHz: 5_000,
					steady: false,
				}),
				all,
			).verdict,
		).toBe("clear")
		// even a steady line there: no dwell ever saw 410.1 MHz empty
		expect(
			lo.check(at(c3, 100_000, day + DQ_LO_LOCK_DWELL_MS), all).verdict,
		).toBe("clear")
		expect(lo.learnedOffsets("rtl", day)).toEqual([])
	})

	it("window: the partner's position at the usable half-span is covered, 1 Hz past it is not", () => {
		// the line counts as 3 kHz wide (floor): its outer edge sits at the half-span
		const c2 = C1 + SPUR + HALF - DQ_LO_LOCK_WIDTH_FLOOR_HZ / 2
		expect(pair(make(), c2, SPUR).verdict).toBe("locked")
		expect(pair(make(), c2 + 1, SPUR).verdict).toBe("clear")
	})

	it("window: the new position inside the earlier centre's DC guard proves nothing", () => {
		// F - C1 = c2 - C1 + SPUR
		const c2 = C1 - SPUR + DQ_LO_LOCK_DC_GUARD_HZ
		expect(pair(make(), c2, SPUR).verdict).toBe("clear")
		expect(pair(make(), c2 + 1, SPUR).verdict).toBe("locked")
	})

	it("dwell: the earlier centre's dwell at the minimum counts, 1 ms shorter does not", () => {
		for (const [ms, want] of [
			[DQ_LO_LOCK_DWELL_MS, "locked"],
			[DQ_LO_LOCK_DWELL_MS - 1, "clear"],
		] as const) {
			const lo = make()
			const end = dwellOn(lo, C1, SPUR, T0, ms, { id: "r1" })
			lo.observe(at(C2, SPUR, end + 500), false)
			expect(
				lo.check(at(C2, SPUR, end + 500 + DQ_LO_LOCK_DWELL_MS), all).verdict,
			).toBe(want)
		}
	})

	it("TTL: the earlier dwell's evidence holds for the TTL after its last sighting, not past it", () => {
		for (const [gap, want] of [
			[DQ_LO_LOCK_TTL_MS, "locked"],
			[DQ_LO_LOCK_TTL_MS + 1, "clear"],
		] as const) {
			const lo = make()
			const end = dwellOn(lo, C1, SPUR, T0, 10_000, { id: "r1" })
			const t2 = end + gap - DQ_LO_LOCK_DWELL_MS
			lo.observe(at(C2, SPUR, t2), false)
			expect(lo.check(at(C2, SPUR, end + gap), all).verdict).toBe(want)
		}
		// a learned offset expires with its TTL
		const lo = make()
		expect(pair(lo, C2, SPUR).verdict).toBe("locked")
		const learnedAt = T0 + 10_000 + 500 + DQ_LO_LOCK_DWELL_MS
		expect(lo.learnedOffsets("rtl", learnedAt + DQ_LO_LOCK_TTL_MS)).toEqual([
			SPUR,
		])
		expect(lo.learnedOffsets("rtl", learnedAt + DQ_LO_LOCK_TTL_MS + 1)).toEqual(
			[],
		)
	})

	it("widths: within 1.5 times the floored width locked, past it not", () => {
		// 1 kHz floors to 3 kHz: 4.5 kHz agrees, 4.501 kHz does not
		expect(pair(make(), C2, SPUR, undefined, { obwHz: 4_500 }).verdict).toBe(
			"locked",
		)
		expect(pair(make(), C2, SPUR, undefined, { obwHz: 4_501 }).verdict).toBe(
			"clear",
		)
	})

	it("offset tolerance: at the bound locked, past it not", () => {
		const off = (d: number) => {
			const lo = make()
			const end = dwellOn(lo, C1, SPUR, T0, 10_000, { id: "r1" })
			lo.observe(at(C2, SPUR + d, end + 500), false)
			return lo.check(at(C2, SPUR + d, end + 500 + DQ_LO_LOCK_DWELL_MS), all)
				.verdict
		}
		expect(off(DQ_LO_LOCK_OFFSET_HZ)).toBe("locked")
		expect(off(DQ_LO_LOCK_OFFSET_HZ + 1)).toBe("clear")
	})

	it("centre separation: under 12.5 kHz the two centres are one", () => {
		expect(
			pair(make(), C1 + DQ_LO_LOCK_MIN_SEPARATION_HZ - 1, SPUR).verdict,
		).toBe("clear")
		expect(pair(make(), C1 + DQ_LO_LOCK_MIN_SEPARATION_HZ, SPUR).verdict).toBe(
			"locked",
		)
	})

	it("something seen at either position from the other centre is a real emitter: clear", () => {
		// a line at F2 seen from C1
		const lo = make()
		const end = dwellOn(lo, C1, SPUR, T0, 10_000, { id: "r1" })
		dwellOn(lo, C1, C2 - C1 + SPUR, T0 + 2_000, 1_000)
		lo.observe(at(C2, SPUR, end + 500), false)
		expect(
			lo.check(at(C2, SPUR, end + 500 + DQ_LO_LOCK_DWELL_MS), all).verdict,
		).toBe("clear")
		// a line at F1 seen from C2 now
		const lo2 = make()
		const end2 = dwellOn(lo2, C1, SPUR, T0, 10_000, { id: "r1" })
		lo2.observe(at(C2, SPUR, end2 + 500), false)
		lo2.observe(at(C2, C1 + SPUR - C2, end2 + 1_000), false)
		expect(
			lo2.check(at(C2, SPUR, end2 + 500 + DQ_LO_LOCK_DWELL_MS), all).verdict,
		).toBe("clear")
	})

	it("only steady lines lock: a bursty or modulated sighting is clear, a young one pending", () => {
		expect(pair(make(), C2, SPUR, undefined, { steady: false }).verdict).toBe(
			"clear",
		)
		expect(
			pair(make(), C2, SPUR, undefined, { steady: undefined }).verdict,
		).toBe("pending")
		// a partner line that was never steady is no partner
		const lo = make()
		const end = dwellOn(lo, C1, SPUR, T0, 10_000, {
			id: "r1",
			over: { steady: false },
		})
		lo.observe(at(C2, SPUR, end + 500), false)
		expect(
			lo.check(at(C2, SPUR, end + 500 + DQ_LO_LOCK_DWELL_MS), all).verdict,
		).toBe("clear")
	})

	it("a partner line with evidence of a real signal never locks; an ineligible record is no partner", () => {
		const lo = make()
		const end = dwellOn(lo, C1, SPUR, T0, 10_000, { id: "r1", real: true })
		lo.observe(at(C2, SPUR, end + 500), false)
		expect(
			lo.check(at(C2, SPUR, end + 500 + DQ_LO_LOCK_DWELL_MS), all).verdict,
		).toBe("clear")
		const lo2 = make()
		const end2 = dwellOn(lo2, C1, SPUR, T0, 10_000, { id: "r1" })
		lo2.observe(at(C2, SPUR, end2 + 500), false)
		expect(
			lo2.check(at(C2, SPUR, end2 + 500 + DQ_LO_LOCK_DWELL_MS), () => false),
		).toEqual({ verdict: "locked", partners: [] })
	})

	it("a record also sighted from the new centre is no partner", () => {
		const lo = make()
		const end = dwellOn(lo, C1, SPUR, T0, 10_000, { id: "r1" })
		lo.note("r1", at(C2, C1 + SPUR - C2, end + 100))
		lo.observe(at(C2, SPUR, end + 500), false)
		// the record's own line at F1 seen from C2 also proves a real emitter there
		expect(
			lo.check(at(C2, SPUR, end + 500 + DQ_LO_LOCK_DWELL_MS), all).partners,
		).toEqual([])
	})

	it("revocation: evidence, a non-steady sighting or one RF line from two centres revokes a learned offset for the TTL", () => {
		const cases: ((lo: LoLockedSpurs, t: number) => void)[] = [
			// control: nothing contradicts, the offset stays learned
			() => undefined,
			(lo, t) => lo.observe(at(C2 + 50_000, SPUR, t), true),
			(lo, t) => lo.observe(at(C2 + 50_000, SPUR, t, { steady: false }), false),
			(lo, t) => {
				// the line C2 + SPUR, seen again from a third centre at another offset
				const c3 = C2 + 100_000
				lo.observe(at(c3, C2 + SPUR - c3, t), false)
			},
		]
		for (const [i, revoke] of cases.entries()) {
			const lo = make()
			expect(pair(lo, C2, SPUR).verdict).toBe("locked")
			const t = T0 + 30_000
			revoke(lo, t)
			expect(lo.learnedOffsets("rtl", t)).toEqual(i === 0 ? [SPUR] : [])
			// back at C1 with a full dwell: no lock while revoked
			lo.observe(at(C1, SPUR, t + 1_000), false)
			expect(
				lo.check(at(C1, SPUR, t + 1_000 + DQ_LO_LOCK_DWELL_MS), all).verdict,
			).toBe(i === 0 ? "locked" : "clear")
		}
	})

	it("a dwell with more lines than the bound proves no absence", () => {
		const lo = make({ linesPerDwell: 2 })
		const end = dwellOn(lo, C1, SPUR, T0, 10_000, { id: "r1" })
		lo.observe(at(C1, 300_000, end - 100), false)
		lo.observe(at(C1, -300_000, end - 50), false)
		lo.observe(at(C2, SPUR, end + 500), false)
		expect(
			lo.check(at(C2, SPUR, end + 500 + DQ_LO_LOCK_DWELL_MS), all).verdict,
		).toBe("clear")
	})

	it("non-finite input is neither logged nor locked; sources past the cap are not remembered", () => {
		const lo = make({ sourcesMax: 1 })
		lo.observe({ ...at(C1, SPUR, T0), centreHz: Number.NaN }, false)
		expect(lo.check({ ...at(C2, SPUR, T0), sampleRateHz: 0 }, all)).toEqual({
			verdict: "clear",
			partners: [],
		})
		dwellOn(lo, C1, SPUR, T0, 10_000)
		dwellOn(lo, C1, SPUR, T0, 10_000, { over: { sourceId: "other" } })
		lo.observe({ ...at(C2, SPUR, T0 + 10_500), sourceId: "other" }, false)
		expect(
			lo.check(
				{
					...at(C2, SPUR, T0 + 10_500 + DQ_LO_LOCK_DWELL_MS),
					sourceId: "other",
				},
				all,
			).verdict,
		).toBe("clear")
		expect(
			lo.check({ ...at(C2, SPUR, T0 + 20_000), tunedHz: Number.NaN }, all)
				.verdict,
		).toBe("clear")
	})

	it("bounds: dwells, records and centres per record drop their oldest", () => {
		// one dwell kept: the C1 dwell is gone when C2 starts
		expect(pair(make({ dwellsPerSource: 1 }), C2, SPUR).verdict).toBe("clear")
		// records: "r1" dropped once two newer records were noted
		const lo = make({ recordsPerSource: 2 })
		const end = dwellOn(lo, C1, SPUR, T0, 10_000, { id: "r1" })
		lo.note("a", at(C1, 300_000, end))
		lo.note("b", at(C1, -300_000, end))
		lo.observe(at(C2, SPUR, end + 500), false)
		expect(
			lo.check(at(C2, SPUR, end + 500 + DQ_LO_LOCK_DWELL_MS), all),
		).toEqual({ verdict: "locked", partners: [] })
		// centres: r1's C1 entry fell out after two other centres
		const r = make({ centresPerRecord: 2 })
		const e = dwellOn(r, C1, SPUR, T0, 10_000, { id: "r1" })
		r.note("r1", at(C1 + 100_000, 0 + 20_000, e))
		r.note("r1", at(C1 + 300_000, 0 + 30_000, e))
		r.observe(at(C2, SPUR, e + 500), false)
		expect(
			r.check(at(C2, SPUR, e + 500 + DQ_LO_LOCK_DWELL_MS), all).partners,
		).toEqual([])
	})

	// Feature: scanner quiet-band quality, Property 1: a fixed RF emitter is never LO-locked
	// Validates: goal 1 (a real signal at a fixed absolute frequency seen from several centres)
	it("property: an emitter at a fixed RF frequency is never LO-locked by its own sightings", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: -400_000, max: 400_000 }),
				fc.array(fc.integer({ min: -40, max: 40 }), {
					minLength: 2,
					maxLength: 6,
				}),
				(offset, steps) => {
					const lo = make()
					const rf = C1 + offset
					let t = T0
					for (const k of steps) {
						const tuned = C1 + k * DQ_LO_LOCK_MIN_SEPARATION_HZ
						for (let i = 0; i <= 10; i++) {
							const s = at(tuned, rf - tuned, t)
							if (lo.check(s, all).verdict === "locked") return false
							lo.observe(s, false)
							lo.note("real", s)
							t += 1_000
						}
					}
					return true
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: scanner quiet-band quality, Property 2: no lock without both windows covering
	// Validates: goal 1 (two real emitters at one offset under far-apart centres are both discovered)
	it("property: when either window does not cover the other position, nothing is LO-locked", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: -400_000, max: 400_000 }),
				fc.integer({ min: -96, max: 96 }),
				(offset, k) => {
					const c2 = C1 + k * DQ_LO_LOCK_MIN_SEPARATION_HZ
					const w = DQ_LO_LOCK_WIDTH_FLOOR_HZ / 2
					const inC1 = Math.abs(c2 + offset - C1) + w <= HALF
					const inC2 = Math.abs(C1 + offset - c2) + w <= HALF
					fc.pre(!(inC1 && inC2))
					const lo = make()
					const end = dwellOn(lo, C1, offset, T0, 10_000, { id: "r1" })
					for (let t = end + 500; t <= end + 500 + 10_000; t += 1_000) {
						const s = at(c2, offset, t)
						if (lo.check(s, all).verdict === "locked") return false
						lo.observe(s, false)
					}
					return true
				},
			),
			{ numRuns: 200 },
		)
	})
})
