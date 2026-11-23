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
	SPEECH_SHORT_MIN_FRAMES,
	SPEECH_STRONG_MIN_RANGE_DB,
	SPEECH_WINDOW_FRAMES,
	SpeechContentMeter,
	strongSpeech,
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
			levelFrames: 0,
			maxWindowSpreadDb: 0,
			minWindowP10Dbfs: 0,
			maxLoudPitchShare: 0,
			maxTopSpreadDb: 0,
			maxLoudLevelDbfs: -Infinity,
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

/**
 * `ms` of 8 kHz audio: low noise (`amp`), or with `pitchHz` a loud pitched tone half-mixed with
 * the noise (a loud voiced burst). Deterministic from `seed`.
 */
function burstAudio(
	parts: readonly { ms: number; amp: number; pitchHz?: number }[],
	seed: number,
): Int16Array {
	const rnd = mulberry32(seed)
	const total = parts.reduce((n, p) => n + Math.round(p.ms * 8), 0)
	const out = new Int16Array(total)
	let at = 0
	for (const p of parts) {
		const n = Math.round(p.ms * 8)
		for (let i = 0; i < n; i++) {
			const noise = rnd() * 2 - 1
			const tone =
				p.pitchHz === undefined
					? noise
					: 0.5 * Math.sin((2 * Math.PI * p.pitchHz * i) / 8000) + 0.5 * noise
			out[at++] = Math.round(p.amp * tone)
		}
	}
	return out
}

/** The meter fed `pcm` in `chunk`-sample pushes, result() read after each push (a judge loop). */
function polled(pcm: Int16Array, chunk: number): SpeechContent {
	const m = new SpeechContentMeter()
	for (let at = 0; at < pcm.length; at += chunk) {
		m.push(pcm.subarray(at, at + chunk))
		const r = m.result()
		expect(m.frames).toBe(r.frames)
	}
	return m.result()
}

describe("speech-content: a meter read on every step (the recorder's judged audio)", () => {
	// Feature: wideband analog recorder, own-audio class by speech.
	it("a 200 ms loud burst then 3 s of low noise: a partial window reads the burst, the whole file never does", () => {
		const pcm = burstAudio(
			[
				{ ms: 200, amp: 12_000, pitchHz: 150 },
				{ ms: 3_000, amp: 300 },
			],
			1,
		)
		// 3 200 ms = 100 frames of 32 ms: one whole window and more.
		expect(Math.floor(pcm.length / SPEECH_FRAME_SAMPLES)).toBe(100)
		const once = measure(pcm, pcm.length)
		expect(once.frames).toBe(100)
		expect(strongSpeech(once)).toBe(false)
		expect(once.maxRangeDb).toBeLessThan(SPEECH_STRONG_MIN_RANGE_DB)
		// Read every 100 ms (each read past 94 frames a whole window ending there): no partial
		// window counts, still under the bound.
		const r = polled(pcm, 800)
		expect(r.maxRangeDb).toBeLessThan(SPEECH_STRONG_MIN_RANGE_DB)
		expect(strongSpeech(r)).toBe(false)
		// A short file (16 frames, 0.512 s) still reads its one partial window: the burst.
		const m = new SpeechContentMeter()
		m.push(pcm.subarray(0, SPEECH_SHORT_MIN_FRAMES * SPEECH_FRAME_SAMPLES))
		expect(m.frames).toBe(SPEECH_SHORT_MIN_FRAMES)
		expect(m.result().maxRangeDb).toBeGreaterThan(SPEECH_STRONG_MIN_RANGE_DB)
		// At 93 frames still the partial window (the latest, over all 93), at 94 the whole one only.
		const at93 = new SpeechContentMeter()
		at93.push(
			pcm.subarray(0, (SPEECH_WINDOW_FRAMES - 1) * SPEECH_FRAME_SAMPLES),
		)
		expect(at93.result().frames).toBe(SPEECH_WINDOW_FRAMES - 1)
		at93.push(
			pcm.subarray(
				(SPEECH_WINDOW_FRAMES - 1) * SPEECH_FRAME_SAMPLES,
				SPEECH_WINDOW_FRAMES * SPEECH_FRAME_SAMPLES,
			),
		)
		expect(at93.result()).toEqual(
			measure(
				pcm.subarray(0, SPEECH_WINDOW_FRAMES * SPEECH_FRAME_SAMPLES),
				SPEECH_WINDOW_FRAMES * SPEECH_FRAME_SAMPLES,
			),
		)
	})

	it("frames counts whole frames without measuring", () => {
		const m = new SpeechContentMeter()
		expect(m.frames).toBe(0)
		m.push(new Int16Array(SPEECH_FRAME_SAMPLES - 1))
		expect(m.frames).toBe(0)
		m.push(new Int16Array(1))
		expect(m.frames).toBe(1)
	})

	it("reading after any push reads only whole windows: between one read at the end and a read after every frame (property)", () => {
		// A read past the first window measures the whole window ending at its last frame (a real
		// 3 s window), so a polled meter may read more than a single read at the end, but never more
		// than a read after every frame, and never a partial window.
		fc.assert(
			fc.property(
				fc.integer({ min: 50, max: 900 }),
				fc.integer({ min: 2_500, max: 4_000 }),
				fc.integer({ min: 64, max: 4_000 }),
				fc.integer({ min: 1, max: 1_000 }),
				(burstMs, restMs, chunk, seed) => {
					const pcm = burstAudio(
						[
							{ ms: burstMs, amp: 12_000, pitchHz: 150 },
							{ ms: restMs, amp: 300 },
						],
						seed,
					)
					const once = measure(pcm, pcm.length)
					const every = polled(pcm, SPEECH_FRAME_SAMPLES)
					const r = polled(pcm, chunk)
					expect(r.frames).toBe(once.frames)
					expect(r.periodicShare).toBe(once.periodicShare)
					expect(r.maxRangeDb).toBeGreaterThanOrEqual(once.maxRangeDb)
					expect(r.maxRangeDb).toBeLessThanOrEqual(every.maxRangeDb)
					expect(r.maxBurstFrames).toBeGreaterThanOrEqual(once.maxBurstFrames)
					expect(r.maxBurstFrames).toBeLessThanOrEqual(every.maxBurstFrames)
					expect(strongSpeech(r)).toBe(false)
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)
})
