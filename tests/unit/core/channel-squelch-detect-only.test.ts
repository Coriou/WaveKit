/**
 * ChannelSquelch detect-only (Listen, the open squelch): the gate decides exactly as a gating
 * squelch on the same input, while every block leaves unchanged.
 */

import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { ChannelSquelch } from "../../../src/core/channel-squelch.js"

const RATE = 25_000
const BLOCK_SAMPLES = 250

/** A constant-phase block at `dbfs` (complex float32), phase `phase` rad. */
function block(dbfs: number, phase = 0.3): Buffer {
	const out = Buffer.alloc(BLOCK_SAMPLES * 8)
	const magnitude = 10 ** (dbfs / 20)
	for (let n = 0; n < BLOCK_SAMPLES; n++) {
		out.writeFloatLE(magnitude * Math.cos(phase + n * 0.01), n * 8)
		out.writeFloatLE(magnitude * Math.sin(phase + n * 0.01), n * 8 + 4)
	}
	return out
}

function run(
	levels: readonly number[],
	options: { detectOnly?: boolean; muteZeros?: boolean; threshold: number },
): { open: boolean[]; out: Buffer[]; inputs: Buffer[] } {
	const squelch = new ChannelSquelch({
		sampleRate: RATE,
		thresholdDbfs: options.threshold,
		hangMs: 250,
		...(options.detectOnly === true ? { detectOnly: true } : {}),
		...(options.muteZeros === true ? { muteZeros: true } : {}),
	})
	const open: boolean[] = []
	const out: Buffer[] = []
	const inputs: Buffer[] = []
	for (const dbfs of levels) {
		const input = block(dbfs)
		inputs.push(input)
		for (const emitted of squelch.process(Buffer.from(input))) out.push(emitted)
		open.push(squelch.open)
	}
	return { open, out, inputs }
}

describe("ChannelSquelch detect-only", () => {
	const scene = [
		...Array<number>(30).fill(-70),
		...Array<number>(50).fill(-30),
		...Array<number>(60).fill(-70),
		...Array<number>(20).fill(-35),
		...Array<number>(40).fill(-70),
	]

	it("decides like the gating squelch and passes every block byte-identical", () => {
		const gated = run(scene, { threshold: -50 })
		const detect = run(scene, { threshold: -50, detectOnly: true })
		expect(detect.open).toEqual(gated.open)
		expect(detect.open.includes(true)).toBe(true)
		expect(detect.open.includes(false)).toBe(true)
		for (let i = 0; i < scene.length; i++)
			expect(detect.out[i]!.equals(detect.inputs[i]!)).toBe(true)
		// The gating squelch replaced its closed blocks.
		expect(gated.out.some((b, i) => !b.equals(gated.inputs[i]!))).toBe(true)
	})

	it("A19 envelope runs: no closed span is logged, so no PCM is muted", () => {
		const detect = run(scene, {
			threshold: -50,
			detectOnly: true,
			muteZeros: true,
		})
		for (let i = 0; i < scene.length; i++)
			expect(detect.out[i]!.equals(detect.inputs[i]!)).toBe(true)
		const squelch = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: -50,
			muteZeros: true,
			detectOnly: true,
		})
		squelch.process(block(-70))
		expect(squelch.open).toBe(false)
		expect(squelch.closedSpansInFlight).toBe(0)
		const pcm = Buffer.alloc(BLOCK_SAMPLES * 2, 1)
		squelch.muteClosedPcm(pcm, 0, 2)
		expect(pcm.every(b => b === 1)).toBe(true)
	})

	it("switches at runtime: off gates the next closed block, on passes it", () => {
		const squelch = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: -50,
		})
		const quiet = block(-70)
		expect(squelch.detectOnly).toBe(false)
		expect(squelch.process(Buffer.from(quiet))[0]!.equals(quiet)).toBe(false)
		squelch.setDetectOnly(true)
		expect(squelch.detectOnly).toBe(true)
		// The output was closed: the passed IQ is rotated to continue the muted phase, at the
		// input's power (an FM, AM or SSB demodulator hears the same signal).
		const passed = squelch.process(Buffer.from(quiet))[0]!
		expect(squelch.open).toBe(false)
		expect(power(passed)).toBeCloseTo(power(quiet), 6)
		squelch.setDetectOnly(false)
		expect(squelch.process(Buffer.from(quiet))[0]!.equals(quiet)).toBe(false)
		expect(power(squelch.process(Buffer.from(quiet))[0]!)).toBeLessThan(1e-7)
	})

	// Feature: listen, Property 1: detect-only never changes the gate decision or the IQ
	// Validates: design C (Open: stage 1 keeps detecting at the Auto threshold, all audio plays)
	it("property: any level sequence decides alike and passes unchanged", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: -90, max: -5 }), {
					minLength: 1,
					maxLength: 120,
				}),
				fc.integer({ min: -80, max: -10 }),
				(levels, threshold) => {
					const gated = run(levels, { threshold })
					const detect = run(levels, { threshold, detectOnly: true })
					expect(detect.open).toEqual(gated.open)
					for (let i = 0; i < levels.length; i++)
						expect(detect.out[i]!.equals(detect.inputs[i]!)).toBe(true)
				},
			),
			{ numRuns: 100 },
		)
	})
})

function power(iq: Buffer): number {
	let sum = 0
	for (let o = 0; o < iq.length; o += 4) sum += iq.readFloatLE(o) ** 2
	return sum / (iq.length / 8)
}
