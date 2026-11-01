import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Detector } from "../../../../src/core/spectrum/detector.js"
import {
	binPowerDb,
	dbThresholdBracket,
	POWER_FLOOR_DB,
	powerScale,
	powerToDb,
} from "../../../../src/core/spectrum/fft.js"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	tone,
} from "../../../mocks/scanner/signals.js"
import { FS, Harness, N } from "./pipeline-harness.js"

const f64 = new Float64Array(1)
const u64 = new BigInt64Array(f64.buffer)
/** Adjacent double towards +∞ (positive finite inputs only). */
function nextUp(x: number): number {
	f64[0] = x
	u64[0] = u64[0]! + 1n
	return f64[0]
}
function nextDown(x: number): number {
	f64[0] = x
	u64[0] = u64[0]! - 1n
	return f64[0]
}

const stored = (a: number, scale: number): number =>
	Math.fround(binPowerDb(a, scale))

/** The pipeline's short-path decision (pipeline.ts shortFrame): bracket first, dB inside it. */
function linearDetect(
	acc: Float64Array,
	floorDb: Float32Array,
	k: number,
	h: number,
	scale: number,
	state: Uint8Array,
): void {
	const n = acc.length
	const onLo = new Float64Array(n)
	const onHi = new Float64Array(n)
	const offLo = new Float64Array(n)
	const offHi = new Float64Array(n)
	for (let i = 0; i < n; i++) {
		const t = floorDb[i]! + k
		dbThresholdBracket(t, scale, onLo, onHi, i)
		dbThresholdBracket(t - h, scale, offLo, offHi, i)
	}
	for (let i = 0; i < n; i++) {
		const a = acc[i]!
		const was = state[i] === 1
		const inDb = (): boolean => {
			const p = stored(a, scale)
			const t = floorDb[i]! + k
			return was ? p >= t - h : p > t
		}
		state[i] =
			a > (was ? offHi[i]! : onHi[i]!) ||
			(!(a < (was ? offLo[i]! : onLo[i]!)) && inDb())
				? 1
				: 0
	}
}

/** The pre-change path: powerToDb, then Detector.detect (no masks). */
function dbDetector(n: number, k: number, h: number): Detector {
	const d = new Detector({
		fftSize: n,
		hysteresisDb: h,
		faTargetPerMhzMin: 1,
		pinnedK: k,
		rbwHz: 1000,
		integrationMs: 5,
	})
	d.setMasks({ dcGuardBins: -1, edgeBins: 0, extra: null })
	return d
}

/** Smallest double a with ok(stored(a)), by bisection (stored is non-decreasing). */
function boundary(
	t: number,
	scale: number,
	ok: (v: number) => boolean,
): number {
	let lo = 0
	let hi = (10 ** (t / 10) / scale) * 2
	while (nextUp(lo) < hi) {
		const mid = lo + (hi - lo) / 2
		if (mid <= lo || mid >= hi) break
		if (ok(stored(mid, scale))) hi = mid
		else lo = mid
	}
	return hi
}

