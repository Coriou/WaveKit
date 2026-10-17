/**
 * ChannelSquelch noise mode (WG7 req 2.1, 2.2): gate from the FM quieting,
 * power measurement still running, runtime mode and threshold changes, and
 * the power (manual/auto) path untouched for instances that never switch.
 */

import { describe, expect, it } from "vitest"
import { ChannelSquelch } from "../../../src/core/channel-squelch.js"
import { FmChannelSynth, carrierWindows } from "./fm-synth.js"

const NFM = { sampleRate: 25_000, bandwidthHz: 12_500 }

function isMuted(buf: Buffer): boolean {
	const i0 = buf.readFloatLE(0)
	const q0 = buf.readFloatLE(4)
	if (Math.hypot(i0, q0) > 1.01e-4) return false
	for (let o = 0; o + 8 <= buf.length; o += 8) {
		if (buf.readFloatLE(o) !== i0 || buf.readFloatLE(o + 4) !== q0) return false
	}
	return true
}

function feed(squelch: ChannelSquelch, synth: FmChannelSynth, blocks: number) {
	const states: boolean[] = []
	const outputs: Buffer[] = []
	for (let b = 0; b < blocks; b++) {
		for (const out of squelch.process(Buffer.from(synth.next()))) {
			outputs.push(out)
			states.push(squelch.open)
		}
	}
	return { states, outputs }
}

describe("ChannelSquelch noise mode", () => {
	it("defaults to power mode with the default quieting threshold", () => {
		const squelch = new ChannelSquelch({
			sampleRate: 25_000,
			thresholdDbfs: -40,
		})
		expect(squelch.mode).toBe("power")
		expect(squelch.noiseQuietingDb).toBe(6)
		expect(squelch.noiseQuietingLevelDb).toBeNull()
	})

	it("mutes noise and passes a 12 dB CNR carrier, ignoring the power threshold (seed 21)", () => {
		// A threshold of -0.001 dBFS would never open on power.
		const squelch = new ChannelSquelch({
			...NFM,
			thresholdDbfs: -0.001,
			mode: "noise",
		})
		expect(squelch.open).toBe(false)
		const synth = new FmChannelSynth({
			...NFM,
			seed: 21,
			cnrDb: 12,
			carrier: carrierWindows([[300, 800]], NFM.sampleRate),
		})
		const { states, outputs } = feed(squelch, synth, 120)
		for (let b = 0; b < 30; b++) {
			expect(states[b]).toBe(false)
			expect(isMuted(outputs[b] ?? Buffer.alloc(8))).toBe(true)
		}
		const openIndex = states.findIndex(Boolean)
		expect(openIndex).toBeGreaterThanOrEqual(30)
		expect(openIndex).toBeLessThan(35)
		expect(isMuted(outputs[openIndex] ?? Buffer.alloc(8))).toBe(false)
		const closeIndex = states.findIndex((open, b) => b > openIndex && !open)
		expect((closeIndex + 1) * 10 - 800).toBeLessThanOrEqual(270)
		expect(squelch.powerDbfs).not.toBeNull()
		expect(squelch.noiseQuietingLevelDb).not.toBeNull()
	})

	it("keeps measuring channel power in noise mode", () => {
		const squelch = new ChannelSquelch({
			...NFM,
			thresholdDbfs: null,
			mode: "noise",
		})
		const synth = new FmChannelSynth({ ...NFM, seed: 22, cnrDb: null })
		feed(squelch, synth, 20)
		expect(squelch.powerDbfs).toBeCloseTo(0, 1)
	})

	it("setThreshold(null) does not force the gate open in noise mode", () => {
		const squelch = new ChannelSquelch({
			...NFM,
			thresholdDbfs: -50,
			mode: "noise",
		})
		squelch.setThreshold(null)
		expect(squelch.open).toBe(false)
		const synth = new FmChannelSynth({
			...NFM,
			seed: 23,
			cnrDb: 0,
			carrier: () => false,
		})
		const { states } = feed(squelch, synth, 30)
		expect(states.every(open => !open)).toBe(true)
	})

	it("switches modes at runtime without a restart", () => {
		const squelch = new ChannelSquelch({ ...NFM, thresholdDbfs: null })
		expect(squelch.open).toBe(true)
		squelch.setMode("noise")
		expect(squelch.mode).toBe("noise")
		expect(squelch.open).toBe(false)
		const noise = new FmChannelSynth({
			...NFM,
			seed: 24,
			cnrDb: 0,
			carrier: () => false,
		})
		expect(feed(squelch, noise, 20).states.every(open => !open)).toBe(true)
		const carrier = new FmChannelSynth({ ...NFM, seed: 25, cnrDb: 20 })
		expect(feed(squelch, carrier, 5).states.some(Boolean)).toBe(true)
		squelch.setNoiseQuietingDb(30)
		expect(squelch.noiseQuietingDb).toBe(30)
		squelch.setMode("power")
		expect(squelch.mode).toBe("power")
		expect(squelch.open).toBe(true)
		squelch.setThreshold(-30)
		squelch.setMode("noise")
		squelch.setMode("noise")
		expect(squelch.open).toBe(false)
		squelch.setMode("power")
		expect(squelch.open).toBe(false)
	})

	it("refuses quieting thresholds past the bounds and keeps the old one", () => {
		const squelch = new ChannelSquelch({ ...NFM, thresholdDbfs: null })
		squelch.setNoiseQuietingDb(1)
		squelch.setNoiseQuietingDb(30)
		for (const bad of [0.5, 31, Number.NaN]) {
			expect(() => squelch.setNoiseQuietingDb(bad)).toThrow(/noiseQuietingDb/)
		}
		expect(squelch.noiseQuietingDb).toBe(30)
		expect(
			() =>
				new ChannelSquelch({ ...NFM, thresholdDbfs: null, noiseQuietingDb: 0 }),
		).toThrow()
	})

	it("power mode output is byte-identical with and without the new options (seed 26)", () => {
		const plain = new ChannelSquelch({ sampleRate: 25_000, thresholdDbfs: -25 })
		const withOptions = new ChannelSquelch({
			...NFM,
			thresholdDbfs: -25,
			mode: "power",
			noiseQuietingDb: 12,
		})
		const synth = new FmChannelSynth({
			...NFM,
			seed: 26,
			cnrDb: 10,
			carrier: carrierWindows(
				[
					[100, 400],
					[700, 750],
				],
				NFM.sampleRate,
			),
		})
		for (let b = 0; b < 120; b++) {
			const chunk = Buffer.from(synth.next())
			const a = Buffer.concat(plain.process(chunk))
			const c = Buffer.concat(withOptions.process(chunk))
			expect(c.equals(a)).toBe(true)
			expect(withOptions.open).toBe(plain.open)
			expect(withOptions.powerDbfs).toBe(plain.powerDbfs)
		}
	})
})
