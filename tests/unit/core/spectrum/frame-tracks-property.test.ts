import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { Tracker } from "../../../../src/core/spectrum/emissions/tracker.js"
import type { Segment } from "../../../../src/core/spectrum/emissions/segmenter.js"
import {
	blockTrackOf,
	roundHalfDb,
	surfacedOf,
} from "../../../../src/core/spectrum/frame-tracks.js"
import type {
	BlockSummary,
	BlockTrack,
	PipelineEvent,
	TrackFlags,
} from "../../../../src/core/spectrum/types.js"
import { richScenario, untrackedScenario } from "./frame-tracks-harness.js"
import type { Harness } from "./pipeline-harness.js"
import { BIN_HZ, FS, N } from "./pipeline-harness.js"

/** The tracker's private state, read to state what "the tracker's own decision" is. */
interface OpenTrackView {
	id: string
	lastSeg: Segment
	lastOnBlock: number
	blocks: number
	peakDbfs: number
	startSample: number
	lastSample: number
	maxBlockSnrDb: number
	thresholdDb: number
	bandLinSum: number
	floorLinSum: number
	chain: unknown
	flags: TrackFlags
}
interface TrackerView {
	open: OpenTrackView[]
	blockNo: number
}
const view = (t: Tracker): TrackerView => t as unknown as TrackerView

const WG11_KEYS = [
	"trackId",
	"snrDb",
	"peakDbfs",
	"blocks",
	"ageMs",
	"surfaced",
	"trackerId",
	"gate",
	"channelSnrDb",
] as const

/**
 * Test-side model of the frame chains (req 5.1): a max-duration close followed by the open of
 * its successor in the same block continues the chain. The members are the tracker's own
 * track objects; the rollover block (counted by both neighbours) is subtracted once per link.
 */
class ChainModel {
	private readonly seen = new Map<string, OpenTrackView>()
	private readonly chainOf = new Map<
		string,
		{ members: OpenTrackView[]; overlaps: { band: number; floor: number }[] }
	>()
	rollovers = 0

	after(events: PipelineEvent[], v: TrackerView): void {
		for (const t of v.open) this.seen.set(t.id, t)
		for (const [i, e] of events.entries()) {
			const next = events[i + 1]
			if (
				e.kind !== "track-close" ||
				e.endReason !== "max-duration" ||
				next?.kind !== "track-open"
			)
				continue
			const prev = this.chainOf.get(e.track.trackId) ?? {
				members: [this.seen.get(e.track.trackId)!],
				overlaps: [],
			}
			const succ = this.seen.get(next.track.trackId)!
			expect(succ.blocks).toBe(1)
			this.chainOf.set(next.track.trackId, {
				members: [...prev.members, succ],
				overlaps: [
					...prev.overlaps,
					{ band: succ.bandLinSum, floor: succ.floorLinSum },
				],
			})
			this.rollovers++
		}
	}

	/** The chain state of `t` as of now (a lone track is a chain of one). */
	of(t: OpenTrackView) {
		const c = this.chainOf.get(t.id) ?? { members: [t], overlaps: [] }
		const root = c.members[0]!
		const sum = (f: (m: OpenTrackView) => number) =>
			c.members.reduce((n, m) => n + f(m), 0)
		const blocks = sum(m => m.blocks) - c.overlaps.length
		const band =
			sum(m => m.bandLinSum) - c.overlaps.reduce((n, o) => n + o.band, 0)
		const floor =
			sum(m => m.floorLinSum) - c.overlaps.reduce((n, o) => n + o.floor, 0)
		const k = Math.max(1, blocks)
		return {
			id: root.id,
			startSample: root.startSample,
			blocks,
			snrDb:
				10 *
				Math.log10(
					Math.max(band / k - floor / k, 1e-30) / Math.max(floor / k, 1e-30),
				),
			peakDbfs: Math.max(...c.members.map(m => m.peakDbfs)),
			maxBlockSnrDb: Math.max(...c.members.map(m => m.maxBlockSnrDb)),
			spur: c.members.some(m => m.flags.spur),
			iqImage: c.members.some(m => m.flags.iqImage),
		}
	}
}

/** Tracker-level expected fields: the chain state of the segment's current track. */
function expectedChainFields(
	chains: ChainModel,
	t: OpenTrackView,
	fs: number,
	minSurfaceBlocks: number,
) {
	const c = chains.of(t)
	return {
		flags: { spur: c.spur },
		trackId: c.id,
		trackerId: t.id === c.id ? undefined : t.id,
		snrDb: roundHalfDb(c.snrDb) ?? undefined,
		peakDbfs: roundHalfDb(c.peakDbfs) ?? undefined,
		blocks: c.blocks,
		ageMs: Math.round(((t.lastSample - c.startSample) / fs) * 1000),
		surfaced: surfacedOf(
			{
				spur: c.spur,
				iqImage: c.iqImage,
				burst: t.flags.burst,
				blocks: c.blocks,
				maxBlockSnrDb: c.maxBlockSnrDb,
				thresholdDb: t.thresholdDb,
			},
			minSurfaceBlocks,
		),
	}
}

