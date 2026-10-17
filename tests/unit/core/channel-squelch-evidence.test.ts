/**
 * WG10 activity hygiene: ChannelSquelch carrier evidence (`carrierEvidence`, `blockCarrier()`)
 * never changes the gated IQ, and the live demodulator counts it for nfm/wfm only.
 */
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import { ChannelSquelch } from "../../../src/core/channel-squelch.js"
import {
	channelIq,
	createDemodHarness,
	writeAndSettle,
} from "./live-demodulator-continuity-fakes.js"

const RATE = 25_000
const BLOCK = 250

function noiseBlock(seed: number, amplitude: number): Buffer {
	let x = seed >>> 0 || 1
	const next = (): number => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return ((x >>> 0) / 0xffffffff) * 2 - 1
	}
	const block = Buffer.alloc(BLOCK * 8)
	for (let n = 0; n < BLOCK * 2; n++)
		block.writeFloatLE(next() * amplitude, n * 4)
	return block
}

function carrierBlock(amplitude: number): Buffer {
	return channelIq(BLOCK, amplitude)
}

describe("ChannelSquelch carrier evidence (WG10 activity hygiene)", () => {
	it("a steady carrier is evidence; broadband noise is not", () => {
		const squelch = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: -40,
			bandwidthHz: 12_500,
			carrierEvidence: true,
		})
		expect(squelch.hasCarrierEvidence).toBe(true)
		expect(squelch.blockCarrier()).toBe(false)
		squelch.process(carrierBlock(0.05))
		expect(squelch.blockCarrier()).toBe(true)
		let noisy = 0
		for (let i = 0; i < 50; i++) {
			squelch.process(noiseBlock(i + 1, 0.05))
			if (squelch.blockCarrier()) noisy += 1
		}
		expect(noisy).toBe(0)
		squelch.setCarrierEvidence(false)
		expect(squelch.blockCarrier()).toBe(false)
		squelch.process(carrierBlock(0.05))
		expect(squelch.blockCarrier()).toBe(false)
	})

	it("noise mode reads the gate's own quieting at its threshold", () => {
		const squelch = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: -40,
			bandwidthHz: 12_500,
			mode: "noise",
			carrierEvidence: true,
		})
		squelch.process(carrierBlock(0.05))
		expect(squelch.blockCarrier()).toBe(true)
		squelch.process(noiseBlock(7, 0.05))
		expect(squelch.blockCarrier()).toBe(false)
	})

	it("never changes the gated output in any squelch mode", () => {
		// Feature: web-gaps-10, Property: carrier evidence never gates
		// Validates: activity hygiene rule 3 (audio gating unchanged)
		const blockArb = fc.oneof(
			fc
				.record({
					seed: fc.integer({ min: 1, max: 1e9 }),
					amp: fc.double({ min: 1e-4, max: 0.5, noNaN: true }),
				})
				.map(({ seed, amp }) => noiseBlock(seed, amp)),
			fc.double({ min: 1e-4, max: 0.5, noNaN: true }).map(carrierBlock),
		)
		fc.assert(
			fc.property(
				fc.array(blockArb, { minLength: 1, maxLength: 40 }),
				fc.constantFrom("manual", "auto", "noise"),
				fc.option(fc.double({ min: -90, max: -20, noNaN: true }), {
					nil: null,
				}),
				(blocks, mode, floor) => {
					const make = (evidence: boolean) =>
						new ChannelSquelch({
							sampleRate: RATE,
							thresholdDbfs: -45,
							bandwidthHz: 12_500,
							...(mode === "noise" ? { mode: "noise" as const } : {}),
							...(mode === "auto" ? { carrierObserver: true } : {}),
							...(evidence ? { carrierEvidence: true } : {}),
						})
					const plain = make(false)
					const measured = make(true)
					for (const block of blocks) {
						plain.setNoiseFloorDbfs(floor)
						measured.setNoiseFloorDbfs(floor)
						const a = Buffer.concat(plain.process(block))
						const b = Buffer.concat(measured.process(block))
						expect(b.equals(a)).toBe(true)
						expect(measured.open).toBe(plain.open)
						expect(measured.blockQuieted()).toBe(plain.blockQuieted())
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("LiveDemodulator carrierBlocks (WG10 activity hygiene)", () => {
	type Harness = Awaited<ReturnType<typeof createDemodHarness>>
	let harness: Harness | null = null
	afterEach(async () => {
		await harness?.dispose()
		harness = null
	})

	it("counts carrier blocks for nfm in manual mode", async () => {
		harness = await createDemodHarness({
			config: { squelchMode: "manual", modulation: "nfm", squelch: -40 },
		})
		expect(harness.demod.carrierBlocks()).toBeNull()
		await harness.demod.start()
		expect(harness.demod.carrierBlocks()).toBe(0)
		const front = harness.current().front
		await writeAndSettle(front.stdout, channelIq(2_500, 0.1))
		const counted = harness.demod.carrierBlocks()
		expect(counted).not.toBeNull()
		expect(counted!).toBeGreaterThan(0)
	})

	it("is null for am (no carrier evidence)", async () => {
		harness = await createDemodHarness({
			config: { squelchMode: "manual", modulation: "am", squelch: -40 },
		})
		await harness.demod.start()
		expect(harness.demod.carrierBlocks()).toBeNull()
	})
})
