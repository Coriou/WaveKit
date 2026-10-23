import { describe, expect, it } from "vitest"
import {
	DCS_MIN_AUDIO_SECONDS,
	LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS,
	LIVE_AUDIO_AUTO_SQUELCH_FRAME_MS,
	LIVE_AUDIO_AUTO_SQUELCH_HANG_MS,
	LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS,
	LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS,
	LIVE_AUDIO_AUTO_SQUELCH_QUIET_WINDOW_BLOCKS,
	LIVE_AUDIO_AUTO_SQUELCH_TONE_MIN_MS,
	LIVE_AUDIO_AUTO_SQUELCH_TONE_MODULATIONS,
	LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES,
} from "@wavekit/api-types"
import { ANALOG_TRANSMISSION_MERGE_GAP_MS } from "../../../../src/core/analog-transmission.js"
import {
	evidenceGateApplies,
	msToSamples,
	preRollBytes,
	preRollCapacitySamples,
} from "../../../../src/core/evidence-squelch/contract.js"
import { ANALOG_TRIAL_FRAME_MS } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import {
	carrierSilence,
	clicks,
	ctcssMix,
	dcsMix,
	fskBursts,
	impulseNoise,
	mix,
	toPcm,
	voiceLike,
	whiteNoise,
} from "./synthetic.js"

describe("evidence squelch contract", () => {
	it("pins the constants and their equalities", () => {
		expect(LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS).toEqual(["nfm", "am"])
		expect(LIVE_AUDIO_AUTO_SQUELCH_TONE_MODULATIONS).toEqual(["nfm"])
		expect(Object.isFrozen(LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS)).toBe(true)
		expect(Object.isFrozen(LIVE_AUDIO_AUTO_SQUELCH_TONE_MODULATIONS)).toBe(true)
		expect(LIVE_AUDIO_AUTO_SQUELCH_FRAME_MS).toBe(ANALOG_TRIAL_FRAME_MS)
		expect(LIVE_AUDIO_AUTO_SQUELCH_TONE_MIN_MS).toBe(
			DCS_MIN_AUDIO_SECONDS * 1000,
		)
		expect(LIVE_AUDIO_AUTO_SQUELCH_HANG_MS).toBe(
			ANALOG_TRANSMISSION_MERGE_GAP_MS,
		)
		expect(
			LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES * LIVE_AUDIO_AUTO_SQUELCH_FRAME_MS,
		).toBe(1000)
		expect(LIVE_AUDIO_AUTO_SQUELCH_QUIET_WINDOW_BLOCKS).toBe(100)
		expect([
			LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS,
			LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS,
		]).toEqual([1500, 200])
	})

	it("sizes the pre-roll per the design table", () => {
		// Sizing table (design, Pre-roll sizing): rate, samples, s16le bytes, f32le bytes
		const table: [number, number, number, number][] = [
			[2_048_000 / Math.round(2_048_000 / 25_000), 37_464, 74_930, 149_860],
			[25_000, 37_500, 75_002, 150_004],
			[50_000, 75_000, 150_002, 300_004],
			[2_048_000 / Math.round(2_048_000 / 20_000), 30_118, 60_238, 120_476],
		]
		for (const [rate, samples, s16, f32] of table) {
			expect(preRollCapacitySamples(rate)).toBe(samples)
			expect(preRollBytes(rate, "s16le")).toBe(s16)
			expect(preRollBytes(rate, "f32le")).toBe(f32)
		}
		expect(msToSamples(10, 8_000)).toBe(80)
		expect(msToSamples(1, 25_001)).toBe(26)
	})

	it("applies only to auto NFM/AM without a tone squelch", () => {
		expect(
			evidenceGateApplies({ squelchMode: "auto", modulation: "nfm" }),
		).toBe(true)
		expect(
			evidenceGateApplies({
				squelchMode: "auto",
				modulation: "am",
				toneSquelch: { kind: "none" },
			}),
		).toBe(true)
		for (const m of ["wfm", "usb", "lsb", "dsb", "cw", "raw"] as const)
			expect(evidenceGateApplies({ squelchMode: "auto", modulation: m })).toBe(
				false,
			)
		expect(
			evidenceGateApplies({ squelchMode: "manual", modulation: "nfm" }),
		).toBe(false)
		expect(
			evidenceGateApplies({ squelchMode: "noise", modulation: "nfm" }),
		).toBe(false)
		expect(evidenceGateApplies({ modulation: "nfm" })).toBe(false)
		expect(
			evidenceGateApplies({
				squelchMode: "auto",
				modulation: "nfm",
				toneSquelch: { kind: "ctcss", frequencyTenthsHz: 670 },
			}),
		).toBe(false)
		expect(
			evidenceGateApplies({
				squelchMode: "auto",
				modulation: "nfm",
				toneSquelch: { kind: "dcs", code: "023", polarity: "normal" },
			}),
		).toBe(false)
	})
})

describe("synthetic generators", () => {
	const rate = 25_000
	const seconds = 0.5
	const cases: [string, (seed: number) => Float32Array][] = [
		["voiceLike", seed => voiceLike({ rate, seconds, seed })],
		["ctcssMix", () => ctcssMix({ rate, seconds, hz: 67 })],
		["dcsMix", () => dcsMix({ rate, seconds, code: 0o23, polarity: "normal" })],
		["carrierSilence", () => carrierSilence({ rate, seconds })],
		[
			"fskBursts",
			seed =>
				fskBursts({
					rate,
					seconds,
					levels: 4,
					baud: 2400,
					burstMs: 100,
					gapMs: 50,
					seed,
				}),
		],
		["clicks", seed => clicks({ rate, seconds, perSecond: 10, seed })],
		["impulseNoise", seed => impulseNoise({ rate, seconds, seed })],
		["whiteNoise", seed => whiteNoise({ rate, seconds, seed })],
	]
	for (const [name, generate] of cases) {
		it(`${name}: length, finite, deterministic`, () => {
			const a = generate(7)
			expect(a).toBeInstanceOf(Float32Array)
			expect(a.length).toBe(Math.round(rate * seconds))
			expect(a.every(v => Number.isFinite(v))).toBe(true)
			expect(Array.from(generate(7))).toEqual(Array.from(a))
		})
	}

	it("seed changes the seeded output", () => {
		expect(Array.from(voiceLike({ rate, seconds, seed: 1 }))).not.toEqual(
			Array.from(voiceLike({ rate, seconds, seed: 2 })),
		)
	})

	it("mix sums over the shorter length", () => {
		const m = mix(new Float32Array([1, 2, 3]), new Float32Array([10, 20]))
		expect(Array.from(m)).toEqual([11, 22])
	})

	it("toPcm writes s16le with clipping and f32le verbatim", () => {
		const samples = new Float32Array([0, 0.5, -2, 0.25])
		const s16 = toPcm(samples, "s16le")
		expect(s16.length).toBe(8)
		expect([
			s16.readInt16LE(0),
			s16.readInt16LE(2),
			s16.readInt16LE(4),
		]).toEqual([0, 16_384, -32_768])
		const f32 = toPcm(samples, "f32le")
		expect(f32.length).toBe(16)
		expect(f32.readFloatLE(12)).toBe(0.25)
	})
})
