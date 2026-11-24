/**
 * Copy fingerprint and metric (copy-fingerprint.ts) on MODELLED frame-level envelopes
 * (copy-envelopes.ts) and synthetic 8 kHz audio: the meter's envelope capture, the overlap,
 * validity and eligibility bounds at and past each one, the lag search, the data-driven
 * effective sample size and the same-audio thresholds.
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	COPY_FRAME_SAMPLES,
	COPY_LAG_FRAMES,
	COPY_MAX_FRAMES,
	COPY_MAX_ZEROS,
	COPY_MIN_DEPTH_DB,
	COPY_MIN_OVERLAP_MS,
	COPY_MIN_VALID_FRAMES,
	COPY_MIN_VOICED_SHARE,
	R_COPY_MIN,
	Z_COPY,
	compareEnvelopes,
	envelopeByte,
	excludeGapFrames,
	overlapAllowed,
	sameAudio,
	voicedAt,
	type CopyPlacement,
} from "../../../../src/core/scanner/channel/copy-fingerprint.js"
import { SpeechContentMeter } from "../../../../src/core/scanner/channel/speech-content.js"
import {
	ENV_RATE,
	ENV_SPF,
	envelopeFrom,
	frameVoice,
	heardAgain,
	slice,
} from "./copy-envelopes.js"

const place = (
	v: { level: Float64Array; voiced: Uint8Array },
	atFrame = 0,
	exclude?: (k: number) => boolean,
): CopyPlacement => ({
	...envelopeFrom(v.level, v.voiced, exclude),
	startSample: atFrame * ENV_SPF,
	samplesPerFrame: ENV_SPF,
})

/** A square wave of ±a dB around 60 dB (period 4 frames), voiced on `voicedEvery` frames. */
function square(frames: number, a: number, voicedShare = 0.5) {
	const level = new Float64Array(frames)
	const voiced = new Uint8Array(frames)
	const on = Math.round(voicedShare * frames)
	for (let k = 0; k < frames; k++) {
		level[k] = 60 + (k % 4 < 2 ? a : -a)
		voiced[k] = k < on ? 1 : 0
	}
	return { level, voiced }
}

describe("copy fingerprint: the meter's envelope capture", () => {
	it("is off unless asked, and holds the band byte and the pitched bit per frame", () => {
		expect(new SpeechContentMeter().envelope()).toBeNull()
		const m = new SpeechContentMeter({ envelope: true })
		// A 125 Hz pulse train (pitched, energy in 312 to 1 500 Hz) then white-ish noise.
		const pcm = new Int16Array(COPY_FRAME_SAMPLES * 40)
		for (let i = 0; i < COPY_FRAME_SAMPLES * 20; i++)
			pcm[i] = i % 64 === 0 ? 20_000 : -300
		let x = 12345
		for (let i = COPY_FRAME_SAMPLES * 20; i < pcm.length; i++) {
			x = (x * 1_103_515_245 + 12_345) & 0x7fffffff
			pcm[i] = (x % 4_001) - 2_000
		}
		m.push(pcm)
		const e = m.envelope()!
		expect(e.frames).toBe(40)
		for (let k = 0; k < 40; k++) {
			expect(e.env[k]).toBeGreaterThan(0)
			expect(e.env[k]).toBeLessThanOrEqual(255)
		}
		const pitched = Array.from({ length: 40 }, (_, k) => voicedAt(e.voiced, k))
		expect(pitched.slice(1, 20).every(Boolean)).toBe(true)
		expect(pitched.slice(21).some(Boolean)).toBe(false)
	})

	it(`keeps a frame with ${COPY_MAX_ZEROS} exact zeros and excludes one with ${COPY_MAX_ZEROS + 1}`, () => {
		for (const zeros of [COPY_MAX_ZEROS, COPY_MAX_ZEROS + 1]) {
			const m = new SpeechContentMeter({ envelope: true })
			const pcm = new Int16Array(COPY_FRAME_SAMPLES).fill(1_000)
			for (let i = 0; i < zeros; i++) pcm[i * 7] = 0
			m.push(pcm)
			const e = m.envelope()!
			expect(e.frames).toBe(1)
			if (zeros <= COPY_MAX_ZEROS) expect(e.env[0]).toBeGreaterThan(0)
			else expect(e.env[0]).toBe(0)
		}
	})

	it(`stops at COPY_MAX_FRAMES (ceil(120 000 / 32) = ${COPY_MAX_FRAMES}) frames`, () => {
		expect(COPY_MAX_FRAMES).toBe(3_750)
		const m = new SpeechContentMeter({ envelope: true })
		const pcm = new Int16Array(COPY_FRAME_SAMPLES * 100).fill(500)
		for (let i = 0; i < 38; i++) m.push(pcm)
		expect(m.frames).toBe(3_800)
		expect(m.envelope()!.frames).toBe(COPY_MAX_FRAMES)
	})

	it("encodes 0.5 dB steps and never 0 for a measured frame", () => {
		expect(envelopeByte(0)).toBe(1)
		expect(envelopeByte(30.25)).toBe(61)
		expect(envelopeByte(500)).toBe(255)
	})

	it("excludes the frames a gap's fill spans (outputFrameIndex + fill length)", () => {
		const env = new Uint8Array(10).fill(100)
		excludeGapFrames(env, 10, [
			{ from: COPY_FRAME_SAMPLES * 2 + 10, to: COPY_FRAME_SAMPLES * 3 + 1 },
			{ from: COPY_FRAME_SAMPLES * 9, to: COPY_FRAME_SAMPLES * 12 },
		])
		expect(Array.from(env)).toEqual([
			100, 100, 0, 0, 100, 100, 100, 100, 100, 0,
		])
	})
})

