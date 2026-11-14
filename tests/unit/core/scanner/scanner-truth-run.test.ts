import { describe, expect, it } from "vitest"
import { buildScene } from "../../../../scripts/bench/scanner-quality/scene.js"
import {
	REPLAY_MIN_HELD_MS,
	analogStats,
	heldBy,
	runTruthCase,
	syntheticCase,
	type Held,
	type TruthCase,
} from "../../../../scripts/bench/scanner-quality/truth-run.js"
import type { CaptureRecord } from "../../../../scripts/bench/scanner-quality/harness.js"
import {
	classifyAnalogTrial,
	isVoice,
} from "../../../../src/core/scanner/analog-trial.js"
import { judgeAnalogResult } from "../../../../src/core/iq-capture/analog-result.js"
import { truthOf } from "../../../../scripts/bench/scanner-quality/truth-scenes.js"
import { scoreCase } from "../../../../scripts/bench/scanner-quality/truth-score.js"
import type {
	TruthDecode,
	TruthInterval,
} from "../../../../scripts/bench/scanner-quality/truth-labels.js"

const CENTRE = 455_000_000

/**
 * 10 s at 1.024 Msps: a speech-like NFM over with CTCSS on one channel, and a DMR repeater keyed
 * on another with an always-on decoder's decode every 2 s while it is on the air.
 */
function smallCase() {
	const scene = buildScene({
		name: "small-truth",
		rateHz: 1_024_000,
		centreHz: CENTRE,
		durationMs: 10_000,
		seed: 20_261_301,
		noiseSigma: 0.03,
		signals: [
			{
				class: "nfm-speech",
				offsetHz: 156_250,
				snrDb: 20,
				intervals: [{ startMs: 1_000, endMs: 7_000 }],
			},
			{
				class: "dmr-bs",
				offsetHz: -193_750,
				snrDb: 20,
				intervals: [{ startMs: 1_000, endMs: 8_000 }],
			},
		],
	})
	const decodes: TruthDecode[] = [2_500, 4_500, 6_500].map(atMs => ({
		atMs,
		frequencyHz: CENTRE - 193_750,
		protocol: "dmr",
		via: "ambient",
	}))
	return syntheticCase(scene, truthOf(scene), decodes)
}

describe("truth scorecard: the recorder in the loop", () => {
	it("keeps the voice over whole, no DMR file, and gives the same scorecard twice", async () => {
		const c = smallCase()
		const first = await runTruthCase(c)
		const s = scoreCase(c, first)
		expect(first.decodes.ambient).toBe(3)
		expect(s.voice).toEqual([
			expect.objectContaining({
				startMs: 1_000,
				endMs: 7_000,
				recorded: "whole",
			}),
		])
		expect(s.kept.map(k => k.label)).toEqual(["analog-voice"])
		expect(s.totals.falseVoice).toBe(0)
		expect(first.unsettled).toBe(0)
		// The DMR repeater is decoded, so identify names it.
		expect(s.identify.find(i => i.label === "dmr")?.verdict).toBe("right")
		const again = scoreCase(c, await runTruthCase(c))
		expect(JSON.stringify(again)).toBe(JSON.stringify(s))
	}, 240_000)
})

describe("truth scorecard: replay decoder doubles", () => {
	const label = (
		l: TruthInterval["label"],
		startMs: number,
		endMs: number,
		extra: Partial<TruthInterval> = {},
	): TruthInterval => ({
		frequencyHz: CENTRE,
		startMs,
		endMs,
		label: l,
		source: "synthetic",
		confirmed: true,
		...extra,
	})
	const capture = (a: number, b: number) =>
		({ windowMs: [a, b] }) as unknown as CaptureRecord
	const caseOf = (intervals: TruthInterval[]) =>
		({ intervals }) as unknown as TruthCase

	it("holds a label only for REPLAY_MIN_HELD_MS of it, or all of a shorter one", () => {
		const long = caseOf([label("pocsag", 0, 4_000)])
		expect(
			heldBy(long, capture(4_000 - REPLAY_MIN_HELD_MS + 1, 8_000), CENTRE),
		).toBeNull()
		expect(
			heldBy(long, capture(4_000 - REPLAY_MIN_HELD_MS, 8_000), CENTRE)?.label
				.label,
		).toBe("pocsag")
		const short = caseOf([label("dmr", 1_000, 1_400)])
		expect(heldBy(short, capture(0, 4_000), CENTRE)?.heldMs).toBe(400)
		expect(heldBy(short, capture(1_100, 4_000), CENTRE)).toBeNull()
		// Off its channel by more than half a 6.25 kHz step: not held.
		expect(heldBy(long, capture(0, 4_000), CENTRE + 3_126)).toBeNull()
		expect(heldBy(long, undefined, CENTRE)).toBeNull()
	})

	it("reports statistics the production judge reads as the label", () => {
		const judged = (held: Held | null, ctcssHz: number | null) => {
			const stats = analogStats(held, "nfm")
			const tones = {
				ctcssHz,
				dcs: null,
				audioSeconds: (held?.heldMs ?? 0) / 1000,
			}
			const outcome = classifyAnalogTrial(stats, tones)
			const result = {
				outcome,
				mode: "nfm",
				voice: isVoice(stats),
				tones,
				stats,
			}
			return judgeAnalogResult(result, "nfm").outcome
		}
		const held = (l: TruthInterval["label"]): Held => ({
			label: label(l, 0, 3_000),
			heldMs: 3_000,
		})
		expect(judged(held("analog-voice"), null)).toBe("heard")
		expect(judged(held("analog-voice"), 88.5)).toBe("decoded")
		// Data is what only a measurement could claim: the double holds no frames for it.
		expect(judged(held("dmr"), null)).toBe("no-sync")
		expect(judged(held("pocsag"), null)).toBe("no-sync")
		expect(judged(held("carrier"), null)).toBe("carrier-only")
		expect(judged(held("noise"), null)).toBe("no-sync")
		expect(judged(null, null)).toBe("no-sync")
	})
})
