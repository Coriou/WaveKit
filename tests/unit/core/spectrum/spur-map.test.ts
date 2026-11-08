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
			{ key: KEY, basebandBin: SPUR_BIN, widthBins: 1, kind: "baseband" },
		])
		const restored = newMap()
		restored.importState(state)
		expect(masked(restored)).toEqual([]) // restored lines are unverified
		expect(restored.exportState()).toEqual(state) // and persisted again until they expire
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
		expect(
			map.exportState().spurs.map(s => [s.basebandBin, s.widthBins]),
		).toEqual([
			[700, 3],
			[1500, 3],
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
