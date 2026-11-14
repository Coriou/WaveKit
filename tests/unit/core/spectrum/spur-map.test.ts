import { describe, expect, it } from "vitest"
import {
	SPUR_MAX_LEVEL_DB,
	SPUR_TTL_MS,
	SpurMap,
} from "../../../../src/core/spectrum/spur-map.js"
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

/** Size of the key's private RF table: the bound (P11) has no public surface. */
function rfEntries(map: SpurMap, key = KEY): number {
	const keys = (
		map as unknown as { keys: Map<string, { rf: Map<number, unknown> }> }
	).keys
	return keys.get(key)?.rf.size ?? 0
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

	it("reports the full width of a stable three-bin RF carrier", () => {
		const map = newMap()
		const rf = 447_000_000
		feed(map, 1, 446_400_000, 6, { rfHz: [rf], widthBins: 3 })
		feed(map, 2, 447_350_000, 6, { rfHz: [rf], widthBins: 3 })
		const carriers = map.rfCarriers()
		expect(carriers).toHaveLength(1)
		expect(carriers[0]!.widthBins).toBe(3)
		expect(Math.abs(carriers[0]!.rfHz - (rf + BIN_HZ))).toBeLessThanOrEqual(
			BIN_HZ,
		)
	})

	it("bounds the RF table and keeps the most-on entries when it overflows", () => {
		const map = newMap()
		const rf = 447_000_000
		feed(map, 1, 446_400_000, 6, { rfHz: [rf] })
		// Ten single-block epoch floods, each a full window of fresh, always-on
		// entries a whole span apart: none falls below onFraction, so only the
		// eviction step can hold the bound.
		const all = new Uint8Array(N).fill(1)
		for (let k = 0; k < 10; k++)
			map.observe(
				KEY,
				{ epoch: 100 + k, centreHz: 500_000_000 + k * FS, binHz: BIN_HZ },
				all,
				BLOCK_MS,
			)
		expect(rfEntries(map)).toBeLessThanOrEqual(16_384)
		expect(rfEntries(map)).toBeGreaterThan(16_384 - N)
		feed(map, 2, 447_350_000, 6, { rfHz: [rf] })
		const carriers = map.rfCarriers()
		expect(carriers).toHaveLength(1)
		expect(Math.abs(carriers[0]!.rfHz - rf)).toBeLessThanOrEqual(BIN_HZ)
	})

	it("does not call an RF carrier seen under a single centre anything", () => {
		const map = newMap()
		feed(map, 1, 446_400_000, 12, { rfHz: [447_000_000], baseband: [SPUR_BIN] })
		expect(map.rfCarriers()).toEqual([])
		expect(masked(map)).toEqual([])
	})

	it("keeps masking a confirmed spur its own mask hid from the detector, and lets it go once it is gone", () => {
		const map = newMap()
		for (const [e, c] of [
			[1, 446e6],
			[2, 447.6e6],
			[3, 449.2e6],
		] as const)
			feed(map, e, c, 4, { baseband: [SPUR_BIN] })
		expect(masked(map)).toEqual([SPUR_BIN])
		// masked: the detector no longer sees it, the line re-test still does, under every centre
		for (let e = 4; e < 10; e++)
			lineEpoch(map, e, 446e6 + e * 100_000, 5 * 60_000, {
				bins: [SPUR_BIN],
				masked: true,
			})
		expect(masked(map)).toEqual([SPUR_BIN])
		// gone: the first epoch that misses it un-confirms it
		lineEpoch(map, 10, 452e6, 60_000, {})
		lineEpoch(map, 11, 453e6, 1000, {})
		expect(masked(map)).toEqual([])
	})

	it("round-trips spurs and carriers through the engine state", () => {
		const map = newMap()
		for (const [e, c] of [
			[1, 446e6],
			[2, 447.6e6],
			[3, 449.2e6],
		] as const)
			feed(map, e, c, 4, { baseband: [SPUR_BIN] })
		feed(map, 4, 446_400_000, 6, { rfHz: [447_000_000], baseband: [SPUR_BIN] })
		feed(map, 5, 447_350_000, 6, { rfHz: [447_000_000], baseband: [SPUR_BIN] })
		const state = map.exportState()
		expect(state.spurs.filter(s => s.kind === "baseband")).toEqual([
			{
				key: KEY,
				basebandBin: SPUR_BIN,
				widthBins: 1,
				kind: "baseband",
				verified: true, // confirmed by credits in this map
			},
		])
		const restored = newMap()
		restored.importState(state)
		expect(masked(restored)).toEqual([]) // restored lines are unverified
		// and persisted again until they expire, unverified (only a line verified when saved is flagged)
		expect(restored.exportState()).toEqual(unflagged(state))
		expect(restored.rfCarriers()).toEqual(map.rfCarriers())
	})

	it("promotes comb lines to candidates that mask and persist only once two LO centres confirm them", () => {
		const map = newMap()
		map.promote(KEY, BIN_HZ, [
			{ startBin: 700, endBin: 703 },
			{ startBin: 1500, endBin: 1503 },
		])
		const bins = [700, 701, 702, 1500, 1501, 1502]
		expect(masked(map)).toEqual([])
		expect(map.exportState().spurs).toEqual([])
		lineEpoch(map, 1, 446e6, 2000, { bins: [701, 1501] })
		lineEpoch(map, 2, 446.5e6, 2000, { bins: [701, 1501] })
		expect(masked(map)).toEqual([]) // the second centre's epoch has not closed
		lineEpoch(map, 3, 447e6, 1000, { bins: [701, 1501] })
		expect(masked(map)).toEqual(bins)
		// Each bin saves its own verified state: the confirmed core with the flag, the ±1 skirt that
		// masks beside it without (no skirt saves verified through its neighbour).
		expect(
			map
				.exportState()
				.spurs.map(s => [s.basebandBin, s.widthBins, s.verified === true]),
		).toEqual([
			[700, 1, false],
			[701, 1, true],
			[702, 1, false],
			[1500, 1, false],
			[1501, 1, true],
			[1502, 1, false],
		])
	})
})

