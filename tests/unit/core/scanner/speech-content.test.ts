/**
 * The speech-content measure (speech-content.ts), its bounds and burst veto: under 3 s nothing
 * is judged; the measure is chunk-split invariant; a burst is counted in time order. The slow
 * cases through WidebandNfmChain live in speech-content-chain.test.ts.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { mulberry32 } from "../../../mocks/scanner/signals.js"
import {
	clearlyNoise,
	clearlyNotSpeech,
	SPEECH_FRAME_SAMPLES,
	SPEECH_NOISE_BURST_DB,
	SPEECH_NOISE_MAX_BURST_FRAMES,
	SPEECH_NOISE_MIN_FRAMES,
	SPEECH_WINDOW_FRAMES,
	SpeechContentMeter,
	type SpeechContent,
} from "../../../../src/core/scanner/channel/speech-content.js"
import { contentAudio } from "./speech-content-fixtures.js"

function measure(pcm: Int16Array, chunk = 4_000): SpeechContent {
	const m = new SpeechContentMeter()
	for (let at = 0; at < pcm.length; at += chunk)
		m.push(pcm.subarray(at, at + chunk))
	return m.result()
}

describe("speech-content: bounds", () => {
	it("under 3 s (SPEECH_WINDOW_FRAMES frames) nothing is judged, however steady", () => {
		const n = SPEECH_WINDOW_FRAMES * SPEECH_FRAME_SAMPLES
		const steady = new Int16Array(n).fill(1_000)
		expect(clearlyNotSpeech(measure(steady.subarray(0, n - 1)))).toBe(false)
		expect(measure(steady.subarray(0, n - 1)).maxRangeDb).toBe(0)
		expect(measure(steady).frames).toBe(SPEECH_WINDOW_FRAMES)
		expect(clearlyNotSpeech(measure(steady))).toBe(true)
		expect(measure(new Int16Array(0))).toEqual({
			frames: 0,
			maxRangeDb: 0,
			periodicShare: 0,
			maxBurstFrames: 0,
		})
	})

	it("result() may be read twice (finish, then the end of a hold): same answer", () => {
		const m = new SpeechContentMeter()
		m.push(
			contentAudio(
				{ waveform: { kind: "speech", pauses: "short" }, cnrDb: 30 },
				4,
			),
		)
		expect(m.result()).toEqual(m.result())
	}, 60_000)

	it("is chunk-split invariant (property)", () => {
		const pcm = contentAudio(
			{ waveform: { kind: "speech", pauses: "long" }, cnrDb: 12 },
			5,
		)
		const whole = measure(pcm, pcm.length)
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 9_000 }), chunk => {
				expect(measure(pcm, chunk)).toEqual(whole)
			}),
			{ numRuns: 100 },
		)
	}, 120_000)
})

describe("speech-content: the burst veto (clearlyNoise only)", () => {
	// The burst veto (SPEECH_NOISE_MAX_BURST_FRAMES) of docs/SCANNER.md, "Analog voice
	// recordings" (the content check); not from a spec, so no property trace.
	/**
	 * 8 s of band noise at a steady level with `burst` consecutive frames 12 dB louder (four times
	 * the amplitude) from frame 120: frame-aligned, so the meter sees exactly `burst` loud frames.
	 */
	function steadyWithBurst(burst: number): Int16Array {
		const rng = mulberry32(3)
		const pcm = new Int16Array(SPEECH_NOISE_MIN_FRAMES * SPEECH_FRAME_SAMPLES)
		for (let i = 0; i < pcm.length; i++) {
			const f = Math.floor(i / SPEECH_FRAME_SAMPLES)
			const amp = f >= 120 && f < 120 + burst ? 4_000 : 1_000
			pcm[i] = Math.round(amp * (2 * rng() - 1))
		}
		return pcm
	}

	it("the veto's figures: 6 dB over the median, 3 frames (96 ms)", () => {
		expect(SPEECH_NOISE_BURST_DB).toBe(6)
		expect(SPEECH_NOISE_MAX_BURST_FRAMES).toBe(3)
		expect((SPEECH_NOISE_MAX_BURST_FRAMES * SPEECH_FRAME_SAMPLES) / 8).toBe(96)
	})

	for (const burst of [
		0,
		1,
		SPEECH_NOISE_MAX_BURST_FRAMES - 1,
		SPEECH_NOISE_MAX_BURST_FRAMES,
		SPEECH_NOISE_MAX_BURST_FRAMES + 1,
		7,
	])
		it(`a ${burst}-frame burst on steady noise: clear noise ${burst < SPEECH_NOISE_MAX_BURST_FRAMES}, not speech either way`, () => {
			const r = measure(steadyWithBurst(burst))
			expect(r.maxBurstFrames).toBe(burst)
			// Too few loud frames to move the 90th percentile: the range alone calls it noise.
			expect(r.maxRangeDb).toBeLessThan(3)
			expect(clearlyNotSpeech(r)).toBe(true)
			expect(clearlyNoise(r)).toBe(burst < SPEECH_NOISE_MAX_BURST_FRAMES)
		})

	it("a burst is measured in time order across the ring's wrap (property)", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: SPEECH_NOISE_MIN_FRAMES - 8 }),
				fc.integer({ min: 1, max: 8 }),
				(start, burst) => {
					const rng = mulberry32(start + 1)
					const pcm = new Int16Array(
						SPEECH_NOISE_MIN_FRAMES * SPEECH_FRAME_SAMPLES,
					)
					for (let i = 0; i < pcm.length; i++) {
						const f = Math.floor(i / SPEECH_FRAME_SAMPLES)
						const amp = f >= start && f < start + burst ? 4_000 : 1_000
						pcm[i] = Math.round(amp * (2 * rng() - 1))
					}
					expect(measure(pcm).maxBurstFrames).toBe(burst)
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)
})
