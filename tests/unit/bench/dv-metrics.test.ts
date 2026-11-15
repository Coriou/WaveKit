/**
 * Digital voice capture metrics (scripts/bench/scanner-quality/dv-metrics.ts),
 * the adapter replay on a fake clock (dv-replay.ts), and the truth scorecard's
 * DV scenes and totals (truth-dv.ts, truth-score.ts), on in-process doubles:
 * hand-made calls and lines, and the provisional latency seeds.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	HOLD_MIN_MS,
	MATCH_LEAD_MS,
	MATCH_TAIL_MS,
	dvTable,
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
		expect(summarise(merged)).toMatchObject({ exactlyOne: 0, merged: 2 })
		const missed = scoreOvers(two, [call(1500, 2500)], [], checkedLine)
		expect(summarise(missed)).toMatchObject({ missed: 1, exactlyOne: 1 })
		expect(missed[1]).toMatchObject({ headCutMs: null, endErrMs: null })
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
			"| s | baseline | 20 dB | 0 Hz | 4 | 100.0 % | 0 | 0 | 0 | 700 / 700 | 40 / 400 | 720 | 10.0 % |",
		)
		expect(
			lines.filter(l => l.startsWith("| s | baseline | 20 dB")),
		).toHaveLength(1 + 4)
		expect(table).toContain(
			"| 1 | 1 | 2000 | 1 | no | 700 | 400 | n/a | 0/5 (no TLC) |",
		)
	})
})

const T = (lines: [number, string][]): DvLine[] =>
	lines.map(([atMs, text]) => ({ atMs, text }))

describe("replayDvLines", () => {
	it("starts a DMR call at its first TG/SRC line and ends it at the terminator", () => {
		const calls = replayDvLines(
			T([
				[100, "Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VC* "],
				[420, " SLOT 1 TGT=9 SRC=100 Group Call "],
				[780, "Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VC* "],
				[1500, "Sync: +DMR MS/DM MODE/MONO | Color Code=01 | TLC "],
				[1500, " SLOT 1 TGT=9 SRC=100 Group Call "],
			]),
			"auto",
		)
		expect(calls).toEqual([
			expect.objectContaining({
				startedAtMs: 420,
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
				[780, "Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VC* "],
				[1140, " SLOT 1 TGT=9 SRC=100 Group Call "],
			]),
			"auto",
		)
		expect(calls).toHaveLength(1)
		expect(calls[0]!.timeout).toBe(true)
		// 4 000 ms timeout + 500 ms timer < DV_IDLE_MS.
		expect(DV_IDLE_MS).toBeGreaterThan(4000 + 500)
	})
})

describe("truth DV scenes", () => {
	const cases = loadDvCases()

	it("load the seeds as digital-voice intervals with protocol and slot", () => {
		expect(cases.map(c => c.name)).toEqual([
			"dv-dmr-direct-gaps-other",
			"dv-dmr-direct-lengths",
			"dv-dmr-direct-no-terminator",
			"dv-dmr-repeater-gaps-same",
			"dv-dmr-repeater-hang-no-tlc",
			"dv-dmr-repeater-two-slots",
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

	it("score today's adapter on the provisional seeds", () => {
		const by = Object.fromEntries(
			cases.map(c => [c.name, summarise(runDvCase(c))]),
		)
		// Direct: the first decoded embedded LC starts the call, 727 ms after key-up.
		expect(by["dv-dmr-direct-lengths"]).toMatchObject({
			overs: 5,
			exactlyOne: 5,
		})
		// 60 + 360 + 4 x 60 + 27.5 + 40 ms of line latency (dv-latency-seeds.mjs).
		expect(by["dv-dmr-direct-lengths"]!.headCutP90Ms).toBeCloseTo(727.5, 0)
		// Hang-time idles refresh a call whose terminator was missed: one call, two overs.
		expect(by["dv-dmr-repeater-hang-no-tlc"]).toMatchObject({ merged: 2 })
		// Two busy slots: slot 1's call is split by slot 2's link control.
		expect(by["dv-dmr-repeater-two-slots"]).toMatchObject({ splits: 2 })
	})

	it("total into the scorecard and pass the checked-in limits", () => {
		const scores = cases.map(c => withTotals(dvCaseScore(c, runDvCase(c))))
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
			dvOvers: 19,
			dvMissed: 0,
			dvSplit: 2,
			dvMerged: 2,
			dvHeadCutP90Ms: 727,
			dvRecordingMissing: 19,
		})
		expect(card.failures).toEqual([])
		expect(formatScorecardLine(card)).toContain(
			"digital voice 19 overs: missed 0, split 2, merged 2, head cut p90 727 ms, no recording 19",
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
	})
})