/** The frame fields a segment must carry, from the tracker's state of its track in this block. */
function expectedFields(
	tracker: Tracker,
	t: OpenTrackView,
	segmentImage: boolean,
	fs: number,
	minSurfaceBlocks: number,
	/** The pipeline's own `${sourceId}-`: a frame id is the tracker id without it. */
	framePrefix = "",
) {
	const snap = tracker.snapshotOf(t.id)
	if (!snap) throw new Error("open track without a snapshot")
	return {
		flags: { spur: snap.flags.spur },
		trackId: t.id.slice(framePrefix.length),
		snrDb: roundHalfDb(snap.snrDb) ?? undefined,
		peakDbfs: roundHalfDb(snap.peakDbfs) ?? undefined,
		blocks: snap.blocks,
		ageMs: Math.round(((snap.lastSample - snap.startSample) / fs) * 1000),
		surfaced: surfacedOf(
			{
				spur: snap.flags.spur,
				iqImage: snap.flags.iqImage || segmentImage,
				burst: snap.flags.burst,
				blocks: snap.blocks,
				maxBlockSnrDb: snap.maxBlockSnrDb,
				thresholdDb: snap.thresholdDb,
			},
			minSurfaceBlocks,
		),
	}
}

function expectUntracked(t: BlockTrack): void {
	for (const k of WG11_KEYS) expect(k in t).toBe(false)
	expect("spur" in t.flags).toBe(false)
}

function expectTracked(
	t: BlockTrack,
	want: ReturnType<typeof expectedFields> & { trackerId?: string | undefined },
): void {
	expect(t.flags.spur).toBe(want.flags.spur)
	expect(t.trackId).toBe(want.trackId)
	expect(t.trackerId).toBe(want.trackerId)
	expect(t.snrDb).toBe(want.snrDb)
	expect(t.peakDbfs).toBe(want.peakDbfs)
	expect(t.blocks).toBe(want.blocks)
	expect(t.ageMs).toBe(want.ageMs)
	expect(t.surfaced).toBe(want.surfaced)
}

// ---- tracker level: random segment streams ----

const TN = 64
const TBIN_HZ = 1_000
const TFS = TN * TBIN_HZ
const BLOCK_SAMPLES = Math.round((50 * TBIN_HZ * TN) / 1000)

const segArb = fc.record({
	start: fc.integer({ min: 0, max: TN - 5 }),
	width: fc.integer({ min: 1, max: 4 }),
	peakDb: fc.integer({ min: -90, max: -20 }),
	truncated: fc.integer({ min: 0, max: 7 }).map(x => x === 0),
	burst: fc.boolean(),
	edge: fc.boolean(),
})
const blockArb = fc.record({
	segs: fc.array(segArb, { maxLength: 6 }),
	gap: fc.integer({ min: 0, max: 9 }).map(x => x === 0),
	spurAt: fc.option(fc.integer({ min: 0, max: TN - 1 }), { nil: undefined }),
	image: fc.integer({ min: 0, max: 7 }).map(x => x === 0),
	threshold: fc.integer({ min: 4, max: 14 }),
})

function segmentsOf(
	raw: {
		start: number
		width: number
		peakDb: number
		truncated: boolean
		edge: boolean
	}[],
): Segment[] {
	const out: Segment[] = []
	let end = -1
	for (const r of [...raw].sort((a, b) => a.start - b.start)) {
		if (r.start < end + 1) continue
		const e = Math.min(TN, r.start + r.width)
		out.push({
			startBin: r.start,
			endBin: e,
			peakBin: r.start,
			peakDb: r.peakDb,
			centroidBin: (r.start + e - 1) / 2,
			flags: { truncated: r.truncated, skirt: false, edge: r.edge },
		})
		end = e
	}
	return out
}

