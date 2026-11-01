// Scanner quality benchmark, small scene (scripts/bench/scanner-quality.ts): the real scanner on a
// seeded synthetic 12 s scene at 1.024 Msps. Measurement, not a spec: the assertions are floors
// that pass today, so a regression in detection, admission or the replay plan shows up here.
//
// Baseline when written (seed 20 261 101): recall 7/8 (LoRa lost at the channel gate, split into
// about 7 below-gate fragments per packet), identified 6/7 by the fake decoders, 0 split signals,
// 1 false discovery (the 8 dB birdie as a carrier), DC spike not discovered; time to discovery
// 0.3 s for the 20 dB classes, 2.0 s for the 12 dB push-to-talk, 8.3 s for AFSK1200 (third
// packet); time to identification 4.1 to 12.5 s; about 0.3 CPU s per IQ s.
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { runScanner } from "../../../../scripts/bench/scanner-quality/harness.js"
import {
	oracleIdentify,
	score,
	type QualityReport,
} from "../../../../scripts/bench/scanner-quality/metrics.js"
import type { CaptureRecord } from "../../../../scripts/bench/scanner-quality/harness.js"
import {
	SceneGenerator,
	amplitudeFor,
	smallScene,
} from "../../../../scripts/bench/scanner-quality/scene.js"

function sceneHash(seed?: number): string {
	const gen = new SceneGenerator(smallScene(seed))
	const h = createHash("sha256")
	for (let i = 0; i < 20; i++) h.update(gen.next(51_200)!)
	return h.digest("hex")
}

describe("scanner quality benchmark scene", () => {
	it("is deterministic for a seed and differs across seeds", () => {
		expect(sceneHash()).toBe(sceneHash())
		expect(sceneHash(7)).not.toBe(sceneHash())
	})

	it("states the SNR convention: power over noise in max(12.5 kHz, bandwidth)", () => {
		// σ 0.03 at 1.024 Msps: noise in 12.5 kHz = 2 · 0.03² · 12 500 / 1 024 000 = 2.197e-5
		const noise = (2 * 0.03 * 0.03 * 12_500) / 1_024_000
		expect(amplitudeFor(0, 9_000, 0.03, 1_024_000) ** 2).toBeCloseTo(noise, 12)
		expect(amplitudeFor(10, 12_500, 0.03, 1_024_000) ** 2).toBeCloseTo(
			10 * noise,
			12,
		)
		// 125 kHz is ten times 12.5 kHz: ten times the noise
		expect(amplitudeFor(0, 125_000, 0.03, 1_024_000) ** 2).toBeCloseTo(
			10 * noise,
			12,
		)
	})

	it("the fake decoder answers only for its protocol, in reach and on air", () => {
		const scene = smallScene()
		const dmr = scene.truth.find(t => t.class === "dmr")!
		const capture = (over: Partial<CaptureRecord>): CaptureRecord => ({
			captureId: "c",
			observationId: null,
			requestedMs: 1_900,
			trackStartMs: 1_500,
			rfHz: dmr.centreHz,
			rateHz: 48_000,
			endedMs: 5_000,
			finishedMs: 5_000,
			windowMs: [1_000, 5_000],
			discoveryId: null,
			trials: [
				{ protocol: "analog-fm", decoder: "analog-demod", kind: "analog" },
				{ protocol: "dmr", decoder: "dsd-fme", kind: "probe" },
			],
			skipped: [],
			edge: false,
			...over,
		})
		// slot 2 of the plan: 2 nominal 1 s trials after the capture finished
		expect(oracleIdentify(dmr, capture({}))).toBe(7_000)
		// 2.5 kHz reach for dsd-fme: at the bound it decodes, past it not
		expect(oracleIdentify(dmr, capture({ rfHz: dmr.centreHz + 2_500 }))).toBe(
			7_000,
		)
		expect(
			oracleIdentify(dmr, capture({ rfHz: dmr.centreHz + 2_501 })),
		).toBeNull()
		expect(
			oracleIdentify(
				dmr,
				capture({
					trials: [{ protocol: "dpmr", decoder: "dsd-fme", kind: "probe" }],
				}),
			),
		).toBeNull()
		// off air: the window holds none of the transmission
		expect(
			oracleIdentify(dmr, capture({ windowMs: [5_500, 6_500] })),
		).toBeNull()
	})
})

describe("scanner quality benchmark, small scene (real scanner)", () => {
	let report: QualityReport
	const bySignal = (id: string) => report.signals.find(s => s.id === id)!

	it("runs the scene through the scanner", async () => {
		const scene = smallScene()
		const gen = new SceneGenerator(scene)
		const run = await runScanner({
			rateHz: scene.rateHz,
			centreHz: scene.centreHz,
			next: n => gen.next(n),
			leadIn: n => gen.noiseOnly(n),
		})
		report = score(scene, run)
		expect(report.iqSeconds).toBeGreaterThanOrEqual(12)
	}, 60_000)

	it("finds and identifies the strong classes", () => {
		for (const id of [
			"nfm-voice-20dB",
			"dmr-20dB",
			"pocsag-20dB",
			"ism-ook-20dB",
			"nfm-ptt-12dB",
		]) {
			const s = bySignal(id)
			expect({ id, discovered: s.discovered }).toEqual({
				id,
				discovered: true,
			})
			expect({ id, identified: s.identified }).toEqual({
				id,
				identified: true,
			})
		}
		expect(bySignal("cw-20dB").discovered).toBe(true)
		// 20 dB sustained classes are found within half a second of keying up
		for (const id of ["nfm-voice-20dB", "dmr-20dB"])
			expect(bySignal(id).timeToDiscoveryMs!).toBeLessThanOrEqual(1_000)
	})

	it("keeps today's floors: recall, identification, splits and false discoveries", () => {
		const t = report.totals
		expect(t.real).toBe(8)
		expect(t.discovered).toBeGreaterThanOrEqual(7)
		expect(t.identified).toBeGreaterThanOrEqual(6)
		expect(t.splitSignals).toBe(0)
		expect(t.falseByKind.dc).toBe(0)
		expect(t.falseByKind.other).toBe(0)
		expect(t.falseDiscoveries).toBeLessThanOrEqual(1)
		// the DC spike never becomes a track (DC guard)
		expect(bySignal("dc-25dB").tracks).toBe(0)
	})
})
