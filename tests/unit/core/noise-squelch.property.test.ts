/**
 * Property 6: the noise squelch stays closed on noise and opens/closes on a
 * carrier (synthetic channels from ./fm-synth.ts).
 */

import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { NoiseSquelch } from "../../../src/core/noise-squelch.js"
import { FmChannelSynth, carrierWindows } from "./fm-synth.js"

const NFM = { sampleRate: 25_000, bandwidthHz: 12_500, deviationHz: 2_500 }

describe("NoiseSquelch property", () => {
	// Feature: web-gaps-7, Property 6: Noise squelch on noise and carrier
	// Validates: Requirements 2.2, 2.5
	it("noise alone never opens; a >= 12 dB CNR carrier opens within 50 ms and the gate closes within hang + 20 ms after it stops", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 0x7fffffff }),
				fc.double({ min: -1000, max: 1000, noNaN: true }),
				fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
				fc.double({ min: 12, max: 40, noNaN: true }),
				fc.integer({ min: 0, max: 30 }),
				(seed, offsetHz, phase, cnrDb, leadBlocks) => {
					// Noise only (carrier off), level-independent: 300 ms.
					const noiseOnly = new NoiseSquelch(NFM)
					const noise = new FmChannelSynth({
						...NFM,
						seed,
						cnrDb: 0,
						carrier: () => false,
					})
					for (let b = 0; b < 30; b++) {
						if (noiseOnly.processBlock(noise.next())) return false
					}

					// Noise for `leadBlocks`, carrier for 150 ms, then noise.
					const onMs = leadBlocks * 10
					const offMs = onMs + 150
					const squelch = new NoiseSquelch(NFM)
					const synth = new FmChannelSynth({
						...NFM,
						seed: seed ^ 0x5a5a,
						cnrDb,
						offsetHz,
						phase,
						carrier: carrierWindows([[onMs, offMs]], NFM.sampleRate),
					})
					let openedAt = -1
					let closedAt = -1
					for (let b = 0; b < leadBlocks + 15 + 30; b++) {
						const endMs = (b + 1) * 10
						const open = squelch.processBlock(synth.next())
						if (endMs <= onMs && open) return false
						if (open && openedAt < 0) openedAt = endMs
						if (endMs > offMs && !open && closedAt < 0) closedAt = endMs
					}
					return (
						openedAt > onMs &&
						openedAt - onMs <= 50 &&
						closedAt > offMs &&
						closedAt - offMs <= 250 + 20
					)
				},
			),
			{ numRuns: 100 },
		)
		expect(true).toBe(true)
	}, 60_000)
})
