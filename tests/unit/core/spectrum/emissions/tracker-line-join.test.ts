import { describe, expect, it } from "vitest"
import { classOf } from "../../../../../src/core/scanner/classify/classifier.js"
import type { Segment } from "../../../../../src/core/spectrum/emissions/segmenter.js"
import {
	LINE_PART_BLOCKS,
	LINE_SIDEBAND_DB,
	LINE_SMOOTH_HZ,
	Tracker,
} from "../../../../../src/core/spectrum/emissions/tracker.js"
import {
	DIP_SMOOTH_HZ,
	SIDEBAND_DB,
} from "../../../../../src/core/spectrum/pipeline.js"
import type { TrackSnapshot } from "../../../../../src/core/spectrum/types.js"

// A learned spur line over 1 kHz bins, driven block by block: the mask, the block's powers and the
// segments the detector left beside the line. Synthetic blocks only.

const N = 512
const BIN_HZ = 1000
const BLOCK = 25_600
const FLOOR = -60
const THRESHOLD = 4
/** The walk's 18 kHz at 1 kHz bins. */
const REACH_BINS = 18

type Span = readonly [start: number, end: number, db: number]

function seg(start: number, end: number, powerDb: Float32Array): Segment {
	let peakBin = start
	for (let i = start; i < end; i++)
		if (powerDb[i]! > powerDb[peakBin]!) peakBin = i
	return {
		startBin: start,
		endBin: end,
		peakBin,
		peakDb: powerDb[peakBin]!,
		centroidBin: (start + end - 1) / 2,
		flags: { truncated: false, skirt: false, edge: false },
	}
}

