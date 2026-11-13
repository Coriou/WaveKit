/**
 * SpurMap trusted restore: lines of a resumed namespace of a strong receiver key load verified
 * (the caller decides, `importState(…, { trusted: true })` / `trustLines`), so a parked receiver
 * masks the lines it verified before from one centre. Everything else loads unverified.
 */
import { describe, expect, it } from "vitest"
import { SPUR_TTL_MS, SpurMap } from "../../../../src/core/spectrum/spur-map.js"
import type { EngineState } from "../../../../src/core/spectrum/types.js"

const N = 2048
const FS = 2_048_000
const BIN_HZ = FS / N
const KEY = `${FS}:m:496:${N}`
const SPUR_BIN = N / 2 - 423
const BLOCK_MS = 1000
const C = 446_000_000
const FLOOR_DB = -60
const FLOOR = new Float32Array(N).fill(FLOOR_DB)
const ALL_BINS = new Uint8Array(N).fill(1)

function clockedMap(clock: { t: number }): SpurMap {
	return new SpurMap({
		fftSize: N,
		minObservedMs: 600_000,
		onFraction: 0.95,
		maxWidthBins: 3,
		nowMs: () => clock.t,
	})
}

/**
 * One epoch of `ms` in BLOCK_MS blocks: `bins` are line bins (on for the detector and the line
 * learner), measured `perBinDb` over a flat floor (default 3 dB, a quiet receiver line). The wall
 * clock advances with the blocks.
 */
function lineEpoch(
	map: SpurMap,
	clock: { t: number },
	epoch: number,
	centreHz: number,
	ms: number,
	bins: number[],
	perBinDb = 3,
): void {
	for (let t = 0; t < ms; t += BLOCK_MS) {
		const powerDb = new Float32Array(N).fill(FLOOR_DB)
		for (const b of bins) powerDb[b] = FLOOR_DB + perBinDb
		map.measure(powerDb, FLOOR, BIN_HZ)
		const line = new Uint8Array(N)
		for (const b of bins) line[b] = 1
		map.observe(KEY, { epoch, centreHz, binHz: BIN_HZ }, line, BLOCK_MS, {
			on: line,
			observable: ALL_BINS,
		})
		clock.t += BLOCK_MS
	}
}

function masked(map: SpurMap, protect?: Uint8Array): number[] {
	const out = new Uint8Array(N)
	map.mask(KEY, out, protect)
	return [...out.keys()].filter(i => out[i] === 1)
}

const SAVED: Pick<EngineState, "spurs"> = {
	spurs: [
		{
			key: KEY,
			basebandBin: SPUR_BIN,
			widthBins: 1,
			kind: "baseband",
			verified: true,
		},
	],
}
/** The same line saved without the flag: an older file, or a line not verified when saved. */
const UNFLAGGED: Pick<EngineState, "spurs"> = {
	spurs: [{ key: KEY, basebandBin: SPUR_BIN, widthBins: 1, kind: "baseband" }],
}

