/**
 * Noise squelch (FM quieting) on synthetic channel IQ (WG7 req 2.2, 2.5).
 * All IQ comes from ./fm-synth.ts (seeded; seeds stated per test).
 */

import { describe, expect, it } from "vitest"
import {
	NOISE_QUIETING_DB_MAX,
	NOISE_QUIETING_DB_MIN,
	NoiseSquelch,
	noiseReferenceMeanSquare,
	validateNoiseQuietingDb,
} from "../../../src/core/noise-squelch.js"
import { LIVE_AUDIO_NOISE_QUIETING_DB } from "../../../packages/api-types/src/live-audio.js"
import { FastChannelNoise, FmChannelSynth, carrierWindows } from "./fm-synth.js"

const NFM = { sampleRate: 25_000, bandwidthHz: 12_500, deviationHz: 2_500 }
const WFM = { sampleRate: 240_000, bandwidthHz: 120_000, deviationHz: 50_000 }

/** Block index (0-based) at which the gate first reports open, or -1. */
function firstOpen(
	squelch: NoiseSquelch,
	synth: FmChannelSynth,
	maxBlocks: number,
): number {
	for (let b = 0; b < maxBlocks; b++) {
		if (squelch.processBlock(synth.next())) return b
	}
	return -1
}

describe("NoiseSquelch reference", () => {
	it.each([
		["NFM 25 kHz", NFM, 100],
		["WFM 240 kHz", WFM, 30],
	] as const)(
		"%s: predicted R is within 1 dB of measured synthetic channel noise",
		(_name, channel, blocks) => {
			const squelch = new NoiseSquelch(channel)
			const predicted = squelch.referenceMeanSquare
			expect(predicted).toBe(
				noiseReferenceMeanSquare(channel.sampleRate, channel.bandwidthHz),
			)
			// Seed 101: long (127-tap) channel filter, carrier off, any noise level.
			const synth = new FmChannelSynth({
				...channel,
				seed: 101,
				cnrDb: 0,
				carrier: () => false,
				noiseTaps: 127,
			})
			let sum = 0
			for (let b = 0; b < blocks; b++) {
				squelch.processBlock(synth.next())
				if (b >= 2) sum += squelch.lastBlockMeanSquare ?? Number.NaN
			}
			const measured = sum / (blocks - 2)
			const errorDb = Math.abs(10 * Math.log10(predicted / measured))
			expect(errorDb).toBeLessThan(1)
			expect(squelch.open).toBe(false)
		},
	)

	it("is scale free: the noise level does not change the quieting", () => {
		const quieting: number[] = []
		for (const cnrDb of [-20, 0, 30]) {
			const squelch = new NoiseSquelch(NFM)
			const synth = new FmChannelSynth({
				...NFM,
				seed: 7,
				cnrDb,
				carrier: () => false,
			})
			for (let b = 0; b < 20; b++) squelch.processBlock(synth.next())
			quieting.push(squelch.lastQuietingDb ?? Number.NaN)
		}
		expect(Math.abs((quieting[0] ?? 0) - (quieting[1] ?? 1))).toBeLessThan(1e-3)
		expect(Math.abs((quieting[1] ?? 0) - (quieting[2] ?? 1))).toBeLessThan(1e-3)
	})
})