const FLOOR_DB = -60
const FLOOR = new Float32Array(N).fill(FLOOR_DB)
const ALL_BINS = new Uint8Array(N).fill(1)

/**
 * One epoch of `ms` in BLOCK_MS blocks. `bins` are line bins: on for the line learner, and on for
 * the detector unless `masked`. `perBinDb` measures every block with the bins that far over a flat
 * floor (a 1-bin line at x dB reads 10·log10((10^(x/10) + 12) / 13) over a 13-bin slot).
 */
function lineEpoch(
	map: SpurMap,
	epoch: number,
	centreHz: number,
	ms: number,
	opts: { bins?: number[]; masked?: boolean; perBinDb?: number },
): void {
	for (let t = 0; t < ms; t += BLOCK_MS) {
		if (opts.perBinDb !== undefined) {
			const powerDb = new Float32Array(N).fill(FLOOR_DB)
			for (const b of opts.bins ?? []) powerDb[b] = FLOOR_DB + opts.perBinDb
			map.measure(powerDb, FLOOR, BIN_HZ)
		}
		const line = new Uint8Array(N)
		for (const b of opts.bins ?? []) line[b] = 1
		const on = opts.masked === true ? new Uint8Array(N) : line
		map.observe(KEY, { epoch, centreHz, binHz: BIN_HZ }, on, BLOCK_MS, {
			on: line,
			observable: ALL_BINS,
		})
	}
}

const C = 446_000_000
/** 13 slot bins + 3 line bins + 2 skirt bins at 1 kHz. */
const SEPARATION_HZ = 18 * BIN_HZ