describe("copy fingerprint: the overlap rule", () => {
	const v = frameVoice(1, 3_000)
	it(`needs ${COPY_MIN_OVERLAP_MS / 1000} s of overlap: at it passes, one sample short fails`, () => {
		const fiveS = (COPY_MIN_OVERLAP_MS * ENV_RATE) / 1000
		const a = place(slice(v, 0, 1_000))
		// b ends exactly five seconds after a starts... b starts so that the overlap is 5 s.
		const bAt = (a.frames * ENV_SPF - fiveS) / ENV_SPF
		const b: CopyPlacement = {
			...place(slice(v, 0, 160)),
			startSample: bAt * ENV_SPF,
		}
		// 0.8 of the shorter (160 frames = 5.12 s) is 4.1 s, so 5 s rules.
		expect(overlapAllowed(a, b, ENV_RATE)).toBe(true)
		expect(
			overlapAllowed(a, { ...b, startSample: b.startSample + 1 }, ENV_RATE),
		).toBe(false)
	})

	it("needs 0.8 of the shorter file: at it passes, past it fails", () => {
		const a = place(slice(v, 0, 2_000))
		const b: CopyPlacement = {
			...place(slice(v, 0, 1_000)),
			startSample: (2_000 - 800) * ENV_SPF,
		}
		expect(overlapAllowed(a, b, ENV_RATE)).toBe(true)
		expect(
			overlapAllowed(
				a,
				{ ...b, startSample: b.startSample + ENV_SPF },
				ENV_RATE,
			),
		).toBe(false)
	})
})

