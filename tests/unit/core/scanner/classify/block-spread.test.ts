import { describe, expect, it } from "vitest"
import { segment } from "../../../../../src/core/spectrum/emissions/segmenter.js"
import type { Segment } from "../../../../../src/core/spectrum/emissions/segmenter.js"
import { Tracker } from "../../../../../src/core/spectrum/emissions/tracker.js"
import type {
	PipelineEvent,
	TrackSnapshot,
} from "../../../../../src/core/spectrum/types.js"

const N = 256
const BLOCK = 12_800
const FIRST_BIN = 140
const WIDTH = 8

function tracker(binHz = 1000, blockMs = 50): Tracker {
	const t = new Tracker({
		sourceId: "s1",
		binHz,
		blockMs,
		hangBlocks: 3,
		maxTracks: 4,
		maxTrackBlocks: 10_000,
		idPrefix: "t",
	})
	t.beginEpoch({
		stream: 1,
		epoch: 1,
		centreHz: 446_100_000,
		tuningTrust: "commanded",
	})
	return t
}

/** A block whose segment has one bin `topDb` above its other, equal bins; `null`: nothing on. */
function block(
	t: Tracker,
	index: number,
	topDb: number | null,
): TrackSnapshot | undefined {
	const powerDb = new Float32Array(N).fill(-60)
	const floorDb = new Float32Array(N).fill(-60)
	if (topDb !== null) {
		for (let i = FIRST_BIN; i < FIRST_BIN + WIDTH; i++) powerDb[i] = -30
		powerDb[FIRST_BIN + 3] = -30 + topDb
	}
	const on = new Uint8Array(N)
	for (let i = 0; i < N; i++) on[i] = powerDb[i]! > -56 ? 1 : 0
	const segs = segment(on, powerDb, floorDb, {
		gapBins: 2,
		usableStartBin: 26,
		usableEndBin: 231,
		exclusionEdges: [],
		rasterBinEdges: [],
		skirtDb: 30,
		inWindow: false,
	})
	let id: string | undefined
	for (const e of t.block(segs, {
		endSample: (index + 1) * BLOCK,
		powerDb,
		floorDb,
		blockFloorDb: -60,
		thresholdDb: 4,
		gap: false,
		overload: false,
	}))
		if (e.kind === "track-open") id = e.track.trackId
	return id === undefined ? undefined : t.snapshotOf(id)
}

/** Concentration of a block: its strongest bin over the segment's power, dB. */
function concentrationDb(topDb: number): number {
	const others = (WIDTH - 1) * 10 ** (-30 / 10)
	const top = 10 ** ((-30 + topDb) / 10)
	return -30 + topDb - 10 * Math.log10(others + top)
}

/** Feeds the blocks; returns the snapshot after the last one. */
function run(
	t: Tracker,
	tops: readonly (number | null)[],
): TrackSnapshot | undefined {
	let id = ""
	for (let i = 0; i < tops.length; i++) {
		const snap = block(t, i, tops[i]!)
		if (snap && id === "") id = snap.trackId
	}
	return t.snapshotOf(id)
}

describe("block concentration readings", () => {
	it("are the mean change and the spread of each block's concentration", () => {
		const low = 3
		const high = 13
		const a = concentrationDb(low)
		const b = concentrationDb(high)
		const snap = run(tracker(), [low, low, high, low])!
		const values = [a, a, b, a]
		const mean = values.reduce((x, y) => x + y, 0) / values.length
		const variance =
			values.reduce((x, y) => x + (y - mean) ** 2, 0) / values.length
		expect(snap.blocks).toBe(4)
		expect(snap.blockSwingDb).toBeCloseTo((0 + (b - a) + (b - a)) / 3, 3)
		expect(snap.blockSpreadDb).toBeCloseTo(Math.sqrt(variance), 3)
	})

	it("read zero on a signal that does not change", () => {
		const snap = run(tracker(), [6, 6, 6, 6, 6])!
		expect(snap.blockSwingDb).toBeCloseTo(0, 6)
		expect(snap.blockSpreadDb).toBeCloseTo(0, 6)
	})

	it("do not count a change across blocks the track was off", () => {
		const low = 3
		const high = 13
		const snap = run(tracker(), [low, low, null, high, high])!
		expect(snap.blocks).toBe(4)
		expect(snap.blockSwingDb).toBeCloseTo(0, 3)
		expect(snap.blockSpreadDb).toBeGreaterThan(0.5)
	})

	it("are absent on one block", () => {
		const snap = run(tracker(), [6])!
		expect(snap.blockSwingDb).toBeUndefined()
		expect(snap.blockSpreadDb).toBeUndefined()
	})

	it("need 35 FFT frames per block", () => {
		// 700 Hz x 50 ms = 35 frames; 680 Hz x 50 ms = 34.
		const at = run(tracker(700, 50), [6, 6, 6])!
		expect(at.blockSwingDb).toBeDefined()
		expect(at.blockSpreadDb).toBeDefined()
		const past = run(tracker(680, 50), [6, 6, 6])!
		expect(past.blockSwingDb).toBeUndefined()
		expect(past.blockSpreadDb).toBeUndefined()
	})
})