describe("NoiseSquelch gate (default 6 dB)", () => {
	it("noise alone never opens in 10 minutes at 25 kHz (seed 0x7e57)", () => {
		const squelch = new NoiseSquelch(NFM)
		const noise = new FastChannelNoise(NFM.sampleRate, NFM.bandwidthHz, 0x7e57)
		const iq = new Float32Array(250 * 2)
		const block = Buffer.from(iq.buffer)
		const blocks = 10 * 60 * 100
		let opens = 0
		let maxQuieting = Number.NEGATIVE_INFINITY
		for (let b = 0; b < blocks; b++) {
			noise.fill(iq)
			if (squelch.processBlock(block)) opens++
			const q = squelch.lastQuietingDb
			if (q !== null && q > maxQuieting) maxQuieting = q
		}
		expect(opens).toBe(0)
		// Margin: noise blocks stay well below the 6 dB threshold.
		expect(maxQuieting).toBeLessThan(LIVE_AUDIO_NOISE_QUIETING_DB.default - 2)
	}, 60_000)

	it("a 12 dB CNR speech carrier opens within 50 ms (20 seeds, random offset ±1 kHz and phase)", () => {
		for (let seed = 1; seed <= 20; seed++) {
			const squelch = new NoiseSquelch(NFM)
			const synth = new FmChannelSynth({ ...NFM, seed, cnrDb: 12 })
			const block = firstOpen(squelch, synth, 5)
			expect(block, `seed ${seed}`).toBeGreaterThanOrEqual(0)
		}
	})

	it("closes within hang + 20 ms after the carrier stops (seed 33)", () => {
		const squelch = new NoiseSquelch(NFM)
		const synth = new FmChannelSynth({
			...NFM,
			seed: 33,
			cnrDb: 12,
			carrier: carrierWindows([[0, 500]], NFM.sampleRate),
		})
		let closedAtMs = -1
		for (let b = 0; b < 150; b++) {
			const open = squelch.processBlock(synth.next())
			const endMs = (b + 1) * 10
			if (endMs === 500) expect(open).toBe(true)
			if (endMs > 500 && !open) {
				closedAtMs = endMs
				break
			}
		}
		expect(closedAtMs).toBeGreaterThan(500)
		expect(closedAtMs - 500).toBeLessThanOrEqual(250 + 20)
	})

	it("WFM at 240 kHz: 12 dB CNR opens within 50 ms, noise alone stays closed (seed 55)", () => {
		const carrier = new FmChannelSynth({ ...WFM, seed: 55, cnrDb: 12 })
		expect(firstOpen(new NoiseSquelch(WFM), carrier, 5)).toBeGreaterThanOrEqual(
			0,
		)
		const squelch = new NoiseSquelch(WFM)
		const noise = new FastChannelNoise(WFM.sampleRate, WFM.bandwidthHz, 55)
		const iq = new Float32Array(2400 * 2)
		const block = Buffer.from(iq.buffer)
		for (let b = 0; b < 1000; b++) {
			noise.fill(iq)
			expect(squelch.processBlock(block)).toBe(false)
		}
	}, 30_000)

	it("WFM: closes within hang + 20 ms after the carrier stops (seed 56)", () => {
		const squelch = new NoiseSquelch(WFM)
		const synth = new FmChannelSynth({
			...WFM,
			seed: 56,
			cnrDb: 15,
			carrier: carrierWindows([[0, 200]], WFM.sampleRate),
		})
		let closedAtMs = -1
		for (let b = 0; b < 60; b++) {
			const open = squelch.processBlock(synth.next())
			if ((b + 1) * 10 === 200) expect(open).toBe(true)
			if ((b + 1) * 10 > 200 && !open) {
				closedAtMs = (b + 1) * 10
				break
			}
		}
		expect(closedAtMs - 200).toBeGreaterThan(0)
		expect(closedAtMs - 200).toBeLessThanOrEqual(270)
	})
})

describe("NoiseSquelch thresholds", () => {
	it("accepts the bounds 1 and 30 dB and refuses values past them", () => {
		expect(validateNoiseQuietingDb(NOISE_QUIETING_DB_MIN)).toBe(1)
		expect(validateNoiseQuietingDb(NOISE_QUIETING_DB_MAX)).toBe(30)
		expect(NOISE_QUIETING_DB_MIN).toBe(LIVE_AUDIO_NOISE_QUIETING_DB.min)
		expect(NOISE_QUIETING_DB_MAX).toBe(LIVE_AUDIO_NOISE_QUIETING_DB.max)
		for (const bad of [0.99, 30.01, 0, -6, Number.NaN, Infinity]) {
			expect(() => validateNoiseQuietingDb(bad)).toThrow(/noiseQuietingDb/)
			expect(() => new NoiseSquelch({ ...NFM, quietingDb: bad })).toThrow()
			const squelch = new NoiseSquelch(NFM)
			expect(() => squelch.setQuietingDb(bad)).toThrow()
			expect(squelch.quietingDb).toBe(6)
		}
	})

	it("1 dB opens on a 9 dB CNR carrier within 50 ms (seed 9)", () => {
		const squelch = new NoiseSquelch({ ...NFM, quietingDb: 1 })
		const synth = new FmChannelSynth({ ...NFM, seed: 9, cnrDb: 9 })
		expect(firstOpen(squelch, synth, 5)).toBeGreaterThanOrEqual(0)
	})

	it("30 dB stays closed on a 12 dB CNR carrier but opens on a 40 dB one (seed 30)", () => {
		const weak = new NoiseSquelch({ ...NFM, quietingDb: 30 })
		const weakSynth = new FmChannelSynth({ ...NFM, seed: 30, cnrDb: 12 })
		expect(firstOpen(weak, weakSynth, 100)).toBe(-1)
		const strong = new NoiseSquelch({ ...NFM, quietingDb: 30 })
		const strongSynth = new FmChannelSynth({ ...NFM, seed: 30, cnrDb: 40 })
		expect(firstOpen(strong, strongSynth, 5)).toBeGreaterThanOrEqual(0)
	})

	it("setQuietingDb applies at runtime without resetting the gate", () => {
		const squelch = new NoiseSquelch(NFM)
		const synth = new FmChannelSynth({ ...NFM, seed: 4, cnrDb: 20 })
		expect(firstOpen(squelch, synth, 5)).toBeGreaterThanOrEqual(0)
		squelch.setQuietingDb(30)
		expect(squelch.open).toBe(true)
		expect(squelch.quietingDb).toBe(30)
	})
})

