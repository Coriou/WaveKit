/**
 * CtcssBank.subAudibleBlockCount and partialBlockCount: blocks no CTCSS tone won that still held
 * sub-audible band energy, and those whose best tone still dominated. Sub-audible energy alone
 * is no tone evidence (voice and receiver noise fill the band); a tone that leans on a block is.
 * The recording facts' tone (toneFactOf) reads both detectors the recorder runs on the same
 * audio: the bank and the DCS decoder. All audio here is modelled.
 */
import { describe, expect, it } from "vitest"
import { DCS_STANDARD_CODES } from "@wavekit/api-types"
import { CTCSS_HZ, CtcssBank } from "../../../../src/core/audio-tones/ctcss.js"
import { DcsDecoder } from "../../../../src/core/audio-tones/dcs.js"
import {
	RECORDER_TONE_QUIET,
	TONE_MEASURED_MIN_BLOCKS,
	TONE_MIN_CREDIBLE_DEVIATION_HZ,
	TONE_MIN_POWER,
	toneAudioPower,
	toneFactOf,
} from "../../../../src/core/scanner/store/recording-facts.js"
import { dcsBitStream, lowpassInPlace, nrz, whiteNoise } from "./dcs-synth.js"
import { gaussian, mulberry32 } from "./synth.js"

const RATE = 8000

interface Fed {
	readonly bank: CtcssBank
	readonly dcs: DcsDecoder
}

