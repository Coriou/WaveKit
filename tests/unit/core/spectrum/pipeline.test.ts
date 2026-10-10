import { describe, expect, it } from "vitest"
import { SpectrumPipeline } from "../../../../src/core/spectrum/pipeline.js"
import type { WaveKitError } from "../../../../src/utils/errors.js"
import {
	addInto,
	counterRun,
	fsk4Burst,
	gaussianNoise,
	mulberry32,
	tone,
} from "../../../mocks/scanner/signals.js"
import {
	BLOCK,
	CENTRE,
	FS,
	Harness,
	pipelineConfig,
} from "./pipeline-harness.js"

const SIGMA = 0.05
const rng = mulberry32(20261009)
const noise = (n: number) => gaussianNoise(rng, n, SIGMA)
const withTone = (n: number, offsetHz: number, amp = 0.3) =>
	addInto(gaussianNoise(rng, n, SIGMA), tone(n, FS, offsetHz, amp))

function blockEnds(h: Harness, epoch: number): number[] {
	return h
		.of("block-summary")
		.filter(e => e.summary.epoch === epoch)
		.map(e => e.summary.endSample)
}

describe("SpectrumPipeline", () => {
	it("starts a new stream at sample 0 and aligns blocks to it", () => {
		// FLOAT32LE has no counter lookahead; with U8_IQ, Task 4 holds back the frame that ends inside the
		// trailing incrementing streak until the next push or seam, so the 10th block would not finish yet
		const h = new Harness({ format: "FLOAT32LE" })
		h.start()
		h.push(noise(10 * BLOCK))
		expect(h.of("epoch-started")).toEqual([
			{ kind: "epoch-started", epoch: 1, startSample: 0, settleMode: "none" },
		])
		expect(blockEnds(h, 1)).toEqual(
			Array.from({ length: 10 }, (_, i) => (i + 1) * BLOCK),
		)
	})

	it("tracks a tone, reports it in the block summary, and closes it quiet after the hang", () => {
		const h = new Harness()
		h.start()
		h.push(noise(2 * BLOCK))
		h.push(withTone(10 * BLOCK, 20_000))
		h.push(noise(20 * BLOCK))
		const open = h.of("track-open")
		expect(open).toHaveLength(1)
		expect(
			Math.abs(open[0]!.track.centreHz - (CENTRE + 20_000)),
		).toBeLessThanOrEqual(1000)
		const close = h.of("track-close")
		expect(close.map(c => c.endReason)).toEqual(["quiet"])
		expect(close[0]!.track.spectralShape).toBe("narrow")
		expect(close[0]!.track.blocks).toBeGreaterThanOrEqual(10)
		const withTrack = h
			.of("block-summary")
			.filter(e =>
				e.summary.tracks.some(
					r => r.startHz <= CENTRE + 20_000 && r.endHz >= CENTRE + 20_000,
				),
			)
		expect(withTrack.length).toBeGreaterThanOrEqual(10)
	})

	it("starts a timer epoch at commandSample + buffered + settle and never lets a block straddle it", () => {
		const h = new Harness()
		h.start()
		h.push(noise(5 * BLOCK + 300))
		const command = h.sample
		h.pending({
			centreHz: CENTRE + 1e6,
			bufferedSamples: 1000,
			settleSamples: 25_600,
		})
		h.push(withTone(26_600, 30_000))
		h.push(noise(6 * BLOCK))
		const started = h.of("epoch-started")[1]!
		expect(started).toEqual({
			kind: "epoch-started",
			epoch: 2,
			startSample: command + 26_600,
			settleMode: "timer",
		})
		expect(blockEnds(h, 1).every(e => e <= command)).toBe(true)
		const ends = blockEnds(h, 2)
		expect(ends.length).toBeGreaterThanOrEqual(5)
		for (const e of ends) {
			expect((e - started.startSample) % BLOCK).toBe(0)
			expect(e - BLOCK).toBeGreaterThanOrEqual(started.startSample)
		}
		expect(h.tracks().filter(t => t.epoch === 2)).toEqual([])
	})

	it("starts a marker epoch after the counter run plus PLL settle, discarding old-frequency samples", () => {
		const h = new Harness()
		h.start()
		h.push(noise(4 * BLOCK))
		const command = h.sample
		h.pending({
			centreHz: CENTRE + 1e6,
			expectMarker: true,
			pllSettleSamples: 1280,
		})
		h.push(withTone(3000, 30_000)) // still queued at the old frequency
		h.pushBytes(counterRun(1024, 17)) // 512 samples of test-mode counter
		h.push(withTone(1280, 30_000)) // PLL settling
		h.push(noise(6 * BLOCK))
		const started = h.of("epoch-started")[1]!
		expect(started.settleMode).toBe("marker")
		expect(started.startSample).toBeGreaterThanOrEqual(
			command + 3000 + 512 + 1280,
		)
		expect(started.startSample).toBeLessThanOrEqual(
			command + 3000 + 512 + 1280 + 1,
		)
		expect(started.markerRunSamples).toBeGreaterThanOrEqual(512)
		expect(started.markerRunSamples).toBeLessThanOrEqual(514)
		expect(h.tracks().filter(t => t.epoch === 2)).toEqual([])
		expect(blockEnds(h, 2).length).toBeGreaterThanOrEqual(5)
	})

	it("falls back to timer mode when no marker arrives before the timeout", () => {
		const h = new Harness()
		h.start()
		h.push(noise(BLOCK))
		const command = h.sample
		h.pending({
			centreHz: CENTRE + 1e6,
			expectMarker: true,
			markerTimeoutSamples: 4 * BLOCK,
			bufferedSamples: 100,
			settleSamples: 1000,
		})
		h.push(noise(10 * BLOCK))
		const started = h.of("epoch-started")[1]!
		expect(started.settleMode).toBe("timer")
		expect(started.startSample).toBeGreaterThanOrEqual(command + 4 * BLOCK)
		expect(started.startSample).toBeLessThanOrEqual(command + 4 * BLOCK + 256)
		expect(blockEnds(h, 2).length).toBeGreaterThanOrEqual(5)
	})

	it("treats a counter run without a pending marker as a gap and raises stuckTestMode past 500 ms", () => {
		const h = new Harness()
		h.start()
		h.push(noise(BLOCK))
		const runSamples = Math.round(0.6 * FS)
		h.pushBytes(counterRun(2 * runSamples, 0))
		h.push(noise(Math.round(4.5 * FS)))
		expect(h.of("epoch-started")).toHaveLength(1)
		const stats = h.of("stats")
		expect(stats).toHaveLength(1)
		expect(stats[0]!.stats.stuckTestMode).toBe(true)
		expect(stats[0]!.stats.gapSamples).toBeGreaterThanOrEqual(runSamples)
		expect(stats[0]!.stats.gapSamples).toBeLessThanOrEqual(runSamples + 2)
	})

	it("discards stale blocks after a centre change and accepts the first clean one", () => {
		const h = new Harness()
		h.start()
		h.push(withTone(10 * BLOCK, 20_000))
		h.pending({ centreHz: CENTRE + 1e6 }) // timer, zero allowance: old samples follow
		h.push(withTone(3 * BLOCK, 20_000))
		h.push(noise(6 * BLOCK))
		const discards = h.of("stale-discard")
		expect(discards).toHaveLength(3)
		expect(discards.every(d => d.epoch === 2 && d.blocks === 1)).toBe(true)
		expect(h.tracks().filter(t => t.epoch === 2)).toEqual([])
		expect(blockEnds(h, 2).length).toBeGreaterThanOrEqual(5)
	})

	it("stops re-testing after 1 s, so a real emitter at the same offset is still found", () => {
		const h = new Harness()
		h.start()
		h.push(withTone(10 * BLOCK, 20_000))
		h.pending({ centreHz: CENTRE + 1e6 })
		h.push(withTone(30 * BLOCK, 20_000))
		expect(h.of("stale-discard")).toHaveLength(20)
		const found = h.of("track-open").filter(e => e.track.epoch === 2)
		expect(found).toHaveLength(1)
		expect(
			Math.abs(found[0]!.track.centreHz - (CENTRE + 1e6 + 20_000)),
		).toBeLessThanOrEqual(1000)
	})

	it("skips the stale check when the centre did not change", () => {
		const h = new Harness()
		h.start()
		h.push(withTone(10 * BLOCK, 20_000))
		h.pending({ centreHz: CENTRE, centreChanged: false, gainKey: "m:400" })
		h.push(withTone(6 * BLOCK, 20_000))
		expect(h.of("stale-discard")).toEqual([])
		expect(h.of("track-close").map(c => c.endReason)).toEqual(["retune"])
		expect(h.of("track-open").filter(e => e.track.epoch === 2)).toHaveLength(1)
	})

	it("never has more than maxTracks tracks open and reports the excess as transients", () => {
		const h = new Harness({ maxTracks: 3 })
		h.start()
		const n = 6 * BLOCK
		const iq = gaussianNoise(rng, n, SIGMA)
		for (const off of [-60_000, -30_000, 30_000, 60_000])
			addInto(iq, tone(n, FS, off, 0.2))
		h.push(iq)
		let open = 0
		let maxOpen = 0
		for (const e of h.events) {
			if (e.kind === "track-open") open++
			if (e.kind === "track-close") open--
			maxOpen = Math.max(maxOpen, open)
		}
		expect(maxOpen).toBeLessThanOrEqual(3)
		expect(h.of("transient").length).toBeGreaterThanOrEqual(1)
	})

	it("splits long tracks at maxTrackMs", () => {
		const h = new Harness({ maxTrackMs: 500 })
		h.start()
		h.push(withTone(30 * BLOCK, 20_000))
		const closes = h
			.of("track-close")
			.filter(c => c.endReason === "max-duration")
		expect(closes.length).toBeGreaterThanOrEqual(2)
		for (const c of closes) expect(c.track.blocks).toBeLessThanOrEqual(10)
	})

	it("rejects a sample-rate change (the engine rebuilds the pipeline)", () => {
		const h = new Harness()
		h.start()
		let code = ""
		try {
			h.send({
				kind: "new-stream",
				stream: 2,
				centreHz: CENTRE,
				sampleRateHz: 2_048_000,
				gainKey: "agc",
				tuningTrust: "unverified",
			})
		} catch (err) {
			code = (err as WaveKitError).code
		}
		expect(code).toBe("SCANNER_PIPELINE_RATE")
	})

	it("closes tracks on a long gap and keeps block indices absolute across it", () => {
		const h = new Harness()
		h.start()
		h.push(withTone(6 * BLOCK, 20_000))
		h.gap(20 * BLOCK + 77)
		h.push(noise(6 * BLOCK))
		expect(h.of("track-close").map(c => c.endReason)).toEqual(["gap"])
		for (const e of blockEnds(h, 1)) expect(e % BLOCK).toBe(0)
		expect(blockEnds(h, 1).some(e => e > 26 * BLOCK)).toBe(true)
	})

	it("decimates the spectrum feed by max-hold to at most spectrumBins and sends nothing when it is off", () => {
		const h = new Harness({ spectrumBins: 64 })
		h.start()
		h.push(withTone(3 * BLOCK, 20_000))
		const s = h.of("block-summary")[0]!.summary
		expect(s.bins).toHaveLength(52) // 205 usable bins in groups of 4
		expect(s.binHz).toBe(4000)
		expect(s.startHz).toBe(CENTRE + (26 - 128 - 0.5) * 1000)
		const toneBin = Math.floor((CENTRE + 20_000 - s.startHz) / s.binHz)
		expect(s.bins[toneBin]).toBe(Math.max(...s.bins))
		for (const b of s.bins) expect(b * 2).toBe(Math.round(b * 2))
		const quiet = new Harness()
		quiet.start({ feed: false })
		quiet.push(noise(3 * BLOCK))
		expect(quiet.of("block-summary")).toEqual([])
	})

	it("emits stats every 5 s of samples", () => {
		const h = new Harness()
		h.start({ feed: false })
		h.push(noise(11 * FS), 16_384)
		const stats = h.of("stats").map(e => e.stats)
		expect(stats).toHaveLength(2)
		expect(stats[0]!.observedSamples).toBeGreaterThanOrEqual(5 * FS)
		expect(stats[1]!.observedSamples).toBeGreaterThanOrEqual(10 * FS)
		for (const s of stats) {
			expect(s.settledSamples).toBeLessThanOrEqual(s.observedSamples)
			expect(s.sourceId).toBe("s1")
			expect(s.kByRange.length).toBeGreaterThan(0)
		}
	})

	it("round-trips its engine state", () => {
		const h = new Harness()
		h.start({ feed: false })
		h.push(noise(40 * BLOCK))
		const state = h.pipeline.exportEngineState()
		expect(state.version).toBe(1)
		const again = new SpectrumPipeline(
			pipelineConfig({ persistedEngine: state }),
			{ now: () => 0 },
		)
		expect(again.exportEngineState()).toEqual(state)
	})

	it("flags obwBiased when an emission edge reaches the DC guard", () => {
		const h = new Harness()
		h.start()
		const n = 8 * BLOCK
		const iq = gaussianNoise(rng, n, SIGMA)
		addInto(iq, fsk4Burst(rng, n, FS, 3000, 0.3))
		addInto(iq, fsk4Burst(rng, n, FS, 40_000, 0.3))
		h.push(iq)
		const near = h
			.tracks()
			.filter(t => Math.abs(t.centreHz - (CENTRE + 3000)) < 3000)
		const far = h
			.tracks()
			.filter(t => Math.abs(t.centreHz - (CENTRE + 40_000)) < 3000)
		expect(near.length).toBeGreaterThan(0)
		expect(near.every(t => t.flags.obwBiased)).toBe(true)
		expect(far.length).toBeGreaterThan(0)
		expect(far.every(t => !t.flags.obwBiased)).toBe(true)
	})
})
