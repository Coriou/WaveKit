import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import {
	chiSquareQuantileRatioDb,
	NoiseFloor,
} from "../../../../src/core/spectrum/noise-floor.js"
import { mulberry32, type Rng } from "../../../mocks/scanner/signals.js"

const N = 2048

/** Exact χ² CDF for even dof: 1 − e^{−x/2}·Σ_{j<dof/2} (x/2)^j / j!. */
function chiSquareCdfEven(x: number, dof: number): number {
	const h = x / 2
	let term = 1
	let sum = 1
	for (let j = 1; 2 * j < dof; j++) {
		term *= h / j
		sum += term
	}
	return 1 - Math.exp(-h) * sum
}

function exactRatioDb(dof: number, q: number): number {
	let lo = 0
	let hi = 10 * dof + 100
	for (let i = 0; i < 200; i++) {
		const mid = (lo + hi) / 2
		if (chiSquareCdfEven(mid, dof) < q) lo = mid
		else hi = mid
	}
	return 10 * Math.log10(lo / dof)
}

/** One block of per-bin power (dB): mean of L exponential frames around noiseDb. */
function noiseBlock(
	rng: Rng,
	L: number,
	noiseDb: number,
	ripple?: (i: number) => number,
): Float32Array {
	const out = new Float32Array(N)
	for (let i = 0; i < N; i++) {
		let s = 0
		for (let f = 0; f < L; f++) s -= Math.log(1 - rng())
		out[i] = noiseDb + (ripple?.(i) ?? 0) + 10 * Math.log10(s / L)
	}
	return out
}

/** Usable span of a 2048-pt window at u = 0.8, DC ±2 bins masked. */
function usable(): Uint8Array {
	const m = new Uint8Array(N)
	for (let i = 205; i <= N - 205; i++) if (Math.abs(i - N / 2) > 2) m[i] = 1
	return m
}

describe("chiSquareQuantileRatioDb", () => {
	it("is exact for 2 degrees of freedom", () => {
		expect(chiSquareQuantileRatioDb(2, 0.2)).toBeCloseTo(
			10 * Math.log10(-Math.log(0.8)),
			10,
		)
	})

	it("is within 0.05 dB of the exact even-dof quantile from 4 dof up, for q in [0.1, 0.95]", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 2, max: 200 }),
				fc.double({ min: 0.1, max: 0.95, noNaN: true }),
				(half, q) => {
					expect(
						Math.abs(
							chiSquareQuantileRatioDb(2 * half, q) - exactRatioDb(2 * half, q),
						),
					).toBeLessThan(0.05)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("shrinks toward 0 dB as averaging grows", () => {
		expect(chiSquareQuantileRatioDb(10, 0.2)).toBeLessThan(
			chiSquareQuantileRatioDb(100, 0.2),
		)
		expect(Math.abs(chiSquareQuantileRatioDb(100_000, 0.2))).toBeLessThan(0.05)
		expect(() => chiSquareQuantileRatioDb(0, 0.2)).toThrow()
		expect(() => chiSquareQuantileRatioDb(10, 1)).toThrow()
	})
})

describe("NoiseFloor.blockFloor", () => {
	it("estimates the mean noise power within 0.2 dB for any averaging depth", () => {
		for (const L of [1, 5, 50, 100]) {
			const floor = new NoiseFloor({
				fftSize: N,
				framesPerBlock: L,
				tauBlocks: 600,
			})
			const fb = floor.blockFloor(noiseBlock(mulberry32(L), L, -60), usable())
			expect([L, Math.abs(fb + 60) < 0.2]).toEqual([L, true])
		}
	})

	it("stays within 1 dB of the true floor when 70 % of the usable bins are occupied", () => {
		const rng = mulberry32(21)
		const block = noiseBlock(rng, 50, -60)
		const mask = usable()
		const bins: number[] = []
		for (let i = 0; i < N; i++) if (mask[i] === 1) bins.push(i)
		// Occupy 70 % of usable bins with emissions 6–60 dB above the floor, in contiguous chunks.
		const occupied = Math.round(0.7 * bins.length)
		for (let k = 0; k < occupied; k++) block[bins[k]!] = -60 + 6 + 54 * rng()
		const fb = new NoiseFloor({
			fftSize: N,
			framesPerBlock: 50,
			tauBlocks: 600,
		}).blockFloor(block, mask)
		expect(Math.abs(fb + 60)).toBeLessThan(1)
	})

	it("ignores masked bins", () => {
		const block = noiseBlock(mulberry32(22), 50, -60)
		const mask = usable()
		for (let i = 0; i < 205; i++) block[i] = 0
		block[N / 2] = 20
		expect(
			Math.abs(
				new NoiseFloor({
					fftSize: N,
					framesPerBlock: 50,
					tauBlocks: 600,
				}).blockFloor(block, mask) + 60,
			),
		).toBeLessThan(0.2)
		expect(() =>
			new NoiseFloor({
				fftSize: N,
				framesPerBlock: 50,
				tauBlocks: 600,
			}).blockFloor(block, new Uint8Array(N)),
		).toThrow()
	})
})