describe("SpurMap trusted restore", () => {
	it("masks a trusted restored line at once from one centre; the same line untrusted does not", () => {
		const clock = { t: 0 }
		const trusted = clockedMap(clock)
		const plain = clockedMap(clock)
		trusted.importState(SAVED, { trusted: true })
		plain.importState(SAVED)
		plain.importState(SAVED, { trusted: false })
		lineEpoch(trusted, clock, 1, C, 2000, [SPUR_BIN])
		lineEpoch(plain, clock, 1, C, 2000, [SPUR_BIN])
		expect(masked(trusted)).toEqual([SPUR_BIN])
		expect(trusted.verified(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(true)
		expect(masked(plain)).toEqual([])
		expect(plain.verified(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(false)
	})

	it("verifies a trusted line before any block, and it persists as a verified line", () => {
		const clock = { t: 0 }
		const map = clockedMap(clock)
		map.importState(SAVED, { trusted: true })
		expect(map.verified(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(true)
		expect(map.exportState()).toEqual(SAVED)
	})

	it("never verifies a new line: a line first seen after the trusted import needs two centres", () => {
		const clock = { t: 0 }
		const map = clockedMap(clock)
		map.importState(SAVED, { trusted: true })
		const other = SPUR_BIN + 200
		map.promote(KEY, BIN_HZ, [{ startBin: other, endBin: other + 1 }])
		lineEpoch(map, clock, 1, C, 4000, [SPUR_BIN, other])
		lineEpoch(map, clock, 2, C, 4000, [SPUR_BIN, other]) // the same centre again
		expect(masked(map)).toEqual([SPUR_BIN])
		expect(map.verified(KEY, other, other + 1)).toBe(false)
	})

	it("keeps masking a parked trusted line seen past 10 min: once seen it ages on the settled clock", () => {
		const clock = { t: 0 }
		const map = clockedMap(clock)
		map.importState(SAVED, { trusted: true })
		lineEpoch(map, clock, 1, C, 2 * SPUR_TTL_MS, [SPUR_BIN])
		expect(clock.t).toBe(2 * SPUR_TTL_MS)
		expect(masked(map)).toEqual([SPUR_BIN])
		expect(map.exportState()).toEqual(SAVED)
	})

	it("stops masking an observed key's trusted line unseen for SPUR_TTL_MS of settled clock, not a block before", () => {
		// Counted from the import (the line counts as seen at the key's settled clock then); one
		// open epoch, so no miss closes in between.
		const clock = { t: 0 }
		const map = clockedMap(clock)
		map.importState(SAVED, { trusted: true })
		lineEpoch(map, clock, 1, C, SPUR_TTL_MS - BLOCK_MS, [])
		expect(map.verified(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(true)
		lineEpoch(map, clock, 1, C, BLOCK_MS, [])
		expect(map.verified(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(false)
		expect(masked(map)).toEqual([])
	})

	it("drops the trust of a never-observed key's line at 10 min of wall time after the import, not a millisecond before", () => {
		const clock = { t: 5_000_000 }
		const map = clockedMap(clock)
		map.importState(SAVED, { trusted: true })
		clock.t += SPUR_TTL_MS - 1
		expect(map.verified(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(true)
		clock.t += 1
		expect(map.verified(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(false)
		// The restored candidate itself ages out at the same bound (restored-candidate rule).
		expect(map.exportState().spurs).toEqual([])
	})

	it("clears the trust at a miss: an epoch where the line was quiet", () => {
		const clock = { t: 0 }
		const map = clockedMap(clock)
		map.importState(SAVED, { trusted: true })
		lineEpoch(map, clock, 1, C, 2000, []) // quiet under this centre
		expect(map.verified(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(true) // the epoch is still open
		lineEpoch(map, clock, 2, C + 1e6, 2000, [SPUR_BIN]) // the close of epoch 1 is the miss
		expect(map.verified(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(false)
		expect(masked(map)).toEqual([])
	})

	it("keeps the lift rule: a trusted line lifts at the footprint's own 6 dB, not under it", () => {
		// 1 + (10^(x/10) − 1) / 13 = 10^0.6 at x = 16.0 dB (spur-map.test.ts)
		const clock = { t: 0 }
		const map = clockedMap(clock)
		map.importState(SAVED, { trusted: true })
		lineEpoch(map, clock, 1, C, 2000, [SPUR_BIN], 15.9)
		expect(masked(map)).toEqual([SPUR_BIN])
		lineEpoch(map, clock, 1, C, 1000, [SPUR_BIN], 16.1)
		expect(masked(map)).toEqual([])
		expect(map.masks(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(false)
	})

	it("keeps a confirmed real signal unmasked on a trusted line (protect)", () => {
		const clock = { t: 0 }
		const map = clockedMap(clock)
		map.importState(SAVED, { trusted: true })
		lineEpoch(map, clock, 1, C, 2000, [SPUR_BIN])
		const protect = new Uint8Array(N)
		protect[SPUR_BIN] = 1
		const out = new Uint8Array(N)
		expect(map.mask(KEY, out, protect)).toBe(1)
		expect(out.includes(1)).toBe(false)
	})

	it("trusts provisional lines given by trustLines at their core bins, of its own FFT size only", () => {
		const clock = { t: 0 }
		const map = clockedMap(clock)
		const line = SPUR_BIN + 300
		map.trustLines([
			{ key: KEY, basebandBin: line, widthBins: 1 },
			{ key: `${FS}:m:496:1024`, basebandBin: 10, widthBins: 1 },
		])
		lineEpoch(map, clock, 1, C, 2000, [line])
		expect(map.masks(KEY, line, line + 1)).toBe(true)
		expect(map.verified(`${FS}:m:496:1024`, 10, 11)).toBe(false)
		// no SpurMap candidate: a provisional line masks through ProvisionalSpurs only
		expect(masked(map)).toEqual([])
	})

	it("ignores malformed keys and out-of-range bins in a trusted import", () => {
		const clock = { t: 0 }
		const map = clockedMap(clock)
		map.importState(
			{
				spurs: [
					{
						key: "x:agc:2048",
						basebandBin: 5,
						widthBins: 1,
						kind: "baseband",
						verified: true,
					},
					{
						key: KEY,
						basebandBin: -3,
						widthBins: 2,
						kind: "baseband",
						verified: true,
					},
				],
			},
			{ trusted: true },
		)
		map.trustLines([
			{ key: "nan:agc:2048", basebandBin: 5, widthBins: 1 },
			{ key: KEY, basebandBin: N - 1, widthBins: 5 },
		])
		expect(map.verified(KEY, 0, 1)).toBe(false)
		expect(map.verified(KEY, N - 1, N)).toBe(true)
		expect(map.verified("x:agc:2048", 5, 6)).toBe(false)
	})

	it("keeps a line saved without the verified flag unverified on a trusted import (older files)", () => {
		const clock = { t: 0 }
		const map = clockedMap(clock)
		map.importState(UNFLAGGED, { trusted: true })
		lineEpoch(map, clock, 1, C, 2000, [SPUR_BIN])
		expect(masked(map)).toEqual([])
		expect(map.verified(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(false)
		// Restored, not verified: it persists again with no flag.
		expect(map.exportState()).toEqual(UNFLAGGED)
	})

	it("saves an untrusted restored line without the flag, so the next trusted load stays unverified", () => {
		// A take-over or a legacy adoption: the lines load untrusted, whatever their saved flag.
		const clock = { t: 0 }
		const first = clockedMap(clock)
		first.importState(SAVED)
		lineEpoch(first, clock, 1, C, 4000, [SPUR_BIN])
		const saved = first.exportState()
		expect(saved).toEqual(UNFLAGGED)
		const next = clockedMap(clock)
		next.importState(saved, { trusted: true })
		lineEpoch(next, clock, 1, C, 2000, [SPUR_BIN])
		expect(masked(next)).toEqual([])
	})

	it("saves a line verified by two centres in this process with the flag, and it loads trusted", () => {
		const clock = { t: 0 }
		const first = clockedMap(clock)
		first.promote(KEY, BIN_HZ, [{ startBin: SPUR_BIN, endBin: SPUR_BIN + 1 }])
		lineEpoch(first, clock, 1, C, 4000, [SPUR_BIN])
		lineEpoch(first, clock, 2, C + 775_100, 4000, [SPUR_BIN])
		lineEpoch(first, clock, 3, C, 1000, [SPUR_BIN]) // closes epoch 2: its credit counts
		expect(first.verified(KEY, SPUR_BIN, SPUR_BIN + 1)).toBe(true)
		const saved = first.exportState()
		expect(saved.spurs.length).toBeGreaterThan(0)
		expect(saved.spurs.every(sp => sp.verified === true)).toBe(true)
		const next = clockedMap(clock)
		next.importState(saved, { trusted: true })
		lineEpoch(next, clock, 1, C, 2000, [SPUR_BIN])
		expect(masked(next)).toContain(SPUR_BIN)
	})

	it("splits a saved run where the verified state changes", () => {
		const clock = { t: 0 }
		const map = clockedMap(clock)
		// Bins SPUR_BIN .. +5: the first three restored trusted and flagged, the last three not.
		map.importState({
			spurs: [
				{ ...UNFLAGGED.spurs[0]!, basebandBin: SPUR_BIN + 3, widthBins: 3 },
			],
		})
		map.importState(
			{ spurs: [{ ...SAVED.spurs[0]!, widthBins: 3 }] },
			{ trusted: true },
		)
		// A verified bin carries a ±1-bin skirt: SPUR_BIN + 3 counts as verified beside it.
		expect(map.exportState().spurs).toEqual([
			{ ...SAVED.spurs[0]!, widthBins: 4 },
			{ ...UNFLAGGED.spurs[0]!, basebandBin: SPUR_BIN + 4, widthBins: 2 },
		])
	})
})
