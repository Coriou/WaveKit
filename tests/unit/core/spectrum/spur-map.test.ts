import { describe, expect, it } from "vitest"
import { SpurMap } from "../../../../src/core/spectrum/spur-map.js"
import { mulberry32 } from "../../../mocks/scanner/signals.js"

const N = 2048
const FS = 2_048_000
const BIN_HZ = FS / N
const KEY = `${FS}:m:496:${N}`
const SPUR_BIN = N / 2 - 423 // −423 kHz baseband spur (run8)
const BLOCK_MS = 1000

function newMap(): SpurMap {
	return new SpurMap({
		fftSize: N,
		minObservedMs: 600_000,
		onFraction: 0.95,
		maxWidthBins: 3,
	})
}

/**
 * Feeds `minutes` of blocks for one epoch. `baseband` bins are on at fixed
 * baseband offsets; `rfHz` carriers are on at the window bin of their RF
 * frequency. `duty` < 1 switches every on-bin off for that fraction of blocks.
 */
function feed(
	map: SpurMap,
	epoch: number,
	centreHz: number,
	minutes: number,
	opts: {
		baseband?: number[]
		rfHz?: number[]
		duty?: number
		widthBins?: number
	},
): void {
	const rng = mulberry32(epoch)
	const blocks = Math.round((minutes * 60_000) / BLOCK_MS)
	for (let b = 0; b < blocks; b++) {
		const on = new Uint8Array(N)
		if (rng() < (opts.duty ?? 1)) {
			for (const bin of opts.baseband ?? [])
				for (let w = 0; w < (opts.widthBins ?? 1); w++) on[bin + w] = 1
			for (const hz of opts.rfHz ?? []) {
				const bin = Math.round((hz - centreHz) / BIN_HZ) + N / 2
				if (bin >= 0 && bin < N)
					for (let w = 0; w < (opts.widthBins ?? 1); w++) on[bin + w] = 1
			}
		}
		map.observe(KEY, { epoch, centreHz, binHz: BIN_HZ }, on, BLOCK_MS)
	}
}

function masked(map: SpurMap, key = KEY): number[] {
	const out = new Uint8Array(N)
	map.mask(key, out)
	const bins: number[] = []
	for (let i = 0; i < N; i++) if (out[i] === 1) bins.push(i)
	return bins
}

describe("SpurMap", () => {
	it("masks a spur that stays at one baseband offset across three centres", () => {
		const map = newMap()
		feed(map, 1, 446_000_000, 4, { baseband: [SPUR_BIN] })
		feed(map, 2, 447_600_000, 4, { baseband: [SPUR_BIN] })
		expect(masked(map)).toEqual([]) // two centres only
		feed(map, 3, 449_200_000, 4, { baseband: [SPUR_BIN] })
		expect(masked(map)).toEqual([SPUR_BIN])
		expect(map.rfCarriers()).toEqual([])
		expect(masked(map, `${FS}:agc:${N}`)).toEqual([])
	})

	it("needs ten minutes of observation", () => {
		const map = newMap()
		feed(map, 1, 446_000_000, 3, { baseband: [SPUR_BIN] })
		feed(map, 2, 447_600_000, 3, { baseband: [SPUR_BIN] })
		feed(map, 3, 449_200_000, 3.9, { baseband: [SPUR_BIN] })
		expect(masked(map)).toEqual([])
		feed(map, 4, 451_000_000, 0.2, { baseband: [SPUR_BIN] })
		expect(masked(map)).toEqual([SPUR_BIN])
	})

	it("needs the bin on for 95 % of the time", () => {
		const map = newMap()
		for (const [e, c] of [
			[1, 446e6],
			[2, 447.6e6],
			[3, 449.2e6],
		] as const)
			feed(map, e, c, 4, { baseband: [SPUR_BIN], duty: 0.85 })
		expect(masked(map)).toEqual([])
	})

	it("rejects runs wider than three bins but keeps a three-bin spur", () => {
		const wide = newMap()
		const narrow = newMap()
		for (const [e, c] of [
			[1, 446e6],
			[2, 447.6e6],
			[3, 449.2e6],
		] as const) {
			feed(wide, e, c, 4, { baseband: [SPUR_BIN], widthBins: 4 })
			feed(narrow, e, c, 4, { baseband: [SPUR_BIN], widthBins: 3 })
		}
		expect(masked(wide)).toEqual([])
		expect(masked(narrow)).toEqual([SPUR_BIN, SPUR_BIN + 1, SPUR_BIN + 2])
	})

	it("reports a carrier fixed in RF across centres as an RF carrier, never as a baseband spur", () => {
		const map = newMap()
		const rf = 447_000_000
		feed(map, 1, 446_400_000, 6, { rfHz: [rf] })
		feed(map, 2, 447_350_000, 6, { rfHz: [rf] })
		expect(masked(map)).toEqual([])
		const carriers = map.rfCarriers()
		expect(carriers).toHaveLength(1)
		expect(Math.abs(carriers[0]!.rfHz - rf)).toBeLessThanOrEqual(BIN_HZ)
		expect(carriers[0]!.widthBins).toBe(1)
	})

	it("does not call an RF carrier seen under a single centre anything", () => {
		const map = newMap()
		feed(map, 1, 446_400_000, 12, { rfHz: [447_000_000], baseband: [SPUR_BIN] })
		expect(map.rfCarriers()).toEqual([])
		expect(masked(map)).toEqual([])
	})

	it("keeps a classified spur after it is masked out of the on bits", () => {
		const map = newMap()
		for (const [e, c] of [
			[1, 446e6],
			[2, 447.6e6],
			[3, 449.2e6],
		] as const)
			feed(map, e, c, 4, { baseband: [SPUR_BIN] })
		expect(masked(map)).toEqual([SPUR_BIN])
		feed(map, 4, 451e6, 30, {})
		expect(masked(map)).toEqual([SPUR_BIN])
	})

	it("round-trips spurs and carriers through the engine state", () => {
		const map = newMap()
		for (const [e, c] of [
			[1, 446e6],
			[2, 447.6e6],
			[3, 449.2e6],
		] as const)
			feed(map, e, c, 4, { baseband: [SPUR_BIN] })
		feed(map, 4, 446_400_000, 6, { rfHz: [447_000_000] })
		feed(map, 5, 447_350_000, 6, { rfHz: [447_000_000] })
		const state = map.exportState()
		expect(state.spurs.filter(s => s.kind === "baseband")).toEqual([
			{ key: KEY, basebandBin: SPUR_BIN, widthBins: 1, kind: "baseband" },
		])
		const restored = newMap()
		restored.importState(state)
		expect(masked(restored)).toEqual([SPUR_BIN])
		expect(restored.rfCarriers()).toEqual(map.rfCarriers())
	})

	it("promotes comb lines to baseband spurs at once, sticky and persisted (Task 7a fast path)", () => {
		const map = newMap()
		map.promote(KEY, BIN_HZ, [
			{ startBin: 700, endBin: 703 },
			{ startBin: 1500, endBin: 1503 },
		])
		const bins = [700, 701, 702, 1500, 1501, 1502]
		expect(masked(map)).toEqual(bins)
		feed(map, 9, 446_000_000, 1, {}) // a quiet minute never un-learns them
		expect(masked(map)).toEqual(bins)
		const restored = newMap()
		restored.importState(map.exportState())
		expect(masked(restored)).toEqual(bins)
	})
})