describe("NoiseFloor absolute floor and occupancy", () => {
	const key = "2048000:m:496:2048"

	it("learns only from quiet blocks, falls at once and rises slowly", () => {
		const floor = new NoiseFloor({
			fftSize: N,
			framesPerBlock: 50,
			tauBlocks: 20,
		})
		const rng = mulberry32(31)
		const mask = usable()
		expect(floor.absoluteFloor(key)).toBeNull()
		floor.update(noiseBlock(rng, 50, -50), mask, false, key)
		expect(floor.absoluteFloor(key)).toBeNull()
		floor.update(noiseBlock(rng, 50, -60), mask, true, key)
		expect(Math.abs(floor.absoluteFloor(key)! + 60)).toBeLessThan(0.2)
		floor.update(noiseBlock(rng, 50, -40), mask, true, key)
		const afterOne = floor.absoluteFloor(key)!
		expect(afterOne).toBeGreaterThan(-60)
		expect(afterOne).toBeLessThan(-58) // one step of a 20-block time constant toward −40
		floor.update(noiseBlock(rng, 50, -70), mask, true, key)
		expect(Math.abs(floor.absoluteFloor(key)! + 70)).toBeLessThan(0.2)
		expect(floor.absoluteFloor("2400000:agc:2048")).toBeNull()
	})

	it("raises the effective floor to A − 1 dB and flags F_b > A + k as occupied", () => {
		const floor = new NoiseFloor({
			fftSize: N,
			framesPerBlock: 50,
			tauBlocks: 20,
		})
		floor.importState({ absoluteFloors: [{ key, dbfs: -60 }] })
		expect(floor.effectiveFloor(-75, key)).toBe(-61)
		expect(floor.effectiveFloor(-55, key)).toBe(-55)
		expect(floor.effectiveFloor(-75, "other")).toBe(-75)
		expect(floor.occupied(-56.1, 4, key)).toBe(false)
		expect(floor.occupied(-55.9, 4, key)).toBe(true)
		expect(floor.occupied(-10, 4, "other")).toBe(false)
	})

	it("round-trips absolute floors through the engine state", () => {
		const a = new NoiseFloor({ fftSize: N, framesPerBlock: 50, tauBlocks: 20 })
		a.update(noiseBlock(mulberry32(32), 50, -63), usable(), true, key)
		const b = new NoiseFloor({ fftSize: N, framesPerBlock: 50, tauBlocks: 20 })
		b.importState(a.exportState())
		expect(b.absoluteFloor(key)).toBe(a.absoluteFloor(key))
		b.importState({ absoluteFloors: [{ key: "bad", dbfs: Number.NaN }] })
		expect(b.absoluteFloor("bad")).toBeNull()
	})
})

describe("NoiseFloor per-bin baseline", () => {
	const key = "2048000:m:496:2048"
	const ripple = (i: number): number => (i >= 300 && i < 400 ? 3 : 0)

	it("is the block floor until the key has learned", () => {
		const floor = new NoiseFloor({
			fftSize: N,
			framesPerBlock: 50,
			tauBlocks: 20,
		})
		floor.useKey(key)
		const out = new Float32Array(N)
		floor.perBinFloor(out, -60)
		expect(out.every(v => v === -60)).toBe(true)
	})

	it("absorbs passband ripple, never goes below F, and is per key", () => {
		const floor = new NoiseFloor({
			fftSize: N,
			framesPerBlock: 50,
			tauBlocks: 20,
		})
		const rng = mulberry32(41)
		const mask = usable()
		for (let b = 0; b < 100; b++)
			floor.update(noiseBlock(rng, 50, -60, ripple), mask, true, key)
		const block = noiseBlock(rng, 50, -60, ripple)
		const fb = floor.effectiveFloor(floor.blockFloor(block, mask), key)
		const out = new Float32Array(N)
		floor.perBinFloor(out, fb)
		let rippleMean = 0
		for (let i = 300; i < 400; i++) rippleMean += out[i]! / 100
		expect(rippleMean - fb).toBeGreaterThan(2)
		expect(rippleMean - fb).toBeLessThan(3.5)
		for (let i = 500; i < 1500; i++) expect(out[i]! - fb).toBeLessThan(0.5)
		for (let i = 0; i < N; i++)
			expect(out[i]!).toBeGreaterThanOrEqual(Math.fround(fb))
		floor.useKey("2048000:m:300:2048")
		floor.perBinFloor(out, fb)
		expect(out.every(v => v === Math.fround(fb))).toBe(true)
	})

	it("clamps a bin that keeps learning a strong carrier to F + 6 dB", () => {
		const floor = new NoiseFloor({
			fftSize: N,
			framesPerBlock: 50,
			tauBlocks: 5,
		})
		const rng = mulberry32(42)
		const mask = usable()
		for (let b = 0; b < 200; b++) {
			const block = noiseBlock(rng, 50, -60)
			block[700] = -20
			floor.update(block, mask, false, key)
		}
		const out = new Float32Array(N)
		floor.perBinFloor(out, -60)
		expect(out[700]).toBeCloseTo(-54, 0)
		expect(out[700]).toBeLessThanOrEqual(-60 + 6 + 0.5)
	})

	it("does not learn from bins outside the learn mask (emissions)", () => {
		const floor = new NoiseFloor({
			fftSize: N,
			framesPerBlock: 50,
			tauBlocks: 5,
		})
		const rng = mulberry32(43)
		const learn = usable()
		learn[800] = 0
		for (let b = 0; b < 100; b++) {
			const block = noiseBlock(rng, 50, -60)
			block[800] = -50
			floor.update(block, learn, false, key)
		}
		const out = new Float32Array(N)
		floor.perBinFloor(out, -60)
		expect(out[800]).toBe(-60)
	})
})
