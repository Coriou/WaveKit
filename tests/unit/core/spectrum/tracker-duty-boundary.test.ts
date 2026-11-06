import { describe, expect, it } from "vitest"
import { isDataBurst } from "../../../../src/core/scanner/replay-plan.js"
import { segment } from "../../../../src/core/spectrum/emissions/segmenter.js"
import { Tracker } from "../../../../src/core/spectrum/emissions/tracker.js"
import { binPowerDb } from "../../../../src/core/spectrum/fft.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"

/**
 * The linear frame path against the Float32 dB round trip it replaced, on the one comparison a bin's
 * rounding can decide: `dutyFromEnvelope`'s `p95 <= 4 * p5`. Each level moved by at most 1.76e-6
 * relative, so the ratio moved by at most about 3.5e-6: exactly 4 can resolve either way, and any
 * ratio further from 4 than that resolves alike on both paths.
 */
const N = 256
const BIN_HZ = 1000
const FLOOR_DB = -60
const BLOCK_SAMPLES = 12_800
const FRAMES_PER_BLOCK = 50
const START_BIN = 140
const END_BIN = 149
/** Past `DQ_SHORT_BURST_BLOCKS`, so `isDataBurst` turns on the duty and not on the length. */
const BLOCKS = 25

/** The removed path's per-bin value: powerToDb's Float32 store, then 10 ** (dB / 10). */
const viaDb = (power: number): number =>
	10 ** (Math.fround(binPowerDb(power, 1)) / 10)

function block(t: Tracker, index: number, on: boolean) {
	const powerDb = new Float32Array(N).fill(FLOOR_DB)
	const floorDb = new Float32Array(N).fill(FLOOR_DB)
	if (on) powerDb.fill(-24, START_BIN, END_BIN)
	const mask = new Uint8Array(N)
	for (let i = 0; i < N; i++) mask[i] = powerDb[i]! > FLOOR_DB + 4 ? 1 : 0
	const segs = segment(mask, powerDb, floorDb, {
		gapBins: 2,
		usableStartBin: 26,
		usableEndBin: 231,
		exclusionEdges: [],
		rasterBinEdges: [],
		skirtDb: 30,
		inWindow: false,
	})
	return t.block(segs, {
		endSample: (index + 1) * BLOCK_SAMPLES,
		powerDb,
		floorDb,
		blockFloorDb: FLOOR_DB,
		thresholdDb: 4,
		gap: false,
		overload: false,
	})
}

/** A real track whose 1 ms envelope alternates the two per-bin powers; its closing snapshot. */
function closedTrack(low: number, high: number, map: (p: number) => number) {
	const t = new Tracker({
		sourceId: "s1",
		binHz: BIN_HZ,
		blockMs: 50,
		hangBlocks: 3,
		maxTracks: 4,
		maxTrackBlocks: 100,
		idPrefix: "t",
	})
	t.beginEpoch({
		stream: 1,
		epoch: 1,
		centreHz: 433_000_000,
		tuningTrust: "commanded",
	})
	const frame = new Float64Array(N)
	const levels = [map(low), map(high)]
	block(t, 0, true)
	for (let b = 1; b < BLOCKS; b++) {
		for (let f = 0; f < FRAMES_PER_BLOCK; f++) {
			const ms = b * FRAMES_PER_BLOCK + f
			frame.fill(levels[ms % 2]!, START_BIN, END_BIN)
			t.frame(frame, 1, ms * N)
		}
		block(t, b, true)
	}
	for (let b = BLOCKS; b < BLOCKS + 10; b++) {
		for (const event of block(t, b, false))
			if (event.kind === "track-close") return event.track
	}
	throw new Error("the track did not close")
}

const burst = (track: TrackSnapshot): boolean => isDataBurst(track, { ism: 1 })

const LOW = 0.01

describe("the duty rule at its 6 dB boundary, linear path against the dB path", () => {
	for (const [ratio, duty, isBurst] of [
		[4 * (1 - 1e-4), 1, false],
		[4 * (1 - 1e-5), 1, false],
		[4 * (1 + 1e-5), 0.5, true],
		[4 * (1 + 1e-4), 0.5, true],
	] as const) {
		it(`a power ratio of ${ratio} reads duty ${duty} on both`, () => {
			const linear = closedTrack(LOW, LOW * ratio, p => p)
			const db = closedTrack(LOW, LOW * ratio, viaDb)
			expect(linear.dutyCycle).toBe(duty)
			expect(db.dutyCycle).toBe(duty)
			expect(burst(linear)).toBe(isBurst)
			expect(burst(db)).toBe(isBurst)
		})
	}

	it("exactly 0.01 and 0.04 per bin is where the paths part", () => {
		const linear = closedTrack(0.01, 0.04, p => p)
		const db = closedTrack(0.01, 0.04, viaDb)
		expect(linear.dutyCycle).toBe(1)
		expect(db.dutyCycle).toBe(0.5)
		expect(burst(linear)).toBe(false)
		expect(burst(db)).toBe(true)
	})
})
