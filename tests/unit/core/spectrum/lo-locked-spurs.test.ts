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
	DQ_LO_LOCK_MIN_TRANSITIONS,
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
		minTransitions: DQ_LO_LOCK_MIN_TRANSITIONS,
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

/**
 * A spur-shaped chain: 10 s dwells (or `dwellMs`) at each centre but the last, 500 ms apart, the
 * line at `offsetHz` from each centre (records `r1` at C1, `r2` at the others), then the sighting at
 * the last centre checked `ms` after that dwell's first sighting (`last` overrides it only).
 */
function chain(
	lo: LoLockedSpurs,
	centres: readonly number[],
	offsetHz: number,
	opts: {
		ms?: number
		dwellMs?: number
		last?: Partial<LoSighting>
		from?: number
		over?: Partial<LoSighting>
	} = {},
) {
	let t = opts.from ?? T0
	for (const c of centres.slice(0, -1)) {
		t =
			dwellOn(lo, c, offsetHz, t, opts.dwellMs ?? 10_000, {
				id: c === C1 ? "r1" : "r2",
				...(opts.over === undefined ? {} : { over: opts.over }),
			}) + 500
	}
	const c = centres.at(-1)!
	const over = { ...opts.over, ...opts.last }
	lo.observe(at(c, offsetHz, t, over), false)
	const s = at(c, offsetHz, t + (opts.ms ?? DQ_LO_LOCK_DWELL_MS), over)
	const res = lo.check(s, all)
	lo.observe(s, false)
	return res
}

/** The minimal lock: C1, c2, C1, c2 (3 transitions), the last sighting checked after `ms`. */
function pair(
	lo: LoLockedSpurs,
	c2: number,
	offsetHz: number,
	ms = DQ_LO_LOCK_DWELL_MS,
	last: Partial<LoSighting> = {},
) {
	return chain(lo, [C1, c2, C1, c2], offsetHz, { ms, last })
}

/** Checks, then logs (and notes as `id`), a line once a second over [from, from + ms]. */
function dwellChecked(
	lo: LoLockedSpurs,
	tunedHz: number,
	offsetHz: number,
	from: number,
	ms: number,
	id: string,
): { end: number; verdicts: string[]; partners: string[] } {
	const verdicts: string[] = []
	const partners: string[] = []
	for (let t = from; t <= from + ms; t += 1_000) {
		const s = at(tunedHz, offsetHz, t)
		const res = lo.check(s, all)
		verdicts.push(res.verdict)
		partners.push(...res.partners)
		lo.observe(s, false)
		lo.note(id, s)
	}
	return { end: from + ms, verdicts, partners }
}