describe("dbThresholdBracket", () => {
	it("acc above hi always stores a dB value above t, below lo always below", () => {
		// Feature: spectrum-linear-power, Property 1: bracket soundness
		// Validates: linear short path decides exactly like the dB path outside the bracket
		fc.assert(
			fc.property(
				fc.double({ min: -199.9, max: 60, noNaN: true }),
				fc.integer({ min: 1, max: 64 }),
				fc.constantFrom(256, 2048, 16_384),
				fc.double({ min: -12, max: 0, noNaN: true }),
				(t, frames, n, logRel) => {
					const scale = powerScale(n, frames)
					const lo = new Float64Array(1)
					const hi = new Float64Array(1)
					dbThresholdBracket(t, scale, lo, hi, 0)
					expect(lo[0]! > 0 && Number.isFinite(hi[0]!)).toBe(true)
					const rel = 10 ** logRel
					for (const a of [nextUp(hi[0]!), hi[0]! * (1 + rel)])
						expect(stored(a, scale)).toBeGreaterThan(t)
					for (const a of [nextDown(lo[0]!), lo[0]! * (1 - rel), 0, -1])
						expect(stored(a, scale)).toBeLessThan(t)
				},
			),
			{ numRuns: 500 },
		)
	})

	it("brackets nothing at or below the dB floor clamp, or for non-finite thresholds", () => {
		const lo = new Float64Array(1)
		const hi = new Float64Array(1)
		for (const t of [
			POWER_FLOOR_DB,
			POWER_FLOOR_DB - 1e-9,
			-1e6,
			Number.NaN,
			Infinity,
			-Infinity,
			2e6,
		]) {
			dbThresholdBracket(t, powerScale(N, 25), lo, hi, 0)
			expect([lo[0], hi[0]]).toEqual([-Infinity, Infinity])
		}
		// just above the clamp the bracket is live (δ = (|t| + 4)·2⁻²⁰ < 0.5)
		dbThresholdBracket(POWER_FLOOR_DB + 1e-9, powerScale(N, 25), lo, hi, 0)
		expect(lo[0]).toBeGreaterThan(0)
	})

	it("the bracket is at most 2·(|t| + 4)·2⁻²⁰ relative wide", () => {
		const lo = new Float64Array(1)
		const hi = new Float64Array(1)
		for (const t of [-199, -100, -60, 0, 30]) {
			dbThresholdBracket(t, powerScale(2048, 30), lo, hi, 0)
			const b = 10 ** (t / 10) / powerScale(2048, 30)
			expect((hi[0]! - lo[0]!) / b).toBeLessThanOrEqual(
				2 * (Math.abs(t) + 4) * 2 ** -20 * (1 + 1e-12),
			)
		}
	})
})

describe("linear short detection equals powerToDb + Detector.detect", () => {
	it("random frame sequences with hysteresis, edge values and non-finite sums", () => {
		// Feature: spectrum-linear-power, Property 2: short-path decision equivalence
		// Validates: identical on/off per bin and frame to the pre-change dB path
		const n = 16
		const special = fc.constantFrom(
			0,
			-1e-30,
			Number.NaN,
			Infinity,
			-Infinity,
			Number.MIN_VALUE,
			Number.MAX_VALUE,
		)
		fc.assert(
			fc.property(
				fc.array(fc.float({ min: -150, max: -20, noNaN: true }), {
					minLength: n,
					maxLength: n,
				}),
				fc.double({ min: 0, max: 15, noNaN: true }),
				fc.double({ min: 0, max: 6, noNaN: true }),
				fc.integer({ min: 1, max: 30 }),
				fc.array(
					fc.array(
						fc.oneof(
							{
								weight: 6,
								arbitrary: fc.double({ min: -20, max: 20, noNaN: true }),
							},
							{ weight: 1, arbitrary: special },
						),
						{ minLength: n, maxLength: n },
					),
					{ minLength: 1, maxLength: 12 },
				),
				(floorArr, k, h, frames, rows) => {
					const kf = Math.fround(k)
					const floorDb = Float32Array.from(floorArr)
					const scale = powerScale(n, frames)
					const ref = dbDetector(n, kf, h)
					const refOut = new Uint8Array(n)
					const db = new Float32Array(n)
					const state = new Uint8Array(n)
					for (const row of rows) {
						// row entries are dB offsets from the on-threshold, or special raw sums
						const acc = new Float64Array(n)
						for (let i = 0; i < n; i++) {
							const v = row[i]!
							const special =
								!Number.isFinite(v) ||
								v === 0 ||
								Math.abs(v) < 1e-300 ||
								Math.abs(v) > 1e300
							acc[i] = special ? v : 10 ** ((floorDb[i]! + kf + v) / 10) / scale
						}
						powerToDb(acc, frames, db)
						ref.detect(db, floorDb, refOut)
						linearDetect(acc, floorDb, kf, h, scale, state)
						expect(Array.from(state)).toEqual(Array.from(refOut))
					}
				},
			),
			{ numRuns: 300 },
		)
	})

	it("decides identically at the exact boundary and one ulp either side", () => {
		const frames = 25
		const n = 16 // powerToDb scales by the array length; cases are padded to it
		const scale = powerScale(n, frames)
		const k = 8.5
		const h = 3
		// floor + k and floor + k − h are exact Float32 values, so a stored dB can equal them exactly
		for (const floor of [-100.25, -140.5, -60, -195.5]) {
			const tOn = floor + k
			const tOff = tOn - h
			const cases: number[] = []
			for (const t of [tOn, tOff]) {
				// first sums with stored > t (the `>` edge) and stored >= t (the `>=` edge, storing t exactly)
				const above = boundary(t, scale, v => v > t)
				const atLeast = boundary(t, scale, v => v >= t)
				cases.push(nextDown(above), above, nextUp(above))
				cases.push(nextDown(atLeast), atLeast, nextUp(atLeast))
			}
			expect(cases.some(a => stored(a, scale) === tOn)).toBe(true)
			expect(cases.some(a => stored(a, scale) === tOff)).toBe(true)
			expect(cases.length).toBeLessThanOrEqual(n)
			for (const was of [0, 1]) {
				const floorDb = new Float32Array(n).fill(floor)
				const acc = new Float64Array(n)
				acc.set(cases)
				const ref = dbDetector(n, k, h)
				const refOut = new Uint8Array(n)
				const db = new Float32Array(n)
				const state = new Uint8Array(n).fill(was)
				if (was === 1) {
					// put the reference in the on state first
					const hot = new Float64Array(n).fill(1e30)
					powerToDb(hot, frames, db)
					ref.detect(db, floorDb, refOut)
				}
				powerToDb(acc, frames, db)
				ref.detect(db, floorDb, refOut)
				linearDetect(acc, floorDb, k, h, scale, state)
				expect(Array.from(state)).toEqual(Array.from(refOut))
				// the cases straddle both thresholds: some on, some off
				expect(new Set(refOut.subarray(0, cases.length)).size).toBe(2)
			}
		}
	})

	it("block peak in linear power then dB equals the peak of per-frame dB values", () => {
		// Feature: spectrum-linear-power, Property 3: burst peak equivalence
		// Validates: burstPeakDone identical (max commutes with the non-decreasing dB map)
		fc.assert(
			fc.property(
				fc.array(
					fc.oneof(
						fc.double({ min: 0, max: 1e6, noNaN: true }),
						fc.constantFrom(0, -1e-12, Number.NaN, Infinity),
					),
					{ minLength: 1, maxLength: 40 },
				),
				fc.integer({ min: 1, max: 30 }),
				(sums, frames) => {
					const scale = powerScale(N, frames)
					let peakDb = -200 // NO_FLOOR_DBFS
					let peakAcc = 0
					for (const a of sums) {
						const p = stored(a, scale)
						if (p > peakDb) peakDb = p
						if (a > peakAcc) peakAcc = a
					}
					expect(stored(peakAcc, scale)).toBe(peakDb)
				},
			),
			{ numRuns: 300 },
		)
	})
})

