/**
 * CtcssBank.subAudibleBlockCount: blocks no CTCSS tone won that still held sub-audible band
 * energy. "No block voted" alone is not proof of absence: a DCS code and a broken-up tone win no
 * block either. The recording facts' tone null needs this count at 0 too (toneFactOf).
 */
import { describe, expect, it } from "vitest"
import { CtcssBank } from "../../../../src/core/audio-tones/ctcss.js"
import {
	TONE_MEASURED_MIN_SAMPLES,
	toneFactOf,
} from "../../../../src/core/scanner/store/recording-facts.js"
import { gaussian, mulberry32 } from "./synth.js"

const RATE = 8000

function fed(samples: Iterable<number>): CtcssBank {
	const bank = new CtcssBank()
	for (const x of samples) bank.pushSample(x)
	return bank
}

function fact(bank: CtcssBank) {
	return toneFactOf(bank.result(), {
		samples: bank.sampleCount(),
		votedBlocks: bank.votedBlockCount(),
		subAudibleBlocks: bank.subAudibleBlockCount(),
	})
}

/** DCS-like: random NRZ at 134.4 bps, two one-pole low-passes at 300 Hz (a transmitter's shaping). */
function* dcsLike(n: number, seed: number): Generator<number> {
	const rand = mulberry32(seed)
	const alpha = 1 - Math.exp((-2 * Math.PI * 300) / RATE)
	let bitIndex = -1
	let level = 0
	let y1 = 0
	let y2 = 0
	for (let i = 0; i < n; i++) {
		const bit = Math.floor((i * 134.4) / RATE)
		if (bit !== bitIndex) {
			bitIndex = bit
			level = rand() < 0.5 ? -0.2 : 0.2
		}
		y1 += alpha * (level - y1)
		y2 += alpha * (y1 - y2)
		yield y2
	}
}

/** 88.5 Hz for 300 ms, then 300 ms of noise, repeated. */
function* brokenTone(n: number, seed: number): Generator<number> {
	const rand = mulberry32(seed)
	for (let i = 0; i < n; i++) {
		const on = Math.floor(i / 2400) % 2 === 0
		yield on
			? 0.2 * Math.sin((2 * Math.PI * 88.5 * i) / RATE)
			: 0.3 * gaussian(rand)
	}
}

/**
 * Voice-like audio: a glottal pulse train (harmonics 1/k) whose pitch glides between 100 and
 * 140 Hz, under a 4 Hz syllabic envelope with a 300 ms pause every 1.7 s. With a tone, the voice
 * is high-passed as a toned transmitter does (harmonics under 400 Hz left out), so the tone owns
 * the sub-audible band.
 */
function* voiceLike(n: number, toneHz: number | null): Generator<number> {
	let phase = 0
	for (let i = 0; i < n; i++) {
		const t = i / RATE
		const f0 = 120 + 20 * Math.sin(2 * Math.PI * 0.7 * t)
		phase += (2 * Math.PI * f0) / RATE
		const envelope =
			t % 1.7 > 1.4 ? 0 : 0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t)
		let voice = 0
		for (let k = 1; k <= 25; k++)
			if (toneHz === null || k * f0 >= 400) voice += Math.sin(k * phase) / k
		const tone =
			toneHz === null ? 0 : 0.08 * Math.sin((2 * Math.PI * toneHz * i) / RATE)
		yield 0.15 * envelope * voice + tone
	}
}

describe("CtcssBank sub-audible energy without a winning tone", () => {
	it("a DCS-like NRZ code: no block votes, its sub-audible blocks count, the fact is absent", () => {
		const bank = fed(dcsLike(16_000, 3))
		expect(bank.sampleCount()).toBe(16_000)
		expect(bank.votedBlockCount()).toBe(0)
		expect(bank.result()).toBeNull()
		// 16 000 samples: blocks at 4 000, 6 000, … 16 000: 7 blocks, every one held the code.
		expect(bank.blockCount()).toBe(7)
		expect(bank.subAudibleBlockCount()).toBe(7)
		expect(fact(bank)).toEqual({})
	})

	it("an 88.5 Hz tone broken up 300 ms on / 300 ms off: no block votes, the fact is absent", () => {
		const bank = fed(brokenTone(16_000, 5))
		expect(bank.votedBlockCount()).toBe(0)
		expect(bank.subAudibleBlockCount()).toBeGreaterThan(0)
		expect(fact(bank)).toEqual({})
	})

	it("voice over an 88.5 Hz tone: the tone", () => {
		const bank = fed(voiceLike(16_000, 88.5))
		expect(bank.result()).toBe(88.5)
		expect(fact(bank)).toEqual({ tone: { kind: "ctcss", hz: 88.5 } })
	})

	// Speech's own fundamental (85-255 Hz) and its low harmonics lie in the bank's band, so an
	// untoned voice fills it: no "no tone" for voice, the safe answer (not determined).
	it("untoned voice: its pitch fills the sub-audible band, the fact is absent", () => {
		const bank = fed(voiceLike(16_000, null))
		expect(bank.result()).toBeNull()
		expect(bank.votedBlockCount()).toBe(0)
		expect(bank.subAudibleBlockCount()).toBeGreaterThan(0)
		expect(fact(bank)).toEqual({})
	})

	it("white noise alone: about 9% of its power is in the band (over 1%), the fact is absent", () => {
		const rand = mulberry32(11)
		const bank = new CtcssBank()
		for (let i = 0; i < 16_000; i++) bank.pushSample(0.3 * gaussian(rand))
		expect(bank.votedBlockCount()).toBe(0)
		expect(bank.subAudibleBlockCount()).toBe(bank.blockCount())
		expect(fact(bank)).toEqual({})
	})

	it("silence at TONE_MEASURED_MIN_SAMPLES: an empty band, measured no tone (null); one sample fewer is absent", () => {
		const silent = fed(new Array<number>(TONE_MEASURED_MIN_SAMPLES).fill(0))
		expect(silent.blockCount()).toBe(3)
		expect(silent.subAudibleBlockCount()).toBe(0)
		expect(fact(silent)).toEqual({ tone: null })
		const short = fed(new Array<number>(TONE_MEASURED_MIN_SAMPLES - 1).fill(0))
		expect(fact(short)).toEqual({})
	})

	it("a 2 kHz voice-band tone alone: under 1% of its power in the band, null", () => {
		// 2 kHz: the band estimate is raw minus the 400 Hz high-pass (2nd-order Butterworth,
		// |H|² = f⁴/(f⁴ + 400⁴)), leaving 400⁴/2000⁴ ≈ 0.16% of the tone's power: under the 1% floor.
		const bank = fed(
			Array.from(
				{ length: 16_000 },
				(_, i) => 0.3 * Math.sin((2 * Math.PI * 2000 * i) / RATE),
			),
		)
		expect(bank.subAudibleBlockCount()).toBe(0)
		expect(fact(bank)).toEqual({ tone: null })
	})

	it("reset clears the count, and the count never changes result()", () => {
		const bank = fed(dcsLike(16_000, 3))
		bank.reset()
		expect(bank.subAudibleBlockCount()).toBe(0)
		for (const x of voiceLike(16_000, 88.5)) bank.pushSample(x)
		expect(bank.result()).toBe(88.5)
	})
})
