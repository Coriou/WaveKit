import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { segment } from "../../../../../src/core/spectrum/emissions/segmenter.js"
import {
	FSK_PAIR_DB,
	Tracker,
} from "../../../../../src/core/spectrum/emissions/tracker.js"
import type { PipelineEvent } from "../../../../../src/core/spectrum/types.js"

// Scanner quality benchmark: a 2FSK emission whose valley falls to the floor (a ±4.5 kHz POCSAG
// pair at 10 dB, a ±30 kHz ISM sensor) showed as two tracks, one per tone. Synthetic blocks only.

const N = 512
const BIN_HZ = 1000
const BLOCK = 25_600
const FLOOR = -60
/** Pair reach in bins: 100 kHz at 1 kHz bins, every bin. */
const REACH = 100

interface Tone {
	/** First bin. */
	at: number
	width: number
	/** Power over the floor (dB). */
	db: number
}

function tracker(): Tracker {
	const t = new Tracker({
		sourceId: "s1",
		binHz: BIN_HZ,
		blockMs: 50,
		hangBlocks: 3,
		maxTracks: 16,
		maxTrackBlocks: 1000,
		idPrefix: "t",
	})
	t.beginEpoch({
		stream: 1,
		epoch: 1,
		centreHz: 433_100_000,
		tuningTrust: "commanded",
	})
	return t
}

const reachBins = (bins: number): Uint16Array => new Uint16Array(N).fill(bins)

function runBlock(
	t: Tracker,
	index: number,
	tones: readonly Tone[],
	reach: Uint16Array | null = reachBins(REACH),
): PipelineEvent[] {
	const powerDb = new Float32Array(N).fill(FLOOR)
	const floorDb = new Float32Array(N).fill(FLOOR)
	for (const tone of tones)
		for (let i = tone.at; i < tone.at + tone.width; i++)
			powerDb[i] = FLOOR + tone.db
	const on = new Uint8Array(N)
	for (let i = 0; i < N; i++) on[i] = (powerDb[i] ?? 0) > FLOOR + 4 ? 1 : 0
	const segs = segment(on, powerDb, floorDb, {
		gapBins: 2,
		usableStartBin: 10,
		usableEndBin: N - 10,
		exclusionEdges: [],
		rasterBinEdges: [],
		skirtDb: 30,
		inWindow: true,
	})
	return t.block(segs, {
		endSample: (index + 1) * BLOCK,
		powerDb,
		floorDb,
		blockFloorDb: FLOOR,
		thresholdDb: 4,
		gap: false,
		overload: false,
		...(reach ? { pairReachBins: reach } : {}),
	})
}

/** Track ids opened over a run of blocks (quiet first block, then `blocks`). */
function opened(
	blocks: readonly (readonly Tone[])[],
	reach: Uint16Array | null = reachBins(REACH),
): { ids: Set<string>; t: Tracker } {
	const t = tracker()
	const ids = new Set<string>()
	// A quiet first block: pairing needs the block before it in the epoch.
	runBlock(t, 0, [], reach)
	blocks.forEach((tones, i) => {
		for (const e of runBlock(t, i + 1, tones, reach))
			if (e.kind === "track-open") ids.add(e.track.trackId)
	})
	return { ids, t }
}

const pair = (gapBins: number, db = 15, width = 4, dbB = db): Tone[] => [
	{ at: 200, width, db },
	{ at: 200 + width + gapBins, width, db: dbB },
]

