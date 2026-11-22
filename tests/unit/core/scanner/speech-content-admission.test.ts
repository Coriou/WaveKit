/**
 * The recording admission reading (speech-content.ts admissionNoise, candidate rule RA-2) on PCM
 * fed directly to SpeechContentMeter (fast; the slow cases through WidebandNfmChain live in
 * speech-content-admission-chain.test.ts): every bound at and past its value, the not-measured
 * floor, frames of exact zeros skipped, a CTCSS-band tone ignored, and the reading invariant to
 * how the audio is chunked. All audio here is modelled (synthetic), never a recording.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { mulberry32 } from "../../../mocks/scanner/signals.js"
import {
	ADMISSION_DEFAULTS,
	ADMISSION_MAX_BURST_FRAMES,
	ADMISSION_MAX_PERIODIC,
	ADMISSION_MAX_SPREAD_DB,
	ADMISSION_MIN_FLOOR_DBFS,
	ADMISSION_MIN_FRAMES,
	admissionNoise,
	SPEECH_FRAME_SAMPLES,
	SPEECH_WINDOW_FRAMES,
	SpeechContentMeter,
	type SpeechContent,
} from "../../../../src/core/scanner/channel/speech-content.js"

const FS = 8_000
const N = SPEECH_FRAME_SAMPLES

function measure(pcm: Int16Array, chunk = 4_000): SpeechContent {
	const m = new SpeechContentMeter()
	for (let at = 0; at < pcm.length; at += chunk)
		m.push(pcm.subarray(at, at + chunk))
	return m.result()
}

/** Modelled white noise at `rmsDbfs` (Gaussian, deterministic), `frames` whole frames. */
function noise(frames: number, rmsDbfs: number, seed = 3): Int16Array {
	const rng = mulberry32(seed)
	const sigma = 32_768 * 10 ** (rmsDbfs / 20)
	const out = new Int16Array(frames * N)
	for (let i = 0; i < out.length; i++) {
		const u = Math.max(1e-12, rng())
		const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
		out[i] = Math.max(-32_768, Math.min(32_767, Math.round(sigma * g)))
	}
	return out
}

/**
 * Modelled speech-like audio on a quieted carrier: 4 Hz syllables of a 120 Hz harmonic voice
 * (raised-cosine envelope, peak about −12 dBFS) with a 300 ms pause every 1.7 s, over a faint
 * demodulator floor at `floorDbfs`; `ctcss` adds a 250 Hz tone at −14 dBFS throughout.
 */
function speech(
	frames: number,
	floorDbfs = -55,
	ctcss = false,
	seed = 9,
): Int16Array {
	const floor = noise(frames, floorDbfs, seed)
	const out = new Int16Array(frames * N)
	for (let i = 0; i < out.length; i++) {
		const t = i / FS
		const env = t % 1.7 > 1.4 ? 0 : 0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t)
		let v = 0
		for (let h = 1; h <= 20; h++) v += Math.sin(2 * Math.PI * 120 * h * t) / h
		let x = floor[i]! + 6_000 * env * v
		if (ctcss) x += 6_500 * Math.sin(2 * Math.PI * 250 * t)
		out[i] = Math.max(-32_768, Math.min(32_767, Math.round(x)))
	}
	return out
}

const content = (over: Partial<SpeechContent> = {}): SpeechContent => ({
	frames: 400,
	maxRangeDb: 3,
	periodicShare: 0.02,
	maxBurstFrames: 0,
	levelFrames: 400,
	maxWindowSpreadDb: 3,
	minWindowP10Dbfs: -10,
	...over,
})