describe("copy fingerprint: compareEnvelopes", () => {
	const v = frameVoice(7, 1_200)
	const ghost = heardAgain(v, 70)

	it("marks the same audio heard again (other gain, independent noise) at lag 0", () => {
		const c = compareEnvelopes(place(v), place(ghost))
		expect(sameAudio(c)).toBe(true)
		if ("noCompare" in c) throw new Error("not compared")
		expect(c.lagFrames).toBe(0)
		expect(c.r).toBeGreaterThan(0.9)
	})

	it(`recovers a lag of ±${COPY_LAG_FRAMES} frames, never past it`, () => {
		for (const shift of [-3, 3]) {
			// The copy's own audio sits `shift` frames late inside a file placed at the same start.
			const shifted = slice(ghost, 10 - shift, 1_000)
			const c = compareEnvelopes(place(slice(v, 10, 1_000)), place(shifted))
			if ("noCompare" in c) throw new Error("not compared")
			expect(c.lagFrames).toBe(shift)
			expect(sameAudio(c)).toBe(true)
		}
		for (const shift of [-6, 6]) {
			const c = compareEnvelopes(
				place(slice(v, 10, 1_000)),
				place(slice(ghost, 10 - shift, 1_000)),
			)
			expect(sameAudio(c)).toBe(false)
		}
	})

	it("aligns files by sample index, a fractional frame offset rounded", () => {
		const a = place(slice(v, 0, 1_000))
		// The copy's frame 0 is audio frame 20; placed 0.4 frame late it rounds to frame 20 (lag
		// 0), placed 0.6 frame late to frame 21 (the lag search finds it at +1).
		for (const [fraction, lag] of [
			[0.4, 0],
			[0.6, 1],
		] as const) {
			const b: CopyPlacement = {
				...place(slice(ghost, 20, 900)),
				startSample: Math.round((20 + fraction) * ENV_SPF),
			}
			const c = compareEnvelopes(a, b)
			if ("noCompare" in c) throw new Error("not compared")
			expect(c.lagFrames).toBe(lag)
			expect(sameAudio(c)).toBe(true)
		}
	})

	it(`needs ${COPY_MIN_VALID_FRAMES} overlapping frames: one fewer is short`, () => {
		const n = COPY_MIN_VALID_FRAMES
		expect(n).toBe(156)
		const ok = compareEnvelopes(
			place(slice(v, 0, n)),
			place(slice(ghost, 0, n)),
		)
		expect("noCompare" in ok).toBe(false)
		const short = compareEnvelopes(
			place(slice(v, 0, n - 1)),
			place(slice(ghost, 0, n - 1)),
		)
		expect(short).toEqual({ noCompare: "short" })
	})

	it("needs 0.6 of the overlap valid in both files: at it compares, under it is invalid", () => {
		const n = 1_000
		// 400 of 1 000 frames excluded in one file: 600 valid (0.6); 401: invalid.
		for (const [cut, expected] of [
			[400, false],
			[401, true],
		] as const) {
			const c = compareEnvelopes(
				place(slice(v, 0, n), 0, k => k < cut),
				place(slice(ghost, 0, n)),
			)
			expect("noCompare" in c && c.noCompare === "invalid").toBe(expected)
		}
	})

	it(`needs a detrended depth of ${COPY_MIN_DEPTH_DB} dB in each file: at it compares, under it is ineligible`, () => {
		const deep = square(800, 2.5)
		const flat = square(800, 2)
		expect("noCompare" in compareEnvelopes(place(deep), place(deep))).toBe(
			false,
		)
		expect(compareEnvelopes(place(deep), place(flat))).toEqual({
			noCompare: "ineligible",
		})
		expect(compareEnvelopes(place(flat), place(deep))).toEqual({
			noCompare: "ineligible",
		})
	})

	it(`needs a voiced share of ${COPY_MIN_VOICED_SHARE} in each file: at it compares, under it is ineligible`, () => {
		const at = square(800, 4, 0.2)
		const under = square(800, 4, 159 / 800)
		expect("noCompare" in compareEnvelopes(place(at), place(at))).toBe(false)
		expect(compareEnvelopes(place(at), place(under))).toEqual({
			noCompare: "ineligible",
		})
	})

	it("a smooth envelope lowers Neff (Bartlett over 16 lags), so a shared slow pattern cannot inflate z", () => {
		const white = compareEnvelopes(place(v), place(ghost))
		// A slow, common pattern: a 64-frame swing, both files, with their own fine detail.
		const a = frameVoice(31, 1_000)
		const b = frameVoice(32, 1_000)
		for (let k = 0; k < 1_000; k++) {
			const slow = 6 * Math.sin((2 * Math.PI * k) / 24)
			a.level[k] = a.level[k]! + slow
			b.level[k] = b.level[k]! + slow
		}
		const common = compareEnvelopes(place(a), place(b))
		if ("noCompare" in white || "noCompare" in common)
			throw new Error("not compared")
		expect(common.neff).toBeLessThan(white.neff)
	})

	it("same audio needs both r* ≥ R_COPY_MIN and z ≥ Z_COPY", () => {
		const s = { neff: 100, lagFrames: 0, validFrames: 100 }
		expect(sameAudio({ ...s, r: R_COPY_MIN, z: Z_COPY })).toBe(true)
		expect(sameAudio({ ...s, r: R_COPY_MIN - 0.001, z: 50 })).toBe(false)
		expect(sameAudio({ ...s, r: 0.99, z: Z_COPY - 0.001 })).toBe(false)
		expect(sameAudio({ noCompare: "short" })).toBe(false)
	})

	// Feature: ghost-copies, Property 2: the metric is symmetric and pure
	// Validates: Requirements 1, 4
	it("is symmetric in its two files (r*, z and Neff; the lag negated) and never throws", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 10_000 }),
				fc.integer({ min: 1, max: 10_000 }),
				fc.integer({ min: 160, max: 1_500 }),
				fc.integer({ min: -40, max: 40 }),
				(s1, s2, n, at) => {
					const a = place(frameVoice(s1, n))
					const b = place(frameVoice(s2, n), at)
					const ab = compareEnvelopes(a, b)
					const ba = compareEnvelopes(b, a)
					if ("noCompare" in ab || "noCompare" in ba) {
						expect("noCompare" in ab).toBe("noCompare" in ba)
						return
					}
					expect(ab.r).toBeCloseTo(ba.r, 9)
					expect(ab.z).toBeCloseTo(ba.z, 9)
					expect(ab.neff).toBeCloseTo(ba.neff, 9)
					expect(ab.lagFrames + ba.lagFrames).toBe(0)
				},
			),
			{ numRuns: 100 },
		)
	})
})
