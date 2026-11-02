/**
 * VoiceActivityGate on synthetic 8 kHz audio: the level and window bounds at and past their
 * values, hiss (flat) against voice-band tones, and CTCSS tones that must never count as voice.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	VOICE_BLOCK_FRAMES,
	VOICE_GATE_HIGH_PASS_HZ,
	VOICE_MIN_RMS,
	VOICE_WINDOW_BLOCKS,
	VoiceActivityGate,
} from "../../../../src/core/scanner/channel/voice-activity.js"
import { mulberry32 } from "../../../mocks/scanner/signals.js"

const RATE = 8000
const WINDOW = VOICE_BLOCK_FRAMES * VOICE_WINDOW_BLOCKS

function tone(hz: number, amplitude: number, frames: number): Int16Array {
	return Int16Array.from({ length: frames }, (_, i) =>
		Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / RATE)),
	)
}

/** Amplitude whose steady RMS after the gate's 4th-order high-pass is `rms` at `hz`. */
function amplitudeFor(hz: number, rms: number): number {
	const gain = 1 / Math.sqrt(1 + (VOICE_GATE_HIGH_PASS_HZ / hz) ** 8)
	return (rms * Math.SQRT2) / gain
}

function voiced(pcm: Int16Array): boolean {
	const gate = new VoiceActivityGate()
	gate.push(pcm)
	return gate.voiced
}

describe("VoiceActivityGate", () => {
	it("qualifies a voice-band tone only above VOICE_MIN_RMS", () => {
		// 3 windows so the filters' start transient is long gone in the later ones.
		expect(
			voiced(tone(700, amplitudeFor(700, 1.1 * VOICE_MIN_RMS), 3 * WINDOW)),
		).toBe(true)
		expect(
			voiced(tone(700, amplitudeFor(700, 0.9 * VOICE_MIN_RMS), 3 * WINDOW)),
		).toBe(false)
	})

	it("decides only on a full window of VOICE_WINDOW_BLOCKS blocks", () => {
		const loud = tone(700, 8000, WINDOW)
		expect(voiced(loud.subarray(0, WINDOW - 1))).toBe(false)
		expect(voiced(loud)).toBe(true)
		// Chunking does not matter.
		const gate = new VoiceActivityGate()
		for (let o = 0; o < WINDOW; o += 333) gate.push(loud.subarray(o, o + 333))
		expect(gate.voiced).toBe(true)
	})

	it("rejects silence (a quieted carrier) and loud flat hiss", () => {
		expect(voiced(new Int16Array(4 * WINDOW))).toBe(false)
		const rng = mulberry32(5)
		const hiss = Int16Array.from(
			{ length: 4 * WINDOW },
			() => (rng() - 0.5) * 20_000,
		)
		expect(voiced(hiss)).toBe(false)
	})

	it("never counts a CTCSS tone as voice (any standard frequency, up to 750 Hz deviation)", () => {
		// Feature: wideband analog voice gate, Property 1: CTCSS alone is not voice
		// The measured 250.3 Hz tone at 750 Hz deviation leaves 235 s16 RMS after the
		// recorder's 300 Hz high-pass; 4000 s16 peak is about 12 times that.
		fc.assert(
			fc.property(
				fc.double({ min: 67, max: 254.1, noNaN: true }),
				fc.integer({ min: 0, max: 4000 }),
				(hz, amplitude) => !voiced(tone(hz, amplitude, 2 * WINDOW)),
			),
			{ numRuns: 100 },
		)
	})
})
