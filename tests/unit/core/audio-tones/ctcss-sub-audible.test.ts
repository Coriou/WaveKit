/**
 * CtcssBank.subAudibleBlockCount and partialBlockCount: blocks no CTCSS tone won that still held
 * sub-audible band energy, and those whose best tone still dominated. Sub-audible energy alone
 * is no tone evidence (voice and receiver noise fill the band); a tone that leans on a block is.
 * The recording facts' tone (toneFactOf) reads both detectors the recorder runs on the same
 * audio: the bank and the DCS decoder. All audio here is modelled.
 */
import { describe, expect, it } from "vitest"
import { CtcssBank } from "../../../../src/core/audio-tones/ctcss.js"
import { DcsDecoder } from "../../../../src/core/audio-tones/dcs.js"
import {
	TONE_MEASURED_MIN_BLOCKS,
	toneFactOf,
} from "../../../../src/core/scanner/store/recording-facts.js"
import { dcsBitStream, nrz } from "./dcs-synth.js"
import { gaussian, mulberry32 } from "./synth.js"

const RATE = 8000

interface Fed {
	readonly bank: CtcssBank
	readonly dcs: DcsDecoder
}

/** The recorder's per-file tone composition: one bank and one DCS decoder, the same samples. */
function fed(samples: Iterable<number>): Fed {
	const bank = new CtcssBank()
	const dcs = new DcsDecoder()
	for (const x of samples) {
		bank.pushSample(x)
		dcs.pushSample(x)
	}
	return { bank, dcs }
}

