/**
 * Digital voice capture metrics (scripts/bench/scanner-quality/dv-metrics.ts),
 * the adapter replay on a fake clock (dv-replay.ts), and the truth scorecard's
 * DV scenes and totals (truth-dv.ts, truth-score.ts), on in-process doubles:
 * hand-made calls and lines, and the provisional latency seeds.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DV_FRAME_MS,
	DV_LONG_OVER_MS,
	HOLD_MIN_MS,
	MATCH_LEAD_MS,
	MATCH_TAIL_MS,
	dvTable,
	falseCalls,
	holdsOf,
	percentile,
	scoreOvers,
	summarise,
	type DvCall,
	type DvLine,
	type DvOver,
} from "../../../scripts/bench/scanner-quality/dv-metrics.js"
import {
	DV_IDLE_MS,
	checkedLine,
	replayDvLines,
} from "../../../scripts/bench/scanner-quality/dv-replay.js"
import {
	dvCaseScore,
	dvIntervals,
	loadDvCases,
	parseDvSeed,
	runDvCase,
	runDvScene,
} from "../../../scripts/bench/scanner-quality/truth-dv.js"
import {
	parseThresholds,
	TruthIntervalSchema,
} from "../../../scripts/bench/scanner-quality/truth-labels.js"
import {
	formatScorecardLine,
	scorecard,
	withTotals,
} from "../../../scripts/bench/scanner-quality/truth-score.js"
import { readFileSync } from "node:fs"

const over = (
	index: number,
	startMs: number,
	endMs: number,
	extra: Partial<DvOver> = {},
): DvOver => ({
	index,
	protocol: "dmr",
	slot: 1,
	startMs,
	endMs,
	frames: 5,
	terminator: true,
	ids: { talkgroup: 4321 },
	...extra,
})

const call = (
	startedAtMs: number,
	endedAtMs: number,
	extra: Partial<DvCall> = {},
): DvCall => ({
	startedAtMs,
	endedAtMs,
	slot: 1,
	talkgroup: 4321,
	source: 1,
	wavFile: false,
	timeout: false,
	...extra,
})

const slotLine = (atMs: number, slot = 1, tg = 4321): DvLine => ({
	atMs,
	text: ` SLOT ${slot} TGT=${tg} SRC=1234567 Group Call `,
})

describe("scoreOvers", () => {
	const two = [over(0, 1000, 3000), over(1, 3200, 5200)]

	it("scores one call per over: head cut, end error, first checked frame", () => {
		const rows = scoreOvers(
			two,
			[call(1700, 3040), call(3900, 5240)],
			[slotLine(1720), slotLine(2800), slotLine(3920)],
			checkedLine,
		)
		expect(rows.map(r => [r.calls, r.splits, r.merged])).toEqual([
			[1, 0, false],
			[1, 0, false],
		])
		expect(rows[0]).toMatchObject({
			headCutMs: 700,
			endErrMs: 40,
			tFirstMs: 720,
			framesChecked: 2,
			framesSent: 5,
		})
		expect(rows[1]!.framesChecked).toBe(1)
	})

	it("counts a split, a merge and a miss", () => {
		const split = scoreOvers(
			two,
			[call(1200, 1900), call(2100, 3000), call(3300, 5200)],
			[],
			checkedLine,
		)
		expect(split.map(r => r.splits)).toEqual([1, 0])
		const merged = scoreOvers(two, [call(1500, 5000)], [], checkedLine)
		expect(merged.map(r => [r.calls, r.merged])).toEqual([
			[1, true],
			[1, true],
		])
		expect(summarise(merged)).toMatchObject({
			exactlyOne: 0,
			merged: 2,
			// A merged over's head cut is the other over's call: not timed.
			headCutP50Ms: null,
			headCutP90Ms: null,
			endErrAllP90Ms: null,
		})
		const missed = scoreOvers(two, [call(1500, 2500)], [], checkedLine)
		expect(summarise(missed)).toMatchObject({ missed: 1, exactlyOne: 1 })
		expect(missed[1]).toMatchObject({ headCutMs: null, endErrMs: null })
	})

	it("misses an over its calls overlap by less than min(HOLD_MIN_MS, half the over)", () => {
		const o = [over(0, 1000, 3000)]
		// A 0 ms call at a late terminator line, given to the over by the widened span.
		const late = scoreOvers(o, [call(3100, 3100)], [], checkedLine)
		expect(late[0]).toMatchObject({ calls: 1, heldMs: 0, missed: true })
		expect(summarise(late)).toMatchObject({
			missed: 1,
			exactlyOne: 0,
			headCutP90Ms: null,
			endErrAllP90Ms: null,
		})
		// At the bound (200 ms of a 2 s over) held; 1 ms short missed.
		const at = scoreOvers(o, [call(2800, 3000)], [], checkedLine)
		expect(at[0]).toMatchObject({ heldMs: HOLD_MIN_MS, missed: false })
		const short = scoreOvers(o, [call(2801, 3000)], [], checkedLine)
		expect(short[0]).toMatchObject({ calls: 1, missed: true })
		// A 300 ms over needs half of itself, 150 ms, summed over its calls.
		const brief = [over(0, 1000, 1300)]
		expect(
			scoreOvers(brief, [call(1150, 1300)], [], checkedLine)[0]!.missed,
		).toBe(false)
		expect(
			scoreOvers(brief, [call(1151, 1300)], [], checkedLine)[0]!.missed,
		).toBe(true)
		expect(
			scoreOvers(
				brief,
				[call(1000, 1075), call(1225, 1300)],
				[],
				checkedLine,
			)[0]!.missed,
		).toBe(false)
	})

	it("times only overs neither merged nor missed, and totals the end error of all of them", () => {
		const o = [
			over(0, 1000, 3000),
			over(1, 6000, 8000, { terminator: false }),
			over(2, 8200, 10_200),
			over(3, 10_400, 12_400),
		]
		// Over 0: 700 / +40; over 1: 300 / +400; overs 2 and 3 one call (merged, 5 000 head cut ignored).
		const rows = scoreOvers(
			o,
			[call(1700, 3040), call(6300, 8400 - 200 + 1), call(8200, 12_500)],
			[],
			checkedLine,
		)
		expect(rows.map(r => r.merged)).toEqual([false, false, true, true])
		const s = summarise(rows)
		expect(s.headCutP90Ms).toBe(700)
		expect(s.headCutP50Ms).toBe(300)
		expect(s.endErrP90Ms).toBe(40)
		expect(s.endErrNoTermP90Ms).toBe(201)
		expect(s.endErrAllP90Ms).toBe(201)
	})

	it("holds an over only by HOLD_MIN_MS of overlap, at the bound and below it", () => {
		const o = [over(0, 1000, 3000), over(1, 3200, 5200)]
		// The previous call's tail runs HOLD_MIN_MS into the next over: holds it.
		expect(holdsOf(o, [call(1500, 3200 + HOLD_MIN_MS)])).toEqual([[0, 1]])
		expect(holdsOf(o, [call(1500, 3200 + HOLD_MIN_MS - 1)])).toEqual([[0]])
		// A short over needs half of itself: 300 ms, so 150 ms.
		const short = [over(0, 0, 1000), over(1, 1100, 1400)]
		expect(holdsOf(short, [call(500, 1250)])).toEqual([[0, 1]])
		expect(holdsOf(short, [call(500, 1249)])).toEqual([[0]])
	})

	it("gives a call that overlaps no over to the nearest within the widened span", () => {
		const o = [over(0, 1000, 2000)]
		// A 0 ms call at a terminator line after key-down: at the tail bound and past it.
		expect(
			holdsOf(o, [call(2000 + MATCH_TAIL_MS, 2000 + MATCH_TAIL_MS)]),
		).toEqual([[0]])
		expect(
			holdsOf(o, [call(2001 + MATCH_TAIL_MS, 2001 + MATCH_TAIL_MS)]),
		).toEqual([[]])
		expect(
			holdsOf(o, [call(1000 - MATCH_LEAD_MS, 1000 - MATCH_LEAD_MS)]),
		).toEqual([[0]])
		expect(
			holdsOf(o, [call(999 - MATCH_LEAD_MS, 999 - MATCH_LEAD_MS)]),
		).toEqual([[]])
		// Another slot's call never holds it.
		expect(holdsOf(o, [call(1000, 2000, { slot: 2 })])).toEqual([[]])
	})

	it("counts a checked line for its nearest over only", () => {
		// The first over's terminator line lands in the second over's lead.
		const rows = scoreOvers(
			two,
			[call(1700, 3040), call(3900, 5240)],
			[slotLine(3040), slotLine(3900)],
			checkedLine,
		)
		expect(rows.map(r => r.tFirstMs)).toEqual([2040, 700])
		// A line with a CRC error, of another slot or another talkgroup is not checked.
		const o = over(0, 0, 1000)
		expect(checkedLine(" SLOT 1 TGT=4321 SRC=1 Group Call (CRC ERR) ", o)).toBe(
			false,
		)
		expect(checkedLine(slotLine(0, 2).text, o)).toBe(false)
		expect(checkedLine(slotLine(0, 1, 99).text, o)).toBe(false)
		expect(checkedLine(slotLine(0).text, o)).toBe(true)
	})

	it("keeps a late line with the over already on air until the next is one frame in", () => {
		// Re-keyed 0.2 s later with the same ids: the first over's terminator
		// line arrives 150 ms late, 50 ms before the second over's key-up.
		const late = scoreOvers(
			two,
			[call(1700, 3040), call(3900, 5240)],
			[slotLine(3150), slotLine(3900)],
			checkedLine,
		)
		expect(late.map(r => r.tFirstMs)).toEqual([2150, 700])
		expect(late.map(r => r.framesChecked)).toEqual([1, 1])
		// Inside the second over, short of one DMR frame: still the first's.
		const frame = DV_FRAME_MS["dmr"]!
		expect(frame).toBe(60)
		const short = scoreOvers(two, [], [slotLine(3200 + frame - 1)], checkedLine)
		expect(short.map(r => r.framesChecked)).toEqual([1, 0])
		// At one frame past its key-up the line is the second over's.
		const at = scoreOvers(two, [], [slotLine(3200 + frame)], checkedLine)
		expect(at.map(r => r.framesChecked)).toEqual([0, 1])
		// With no earlier over to keep it, a line before one frame is the first's own.
		const first = scoreOvers(two, [], [slotLine(1010)], checkedLine)
		expect(first.map(r => r.tFirstMs)).toEqual([10, null])
	})

	it("counts a clear over without a recording", () => {
		const rows = scoreOvers(
			two,
			[call(1700, 3040, { wavFile: true }), call(3900, 5240)],
			[],
			checkedLine,
		)
		expect(summarise(rows).recordingMissing).toBe(1)
		const encrypted = scoreOvers(
			[over(0, 1000, 3000, { clear: false })],
			[],
			[],
			checkedLine,
		)
		expect(summarise(encrypted).recordingMissing).toBe(0)
	})
})

describe("summarise missedLong", () => {
	it("counts a missed over asked for DV_LONG_OVER_MS (1 000 ms) or more, not one asked for less or unknown", () => {
		expect(DV_LONG_OVER_MS).toBe(1000)
		// No call at all: every over is missed.
		const rows = scoreOvers(
			[
				over(0, 0, 990, { nominalMs: 999 }),
				over(1, 2000, 2990, { nominalMs: 1000 }),
				over(2, 4000, 6000, { nominalMs: 2000 }),
				over(3, 7000, 9000),
			],
			[],
			[],
			() => false,
		)
		const s = summarise(rows)
		expect(s.missed).toBe(4)
		expect(s.missedLong).toBe(2)
	})
})

describe("percentile", () => {
	it("is the nearest rank", () => {
		expect(percentile([], 90)).toBeNull()
		expect(percentile([5], 90)).toBe(5)
		// Rank ceil(0.9 x 10) = 9.
		expect(percentile([10, 1, 2, 3, 4, 5, 6, 7, 8, 9], 90)).toBe(9)
		// Rank ceil(0.9 x 11) = 10.
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 90)).toBe(10)
	})

	// Feature: dv-capture, Property 2: a percentile is one of the values, ordered by p
	// Validates: dvHeadCutP90Ms (design section B)
	it("returns a value of the set, never less at a higher p", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: -10_000, max: 10_000 }), { minLength: 1 }),
				fc.integer({ min: 0, max: 100 }),
				fc.integer({ min: 0, max: 100 }),
				(xs, a, b) => {
					const lo = percentile(xs, Math.min(a, b))!
					const hi = percentile(xs, Math.max(a, b))!
					expect(xs).toContain(lo)
					expect(hi).toBeGreaterThanOrEqual(lo)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("dvTable", () => {
	it("writes one summary row per scene, variant, CNR and error, then every over", () => {
		const rows = scoreOvers(
			[over(0, 1000, 3000), over(1, 6000, 8000, { terminator: false })],
			[call(1700, 3040), call(6700, 8400)],
			[slotLine(1720)],
			checkedLine,
		)
		const table = dvTable([
			{
				scene: "s",
				variant: "baseline",
				cnrDb: 20,
				errorHz: 0,
				phase: 0,
				rows,
			},
			{
				scene: "s",
				variant: "baseline",
				cnrDb: 20,
				errorHz: 0,
				phase: 0.25,
				rows,
			},
		])
		const lines = table.split("\n")
		expect(lines[0]).toMatch(/^\| Scene \| Variant \| CNR/)
		expect(lines[2]).toBe(
			"| s | baseline | 20 dB | 0 Hz | 0 | 4 | 100.0 % | 0 | 0 | 0 | 700 / 700 | 40 / 400 | 720 | 10.0 % | 0 |",
		)
		expect(
			lines.filter(l => l.startsWith("| s | baseline | 20 dB")),
		).toHaveLength(1 + 4)
		expect(table).toContain(
			"| 1 | 1 | - | 2000 | 1 | no | 700 | 400 | n/a | 0/5 (no TLC) |  |",
		)
	})

	it("shows the nominal length, a missed over, a recorded exit and a failed point", () => {
		const rows = scoreOvers(
			[over(0, 1000, 2980, { nominalMs: 2000 }), over(1, 4000, 6000)],
			[call(1700, 3040), call(6100, 6100)],
			[],
			checkedLine,
		)
		const table = dvTable([
			{
				scene: "s",
				variant: "baseline",
				cnrDb: 20,
				errorHz: 0,
				phase: 0,
				rows,
				exit: "exit 3",
			},
			{
				scene: "s",
				variant: "baseline",
				cnrDb: 20,
				errorHz: 0,
				phase: 0.5,
				rows: [],
				error: "no | line\nat all",
			},
		])
		// One of two points failed; 1 of 2 overs missed.
		expect(table).toContain(
			"| s | baseline | 20 dB | 0 Hz | 1 | 2 | 50.0 % | 1 |",
		)
		expect(table).toContain("| 0 | 1 | 2000 | 1980 | 1 | no |")
		expect(table).toMatch(
			/\| 1 \| 1 \| - \| 2000 \| 1 \| no .*\| missed \(held 0 ms\); exit 3 \|$/m,
		)
		expect(table).toContain(
			"| s | baseline | 20 dB | 0 Hz | 0.5 | - | - | - | - | - | - | - | - | - | - | failed: no \\| line at all |",
		)
	})
})

const T = (lines: [number, string][]): DvLine[] =>
	lines.map(([atMs, text]) => ({ atMs, text }))

describe("replayDvLines", () => {
	it("starts a DMR call back-dated to its first voice sync, IDs attached, and ends it at the terminator", () => {
		const calls = replayDvLines(
			T([
				[100, "Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VC* "],
				[420, " SLOT 1 TGT=9 SRC=100 Group Call "],
				// One superframe (360 ms) on from the first sync: the same over.
				[820, "Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VC* "],
				[1500, "Sync: +DMR MS/DM MODE/MONO | Color Code=01 | TLC "],
				[1500, " SLOT 1 TGT=9 SRC=100 Group Call "],
			]),
			"auto",
		)
		expect(calls).toEqual([
			expect.objectContaining({
				startedAtMs: 100,
				endedAtMs: 1500,
				talkgroup: 9,
				source: 100,
				timeout: false,
				wavFile: false,
			}),
		])
		// The fake clock is gone afterwards.
		expect(Math.abs(Date.now() - new Date().getTime())).toBeLessThan(1000)
	})

	it("ends a call without its terminator by the timeout, inside DV_IDLE_MS", () => {
		const calls = replayDvLines(
			T([
				[100, "Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VC* "],
				[420, " SLOT 1 TGT=9 SRC=100 Group Call "],
				// One superframe (360 ms) on from the first sync: the same over.
				[820, "Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VC* "],
				[1140, " SLOT 1 TGT=9 SRC=100 Group Call "],
			]),
			"auto",
		)
		expect(calls).toHaveLength(1)
		expect(calls[0]!.timeout).toBe(true)
		// Back-dated to the first sync, ended at the last voice line.
		expect(calls[0]).toMatchObject({ startedAtMs: 100, endedAtMs: 1140 })
		// 4 000 ms timeout + 500 ms timer < DV_IDLE_MS.
		expect(DV_IDLE_MS).toBeGreaterThan(4000 + 500)
	})
})

describe("false calls", () => {
	const call = (startedAtMs: number, extra: Partial<DvCall> = {}): DvCall => ({
		startedAtMs,
		endedAtMs: startedAtMs + 700,
		slot: 1,
		talkgroup: null,
		source: null,
		wavFile: false,
		timeout: false,
		...extra,
	})

	it("are the identity-less calls that hold no over and are near none", () => {
		const overs = [over(0, 1000, 3000)]
		// Inside, within the widened span (MATCH_TAIL_MS after the end), past it, named.
		const calls = [
			call(1200),
			call(3000 + MATCH_TAIL_MS),
			call(3000 + MATCH_TAIL_MS + 1),
			call(9000, { talkgroup: 9, source: 100 }),
			call(9000, { talkgroup: 0, source: 0 }),
		]
		expect(falseCalls(overs, calls)).toEqual([calls[2], calls[4]])
		expect(falseCalls([], [call(0)])).toHaveLength(1)
	})

	it("the noise-sync scene of stray syncs starts no call", () => {
		const noise = loadDvCases().find(c => c.name === "dv-noise-sync")!
		expect(noise.seed.overs).toEqual([])
		expect(replayDvLines(noise.seed.lines, "auto")).toEqual([])
		expect(runDvScene(noise)).toEqual({ rows: [], dvFalse: 0 })
	})
})

describe("truth DV scenes", () => {
	const cases = loadDvCases()

	it("load the seeds as digital-voice intervals with protocol and slot", () => {
		expect(cases.map(c => c.name)).toEqual([
			"dv-dmr-direct-gaps-other",
			"dv-dmr-direct-lengths",
			"dv-dmr-direct-no-terminator",
			"dv-dmr-direct-rekey-no-tlc",
			"dv-dmr-repeater-gaps-same",
			"dv-dmr-repeater-hang-no-tlc",
			"dv-dmr-repeater-two-slots",
			"dv-noise-sync",
		])
		for (const c of cases)
			for (const iv of dvIntervals(c))
				expect(TruthIntervalSchema.safeParse(iv).success).toBe(true)
		expect(
			TruthIntervalSchema.safeParse({
				...dvIntervals(cases[0]!)[0],
				protocol: undefined,
			}).success,
		).toBe(false)
		expect(() => parseDvSeed("x.json", "{}")).toThrow(/x\.json: version/)
	})

	it("score the call-first adapter on the provisional seeds", () => {
		const by = Object.fromEntries(
			cases.map(c => [c.name, summarise(runDvCase(c))]),
		)
		// Direct: the call starts on the over's second clean voice sync,
		// back-dated to its first, so even the 0.5 s over (voice sync and
		// terminator) is held by exactly one call.
		expect(by["dv-dmr-direct-lengths"]).toMatchObject({
			overs: 5,
			exactlyOne: 5,
			missed: 0,
			missedLong: 0,
		})
		expect(cases.flatMap(c => runDvCase(c).filter(r => r.missed))).toEqual([])
		// The lost header burst (60) + 27.5 + 40 ms of line latency (dv-latency-seeds.mjs).
		expect(by["dv-dmr-direct-lengths"]!.headCutP90Ms).toBeCloseTo(127.5, 0)
		// Hang-time idles no longer hold a call whose terminator was missed.
		expect(by["dv-dmr-repeater-hang-no-tlc"]).toMatchObject({
			merged: 0,
			exactlyOne: 2,
		})
		// Two busy slots: one call per slot, concurrent, no split.
		expect(by["dv-dmr-repeater-two-slots"]).toMatchObject({
			splits: 0,
			exactlyOne: 2,
		})
		// The modelled re-key's first sync is on the lost over's superframe
		// grid and its header is lost: nothing in the lines splits it.
		expect(by["dv-dmr-direct-rekey-no-tlc"]).toMatchObject({ merged: 2 })
		// Without a terminator the call ends at its last voice line (40 ms latency).
		expect(by["dv-dmr-direct-no-terminator"]!.endErrNoTermP90Ms).toBeCloseTo(
			40,
			-1,
		)
	})

	it("total into the scorecard and pass the checked-in limits", () => {
		const scores = cases.map(c => {
			const run = runDvScene(c)
			return withTotals(dvCaseScore(c, run.rows, run.dvFalse))
		})
		const limits = parseThresholds(
			"truth-thresholds.json",
			readFileSync(
				new URL(
					"../../../scripts/bench/scanner-quality/truth-thresholds.json",
					import.meta.url,
				),
				"utf8",
			),
		)
		// Only the DV scenes: the other synthetic minimums do not apply.
		const card = scorecard(scores, limits, { subset: true })
		expect(card.byKind.synthetic).toMatchObject({
			dvOvers: 21,
			dvMissed: 0,
			dvMissedLong: 0,
			dvSplit: 0,
			dvMerged: 2,
			dvHeadCutP90Ms: 127,
			dvEndErrP90Ms: 40,
			dvRecordingMissing: 21,
			dvFalse: 0,
		})
		expect(card.failures).toEqual([])
		expect(formatScorecardLine(card)).toContain(
			"digital voice 21 overs: missed 0 (long 0), split 0, merged 2, head cut p90 127 ms, end error p90 40 ms, no recording 21, false calls 0",
		)
		// The false-call bar: at 0 it passes, one false call fails.
		expect(limits.limits.synthetic?.["dvFalse"]).toEqual({ max: 0 })
		const noise = cases.find(c => c.name === "dv-noise-sync")!
		const phantom = scorecard(
			[...scores, withTotals(dvCaseScore(noise, [], 1))],
			limits,
			{ subset: true },
		)
		expect(phantom.byKind.synthetic?.dvFalse).toBe(1)
		expect(phantom.failures.map(f => f.metric)).toEqual(["dvFalse"])
		// The miss and end error ratchets: at their limits they pass, past them they fail.
		expect(limits.limits.synthetic?.["dvMissed"]).toEqual({ max: 0 })
		expect(limits.limits.synthetic?.["dvMissedLong"]).toEqual({ max: 0 })
		expect(limits.limits.synthetic?.["dvEndErrP90Ms"]).toEqual({ max: 40 })
		const late = scorecard(
			[
				...scores,
				withTotals(
					dvCaseScore(cases[0]!, [
						// 3 more timed overs 5 s late: 3 of 22 timed end errors (rank 20 is 5 000 ms) move the p90.
						...[1, 2, 3].map(() => ({
							...runDvCase(cases[0]!)[1]!,
							endErrMs: 5000,
							recording: true,
						})),
						{ ...runDvCase(cases[0]!)[1]!, missed: true, recording: true },
					]),
				),
			],
			limits,
			{ subset: true },
		)
		// The missed copy was asked for 2 s: it is long too.
		expect(late.byKind.synthetic?.dvMissed).toBe(1)
		expect(late.byKind.synthetic?.dvMissedLong).toBe(1)
		expect(late.failures.map(f => f.metric).sort()).toEqual(
			["dvEndErrP90Ms", "dvMissed", "dvMissedLong"].sort(),
		)
		// One more split than the ratchet allows fails.
		const worse = scorecard(
			[
				...scores,
				withTotals(
					dvCaseScore(cases[0]!, [
						...runDvCase(cases[0]!).map(r => ({ ...r, calls: 2, splits: 1 })),
					]),
				),
			],
			limits,
			{ subset: true },
		)
		expect(worse.failures.map(f => f.metric)).toContain("dvSplit")
		// The merge ratchet: at its limit (2) it passes, one more merged over fails.
		expect(limits.limits.synthetic?.["dvMerged"]).toEqual({ max: 2 })
		const merged = scorecard(
			[
				...scores,
				withTotals(
					dvCaseScore(cases[0]!, [
						// Its recording held, so only the merge moves.
						{ ...runDvCase(cases[0]!)[0]!, merged: true, recording: true },
					]),
				),
			],
			limits,
			{ subset: true },
		)
		expect(merged.byKind.synthetic?.dvMerged).toBe(3)
		expect(merged.failures.map(f => f.metric)).toEqual(["dvMerged"])
	})
})
