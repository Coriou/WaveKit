import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	OPERATOR_RETUNE_SETTLE_MS,
	blockSamplesOf,
	frameTrust,
	operatorRetuneTiming,
} from "../../../../src/core/spectrum/retune-settle.js"
import type { BlockSummary } from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	tone,
} from "../../../mocks/scanner/signals.js"
import {
	BLOCK,
	CENTRE,
	FS,
	Harness,
	N,
	yieldToRpc,
} from "./pipeline-harness.js"

describe("operator retune settle helpers (WG9 req 3.4)", () => {
	it("keeps the constant within the 300 ms bound", () => {
		expect(OPERATOR_RETUNE_SETTLE_MS).toBeGreaterThan(0)
		expect(OPERATOR_RETUNE_SETTLE_MS).toBeLessThanOrEqual(300)
	})

	it("uses the operator settle, the same stale cap and an unverified window up to the network settle", () => {
		const t = operatorRetuneTiming({
			commandSample: 10_000,
			bufferedSamples: 500,
			sampleRateHz: 1_024_000,
			networkSettleMs: 1000,
		})
		expect(t).toEqual({
			settleSamples: Math.round((OPERATOR_RETUNE_SETTLE_MS * 1_024_000) / 1000),
			staleMaxMs: OPERATOR_RETUNE_SETTLE_MS,
			verifiedFromSample: 10_000 + 500 + 1_024_000,
		})
	})

	it("never settles longer than the network settle, and has no window at or below the bound", () => {
		for (const networkSettleMs of [0, 100, OPERATOR_RETUNE_SETTLE_MS]) {
			const t = operatorRetuneTiming({
				commandSample: 0,
				bufferedSamples: 0,
				sampleRateHz: 1_000_000,
				networkSettleMs,
			})
			expect(t.settleSamples).toBe(networkSettleMs * 1000)
			expect(t.verifiedFromSample).toBeNull()
		}
	})

	it("caps the settle at the bound one millisecond past it, and opens a window", () => {
		const t = operatorRetuneTiming({
			commandSample: 0,
			bufferedSamples: 0,
			sampleRateHz: 1_000_000,
			networkSettleMs: OPERATOR_RETUNE_SETTLE_MS + 1,
		})
		expect(t.settleSamples).toBe(OPERATOR_RETUNE_SETTLE_MS * 1000)
		expect(t.verifiedFromSample).toBe((OPERATOR_RETUNE_SETTLE_MS + 1) * 1000)
		const at300 = operatorRetuneTiming({
			commandSample: 0,
			bufferedSamples: 0,
			sampleRateHz: 1_000_000,
			networkSettleMs: 300,
		})
		expect(at300.settleSamples).toBe(OPERATOR_RETUNE_SETTLE_MS * 1000)
	})

	it("labels a block that starts before the window's end unverified", () => {
		expect(frameTrust("commanded", 99, 100)).toBe("unverified")
		expect(frameTrust("commanded", 100, 100)).toBe("commanded")
		expect(frameTrust("relay", 0, 100)).toBe("unverified")
		expect(frameTrust("relay", 0, null)).toBe("relay")
		expect(frameTrust("unverified", 500, 100)).toBe("unverified")
	})

	it("computes the pipeline's block length", () => {
		expect(blockSamplesOf(50, FS, N)).toBe(BLOCK)
		expect(blockSamplesOf(1, FS, N)).toBe(N)
	})
})

const OLD_OFFSET = 40_000
const NEW_OFFSET = -40_000

function peakOffset(s: BlockSummary): number {
	let best = 0
	for (let i = 1; i < s.bins.length; i++)
		if ((s.bins[i] ?? -Infinity) > (s.bins[best] ?? -Infinity)) best = i
	return s.startHz + (best + 0.5) * s.binHz - s.centreHz
}