function piece(startBin: number, endBin: number): Segment {
	return {
		startBin,
		endBin,
		peakBin: startBin,
		peakDb: -30,
		centroidBin: (startBin + endBin - 1) / 2,
		flags: { truncated: false, skirt: false, edge: false },
	}
}

function lineMask(startBin: number, endBin: number): Uint8Array {
	const mask = new Uint8Array(N)
	mask.fill(1, startBin, endBin)
	return mask
}

/** One block of `pieces` at -30 dBFS on a -60 dBFS floor, plus `extra` bins: [bin, dBFS]. */
function lineBlock(
	t: Tracker,
	index: number,
	pieces: readonly Segment[],
	mask: Uint8Array | null,
	extra: readonly (readonly [number, number])[] = [],
): PipelineEvent[] {
	const powerDb = new Float32Array(N).fill(-60)
	const floorDb = new Float32Array(N).fill(-60)
	for (const s of pieces) powerDb.fill(-30, s.startBin, s.endBin)
	for (const [bin, db] of extra) powerDb[bin] = db
	if (mask !== null) t.flagSpurs(mask)
	return t.block([...pieces], {
		endSample: (index + 1) * BLOCK,
		powerDb,
		floorDb,
		blockFloorDb: -60,
		thresholdDb: 4,
		gap: false,
		overload: false,
	})
}

const openIds = (events: readonly PipelineEvent[]): string[] =>
	events.flatMap(e => (e.kind === "track-open" ? [e.track.trackId] : []))

describe("a segment across spur lines", () => {
	const lineBins: readonly (readonly [number, number])[] = [
		144, 145, 146, 147,
	].map(bin => [bin, -30] as const)

	it("joins the pieces a line cut, one track on the whole width", () => {
		const t = tracker()
		const lower = piece(140, 144)
		const upper = piece(148, 152)
		const ids = openIds(
			lineBlock(t, 0, [lower, upper], lineMask(143, 149), lineBins),
		)
		expect(ids).toHaveLength(1)
		const snap = t.snapshotOf(ids[0]!)!
		expect(snap.obwHz).toBe(12_000)
		expect(snap.centreHz).toBe(446_100_000 + (145.5 - N / 2) * 1000)
		// The pipeline asks for the pieces it passed in.
		expect(t.associationOf(lower)?.trackId).toBe(ids[0])
		expect(t.associationOf(upper)?.trackId).toBe(ids[0])
	})

	it("leaves two emitters apart when the line's bins are on the floor", () => {
		const t = tracker()
		const ids = openIds(
			lineBlock(t, 0, [piece(140, 144), piece(148, 152)], lineMask(143, 149)),
		)
		expect(ids).toHaveLength(2)
		for (const id of ids) expect(t.snapshotOf(id)!.obwHz).toBe(4000)
	})

	it("stops at the first bin under the threshold", () => {
		// Threshold 4 dB over a -60 dB floor. Bin 145 at -30 dBFS counts only if the walk gets there.
		const width = (firstLineBinDb: number): number => {
			const t = tracker()
			const ids = openIds(
				lineBlock(t, 0, [piece(140, 144)], lineMask(143, 149), [
					[144, firstLineBinDb],
					[145, -30],
				]),
			)
			return t.snapshotOf(ids[0]!)!.obwHz
		}
		expect(width(-56)).toBe(6000)
		expect(width(-56.5)).toBe(4000)
	})

	it("does not join across a hole that is no line", () => {
		const t = tracker()
		const ids = openIds(
			lineBlock(
				t,
				0,
				[piece(140, 144), piece(148, 152)],
				new Uint8Array(N),
				lineBins,
			),
		)
		expect(ids).toHaveLength(2)
	})

	it("walks at most 18 kHz from an edge", () => {
		const active = (from: number, to: number): [number, number][] => {
			const out: [number, number][] = []
			for (let bin = from; bin < to; bin++) out.push([bin, -30])
			return out
		}
		// 18 kHz at 1 kHz bins is 18 bins past the 4 of the segment.
		for (const [walked, width] of [
			[17, 21_000],
			[18, 22_000],
			[30, 22_000],
		] as const) {
			const t = tracker()
			const ids = openIds(
				lineBlock(
					t,
					0,
					[piece(100, 104)],
					lineMask(104, 150),
					active(104, 104 + walked),
				),
			)
			expect(t.snapshotOf(ids[0]!)!.obwHz).toBe(width)
		}
	})

	it("flags a track on a line as before", () => {
		const t = tracker()
		const ids = openIds(lineBlock(t, 0, [piece(140, 144)], null))
		const events = t.flagSpurs(lineMask(139, 145))
		expect(events).toHaveLength(1)
		expect(t.snapshotOf(ids[0]!)!.flags.spur).toBe(true)
	})
})