describe("frame tracks are the tracker's own association", () => {
	it("tracker level: every segment's fields are its associated track's state in that block; others carry none", () => {
		// Feature: web-gaps-11, Property 10: Track fields are the tracker's
		// Validates: Requirements 5.1, 5.2, 5.3
		// The fields are the tracker's chain state: a max-duration rollover continues the chain.
		let associated = 0
		let untracked = 0
		let rollovers = 0
		let continued = 0
		fc.assert(
			fc.property(
				fc.array(blockArb, { minLength: 1, maxLength: 24 }),
				fc.integer({ min: 1, max: 4 }), // hangBlocks
				fc.integer({ min: 1, max: 4 }), // maxTracks
				fc.integer({ min: 2, max: 12 }), // maxTrackBlocks
				fc.integer({ min: 1, max: 4 }), // minSurfaceBlocks
				(blocks, hangBlocks, maxTracks, maxTrackBlocks, minSurface) => {
					const tracker = new Tracker({
						sourceId: "s",
						binHz: TBIN_HZ,
						blockMs: 50,
						hangBlocks,
						maxTracks,
						maxTrackBlocks,
						idPrefix: "s-0-",
					})
					tracker.beginEpoch({
						stream: 1,
						epoch: 1,
						centreHz: 0,
						tuningTrust: "commanded",
					})
					const chains = new ChainModel()
					let previous: Segment[] = []
					for (const [i, b] of blocks.entries()) {
						const segs = segmentsOf(b.segs)
						const power = new Float32Array(TN).fill(-100)
						for (const s of segs)
							for (let k = s.startBin; k < s.endBin; k++) power[k] = s.peakDb
						if (b.spurAt !== undefined) {
							const mask = new Uint8Array(TN)
							mask.fill(1, Math.max(0, b.spurAt - 3), b.spurAt + 3)
							tracker.flagSpurs(mask)
						}
						const bursts = new Set(
							segs.filter((_, k) => b.segs[k]?.burst === true),
						)
						const events = tracker.block(segs, {
							endSample: (i + 1) * BLOCK_SAMPLES,
							powerDb: power,
							floorDb: new Float32Array(TN).fill(-100),
							blockFloorDb: -100,
							thresholdDb: b.threshold,
							gap: b.gap,
							overload: false,
							burstSegments: bursts,
						})
						if (b.image && view(tracker).open.length > 0)
							tracker.raiseFlag(new Set([view(tracker).open[0]!.id]), "iqImage")
						const v = view(tracker)
						chains.after(events, v)
						const ids = new Set<string>()
						for (const s of segs) {
							const owners = v.open.filter(
								t => t.lastSeg === s && t.lastOnBlock === v.blockNo,
							)
							expect(owners.length).toBeLessThanOrEqual(1)
							const owner = owners[0]
							const a = tracker.associationOf(s)
							const bt = blockTrackOf(
								1,
								2,
								{ burst: bursts.has(s), iqImage: false, edge: false },
								a,
								TFS,
								minSurface,
							)
							if (owner === undefined) {
								expect(a).toBeNull()
								expectUntracked(bt)
								untracked++
								continue
							}
							expect(a?.trackerId).toBe(owner.id)
							expect(a?.trackId).toBe(chains.of(owner).id)
							if (a?.trackId !== owner.id) continued++
							expect(ids.has(owner.id)).toBe(false) // one segment per track per block
							ids.add(owner.id)
							associated++
							expectTracked(
								bt,
								expectedChainFields(chains, owner, TFS, minSurface),
							)
						}
						// no look-ahead or stale carry: last block's segments have no association now
						for (const s of previous)
							expect(tracker.associationOf(s)).toBeNull()
						previous = segs
					}
					rollovers += chains.rollovers
				},
			),
			{ numRuns: 100, seed: 11_010 },
		)
		// the generator reaches both sides
		expect(associated).toBeGreaterThan(100)
		expect(untracked).toBeGreaterThan(10)
		expect(rollovers).toBeGreaterThan(10)
		expect(continued).toBeGreaterThan(10)
	}, 30_000) // ≈ 1 s idle; the margin is for a loaded machine
})

// ---- pipeline level: the summary of each block against the tracker after that block ----

function checkBlock(h: Harness, summary: BlockSummary): number {
	const tracker = (h.pipeline as unknown as { tracker: Tracker }).tracker
	const v = view(tracker)
	const rfLow = (bin: number) => summary.centreHz + (bin - N / 2 - 0.5) * BIN_HZ
	const current = v.open.filter(t => t.lastOnBlock === v.blockNo)
	let tracked = 0
	for (const t of summary.tracks) {
		const owner = current.find(
			o =>
				rfLow(o.lastSeg.startBin) === t.startHz &&
				rfLow(o.lastSeg.endBin) === t.endHz,
		)
		if (t.trackId === undefined) {
			expect(owner).toBeUndefined()
			expectUntracked(t)
			continue
		}
		tracked++
		// the frame id is the tracker id without the pipeline's own `${sourceId}-` prefix
		expect(owner?.id).toBe(`${h.config.sourceId}-${t.trackId}`)
		// these scenarios are shorter than maxTrackMs: no chain, so the snapshot is the chain state
		expect(owner?.chain).toBeNull()
		expectTracked(
			t,
			expectedFields(
				tracker,
				owner!,
				t.flags.iqImage,
				FS,
				h.config.minSurfaceBlocks,
				`${h.config.sourceId}-`,
			),
		)
	}
	return tracked
}

describe("pipeline: each summary's tracks equal the tracker's state after that same block", () => {
	for (const [name, build] of [
		["rich (bursts, image, spur, epoch change)", richScenario],
		["untracked (maxTracks 1)", untrackedScenario],
	] as const) {
		it(
			name,
			() => {
				let blocks = 0
				let tracked = 0
				const observe = (h: Harness, events: PipelineEvent[]) => {
					for (const e of events)
						if (e.kind === "block-summary") {
							blocks++
							tracked += checkBlock(h, e.summary)
						}
				}
				if (build === richScenario) richScenario(undefined, {}, observe)
				else untrackedScenario(undefined, observe)
				expect(blocks).toBeGreaterThan(20)
				expect(tracked).toBeGreaterThan(20)
			},
			60_000,
		) // a few seconds of simulated DSP; slow only on a loaded machine
	}
})