describe("operator retune over a small pipeline", () => {
	// Feature: web-gaps-9, Property 8: No early commanded frame
	// Validates: Requirements 3.4, 3.5
	it("never labels a block carrying pre-retune samples commanded while the bridge delay is within the network settle", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: OPERATOR_RETUNE_SETTLE_MS + 1, max: 600 }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.integer({ min: 0, max: 4000 }),
				fc.integer({ min: 1, max: 2 ** 31 - 1 }),
				async (networkSettleMs, delayFraction, bufferedSamples, seed) => {
					const h = new Harness()
					h.start()
					const rng = mulberry32(seed)
					const chunk = (n: number, offset: number) =>
						addInto(gaussianNoise(rng, n, 0.02), tone(n, FS, offset, 0.4))
					h.push(chunk(6 * BLOCK, OLD_OFFSET))
					const commandSample = h.sample
					const t = operatorRetuneTiming({
						commandSample,
						bufferedSamples,
						sampleRateHz: FS,
						networkSettleMs,
					})
					h.pending({
						epoch: 2,
						centreHz: CENTRE + 100_000,
						bufferedSamples,
						settleSamples: t.settleSamples,
						staleMaxMs: t.staleMaxMs,
					})
					// samples of the old centre keep arriving for the bridge delay (≤ network settle)
					const delaySamples = Math.floor(
						delayFraction * ((networkSettleMs * FS) / 1000 + bufferedSamples),
					)
					if (delaySamples > 0) h.push(chunk(delaySamples, OLD_OFFSET))
					h.push(
						chunk(
							Math.round(((networkSettleMs + 300) * FS) / 1000),
							NEW_OFFSET,
						),
					)
					const own = h
						.of("block-summary")
						.map(e => e.summary)
						.filter(s => s.epoch === 2)
					expect(own.length).toBeGreaterThan(0)
					const blockSamples = blockSamplesOf(50, FS, N)
					for (const s of own) {
						const start = s.endSample - blockSamples
						expect(start).toBeGreaterThanOrEqual(
							commandSample + bufferedSamples + t.settleSamples,
						)
						const trust = frameTrust("commanded", start, t.verifiedFromSample)
						if (trust !== "unverified") {
							expect(start).toBeGreaterThanOrEqual(commandSample + delaySamples)
							expect(Math.abs(peakOffset(s) - NEW_OFFSET)).toBeLessThan(2000)
						}
					}
					const stale = h
						.of("stale-discard")
						.filter(e => e.epoch === 2)
						.reduce((n, e) => n + e.blocks, 0)
					expect(stale).toBeLessThanOrEqual(
						Math.ceil(OPERATOR_RETUNE_SETTLE_MS / 50),
					)
					await yieldToRpc()
				},
			),
			{ numRuns: 100 },
		)
	}, 600_000)

	it("keeps the pipeline's own stale cap for an epoch without staleMaxMs (the scanner's)", () => {
		const h = new Harness()
		h.start()
		const rng = mulberry32(5)
		const chunk = (n: number) =>
			addInto(gaussianNoise(rng, n, 0.02), tone(n, FS, OLD_OFFSET, 0.4))
		h.push(chunk(6 * BLOCK))
		h.pending({ epoch: 2, centreHz: CENTRE + 100_000 })
		// the same baseband scene for 2 s: the scanner's 1 s stale cap applies
		h.push(chunk(40 * BLOCK))
		const stale = h
			.of("stale-discard")
			.filter(e => e.epoch === 2)
			.reduce((n, e) => n + e.blocks, 0)
		expect(stale).toBe(20)
		const capped = new Harness()
		capped.start()
		const rng2 = mulberry32(5)
		capped.push(
			addInto(
				gaussianNoise(rng2, 6 * BLOCK, 0.02),
				tone(6 * BLOCK, FS, OLD_OFFSET, 0.4),
			),
		)
		capped.pending({
			epoch: 2,
			centreHz: CENTRE + 100_000,
			staleMaxMs: OPERATOR_RETUNE_SETTLE_MS,
		})
		capped.push(
			addInto(
				gaussianNoise(rng2, 40 * BLOCK, 0.02),
				tone(40 * BLOCK, FS, OLD_OFFSET, 0.4),
			),
		)
		const cappedStale = capped
			.of("stale-discard")
			.filter(e => e.epoch === 2)
			.reduce((n, e) => n + e.blocks, 0)
		expect(cappedStale).toBe(Math.ceil(OPERATOR_RETUNE_SETTLE_MS / 50))
	}, 120_000)
})
