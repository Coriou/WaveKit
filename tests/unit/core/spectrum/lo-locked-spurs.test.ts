import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { LoLockedSpurs } from "../../../../src/core/spectrum/lo-locked-spurs.js"
import type { LoSighting } from "../../../../src/core/spectrum/lo-locked-spurs.js"
import { USABLE_FRACTION } from "../../../../src/core/spectrum/spectrum-engine.js"
import {
	PROVISIONAL_ON_FRACTION,
	PROVISIONAL_WINDOW_MS,
} from "../../../../src/core/spectrum/provisional-spurs.js"
import {
	DQ_DC_ADMIT_HZ,
	DQ_LO_LOCK_CENTRES_PER_RECORD,
	DQ_LO_LOCK_DC_GUARD_HZ,
	DQ_LO_LOCK_DWELL_MS,
	DQ_LO_LOCK_DWELLS_PER_SOURCE,
	DQ_LO_LOCK_LINES_PER_DWELL,
	DQ_LO_LOCK_MASK_PERIOD_MS,
	DQ_LO_LOCK_MASK_SETTLE_MS,
	DQ_LO_LOCK_MIN_CENTRES,
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
/** A tiling sweep: hops 785 kHz apart, so no hop's window covers another hop's spur position. */
const STEP = 785_000
const SWEEP = [C1, C1 + STEP, C1 + 2 * STEP] as const
const SPUR = -300_000
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
		minCentres: DQ_LO_LOCK_MIN_CENTRES,
		maskSettleMs: DQ_LO_LOCK_MASK_SETTLE_MS,
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

interface DwellResult {
	end: number
	verdicts: string[]
	partners: Set<string>
}

/**
 * One dwell at `tunedHz`: ticks and sightings once a second over [from, from + ms] (the last
 * exactly at the end). Each listed line is observed, noted (born at its first sighting) as
 * `id` and checked.
 */
function dwell(
	lo: LoLockedSpurs,
	tunedHz: number,
	from: number,
	ms: number,
	lines: readonly {
		offsetHz: number
		id?: string
		real?: boolean
		over?: Partial<LoSighting>
	}[],
	born = new Set<string>(),
): DwellResult {
	const verdicts: string[] = []
	const partners = new Set<string>()
	const times: number[] = []
	for (let t = from; t < from + ms; t += 1_000) times.push(t)
	times.push(from + ms)
	for (const t of times) {
		lo.tick("rtl", tunedHz, RATE, t)
		for (const l of lines) {
			const s = at(tunedHz, l.offsetHz, t, l.over)
			lo.observe(s, l.real ?? false)
			if (l.id !== undefined) {
				lo.note(l.id, s, !born.has(l.id))
				born.add(l.id)
			}
			const res = lo.check(s, all)
			verdicts.push(res.verdict)
			for (const p of res.partners) partners.add(p)
		}
	}
	return { end: from + ms, verdicts, partners }
}

/** Dwells of `ms` (default 10 s) 500 ms apart over `centres`, a line at `offsetHz` in each. */
function sweep(
	lo: LoLockedSpurs,
	centres: readonly number[],
	offsetHz: number,
	opts: { ms?: number; from?: number; over?: Partial<LoSighting> } = {},
): DwellResult[] {
	let t = opts.from ?? T0
	const born = new Set<string>()
	const out: DwellResult[] = []
	for (const c of centres) {
		const r = dwell(
			lo,
			c,
			t,
			opts.ms ?? 10_000,
			[
				{
					offsetHz,
					id: `r${c}`,
					...(opts.over === undefined ? {} : { over: opts.over }),
				},
			],
			born,
		)
		out.push(r)
		t = r.end + 500
	}
	return out
}

const lockedIn = (r: DwellResult) => r.verdicts.includes("locked")

describe("LO-locked spurs from sightings (flag only)", () => {
	it("no revocation: every block gets the same frozen empty array (no per-block allocation)", () => {
		const lo = make()
		const a = lo.takeRevoked()
		expect(a).toEqual([])
		expect(lo.takeRevoked()).toBe(a)
		expect(Object.isFrozen(a)).toBe(true)
	})

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
		expect(DQ_LO_LOCK_DWELL_MS).toBe(3_000)
		expect(DQ_LO_LOCK_TTL_MS).toBe(10 * 60_000)
		expect(DQ_LO_LOCK_MIN_CENTRES).toBe(3)
		// the provisional off budget (1 − 0.95) × 30 s = 1.5 s, plus 0.5 s margin
		const offBudget = (1 - PROVISIONAL_ON_FRACTION) * PROVISIONAL_WINDOW_MS
		expect(offBudget).toBeCloseTo(1_500, 6)
		expect(DQ_LO_LOCK_MASK_SETTLE_MS).toBe(2_000)
		expect(DQ_LO_LOCK_MASK_SETTLE_MS).toBeGreaterThan(offBudget)
		expect(DQ_LO_LOCK_MASK_PERIOD_MS).toBe(1_000)
		// the tiling sweep below never has a spur position inside another hop's window
		expect(STEP - Math.abs(SPUR)).toBeGreaterThan(HALF)
	})

	it("repro: a tiling sweep (3 hops 785 kHz apart, cyclic) locks at the third distinct centre; the born records are partners", () => {
		const lo = make()
		const rs = sweep(lo, [...SWEEP, SWEEP[0], SWEEP[1]], SPUR)
		expect(lockedIn(rs[0]!)).toBe(false)
		expect(lockedIn(rs[1]!)).toBe(false)
		expect(lockedIn(rs[2]!)).toBe(true)
		expect([...rs[2]!.partners].sort()).toEqual(SWEEP.map(c => `r${c}`).sort())
		// revisits stay locked (the cyclic wrap breaks nothing)
		expect(rs[3]!.verdicts.every(v => v === "locked")).toBe(true)
		expect(rs[4]!.verdicts.every(v => v === "locked")).toBe(true)
		expect(lo.learnedOffsets("rtl")).toEqual([SPUR])
	})

	it("short hops (2.9 s) still lock: a hit needs no minimum dwell", () => {
		const lo = make()
		const rs = sweep(lo, SWEEP, SPUR, { ms: 2_900 })
		expect(lockedIn(rs[2]!)).toBe(true)
	})

	it("two distinct centres (A, B, A, B) never lock", () => {
		const lo = make()
		const rs = sweep(lo, [SWEEP[0], SWEEP[1], SWEEP[0], SWEEP[1]], SPUR, {
			ms: 30_000,
		})
		for (const r of rs) expect(lockedIn(r)).toBe(false)
		expect(lo.learnedOffsets("rtl")).toEqual([])
	})

	it("repro: two real emitters at one offset under two hops, the third hop's complete dwell sees nothing there: never locked", () => {
		const lo = make()
		const born = new Set<string>()
		let t = T0
		for (const k of [0, 1, 2, 0, 1, 2]) {
			const c = SWEEP[k]!
			const lines = k === 2 ? [] : [{ offsetHz: SPUR, id: `e${k}` }]
			const r = dwell(lo, c, t, 10_000, lines, born)
			expect(lockedIn(r)).toBe(false)
			t = r.end + 500
		}
		expect(lo.learnedOffsets("rtl")).toEqual([])
	})

	it("miss: a dwell 1 ms shorter than the minimum is no miss; at the minimum it is", () => {
		for (const [ms, locks] of [
			[DQ_LO_LOCK_DWELL_MS - 1, true],
			[DQ_LO_LOCK_DWELL_MS, false],
		] as const) {
			const lo = make()
			const born = new Set<string>()
			let t = T0
			const empty = C1 + 3 * STEP
			lo.tick("rtl", empty, RATE, t)
			lo.tick("rtl", empty, RATE, t + ms)
			t += ms + 500
			let locked = false
			for (const c of SWEEP) {
				const r = dwell(
					lo,
					c,
					t,
					10_000,
					[{ offsetHz: SPUR, id: `r${c}` }],
					born,
				)
				locked ||= lockedIn(r)
				t = r.end + 500
			}
			expect({ ms, locked }).toEqual({ ms, locked: locks })
		}
	})

	it("a position outside a dwell's usable window or inside its DC guard is no miss", () => {
		for (const off of [-(HALF + 2_000), DQ_LO_LOCK_DC_GUARD_HZ]) {
			const lo = make()
			let t = T0
			const empty = C1 + 3 * STEP
			lo.tick("rtl", empty, RATE, t)
			lo.tick("rtl", empty, RATE, t + 10_000)
			t += 10_500
			const rs = sweep(lo, SWEEP, off, { from: t })
			expect({ off, locked: lockedIn(rs[2]!) }).toEqual({ off, locked: true })
		}
	})

	it("one RF line seen from another centre whose window covers it is a real emitter: clear", () => {
		// centres 100 kHz apart: each spur position lies inside the other centres' windows
		const lo = make()
		const born = new Set<string>()
		const cs = [C1, C1 + 100_000, C1 + 200_000]
		let t = T0
		// a real emitter sits at C1 + SPUR and stays there: seen from every centre
		for (const c of cs) {
			const r = dwell(
				lo,
				c,
				t,
				10_000,
				[{ offsetHz: SPUR, id: `r${c}` }, { offsetHz: C1 + SPUR - c }],
				born,
			)
			t = r.end + 500
			if (c !== C1) expect(lockedIn(r)).toBe(false)
		}
		expect(lo.learnedOffsets("rtl")).toEqual([])
	})

	it("overlapping windows with each spur position empty from the other centres lock", () => {
		const lo = make()
		const rs = sweep(lo, [C1, C1 + 100_000, C1 + 200_000], SPUR)
		expect(lockedIn(rs[2]!)).toBe(true)
	})

	it("a line at the offset with evidence of a real signal, or not steady, blocks the lock", () => {
		for (const blocker of [
			{ real: true },
			{ over: { steady: false } as Partial<LoSighting> },
		]) {
			const lo = make()
			const born = new Set<string>()
			let t = T0
			const first = dwell(
				lo,
				SWEEP[0],
				t,
				10_000,
				[{ offsetHz: SPUR, id: "x", ...blocker }],
				born,
			)
			t = first.end + 500
			const rs = sweep(lo, [SWEEP[1], SWEEP[2], C1 + 3 * STEP], SPUR, {
				from: t,
			})
			for (const r of rs) expect(lockedIn(r)).toBe(false)
		}
	})

	it("only steady sightings lock: a young (undefined) or bursty sighting is clear", () => {
		const lo = make()
		sweep(lo, SWEEP, SPUR)
		const t = T0 + 40_000
		lo.observe(at(SWEEP[0], SPUR, t, { steady: undefined }), false)
		expect(lo.check(at(SWEEP[0], SPUR, t, { steady: undefined }), all)).toEqual(
			{ verdict: "clear", partners: [], centres: 0 },
		)
	})

	it("widths: within 1.5 times the floored width a hit, past it not", () => {
		const ok = make()
		const rs = sweep(ok, SWEEP, SPUR, { over: { obwHz: 4_400 } })
		// 4.4 kHz against 3 kHz floor: the checked sighting is the same line, all widths agree
		expect(lockedIn(rs[2]!)).toBe(true)
		const lo = make()
		const born = new Set<string>()
		let t = T0
		for (const [i, c] of SWEEP.entries()) {
			const obwHz = i === 2 ? 4_600 : 1_000
			const r = dwell(
				lo,
				c,
				t,
				10_000,
				[{ offsetHz: SPUR, id: `r${c}`, over: { obwHz } }],
				born,
			)
			expect(lockedIn(r)).toBe(false)
			t = r.end + 500
		}
	})

	it("offset tolerance: at the bound a hit, past it not", () => {
		for (const [d, locks] of [
			[DQ_LO_LOCK_OFFSET_HZ, true],
			[DQ_LO_LOCK_OFFSET_HZ + 1, false],
		] as const) {
			const lo = make()
			const born = new Set<string>()
			let t = T0
			let locked = false
			for (const [i, c] of SWEEP.entries()) {
				const r = dwell(
					lo,
					c,
					t,
					10_000,
					[{ offsetHz: SPUR + (i === 1 ? d : 0), id: `r${c}` }],
					born,
				)
				if (i === 2) locked = lockedIn(r)
				t = r.end + 500
			}
			expect({ d, locked }).toEqual({ d, locked: locks })
		}
	})

	it("centre separation: three centres within 12.5 kHz of each other count as fewer", () => {
		const lo = make()
		const rs = sweep(lo, [C1, C1 + 12_499, C1 + 2 * 12_499], SPUR)
		// C1 and C1 + 24 998 are apart; C1 + 12 499 is one with each: 2 distinct centres
		for (const r of rs) expect(lockedIn(r)).toBe(false)
		const lo2 = make()
		const rs2 = sweep(lo2, [C1, C1 + 12_500, C1 + 25_000], SPUR)
		expect(lockedIn(rs2[2]!)).toBe(true)
	})

	it("revocation: evidence at a learned offset revokes it for the TTL and reports it", () => {
		const lo = make()
		sweep(lo, SWEEP, SPUR)
		expect(lo.learnedOffsets("rtl")).toEqual([SPUR])
		const t = T0 + 40_000
		lo.observe(at(SWEEP[0], SPUR, t), true)
		expect(lo.learnedOffsets("rtl")).toEqual([])
		expect(lo.takeRevoked()).toEqual([
			{ sourceId: "rtl", rateHz: RATE, offsetHz: SPUR },
		])
		expect(lo.takeRevoked()).toEqual([])
		const again = sweep(lo, SWEEP, SPUR, { from: t + 1_000 })
		for (const r of again) expect(lockedIn(r)).toBe(false)
	})

	it("revocation: one RF line seen from two centres where its offset is learned", () => {
		const lo = make()
		sweep(lo, [C1, C1 + 100_000, C1 + 200_000], SPUR)
		expect(lo.learnedOffsets("rtl")).toEqual([SPUR])
		// back at C1, a line at the position C1 + 200 kHz + SPUR (seen there before)
		lo.observe(at(C1, 200_000 + SPUR, T0 + 40_000), false)
		expect(lo.learnedOffsets("rtl")).toEqual([])
		expect(lo.takeRevoked().length).toBeGreaterThan(0)
	})

	it("TTL: a learned offset holds for the TTL after its last proof, not past it", () => {
		const lo = make()
		const rs = sweep(lo, SWEEP, SPUR)
		const end = rs[2]!.end
		expect(lo.learnedOffsets("rtl", end + DQ_LO_LOCK_TTL_MS)).toEqual([SPUR])
		expect(lo.learnedOffsets("rtl", end + DQ_LO_LOCK_TTL_MS + 1)).toEqual([])
		const s = at(SWEEP[0], SPUR, end + DQ_LO_LOCK_TTL_MS + 1)
		lo.observe(s, false)
		expect(lo.check(s, all).verdict).toBe("clear")
	})

	it("repro: an expired offset is reported like a revocation (its flags lift), and isLearned follows the TTL", () => {
		const lo = make()
		const rs = sweep(lo, SWEEP, SPUR)
		expect(lo.takeRevoked()).toEqual([])
		const end = rs[2]!.end
		expect(lo.isLearned("rtl", RATE, SPUR, end + DQ_LO_LOCK_TTL_MS)).toBe(true)
		expect(lo.isLearned("rtl", RATE, SPUR + DQ_LO_LOCK_OFFSET_HZ, end)).toBe(
			true,
		)
		expect(
			lo.isLearned("rtl", RATE, SPUR + DQ_LO_LOCK_OFFSET_HZ + 1, end),
		).toBe(false)
		expect(lo.isLearned("rtl", 2_400_000, SPUR, end)).toBe(false)
		expect(lo.isLearned("other", RATE, SPUR, end)).toBe(false)
		expect(lo.isLearned("rtl", RATE, SPUR, end + DQ_LO_LOCK_TTL_MS + 1)).toBe(
			false,
		)
		// one block at the TTL: nothing due, nothing reported
		lo.tick("rtl", SWEEP[0], RATE, end + DQ_LO_LOCK_TTL_MS)
		expect(lo.takeRevoked()).toEqual([])
		expect(lo.learnedOffsets("rtl")).toEqual([SPUR])
		// one block past it: the offset expires and is reported once
		lo.tick("rtl", SWEEP[0], RATE, end + DQ_LO_LOCK_TTL_MS + 1)
		expect(lo.learnedOffsets("rtl")).toEqual([])
		expect(lo.takeRevoked()).toEqual([
			{ sourceId: "rtl", rateHz: RATE, offsetHz: SPUR },
		])
		lo.tick("rtl", SWEEP[0], RATE, end + DQ_LO_LOCK_TTL_MS + 2)
		expect(lo.takeRevoked()).toEqual([])
	})

	it("records: a sighting that is no steady line (modulated, too wide) taints the record for good, at any centre", () => {
		const lo = make()
		lo.note("a", at(C1, SPUR, T0), true)
		lo.note("a", at(C1 + STEP, SPUR, T0 + 1_000, { steady: false }), false)
		expect(lo.remembers("rtl", "a")).toBe(false)
		expect(lo.remembersAny("a")).toBe(false)
		lo.note("b", at(C1, SPUR, T0), true)
		// a young (undefined) sighting is no contradiction
		lo.note("b", at(C1 + STEP, SPUR, T0 + 1_000, { steady: undefined }), false)
		expect(lo.remembersAny("b")).toBe(true)
	})

	it("records: only a record born here is a partner; a taint is for good", () => {
		const lo = make()
		// a record created elsewhere (restored, or placed without a tuned centre) is never remembered
		const t = T0
		lo.note("restored", at(SWEEP[0], SPUR, t), false)
		expect(lo.remembers("rtl", "restored")).toBe(false)
		lo.note("born", at(SWEEP[0], SPUR, t), true)
		expect(lo.remembers("rtl", "born")).toBe(true)
		lo.taint("born")
		lo.note("born", at(SWEEP[0], SPUR, t + 1_000), false)
		expect(lo.remembers("rtl", "born")).toBe(false)
	})

	it("records: a replaced entry that is not the same steady line, or one centre past the bound, leaves", () => {
		const lo = make()
		lo.note("a", at(C1, SPUR, T0, { steady: false }), true)
		lo.note("a", at(C1, SPUR, T0 + 1_000), false)
		expect(lo.remembers("rtl", "a")).toBe(false)
		lo.note("b", at(C1, SPUR, T0), true)
		for (let k = 1; k < DQ_LO_LOCK_CENTRES_PER_RECORD; k++)
			lo.note("b", at(C1 + k * 100_000, SPUR, T0 + k), false)
		expect(lo.remembers("rtl", "b")).toBe(true)
		lo.note("b", at(C1 + 900_000, SPUR, T0 + 10), false)
		expect(lo.remembers("rtl", "b")).toBe(false)
	})

	it("records: a record also sighted at another offset is no partner", () => {
		const lo = make()
		lo.note("two", at(C1 + 3 * STEP, SPUR, T0), true)
		lo.note("two", at(C1 + 3 * STEP + 100_000, SPUR - 100_000, T0 + 1), false)
		const rs = sweep(lo, SWEEP, SPUR, { from: T0 + 10 })
		expect(lockedIn(rs[2]!)).toBe(true)
		expect(rs[2]!.partners.has("two")).toBe(false)
	})

	it("records: the per-source bound drops the least recently sighted and counts it", () => {
		const lo = make({ recordsPerSource: 2 })
		lo.note("a", at(C1, SPUR, T0), true)
		lo.note("b", at(C1, SPUR - 20_000, T0), true)
		expect(lo.historyDropped("rtl")).toBe(0)
		lo.note("c", at(C1, SPUR - 40_000, T0), true)
		expect(lo.remembers("rtl", "a")).toBe(false)
		expect(lo.remembers("rtl", "c")).toBe(true)
		expect(lo.historyDropped("rtl")).toBe(1)
	})

	it("mask lines: ignored until the dwell is settled, then a steady line", () => {
		const lo = make()
		let t = T0
		for (const c of SWEEP) {
			lo.tick("rtl", c, RATE, t)
			expect(
				lo.observeMask(at(c, SPUR, t + DQ_LO_LOCK_MASK_SETTLE_MS - 1)),
			).toBe(false)
			lo.tick("rtl", c, RATE, t + DQ_LO_LOCK_MASK_SETTLE_MS)
			expect(lo.observeMask(at(c, SPUR, t + DQ_LO_LOCK_MASK_SETTLE_MS))).toBe(
				true,
			)
			lo.tick("rtl", c, RATE, t + 10_000)
			t += 10_500
		}
		const s = at(SWEEP[2], SPUR, t - 500)
		expect(lo.check(s, all).verdict).toBe("locked")
	})

	it("mask lines: a mask under another centre than the current dwell is ignored", () => {
		const lo = make()
		lo.tick("rtl", C1, RATE, T0)
		lo.tick("rtl", C1, RATE, T0 + 5_000)
		expect(lo.observeMask(at(C1 + STEP, SPUR, T0 + 5_000))).toBe(false)
	})

	it("non-finite input is neither logged nor locked; sources past the cap are not remembered", () => {
		const lo = make({ sourcesMax: 1 })
		lo.observe(at(C1, SPUR, Number.NaN), false)
		expect(lo.check(at(C1, SPUR, Number.NaN), all).verdict).toBe("clear")
		sweep(lo, SWEEP, SPUR)
		expect(lo.learnedOffsets("rtl")).toEqual([SPUR])
		const other = (s: LoSighting): LoSighting => ({ ...s, sourceId: "other" })
		let t = T0
		for (const c of SWEEP) {
			for (let k = 0; k <= 10; k++) {
				const s = other(at(c, SPUR, t + k * 1_000))
				lo.observe(s, false)
				expect(lo.check(s, all).verdict).toBe("clear")
			}
			t += 10_500
		}
		expect(lo.learnedOffsets("other")).toEqual([])
	})

	it("bounds: dwells per source drop their oldest", () => {
		const lo = make({ dwellsPerSource: 2 })
		// three hops but only the last two dwells are remembered: never three centres
		const rs = sweep(lo, [...SWEEP, ...SWEEP], SPUR)
		for (const r of rs) expect(lockedIn(r)).toBe(false)
	})

	// Feature: scanner quiet-band quality, Property 1: a fixed RF emitter is never LO-locked
	// Validates: goal 1 (a real signal at a fixed absolute frequency seen from several centres)
	it("repro: a complete stay that ends with nothing at a learned offset revokes it at once (its flags lift); a shorter stay or another rate does not", () => {
		const far = C1 + 3 * STEP
		for (const [ms, rate, revoked] of [
			[DQ_LO_LOCK_DWELL_MS, RATE, true],
			[DQ_LO_LOCK_DWELL_MS - 1, RATE, false],
			[10_000, 2_048_000, false],
		] as const) {
			const lo = make()
			const rs = sweep(lo, SWEEP, SPUR)
			expect(lo.learnedOffsets("rtl")).toEqual([SPUR])
			lo.takeRevoked()
			const from = rs[2]!.end + 500
			// a fourth hop whose window covers the offset, nothing there
			lo.tick("rtl", far, rate, from)
			lo.tick("rtl", far, rate, from + ms)
			// still in the stay: nothing decided yet
			expect(lo.learnedOffsets("rtl")).toEqual([SPUR])
			// the tuner moves on: the stay is complete
			lo.tick("rtl", SWEEP[0], RATE, from + ms + 500)
			expect(lo.learnedOffsets("rtl")).toEqual(revoked ? [] : [SPUR])
			expect(lo.takeRevoked()).toEqual(
				revoked ? [{ sourceId: "rtl", rateHz: RATE, offsetHz: SPUR }] : [],
			)
		}
	})

	it("a stay that ends having seen the line at a learned offset (or something covering it) revokes nothing", () => {
		const lo = make()
		const rs = sweep(lo, [...SWEEP, C1 + 3 * STEP], SPUR)
		lo.tick("rtl", SWEEP[0], RATE, rs[3]!.end + 500)
		expect(lo.learnedOffsets("rtl")).toEqual([SPUR])
		expect(lo.takeRevoked()).toEqual([])
	})

	it("a sighting that cannot tell (steadiness undefined: young or ambiguous) neither revokes, nor overwrites the steady line, nor drops a partner", () => {
		const lo = make()
		const rs = sweep(lo, SWEEP, SPUR)
		lo.takeRevoked()
		const t = rs[2]!.end + 500
		const vague = at(SWEEP[0], SPUR, t, { steady: undefined })
		lo.observe(vague, false)
		lo.note(`r${SWEEP[0]}`, vague, false)
		expect(lo.check(vague, all).verdict).toBe("clear")
		expect(lo.takeRevoked()).toEqual([])
		expect(lo.learnedOffsets("rtl")).toEqual([SPUR])
		const steady = at(SWEEP[0], SPUR, t + 1_000)
		lo.observe(steady, false)
		const res = lo.check(steady, all)
		expect(res.verdict).toBe("locked")
		expect([...res.partners].sort()).toEqual(SWEEP.map(c => `r${c}`).sort())
	})

	it("adopt: a restored record is remembered with no sighting, a partner only once its sightings are the steady line", () => {
		const lo = make()
		expect(lo.adopt("rtl", "old")).toBe(true)
		expect(lo.remembers("rtl", "old")).toBe(true)
		const rs = sweep(lo, SWEEP, SPUR)
		expect(rs[2]!.partners.has("old")).toBe(false)
		const s = at(SWEEP[0], SPUR, rs[2]!.end + 500)
		lo.observe(s, false)
		lo.note("old", s, false)
		expect(lo.check(s, all).partners).toContain("old")
		// a later sighting that is no steady line: never a partner again
		lo.note(
			"old",
			at(SWEEP[0], SPUR, rs[2]!.end + 1_500, { steady: false }),
			false,
		)
		expect(lo.remembers("rtl", "old")).toBe(false)
		// past the source cap nothing is adopted
		const capped = make({ sourcesMax: 0 })
		expect(capped.adopt("rtl", "x")).toBe(false)
	})

	it("property: an emitter at a fixed RF frequency is never LO-locked by its own sightings", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: -400_000, max: 400_000 }),
				fc.array(fc.integer({ min: -80, max: 80 }), {
					minLength: 2,
					maxLength: 8,
				}),
				(offset, steps) => {
					const lo = make()
					const rf = C1 + offset
					let t = T0
					let first = true
					for (const k of steps) {
						const tuned = C1 + k * DQ_LO_LOCK_MIN_SEPARATION_HZ
						for (let i = 0; i <= 10; i++) {
							const s = at(tuned, rf - tuned, t)
							lo.tick("rtl", tuned, RATE, t)
							lo.observe(s, false)
							lo.note("real", s, first)
							first = false
							if (lo.check(s, all).verdict === "locked") return false
							t += 1_000
						}
					}
					return true
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: scanner quiet-band quality, Property 2: fewer than 3 distinct centres never lock
	// Validates: goal 1 (two real emitters at one offset under two centres stay unflagged)
	it("property: a line at one offset seen from at most 2 distinct centres is never LO-locked", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: -480_000, max: 480_000 }),
				fc.integer({ min: 1, max: 160 }),
				fc.array(fc.boolean(), { minLength: 2, maxLength: 8 }),
				fc.integer({ min: 1_000, max: 30_000 }),
				(offset, k, order, ms) => {
					const lo = make()
					const cs = [C1, C1 + k * DQ_LO_LOCK_MIN_SEPARATION_HZ]
					let t = T0
					const born = new Set<string>()
					for (const b of order) {
						const c = cs[b ? 1 : 0]!
						const r = dwell(
							lo,
							c,
							t,
							ms,
							[{ offsetHz: offset, id: `r${c}` }],
							born,
						)
						if (lockedIn(r) || r.partners.size > 0) return false
						t = r.end + 500
					}
					return lo.learnedOffsets("rtl").length === 0
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: scanner quiet-band quality, Property 3: a spur in a tiling sweep is learned
	// Validates: goal 1 (a receiver spur at a fixed offset is flagged in a sweep of any step)
	it("property: a steady line at one offset under 3 or more distinct far-apart hops is locked by the third", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: -480_000, max: 480_000 }),
				fc.integer({ min: 2, max: 200 }),
				fc.integer({ min: 1_000, max: 15_000 }),
				(offset, k, ms) => {
					fc.pre(Math.abs(offset) > DQ_LO_LOCK_DC_GUARD_HZ + 2_000)
					const step = k * DQ_LO_LOCK_MIN_SEPARATION_HZ
					const lo = make()
					const rs = sweep(lo, [C1, C1 + step, C1 + 2 * step], offset, { ms })
					return lockedIn(rs[2]!) && !lockedIn(rs[1]!)
				},
			),
			{ numRuns: 200 },
		)
	})
})