describe("NoiseSquelch failure paths", () => {
	it("silent (all-zero) IQ never opens", () => {
		const squelch = new NoiseSquelch(NFM)
		const zero = Buffer.alloc(250 * 8)
		for (let b = 0; b < 100; b++) expect(squelch.processBlock(zero)).toBe(false)
		expect(squelch.lastQuietingDb).toBeNull()
	})

	it("NaN or infinite IQ never opens and closes an open gate after the hang", () => {
		for (const bad of [Number.NaN, Infinity, -Infinity]) {
			const fresh = new NoiseSquelch(NFM)
			const poison = new Float32Array(500).fill(bad)
			const buf = Buffer.from(poison.buffer)
			for (let b = 0; b < 10; b++) expect(fresh.processBlock(buf)).toBe(false)

			// A clean carrier with one NaN sample per block: no block counts.
			const mixed = new FmChannelSynth({ ...NFM, seed: 2, cnrDb: null })
			const squelchMixed = new NoiseSquelch(NFM)
			for (let b = 0; b < 10; b++) {
				const block = Buffer.from(mixed.next())
				block.writeFloatLE(bad, 80)
				expect(squelchMixed.processBlock(block)).toBe(false)
			}

			const open = new NoiseSquelch(NFM)
			const carrier = new FmChannelSynth({ ...NFM, seed: 3, cnrDb: 30 })
			expect(firstOpen(open, carrier, 5)).toBeGreaterThanOrEqual(0)
			let closed = -1
			for (let b = 0; b < 40; b++) {
				if (!open.processBlock(buf)) {
					closed = b + 1
					break
				}
			}
			expect(closed).toBeGreaterThan(0)
			expect(closed * 10).toBeLessThanOrEqual(270)
			// The state recovers: a clean carrier reopens.
			expect(firstOpen(open, carrier, 5)).toBeGreaterThanOrEqual(0)
		}
	})

	it("a clean carrier keeps quieting high across block boundaries (state carried)", () => {
		const squelch = new NoiseSquelch(NFM)
		const synth = new FmChannelSynth({
			...NFM,
			seed: 5,
			cnrDb: null,
			audio: "silence",
			offsetHz: 700,
		})
		squelch.processBlock(synth.next())
		for (let b = 0; b < 20; b++) {
			squelch.processBlock(synth.next())
			expect(squelch.lastQuietingDb ?? 0).toBeGreaterThan(60)
		}
	})

	it("unaligned and offset buffers give the same result as aligned ones", () => {
		const synth = new FmChannelSynth({ ...NFM, seed: 12, cnrDb: 10 })
		const blocks = synth.render(5)
		const aligned = new NoiseSquelch(NFM)
		const unaligned = new NoiseSquelch(NFM)
		const offset = new NoiseSquelch(NFM)
		for (const block of blocks) {
			aligned.processBlock(block)
			const shifted = Buffer.alloc(block.length + 3)
			block.copy(shifted, 3)
			unaligned.processBlock(shifted.subarray(3))
			const padded = Buffer.alloc(block.length + 16)
			block.copy(padded, 8)
			offset.processBlock(padded, 8, block.length)
			expect(unaligned.lastBlockMeanSquare).toBe(aligned.lastBlockMeanSquare)
			expect(offset.lastBlockMeanSquare).toBe(aligned.lastBlockMeanSquare)
		}
	})

	it("reset closes the gate", () => {
		const squelch = new NoiseSquelch(NFM)
		const synth = new FmChannelSynth({ ...NFM, seed: 6, cnrDb: 30 })
		expect(firstOpen(squelch, synth, 5)).toBeGreaterThanOrEqual(0)
		squelch.reset()
		expect(squelch.open).toBe(false)
		expect(squelch.lastQuietingDb).toBeNull()
	})
})
