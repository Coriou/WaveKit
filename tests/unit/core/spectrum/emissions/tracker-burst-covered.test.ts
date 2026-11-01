import { describe, expect, it } from "vitest"
import { segment } from "../../../../../src/core/spectrum/emissions/segmenter.js"
import { Tracker } from "../../../../../src/core/spectrum/emissions/tracker.js"
import type { PipelineEvent } from "../../../../../src/core/spectrum/types.js"

// Scanner quality benchmark, defect A: in ISM 433, which 70 cm and UHF land mobile overlap, a
// wide track's covering slots are not all burst, so its reading carried the standard rule (300 ms)
// and a 150 ms sensor burst at 25 dB never passed. `burstCovered` lets the burst rule (100 ms at
// k + 6 dB) pass it too, while the standard rule still passes a long weak carrier.

const N = 256
const BLOCK = 12_800

function tracker(): Tracker {
	const t = new Tracker({
		sourceId: "s1",
		binHz: 1000,
		blockMs: 50,
		hangBlocks: 3,
		maxTracks: 4,
		maxTrackBlocks: 1000,
		idPrefix: "t",
	})
	t.beginEpoch({
		stream: 1,
		epoch: 1,
		centreHz: 433_400_000,
		tuningTrust: "commanded",
	})
	t.setGatePlan(true)
	return t
}

function runBlock(t: Tracker, index: number, on: boolean): PipelineEvent[] {
	const powerDb = new Float32Array(N).fill(-60)
	const floorDb = new Float32Array(N).fill(-60)
	if (on) for (let i = 140; i < 149; i++) powerDb[i] = -20
	const bins = new Uint8Array(N)
	for (let i = 0; i < N; i++) bins[i] = (powerDb[i] ?? 0) > -56 ? 1 : 0
	const segs = segment(bins, powerDb, floorDb, {
		gapBins: 2,
		usableStartBin: 26,
		usableEndBin: 231,
		exclusionEdges: [],
		rasterBinEdges: [],
		skirtDb: 30,
		inWindow: false,
	})
	return t.block(segs, {
		endSample: (index + 1) * BLOCK,
		powerDb,
		floorDb,
		blockFloorDb: -60,
		thresholdDb: 4,
		gap: false,
		overload: false,
	})
}

/** The standard rule's reading (k 3, margin 3, 300 ms), with or without burst coverage. */
const reading = (channelSnrDb: number, burstCovered: boolean) => ({
	channelSnrDb,
	kDb: 3,
	marginDb: 3,
	minDurationMs: 300,
	valid: true,
	burstCovered,
})

/** Blocks on at `snr`, then quiet; true when the track passed. */
function passes(snr: number, onBlocks: number, burstCovered: boolean): boolean {
	const t = tracker()
	let id = ""
	let passed = false
	for (let i = 0; i < onBlocks + 4; i++) {
		const on = i < onBlocks
		const ev = runBlock(t, i, on)
		for (const e of ev) if (e.kind === "track-open") id = e.track.trackId
		t.publishGate(() => reading(snr, burstCovered), ev, 0)
		if (t.snapshotOf(id)?.gate === "passed") passed = true
	}
	return passed
}

describe("tracker gate with burst coverage", () => {
	it("a 150 ms burst at 25 dB passes when burst slots cover it, not without", () => {
		expect(passes(25, 3, true)).toBe(true)
		expect(passes(25, 3, false)).toBe(false)
	})

	it("the burst rule's bounds: 2 strong blocks (100 ms) and k + 6 dB", () => {
		expect(passes(9, 2, true)).toBe(true)
		expect(passes(8.9, 2, true)).toBe(false)
		expect(passes(25, 1, true)).toBe(false)
	})

	it("a long weak carrier still passes by the standard rule (6 blocks at k + 3 dB)", () => {
		expect(passes(6.5, 8, true)).toBe(true)
		expect(passes(6.5, 8, false)).toBe(true)
		expect(passes(6.5, 5, true)).toBe(false)
	})
})
