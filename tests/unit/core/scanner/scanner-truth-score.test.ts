import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	loadTruthDir,
	parseThresholds,
	parseTruthFile,
	type TruthInterval,
} from "../../../../scripts/bench/scanner-quality/truth-labels.js"
import type {
	RecordingRecord,
	TruthCase,
	TruthRun,
} from "../../../../scripts/bench/scanner-quality/truth-run.js"
import { captureCase } from "../../../../scripts/bench/scanner-quality/truth-run.js"
import {
	EDGE_TOLERANCE_MS,
	formatScorecardLine,
	scoreCase,
	scorecard,
} from "../../../../scripts/bench/scanner-quality/truth-score.js"
import type { DiscoveryRecord } from "../../../../scripts/bench/scanner-quality/harness.js"

const F = 455_106_250

const iv = (
	label: TruthInterval["label"],
	startMs: number,
	endMs: number,
	frequencyHz = F,
): TruthInterval => ({
	frequencyHz,
	startMs,
	endMs,
	label,
	source: "synthetic",
	confirmed: true,
})

const kept = (
	startMs: number,
	durationMs: number,
	targetHz = F,
	extra: Partial<RecordingRecord> = {},
): RecordingRecord => ({
	operationId: `op-${startMs}-${targetHz}`,
	discoveryId: "d_1",
	targetHz,
	startMs,
	durationMs,
	outcome: "finalized",
	onDisk: true,
	...extra,
})

const disc = (
	centreHz: number,
	protocol: string,
	cls: string,
	id = "d_1",
): DiscoveryRecord => ({
	id,
	createdMs: 0,
	lastEventMs: 0,
	centreHz,
	frequencyHz: centreHz,
	bandwidthHz: 11_000,
	class: cls,
	protocol,
	hint: null,
	observationCount: 1,
	firstClassMs: {},
	gone: false,
	mergedInto: null,
})

const caseOf = (intervals: TruthInterval[], complete = true): TruthCase => ({
	name: "t",
	kind: "synthetic",
	rateHz: 1_024_000,
	centreHz: 455_000_000,
	complete,
	intervals,
	decodes: [],
	open: () => {
		throw new Error("not run")
	},
})

const runOf = (
	recordings: RecordingRecord[],
	discoveries: DiscoveryRecord[] = [],
): TruthRun => ({
	recordings,
	discoveries,
	finalIds: discoveries.map(d => d.id),
	decodes: {
		ambient: 0,
		probe: 0,
		replay: 0,
		dropped: 0,
		replays: 0,
		replayDecoded: 0,
	},
	decisions: {},
	iqSeconds: 1,
	wallSeconds: 1,
	busyOverruns: 0,
	trace: [],
})

const limits = (l: Record<string, number>) => ({
	version: 1 as const,
	limits: Object.fromEntries(Object.entries(l).map(([k, max]) => [k, { max }])),
})

describe("truth scorecard: kept files", () => {
	it("counts a kept file over a DMR or POCSAG label as digital false voice", () => {
		const s = scoreCase(
			caseOf([iv("dmr", 1_000, 5_000), iv("pocsag", 8_000, 12_000)]),
			runOf([kept(700, 4_500), kept(7_500, 5_000)]),
		)
		expect(s.totals.falseVoice).toBe(2)
		expect(s.totals.digitalKeptAsVoice).toBe(2)
		expect(s.totals.falseVoiceByLabel).toEqual({ dmr: 1, pocsag: 1 })
	})

	it("counts noise and carriers as false voice but not as digital", () => {
		const s = scoreCase(
			caseOf([iv("noise", 0, 5_000), iv("carrier", 6_000, 9_000)]),
			runOf([kept(0, 5_000), kept(6_000, 3_000)]),
		)
		expect(s.totals.falseVoice).toBe(2)
		expect(s.totals.digitalKeptAsVoice).toBe(0)
	})

	it("labels a file by the interval it overlaps most on its channel", () => {
		const s = scoreCase(
			caseOf([iv("analog-voice", 0, 6_000), iv("dmr", 5_500, 9_000)]),
			runOf([kept(0, 6_200)]),
		)
		expect(s.kept[0]!.label).toBe("analog-voice")
		expect(s.totals.falseVoice).toBe(0)
	})

	it("matches a label only on the file's channel (half a 12.5 kHz channel)", () => {
		const near = scoreCase(
			caseOf([iv("dmr", 0, 5_000)]),
			runOf([kept(0, 5_000, F + 6_250)]),
		)
		expect(near.kept[0]!.label).toBe("dmr")
		const far = scoreCase(
			caseOf([iv("dmr", 0, 5_000)], false),
			runOf([kept(0, 5_000, F + 6_251)]),
		)
		expect(far.kept[0]!.label).toBe("unmatched")
	})

	it("counts an unmatched file as false voice only when the labels are complete", () => {
		const r = runOf([kept(0, 3_000, F + 100_000)])
		expect(scoreCase(caseOf([], true), r).totals.falseVoice).toBe(1)
		const partial = scoreCase(caseOf([], false), r)
		expect(partial.totals.falseVoice).toBe(0)
		expect(partial.totals.unmatchedKept).toBe(1)
	})

	it("scores only finalized files still on disk", () => {
		const s = scoreCase(
			caseOf([iv("dmr", 0, 5_000)]),
			runOf([
				kept(0, 5_000, F, { outcome: "aborted" }),
				kept(0, 5_000, F, { onDisk: false, operationId: "b" }),
				kept(0, 5_000, F, { outcome: "pending", operationId: "c" }),
			]),
		)
		expect(s.totals.keptFiles).toBe(0)
		expect(s.totals.falseVoice).toBe(0)
	})

	it("ignores unknown labels either way", () => {
		const s = scoreCase(
			caseOf([iv("unknown", 0, 5_000)]),
			runOf([kept(0, 5_000)]),
		)
		expect(s.totals.falseVoice).toBe(0)
		expect(s.totals.labelledSignals).toBe(0)
	})
})

