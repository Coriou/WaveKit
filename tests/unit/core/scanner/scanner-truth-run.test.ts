import { describe, expect, it } from "vitest"
import { buildScene } from "../../../../scripts/bench/scanner-quality/scene.js"
import {
	runTruthCase,
	syntheticCase,
} from "../../../../scripts/bench/scanner-quality/truth-run.js"
import { truthOf } from "../../../../scripts/bench/scanner-quality/truth-scenes.js"
import { scoreCase } from "../../../../scripts/bench/scanner-quality/truth-score.js"
import type { TruthDecode } from "../../../../scripts/bench/scanner-quality/truth-labels.js"

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
		// The DMR repeater is decoded, so identify names it.
		expect(s.identify.find(i => i.label === "dmr")?.verdict).toBe("right")
		const again = scoreCase(c, await runTruthCase(c))
		expect(JSON.stringify(again)).toBe(JSON.stringify(s))
	}, 240_000)
})