describe("operation-count guards (no wall clock)", () => {
	afterEach(() => vi.restoreAllMocks())

	/** Math.log10 calls per block over a run; Detector, floor and tracker calls all count. */
	function log10PerBlock(withTone: boolean): { perBlock: number } {
		const iq = gaussianNoise(mulberry32(9), Math.round(0.8 * FS), 0.005)
		if (withTone) addInto(iq, tone(iq.re.length, FS, 40_000, 0.01))
		const h = new Harness({ format: "FLOAT32LE" })
		h.start({ feed: true })
		const spy = vi.spyOn(Math, "log10")
		h.push(iq, 8192)
		const calls = spy.mock.calls.length
		spy.mockRestore()
		const blocks = h.of("block-summary").length
		expect(blocks).toBeGreaterThan(10)
		return { perBlock: calls / blocks }
	}

	it("no per-frame full-spectrum dB pass without open tracks (≤ 4·N logs per block, was ≥ 50·N)", () => {
		// 50 frames of N = 256 per 50 ms block: the old short path alone took 50·N = 12 800 logs per
		// block. Allowed now: the block powerToDb (N), the burst peak (≤ N), floor and segment work.
		const { perBlock } = log10PerBlock(false)
		expect(perBlock).toBeLessThanOrEqual(4 * N)
	})

	it("with an open track only the tracker's frame dB pass stays per frame (≤ 54·N per block)", () => {
		// frameDb for Tracker.frame: 50·N per block; the old short path doubled it to ≥ 100·N
		const { perBlock } = log10PerBlock(true)
		expect(perBlock).toBeGreaterThan(40 * N)
		expect(perBlock).toBeLessThanOrEqual(54 * N)
	})
})
