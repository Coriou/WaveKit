/**
 * A scanner hop's settled epoch starts at its proof boundary (PendingEpoch.awaitProofFloor and
 * proofSlackSamples): a timer hop at the later of its timer start and the `proof-floor` the engine
 * maps from its frequency receipt's B(R); a marker hop the mapping width past its marker start.
 */
import { describe, expect, it } from "vitest"
import {
	counterRun,
	gaussianNoise,
	mulberry32,
} from "../../../mocks/scanner/signals.js"
import { BLOCK, CENTRE, Harness } from "./pipeline-harness.js"

const rng = mulberry32(20261113)
const noise = (n: number) => gaussianNoise(rng, n, 0.05)
const HOP = 7

function blockEnds(h: Harness, epoch: number): number[] {
	return h
		.of("block-summary")
		.filter(e => e.summary.epoch === epoch)
		.map(e => e.summary.endSample)
}

describe("SpectrumPipeline proof floor", () => {
	it("a timer hop waits for its floor and starts there, its blocks aligned to it", () => {
		const h = new Harness()
		h.start()
		h.push(noise(2 * BLOCK))
		const command = h.sample
		h.pending({
			epoch: HOP,
			centreHz: CENTRE + 1e6,
			settleSamples: 1000,
			awaitProofFloor: true,
		})
		// No start before the floor: the timer start alone would have been command + 1000.
		expect(h.of("epoch-started")).toHaveLength(1)
		// Another epoch's floor changes nothing.
		h.send({ kind: "proof-floor", epoch: HOP + 1, sample: command + 5 })
		expect(h.of("epoch-started")).toHaveLength(1)
		h.send({ kind: "proof-floor", epoch: HOP, sample: command + 1003 })
		const started = h.of("epoch-started")[1]!
		expect(started).toMatchObject({
			startSample: command + 1003,
			settleMode: "timer",
		})
		h.push(noise(6 * BLOCK))
		const ends = blockEnds(h, started.epoch)
		expect(ends.length).toBeGreaterThanOrEqual(5)
		expect(ends[0]).toBe(command + 1003 + BLOCK)
		for (const e of ends) expect((e - started.startSample) % BLOCK).toBe(0)
		// A floor after the start changes nothing.
		h.send({ kind: "proof-floor", epoch: HOP, sample: command + 9 * BLOCK })
		expect(h.of("epoch-started")).toHaveLength(2)
	})

	it("never starts a timer hop before its timer start, whatever the floor", () => {
		const h = new Harness()
		h.start()
		h.push(noise(BLOCK))
		const command = h.sample
		h.pending({
			epoch: HOP,
			centreHz: CENTRE + 1e6,
			bufferedSamples: 200,
			settleSamples: 1000,
			awaitProofFloor: true,
		})
		h.send({ kind: "proof-floor", epoch: HOP, sample: command + 10 })
		expect(h.of("epoch-started")[1]!.startSample).toBe(command + 1200)
	})

	it("without a floor a timer hop starts at its timer start once data reaches it", () => {
		const h = new Harness()
		h.start()
		h.push(noise(BLOCK))
		const command = h.sample
		h.pending({
			epoch: HOP,
			centreHz: CENTRE + 1e6,
			settleSamples: 1000,
			awaitProofFloor: true,
		})
		h.push(noise(512), 256)
		expect(h.of("epoch-started")).toHaveLength(1)
		h.push(noise(4 * BLOCK), 256)
		const started = h.of("epoch-started")[1]!
		expect(started).toMatchObject({
			startSample: command + 1000,
			settleMode: "timer",
		})
		expect(blockEnds(h, started.epoch)[0]).toBe(command + 1000 + BLOCK)
	})

	it("a marker hop starts its slack past the counter run plus PLL settle", () => {
		const h = new Harness()
		h.start()
		h.push(noise(4 * BLOCK))
		const command = h.sample
		h.pending({
			epoch: HOP,
			centreHz: CENTRE + 1e6,
			expectMarker: true,
			pllSettleSamples: 1280,
			proofSlackSamples: 37,
		})
		h.push(noise(3000))
		h.pushBytes(counterRun(1024, 17)) // 512 samples of test-mode counter
		h.push(noise(1280 + 6 * BLOCK))
		const started = h.of("epoch-started")[1]!
		expect(started.settleMode).toBe("marker")
		// The run ends at command + 3000 + 512 (± 1 for the counter's edge), then 1280 + 37.
		expect(started.startSample).toBeGreaterThanOrEqual(
			command + 3000 + 512 + 1280 + 37,
		)
		expect(started.startSample).toBeLessThanOrEqual(
			command + 3000 + 512 + 1280 + 37 + 1,
		)
	})

	it("a marker hop that times out starts no earlier than its floor", () => {
		const h = new Harness()
		h.start()
		h.push(noise(BLOCK))
		const command = h.sample
		h.pending({
			epoch: HOP,
			centreHz: CENTRE + 1e6,
			expectMarker: true,
			markerTimeoutSamples: 2 * BLOCK,
			settleSamples: 1000,
		})
		const floor = command + 3 * BLOCK + 11
		h.send({ kind: "proof-floor", epoch: HOP, sample: floor })
		expect(h.of("epoch-started")).toHaveLength(1)
		h.push(noise(8 * BLOCK), 256)
		const started = h.of("epoch-started")[1]!
		expect(started.settleMode).toBe("timer")
		expect(started.startSample).toBe(floor)
	})

	it("a marker hop takes a larger proof-slack sent before its marker, and reports the slack it applied (P2)", () => {
		const h = new Harness()
		h.start()
		h.push(noise(4 * BLOCK))
		const command = h.sample
		h.pending({
			epoch: HOP,
			centreHz: CENTRE + 1e6,
			expectMarker: true,
			pllSettleSamples: 1280,
			proofSlackSamples: 37,
		})
		// Another epoch's, and a smaller one, change nothing; the larger one is taken.
		h.send({ kind: "proof-slack", epoch: HOP + 1, samples: 5000 })
		h.send({ kind: "proof-slack", epoch: HOP, samples: 20 })
		h.send({ kind: "proof-slack", epoch: HOP, samples: 900 })
		h.push(noise(3000))
		h.pushBytes(counterRun(1024, 17))
		h.push(noise(1280 + 900 + 6 * BLOCK))
		const started = h.of("epoch-started")[1]!
		expect(started).toMatchObject({
			settleMode: "marker",
			proofSlackSamples: 900,
		})
		expect(started.startSample).toBeGreaterThanOrEqual(
			command + 3000 + 512 + 1280 + 900,
		)
		expect(started.startSample).toBeLessThanOrEqual(
			command + 3000 + 512 + 1280 + 900 + 1,
		)
		// After the start: nothing changes.
		h.send({ kind: "proof-slack", epoch: HOP, samples: 9000 })
		expect(h.of("epoch-started")).toHaveLength(2)
	})
})
