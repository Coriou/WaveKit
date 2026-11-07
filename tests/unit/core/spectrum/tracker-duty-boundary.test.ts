import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { isDataBurst } from "../../../../src/core/scanner/replay-plan.js"
import { segment } from "../../../../src/core/spectrum/emissions/segmenter.js"
import { Tracker } from "../../../../src/core/spectrum/emissions/tracker.js"
import { binPowerDb } from "../../../../src/core/spectrum/fft.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"

/**
 * The linear frame path against the Float32 dB round trip it replaced, on the one comparison a bin's
 * rounding can decide: `dutyFromEnvelope`'s `p95 <= 4 * p5`.
 *
 * The old path's error is half a Float32 ulp of the dB value, a fixed step in dB for each binade of
 * |dB|, and so a fixed relative step in power: it grows with |dB|, that is at lower power. |dB| stays
 * under 256 down to the −200 dB floor: half an ulp is at most 2^-17 dB = 7.63e-6 dB, 1.757e-6 relative
 * in power, 3.513e-6 relative in a ratio of two levels. Both paths then store each envelope value as
 * Float32, 2^-24 relative per level, 1.19e-7 in the ratio.
 *
 * So the tolerance is RELATIVE: a ratio r with |r / 4 − 1| > 3.64e-6 (|r − 4| > 1.456e-5) resolves
 * alike on both paths for any level from the floor up. Inside it, whether they agree depends on the
 * power: at −20 dB half an ulp is 8 times smaller, and at −150 dB it is that full step.
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
/** See the header: 3.513e-6 + 1.19e-7, rounded up. */
const RATIO_TOLERANCE = 3.64e-6

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

	it("4.000005 is inside the tolerance: the paths agree at 0.01 and part at 1e-15", () => {
		const ratio = 4.000005
		expect(Math.abs(ratio / 4 - 1)).toBeLessThan(RATIO_TOLERANCE)
		const near = closedTrack(0.01, 0.01 * ratio, p => p)
		const nearDb = closedTrack(0.01, 0.01 * ratio, viaDb)
		expect(near.dutyCycle).toBe(0.5)
		expect(nearDb.dutyCycle).toBe(0.5)
		const low = closedTrack(1e-15, 1e-15 * ratio, p => p)
		const lowDb = closedTrack(1e-15, 1e-15 * ratio, viaDb)
		expect(low.dutyCycle).toBe(0.5)
		expect(lowDb.dutyCycle).toBe(1)
		expect(burst(low)).toBe(true)
		expect(burst(lowDb)).toBe(false)
	})

	for (const low of [1e-20, 1e-18, 1e-15, 1e-12, 1e-9, 1e-6, 1e-3, 0.25]) {
		for (const sign of [-1, 1]) {
			const ratio = 4 * (1 + sign * RATIO_TOLERANCE)
			it(`just past the tolerance at ${low} per bin, ratio ${ratio}: the same duty on both`, () => {
				const linear = closedTrack(low, low * ratio, p => p)
				const db = closedTrack(low, low * ratio, viaDb)
				expect(linear.dutyCycle).toBe(sign < 0 ? 1 : 0.5)
				expect(db.dutyCycle).toBe(linear.dutyCycle)
				expect(burst(db)).toBe(burst(linear))
			})
		}
	}

	// Feature: frame-linear-power, Property 1: past the tolerance both paths resolve the duty rule alike
	// Validates: docs/PERFORMANCE.md, frame tracks in linear power
	it("past the tolerance the rule's verdict is the same at any level from the floor up", () => {
		/** The rule on the two stored Float32 envelope values of a 9-bin track. */
		const flat = (p95: number, p5: number) =>
			Math.fround(9 * p95) <= 4 * Math.fround(9 * p5)
		fc.assert(
			fc.property(
				fc.double({ min: -20, max: 0, noNaN: true }),
				fc.double({ min: 0, max: 1e-2, noNaN: true }),
				fc.constantFrom(-1, 1),
				(exponent, past, sign) => {
					const low = 10 ** exponent
					const ratio = 4 * (1 + sign * (RATIO_TOLERANCE + past))
					const high = low * ratio
					const linear = flat(high, low)
					expect(linear).toBe(sign < 0)
					expect(flat(viaDb(high), viaDb(low))).toBe(linear)
				},
			),
			{ numRuns: 2000 },
		)
	})
})
