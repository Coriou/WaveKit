import { describe, expect, it } from "vitest"
import {
	DCS_WORD_BITS,
	DcsDecoder,
	dcsTwin,
} from "../../../../src/core/audio-tones/dcs.js"
import { ToneEvidence } from "../../../../src/core/evidence-squelch/tone-evidence.js"
import type { ToneReading } from "../../../../src/core/evidence-squelch/tone-evidence.js"
import {
	dataLike,
	toneQualified,
} from "../../../../src/core/scanner/analog-trial.js"
import type { AnalogTrialFrame } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { fskBursts, mix, voiceLike, ctcssMix, dcsMix } from "./synthetic.js"

const RATE = 8_000

/** Feed samples; return the samples pushed when a reading first appeared (-1: never), and the final reading copy. */
function feed(
	tone: ToneEvidence,
	samples: Float32Array,
): { first: number; last: ToneReading | null } {
	let first = -1
	for (let i = 0; i < samples.length; i++) {
		tone.push(samples[i] ?? 0)
		if (first < 0 && tone.current() !== null) first = i + 1
	}
	const current = tone.current()
	return {
		first,
		last:
			current === null
				? null
				: current.kind === "ctcss"
					? { ...current }
					: { ...current, dcs: { ...current.dcs } },
	}
}

function sine(hz: number, seconds: number): Float32Array {
	const out = new Float32Array(Math.round(RATE * seconds))
	for (let i = 0; i < out.length; i++)
		out[i] = 0.3 * Math.sin((2 * Math.PI * hz * i) / RATE)
	return out
}

describe("ToneEvidence", () => {
	for (const hz of [67.0, 100.0, 250.3]) {
		it(`qualifies ${hz} Hz CTCSS`, () => {
			const audio = mix(
				ctcssMix({ rate: RATE, seconds: 1.5, hz }),
				voiceLike({ rate: RATE, seconds: 1.5, seed: 11 }),
			)
			const { first, last } = feed(new ToneEvidence(), audio)
			expect(last).toMatchObject({ kind: "ctcss", hz })
			expect(first).toBeGreaterThanOrEqual(6_000)
		})
	}

	for (const [code, polarity] of [
		["023", "normal"],
		["754", "inverted"],
	] as const) {
		it(`qualifies DCS ${code}${polarity === "normal" ? "N" : "I"}`, () => {
			const audio = mix(
				dcsMix({
					rate: RATE,
					seconds: 1.5,
					code: Number.parseInt(code, 8),
					polarity,
				}),
				voiceLike({ rate: RATE, seconds: 1.5, seed: 5, level: 0.3 }),
			)
			const { last } = feed(new ToneEvidence(), audio)
			expect(last?.kind).toBe("dcs")
			const twin = dcsTwin({ code, polarity })
			expect(last?.kind === "dcs" ? [last.dcs] : []).toSatisfy(
				(found: unknown[]) =>
					JSON.stringify(found) === JSON.stringify([{ code, polarity }]) ||
					JSON.stringify(found) === JSON.stringify([twin]),
			)
		})
	}

	it("off-table tone never qualifies", () => {
		expect(feed(new ToneEvidence(), sine(1_000, 2)).first).toBe(-1)
		expect(feed(new ToneEvidence(), sine(60, 2)).first).toBe(-1)
	})

	it("voice and FSK alone never qualify", () => {
		expect(
			feed(new ToneEvidence(), voiceLike({ rate: RATE, seconds: 2, seed: 2 }))
				.first,
		).toBe(-1)
		for (const levels of [2, 4] as const)
			expect(
				feed(
					new ToneEvidence(),
					fskBursts({
						rate: RATE,
						seconds: 2,
						levels,
						baud: levels === 2 ? 1_200 : 4_800,
						burstMs: 200,
						gapMs: 50,
						seed: 9,
					}),
				).first,
			).toBe(-1)
	})

	it("DCS hold expires 2 word periods after the last qualifying word", () => {
		const signal = new Float32Array(RATE * 3)
		signal.set(
			dcsMix({ rate: RATE, seconds: 1.5, code: 0o23, polarity: "normal" }),
		)
		// A twin decoder on the same input shows the bit clock and the word hits.
		const probe = new DcsDecoder()
		const tone = new ToneEvidence()
		const hold = DCS_WORD_BITS * 2
		let lastBit = 0
		let lastHits = 0
		let lastReading = -1
		let lastWordBit = -1
		const activeAtBit = new Map<number, boolean>()
		for (const sample of signal) {
			probe.pushSample(sample)
			tone.push(sample)
			const bits = probe.bitCount()
			if (bits === lastBit) continue
			lastBit = bits
			const reading = probe.wordReading()
			const hits = probe.wordHits()
			if (hits >= 2 && (hits !== lastHits || reading !== lastReading))
				lastWordBit = bits
			lastHits = hits
			lastReading = reading
			activeAtBit.set(bits, tone.current()?.kind === "dcs")
		}
		expect(lastWordBit).toBeGreaterThan(0)
		expect(activeAtBit.get(lastWordBit + hold - 1)).toBe(true)
		expect(activeAtBit.get(lastWordBit + hold)).toBe(false)
		expect(activeAtBit.get(lastWordBit + hold + 1)).toBe(false)
	})

	it("reset clears", () => {
		const tone = new ToneEvidence()
		feed(tone, ctcssMix({ rate: RATE, seconds: 1.5, hz: 100 }))
		expect(tone.current()).not.toBeNull()
		tone.reset()
		expect(tone.current()).toBeNull()
		// Fresh after reset: the same input qualifies at the same sample as a new instance.
		const input = ctcssMix({ rate: RATE, seconds: 1.5, hz: 67 })
		expect(feed(tone, input).first).toBe(feed(new ToneEvidence(), input).first)
	})
})

function framesWithCluster(cluster: number): AnalogTrialFrame[] {
	return Array.from({ length: 20 }, () => ({
		carrierDb: -20,
		hfNoiseDb: -10,
		audioDb: -10,
		syllabic: 0.5,
		cluster,
	}))
}

describe("analog-trial exports keep behaviour", () => {
	it("dataLike is the median cluster test", () => {
		const stats = (cluster: number) => ({
			mode: "nfm" as const,
			frames: framesWithCluster(cluster),
			gapSamples: 0,
			floorDb: -100,
		})
		expect(dataLike(stats(0.6))).toBe(true)
		expect(dataLike(stats(0.59))).toBe(false)
		expect(dataLike({ ...stats(0.9), frames: [] })).toBe(false)
		expect(dataLike(stats(NaN))).toBe(false)
	})

	it("toneQualified needs 750 ms of audio", () => {
		expect(toneQualified({ ctcssHz: 67, dcs: null, audioSeconds: 0.75 })).toBe(
			true,
		)
		expect(toneQualified({ ctcssHz: 67, dcs: null, audioSeconds: 0.74 })).toBe(
			false,
		)
		expect(toneQualified(null)).toBe(false)
	})
})