function fact({ bank, dcs }: Fed, ownTone = false) {
	return toneFactOf(bank.result(), {
		ctcssBlocks: bank.blockCount(),
		votedBlocks: bank.votedBlockCount(),
		partialBlocks: bank.partialBlockCount(),
		dcsSamples: dcs.sampleCount(),
		dcsChain: dcs.longestChain(),
		dcs: dcs.result(),
		ownTone,
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
	it("a DCS-like random NRZ: no block votes or leans, no DCS word chains: no tone (null)", () => {
		const f = fed(dcsLike(16_000, 3))
		const { bank } = f
		expect(bank.sampleCount()).toBe(16_000)
		expect(bank.votedBlockCount()).toBe(0)
		expect(bank.result()).toBeNull()
		// 16 000 samples: blocks at 4 000, 6 000, … 16 000: 7 blocks, every one held the code.
		expect(bank.blockCount()).toBe(7)
		expect(bank.subAudibleBlockCount()).toBe(7)
		expect(bank.partialBlockCount()).toBe(0)
		expect(f.dcs.longestChain()).toBeLessThan(2)
		expect(fact(f)).toEqual({ tone: null })
	})

	it("a real DCS 023 word stream: the code, though no CTCSS block votes", () => {
		const f = fed(nrz(dcsBitStream({ code: 0o23, bits: 23 * 8 })))
		expect(f.bank.votedBlockCount()).toBe(0)
		expect(f.dcs.longestChain()).toBeGreaterThanOrEqual(3)
		expect(fact(f)).toEqual({
			tone: { kind: "dcs", code: "023", polarity: "normal" },
		})
	})

	it("an 88.5 Hz tone broken up 300 ms on / 300 ms off: no block votes but blocks lean on it: absent", () => {
		const f = fed(brokenTone(16_000, 5))
		expect(f.bank.votedBlockCount()).toBe(0)
		expect(f.bank.subAudibleBlockCount()).toBeGreaterThan(0)
		expect(f.bank.partialBlockCount()).toBeGreaterThan(0)
		expect(fact(f)).toEqual({})
	})

	it("voice over an 88.5 Hz tone: the tone; its voted blocks are never partial", () => {
		const f = fed(voiceLike(16_000, 88.5))
		expect(f.bank.result()).toBe(88.5)
		expect(f.bank.partialBlockCount()).toBeLessThan(f.bank.votedBlockCount())
		expect(fact(f)).toEqual({ tone: { kind: "ctcss", hz: 88.5 } })
	})

	// Speech's own fundamental (85-255 Hz) and its low harmonics lie in the bank's band, so an
	// untoned voice fills it, but its gliding pitch never holds one tone's bin: no tone (null).
	it("untoned voice: its pitch fills the sub-audible band, no tone leans on a block: null", () => {
		const f = fed(voiceLike(16_000, null))
		expect(f.bank.result()).toBeNull()
		expect(f.bank.votedBlockCount()).toBe(0)
		expect(f.bank.subAudibleBlockCount()).toBeGreaterThan(0)
		expect(f.bank.partialBlockCount()).toBe(0)
		expect(fact(f)).toEqual({ tone: null })
		// Kept for its own tone: never null.
		expect(fact(f, true)).toEqual({})
	})

	it("white noise alone: it fills the band, no tone wins or leans, no DCS word chains: null", () => {
		const rand = mulberry32(11)
		const f = fed(Array.from({ length: 16_000 }, () => 0.3 * gaussian(rand)))
		expect(f.bank.votedBlockCount()).toBe(0)
		expect(f.bank.subAudibleBlockCount()).toBe(f.bank.blockCount())
		expect(f.bank.partialBlockCount()).toBe(0)
		expect(fact(f)).toEqual({ tone: null })
	})

	it("silence at the minimums (3 blocks, 8 000 samples): null; one sample fewer is absent", () => {
		const silent = fed(new Array<number>(8_000).fill(0))
		expect(silent.bank.blockCount()).toBe(TONE_MEASURED_MIN_BLOCKS)
		expect(fact(silent)).toEqual({ tone: null })
		const short = fed(new Array<number>(7_999).fill(0))
		expect(short.bank.blockCount()).toBe(TONE_MEASURED_MIN_BLOCKS - 1)
		expect(fact(short)).toEqual({})
	})

	it("a 2 kHz voice-band tone alone: under 1% of its power in the band, null", () => {
		// 2 kHz: the band estimate is raw minus the 400 Hz high-pass (2nd-order Butterworth,
		// |H|² = f⁴/(f⁴ + 400⁴)), leaving 400⁴/2000⁴ ≈ 0.16% of the tone's power: under the 1% floor.
		const f = fed(
			Array.from(
				{ length: 16_000 },
				(_, i) => 0.3 * Math.sin((2 * Math.PI * 2000 * i) / RATE),
			),
		)
		expect(f.bank.subAudibleBlockCount()).toBe(0)
		expect(fact(f)).toEqual({ tone: null })
	})

	it("reset clears the counts, and the counts never change result()", () => {
		const { bank } = fed(brokenTone(16_000, 5))
		bank.reset()
		expect(bank.subAudibleBlockCount()).toBe(0)
		expect(bank.partialBlockCount()).toBe(0)
		for (const x of voiceLike(16_000, 88.5)) bank.pushSample(x)
		expect(bank.result()).toBe(88.5)
	})
})

/**
 * PARTIAL_BAND_FRACTION (0.325, half a vote's 0.65): the 88.5 Hz tone's share of the band set by
 * an off-table 148.8 Hz companion (between 146.2 and 151.4 Hz, its leak on either table bin under
 * a third of the tone's power). A share of a²/(a² + b²) for amplitudes a and b; shares just above
 * and below the bound (a float share cannot sit exactly on it), and a vote's share past 0.65.
 */
describe("CtcssBank partialBlockCount bound", () => {
	const mix = (share: number) => {
		const a = 0.2 * Math.sqrt(share)
		const b = 0.2 * Math.sqrt(1 - share)
		return Array.from(
			{ length: 16_000 },
			(_, i) =>
				a * Math.sin((2 * Math.PI * 88.5 * i) / RATE) +
				b * Math.sin((2 * Math.PI * 148.8 * i) / RATE),
		)
	}
	it.each([
		[0.8, "votes", 7, 0],
		[0.4, "leans", 0, 7],
		[0.3, "neither", 0, 0],
	])("a %s share %s", (share, _what, voted, partial) => {
		const { bank } = fed(mix(share))
		expect(bank.votedBlockCount()).toBe(voted)
		expect(bank.partialBlockCount()).toBe(partial)
	})
})

describe("DcsDecoder coverage accessors", () => {
	it("sampleCount counts every push, a non-finite one too; reset clears it", () => {
		const dcs = new DcsDecoder()
		for (let i = 0; i < 5_999; i++) dcs.pushSample(0)
		dcs.pushSample(Number.NaN)
		expect(dcs.sampleCount()).toBe(6_000)
		dcs.reset()
		expect(dcs.sampleCount()).toBe(0)
	})

	it("longestChain: at least DCS_MIN_WORDS once a code confirms, kept after the chain breaks; reset clears it", () => {
		const dcs = new DcsDecoder()
		for (const x of nrz(dcsBitStream({ code: 0o23, bits: 23 * 6 })))
			dcs.pushSample(x)
		const confirmed = dcs.longestChain()
		expect(confirmed).toBeGreaterThanOrEqual(3)
		expect(dcs.result()).toEqual({ code: "023", polarity: "normal" })
		const rand = mulberry32(2)
		for (let i = 0; i < 8_000; i++) dcs.pushSample(0.2 * gaussian(rand))
		expect(dcs.wordHits()).toBeLessThan(confirmed)
		expect(dcs.longestChain()).toBe(confirmed)
		dcs.reset()
		expect(dcs.longestChain()).toBe(0)
	})

	it("two words of a code (one short of confirming): a chain of 2, no result", () => {
		const dcs = new DcsDecoder()
		// 23 bits fill the register (the first hit), 23 more bring the second word.
		for (const x of nrz(dcsBitStream({ code: 0o23, bits: 23 * 2 + 10 })))
			dcs.pushSample(x)
		dcs.pushSample(0)
		for (let i = 0; i < 2_000; i++) dcs.pushSample(0)
		expect(dcs.result()).toBeNull()
		expect(dcs.longestChain()).toBe(2)
	})
})
