// Scanner quality benchmark, small scene (scripts/bench/scanner-quality.ts): the real scanner on a
// seeded synthetic 12 s scene at 1.024 Msps. Measurement, not a spec: the assertions are floors
// that pass today, so a regression in detection, admission or the replay plan shows up here.
//
// Baseline when written (seed 20 261 101): recall 7/8 (LoRa lost at the channel gate, split into
// about 7 below-gate fragments per packet), identified 6/7 by the fake decoders, 0 split signals,
// 1 false discovery (the 8 dB birdie as a carrier), DC spike not discovered; time to discovery
// 0.3 s for the 20 dB classes, 2.0 s for the 12 dB push-to-talk, 8.3 s for AFSK1200 (third
// packet); time to identification 4.1 to 12.5 s; about 0.3 CPU s per IQ s.
//
// After the FSK pair, burst-coverage and data-burst trial order fixes: the whole small scene lies
// in ISM 433 (overlapped by 70 cm), so strong emissions pass the gate by the burst rule (time to
// discovery about 0.1 s); the OOK sensor tries rtl433 first (identified 1.9 s, was 8.9 s), the
// POCSAG burst tries pocsag before the analog trial (4.2 s, was 8.1 s), LoRa passes the gate in
// 2 to 3 tracks per packet (was 7) and is lost at discovery. Pipeline tracks 29 → 20.
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { runScanner } from "../../../../scripts/bench/scanner-quality/harness.js"
import {
	oracleIdentify,
	score,
	type QualityReport,
} from "../../../../scripts/bench/scanner-quality/metrics.js"
import type {
	CaptureRecord,
	TrackRecord,
} from "../../../../scripts/bench/scanner-quality/harness.js"
import {
	SceneGenerator,
	amplitudeFor,
	buildScene,
	smallScene,
	type Interval,
	type Scene,
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

	it("tries the data decoders first for the data bursts", () => {
		// slot 1 after the capture: the sensor's rtl433, the pager's pocsag (rtl433 first in ISM, slot 2)
		expect(bySignal("ism-ook-20dB").timeToIdentifyMs!).toBeLessThanOrEqual(
			3_000,
		)
		expect(bySignal("pocsag-20dB").timeToIdentifyMs!).toBeLessThanOrEqual(5_000)
		expect(bySignal("lora-15dB").gatePassed).toBe(true)
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

/** Three repeats of `lengthMs` with 15 ms gaps every period (the scene's sensor pattern). */
function sends(
	firstMs: number,
	periodMs: number,
	lengthMs: number,
	untilMs: number,
): Interval[] {
	const out: Interval[] = []
	for (let t = firstMs; t + 3 * lengthMs + 30 <= untilMs; t += periodMs)
		for (const k of [0, 1, 2])
			out.push({
				startMs: t + k * (lengthMs + 15),
				endMs: t + k * (lengthMs + 15) + lengthMs,
			})
	return out
}

/**
 * The full scene's FSK cases on their own: 8 s at 2.4 Msps centred at 433.1 MHz. A ±30 kHz ISM
 * FSK sensor (40 ms sends, 20 dB in 100 kHz, channel SNR about 28 dB) at +400 kHz, a POCSAG burst
 * at 10 dB at -450 kHz (its two tones fall apart at that level) and an OOK sensor at +820 kHz.
 * Before the fixes: the FSK sensor never passed the gate (300 ms rule from the overlapping 70 cm
 * slots) and split into 3 tracks per send; the POCSAG burst was two carrier tracks whose plan
 * lacked pocsag.
 */
function fskScene(): Scene {
	const ms = 8_000
	return buildScene({
		name: "fsk",
		rateHz: 2_400_000,
		centreHz: 433_100_000,
		durationMs: ms,
		seed: 20_261_103,
		noiseSigma: 0.03,
		signals: [
			{
				class: "ism-fsk",
				offsetHz: 400_000,
				snrDb: 20,
				intervals: sends(1_000, 3_000, 40, ms),
			},
			{
				class: "pocsag",
				offsetHz: -450_000,
				snrDb: 10,
				intervals: [
					{ startMs: 1_500, endMs: 3_000 },
					{ startMs: 4_500, endMs: 6_000 },
				],
			},
			{
				class: "ism-ook",
				offsetHz: 820_000,
				snrDb: 20,
				intervals: sends(2_000, 3_000, 120, ms),
			},
		],
	})
}

describe("scanner quality benchmark, FSK scene (real scanner)", () => {
	let report: QualityReport
	let captures: CaptureRecord[]
	let tracks: TrackRecord[]
	const bySignal = (id: string) => report.signals.find(s => s.id === id)!

	it("runs the scene through the scanner", async () => {
		const scene = fskScene()
		const gen = new SceneGenerator(scene)
		const run = await runScanner({
			rateHz: scene.rateHz,
			centreHz: scene.centreHz,
			next: n => gen.next(n),
			leadIn: n => gen.noiseOnly(n),
		})
		report = score(scene, run)
		captures = run.captures
		tracks = run.tracks
		expect(report.iqSeconds).toBeGreaterThanOrEqual(8)
	}, 90_000)

	it("a strong short ISM FSK send is one track, discovered and identified by rtl433 first", () => {
		const fsk = bySignal("ism-fsk-20dB")
		expect(fsk.tracksPerTransmission).toBe(1)
		expect(fsk.gatePassed).toBe(true)
		expect(fsk.discoveriesLive).toBe(1)
		expect(fsk.identified).toBe(true)
		expect(fsk.timeToIdentifyMs!).toBeLessThanOrEqual(3_000)
	})

	it("a weak POCSAG burst is one passing track whose plan tries pocsag first", () => {
		const p = bySignal("pocsag-10dB")
		// a one-block tone track left over from a partial first block may close below the gate
		expect(p.tracksPerTransmission).toBeLessThanOrEqual(1.5)
		expect(p.trialPlanned).toBe(true)
		const centre = 433_100_000 - 450_000
		const passing = tracks.filter(
			t => Math.abs(t.centreHz - centre) <= 5_500 && t.gate === "passed",
		)
		expect(passing).toHaveLength(p.transmissions)
		const planned = captures.filter(
			c => Math.abs(c.rfHz - centre) <= 5_500 && c.trials.length > 0,
		)
		expect(planned.length).toBeGreaterThan(0)
		for (const c of planned) expect(c.trials[0]!.protocol).toBe("pocsag")
	})

	it("no split and no false discovery", () => {
		expect(report.totals.splitSignals).toBe(0)
		expect(report.totals.falseDiscoveries).toBe(0)
		expect(bySignal("ism-ook-20dB").timeToIdentifyMs!).toBeLessThanOrEqual(
			3_000,
		)
	})
})