/** The recorder's per-file tone composition: one bank and one DCS decoder, the same samples. */
function fed(samples: Iterable<number>): Fed {
	const bank = new CtcssBank(RECORDER_TONE_QUIET)
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
		quietBlocks: bank.quietBlockCount(),
		dcsSamples: dcs.sampleCount(),
		dcsChain: dcs.longestChain(),
		dcsLoneHits: dcs.loneHitCount(),
		dcsAnyChain: dcs.anyValidChain(),
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
	// Nothing tone-like, but every block is too loud to prove a tone would have been seen: absent.
	it("a DCS-like random NRZ: no block votes or leans, no DCS word chains, no quiet block: absent", () => {
		const f = fed(dcsLike(24_000, 3))
		const { bank } = f
		expect(bank.sampleCount()).toBe(24_000)
		expect(bank.votedBlockCount()).toBe(0)
		expect(bank.result()).toBeNull()
		// 24 000 samples: blocks at 4 000, 6 000, … 24 000: 11 blocks, every one held the code.
		expect(bank.blockCount()).toBe(11)
		expect(bank.subAudibleBlockCount()).toBe(11)
		expect(bank.partialBlockCount()).toBe(0)
		expect(f.dcs.longestChain()).toBeLessThan(2)
		expect(f.dcs.anyValidChain()).toBeLessThan(2)
		expect(f.bank.quietBlockCount()).toBe(0)
		expect(fact(f)).toEqual({})
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
	// untoned voice fills it, and its gliding pitch never holds one tone's bin; filled, the band
	// could hide a tone under the pitch, so the file is not determined (absent), never null.
	it("untoned voice: its pitch fills the sub-audible band, no tone leans on a block, no quiet block: absent", () => {
		const f = fed(voiceLike(24_000, null))
		expect(f.bank.result()).toBeNull()
		expect(f.bank.votedBlockCount()).toBe(0)
		expect(f.bank.subAudibleBlockCount()).toBeGreaterThan(0)
		expect(f.bank.partialBlockCount()).toBe(0)
		expect(f.bank.quietBlockCount()).toBe(0)
		expect(fact(f)).toEqual({})
		// Kept for its own tone: never null.
		expect(fact(f, true)).toEqual({})
	})

	it("white noise alone: it fills the band, no tone wins or leans, no DCS word chains, no quiet block: absent", () => {
		const rand = mulberry32(11)
		const f = fed(Array.from({ length: 24_000 }, () => 0.3 * gaussian(rand)))
		expect(f.bank.votedBlockCount()).toBe(0)
		expect(f.bank.subAudibleBlockCount()).toBe(f.bank.blockCount())
		expect(f.bank.partialBlockCount()).toBe(0)
		expect(f.bank.quietBlockCount()).toBe(0)
		expect(fact(f)).toEqual({})
	})

	it("silence at the minimums (10 blocks, 22 000 samples): null; one sample fewer is absent", () => {
		const silent = fed(new Array<number>(22_000).fill(0))
		expect(silent.bank.blockCount()).toBe(TONE_MEASURED_MIN_BLOCKS)
		expect(fact(silent)).toEqual({ tone: null })
		const short = fed(new Array<number>(21_999).fill(0))
		expect(short.bank.blockCount()).toBe(TONE_MEASURED_MIN_BLOCKS - 1)
		expect(fact(short)).toEqual({})
	})

	it("a 2 kHz voice-band tone alone: under 1% of its power in the band, null", () => {
		// 2 kHz: the band estimate is raw minus the 400 Hz high-pass (2nd-order Butterworth,
		// |H|² = f⁴/(f⁴ + 400⁴)), leaving 400⁴/2000⁴ ≈ 0.16% of the tone's power: under the 1% floor.
		const f = fed(
			Array.from(
				{ length: 24_000 },
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
 * PARTIAL_BAND_FRACTION (0.325, half a vote's 0.65) and LEAN_BAND_FRACTION (0.1, two consecutive
 * blocks on the same tone): the 88.5 Hz tone's share of the band set by an off-table 148.8 Hz
 * companion (between 146.2 and 151.4 Hz, its leak on either table bin under a third of the tone's
 * power). A share of a²/(a² + b²) for amplitudes a and b; shares just above and below each bound
 * (a float share cannot sit exactly on one), and a vote's share past 0.65. 16 000 samples run 7
 * blocks; a share under 0.325 leans from the second block on (the first has no previous lean).
 * Near 0.1 the measured share sits a little under the nominal one while the band filters settle:
 * a nominal 0.11 leans from the fourth block only, 0.12 from the second.
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
		[0.4, "leans alone", 0, 7],
		[0.3, "leans twice in a row", 0, 6],
		[0.12, "leans twice in a row", 0, 6],
		[0.09, "neither", 0, 0],
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

/** Two 2nd-order Butterworth low-passes at 300 Hz: the recorder's tone audio band (modelled). */
function lowpassed300(x: Float64Array): Float64Array {
	return lowpassInPlace(lowpassInPlace(x, 300, RATE), 300, RATE)
}

/** Mean power of `x`. */
function power(x: ArrayLike<number>): number {
	let p = 0
	for (let i = 0; i < x.length; i++) p += (x[i] ?? 0) ** 2
	return p / x.length
}

describe("weak or broken tones under noise read absent, and so do loud noise and voice", () => {
	/** 6 s of 300 Hz low-passed white noise with an 88.5 Hz tone `snrDb` under its power. */
	const weakTone = (snrDb: number, seed: number) => {
		const noise = lowpassed300(whiteNoise({ seconds: 6, seed, std: 0.3 }))
		const amplitude = Math.sqrt(2 * power(noise) * 10 ** (snrDb / 10))
		return noise.map(
			(v, i) => v + amplitude * Math.sin((2 * Math.PI * 88.5 * i) / RATE),
		)
	}

	it.each([9, 12])(
		"an 88.5 Hz tone %s dB under the band's noise: no vote, consecutive leans: absent",
		snrDb => {
			const f = fed(weakTone(-snrDb, 4))
			expect(f.bank.result()).toBeNull()
			expect(f.bank.votedBlockCount()).toBe(0)
			expect(f.bank.partialBlockCount()).toBeGreaterThan(0)
			expect(fact(f)).toEqual({})
		},
	)

	// TONE_MEASURED_MIN_BLOCKS (10 blocks, 2.75 s): a tone 9 dB under the noise leans on a block
	// only now and then; a file analysed for fewer blocks reads absent, a longer one has leaned.
	it.each([1.5, 3])(
		"an 88.5 Hz tone 9 dB under the noise, %s s, 30 seeds: never null",
		seconds => {
			const nulls: number[] = []
			for (let seed = 1; seed <= 30; seed++) {
				const noise = lowpassed300(whiteNoise({ seconds, seed, std: 0.3 }))
				const amplitude = Math.sqrt(2 * power(noise) * 10 ** (-9 / 10))
				const f = fed(
					noise.map(
						(v, i) => v + amplitude * Math.sin((2 * Math.PI * 88.5 * i) / RATE),
					),
				)
				if (fact(f).tone === null) nulls.push(seed)
			}
			expect(nulls).toEqual([])
		},
		30_000,
	)

	it.each([1, 2, 3])(
		"60 s of 300 Hz low-passed white noise (seed %s): no lean twice on one tone, chance DCS hits only, no quiet block: absent",
		seed => {
			const f = fed(lowpassed300(whiteNoise({ seconds: 60, seed, std: 0.3 })))
			expect(f.bank.partialBlockCount()).toBe(0)
			expect(f.dcs.loneHitCount()).toBeLessThan(20)
			expect(f.bank.quietBlockCount()).toBe(0)
			expect(fact(f)).toEqual({})
		},
		30_000,
	)

	it("60 s of a gliding voice pitch (110-170 Hz, its harmonic, 4 Hz syllables), no quiet block: absent", () => {
		const glide = 30 / (2 * Math.PI * 1.3)
		const x = Array.from({ length: 60 * RATE }, (_, i) => {
			const t = i / RATE
			const phase =
				2 * Math.PI * (140 * t - glide * Math.cos(2 * Math.PI * 1.3 * t))
			const envelope = 0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t)
			return 0.3 * envelope * (Math.sin(phase) + 0.5 * Math.sin(2 * phase))
		})
		const f = fed(x)
		expect(f.bank.partialBlockCount()).toBe(0)
		expect(f.bank.quietBlockCount()).toBe(0)
		expect(fact(f)).toEqual({})
	}, 30_000)

	// DCS 023 with one bit flipped at a random place in every 20 (5% bit errors): never 46 clean
	// bits in a row, so no two consecutive words match, yet clean 23-bit windows hit many times.
	it("DCS 023 with 5% flipped bits: no chain of two, lone hits far above chance: absent", () => {
		const rand = mulberry32(5)
		const bits = dcsBitStream({ code: 0o23, bits: Math.ceil(6 * 134.4) + 2 })
		for (let i = 0; i < bits.length; i += 20) {
			const k = i + Math.floor(rand() * 20)
			if (k < bits.length) bits[k] = bits[k]! ^ 1
		}
		const audio = lowpassInPlace(nrz(bits, { amplitude: 0.15 }), 250, RATE)
		const f = fed(audio.subarray(0, 6 * RATE))
		expect(f.dcs.result()).toBeNull()
		expect(f.dcs.longestChain()).toBe(1)
		// One per 3 s of 6 s analysed is 2; it hits far more.
		expect(f.dcs.loneHitCount()).toBeGreaterThanOrEqual(10)
		expect(fact(f)).toEqual({})
	})
})

describe("DcsDecoder loneHitCount", () => {
	it("counts every chain start, a chain that went on to confirm once; reset clears it", () => {
		const dcs = new DcsDecoder()
		for (const x of nrz(dcsBitStream({ code: 0o23, bits: 23 * 6 })))
			dcs.pushSample(x)
		expect(dcs.result()).toEqual({ code: "023", polarity: "normal" })
		const started = dcs.loneHitCount()
		expect(started).toBeGreaterThanOrEqual(1)
		expect(started).toBeLessThan(dcs.longestChain())
		dcs.reset()
		expect(dcs.loneHitCount()).toBe(0)
		// Silence never hits.
		for (let i = 0; i < 8_000; i++) dcs.pushSample(0)
		expect(dcs.loneHitCount()).toBe(0)
	})
})

/**
 * A clean code outside the standard set (DCS_CODE_SET "standard"): the gate reports no code and,
 * when its word is no rotation of a standard word, no standard lone hit chains either, yet the
 * any-valid side chain (DcsDecoder.anyValidChain) holds it: absent, never "No tone heard". Every
 * one of the 512 codes, 6 s each, clean NRZ low-passed at 250 Hz (modelled).
 */
describe("DcsDecoder anyValidChain: no clean DCS code reads null", () => {
	const standard = new Set(DCS_STANDARD_CODES.map(c => Number.parseInt(c, 8)))
	const sixSeconds = (code: number) =>
		lowpassInPlace(
			nrz(dcsBitStream({ code, bits: Math.ceil(6 * 134.4) }), {
				amplitude: 0.15,
			}),
			250,
			RATE,
		).subarray(0, 6 * RATE)

	it("every non-standard code: a chain of at least 2 any-valid words (000: a leaned CTCSS block), never null", () => {
		const nulls: string[] = []
		const short: string[] = []
		let checked = 0
		for (let code = 0; code < 512; code++) {
			if (standard.has(code)) continue
			checked++
			const f = fed(sixSeconds(code))
			const name = code.toString(8).padStart(3, "0")
			// 2 words make the file tone-like (DCS_PARTIAL_WORDS).
			if (f.dcs.anyValidChain() < 2) {
				short.push(name)
				// Its word repeats every 23 bits: lines 5.84 Hz apart, one leans on a CTCSS bin.
				expect(f.bank.partialBlockCount()).toBeGreaterThan(0)
			}
			if ("tone" in fact(f) && fact(f).tone === null) nulls.push(name)
		}
		expect(checked).toBe(512 - standard.size)
		// 000's word opens with 11 zeros: shaped at 250 Hz, its slicer never reads a whole word.
		expect(short).toEqual(["000"])
		expect(nulls).toEqual([])
	}, 120_000)

	it("every standard code still reads as its own code", () => {
		for (const text of DCS_STANDARD_CODES) {
			const f = fed(sixSeconds(Number.parseInt(text, 8)))
			expect(fact(f)).toEqual({
				tone: { kind: "dcs", code: text, polarity: "normal" },
			})
		}
	}, 120_000)

	it("counts like longestChain, kept after the chain breaks; reset clears it", () => {
		const dcs = new DcsDecoder()
		// 017 is no standard code and no rotation of one: result() and longestChain stay empty.
		for (const x of nrz(dcsBitStream({ code: 0o17, bits: 23 * 4 })))
			dcs.pushSample(x)
		// The last bits leave the low-pass after the stream ends.
		for (let i = 0; i < 2_000; i++) dcs.pushSample(0)
		expect(dcs.result()).toBeNull()
		expect(dcs.longestChain()).toBe(0)
		const chain = dcs.anyValidChain()
		expect(chain).toBeGreaterThanOrEqual(2)
		const rand = mulberry32(4)
		for (let i = 0; i < 8_000; i++) dcs.pushSample(0.2 * gaussian(rand))
		expect(dcs.anyValidChain()).toBe(chain)
		dcs.reset()
		expect(dcs.anyValidChain()).toBe(0)
	})
})

describe("CtcssBank quietBlockCount: ceilings at and past their bound", () => {
	const sine = (hz: number, amplitude: number, n = 24_000) =>
		Array.from(
			{ length: n },
			(_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / RATE),
		)
	const quietOf = (
		samples: readonly number[],
		ceilings?: { bandMax: number; rawMax: number },
	) => {
		const bank = new CtcssBank(ceilings)
		for (const x of samples) bank.pushSample(x)
		return { quiet: bank.quietBlockCount(), blocks: bank.blockCount(), bank }
	}

	it("no ceilings, or ceilings that are not finite non-negative numbers: no block is quiet", () => {
		const silence = new Array<number>(24_000).fill(0)
		expect(quietOf(silence).quiet).toBe(0)
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1e-9]) {
			expect(quietOf(silence, { bandMax: bad, rawMax: 1 }).quiet).toBe(0)
			expect(quietOf(silence, { bandMax: 1, rawMax: bad }).quiet).toBe(0)
		}
	})

	it("exactly at both ceilings is quiet: silence under ceilings of 0", () => {
		const r = quietOf(new Array<number>(24_000).fill(0), {
			bandMax: 0,
			rawMax: 0,
		})
		expect(r.blocks).toBe(11)
		expect(r.quiet).toBe(11)
		// Any power at all is past a ceiling of 0.
		expect(quietOf(sine(2000, 1e-6), { bandMax: 1, rawMax: 0 }).quiet).toBe(0)
	})

	it("the raw ceiling: a 2 kHz sine of 0.1 (raw power 0.005) is quiet at 0.005, not under it", () => {
		// Four samples per period at 8 kHz: every 500 ms block's mean square is 0.1² / 2.
		const x = sine(2000, 0.1)
		expect(quietOf(x, { bandMax: 1, rawMax: 0.005 * (1 + 1e-9) }).quiet).toBe(
			11,
		)
		expect(quietOf(x, { bandMax: 1, rawMax: 0.005 * (1 - 1e-6) }).quiet).toBe(0)
	})

	it("the band ceiling: a 150 Hz sine is quiet above its band share (0.976), not below it", () => {
		const x = sine(150, 0.1)
		const p = 0.1 ** 2 / 2
		expect(quietOf(x, { bandMax: 0.995 * p, rawMax: 1 }).quiet).toBe(11)
		expect(quietOf(x, { bandMax: 0.955 * p, rawMax: 1 }).quiet).toBe(0)
		// The count never changes the bank's answer.
		expect(quietOf(x, { bandMax: 1, rawMax: 1 }).bank.result()).toBe(
			quietOf(x).bank.result(),
		)
	})

	it("reset clears the count", () => {
		const { bank } = quietOf(new Array<number>(24_000).fill(0), {
			bandMax: 0,
			rawMax: 0,
		})
		bank.reset()
		expect(bank.quietBlockCount()).toBe(0)
	})
})

describe("RECORDER_TONE_QUIET: a quiet block proves a credible tone would have voted", () => {
	const tone = (hz: number, power: number, i: number) =>
		Math.sqrt(2 * power) * Math.sin((2 * Math.PI * hz * i) / RATE)

	it("the ceilings' arithmetic: 250 Hz of deviation at 254.1 Hz is the weakest tone, 6.51e-3", () => {
		expect(TONE_MIN_CREDIBLE_DEVIATION_HZ).toBe(250)
		expect(TONE_MIN_POWER).toBeCloseTo(6.51e-3, 4)
		expect(TONE_MIN_POWER).toBe(toneAudioPower(254.1, 250))
		expect(toneAudioPower(67, 250)).toBeCloseTo(1.82e-2, 3)
		expect(RECORDER_TONE_QUIET.bandMax).toBeCloseTo(1.3e-3, 4)
		expect(RECORDER_TONE_QUIET.rawMax).toBeCloseTo(0.163, 3)
	})

	// Every standard tone at the power 250 Hz of deviation gives it: no block is quiet, every
	// block votes for it (its own tone alone keeps it above the band ceiling).
	it("every standard tone at 250 Hz of deviation: no block quiet, every block votes", () => {
		for (const hz of CTCSS_HZ) {
			const p = toneAudioPower(hz, TONE_MIN_CREDIBLE_DEVIATION_HZ)
			const f = fed(Array.from({ length: 24_000 }, (_, i) => tone(hz, p, i)))
			expect(f.bank.quietBlockCount()).toBe(0)
			expect(f.bank.votedBlockCount()).toBe(f.bank.blockCount())
			expect(f.bank.result()).toBe(hz)
		}
	})

	// Other audio just quiet enough (98% of the band ceiling in the band) as a line on the next
	// tone's bin, the worst case for the 3x rule, and as noise across the band: alone every block
	// is quiet; with the weakest credible tone added, every block votes for that tone.
	it("other audio at the band ceiling: quiet alone, and the weakest tone added votes in every block", () => {
		// The bank's band measure keeps 0.869 of a 250.3 Hz line; the noise is scaled on its raw
		// power, of which the band keeps less.
		const line = (0.98 * RECORDER_TONE_QUIET.bandMax) / 0.869
		const noise = lowpassed300(whiteNoise({ seconds: 3, seed: 17, std: 1 }))
		const noiseScale = Math.sqrt(
			(0.98 * RECORDER_TONE_QUIET.bandMax) / power(noise),
		)
		const others: [string, (i: number) => number][] = [
			["a 250.3 Hz line", i => tone(250.3, line, i)],
			["300 Hz low-passed noise", i => noiseScale * (noise[i] ?? 0)],
		]
		for (const [, other] of others) {
			// Alone it is quiet (the line, a tone far under 250 Hz of deviation, still votes for itself).
			const alone = fed(Array.from({ length: 24_000 }, (_, i) => other(i)))
			expect(alone.bank.quietBlockCount()).toBe(alone.bank.blockCount())
			for (const hz of [67, 151.4, 254.1]) {
				const p = toneAudioPower(hz, TONE_MIN_CREDIBLE_DEVIATION_HZ)
				const f = fed(
					Array.from({ length: 24_000 }, (_, i) => other(i) + tone(hz, p, i)),
				)
				expect(f.bank.quietBlockCount()).toBe(0)
				expect(f.bank.votedBlockCount()).toBe(f.bank.blockCount())
				expect(f.bank.result()).toBe(hz)
			}
		}
	})
})