describe("admission: the rule's bounds (each at and past its value)", () => {
	// Feature: recording-admission, candidate rule RA-2 (provisional bounds).
	it("states its defaults: 94 frames (3.008 s), 10 dB, -25 dBFS, 4 frames, 0.25", () => {
		expect(ADMISSION_MIN_FRAMES).toBe(SPEECH_WINDOW_FRAMES)
		expect((ADMISSION_MIN_FRAMES * N) / FS).toBeCloseTo(3.008, 3)
		expect(ADMISSION_DEFAULTS).toEqual({
			minFrames: 94,
			maxSpreadDb: 10,
			minFloorDbfs: -25,
			maxBurstFrames: 4,
			maxPeriodicShare: 0.25,
		})
		expect(Object.isFrozen(ADMISSION_DEFAULTS)).toBe(true)
		expect(ADMISSION_MAX_SPREAD_DB).toBe(10)
		expect(ADMISSION_MIN_FLOOR_DBFS).toBe(-25)
		expect(ADMISSION_MAX_BURST_FRAMES).toBe(4)
		expect(ADMISSION_MAX_PERIODIC).toBe(0.25)
	})

	it("a noise-like reading is noise", () => {
		expect(admissionNoise(content())).toBe(true)
	})

	it("level frames: 93 not measured (null), 94 measured", () => {
		expect(admissionNoise(content({ levelFrames: 93 }))).toBeNull()
		expect(admissionNoise(content({ levelFrames: 94 }))).toBe(true)
		expect(admissionNoise(content({ levelFrames: 0 }))).toBeNull()
	})

	it("spread: under 10 dB noise, at 10 dB and past it kept", () => {
		expect(admissionNoise(content({ maxWindowSpreadDb: 9.99 }))).toBe(true)
		expect(admissionNoise(content({ maxWindowSpreadDb: 10 }))).toBe(false)
		expect(admissionNoise(content({ maxWindowSpreadDb: 10.01 }))).toBe(false)
	})

	it("floor: over -25 dBFS noise, at -25 and under it kept", () => {
		expect(admissionNoise(content({ minWindowP10Dbfs: -24.99 }))).toBe(true)
		expect(admissionNoise(content({ minWindowP10Dbfs: -25 }))).toBe(false)
		expect(admissionNoise(content({ minWindowP10Dbfs: -25.01 }))).toBe(false)
	})

	it("burst: 3 frames noise, 4 and more kept", () => {
		expect(admissionNoise(content({ maxBurstFrames: 3 }))).toBe(true)
		expect(admissionNoise(content({ maxBurstFrames: 4 }))).toBe(false)
		expect(admissionNoise(content({ maxBurstFrames: 5 }))).toBe(false)
	})

	it("periodic share: under 0.25 noise, at 0.25 and past it kept", () => {
		expect(admissionNoise(content({ periodicShare: 0.249 }))).toBe(true)
		expect(admissionNoise(content({ periodicShare: 0.25 }))).toBe(false)
		expect(admissionNoise(content({ periodicShare: 0.26 }))).toBe(false)
	})

	it("takes overrides (a later config): a looser spread bound reads a 12 dB file as noise", () => {
		const c = content({ maxWindowSpreadDb: 12 })
		expect(admissionNoise(c)).toBe(false)
		expect(admissionNoise(c, { ...ADMISSION_DEFAULTS, maxSpreadDb: 15 })).toBe(
			true,
		)
		expect(admissionNoise(c, { ...ADMISSION_DEFAULTS, minFrames: 500 })).toBe(
			null,
		)
	})
})