describe("tracker FSK pair fusion", () => {
	it("two co-onset tones of one emission are one track spanning both, block after block", () => {
		const { ids, t } = opened(Array.from({ length: 6 }, () => pair(5)))
		expect(ids.size).toBe(1)
		const snap = t.snapshotOf([...ids][0]!)!
		// the centroid sits between the tones (bins 200..203 and 209..212, mean bin 206), not on one
		const mid = 433_100_000 + (206 - N / 2) * BIN_HZ
		expect(Math.abs(snap.centreHz - mid)).toBeLessThanOrEqual(BIN_HZ)
		expect(snap.blocks).toBe(6)
	})

	it("a tone that keys up one block after its partner still joins it", () => {
		const one = [pair(5)[0]!]
		const { ids } = opened([one, pair(5), pair(5), pair(5)])
		expect(ids.size).toBe(1)
	})

	it("joins at FSK_PAIR_DB level difference, not past it", () => {
		expect(opened([pair(5, 20, 4, 20 - FSK_PAIR_DB)]).ids.size).toBe(1)
		expect(opened([pair(5, 20, 4, 20 - FSK_PAIR_DB - 0.5)]).ids.size).toBe(2)
	})

	it("parts of very different width stay apart (an OOK sensor next to a LoRa piece)", () => {
		const two = (w: number): Tone[] => [
			{ at: 200, width: 4, db: 15 },
			{ at: 210, width: w, db: 15 },
		]
		// widths 4 and 9: 9 ≤ 2 · 4 + 1 joins at the bound; 10 stays apart
		expect(opened([two(9)]).ids.size).toBe(1)
		expect(opened([two(10)]).ids.size).toBe(2)
	})

	it("needs the peaks inside the reach, and no reach means no pairing", () => {
		// peaks 9 bins apart: reach 9 refuses (strictly closer), 10 joins
		expect(opened([pair(5)], reachBins(9)).ids.size).toBe(2)
		expect(opened([pair(5)], reachBins(10)).ids.size).toBe(1)
		expect(opened([pair(5)], reachBins(0)).ids.size).toBe(2)
		expect(opened([pair(5)], null).ids.size).toBe(2)
	})

	it("never pairs on the first block of an epoch (everything keys up then), nor on the next", () => {
		const t = tracker()
		const ids = new Set<string>()
		for (let i = 0; i < 4; i++)
			for (const e of runBlock(t, i, pair(5)))
				if (e.kind === "track-open") ids.add(e.track.trackId)
		expect(ids.size).toBe(2)
		// both tracks keep their own 4 kHz tone: neither grew over the pair
		for (const id of ids)
			expect(t.snapshotOf(id)!.obwHz).toBeLessThanOrEqual(4 * BIN_HZ)
	})

	it("a pair whose partial first block read 10 dB apart joins on the next block", () => {
		const { ids, t } = opened([pair(5, 20, 4, 10), pair(5), pair(5), pair(5)])
		expect(ids.size).toBe(2)
		// one of them carries both tones from the second block on; the other stopped after one
		const blocks = [...ids].map(id => t.snapshotOf(id)?.blocks ?? 0)
		expect(Math.max(...blocks)).toBe(4)
	})

	it("a new tone next to an established track does not join it", () => {
		const first = [pair(5)[0]!]
		// the first tone runs alone for three blocks, then a second carrier keys up
		const { ids } = opened([first, first, first, pair(5), pair(5)])
		expect(ids.size).toBe(2)
	})

	it("a gap block never pairs", () => {
		const t = tracker()
		runBlock(t, 0, [])
		const powerDb = new Float32Array(N).fill(FLOOR)
		for (let i = 200; i < 204; i++) powerDb[i] = FLOOR + 15
		for (let i = 209; i < 213; i++) powerDb[i] = FLOOR + 15
		const floorDb = new Float32Array(N).fill(FLOOR)
		const on = new Uint8Array(N).map((_, i) =>
			(powerDb[i] ?? 0) > -56 ? 1 : 0,
		)
		const segs = segment(on, powerDb, floorDb, {
			gapBins: 2,
			usableStartBin: 10,
			usableEndBin: N - 10,
			exclusionEdges: [],
			rasterBinEdges: [],
			skirtDb: 30,
			inWindow: true,
		})
		expect(segs).toHaveLength(2)
		const ev = t.block(segs, {
			endSample: 2 * BLOCK,
			powerDb,
			floorDb,
			blockFloorDb: FLOOR,
			thresholdDb: 4,
			gap: true,
			overload: false,
			pairReachBins: reachBins(REACH),
		})
		expect(ev.filter(e => e.kind === "track-open")).toHaveLength(0)
	})

	it("any co-onset pair of equal tones within the reach is one track", () => {
		// Feature: scanner-quality, Property 1: FSK pair fusion
		// Validates: one burst = one track (benchmark defects A, B)
		fc.assert(
			fc.property(
				fc.integer({ min: 3, max: 60 }),
				fc.integer({ min: 1, max: 8 }),
				fc.integer({ min: 8, max: 30 }),
				fc.integer({ min: 1, max: 6 }),
				(gap, width, db, blocks) =>
					opened(Array.from({ length: blocks }, () => pair(gap, db, width))).ids
						.size === 1,
			),
			{ numRuns: 100 },
		)
	})
})