describe("block concentration readings on a line", () => {
	/**
	 * Thue-Morse: as many highs as lows over 40 blocks, in an order that never repeats, where a
	 * regular alternation reads as keying.
	 */
	const irregular = (i: number): boolean => {
		let odd = false
		for (let v = i; v > 0; v &= v - 1) odd = !odd
		return odd
	}

	/** Feeds `count` blocks of a piece beside a line, its top bin moving between `low`, `high` dB up. */
	function onLine(
		count: number,
		low: number,
		high: number,
		isHigh: (block: number) => boolean = irregular,
	): {
		t: Tracker
		id: string
		mask: Uint8Array
	} {
		const t = tracker()
		const mask = lineMask(148, 150)
		let id = ""
		for (let i = 0; i < count; i++) {
			const top = -30 + (isHigh(i) ? high : low)
			const ids = openIds(
				lineBlock(t, i, [piece(FIRST_BIN, FIRST_BIN + WIDTH)], mask, [
					[FIRST_BIN + 3, top],
				]),
			)
			if (ids[0] !== undefined) id = ids[0]
		}
		return { t, id, mask }
	}

	/** The high block's top (dB over the piece) whose spread with a 3 dB low block is `spreadDb`. */
	function highFor(spreadDb: number): number {
		let lo = 3
		let hi = 30
		for (let i = 0; i < 60; i++) {
			const mid = (lo + hi) / 2
			if ((concentrationDb(mid) - concentrationDb(3)) / 2 < spreadDb) lo = mid
			else hi = mid
		}
		return lo
	}

	it("wait for 40 blocks on one span", () => {
		const under = onLine(39, 3, 13)
		expect(under.t.snapshotOf(under.id)!.blockSpreadDb).toBeUndefined()
		expect(under.t.snapshotOf(under.id)!.blockSwingDb).toBeUndefined()
		const at = onLine(40, 3, 13)
		expect(at.t.snapshotOf(at.id)!.blockSpreadDb).toBeDefined()
		expect(at.t.snapshotOf(at.id)!.blockSwingDb).toBeDefined()
	})

	it("start over when the span widens", () => {
		const { t, id, mask } = onLine(40, 3, 13)
		lineBlock(t, 40, [piece(FIRST_BIN - 1, FIRST_BIN + WIDTH)], mask)
		expect(t.snapshotOf(id)!.blockSpreadDb).toBeUndefined()
	})

	it("need a spread of 0.65 dB", () => {
		const under = onLine(40, 3, highFor(0.649))
		expect(under.t.snapshotOf(under.id)!.blockSpreadDb).toBeUndefined()
		const over = onLine(40, 3, highFor(0.651))
		expect(over.t.snapshotOf(over.id)!.blockSpreadDb).toBeCloseTo(0.651, 3)
	})

	it("publish nothing while they repeat, as keying does", () => {
		const keyed = onLine(40, 3, 13, i => i % 4 < 2)
		expect(keyed.t.snapshotOf(keyed.id)!.blockSpreadDb).toBeUndefined()
		expect(keyed.t.snapshotOf(keyed.id)!.blockSwingDb).toBeUndefined()
	})

	it("read off a line as before at any age", () => {
		const t = tracker()
		const snap = run(t, [3, 13, 3])!
		expect(snap.blockSpreadDb).toBeDefined()
	})
})
