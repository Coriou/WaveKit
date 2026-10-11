import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	addInto,
	counterRun,
	gaussianNoise,
	mulberry32,
	tone,
} from "../../../mocks/scanner/signals.js"
import { BLOCK, CENTRE, FS, Harness, N } from "./pipeline-harness.js"

const SIGMA = 0.05
const POISON_HZ = 30_000 // baseband offset of a loud tone in samples that must never be used
const PLL = 1280

const stepArb = fc.record({
	kind: fc.constantFrom("marker", "timer", "gap"),
	lead: fc.integer({ min: BLOCK, max: 3 * BLOCK }),
	chunk: fc.integer({ min: 64, max: 6000 }),
	stale: fc.integer({ min: 0, max: 2 * BLOCK }),
	settle: fc.integer({ min: 0, max: 2 * BLOCK }),
	run: fc.integer({ min: 128, max: 2000 }),
	gap: fc.integer({ min: 1, max: 3 * BLOCK }),
	startByte: fc.integer({ min: 0, max: 255 }),
})

describe("SpectrumPipeline epochs and gaps", () => {
	it("never lets pre-settle, counter-run or gap samples into a block and keeps indices absolute", () => {
		// Feature: signal-discovery-scanner, Property 6: Epoch and gap accounting
		// Validates: spec § 4.1, § 4.6
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 0x7fffffff }),
				fc.array(stepArb, { minLength: 1, maxLength: 4 }),
				(seed, steps) => {
					const rng = mulberry32(seed)
					const h = new Harness()
					h.start({ inWindow: false })
					let centre = CENTRE
					const expected: {
						command: number
						start: number
						marker: boolean
						centre: number
					}[] = []
					const poison = (n: number) =>
						addInto(gaussianNoise(rng, n, SIGMA), tone(n, FS, POISON_HZ, 0.4))
					for (const s of steps) {
						h.push(gaussianNoise(rng, s.lead, SIGMA), s.chunk)
						if (s.kind === "gap") {
							h.gap(s.gap)
							continue
						}
						const command = h.sample
						centre += 500_000
						if (s.kind === "timer") {
							h.pending({
								centreHz: centre,
								bufferedSamples: s.stale,
								settleSamples: s.settle,
							})
							if (s.stale + s.settle > 0)
								h.push(poison(s.stale + s.settle), s.chunk)
							expected.push({
								command,
								start: command + s.stale + s.settle,
								marker: false,
								centre,
							})
						} else {
							h.pending({
								centreHz: centre,
								expectMarker: true,
								markerTimeoutSamples: 10 * BLOCK,
								pllSettleSamples: PLL,
							})
							if (s.stale > 0) h.push(poison(s.stale), s.chunk)
							h.pushBytes(counterRun(2 * s.run, s.startByte), s.chunk)
							h.push(poison(PLL), s.chunk)
							expected.push({
								command,
								start: command + s.stale + s.run + PLL,
								marker: true,
								centre,
							})
						}
					}
					h.push(gaussianNoise(rng, 3 * BLOCK, SIGMA), 4096)

					const started = h.of("epoch-started")
					expect(started).toHaveLength(expected.length + 1)
					expected.forEach((x, i) => {
						const st = started[i + 1]!
						expect(st.settleMode).toBe(x.marker ? "marker" : "timer")
						expect(st.startSample).toBeGreaterThanOrEqual(x.start)
						expect(st.startSample).toBeLessThanOrEqual(
							x.start + (x.marker ? 1 : 0),
						)
					})
					const startOf = new Map(started.map(e => [e.epoch, e.startSample]))
					const commandAfter = new Map(
						started.map((e, i) => [e.epoch, expected[i]?.command ?? Infinity]),
					)
					const centreOf = new Map(
						started.map((e, i) => [
							e.epoch,
							i === 0 ? CENTRE : (expected[i - 1]?.centre ?? 0),
						]),
					)
					const poisonIndex = POISON_HZ / (FS / N) + N / 2 - 26 // decimation 1 at spectrumBins 512
					for (const { summary } of h.of("block-summary")) {
						const s0 = startOf.get(summary.epoch)
						expect(s0).toBeDefined()
						expect(summary.stream).toBe(1)
						expect((summary.endSample - (s0 ?? 0)) % BLOCK).toBe(0)
						expect(summary.endSample - BLOCK).toBeGreaterThanOrEqual(s0 ?? 0)
						expect(summary.endSample).toBeLessThanOrEqual(
							commandAfter.get(summary.epoch) ?? Infinity,
						)
						expect(summary.centreHz).toBe(centreOf.get(summary.epoch))
						expect(summary.bins[poisonIndex]! - summary.floorDbfs).toBeLessThan(
							15,
						)
					}
					for (const t of h.tracks()) {
						const c = centreOf.get(t.epoch) ?? 0
						expect(Math.abs(t.centreHz - (c + POISON_HZ))).toBeGreaterThan(3000)
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000) // 8–26 s on a loaded Mac once Task 7a's per-frame work is wired
})