describe("truth scorecard: voice recorded whole", () => {
	const voice = iv("analog-voice", 2_000, 10_000)

	it("is whole when one file holds it within the edge tolerance", () => {
		const s = scoreCase(
			caseOf([voice]),
			runOf([kept(2_000 + EDGE_TOLERANCE_MS, 8_000 - 2 * EDGE_TOLERANCE_MS)]),
		)
		expect(s.voice[0]!.recorded).toBe("whole")
		expect(s.totals.missedVoice).toBe(0)
	})

	it("is missed when the file starts past the tolerance", () => {
		const s = scoreCase(
			caseOf([voice]),
			runOf([kept(2_000 + EDGE_TOLERANCE_MS + 1, 8_000)]),
		)
		expect(s.voice[0]!.recorded).toBe("partial")
		expect(s.totals.missedVoice).toBe(1)
	})

	it("is missed and split when two files hold it only together", () => {
		const s = scoreCase(
			caseOf([voice]),
			runOf([kept(1_500, 4_000), kept(5_600, 5_000)]),
		)
		expect(s.voice[0]!.recorded).toBe("split")
		expect(s.totals.missedVoice).toBe(1)
		expect(s.totals.splitVoice).toBe(1)
	})

	it("is none when nothing on its channel was kept", () => {
		const s = scoreCase(
			caseOf([voice]),
			runOf([kept(2_000, 8_000, F + 25_000)]),
		)
		expect(s.voice[0]!.recorded).toBe("none")
	})
})

describe("truth scorecard: identify verdicts", () => {
	it("is right when the discovery names the label's protocol", () => {
		const s = scoreCase(
			caseOf([iv("pocsag", 0, 4_000), iv("pocsag", 9_000, 13_000)]),
			runOf([], [disc(F + 200, "pocsag", "fsk2-wide")]),
		)
		expect(s.identify).toEqual([
			expect.objectContaining({
				label: "pocsag",
				intervals: 2,
				verdict: "right",
			}),
		])
	})

	it("is wrong when it names another protocol, unidentified when it names none", () => {
		const wrong = scoreCase(
			caseOf([iv("dmr", 0, 4_000)]),
			runOf([], [disc(F, "analog-fm", "analog-fm")]),
		)
		expect(wrong.identify[0]!.verdict).toBe("wrong")
		const none = scoreCase(
			caseOf([iv("dmr", 0, 4_000)]),
			runOf([], [disc(F, "unknown", "fsk4-12k5")]),
		)
		expect(none.identify[0]!.verdict).toBe("unidentified")
		const missing = scoreCase(caseOf([iv("dmr", 0, 4_000)]), runOf([]))
		expect(missing.identify[0]!.verdict).toBe("unidentified")
	})

	it("takes a carrier as right without a protocol, noise as right unless named", () => {
		const s = scoreCase(
			caseOf([iv("carrier", 0, 4_000), iv("noise", 0, 4_000, F + 50_000)]),
			runOf(
				[],
				[
					disc(F, "unknown", "carrier"),
					disc(F + 50_000, "analog-fm", "analog-fm", "d_2"),
				],
			),
		)
		expect(s.identify.map(i => [i.label, i.verdict])).toEqual([
			["carrier", "right"],
			["noise", "wrong"],
		])
	})

	it("ignores discoveries that are gone or not listed", () => {
		const gone = { ...disc(F, "dmr", "fsk4-12k5"), gone: true }
		const s = scoreCase(caseOf([iv("dmr", 0, 4_000)]), runOf([], [gone]))
		expect(s.identify[0]!.verdict).toBe("unidentified")
	})
})