describe("admission: the meter's level ring (modelled PCM)", () => {
	it("steady white noise at -10 dBFS: spread a few dB, p10 near -10 dBFS: noise", () => {
		const c = measure(noise(250, -10))
		expect(c.levelFrames).toBe(250)
		expect(c.maxWindowSpreadDb).toBeLessThan(3)
		// The 312.5 Hz to 4 kHz band holds 118/128 of white noise's power: about -10.4 dBFS.
		expect(c.minWindowP10Dbfs).toBeGreaterThan(-12)
		expect(c.minWindowP10Dbfs).toBeLessThan(-10)
		expect(admissionNoise(c)).toBe(true)
	})

	it("speech-like syllables on a quieted carrier: p10 at least 8 dB under -25 dBFS, kept", () => {
		const c = measure(speech(250))
		expect(c.minWindowP10Dbfs).toBeLessThan(ADMISSION_MIN_FLOOR_DBFS - 8)
		expect(c.maxWindowSpreadDb).toBeGreaterThan(ADMISSION_MAX_SPREAD_DB + 8)
		expect(admissionNoise(c)).toBe(false)
	})

	it("a 250 Hz tone (CTCSS band) under the voice is ignored: the quieting still shows, kept", () => {
		const plain = measure(speech(250))
		const toned = measure(speech(250, -55, true))
		expect(toned.minWindowP10Dbfs).toBeLessThan(ADMISSION_MIN_FLOOR_DBFS - 8)
		expect(
			Math.abs(toned.minWindowP10Dbfs - plain.minWindowP10Dbfs),
		).toBeLessThan(3)
		expect(admissionNoise(toned)).toBe(false)
		// The tone alone (no voice) reads at the floor: none of its power is in the band.
		const tone = new Int16Array(200 * N)
		for (let i = 0; i < tone.length; i++)
			tone[i] = Math.round(6_500 * Math.sin((2 * Math.PI * 250 * i) / FS))
		expect(measure(tone).minWindowP10Dbfs).toBeLessThan(-60)
	})

	it("noise with 1 s gaps of exact zeros every 4 s: the zero frames are skipped, still noise", () => {
		const frames = 375 // 12 s
		const pcm = noise(frames, -10)
		const gapFrames = Math.round(FS / N) // 31 frames ≈ 1 s
		let zeroFrames = 0
		for (let f = 0; f < frames; f++)
			if (f % 125 >= 125 - gapFrames) {
				pcm.fill(0, f * N, (f + 1) * N)
				zeroFrames++
			}
		const c = measure(pcm)
		expect(c.frames).toBe(frames)
		expect(c.levelFrames).toBe(frames - zeroFrames)
		expect(c.minWindowP10Dbfs).toBeGreaterThan(-12)
		expect(admissionNoise(c)).toBe(true)
	})

	it("zero-filled gaps neither count nor dilute the periodic share: pitched voice with 1 s gaps reads the share of its voiced frames", () => {
		const frames = 375 // 12 s
		const gapped = speech(frames)
		let voiced = 0
		const kept = new Int16Array(gapped.length)
		for (let f = 0; f < frames; f++)
			if (f % 125 >= 94) gapped.fill(0, f * N, (f + 1) * N)
			else kept.set(gapped.subarray(f * N, (f + 1) * N), voiced++ * N)
		const g = measure(gapped)
		const v = measure(kept.subarray(0, voiced * N))
		expect(g.levelFrames).toBe(voiced)
		expect(g.periodicShare).toBeGreaterThan(0)
		expect(g.periodicShare).toBe(v.periodicShare)
	})

	it("a frame of exactly half zeros counts; one more zero skips it", () => {
		const half = noise(100, -10)
		const more = noise(100, -10)
		for (let f = 0; f < 100; f++) {
			half.fill(0, f * N, f * N + N / 2)
			more.fill(0, f * N, f * N + N / 2 + 1)
		}
		// The noise draw never lands on an exact zero at this level often enough to matter here:
		// count the zeros actually there.
		const zeros = (pcm: Int16Array, f: number): number => {
			let z = 0
			for (let i = f * N; i < (f + 1) * N; i++) if (pcm[i] === 0) z++
			return z
		}
		let halfSkipped = 0
		let moreSkipped = 0
		for (let f = 0; f < 100; f++) {
			if (zeros(half, f) > N / 2) halfSkipped++
			if (zeros(more, f) > N / 2) moreSkipped++
		}
		expect(moreSkipped).toBe(100)
		expect(measure(half).levelFrames).toBe(100 - halfSkipped)
		expect(measure(more).levelFrames).toBe(0)
	})

	it("fewer than 94 non-zero frames: not measured (null), however noisy; 94: measured", () => {
		const short = noise(ADMISSION_MIN_FRAMES - 1, -10)
		expect(measure(short).levelFrames).toBe(93)
		expect(admissionNoise(measure(short))).toBeNull()
		// 93 noise frames and 60 zero frames: still 93 level frames, still null.
		const padded = new Int16Array((ADMISSION_MIN_FRAMES - 1 + 60) * N)
		padded.set(short)
		expect(measure(padded).frames).toBe(153)
		expect(admissionNoise(measure(padded))).toBeNull()
		expect(admissionNoise(measure(noise(ADMISSION_MIN_FRAMES, -10)))).toBe(true)
		expect(admissionNoise(measure(new Int16Array(0)))).toBeNull()
	})

	it("a short file's partial level window is reported from 16 frames, 0 under it", () => {
		expect(measure(noise(15, -10))).toMatchObject({
			levelFrames: 15,
			maxWindowSpreadDb: 0,
			minWindowP10Dbfs: 0,
		})
		const c = measure(noise(40, -10))
		expect(c.levelFrames).toBe(40)
		expect(c.minWindowP10Dbfs).toBeLessThan(-10)
		expect(c.minWindowP10Dbfs).toBeGreaterThan(-12)
	})

	it("one quiet stretch anywhere keeps the file: every window must look like noise", () => {
		// 8 s of noise with 1.5 s of a quieted carrier (-55 dBFS) in the middle.
		const pcm = noise(250, -10)
		pcm.set(noise(47, -55, 11), 100 * N)
		const c = measure(pcm)
		expect(c.minWindowP10Dbfs).toBeLessThan(ADMISSION_MIN_FLOOR_DBFS)
		expect(admissionNoise(c)).toBe(false)
	})

	it("FROZEN: the existing readings are unchanged by the level ring", () => {
		const c = measure(noise(250, -10))
		const again = measure(noise(250, -10))
		expect(c).toEqual(again)
		expect(c.frames).toBe(250)
	})

	it("is chunk-split invariant (property)", () => {
		// Feature: recording-admission, Property 1: chunking invariance
		// Validates: Requirements RA.3
		const pcm = noise(200, -10)
		pcm.set(speech(60), 80 * N)
		for (let f = 150; f < 170; f++) pcm.fill(0, f * N, (f + 1) * N)
		const whole = measure(pcm, pcm.length)
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 1, max: 3_000 }), {
					minLength: 1,
					maxLength: 40,
				}),
				sizes => {
					const m = new SpeechContentMeter()
					let at = 0
					let k = 0
					while (at < pcm.length) {
						const n = sizes[k++ % sizes.length]!
						m.push(pcm.subarray(at, at + n))
						at += n
					}
					expect(m.result()).toEqual(whole)
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)
})
