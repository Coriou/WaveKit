import { describe, expect, it } from "vitest"
import { segment } from "../../../../../src/core/spectrum/emissions/segmenter.js"
import {
	MATCHED_SUPPORT_DB,
	Tracker,
} from "../../../../../src/core/spectrum/emissions/tracker.js"
import type { PipelineEvent } from "../../../../../src/core/spectrum/types.js"

// The matched window serves admission only for an emission at least 2 bins wide above the local
// floor: one hot bin with its neighbours on the floor never reads as a carrier.

const N = 256
const BLOCK = 12_800
const FLOOR = -60
const HOT = 128
/** The slot SNR the gate reports: under the run floor, so only a matched SNR could lift it. */
const SLOT_SNR = 4

function tracker(): Tracker {
	const t = new Tracker({
		sourceId: "s1",
		binHz: 1000,
		blockMs: 50,
		hangBlocks: 3,
		maxTracks: 4,
		maxTrackBlocks: 1000,
		idPrefix: "t",
		localBins: 8,
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

/** A 15 dB bin at HOT; `neighbourDb` over the floor in the bin above it (under detection). */
function runBlock(
	t: Tracker,
	index: number,
	neighbourDb: number,
	secondOn = false,
): PipelineEvent[] {
	const powerDb = new Float32Array(N).fill(FLOOR)
	const floorDb = new Float32Array(N).fill(FLOOR)
	powerDb[HOT] = FLOOR + 15
	powerDb[HOT + 1] = FLOOR + neighbourDb
	const on = new Uint8Array(N)
	on[HOT] = 1
	if (secondOn) on[HOT + 1] = 1
	const segs = segment(on, powerDb, floorDb, {
		gapBins: 0,
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
		blockFloorDb: FLOOR,
		thresholdDb: 4,
		gap: false,
		overload: false,
	})
}

/** The admission SNR after a few blocks (absent: it equals the slot SNR). */
function admissionSnr(neighbourDb: number, secondOn = false): number {
	const t = tracker()
	let id = ""
	for (let i = 0; i < 4; i++) {
		const ev = runBlock(t, i, neighbourDb, secondOn)
		for (const e of ev) if (e.kind === "track-open") id = e.track.trackId
		t.publishGate(
			() => ({
				channelSnrDb: SLOT_SNR,
				kDb: 6,
				marginDb: 3,
				minDurationMs: 300,
				valid: true,
			}),
			ev,
			0,
		)
	}
	expect(id).not.toBe("")
	const snap = t.snapshotOf(id)
	return snap?.peakChannelSnrDb ?? snap?.channelSnrDb ?? Number.NaN
}

const twoBinDb = (neighbourDb: number) =>
	10 * Math.log10((10 ** 1.5 + 10 ** (neighbourDb / 10)) / 2)

describe("matched-window support (an emission spans at least 2 bins)", () => {
	it("a lone 15 dB bin on the floor has no matched SNR: admission reads the slot SNR", () => {
		expect(admissionSnr(0)).toBe(SLOT_SNR)
	})

	it("a neighbour just under the support line does not lift a lone hot bin", () => {
		expect(admissionSnr(MATCHED_SUPPORT_DB - 0.01)).toBe(SLOT_SNR)
	})

	it("a neighbour at the support line makes a 2-bin emission measured on both bins", () => {
		const got = admissionSnr(MATCHED_SUPPORT_DB)
		expect(got).toBeCloseTo(twoBinDb(MATCHED_SUPPORT_DB), 3)
		expect(got).toBeLessThan(15)
	})

	it("a Hann-like tone (second bin 6 dB down) inside a 2-bin segment keeps its matched SNR", () => {
		expect(admissionSnr(9, true)).toBeCloseTo(twoBinDb(9), 3)
	})
})