describe("truth scorecard: totals and limits", () => {
	const one = scoreCase(caseOf([iv("dmr", 0, 5_000)]), runOf([kept(0, 5_000)]))

	it("fails at one past a limit and passes at it", () => {
		const fail = scorecard([one, one], limits({ digitalKeptAsVoice: 1 }))
		expect(fail.pass).toBe(false)
		expect(fail.failures).toEqual([
			{ metric: "digitalKeptAsVoice", value: 2, max: 1 },
		])
		expect(scorecard([one], limits({ digitalKeptAsVoice: 1 })).pass).toBe(true)
	})

	it("adds totals over cases, labels included", () => {
		const s = scorecard([one, one], limits({}))
		expect(s.totals.cases).toBe(2)
		expect(s.totals.falseVoiceByLabel).toEqual({ dmr: 2 })
	})

	it("refuses a limit on a metric the scorecard has not", () => {
		expect(() => scorecard([one], limits({ notAMetric: 0 }))).toThrow(
			/unknown metric/,
		)
		expect(() => scorecard([one], limits({ falseVoiceByLabel: 0 }))).toThrow(
			/unknown metric/,
		)
	})

	it("prints one line with the verdict", () => {
		const line = formatScorecardLine(
			scorecard([one], limits({ digitalKeptAsVoice: 0 })),
		)
		expect(line.split("\n")).toHaveLength(1)
		expect(line).toContain("false voice 1 (digital 1)")
		expect(line).toContain("FAIL (digitalKeptAsVoice 1 > 0)")
	})
})

describe("truth labels", () => {
	const file = {
		version: 1,
		capture: "a.cu8",
		centreHz: 455_000_000,
		rateHz: 1_024_000,
		durationMs: 10_000,
		intervals: [
			{
				frequencyHz: F,
				startMs: 0,
				endMs: 1_000,
				label: "dmr",
				source: "decoded-offline",
				confirmed: true,
			},
		],
	}

	it("parses a truth file and defaults complete and decodes", () => {
		const t = parseTruthFile("x", JSON.stringify(file))
		expect(t.complete).toBe(false)
		expect(t.decodes).toEqual([])
	})

	it("refuses a malformed file with its path and the issue", () => {
		expect(() => parseTruthFile("p.json", "{")).toThrow("p.json: not JSON")
		const bad = {
			...file,
			intervals: [{ ...file.intervals[0], label: "voice" }],
		}
		expect(() => parseTruthFile("p.json", JSON.stringify(bad))).toThrow(
			/^p\.json: intervals\.0\.label/,
		)
		const backwards = {
			...file,
			intervals: [{ ...file.intervals[0], startMs: 5, endMs: 5 }],
		}
		expect(() => parseTruthFile("p.json", JSON.stringify(backwards))).toThrow(
			/ends after it starts/,
		)
		expect(() =>
			parseTruthFile("p.json", JSON.stringify({ ...file, extra: 1 })),
		).toThrow(/p\.json/)
	})

	it("loads a directory's truth files with their captures, in name order", () => {
		const dir = mkdtempSync(join(tmpdir(), "wk-truth-test-"))
		try {
			mkdirSync(join(dir, "iq"))
			writeFileSync(join(dir, "iq", "a.cu8"), Buffer.alloc(4))
			writeFileSync(
				join(dir, "b.truth.json"),
				JSON.stringify({ ...file, capture: "iq/a.cu8" }),
			)
			writeFileSync(
				join(dir, "a.truth.json"),
				JSON.stringify({ ...file, capture: join(dir, "iq", "a.cu8") }),
			)
			writeFileSync(join(dir, "notes.json"), "{}")
			const loaded = loadTruthDir(dir)
			expect(loaded.map(t => t.name)).toEqual(["a", "b"])
			expect(loaded[1]!.capturePath).toBe(join(dir, "iq", "a.cu8"))
			writeFileSync(
				join(dir, "c.truth.json"),
				JSON.stringify({ ...file, capture: "missing.cu8" }),
			)
			expect(() => loadTruthDir(dir)).toThrow(
				/c\.truth\.json: capture not found/,
			)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("parses the checked-in thresholds", async () => {
		const { readFileSync } = await import("node:fs")
		const path = "scripts/bench/scanner-quality/truth-thresholds.json"
		const t = parseThresholds(path, readFileSync(path, "utf8"))
		expect(t.limits["digitalKeptAsVoice"]).toBeDefined()
		// Every limit names a scorecard total.
		expect(() => scorecard([], t)).not.toThrow()
	})

	it("shifts a capture's labels and decodes by the lead-in and keeps decodes inside it", () => {
		const c = captureCase({
			name: "c",
			path: "/nowhere.cu8",
			rateHz: 1_024_000,
			centreHz: 455_000_000,
			durationMs: 10_000,
			startedAtMs: null,
			complete: false,
			intervals: [
				iv("dmr", 500, 2_000),
				iv("dmr", 0, 900),
				iv("dmr", 9_000, 12_000),
			],
			decodes: [
				{ atMs: -100, frequencyHz: F, protocol: "dmr", via: "ambient" },
				{ atMs: 1_500, frequencyHz: F, protocol: "dmr", via: "ambient" },
				{ atMs: 10_000, frequencyHz: F, protocol: "dmr", via: "ambient" },
				{ atMs: 10_001, frequencyHz: F, protocol: "dmr", via: "ambient" },
			],
		})
		expect(c.intervals.map(i => [i.startMs, i.endMs])).toEqual([
			[0, 1_000],
			[8_000, 9_000],
		])
		expect(c.decodes.map(d => d.atMs)).toEqual([500, 9_000])
	})
})
