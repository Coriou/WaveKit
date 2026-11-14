/**
 * VoiceActivityGate on synthetic 8 kHz audio: the level and window bounds at and past their
 * values, hiss (flat) against voice-band tones, and CTCSS tones that must never count as voice;
 * audio shorter than a window is judged once at its end (`conclude()`).
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	VOICE_BLOCK_FRAMES,
	VOICE_GATE_HIGH_PASS_HZ,
	VOICE_MIN_FINAL_FRAMES,
	VOICE_MIN_RMS,
	VOICE_MIN_WINDOWS,
	VOICE_WINDOW_BLOCKS,
	VoiceActivityGate,
	VoiceOnAirMeter,
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

	it(`decides on full windows of VOICE_WINDOW_BLOCKS blocks, latching at the ${VOICE_MIN_WINDOWS}th voiced one`, () => {
		// Windows slide by one block: the 3rd completes VOICE_MIN_WINDOWS − 1 blocks past the first.
		const latch = WINDOW + (VOICE_MIN_WINDOWS - 1) * VOICE_BLOCK_FRAMES
		const loud = tone(700, 8000, latch)
		expect(voiced(loud.subarray(0, WINDOW - 1))).toBe(false)
		expect(voiced(loud.subarray(0, latch - 1))).toBe(false)
		expect(voiced(loud)).toBe(true)
		const g = new VoiceActivityGate()
		expect(g.push(loud)).toBe(latch)
		// Chunking does not matter.
		const gate = new VoiceActivityGate()
		for (let o = 0; o < latch; o += 333) gate.push(loud.subarray(o, o + 333))
		expect(gate.voiced).toBe(true)
	})

	it("an over that ends before latching qualifies at its end when half its windows (rounded up) were voiced", () => {
		const one = new VoiceActivityGate()
		one.push(tone(700, 8000, WINDOW))
		expect(one.voiced).toBe(false)
		expect(one.conclude()).toBe(true)
		// k silent windows' worth then `loud` loud blocks at the end: `loud` windows pass.
		const end = (blocks: number, loud: number): VoiceActivityGate => {
			const g = new VoiceActivityGate()
			g.push(new Int16Array((blocks - loud) * VOICE_BLOCK_FRAMES))
			g.push(tone(700, 8000, loud * VOICE_BLOCK_FRAMES))
			return g
		}
		// 3 windows (7 blocks), 1 voiced: under ⌈3 / 2⌉ = 2.
		expect(end(7, 1).conclude()).toBe(false)
		// 4 windows (8 blocks, a 1 s over), 2 voiced: ⌈4 / 2⌉ = 2.
		expect(end(8, 2).conclude()).toBe(true)
		// 9 windows (13 blocks, a 1.5 s over), 2 voiced: under min(3, 5) = 3.
		expect(end(13, 2).conclude()).toBe(false)
	})

	it(`a burst that passes only 2 windows of an over never reserves a file; one that passes ${VOICE_MIN_WINDOWS} does`, () => {
		// A 1.5 s over: 1.3 s of audio past the 100 ms trims, 13 blocks, 13 − 5 + 1 = 9 windows.
		expect(13 - VOICE_WINDOW_BLOCKS + 1).toBe(9)
		const quiet = (n: number) => new Int16Array(n * VOICE_BLOCK_FRAMES)
		// Loud enough that one loud block in a window passes (RMS / √5 > VOICE_MIN_RMS), so k loud
		// blocks at the over's end pass exactly k windows.
		const loud = (n: number) => tone(700, 8000, n * VOICE_BLOCK_FRAMES)
		const over = (k: number): VoiceActivityGate => {
			const g = new VoiceActivityGate()
			g.push(quiet(13 - k))
			g.push(loud(k))
			return g
		}
		const two = over(2)
		expect(two.voiced).toBe(false)
		expect(two.conclude()).toBe(false)
		const three = over(VOICE_MIN_WINDOWS)
		expect(three.voiced).toBe(true)
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

	describe("conclude() on audio shorter than a window", () => {
		function concluded(pcm: Int16Array): boolean {
			const gate = new VoiceActivityGate()
			gate.push(pcm)
			return gate.conclude()
		}

		it("judges audio of VOICE_MIN_FINAL_FRAMES (200 ms) and more, never less", () => {
			expect(VOICE_MIN_FINAL_FRAMES).toBe(1600)
			const loud = tone(700, 8000, WINDOW - 1)
			expect(concluded(loud.subarray(0, VOICE_MIN_FINAL_FRAMES))).toBe(true)
			expect(concluded(loud.subarray(0, VOICE_MIN_FINAL_FRAMES - 1))).toBe(
				false,
			)
			// A partial last block counts: 2.5 blocks qualify.
			expect(concluded(loud.subarray(0, 2.5 * VOICE_BLOCK_FRAMES))).toBe(true)
			expect(concluded(loud)).toBe(true)
			// The level bound still applies to a short window.
			const quiet = tone(
				700,
				amplitudeFor(700, 0.5 * VOICE_MIN_RMS),
				WINDOW - 1,
			)
			expect(concluded(quiet)).toBe(false)
		})

		it("rejects short silence and short flat hiss", () => {
			expect(concluded(new Int16Array(WINDOW - 1))).toBe(false)
			const rng = mulberry32(9)
			const hiss = Int16Array.from(
				{ length: WINDOW - 1 },
				() => (rng() - 0.5) * 20_000,
			)
			expect(concluded(hiss)).toBe(false)
		})

		it("adds nothing after a judged full window, is idempotent and ignores later pushes", () => {
			const gate = new VoiceActivityGate()
			gate.push(new Int16Array(WINDOW))
			gate.push(tone(700, 8000, VOICE_BLOCK_FRAMES - 1))
			expect(gate.conclude()).toBe(false)
			gate.push(tone(700, 8000, 3 * WINDOW))
			expect(gate.voiced).toBe(false)
			expect(gate.conclude()).toBe(false)
		})

		it("never counts a short CTCSS-only window as voice", () => {
			// Feature: wideband analog voice gate, Property 2: a short CTCSS-only over is not voice
			fc.assert(
				fc.property(
					fc.double({ min: 67, max: 254.1, noNaN: true }),
					fc.integer({ min: 0, max: 4000 }),
					fc.integer({ min: VOICE_MIN_FINAL_FRAMES, max: WINDOW - 1 }),
					(hz, amplitude, frames) => !concluded(tone(hz, amplitude, frames)),
				),
				{ numRuns: 100 },
			)
		})
	})
})

describe("VoiceOnAirMeter (per-transmission voice, never latches)", () => {
	it("reports where the last voiced window ended, and 0 once only silence follows a full window later", () => {
		const m = new VoiceOnAirMeter()
		const loud = tone(700, 8000, 2 * WINDOW)
		// Every block after the first full window ends a voiced window: the last frame counts.
		expect(m.push(loud)).toBe(2 * WINDOW)
		// Silence: the windows still holding loud blocks are voiced (RMS over the window), the
		// first block-aligned window of silence only is not.
		const quiet = new Int16Array(2 * WINDOW)
		const to = m.push(quiet)
		expect(to).toBeGreaterThan(0)
		expect(to).toBeLessThan(WINDOW)
		expect(m.push(new Int16Array(WINDOW))).toBe(0)
		// It never latches: voice again is reported again.
		expect(m.push(loud)).toBe(2 * WINDOW)
	})

	it("needs a full window after reset() (no window joins audio across the reset)", () => {
		const m = new VoiceOnAirMeter()
		const loud = tone(700, 8000, WINDOW)
		expect(m.push(loud)).toBe(WINDOW)
		m.reset()
		expect(m.push(loud.subarray(0, WINDOW - VOICE_BLOCK_FRAMES))).toBe(0)
		expect(m.push(loud.subarray(WINDOW - VOICE_BLOCK_FRAMES))).toBe(
			VOICE_BLOCK_FRAMES,
		)
	})
})

describe("range pushes (the recorder passes runs as ranges, no views)", () => {
	it("the gate consumes up to the frame that completed its first voiced window (a block boundary, at least one window in), then nothing", () => {
		const gate = new VoiceActivityGate()
		const pcm = new Int16Array(1_000 + WINDOW + 1_000)
		pcm.set(tone(700, 8000, WINDOW + 1_000), 1_000)
		// Frames 0 to 999 are silence: the first voiced window ends at a block boundary past them.
		const used = gate.push(pcm, 0, pcm.length)
		expect(gate.voiced).toBe(true)
		expect(used % VOICE_BLOCK_FRAMES).toBe(0)
		expect(used).toBeGreaterThanOrEqual(WINDOW)
		expect(used).toBeLessThan(pcm.length)
		expect(gate.push(pcm, 0, pcm.length)).toBe(0)
	})

	it("the gate and the meter judge a range as they judge its copy (meter index in the whole array)", () => {
		const pcm = new Int16Array(500 + 2 * WINDOW + 300)
		pcm.set(tone(700, 8000, 2 * WINDOW), 500)
		const a = new VoiceOnAirMeter()
		const b = new VoiceOnAirMeter()
		const copy = pcm.slice(500, 500 + 2 * WINDOW)
		expect(a.push(pcm, 500, 500 + 2 * WINDOW)).toBe(500 + b.push(copy))
		const g1 = new VoiceActivityGate()
		const g2 = new VoiceActivityGate()
		expect(g1.push(pcm, 500, 500 + 2 * WINDOW)).toBe(g2.push(copy))
		expect(g1.voiced).toBe(g2.voiced)
	})
})
