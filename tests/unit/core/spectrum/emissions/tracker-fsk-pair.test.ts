import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { segment } from "../../../../../src/core/spectrum/emissions/segmenter.js"
import {
	CLING_ABUT_BINS,
	CLING_MIDPOINT_FRACTION,
	CLING_WIDTH_RATIO,
	FSK_PAIR_DB,
	Tracker,
} from "../../../../../src/core/spectrum/emissions/tracker.js"
import type { Segment } from "../../../../../src/core/spectrum/emissions/segmenter.js"
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

function tracker(maxTrackBlocks = 1000): Tracker {
	const t = new Tracker({
		sourceId: "s1",
		binHz: BIN_HZ,
		blockMs: 50,
		hangBlocks: 3,
		maxTracks: 16,
		maxTrackBlocks,
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
	maxTrackBlocks = 1000,
): { ids: Set<string>; t: Tracker } {
	const t = tracker(maxTrackBlocks)
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

describe("tracker FSK pair fusion keeps other emitters apart", () => {
	const at = (t: Tracker, id: string): number =>
		(t.snapshotOf(id)!.centreHz - 433_100_000) / BIN_HZ + N / 2
	/** The narrowest track: the weak carrier (the pair's centroid also sits mid-span). */
	const narrowest = (t: Tracker, ids: Set<string>): string =>
		[...ids].sort((x, y) => t.snapshotOf(x)!.obwHz - t.snapshotOf(y)!.obwHz)[0]!

	it("a weak carrier keying up between the two tones keeps its own track", () => {
		const scene: Tone[] = [
			{ at: 200, width: 4, db: 25 },
			{ at: 220, width: 1, db: 8 },
			{ at: 240, width: 4, db: 25 },
		]
		const { ids, t } = opened(Array.from({ length: 4 }, () => scene))
		expect(ids.size).toBe(2)
		const weak = narrowest(t, ids)
		expect(Math.abs(at(t, weak) - 220.5)).toBeLessThanOrEqual(1)
		expect(t.snapshotOf(weak)!.blocks).toBe(4)
		expect(t.snapshotOf(weak)!.obwHz).toBeLessThanOrEqual(BIN_HZ)
	})

	it("a weak carrier appearing inside an established pair's span gets its own identity", () => {
		const two: Tone[] = [
			{ at: 200, width: 4, db: 20 },
			{ at: 260, width: 4, db: 20 },
		]
		const three: Tone[] = [...two, { at: 230, width: 1, db: 8 }]
		const { ids, t } = opened([two, two, two, three, three, three])
		expect(ids.size).toBe(2)
		const weak = narrowest(t, ids)
		expect(Math.abs(at(t, weak) - 230.5)).toBeLessThanOrEqual(1)
		expect(t.snapshotOf(weak)!.blocks).toBe(3)
	})

	it("the transition hump bridging a wide pair's valley joins it, from the first block on", () => {
		// a ±30 kHz sensor: 30-bin tones, a 12-bin hump 15 dB down, 4 bins of floor each side
		const sensor: Tone[] = [
			{ at: 200, width: 30, db: 30 },
			{ at: 234, width: 12, db: 15 },
			{ at: 250, width: 30, db: 30 },
		]
		const tones = [sensor[0]!, sensor[2]!]
		expect(opened(Array.from({ length: 4 }, () => sensor)).ids.size).toBe(1)
		// and inside an established pair
		expect(opened([tones, tones, sensor, sensor, sensor]).ids.size).toBe(1)
	})

	it("a narrow carrier between the tones joins only while it abuts one (CLING_ABUT_BINS)", () => {
		// 6-bin tones 30 bins apart, a weak 1-bin carrier `gap` bins of floor from the left one (off
		// the midpoint, so no transition hump)
		const scene = (gap: number): Tone[] => [
			{ at: 200, width: 6, db: 25 },
			{ at: 206 + gap, width: 1, db: 8 },
			{ at: 230, width: 6, db: 25 },
		]
		expect(CLING_ABUT_BINS).toBe(2)
		expect(opened(Array.from({ length: 3 }, () => scene(2))).ids.size).toBe(1)
		expect(opened(Array.from({ length: 3 }, () => scene(3))).ids.size).toBe(2)
		// 3 · 1 < 6 bins: a carrier tone widths narrower than the tones is never bridged past that
		expect(opened(Array.from({ length: 3 }, () => scene(5))).ids.size).toBe(2)
	})

	it("an independent narrow carrier 5 bins from a tone keeps its identity", () => {
		// tones [200, 206) and [260, 266) at 25 dB, a 1-bin carrier at bin 211 8 dB over the floor
		const scene: Tone[] = [
			{ at: 200, width: 6, db: 25 },
			{ at: 211, width: 1, db: 8 },
			{ at: 260, width: 6, db: 25 },
		]
		const { ids, t } = opened(Array.from({ length: 4 }, () => scene))
		expect(ids.size).toBe(2)
		const weak = narrowest(t, ids)
		expect(Math.abs(at(t, weak) - 211.5)).toBeLessThanOrEqual(1)
		expect(t.snapshotOf(weak)!.blocks).toBe(4)
	})

	it("a piece past the abut bound bridges while CLING_WIDTH_RATIO times its width reaches the tone's", () => {
		// 30-bin tones, a piece 15 dB down 4 bins of floor from the left one and 30 from the right
		// (no midpoint hump): 3 · 10 ≥ 30 joins, 3 · 9 does not
		const sensor = (w: number): Tone[] => [
			{ at: 200, width: 30, db: 30 },
			{ at: 234, width: w, db: 15 },
			{ at: 264 + w, width: 30, db: 30 },
		]
		expect(CLING_WIDTH_RATIO).toBe(3)
		expect(opened(Array.from({ length: 3 }, () => sensor(10))).ids.size).toBe(1)
		expect(opened(Array.from({ length: 3 }, () => sensor(9))).ids.size).toBe(2)
	})

	it("a weak crumb past an established pair's outer tone joins only inside that tone's last bins", () => {
		// span [200, 266) from a 12-bin right tone; then 6-bin tones and a 1-bin crumb 10 dB down
		const wide: Tone[] = [
			{ at: 200, width: 6, db: 25 },
			{ at: 254, width: 12, db: 25 },
		]
		const tail = (gap: number): Tone[] => [
			{ at: 200, width: 6, db: 25 },
			{ at: 254, width: 6, db: 25 },
			{ at: 260 + gap, width: 1, db: 15 },
		]
		// the right tone covered [254, 266) on the block before: a crumb at 265 is the emission's own
		expect(opened([wide, wide, tail(5)]).ids.size).toBe(1)
		expect(opened([wide, wide, tail(6)]).ids.size).toBe(2)
		// with 6-bin tones all along the same crumb is a carrier clear of the tone
		const narrow = tail(100).slice(0, 2)
		expect(opened([narrow, narrow, tail(2)]).ids.size).toBe(1)
		expect(opened([narrow, narrow, tail(3)]).ids.size).toBe(2)
	})

	it("a narrow transition hump joins within 1/CLING_MIDPOINT_FRACTION of the tone spacing of the midpoint", () => {
		// 24-bin tones [200, 224) and [248, 272): midpoint 236, spacing 48 bins, so ±6 bins
		const scene = (x: number): Tone[] => [
			{ at: 200, width: 24, db: 30 },
			{ at: x, width: 1, db: 15 },
			{ at: 248, width: 24, db: 30 },
		]
		expect(CLING_MIDPOINT_FRACTION).toBe(8)
		const blocks = (x: number): Tone[][] =>
			Array.from({ length: 3 }, () => scene(x))
		// bin 241 has its middle at 241.5, 5.5 bins over; 242 is 6.5 over
		expect(opened(blocks(241)).ids.size).toBe(1)
		expect(opened(blocks(242)).ids.size).toBe(2)
		expect(opened(blocks(230)).ids.size).toBe(1)
		expect(opened(blocks(229)).ids.size).toBe(2)
	})

	it("a carrier at the midpoint as strong as the tones is no transition hump", () => {
		const scene: Tone[] = [
			{ at: 200, width: 24, db: 30 },
			{ at: 236, width: 1, db: 30 },
			{ at: 248, width: 24, db: 30 },
		]
		expect(opened(Array.from({ length: 3 }, () => scene)).ids.size).toBe(2)
	})

	it("abutting chirp pieces stay one track when one block shows a piece 8 dB over the rest", () => {
		const pieces = (loud: number): Tone[] =>
			[200, 213, 226, 239].map(at => ({
				at,
				width: 10,
				db: at === loud ? 28 : 20,
			}))
		expect(
			opened([pieces(0), pieces(0), pieces(226), pieces(0)]).ids.size,
		).toBe(1)
	})

	it("a weak carrier inside a paired span keeps its identity while the pair is silent", () => {
		const two: Tone[] = [
			{ at: 200, width: 4, db: 20 },
			{ at: 260, width: 4, db: 20 },
		]
		const weak: Tone = { at: 230, width: 1, db: 8 }
		const { ids, t } = opened([two, two, [...two, weak], [weak], [weak]])
		expect(ids.size).toBe(2)
		expect(t.snapshotOf(narrowest(t, ids))!.blocks).toBe(3)
	})

	it("a pair that sends one tone per block keeps one identity", () => {
		const left: Tone = { at: 200, width: 4, db: 20 }
		const right: Tone = { at: 260, width: 4, db: 20 }
		const { ids } = opened([
			[left, right],
			[left],
			[right],
			[left],
			[right],
			[left, right],
			[right],
		])
		expect(ids.size).toBe(1)
	})

	it("a stronger narrow carrier inside an established pair does not take its identity", () => {
		const two: Tone[] = [
			{ at: 200, width: 4, db: 20 },
			{ at: 260, width: 4, db: 20 },
		]
		const three: Tone[] = [...two, { at: 230, width: 1, db: 25 }]
		const { ids, t } = opened([two, two, two, three, three, three])
		expect(ids.size).toBe(2)
		const carrier = narrowest(t, ids)
		expect(Math.abs(at(t, carrier) - 230.5)).toBeLessThanOrEqual(1)
		expect(t.snapshotOf(carrier)!.blocks).toBe(3)
		const pairId = [...ids].find(id => id !== carrier)!
		expect(t.snapshotOf(pairId)!.blocks).toBe(6)
	})

	it("a stronger narrow carrier in a tone's previous footprint does not take the pair's identity", () => {
		// span [200, 266) from a 12-bin right tone; then the right tone narrows to 6 bins and a
		// 1-bin carrier 10 dB over the tones keys up at 265, inside the bins that tone covered
		const wide: Tone[] = [
			{ at: 200, width: 6, db: 25 },
			{ at: 254, width: 12, db: 25 },
		]
		const withCarrier: Tone[] = [
			{ at: 200, width: 6, db: 25 },
			{ at: 254, width: 6, db: 25 },
			{ at: 265, width: 1, db: 35 },
		]
		const { ids, t } = opened([wide, wide, withCarrier, withCarrier])
		// the pair and the carrier: 2 tracks, not 3 (the tones reopening beside a stolen pair id)
		expect(ids.size).toBe(2)
		const carrier = narrowest(t, ids)
		expect(Math.abs(at(t, carrier) - 265.5)).toBeLessThanOrEqual(1)
		const pairId = [...ids].find(id => id !== carrier)!
		expect(t.snapshotOf(pairId)!.blocks).toBe(4)
		// a weaker crumb at the same place is still the emission's own (one track)
		const crumb: Tone[] = [
			{ at: 200, width: 6, db: 25 },
			{ at: 254, width: 6, db: 25 },
			{ at: 265, width: 1, db: 15 },
		]
		expect(opened([wide, wide, crumb, crumb]).ids.size).toBe(1)
	})

	it("a pair sending one tone per block keeps its span and partners across a max-duration rollover", () => {
		const left: Tone = { at: 200, width: 4, db: 20 }
		const right: Tone = { at: 260, width: 4, db: 20 }
		// maxTrackBlocks 3: the second left-only block rolls the track over on a left-tone segment
		const blocks: Tone[][] = [
			[],
			[left, right],
			[left],
			[left],
			[right],
			[left],
			[right],
		]
		const t = tracker(3)
		let opens = 0
		let rollovers = 0
		blocks.forEach((tones, i) => {
			for (const e of runBlock(t, i, tones)) {
				if (e.kind === "track-open") opens++
				if (e.kind === "track-close") {
					// only max-duration closes: no tone track ever opened alone and went quiet
					expect(e.endReason).toBe("max-duration")
					rollovers++
				}
			}
		})
		// one opening, every other open is a max-duration successor
		expect(opens).toBe(1 + rollovers)
		expect(rollovers).toBeGreaterThanOrEqual(2)
		expect(t.openCount).toBe(1)
	})
})

describe("tracker FSK pair fusion storage", () => {
	it("a steady pair reuses its fused segments block to block (docs/PERFORMANCE.md rule 4)", () => {
		const t = tracker()
		const out = (t as unknown as { fuseOut: Segment[] }).fuseOut
		const seen = new Set<Segment>()
		const flags = new Set<Segment["flags"]>()
		runBlock(t, 0, [])
		for (let i = 1; i <= 50; i++) {
			runBlock(t, i, pair(5))
			if (i < 3) continue
			// the input segments are the segmenter's; the fused one is the tracker's own
			const fused = out.find(s => s.endBin - s.startBin > 4)!
			seen.add(fused)
			flags.add(fused.flags)
		}
		// one fused segment held by the track, one being written: two objects rotate
		expect(seen.size).toBeLessThanOrEqual(2)
		expect(flags.size).toBeLessThanOrEqual(2)
		expect(t.openCount).toBe(1)
	})
})