function tracker(maxTrackBlocks = 1000, hangBlocks = 3): Tracker {
	const t = new Tracker({
		sourceId: "s1",
		binHz: BIN_HZ,
		blockMs: 50,
		hangBlocks,
		maxTracks: 16,
		maxTrackBlocks,
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

interface Scene {
	/** Spans at a level, the rest at the floor. */
	readonly power: readonly Span[]
	/** The detector's segments: what the mask left on. */
	readonly segments: readonly (readonly [number, number])[]
	/** Masked bins [start, end). */
	readonly mask?: readonly (readonly [number, number])[]
	readonly reach?: number
	readonly blocks?: number
	/** Blocks already run on this tracker. */
	readonly from?: number
}

/** The last snapshot of each track the scene opens. */
function run(scene: Scene, t = tracker()): TrackSnapshot[] {
	const powerDb = new Float32Array(N).fill(FLOOR)
	const floorDb = new Float32Array(N).fill(FLOOR)
	for (const [a, b, db] of scene.power) powerDb.fill(db, a, b)
	const mask = new Uint8Array(N)
	for (const [a, b] of scene.mask ?? []) mask.fill(1, a, b)
	const last = new Map<string, TrackSnapshot>()
	const reach =
		scene.reach === undefined
			? {}
			: { pairReachBins: new Uint16Array(N).fill(scene.reach) }
	for (let k = 0; k < (scene.blocks ?? 40); k++) {
		t.flagSpurs(mask)
		const events = t.block(
			scene.segments.map(([a, b]) => seg(a, b, powerDb)),
			{
				endSample: ((scene.from ?? 0) + k + 1) * BLOCK,
				powerDb,
				floorDb,
				blockFloorDb: FLOOR,
				thresholdDb: THRESHOLD,
				gap: false,
				overload: false,
				...reach,
			},
		)
		for (const e of events)
			if (
				e.kind === "track-open" ||
				e.kind === "track-update" ||
				e.kind === "track-close"
			)
				last.set(e.track.trackId, e.track)
	}
	return [...last.values()]
}

/** Two pieces at `db`, `[144, 148)` masked and at `holeDb`. */
const piecesAround = (db: number, holeDb: number, reach?: number): Scene => ({
	power: [
		[140, 144, db],
		[144, 148, holeDb],
		[148, 152, db],
	],
	segments: [
		[140, 144],
		[148, 152],
	],
	mask: [[144, 148]],
	...(reach === undefined ? {} : { reach }),
})

describe("pieces joined across a spur line", () => {
	it("states the segmenter's own numbers", () => {
		expect(LINE_SIDEBAND_DB).toBe(SIDEBAND_DB)
		expect(LINE_SMOOTH_HZ).toBe(DIP_SMOOTH_HZ)
	})

	it("two emitters with a deep valley on the line stay two, as without the mask", () => {
		const unmasked = run({
			power: [
				[140, 144, -30],
				[144, 148, -50],
				[148, 152, -30],
			],
			segments: [
				[140, 144],
				[148, 152],
			],
		})
		const masked = run(piecesAround(-30, -50))
		expect(unmasked.map(t => classOf(t))).toEqual(["fsk4-6k25", "fsk4-6k25"])
		expect(masked.map(t => classOf(t))).toEqual(unmasked.map(t => classOf(t)))
		expect(masked.map(t => t.obwHz)).toEqual(unmasked.map(t => t.obwHz))
		expect(masked.map(t => t.centreHz)).toEqual(unmasked.map(t => t.centreHz))
	})

	it("a valley at half the height parts them; just over it joins them", () => {
		// 30 dB over the floor: half is -45.
		expect(run(piecesAround(-30, -45))).toHaveLength(2)
		expect(run(piecesAround(-30, -44.9))).toHaveLength(1)
	})

	it("a valley under the dip depth joins them; at it parts them", () => {
		// 10 dB over the floor, so half the height is -55 and the 6 dB dip decides at -56.
		expect(run(piecesAround(-50, -56))).toHaveLength(2)
		expect(run(piecesAround(-50, -55.9))).toHaveLength(1)
		// 8 dB over the floor: half is -56 and a valley under the 6 dB dip is under -58.
		expect(run(piecesAround(-52, -56))).toHaveLength(1)
	})

	it("one scattered bin in the hole fakes no valley", () => {
		const tracks = run({
			...piecesAround(-30, -33),
			power: [
				[140, 144, -30],
				[144, 148, -33],
				[146, 147, -55],
				[148, 152, -30],
			],
		})
		expect(tracks).toHaveLength(1)
	})

	it("power on the line between two pieces joins them across its whole width", () => {
		const [t, ...rest] = run(piecesAround(-30, -33))
		expect(rest).toEqual([])
		expect(t!.obwHz).toBe(12_000)
	})

	it("a voice's carrier on the line joins the skirts on both sides", () => {
		expect(run(piecesAround(-40, -15))).toHaveLength(1)
	})

	it("a piece over the sideband margin stays with the stronger one whatever the valley", () => {
		const power: Span[] = [
			[140, 144, -30],
			[144, 148, -55],
			[148, 152, -30 - SIDEBAND_DB - 0.1],
		]
		const scene = {
			power,
			segments: [
				[140, 144],
				[148, 152],
			] as const,
			mask: [[144, 148]] as const,
		}
		expect(run(scene)).toHaveLength(1)
		// At the margin it is its own emitter: the valley decides.
		power[2] = [148, 152, -30 - SIDEBAND_DB]
		expect(run({ ...scene, power })).toHaveLength(2)
	})

	it("peaks a channel apart stay two without a valley; closer ones join", () => {
		// The peak bins are the pieces' first: 148 - 140 = 8 bins apart.
		expect(run(piecesAround(-30, -33, 8))).toHaveLength(2)
		expect(run(piecesAround(-30, -33, 9))).toHaveLength(1)
		// No channel plan (reach 0 or absent) sets no limit.
		expect(run(piecesAround(-30, -33, 0))).toHaveLength(1)
		expect(run(piecesAround(-30, -33))).toHaveLength(1)
	})

	it("peaks inside one channel are one emitter whatever the valley, as the segmenter says", () => {
		expect(run(piecesAround(-30, -50, 9))).toHaveLength(1)
		// A burst range's pair reach is no channel: within the walk's 18 bins it joins, past them the
		// valley decides.
		expect(run(piecesAround(-30, -50, 100))).toHaveLength(1)
		const far = (gap: number, holeDb: number): Scene => ({
			power: [
				[100, 104, -30],
				[104, 104 + gap, holeDb],
				[104 + gap, 108 + gap, -30],
			],
			segments: [
				[100, 104],
				[104 + gap, 108 + gap],
			],
			mask: [[104, 104 + gap]],
			reach: 100,
		})
		// Peak bins 100 and 104 + gap: 18 bins apart at a hole of 14, 19 at 15.
		expect(run(far(14, -50))).toHaveLength(1)
		expect(run(far(15, -50))).toHaveLength(2)
		expect(run(far(15, -33))).toHaveLength(1)
	})

	it("a hole of the walk's whole reach joins; one bin past it does not", () => {
		const scene = (hole: number): Scene => ({
			power: [
				[100, 104, -30],
				[104, 104 + hole, -33],
				[104 + hole, 108 + hole, -30],
			],
			segments: [
				[100, 104],
				[104 + hole, 108 + hole],
			],
			mask: [[104, 104 + hole]],
		})
		expect(REACH_BINS).toBe(18)
		expect(run(scene(REACH_BINS))).toHaveLength(1)
		expect(run(scene(REACH_BINS + 1))).toHaveLength(2)
	})

	it("a hole with a bin under the threshold joins nothing", () => {
		const tracks = run({
			...piecesAround(-30, -33),
			power: [
				[140, 144, -30],
				[144, 146, -33],
				[146, 147, FLOOR + THRESHOLD - 0.1],
				[147, 148, -33],
				[148, 152, -30],
			],
		})
		expect(tracks).toHaveLength(2)
	})

	it("unknown power in the hole is no evidence", () => {
		for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY]) {
			const tracks = run({
				...piecesAround(-30, -33),
				power: [
					[140, 144, -30],
					[144, 146, -33],
					[146, 147, bad],
					[147, 148, -33],
					[148, 152, -30],
				],
			})
			expect(tracks).toHaveLength(2)
		}
	})

	it("a segment that meets no line stays as it came", () => {
		const [t, ...rest] = run({
			power: [
				[140, 144, -30],
				[144, 148, -33],
				[148, 152, -30],
			],
			segments: [
				[140, 144],
				[148, 152],
			],
			mask: [[300, 304]],
		})
		expect(rest).toHaveLength(1)
		expect(t!.obwHz).toBe(4000)
	})
})

describe("a piece on one side of a spur line", () => {
	const alone = (lineDb: number): Scene => ({
		power: [
			[140, 144, -30],
			[144, 147, lineDb],
		],
		segments: [[140, 144]],
		mask: [[144, 147]],
	})

	const plain = run({ power: [[140, 144, -30]], segments: [[140, 144]] })[0]!

	it("takes nothing from a real spur far stronger than it", () => {
		const [t, ...rest] = run(alone(-10))
		expect(rest).toEqual([])
		expect(classOf(t!)).toBe("fsk4-6k25")
		expect(t!.obwHz).toBe(plain.obwHz)
		expect(t!.centreHz).toBe(plain.centreHz)
	})

	it.each([
		["far stronger", -10],
		["as strong", -30],
		["weaker", -40],
	])(
		"takes nothing from a spur %s than it that was on the line before it",
		(_name, lineDb) => {
			const [t, ...rest] = afterIdle(lineDb, lineDb)
			expect(rest).toEqual([])
			expect(classOf(t!)).toBe("fsk4-6k25")
			expect(t!.obwHz).toBe(plain.obwHz)
			expect(t!.centreHz).toBe(plain.centreHz)
		},
	)

	/** `idleDb` on the line alone for 40 blocks, then the piece beside it at `lineDb`. */
	function afterIdle(idleDb: number, lineDb: number): TrackSnapshot[] {
		const t = tracker()
		const mask = [[144, 147]] as const
		run({ power: [[144, 147, idleDb]], segments: [], mask }, t)
		return run({ ...alone(lineDb), from: 40 }, t)
	}

	it("takes a line whose power came up with the signal", () => {
		// The carrier of a voice: the line was at the floor until it keyed up.
		const [t, ...rest] = afterIdle(FLOOR, -10)
		expect(rest).toEqual([])
		expect(t!.obwHz).toBeLessThanOrEqual(7000)
		const open = run(alone(-10))[0]!
		expect(t!.centreHz).toBeCloseTo(open.centreHz, -1)
		expect(t!.spectralShape).not.toBe("flat")
	})

	it("the gain's bound is 6 dB over the idle level", () => {
		const shape = (lineDb: number) =>
			afterIdle(-30, lineDb)[0]!.spectralShape !== "flat" ||
			afterIdle(-30, lineDb)[0]!.obwHz !== plain.obwHz
		expect(shape(-30 + 5.9)).toBe(false)
		expect(shape(-30 + 6)).toBe(true)
	})

	it("a line's idle level rises 1 dB per second it is idle", () => {
		const t = (idleBlocks: number) => {
			const u = tracker()
			const mask = [[144, 147]] as const
			run({ power: [[144, 147, -30]], segments: [], mask, blocks: 1 }, u)
			run(
				{
					power: [[144, 147, -20]],
					segments: [],
					mask,
					blocks: idleBlocks,
					from: 1,
				},
				u,
			)
			return run({ ...alone(-20), from: 1 + idleBlocks }, u)[0]!.obwHz
		}
		// 0.05 dB per block: 1 s leaves the line 9 dB over its idle level, 10 s leaves it level.
		expect(t(20)).not.toBe(plain.obwHz)
		expect(t(200)).toBe(plain.obwHz)
	})

	describe("after a minute of a bare carrier on the line", () => {
		/**
		 * A carrier held on a line with nothing beside it is what a spur looks like: the line's idle
		 * level rises to it (1 dB per second, so 60 s teaches a line 50 dB over the floor). One piece on
		 * one side is then no evidence that the line belongs to it, and it keeps its own width: staying
		 * 4 kHz is right, not the idle level going wrong. Pieces on both sides are evidence the idle
		 * level has no part in, so the speech a repeater carries after a long hold keeps its width.
		 */
		const held = (scene: Omit<Scene, "mask">): TrackSnapshot[] => {
			const t = tracker()
			const mask = [[144, 147]] as const
			run({ power: [[144, 147, -10]], segments: [], mask, blocks: 1200 }, t)
			return run({ ...scene, mask, from: 1200 }, t)
		}

		it("one piece on one side stays out of the line", () => {
			const [t, ...rest] = held({
				power: [
					[140, 144, -30],
					[144, 147, -10],
				],
				segments: [[140, 144]],
			})
			expect(rest).toEqual([])
			expect(t!.obwHz).toBe(plain.obwHz)
			expect(t!.obwHz).toBe(4000)
		})

		it("pieces on both sides join across it, whatever it held", () => {
			const [t, ...rest] = held({
				power: [
					[140, 144, -30],
					[144, 147, -10],
					[147, 151, -30],
				],
				segments: [
					[140, 144],
					[147, 151],
				],
			})
			// Two tracks without the join: the pieces are 7 bins apart, past a piece's match tolerance.
			expect(rest).toEqual([])
			expect(t!.spectralShape).not.toBe("flat")
		})
	})

	it("a line never seen idle joins only at most 10 dB over the piece", () => {
		// Level with its piece, as a signal's flat top reads, the line is taken in.
		expect(run(alone(-30))[0]!.obwHz).toBe(7000)
		expect(run(alone(-20))[0]!.startSample).toBe(0)
		const width = (lineDb: number) => run(alone(lineDb))[0]!.spectralShape
		expect(width(-20)).not.toBe("flat")
		// Past it the power is not the piece's: the piece stays as it is.
		expect(run(alone(-19.9))[0]!.obwHz).toBe(plain.obwHz)
		expect(classOf(run(alone(-19.9))[0]!)).toBe("fsk4-6k25")
	})

	it("an epoch's start forgets what the line held", () => {
		const t = tracker()
		run({ power: [[144, 147, FLOOR]], segments: [], mask: [[144, 147]] }, t)
		t.beginEpoch({
			stream: 1,
			epoch: 2,
			centreHz: 446_200_000,
			tuningTrust: "commanded",
		})
		const [u] = run({ ...alone(-10), from: 40 }, t)
		expect(u!.obwHz).toBe(plain.obwHz)
	})

	it("is measured the same on the far side of the line", () => {
		const [t] = run({
			power: [
				[144, 147, -10],
				[147, 151, -30],
			],
			segments: [[147, 151]],
			mask: [[144, 147]],
		})
		expect(classOf(t!)).toBe("fsk4-6k25")
		expect(t!.obwHz).toBe(4000)
		expect(t!.centreHz).toBe(plain.centreHz + 7000)
	})

	it("a spur between two pieces does not pull the joined centre", () => {
		// Symmetric pieces: their centre is the middle whatever the line holds.
		const [t] = run({
			power: [
				[140, 144, -30],
				[144, 147, -10],
				[147, 151, -30],
			],
			segments: [
				[140, 144],
				[147, 151],
			],
			mask: [[144, 147]],
		})
		expect(t!.centreHz).toBeCloseTo(plain.centreHz + 3500, -1)
	})
})

describe("line joins on the hot path", () => {
	it("a steady join rotates scratch segments, block to block", () => {
		const t = tracker()
		const open = t as unknown as { open: { lastSeg: Segment }[] }
		const seen = new Set<Segment>()
		for (let k = 0; k < 30; k++) {
			run({ ...piecesAround(-30, -33), blocks: 1, from: k }, t)
			seen.add(open.open[0]!.lastSeg)
		}
		expect(open.open).toHaveLength(1)
		expect(seen.size).toBeLessThanOrEqual(2)
	})

	it("each piece the pipeline passed maps to the joined track, also as segments change", () => {
		const t = tracker()
		const powerDb = new Float32Array(N).fill(FLOOR)
		powerDb.fill(-30, 140, 144)
		powerDb.fill(-33, 144, 148)
		powerDb.fill(-30, 148, 152)
		const floorDb = new Float32Array(N).fill(FLOOR)
		const mask = new Uint8Array(N).fill(1, 144, 148)
		const block = (k: number) => ({
			endSample: (k + 1) * BLOCK,
			powerDb,
			floorDb,
			blockFloorDb: FLOOR,
			thresholdDb: THRESHOLD,
			gap: false,
			overload: false,
		})
		t.flagSpurs(mask)
		const a = seg(140, 144, powerDb)
		const b = seg(148, 152, powerDb)
		t.block([a, b], block(0))
		const joined = t.associationOf(a)
		expect(joined).not.toBeNull()
		expect(t.associationOf(b)?.trackId).toBe(joined?.trackId)
		// The next block has no join to report: no piece of the last one is known any more.
		t.flagSpurs(mask)
		const c = seg(140, 144, powerDb)
		t.block([c], block(1))
		expect(t.associationOf(a)).toBeNull()
		expect(t.associationOf(c)?.trackId).toBe(joined?.trackId)
	})

	it("a block without a channel plan keeps no pair reach from the join before it", () => {
		const t = tracker()
		run({ ...piecesAround(-30, -33, 100), blocks: 3 }, t)
		// Two new tones of one level pair under a reach, and there is none now.
		const after = run(
			{
				...piecesAround(-30, -33),
				power: [
					...piecesAround(-30, -33).power,
					[200, 204, -30],
					[220, 224, -30],
				],
				segments: [...piecesAround(-30, -33).segments, [200, 204], [220, 224]],
				blocks: 3,
				from: 3,
			},
			t,
		)
		expect(after.filter(x => x.obwHz === 4000)).toHaveLength(2)
	})
})

describe("a join across a line stays with its track", () => {
	/**
	 * Two pieces with their hole on a line, under a channel limit of 8 bins. Each letter is a block:
	 * T has the peaks 5 bins apart, so the block's evidence allows the join, R has them 11 apart, so
	 * it refuses. Hole level the same, so only the peaks speak.
	 */
	const pieces = (allow: boolean): Scene => ({
		power: [
			[140, 144, -35],
			[144, 148, -36],
			[148, 152, -35],
			allow ? [143, 144, -30] : [140, 141, -30],
			allow ? [148, 149, -30] : [151, 152, -30],
		],
		segments: [
			[140, 144],
			[148, 152],
		],
		mask: [[144, 148]],
		reach: 8,
	})

	interface OpenView {
		id: string
		onMin: number
		onMax: number
		startBin: number
		endBin: number
	}
	const openOf = (t: Tracker) =>
		(t as unknown as { open: readonly OpenView[] }).open

	/** Runs the blocks of `script`; every track id it saw, and the block count after it. */
	function play(
		script: string,
		t: Tracker,
		from = 0,
		ids = new Set<string>(),
	): { ids: Set<string>; from: number } {
		let k = from
		for (const c of script) {
			const scene = pieces(c === "T")
			for (const s of run({ ...scene, blocks: 1, from: k }, t))
				ids.add(s.trackId)
			k++
		}
		return { ids, from: k }
	}

	it("the bound is 4 blocks, and those are 200 ms at 50 ms blocks", () => {
		expect(LINE_PART_BLOCKS).toBe(4)
	})

	it("a first join takes its first block", () => {
		const t = tracker()
		const { ids } = play("T", t)
		expect(ids.size).toBe(1)
		const [o] = openOf(t)
		expect([o!.onMin, o!.onMax]).toEqual([140, 152])
	})

	it("a held join stands 3 refused blocks and gives way on the 4th", () => {
		const t = tracker()
		const a = play("TRRR", t)
		expect(a.ids.size).toBe(1)
		expect(openOf(t)).toHaveLength(1)
		play("R", t, a.from, a.ids)
		expect(a.ids.size).toBe(2)
		expect(openOf(t)).toHaveLength(2)
	})

	it("a block that allows it restarts the count", () => {
		const t = tracker()
		const { ids } = play("TRRRTRRRTRRRT", t)
		expect(ids.size).toBe(1)
		expect(openOf(t)).toHaveLength(1)
	})

	it("the track that gave up a join goes on as its own piece", () => {
		const t = tracker()
		const a = play("TTTTTTTTTTRRRR", t)
		const [kept] = openOf(t)
		expect([kept!.onMin, kept!.onMax]).toEqual([140, 144])
		// Forty blocks on: nothing of the ten joined blocks is left in its width or centre.
		const last = new Map<string, TrackSnapshot>()
		for (let k = 0; k < 40; k++)
			for (const s of run({ ...pieces(false), blocks: 1, from: a.from + k }, t))
				last.set(s.trackId, s)
		const [one, two] = [...last.values()]
		expect(one!.obwHz).toBe(4000)
		expect(two!.obwHz).toBe(4000)
		expect(Math.abs(two!.centreHz - one!.centreHz)).toBeCloseTo(8000, -3)
	})

	it("two tracks that parted stay two however long the join is allowed", () => {
		const t = tracker()
		const a = play("TRRRR", t)
		const after = play("T".repeat(60), t, a.from, a.ids)
		expect(after.ids.size).toBe(2)
		expect(openOf(t)).toHaveLength(2)
	})

	it("once the other track has closed a piece joins again at once", () => {
		const t = tracker()
		const { from } = play("TRRRR", t)
		const powerOnly = { ...pieces(true), segments: [[140, 144]] as const }
		// The 3 blocks of hang, with one piece.
		run({ ...powerOnly, blocks: 3, from }, t)
		expect(openOf(t)).toHaveLength(1)
		play("T", t, from + 3)
		expect(openOf(t)).toHaveLength(1)
		expect(openOf(t)[0]!.onMax).toBe(152)
	})

	it("tracks under 4 blocks old come together: one refusal is no decision", () => {
		const t = tracker()
		const { from } = play("RRR", t)
		expect(openOf(t)).toHaveLength(2)
		play("T", t, from)
		const on = openOf(t).filter(o => o.onMax === 152 && o.onMin === 140)
		expect(on).toHaveLength(1)
		// The other has lost its piece: it closes after its hang, and only the join is left.
		play("TTT", t, from + 1)
		expect(openOf(t)).toHaveLength(1)
	})

	it("tracks 4 blocks old keep to themselves", () => {
		const t = tracker()
		const { from } = play("RRRR", t)
		play("TTTT", t, from)
		expect(openOf(t).map(o => [o.onMin, o.onMax])).toEqual([
			[140, 144],
			[148, 152],
		])
	})

	it("a track that parted takes neither its neighbour's bins nor the line in its hang", () => {
		const t = tracker()
		const { from } = play("TRRRRR", t)
		// The upper piece missed this block; its power is still over the threshold across the line.
		run({ ...pieces(true), segments: [[140, 144]], blocks: 1, from }, t)
		expect(openOf(t)[0]!.onMax).toBe(144)
	})

	it("a join and a parting both outlast a track's rollover", () => {
		const held = tracker(10)
		const a = play("T".repeat(10), held)
		expect(openOf(held)).toHaveLength(1)
		play("RRR", held, a.from)
		expect(openOf(held)).toHaveLength(1)

		const parted = tracker(10)
		const b = play("TRRRR", parted)
		play("T".repeat(10), parted, b.from)
		expect(openOf(parted)).toHaveLength(2)
	})

	it("a rollover keeps the run of refusals: the 4th still parts", () => {
		const t = tracker(10)
		// The rollover comes on the 10th block, the 3rd refusal.
		const { from } = play("TTTTTTTRRR", t)
		expect(openOf(t)).toHaveLength(1)
		play("R", t, from)
		expect(openOf(t).map(o => [o.onMin, o.onMax])).toEqual([
			[140, 144],
			[148, 152],
		])
	})

	it("a lone refusal does not split a join whose other track is in its hang", () => {
		const t = tracker()
		const { ids } = play("RRRTRT", t)
		// The two young tracks, and neither piece opened another.
		expect(ids.size).toBe(2)
		expect(openOf(t).map(o => [o.onMin, o.onMax])).toEqual([[140, 152]])
	})

	it("a track in its hang neither revives on a refusal nor shortens the count", () => {
		const t = tracker(1000, 10)
		const a = play("RRRTRRR", t)
		expect(a.ids.size).toBe(2)
		const [holder, hanging] = openOf(t)
		expect([holder!.onMin, holder!.onMax]).toEqual([140, 152])
		expect([hanging!.onMin, hanging!.onMax]).toEqual([148, 152])
		// The 4th refusal parts them, and the piece goes back to the track that hung on it.
		play("R", t, a.from, a.ids)
		expect(a.ids.size).toBe(2)
		expect(openOf(t).map(o => [o.onMin, o.onMax])).toEqual([
			[140, 144],
			[148, 152],
		])
		// A decision: they stay two.
		play("TTTT", t, a.from + 1, a.ids)
		expect(openOf(t)).toHaveLength(2)
	})

	it("a held join stands a refusal when its track last saw only the weaker piece", () => {
		const t = tracker()
		play("T", t)
		// The upper piece fades for a block, with the hole under the threshold.
		const lower: Scene = {
			power: [
				[140, 144, -35],
				[143, 144, -30],
			],
			segments: [[140, 144]],
			mask: [[144, 148]],
			reach: 8,
		}
		run({ ...lower, blocks: 1, from: 1 }, t)
		// It comes back the stronger, and the block's peaks refuse the join.
		const refused = pieces(false)
		run(
			{
				...refused,
				power: [...refused.power, [151, 152, -29]],
				blocks: 1,
				from: 2,
			},
			t,
		)
		expect(openOf(t).map(o => [o.onMin, o.onMax])).toEqual([[140, 152]])
	})

	describe("the piece a parted track goes on as", () => {
		const onItsOwn: Scene = {
			power: [[140, 144, -35]],
			segments: [[140, 144]],
			mask: [[144, 148]],
			reach: 8,
		}
		/** T or R as `pieces`, with the upper piece a neighbour 6 dB over the lower one. */
		const beside = (allow: boolean): Scene => {
			const s = pieces(allow)
			return {
				...s,
				power: [
					...s.power,
					[148, 152, -29],
					...(allow
						? ([[148, 149, -24]] as const)
						: ([[151, 152, -24]] as const)),
				],
			}
		}
		function playBeside(script: string, t: Tracker, from: number): number {
			let k = from
			for (const c of script)
				run({ ...beside(c === "T"), blocks: 1, from: k++ }, t)
			return k
		}

		it("a stronger neighbour joined late: the track keeps its own span, the neighbour opens", () => {
			const t = tracker()
			run({ ...onItsOwn, blocks: 20 }, t)
			const [own] = openOf(t)
			const k = playBeside("TTTRRR", t, 20)
			expect(openOf(t)).toHaveLength(1)
			playBeside("R", t, k)
			const [kept, neighbour, ...rest] = openOf(t)
			expect(rest).toEqual([])
			expect(kept!.id).toBe(own!.id)
			expect([kept!.onMin, kept!.onMax]).toEqual([140, 144])
			expect([neighbour!.onMin, neighbour!.onMax]).toEqual([148, 152])
		})

		it("a track that joined young goes by its span at 4 blocks", () => {
			const t = tracker()
			// One emission from its first block: a skirt of 2 bins across the line, peaks 5 bins apart.
			run(
				{
					power: [
						[140, 144, -35],
						[143, 144, -30],
						[144, 148, -36],
						[148, 150, -35],
						[148, 149, -30],
					],
					segments: [
						[140, 144],
						[148, 150],
					],
					mask: [[144, 148]],
					reach: 8,
					blocks: 10,
				},
				t,
			)
			const [own] = openOf(t)
			expect([own!.onMin, own!.onMax]).toEqual([140, 150])
			// A stronger neighbour comes up on the skirt, with the peaks 15 bins apart.
			run(
				{
					power: [
						[140, 144, -35],
						[140, 141, -30],
						[144, 148, -36],
						[148, 156, -30],
						[155, 156, -24],
					],
					segments: [
						[140, 144],
						[148, 156],
					],
					mask: [[144, 148]],
					reach: 8,
					blocks: 1,
					from: 10,
				},
				t,
			)
			const [kept, neighbour, ...rest] = openOf(t)
			expect(rest).toEqual([])
			expect(kept!.id).toBe(own!.id)
			expect(kept!.onMin).toBe(140)
			expect([neighbour!.onMin, neighbour!.onMax]).toEqual([148, 156])
		})

		it("a track on both pieces from its first block goes by strength", () => {
			const t = tracker()
			const k = playBeside("TTTTT", t, 0)
			const [own] = openOf(t)
			playBeside("RRRR", t, k)
			const kept = openOf(t).find(o => o.id === own!.id)!
			expect([kept.onMin, kept.onMax]).toEqual([148, 152])
		})

		it("the remembered span outlasts a rollover", () => {
			const t = tracker(30)
			run({ ...onItsOwn, blocks: 20 }, t)
			// The rollover comes on the 30th block, inside the join.
			const k = playBeside("TTTTTTTTTTTTTT", t, 20)
			const before = openOf(t)[0]!.id
			playBeside("RRRR", t, k)
			const [kept, neighbour, ...rest] = openOf(t)
			expect(rest).toEqual([])
			expect(kept!.id).toBe(before)
			expect([kept!.onMin, kept!.onMax]).toEqual([140, 144])
			expect([neighbour!.onMin, neighbour!.onMax]).toEqual([148, 152])
		})

		it("a track parted once remembers its piece for the next join", () => {
			const t = tracker()
			run({ ...onItsOwn, blocks: 20 }, t)
			let k = playBeside("TRRRR", t, 20)
			const [own] = openOf(t)
			// The neighbour closes after its hang; it comes back and joins, then parts again.
			run({ ...onItsOwn, blocks: 3, from: k }, t)
			k += 3
			expect(openOf(t)).toHaveLength(1)
			k = playBeside("T", t, k)
			expect(openOf(t)[0]!.onMax).toBe(152)
			playBeside("RRRR", t, k)
			expect(openOf(t)[0]!.id).toBe(own!.id)
			expect(openOf(t)[0]!.onMax).toBe(144)
		})

		it("a stronger piece that only touches a track past a walked line does not take it", () => {
			const t = tracker()
			const powerDb = new Float32Array(N).fill(FLOOR)
			const floorDb = new Float32Array(N).fill(FLOOR)
			powerDb.fill(-30, 130, 148)
			powerDb.fill(-50, 144, 148)
			const mask = new Uint8Array(N)
			mask.fill(1, 144, 148)
			const block = (
				k: number,
				segs: readonly (readonly [number, number])[],
			) => {
				t.flagSpurs(mask)
				t.block(
					segs.map(([a, b]) => seg(a, b, powerDb)),
					{
						endSample: (k + 1) * BLOCK,
						powerDb,
						floorDb,
						blockFloorDb: FLOOR,
						thresholdDb: THRESHOLD,
						gap: false,
						overload: false,
					},
				)
			}
			// A line never seen idle: the segment walks it, up to the far edge of the line.
			for (let k = 0; k < 8; k++) block(k, [[130, 144]])
			const [own] = openOf(t)
			expect((own as unknown as { endBin: number }).endBin).toBe(148)
			// A neighbour comes up right past the line, stronger, and the hole dips under the threshold.
			powerDb.fill(FLOOR, 144, 148)
			powerDb.fill(-24, 148, 152)
			block(8, [
				[130, 144],
				[148, 152],
			])
			const [kept, neighbour, ...rest] = openOf(t)
			expect(rest).toEqual([])
			expect(kept!.id).toBe(own!.id)
			expect(kept!.onMin).toBe(130)
			expect([neighbour!.onMin, neighbour!.onMax]).toEqual([148, 152])
		})

		it("a stronger piece past a walked line stays out when the weaker piece walks another line", () => {
			const t = tracker()
			const walked: Scene = {
				power: [
					[126, 130, -35],
					[130, 144, -30],
					[144, 148, -35],
				],
				segments: [[130, 144]],
				mask: [
					[126, 130],
					[144, 148],
				],
				reach: 8,
			}
			run({ ...walked, blocks: 8 }, t)
			const [own] = openOf(t)
			expect([own!.startBin, own!.endBin]).toEqual([126, 148])
			// The piece walks only its far line now, so what the block carries is a joined segment.
			run(
				{
					...walked,
					power: [...walked.power, [148, 152, -24]],
					segments: [
						[130, 144],
						[148, 152],
					],
					blocks: 1,
					from: 8,
				},
				t,
			)
			const [kept, neighbour, ...rest] = openOf(t)
			expect(rest).toEqual([])
			expect(kept!.id).toBe(own!.id)
			expect([kept!.startBin, kept!.endBin]).toEqual([126, 144])
			expect([neighbour!.startBin, neighbour!.endBin]).toEqual([148, 152])
		})

		it("pieces a line did not keep apart go by strength, whatever a line does elsewhere", () => {
			/** Which track holds which piece of a split, with or without two pieces parted by a far line. */
			const split = (farLine: boolean) => {
				const t = tracker()
				run({ power: [[30, 42, -30]], segments: [[30, 42]], blocks: 5 }, t)
				const [own] = openOf(t)
				run(
					{
						power: [
							[30, 32, -25],
							[35, 42, -35],
							...(farLine
								? ([
										[140, 144, -30],
										[144, 148, -50],
										[148, 152, -30],
									] as const)
								: []),
						],
						segments: [
							[30, 32],
							[35, 42],
							...(farLine
								? ([
										[140, 144],
										[148, 152],
									] as const)
								: []),
						],
						...(farLine ? { mask: [[144, 148]] as const } : {}),
						blocks: 1,
						from: 5,
					},
					t,
				)
				return openOf(t)
					.filter(o => o.startBin < 100)
					.map(o => [o.id === own!.id, o.startBin, o.endBin])
			}
			expect(split(false)).toEqual([
				[true, 30, 32],
				[false, 35, 42],
			])
			expect(split(true)).toEqual(split(false))
		})

		it("a joined segment that drifted off its remembered span parts by strength", () => {
			const t = tracker()
			const mask = [
				[144, 148],
				[152, 156],
			] as const
			const twoLines = { mask, reach: 8, blocks: 1 }
			run({ ...onItsOwn, mask, blocks: 20 }, t)
			const [own] = openOf(t)
			// It joins through [152), remembering [140, 144).
			run(
				{
					...twoLines,
					power: [
						[140, 144, -35],
						[143, 144, -30],
						[144, 148, -36],
						[148, 152, -35],
						[148, 149, -30],
					],
					segments: [
						[140, 144],
						[148, 152],
					],
					from: 20,
				},
				t,
			)
			expect(openOf(t).map(o => [o.onMin, o.onMax])).toEqual([[140, 152]])
			// Eight bins right: neither piece lies on the remembered span any more.
			const drifted = (allow: boolean): Scene => ({
				...twoLines,
				power: [
					[148, 152, -35],
					allow ? [151, 152, -30] : [148, 149, -30],
					[152, 156, -36],
					[156, 160, -29],
					allow ? [156, 157, -24] : [159, 160, -24],
				],
				segments: [
					[148, 152],
					[156, 160],
				],
			})
			run({ ...drifted(true), from: 21 }, t)
			expect(openOf(t).map(o => [o.onMin, o.onMax])).toEqual([[140, 160]])
			for (let k = 0; k < LINE_PART_BLOCKS; k++)
				run({ ...drifted(false), from: 22 + k }, t)
			const kept = openOf(t).find(o => o.id === own!.id)!
			const other = openOf(t).find(o => o.id !== own!.id)!
			expect([kept.onMin, kept.onMax]).toEqual([156, 160])
			expect([other.onMin, other.onMax]).toEqual([148, 152])
		})
	})

	describe("what a parted track measured over the join", () => {
		/** One block's frames, 1 ms each, over both pieces: keyed 30 ms on and 30 ms off, or steady. */
		function frames(t: Tracker, block: number, keyed: boolean): void {
			const power = new Float64Array(N).fill(10 ** (FLOOR / 10))
			for (let ms = 0; ms < 50; ms++) {
				const at = block * 50 + ms
				const on = !keyed || Math.floor(at / 30) % 2 === 0
				power.fill(10 ** ((on ? -30 : FLOOR) / 10), 140, 152)
				t.frame(power, 1, (at * BLOCK) / 50)
			}
		}

		it.each([
			["after the envelope froze", 23],
			["before the envelope froze", 10],
		])("is gone %s", (_name, joined) => {
			const t = tracker()
			let k = 0
			for (const c of `${"T".repeat(joined)}RRRR`) {
				frames(t, k, true)
				run({ ...pieces(c === "T"), blocks: 1, from: k }, t)
				k++
			}
			for (let i = 0; i < 40; i++) {
				frames(t, k, false)
				run({ ...pieces(false), blocks: 1, from: k }, t)
				k++
			}
			const [kept, ...rest] = openOf(t)
			expect(rest).toHaveLength(1)
			const reading = t.snapshotOf(kept!.id)!
			expect(reading.obwHz).toBe(4000)
			expect(reading.dutyCycle).toBe(1)
			expect(classOf(reading)).toBe(classOf(t.snapshotOf(rest[0]!.id)!))
			expect(classOf(reading)).toBe("fsk4-6k25")
		})

		it("a parted piece's peak and SNR hold nothing from the join", () => {
			// While joined the strongest bin is -24 dB; after the parting neither piece goes over -30 dB.
			const joined: Scene = {
				...pieces(true),
				power: [
					[140, 144, -35],
					[144, 148, -36],
					[148, 152, -35],
					[143, 144, -30],
					[148, 149, -24],
				],
			}
			const t = tracker()
			let k = 0
			for (let i = 0; i < 10; i++) run({ ...joined, blocks: 1, from: k++ }, t)
			expect(openOf(t)).toHaveLength(1)
			for (let i = 0; i < 4; i++)
				run({ ...pieces(false), blocks: 1, from: k++ }, t)
			const parted = openOf(t)
			expect(parted).toHaveLength(2)
			for (const piece of parted) {
				const reading = t.snapshotOf(piece.id)!
				expect(reading.peakDbfs).toBe(-30)
				// A mean over what the piece itself held: -35 dB bins, one bin at -30 dB.
				expect(reading.meanDbfs).toBeGreaterThan(-30)
				expect(reading.meanDbfs).toBeLessThan(-25)
			}
		})

		it("a parted piece's chain holds nothing from a join before a rollover", () => {
			const joined: Scene = {
				...pieces(true),
				power: [
					[140, 144, -35],
					[144, 148, -36],
					[148, 152, -35],
					[143, 144, -30],
					[148, 149, -24],
				],
			}
			const t = tracker(10)
			let k = 0
			for (let i = 0; i < 10; i++) run({ ...joined, blocks: 1, from: k++ }, t)
			for (let i = 0; i < 4; i++)
				run({ ...pieces(false), blocks: 1, from: k++ }, t)
			const parted = openOf(t) as unknown as readonly {
				chain: { peakDbfs: number } | null
			}[]
			expect(parted).toHaveLength(2)
			const chained = parted.filter(piece => piece.chain !== null)
			expect(chained).toHaveLength(1)
			expect(chained[0]!.chain!.peakDbfs).toBe(-Infinity)
		})

		it("a keyed envelope stands while the join holds", () => {
			const t = tracker()
			let k = 0
			for (const c of `${"T".repeat(23)}RRR`) {
				frames(t, k, true)
				run({ ...pieces(c === "T"), blocks: 1, from: k }, t)
				k++
			}
			const [kept, ...rest] = openOf(t)
			expect(rest).toEqual([])
			expect(classOf(t.snapshotOf(kept!.id)!)).toBe("tdma-ms")
		})
	})
})