const CLEAR = { verdict: "clear", partners: [] }
/** When the chain C1, c2, C1, c2 locks: 3 dwells of 10 s, 500 ms apart, then the minimum dwell. */
const LOCK_AT = T0 + 3 * 10_000 + 3 * 500 + DQ_LO_LOCK_DWELL_MS

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
		// two emitters swapping at a retune with p = 0.1: three swaps in a row 1 in 1 000
		expect(DQ_LO_LOCK_MIN_TRANSITIONS).toBe(3)
		expect(0.1 ** DQ_LO_LOCK_MIN_TRANSITIONS).toBeCloseTo(1 / 1_000, 12)
	})

	it("repro: two real transmitters taking turns at one offset across one retune: clear, nothing retired", () => {
		// centres 25 kHz apart, each transmitter 100 kHz above its centre: both positions lie in
		// both windows. Only TX-A keys while tuned at A, only TX-B after the retune to B, on all along.
		const lo = make()
		const a = C1
		const b = C1 + 25_000
		const txA = dwellChecked(lo, a, 100_000, T0, 5_000, "txA")
		expect(new Set(txA.verdicts)).toEqual(new Set(["clear"]))
		const txB = dwellChecked(lo, b, 100_000, txA.end + 500, 60_000, "txB")
		expect(new Set(txB.verdicts)).toEqual(new Set(["clear"]))
		expect(txB.partners).toEqual([])
		expect(lo.learnedOffsets("rtl")).toEqual([])
		expect(lo.suppressed("rtl")).toBe(0)
	})

	it("two transitions (A, B, A) are not enough: every sighting clear, nothing retired", () => {
		const lo = make()
		let t = dwellChecked(lo, C1, SPUR, T0, 10_000, "r1").end + 500
		const second = dwellChecked(lo, C2, SPUR, t, 10_000, "r2")
		t = second.end + 500
		const third = dwellChecked(lo, C1, SPUR, t, 60_000, "r1")
		for (const d of [second, third]) {
			expect(new Set(d.verdicts)).toEqual(new Set(["clear"]))
			expect(d.partners).toEqual([])
		}
		expect(lo.learnedOffsets("rtl")).toEqual([])
	})

	it("three transitions (A, B, A, B), each window seeing the other position empty: pending until the dwell, then locked, earlier records retired", () => {
		const lo = make()
		let t = T0
		for (const [c, id] of [
			[C1, "r1"],
			[C2, "r2"],
			[C1, "r1"],
		] as const) {
			const d = dwellChecked(lo, c, SPUR, t, 10_000, id)
			// before the lock, every sighting is discovered as usual
			expect(new Set(d.verdicts)).toEqual(new Set(["clear"]))
			t = d.end + 500
		}
		expect(lo.check(at(C2, SPUR, t), all).verdict).toBe("pending")
		lo.observe(at(C2, SPUR, t), false)
		expect(
			lo.check(at(C2, SPUR, t + DQ_LO_LOCK_DWELL_MS - 1), all).verdict,
		).toBe("pending")
		const res = lo.check(at(C2, SPUR, t + DQ_LO_LOCK_DWELL_MS), all)
		expect(res.verdict).toBe("locked")
		expect([...res.partners].sort()).toEqual(["r1", "r2"])
		expect(lo.learnedOffsets("rtl")).toEqual([SPUR])
		expect(lo.suppressed("rtl")).toBe(1)
		// back at C1 (the records gone): the chain goes on, locked once the dwell there is long
		lo.forget("r1")
		lo.forget("r2")
		const t3 = dwellOn(lo, C2, SPUR, t, 8_000) + 500
		lo.observe(at(C1, SPUR, t3), false)
		expect(lo.check(at(C1, SPUR, t3 + DQ_LO_LOCK_DWELL_MS), all)).toEqual({
			verdict: "locked",
			partners: [],
		})
	})

	it("repro: a record whose non-steady history was overwritten by a steady line is never retired", () => {
		const lo = make()
		// an undecoded real emitter, sighted non-steady from C1 long before (past any revocation)
		lo.note("r1", at(C1, SPUR, T0 - 2 * DQ_LO_LOCK_TTL_MS, { steady: false }))
		expect(lo.isTainted("rtl", "r1")).toBe(false)
		const res = pair(lo, C2, SPUR)
		// the chain's steady sightings replaced that history: r1 is tainted, never a partner
		expect(lo.isTainted("rtl", "r1")).toBe(true)
		expect(res.verdict).toBe("locked")
		expect(res.partners).toEqual(["r2"])
	})

	it("a record whose history lost an entry to the per-record bound is never retired; forget clears it", () => {
		const lo = make({ centresPerRecord: 1 })
		lo.note("r1", at(C1 + 5_000_000, SPUR, T0 - 1_000))
		lo.note("r1", at(C1, SPUR, T0 - 500))
		expect(lo.isTainted("rtl", "r1")).toBe(true)
		lo.note("r9", at(C1, SPUR, T0 - 500))
		lo.note("r9", at(C1, SPUR, T0 - 400, { steady: undefined }))
		// a young sighting replaced by the same steady line is no contradiction
		expect(lo.isTainted("rtl", "r9")).toBe(false)
		lo.forget("r1")
		expect(lo.isTainted("rtl", "r1")).toBe(false)
	})

	it("a break resets the count: the old position still seen after a retune needs three new transitions", () => {
		const lo = make()
		let t = dwellOn(lo, C1, SPUR, T0, 10_000, { id: "r1" }) + 500
		t = dwellOn(lo, C2, SPUR, t, 10_000, { id: "r2" }) + 500
		// back at C1, C2's position C2 + SPUR is still there: this transition and the next break
		const e3 = dwellOn(lo, C1, SPUR, t, 10_000, { id: "r1" })
		lo.observe(at(C1, C2 - C1 + SPUR, e3 - 100), false)
		t = e3 + 500
		const verdicts: string[][] = []
		for (const [c, id] of [
			[C2, "r2"],
			[C1, "r1"],
			[C2, "r2"],
		] as const) {
			const d = dwellChecked(lo, c, SPUR, t, 10_000, id)
			verdicts.push([...new Set(d.verdicts)])
			t = d.end + 500
		}
		// 0, 1 and 2 concordant transitions since the break
		expect(verdicts).toEqual([["clear"], ["clear"], ["clear"]])
		// the third since the break locks
		const last = dwellChecked(lo, C1, SPUR, t, DQ_LO_LOCK_DWELL_MS, "r1")
		expect(last.verdicts.at(-1)).toBe("locked")
		expect(last.verdicts.slice(0, -1)).toEqual(
			last.verdicts.slice(0, -1).map(() => "pending"),
		)
	})

	it("a non-steady sighting in a dwell breaks the chain", () => {
		const lo = make()
		let t = dwellOn(lo, C1, SPUR, T0, 10_000, { id: "r1" }) + 500
		// the C2 line is modulated: no transition through it follows the LO
		t =
			dwellOn(lo, C2, SPUR, t, 10_000, {
				id: "r2",
				over: { steady: false },
			}) + 500
		t = dwellOn(lo, C1, SPUR, t, 10_000, { id: "r1" }) + 500
		lo.observe(at(C2, SPUR, t), false)
		expect(lo.check(at(C2, SPUR, t + DQ_LO_LOCK_DWELL_MS), all)).toEqual(CLEAR)
	})

	it("repro: two real emitters at one offset, the first window not covering the second: clear", () => {
		// 1.024 Msps, ±409.6 kHz usable: 400.1 MHz under 400 MHz, then 402.1 MHz under 402 MHz
		const a = 400_000_000
		const b = 402_000_000
		const lo = make()
		let t = T0
		for (const c of [a, b, a]) t = dwellOn(lo, c, 100_000, t, 10_000) + 500
		lo.observe(at(b, 100_000, t), false)
		for (const dt of [0, DQ_LO_LOCK_DWELL_MS, 60_000])
			expect(lo.check(at(b, 100_000, t + dt), all)).toEqual(CLEAR)
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

	it("dwell: earlier dwells at the minimum count, 1 ms shorter do not", () => {
		for (const [ms, want] of [
			[DQ_LO_LOCK_DWELL_MS, "locked"],
			[DQ_LO_LOCK_DWELL_MS - 1, "clear"],
		] as const)
			expect(
				chain(make(), [C1, C2, C1, C2], SPUR, { dwellMs: ms }).verdict,
			).toBe(want)
	})

	it("TTL: the oldest dwell's evidence holds for the TTL after its last sighting, not past it", () => {
		for (const [gap, want] of [
			[DQ_LO_LOCK_TTL_MS, "locked"],
			[DQ_LO_LOCK_TTL_MS + 1, "clear"],
		] as const) {
			const lo = make()
			const e1 = dwellOn(lo, C1, SPUR, T0, 10_000, { id: "r1" })
			let t = dwellOn(lo, C2, SPUR, e1 + 500, 10_000) + 500
			t = dwellOn(lo, C1, SPUR, t, 10_000) + 500
			lo.observe(at(C2, SPUR, t), false)
			expect(lo.check(at(C2, SPUR, e1 + gap), all).verdict).toBe(want)
		}
		// a learned offset expires with its TTL
		const lo = make()
		expect(pair(lo, C2, SPUR).verdict).toBe("locked")
		expect(lo.learnedOffsets("rtl", LOCK_AT + DQ_LO_LOCK_TTL_MS)).toEqual([
			SPUR,
		])
		expect(lo.learnedOffsets("rtl", LOCK_AT + DQ_LO_LOCK_TTL_MS + 1)).toEqual(
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
		const off = (d: number) =>
			pair(make(), C2, SPUR, undefined, { centreHz: C2 + SPUR + d }).verdict
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
		// a line at F2 seen from C1 in the dwell before the retune
		const lo = make()
		let t = dwellOn(lo, C1, SPUR, T0, 10_000, { id: "r1" }) + 500
		t = dwellOn(lo, C2, SPUR, t, 10_000) + 500
		const e3 = dwellOn(lo, C1, SPUR, t, 10_000, { id: "r1" })
		lo.observe(at(C1, C2 - C1 + SPUR, e3 - 100), false)
		lo.observe(at(C2, SPUR, e3 + 500), false)
		expect(
			lo.check(at(C2, SPUR, e3 + 500 + DQ_LO_LOCK_DWELL_MS), all).verdict,
		).toBe("clear")
		// a line at F1 seen from C2 now
		const lo2 = make()
		let t2 = dwellOn(lo2, C1, SPUR, T0, 10_000, { id: "r1" }) + 500
		t2 = dwellOn(lo2, C2, SPUR, t2, 10_000) + 500
		t2 = dwellOn(lo2, C1, SPUR, t2, 10_000) + 500
		lo2.observe(at(C2, SPUR, t2), false)
		lo2.observe(at(C2, C1 + SPUR - C2, t2 + 500), false)
		expect(lo2.check(at(C2, SPUR, t2 + DQ_LO_LOCK_DWELL_MS), all).verdict).toBe(
			"clear",
		)
	})

	it("only steady lines lock: a bursty or modulated sighting is clear, a young one pending", () => {
		expect(pair(make(), C2, SPUR, undefined, { steady: false }).verdict).toBe(
			"clear",
		)
		expect(
			pair(make(), C2, SPUR, undefined, { steady: undefined }).verdict,
		).toBe("pending")
		// partner lines that were never steady are no chain
		expect(
			chain(make(), [C1, C2, C1, C2], SPUR, {
				over: { steady: false },
				last: { steady: true },
			}).verdict,
		).toBe("clear")
	})

	it("a line with evidence of a real signal breaks the chain; an ineligible record is no partner", () => {
		const lo = make()
		let t = dwellOn(lo, C1, SPUR, T0, 10_000, { id: "r1" }) + 500
		t = dwellOn(lo, C2, SPUR, t, 10_000, { id: "r2", real: true }) + 500
		t = dwellOn(lo, C1, SPUR, t, 10_000, { id: "r1" }) + 500
		lo.observe(at(C2, SPUR, t), false)
		expect(lo.check(at(C2, SPUR, t + DQ_LO_LOCK_DWELL_MS), all)).toEqual(CLEAR)
		const lo2 = make()
		let t2 = T0
		for (const c of [C1, C2, C1])
			t2 = dwellOn(lo2, c, SPUR, t2, 10_000, { id: "r1" }) + 500
		lo2.observe(at(C2, SPUR, t2), false)
		expect(
			lo2.check(at(C2, SPUR, t2 + DQ_LO_LOCK_DWELL_MS), () => false),
		).toEqual({ verdict: "locked", partners: [] })
	})

	it("a record also sighted at another offset is no partner", () => {
		const lo = make()
		// r1: also sighted from C2 at its own RF line (C1 + SPUR), one RF line from two centres
		lo.note("r1", at(C2, C1 + SPUR - C2, T0 - 1_000))
		expect(pair(lo, C2, SPUR).partners).toEqual(["r2"])
	})

	it("revocation: evidence, a non-steady sighting or one RF line from two centres revokes a learned offset for the TTL", () => {
		const c3 = C2 + 100_000
		const cases: ((lo: LoLockedSpurs, t: number) => void)[] = [
			// control: a neutral sighting there, nothing contradicts, the offset stays learned
			(lo, t) => lo.observe(at(c3, 300_000, t), false),
			(lo, t) => lo.observe(at(c3, SPUR, t), true),
			(lo, t) => lo.observe(at(c3, SPUR, t, { steady: false }), false),
			// the line C2 + SPUR, seen again from a third centre at another offset
			(lo, t) => lo.observe(at(c3, C2 + SPUR - c3, t), false),
		]
		for (const [i, revoke] of cases.entries()) {
			const lo = make()
			expect(pair(lo, C2, SPUR).verdict).toBe("locked")
			const t = LOCK_AT + 1_000
			revoke(lo, t)
			expect(lo.learnedOffsets("rtl", t)).toEqual(i === 0 ? [SPUR] : [])
			// a fresh full chain after it: no lock while revoked
			expect(
				chain(lo, [C1, C2, C1, C2], SPUR, { from: t + 1_000 }).verdict,
			).toBe(i === 0 ? "locked" : "clear")
		}
	})

	it("a dwell with more lines than the bound proves no absence", () => {
		for (const [cap, want] of [
			[3, "locked"],
			[2, "clear"],
		] as const) {
			const lo = make({ linesPerDwell: cap })
			let t = dwellOn(lo, C1, SPUR, T0, 10_000) + 500
			t = dwellOn(lo, C2, SPUR, t, 10_000) + 500
			const e3 = dwellOn(lo, C1, SPUR, t, 10_000)
			lo.observe(at(C1, 300_000, e3 - 100), false)
			lo.observe(at(C1, -300_000, e3 - 50), false)
			lo.observe(at(C2, SPUR, e3 + 500), false)
			expect(
				lo.check(at(C2, SPUR, e3 + 500 + DQ_LO_LOCK_DWELL_MS), all).verdict,
			).toBe(want)
		}
	})

	it("non-finite input is neither logged nor locked; sources past the cap are not remembered", () => {
		const lo = make({ sourcesMax: 1 })
		lo.observe({ ...at(C1, SPUR, T0), centreHz: Number.NaN }, false)
		expect(lo.check({ ...at(C2, SPUR, T0), sampleRateHz: 0 }, all)).toEqual(
			CLEAR,
		)
		dwellOn(lo, C1, SPUR, T0 - 20_000, 10_000)
		const other = { over: { sourceId: "other" } }
		expect(chain(lo, [C1, C2, C1, C2], SPUR, other).verdict).toBe("clear")
		expect(
			chain(make({ sourcesMax: 2 }), [C1, C2, C1, C2], SPUR, other).verdict,
		).toBe("locked")
		expect(
			lo.check({ ...at(C2, SPUR, LOCK_AT), tunedHz: Number.NaN }, all).verdict,
		).toBe("clear")
	})

	it("bounds: dwells, records and centres per record drop their oldest", () => {
		// a lock needs 4 dwells (3 transitions): 3 kept is not enough
		expect(pair(make({ dwellsPerSource: 4 }), C2, SPUR).verdict).toBe("locked")
		expect(pair(make({ dwellsPerSource: 3 }), C2, SPUR).verdict).toBe("clear")
		// records: the least recently sighted dropped once newer records were noted
		const recs = (n: number) => {
			const lo = make({ recordsPerSource: n })
			let t = dwellOn(lo, C1, SPUR, T0, 10_000, { id: "r1" }) + 500
			t = dwellOn(lo, C2, SPUR, t, 10_000, { id: "r2" }) + 500
			t = dwellOn(lo, C1, SPUR, t, 10_000, { id: "r1" })
			lo.note("a", at(C1, 300_000, t))
			lo.note("b", at(C1, -300_000, t))
			lo.observe(at(C2, SPUR, t + 500), false)
			return [
				...lo.check(at(C2, SPUR, t + 500 + DQ_LO_LOCK_DWELL_MS), all).partners,
			].sort()
		}
		expect(recs(4)).toEqual(["r1", "r2"])
		expect(recs(3)).toEqual(["r1"])
		expect(recs(2)).toEqual([])
		// centres: r1's sighting at another offset is never a partner, kept or evicted (an evicted
		// entry leaves the record tainted)
		const cpr = (n: number) => {
			const lo = make({ centresPerRecord: n })
			lo.note("r1", at(C1 + 100_000, 20_000, T0 - 1_000))
			return [...pair(lo, C2, SPUR).partners].sort()
		}
		expect(cpr(1)).toEqual(["r2"])
		expect(cpr(2)).toEqual(["r2"])
	})

	// Feature: scanner quiet-band quality, Property 1: a fixed RF emitter is never LO-locked
	// Validates: goal 1 (a real signal at a fixed absolute frequency seen from several centres)
	it("property: an emitter at a fixed RF frequency is never LO-locked by its own sightings", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: -400_000, max: 400_000 }),
				fc.array(fc.integer({ min: -40, max: 40 }), {
					minLength: 2,
					maxLength: 8,
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
					let t = T0
					for (const c of [C1, c2, C1, c2, C1])
						for (const end = t + 10_000; t <= end; t += 1_000) {
							const s = at(c, offset, t)
							if (lo.check(s, all).verdict === "locked") return false
							lo.observe(s, false)
						}
					return true
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: scanner quiet-band quality, Property 3: fewer than 3 retune transitions never lock
	// Validates: goal 1 (transmitters taking turns at one offset across retunes stay discovered)
	it("property: a line at one offset through 1 or 2 retunes is never LO-locked, nothing retired", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: -380_000, max: 380_000 }),
				fc.array(fc.integer({ min: -24, max: 24 }), {
					minLength: 2,
					maxLength: 3,
				}),
				fc.integer({ min: DQ_LO_LOCK_DWELL_MS, max: 30_000 }),
				(offset, steps, ms) => {
					const lo = make()
					let t = T0
					for (const [i, k] of steps.entries()) {
						const tuned = C1 + k * DQ_LO_LOCK_MIN_SEPARATION_HZ * 2
						const d = dwellChecked(lo, tuned, offset, t, ms, `r${i}`)
						if (d.verdicts.includes("locked") || d.partners.length > 0)
							return false
						t = d.end + 500
					}
					return lo.learnedOffsets("rtl").length === 0
				},
			),
			{ numRuns: 200 },
		)
	})
})
