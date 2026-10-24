import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { segment } from "../../../../../src/core/spectrum/emissions/segmenter.js"
import { Tracker } from "../../../../../src/core/spectrum/emissions/tracker.js"
import type { PipelineEvent } from "../../../../../src/core/spectrum/types.js"

// WG15 DQ requirement 1.8: only blocks at snr >= k count toward the gate's minimum on-time.

const N = 256
const BLOCK = 12_800
const BLOCK_MS = 50
const K = 3
const MARGIN = 3
const MIN_MS = 300
const HYST = 1.5

function tracker(maxTrackBlocks: number): Tracker {
	const t = new Tracker({
		sourceId: "s1",
		binHz: 1000,
		blockMs: BLOCK_MS,
		hangBlocks: 3,
		maxTracks: 4,
		maxTrackBlocks,
		idPrefix: "t",
	})
	t.beginEpoch({
		stream: 1,
		epoch: 1,
		centreHz: 446_100_000,
		tuningTrust: "commanded",
	})
	t.setGatePlan(true)
	return t
}

function runBlock(t: Tracker, index: number): PipelineEvent[] {
	const powerDb = new Float32Array(N).fill(-60)
	const floorDb = new Float32Array(N).fill(-60)
	for (let i = 140; i < 149; i++) powerDb[i] = -20
	const on = new Uint8Array(N)
	for (let i = 0; i < N; i++) on[i] = (powerDb[i] ?? 0) > -56 ? 1 : 0
	const segs = segment(on, powerDb, floorDb, {
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

const meas = (channelSnrDb: number) => ({
	channelSnrDb,
	kDb: K,
	marginDb: MARGIN,
	minDurationMs: MIN_MS,
	valid: true,
})

/** Feeds one channel SNR per block; returns the block index of the first pass, or -1. */
function firstPass(snrs: readonly number[], maxTrackBlocks: number): number {
	const t = tracker(maxTrackBlocks)
	let id = ""
	for (let i = 0; i < snrs.length; i++) {
		const ev = runBlock(t, i)
		for (const e of ev) if (e.kind === "track-open") id = e.track.trackId
		t.publishGate(() => meas(snrs[i]!), ev, 0)
		if (t.snapshotOf(id)?.gate === "passed") return i
	}
	return -1
}

/** Reference: the run rules with the strong-block duration. */
function oraclePass(snrs: readonly number[]): number {
	let alive = false
	let offs = 0
	let strong = 0
	let best = Number.NEGATIVE_INFINITY
	const need = Math.ceil(MIN_MS / BLOCK_MS)
	for (let i = 0; i < snrs.length; i++) {
		const snr = snrs[i]!
		const on = snr >= K || (alive && snr >= K - HYST)
		if (on) {
			if (!alive) {
				alive = true
				offs = 0
				strong = 0
				best = Number.NEGATIVE_INFINITY
			}
			if (snr >= K) strong++
			if (snr > best) best = snr
		} else if (alive && offs === 0) {
			offs = 1
		} else {
			alive = false
			continue
		}
		if (strong >= need && best + 1e-6 >= K + MARGIN) return i
	}
	return -1
}

const alternating = (n: number): number[] =>
	Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 6.5 : 2.0))

describe("tracker strong-block duration (DQ 1.8)", () => {
	it("10 alternating 6.5 / 2.0 dB blocks hold 5 strong blocks (250 ms) and do not pass", () => {
		expect(firstPass(alternating(10), 100)).toBe(-1)
	})

	it("12 alternating blocks hold 6 strong blocks (300 ms, best 6.5 dB) and pass", () => {
		// Block 10 (0-based) is the sixth 6.5 dB block.
		expect(firstPass(alternating(12), 100)).toBe(10)
	})

	it("a run split by inheritRun after block 6 passes at the same block as an unsplit run", () => {
		expect(firstPass(alternating(12), 6)).toBe(10)
		expect(firstPass(alternating(10), 6)).toBe(-1)
	})

	// Feature: detection-quality, Property 4: Strong duration
	// Validates: Requirements 1.8
	it("passes only with ceil(minMs / blockMs) strong blocks, at the same block with or without a split", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.oneof(
						fc.constantFrom(-2, 1.4, 1.5, 2, 2.99, 3, 5.99, 6, 6.5, 12),
						fc.double({ min: -3, max: 12, noNaN: true }),
					),
					{ minLength: 1, maxLength: 24 },
				),
				fc.integer({ min: 2, max: 12 }),
				(snrs, split) => {
					const expected = oraclePass(snrs)
					expect(firstPass(snrs, 100)).toBe(expected)
					expect(firstPass(snrs, split)).toBe(expected)
				},
			),
			{ numRuns: 100 },
		)
	})
})
