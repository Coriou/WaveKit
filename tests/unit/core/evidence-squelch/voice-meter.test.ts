import { describe, expect, it } from "vitest"
import {
	VOICE_METER_FRAME_SAMPLES,
	VoiceFrameMeter,
} from "../../../../src/core/evidence-squelch/voice-meter.js"
import type { VoiceFrame } from "../../../../src/core/evidence-squelch/voice-meter.js"
import { mulberry32 } from "../audio-tones/synth.js"
import { voiceLike } from "./synthetic.js"

const RATE = 8_000

function run(meter: VoiceFrameMeter, samples: ArrayLike<number>): VoiceFrame[] {
	const frames: VoiceFrame[] = []
	for (let i = 0; i < samples.length; i++)
		if (meter.push(samples[i] ?? 0)) frames.push({ ...meter.frame })
	return frames
}

function sine(hz: number, amplitude: number, seconds: number): Float32Array {
	const n = Math.round(RATE * seconds)
	const out = new Float32Array(n)
	for (let i = 0; i < n; i++)
		out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE)
	return out
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1
	return sorted.length % 2 === 1
		? (sorted[mid] ?? NaN)
		: ((sorted[mid - 1] ?? NaN) + (sorted[mid] ?? NaN)) / 2
}

describe("VoiceFrameMeter", () => {
	it("emits one frame per 400 samples", () => {
		expect(VOICE_METER_FRAME_SAMPLES).toBe(400)
		const meter = new VoiceFrameMeter({ gain: 2 })
		let trues = 0
		for (let i = 0; i < 4_000; i++) if (meter.push(0)) trues += 1
		expect(trues).toBe(10)
		expect(meter.frameCount).toBe(10)
	})

	it("silence", () => {
		const frames = run(
			new VoiceFrameMeter({ gain: 2 }),
			new Float32Array(4_000),
		)
		for (const frame of frames) {
			expect(frame.audioDb).toBe(-160)
			expect(frame.syllabic).toBe(0)
			expect(frame.finite).toBe(true)
		}
	})

	it("full-deviation sine reads 0 dB", () => {
		const a = run(new VoiceFrameMeter({ gain: 2 }), sine(1_000, 0.8, 1))
		expect(Math.abs((a.at(-1)?.audioDb ?? NaN) - 0)).toBeLessThan(0.5)
		const b = run(new VoiceFrameMeter({ gain: 3 }), sine(1_000, 1.2, 1))
		expect(Math.abs((b.at(-1)?.audioDb ?? NaN) - 0)).toBeLessThan(0.5)
	})

	it("voice-like is syllabic", () => {
		// Deviation-scaled speech: peak 0.8 is full deviation at gain 2.
		const frames = run(
			new VoiceFrameMeter({ gain: 2 }),
			voiceLike({ rate: RATE, seconds: 2, seed: 7, level: 0.8 }),
		)
		const window = frames.slice(20, 40)
		expect(median(window.map(f => f.syllabic))).toBeGreaterThanOrEqual(0.3)
		expect(median(window.map(f => f.audioDb))).toBeGreaterThanOrEqual(-30)
	})

	it("steady tone is not syllabic", () => {
		const frames = run(new VoiceFrameMeter({ gain: 2 }), sine(1_000, 0.5, 2))
		expect(median(frames.map(f => f.syllabic))).toBeLessThan(0.3)
	})

	it("4-level FSK clusters", () => {
		// 4FSK as the FM discriminator delivers it: a 4-level NRZ baseband (DMR-like, 4 800
		// symbols/s, levels ±1/3 and ±1 of full deviation). `fskBursts` is audio-frequency FSK
		// (tones), which a discriminator-level cluster test is not meant to see as levels.
		const rand = mulberry32(3)
		const fsk = new Float32Array(RATE * 2)
		let level = 0
		let next = 0
		for (let i = 0; i < fsk.length; i++) {
			if (i >= next) {
				level = [-1, -1 / 3, 1 / 3, 1][Math.floor(rand() * 4)] ?? 0
				next += RATE / 4_800
			}
			fsk[i] = 0.8 * level
		}
		const data = run(new VoiceFrameMeter({ gain: 2 }), fsk)
		expect(median(data.map(f => f.cluster))).toBeGreaterThanOrEqual(0.6)
		const voice = run(
			new VoiceFrameMeter({ gain: 2 }),
			voiceLike({ rate: RATE, seconds: 2, seed: 7, level: 0.8 }),
		)
		expect(median(voice.map(f => f.cluster))).toBeLessThan(0.6)
	})

	it("non-finite input fails the frame closed", () => {
		const meter = new VoiceFrameMeter({ gain: 2 })
		const samples = sine(1_000, 0.5, 0.1)
		samples[123] = NaN
		const frames = run(meter, samples)
		expect(frames[0]?.finite).toBe(false)
		expect(frames[1]?.finite).toBe(true)
		expect(Number.isFinite(frames[1]?.audioDb)).toBe(true)
		const inf = run(new VoiceFrameMeter({ gain: 2 }), [
			Infinity,
			...new Array<number>(399).fill(0),
		])
		expect(inf[0]?.finite).toBe(false)
	})

	it("reset returns to constructed state", () => {
		const used = new VoiceFrameMeter({ gain: 2 })
		run(used, voiceLike({ rate: RATE, seconds: 1, seed: 1 }))
		used.reset()
		expect(used.frameCount).toBe(0)
		const silence = sine(1_000, 0.1, 1)
		expect(run(used, silence)).toEqual(
			run(new VoiceFrameMeter({ gain: 2 }), silence),
		)
	})

	it("rejects a gain that is not finite and positive", () => {
		for (const gain of [0, -1, NaN, Infinity])
			expect(() => new VoiceFrameMeter({ gain })).toThrow(
				expect.objectContaining({ code: "EVIDENCE_GAIN" }),
			)
	})
})