describe("SpurMap verification", () => {
	it("confirms a baseband spur from two centres at least 18 bins apart, not 17", () => {
		const near = newMap()
		const far = newMap()
		for (const [map, second] of [
			[near, C + SEPARATION_HZ - BIN_HZ],
			[far, C + SEPARATION_HZ],
		] as const) {
			map.promote(KEY, BIN_HZ, [{ startBin: SPUR_BIN, endBin: SPUR_BIN + 1 }])
			lineEpoch(map, 1, C, 2000, { bins: [SPUR_BIN] })
			lineEpoch(map, 2, second, 2000, { bins: [SPUR_BIN] })
			lineEpoch(map, 3, second, 1000, { bins: [SPUR_BIN] })
		}
		expect(masked(near)).toEqual([])
		expect(far.verified(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(true)
		expect(masked(far)).toEqual([SPUR_BIN])
	})

	it("never learns a line at the gate's pass level, and lifts a confirmed mask while a strong signal sits on it", () => {
		// 13 dB in one bin reads 10·log10((20 + 12) / 13) = 3.9 dB; 16 dB reads 10·log10((39.8 + 12) / 13) = 6.0 dB
		expect(SPUR_MAX_LEVEL_DB).toBe(6)
		const strong = newMap()
		for (const [e, c] of [
			[1, 446e6],
			[2, 447.6e6],
			[3, 449.2e6],
			[4, 450.8e6],
		] as const)
			lineEpoch(strong, e, c, 4 * 60_000, { bins: [SPUR_BIN], perBinDb: 16.1 })
		expect(strong.exportState().spurs).toEqual([]) // not even a slow-path candidate
		strong.promote(KEY, BIN_HZ, [{ startBin: SPUR_BIN, endBin: SPUR_BIN + 1 }])
		lineEpoch(strong, 5, 452e6, 1000, { bins: [SPUR_BIN], perBinDb: 16.1 })
		expect(masked(strong)).toEqual([])
		const weak = newMap()
		weak.promote(KEY, BIN_HZ, [{ startBin: SPUR_BIN, endBin: SPUR_BIN + 1 }])
		lineEpoch(weak, 1, C, 2000, { bins: [SPUR_BIN], perBinDb: 13 })
		lineEpoch(weak, 2, C + 1e6, 2000, { bins: [SPUR_BIN], perBinDb: 13 })
		lineEpoch(weak, 3, C + 2e6, 1000, { bins: [SPUR_BIN], perBinDb: 13 })
		expect(masked(weak)).toEqual([SPUR_BIN])
		lineEpoch(weak, 3, C + 2e6, 1000, { bins: [SPUR_BIN], perBinDb: 25 })
		expect(masked(weak)).toEqual([]) // a voice on top: suspended this block
		lineEpoch(weak, 3, C + 2e6, 1000, { bins: [SPUR_BIN], perBinDb: 13 })
		expect(masked(weak)).toEqual([SPUR_BIN])
	})

	it("needs the hits without a miss between them: two real emitters at one offset under far hops do not confirm", () => {
		const map = newMap()
		map.promote(KEY, BIN_HZ, [{ startBin: SPUR_BIN, endBin: SPUR_BIN + 1 }])
		lineEpoch(map, 1, C, 2000, { bins: [SPUR_BIN] })
		lineEpoch(map, 2, C + 1e6, 2000, {}) // quiet and off: a miss
		lineEpoch(map, 3, C + 2e6, 2000, { bins: [SPUR_BIN] })
		lineEpoch(map, 4, C + 3e6, 1000, {})
		expect(masked(map)).toEqual([])
		const spur = newMap()
		spur.promote(KEY, BIN_HZ, [{ startBin: SPUR_BIN, endBin: SPUR_BIN + 1 }])
		for (let e = 1; e <= 4; e++)
			lineEpoch(spur, e, C + e * 1e6, 2000, { bins: [SPUR_BIN] })
		expect(masked(spur)).toEqual([SPUR_BIN])
	})

	it("expires an unconfirmed candidate at its TTL, not a block before", () => {
		const map = newMap()
		map.promote(KEY, BIN_HZ, [{ startBin: SPUR_BIN, endBin: SPUR_BIN + 1 }])
		lineEpoch(map, 1, C, SPUR_TTL_MS - BLOCK_MS, { bins: [SPUR_BIN] })
		expect(map.alive(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(true)
		expect(map.exportState().spurs).toEqual([]) // unconfirmed: never persisted
		lineEpoch(map, 1, C, BLOCK_MS, { bins: [SPUR_BIN] })
		expect(map.alive(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(false)
	})

	it("stops masking a confirmed spur unseen for the TTL, not a block before", () => {
		const map = newMap()
		map.promote(KEY, BIN_HZ, [{ startBin: SPUR_BIN, endBin: SPUR_BIN + 1 }])
		lineEpoch(map, 1, C, 2000, { bins: [SPUR_BIN] })
		lineEpoch(map, 2, C + 1e6, 2000, { bins: [SPUR_BIN] })
		lineEpoch(map, 3, C + 2e6, 1000, { bins: [SPUR_BIN] }) // last seen here
		expect(masked(map)).toEqual([SPUR_BIN])
		lineEpoch(map, 3, C + 2e6, SPUR_TTL_MS - BLOCK_MS, {}) // parked: no epoch closes, no miss
		expect(masked(map)).toEqual([SPUR_BIN])
		lineEpoch(map, 3, C + 2e6, BLOCK_MS, {})
		expect(masked(map)).toEqual([])
		expect(map.alive(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(false)
	})

	it("re-verifies a persisted line after a restart before it masks", () => {
		const map = newMap()
		map.promote(KEY, BIN_HZ, [{ startBin: SPUR_BIN, endBin: SPUR_BIN + 1 }])
		for (let e = 1; e <= 3; e++)
			lineEpoch(map, e, C + e * 1e6, 2000, { bins: [SPUR_BIN] })
		expect(masked(map)).toEqual([SPUR_BIN])
		const restored = newMap()
		restored.importState(map.exportState())
		expect(masked(restored)).toEqual([])
		lineEpoch(restored, 1, C, 2000, { bins: [SPUR_BIN] })
		expect(masked(restored)).toEqual([]) // one centre since the restart
		lineEpoch(restored, 2, C + 1e6, 2000, { bins: [SPUR_BIN] })
		lineEpoch(restored, 3, C + 2e6, 1000, { bins: [SPUR_BIN] })
		expect(masked(restored)).toEqual([SPUR_BIN])
	})

	/** A promoted SPUR_BIN ± 1 range, its centre confirmed from two centres 1 MHz apart. */
	function verifiedSkirtedLine(): SpurMap {
		const map = newMap()
		map.promote(KEY, BIN_HZ, [{ startBin: SPUR_BIN - 1, endBin: SPUR_BIN + 2 }])
		for (let e = 1; e <= 3; e++)
			lineEpoch(map, e, C + e * 1e6, 2000, { bins: [SPUR_BIN] })
		return map
	}

	/** dB over the floor of a bin carrying `excess` floor powers over it. */
	const db = (excess: number): number => 10 * Math.log10(1 + excess)

	/** Measures one block with `loud` bins that far over the flat floor, the rest at the floor. */
	function measureWith(map: SpurMap, loud: Record<number, number>): void {
		const powerDb = new Float32Array(N).fill(FLOOR_DB)
		for (const [bin, db] of Object.entries(loud))
			powerDb[Number(bin)] = FLOOR_DB + db
		map.measure(powerDb, FLOOR, BIN_HZ)
	}

	it("lifts a verified mask at the footprint's own level of 6 dB, not under it", () => {
		// 1 + (10^(x/10) − 1) / 13 = 10^0.6 at x = 10·log10(1 + 13 · (10^0.6 − 1)) = 16.0 dB
		const map = verifiedSkirtedLine()
		const fp = [SPUR_BIN - 1, SPUR_BIN, SPUR_BIN + 1]
		measureWith(map, { [SPUR_BIN]: 15.9 })
		expect(masked(map)).toEqual(fp)
		expect(map.masks(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(true)
		measureWith(map, { [SPUR_BIN]: 16.1 })
		expect(masked(map)).toEqual([]) // the whole run lifts
		expect(map.masks(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(false)
		// the excess is summed over the footprint: 13 dB in each of its 3 bins, 3 · 19 = 57 ≥ 38.8
		measureWith(map, {
			[SPUR_BIN - 1]: 13,
			[SPUR_BIN]: 13,
			[SPUR_BIN + 1]: 13,
		})
		expect(masked(map)).toEqual([])
	})

	it("lifts for a signal on the footprint's skirt bin, never for one a bin past it", () => {
		const map = verifiedSkirtedLine()
		measureWith(map, { [SPUR_BIN + 1]: 30 })
		expect(masked(map)).toEqual([])
		measureWith(map, { [SPUR_BIN + 2]: 30 }) // inside the 13-bin slot of every footprint bin
		expect(masked(map)).toEqual([SPUR_BIN - 1, SPUR_BIN, SPUR_BIN + 1])
		measureWith(map, { [SPUR_BIN - 2]: 30, [SPUR_BIN + 6]: 40 })
		expect(masked(map)).toEqual([SPUR_BIN - 1, SPUR_BIN, SPUR_BIN + 1])
	})

	it("measures a provisional line given by its core bins with ±1 bin of skirt", () => {
		const map = verifiedSkirtedLine()
		measureWith(map, { [SPUR_BIN + 1]: 30 })
		expect(map.masks(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(false)
		measureWith(map, { [SPUR_BIN + 2]: 30 })
		expect(map.masks(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(true)
	})

	/** Footprint 3 bins of `fpExcess` floor powers each, a 3-bin flank at `side` of `flankExcess` each. */
	function spill(
		side: 1 | -1,
		fpExcess: number,
		flankExcess: number,
	): Record<number, number> {
		const loud: Record<number, number> = {}
		for (let b = SPUR_BIN - 1; b <= SPUR_BIN + 1; b++) loud[b] = db(fpExcess)
		// one guard bin (SPUR_BIN ± 2) past the footprint, then the flank SPUR_BIN ± 3 to ± 5
		for (let k = 3; k <= 5; k++) loud[SPUR_BIN + side * k] = db(flankExcess)
		return loud
	}

	it("keeps the mask while the footprint's loud energy spills past its guard bin at its level less 6 dB", () => {
		// footprint excess 99 a bin (20 dB): the flank holds the mask from 99 · 10^−0.6 ≈ 24.9 a bin
		// (its own level 1 + 3 · 24.9 / 13 = 6.7 dB, past the absolute bound too)
		const fp = [SPUR_BIN - 1, SPUR_BIN, SPUR_BIN + 1]
		const atBound = 99 * 10 ** (-SPUR_MAX_LEVEL_DB / 10)
		const map = verifiedSkirtedLine()
		for (const side of [1, -1] as const) {
			measureWith(map, spill(side, 99, atBound * 0.97))
			expect(masked(map), `side ${side} under`).toEqual([])
			expect(map.masks(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(false)
			measureWith(map, spill(side, 99, atBound * 1.03))
			expect(masked(map), `side ${side} at`).toEqual(fp)
			expect(map.masks(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(true)
		}
		// the flank is summed, not read bin by bin: all its excess in one of its bins
		measureWith(map, {
			...spill(1, 99, 0),
			[SPUR_BIN + 4]: db(3 * atBound * 1.03),
		})
		expect(masked(map)).toEqual(fp)
		// the guard bin is no part of the flank, nor is a bin past the flank
		measureWith(map, {
			...spill(1, 99, 0),
			[SPUR_BIN + 2]: 40,
			[SPUR_BIN + 6]: 40,
			[SPUR_BIN - 6]: 40,
		})
		expect(masked(map)).toEqual([])
	})

	it("keeps the mask for a spill only while the flank alone reaches the 6 dB slot level", () => {
		// footprint excess 20 a bin (13.2 dB, 1 + 60 / 13 = 7.5 dB: loud), relative bound 5.0 a bin;
		// the flank's own level 1 + 3x / 13 reaches 10^0.6 at x = 13 · (10^0.6 − 1) / 3 ≈ 12.9
		const atBound = (13 * (10 ** (SPUR_MAX_LEVEL_DB / 10) - 1)) / 3
		const map = verifiedSkirtedLine()
		measureWith(map, spill(1, 20, atBound * 0.97))
		expect(masked(map)).toEqual([])
		measureWith(map, spill(1, 20, atBound * 1.03))
		expect(masked(map)).toEqual([SPUR_BIN - 1, SPUR_BIN, SPUR_BIN + 1])
	})

	it("lifts for a narrow carrier on the line and holds for a flat emission across it or a neighbour", () => {
		const map = verifiedSkirtedLine()
		const fp = [SPUR_BIN - 1, SPUR_BIN, SPUR_BIN + 1]
		// Hann tones 40 dB at their peak: half a bin off the footprint's edge bin, inward or outward,
		// 0.029 + 0.0006 of the peak power in the flank against 0.72 + 0.029 a footprint bin
		const peak = 10 ** 4
		const at = (frac: number): number => db(peak * frac)
		for (const edge of [SPUR_BIN + 0.5, SPUR_BIN + 1.5]) {
			const loud: Record<number, number> = {}
			for (let b = SPUR_BIN - 1; b <= SPUR_BIN + 4; b++) {
				const d = Math.abs(b - edge)
				loud[b] = at(
					d === 0.5 ? 0.72 : d === 1.5 ? 0.029 : d === 2.5 ? 0.0006 : 0,
				)
			}
			measureWith(map, loud)
			expect(masked(map), `tone at ${edge - SPUR_BIN}`).toEqual([])
		}
		// bin-centred on the footprint's edge bin: its −6 dB skirt is on the guard bin
		measureWith(map, {
			[SPUR_BIN]: at(0.25),
			[SPUR_BIN + 1]: at(1),
			[SPUR_BIN + 2]: at(0.25),
		})
		expect(masked(map)).toEqual([])
		// bin-centred on the guard bin: its skirt on the footprint and on the flank alike
		measureWith(map, {
			[SPUR_BIN + 1]: at(0.25),
			[SPUR_BIN + 2]: at(1),
			[SPUR_BIN + 3]: at(0.25),
		})
		expect(masked(map)).toEqual(fp)
		// 16 bins of 20 dB, the line 5 bins from the band's low edge: the footprint lifts alone
		const band: Record<number, number> = {}
		for (let b = SPUR_BIN - 5; b < SPUR_BIN + 11; b++) band[b] = 20
		measureWith(map, band)
		expect(masked(map)).toEqual(fp)
		expect(map.masks(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(true)
	})

	it("masks nothing while the block has no floor", () => {
		const map = verifiedSkirtedLine()
		map.measure(new Float32Array(N).fill(FLOOR_DB), null, BIN_HZ)
		expect(masked(map)).toEqual([])
		expect(map.masks(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(false)
	})

	it("leaves protected bins unmasked and counts them", () => {
		const map = newMap()
		map.promote(KEY, BIN_HZ, [{ startBin: SPUR_BIN - 1, endBin: SPUR_BIN + 2 }])
		for (let e = 1; e <= 3; e++)
			lineEpoch(map, e, C + e * 1e6, 2000, { bins: [SPUR_BIN] })
		const protect = new Uint8Array(N)
		protect[SPUR_BIN + 1] = 1
		const out = new Uint8Array(N)
		expect(map.mask(KEY, out, protect)).toBe(1)
		expect([...out.keys()].filter(i => out[i] === 1)).toEqual([
			SPUR_BIN - 1,
			SPUR_BIN,
		])
	})
})

/**
 * One epoch of `ms` in BLOCK_MS blocks with steady emissions at `rfHz` (each on at the bin its RF
 * reads under `centreHz`, when inside the FFT) and receiver lines at the baseband bins `bins`.
 */
function rfEpoch(
	map: SpurMap,
	epoch: number,
	centreHz: number,
	ms: number,
	opts: { rfHz?: number[]; bins?: number[] },
): void {
	const bins = [...(opts.bins ?? [])]
	for (const hz of opts.rfHz ?? []) {
		const b = Math.round((hz - centreHz) / BIN_HZ) + N / 2
		if (b >= 0 && b < N) bins.push(b)
	}
	lineEpoch(map, epoch, centreHz, ms, { bins })
}

/** A live 2 m sweep step: 775.1 kHz, 775.1 bins at 1 kHz, so f and f + hop share a baseband bin. */
const HOP_HZ = 775_100
/** A bin both centres see the other carrier from: 775 ≤ bin ≤ N − 1 − 775, off DC. */
const LINE_BIN = 900
/** RF of LINE_BIN under C. */
const RF_A = C + (LINE_BIN - N / 2) * BIN_HZ

describe("SpurMap RF move veto", () => {
	// Two weak steady real carriers one hop apart: A under C and B under C + hop both read LINE_BIN.
	for (const [label, offsetHz, bin] of [
		["exactly one hop apart", 0, LINE_BIN],
		[
			"one hop and 0.4 bin apart (rounds to the same bin)",
			0.4 * BIN_HZ,
			LINE_BIN,
		],
		["one hop and one bin apart (the ±1 tolerance)", BIN_HZ, LINE_BIN],
		["one hop and two bins apart (past the tolerance)", 2 * BIN_HZ, LINE_BIN],
		[
			"exactly one hop apart, the other carrier outside the second centre",
			0,
			SPUR_BIN,
		],
	] as const) {
		it(`never confirms two real carriers ${label}`, () => {
			const map = newMap()
			const a = C + (bin - N / 2) * BIN_HZ
			const rfHz = [a, a + HOP_HZ + offsetHz]
			map.promote(KEY, BIN_HZ, [{ startBin: bin - 1, endBin: bin + 4 }])
			for (let e = 1; e <= 6; e++)
				rfEpoch(map, e, e % 2 === 1 ? C : C + HOP_HZ, 2000, { rfHz })
			for (let i = bin - 1; i <= bin + 3; i++)
				expect(map.verified(KEY, i, i + 1)).toBe(false)
			expect(masked(map)).toEqual([])
			expect(
				map.exportState().spurs.filter(s => s.kind === "baseband"),
			).toEqual([])
		})
	}

	it("still confirms a receiver line from the same two centres, real carriers around it", () => {
		const map = newMap()
		map.promote(KEY, BIN_HZ, [{ startBin: LINE_BIN, endBin: LINE_BIN + 1 }])
		// Real carriers nowhere near the line's RF under either centre.
		const rfHz = [C + 120_000, C + 400_000]
		for (let e = 1; e <= 3; e++)
			rfEpoch(map, e, e % 2 === 1 ? C : C + HOP_HZ, 2000, {
				rfHz,
				bins: [LINE_BIN],
			})
		expect(map.verified(KEY, LINE_BIN, LINE_BIN + 1)).toBe(true)
		expect(masked(map)).toEqual([LINE_BIN])
	})

	it("still confirms a receiver comb whose spacing divides the hop: tooth k + 4 sits on tooth k's RF", () => {
		// 25-bin teeth, a 100 kHz (100-bin) hop: under C + hop the RF tooth k read under C is at
		// tooth k − 4's bin, a line C credited too, so the same pattern under both centres.
		const map = newMap()
		const teeth = Array.from({ length: 7 }, (_, k) => LINE_BIN + (k - 3) * 25)
		for (const t of teeth)
			map.promote(KEY, BIN_HZ, [{ startBin: t, endBin: t + 1 }])
		for (let e = 1; e <= 3; e++)
			rfEpoch(map, e, e % 2 === 1 ? C : C + 100_000, 2000, { bins: teeth })
		for (const t of teeth) expect(map.verified(KEY, t, t + 1)).toBe(true)
		expect(masked(map)).toEqual(teeth)
	})

	// A receiver line at LINE_BIN under C, C + 18 bins and C + Δ bins; a real carrier at the RF the
	// line reads under C keys up only under C + Δ, where it sits Δ bins below the line. The veto
	// bound is maxWidthBins + 2 = 5 bins: at Δ = 4 the line itself could light that RF entry, so C's
	// credit stands; at Δ = 5 it is an emission that moved with RF, C's credit goes and C + 18 bins
	// and C + 5 bins are 13 bins apart, under the 18 needed.
	for (const [delta, confirms] of [
		[4, true],
		[5, false],
	] as const) {
		it(`vetoes a credit whose RF was seen steady ${delta} bins away: ${confirms ? "kept" : "vetoed"}`, () => {
			const map = newMap()
			map.promote(KEY, BIN_HZ, [{ startBin: LINE_BIN, endBin: LINE_BIN + 1 }])
			const c3 = C + delta * BIN_HZ
			rfEpoch(map, 1, C, 2000, { bins: [LINE_BIN] })
			rfEpoch(map, 2, C + SEPARATION_HZ, 2000, { bins: [LINE_BIN] })
			rfEpoch(map, 3, c3, 2000, { bins: [LINE_BIN], rfHz: [RF_A] })
			rfEpoch(map, 4, c3, 1000, { bins: [LINE_BIN], rfHz: [RF_A] })
			expect(map.verified(KEY, LINE_BIN, LINE_BIN + 1)).toBe(confirms)
			expect(masked(map)).toEqual(confirms ? [LINE_BIN] : [])
		})
	}
})

/** `st` as a map that restored it unverified saves it again: no `verified` flag. */
function unflagged(
	st: ReturnType<SpurMap["exportState"]>,
): ReturnType<SpurMap["exportState"]> {
	return { spurs: st.spurs.map(({ verified: _v, ...sp }) => sp) }
}

describe("SpurMap restored candidates age by wall time", () => {
	/** A state with one confirmed line of `key`, learned by a fresh map. */
	function persisted(): ReturnType<SpurMap["exportState"]> {
		const map = newMap()
		map.promote(KEY, BIN_HZ, [{ startBin: SPUR_BIN, endBin: SPUR_BIN + 1 }])
		for (let e = 1; e <= 3; e++)
			lineEpoch(map, e, C + e * 1e6, 2000, { bins: [SPUR_BIN] })
		const st = map.exportState()
		expect(st.spurs).toEqual([
			{
				key: KEY,
				basebandBin: SPUR_BIN,
				widthBins: 1,
				kind: "baseband",
				verified: true, // confirmed by credits in this map
			},
		])
		return st
	}

	function clockedMap(clock: { t: number }): SpurMap {
		return new SpurMap({
			fftSize: N,
			minObservedMs: 600_000,
			onFraction: 0.95,
			maxWidthBins: 3,
			nowMs: () => clock.t,
		})
	}

	it("drops a restored candidate of a never-observed key at 10 min of wall time, not a millisecond before", () => {
		const clock = { t: 1_000_000 }
		const map = clockedMap(clock)
		const st = persisted()
		map.importState(st)
		clock.t += SPUR_TTL_MS - 1
		expect(map.alive(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(true)
		expect(map.exportState()).toEqual(unflagged(st))
		clock.t += 1
		expect(map.alive(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(false)
		const out = new Uint8Array(N)
		map.candidates(KEY, out)
		expect(out.includes(1)).toBe(false)
		expect(map.exportState().spurs).toEqual([])
	})

	it("drops an observed key's restored candidate that never re-confirms at the same wall bound", () => {
		const clock = { t: 0 }
		const map = clockedMap(clock)
		map.importState(persisted())
		lineEpoch(map, 1, C, 2000, { bins: [SPUR_BIN] }) // one centre: unverified
		clock.t = SPUR_TTL_MS
		expect(map.alive(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(false)
		expect(map.exportState().spurs).toEqual([])
	})

	it("keeps a restored line re-confirmed in the very block that reaches its wall-time bound", () => {
		let restored = false
		const map: SpurMap = new SpurMap({
			fftSize: N,
			minObservedMs: 600_000,
			onFraction: 0.95,
			maxWidthBins: 3,
			// The wall clock reaches the bound (the import at 0) in the block whose classification
			// re-confirms the line, and stays a millisecond short of it before: the refresh and the
			// restored candidates' aging meet in one block.
			nowMs: (): number => {
				if (!restored) return 0
				const s: { confirmed: Uint8Array } | undefined = (
					map as unknown as {
						keys: Map<string, { confirmed: Uint8Array }>
					}
				).keys.get(KEY)
				return s?.confirmed[SPUR_BIN] === 1 ? SPUR_TTL_MS : SPUR_TTL_MS - 1
			},
		})
		const st = persisted()
		map.importState(st)
		restored = true
		for (let e = 1; e <= 3; e++)
			lineEpoch(map, e, C + e * 1e6, 2000, { bins: [SPUR_BIN] })
		expect(masked(map)).toEqual([SPUR_BIN])
		expect(map.alive(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(true)
		expect(map.exportState()).toEqual(st)
	})

	it("keeps a restored line of a key observed again: it re-confirms and ages on settled time", () => {
		const clock = { t: 0 }
		const map = clockedMap(clock)
		const st = persisted()
		map.importState(st)
		for (let e = 1; e <= 3; e++) {
			clock.t += 2000
			lineEpoch(map, e, C + e * 1e6, 2000, { bins: [SPUR_BIN] })
		}
		expect(masked(map)).toEqual([SPUR_BIN])
		clock.t += SPUR_TTL_MS
		expect(map.alive(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(true)
		expect(masked(map)).toEqual([SPUR_BIN])
		expect(map.exportState()).toEqual(st)
	})
})
