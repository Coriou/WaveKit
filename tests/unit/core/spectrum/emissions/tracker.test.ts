import { describe, expect, it } from "vitest"
import { segment } from "../../../../../src/core/spectrum/emissions/segmenter.js"
import type { Segment } from "../../../../../src/core/spectrum/emissions/segmenter.js"
import { Tracker } from "../../../../../src/core/spectrum/emissions/tracker.js"
import type { TrackerBlock } from "../../../../../src/core/spectrum/emissions/tracker.js"
import type {
	PipelineEvent,
	TrackSnapshot,
} from "../../../../../src/core/spectrum/types.js"

const N = 256
const BIN_HZ = 1000
const CENTRE = 446_100_000
const FLOOR = -60
const BLOCK = 12_800

function tracker(
	over: Partial<ConstructorParameters<typeof Tracker>[0]> = {},
): Tracker {
	const t = new Tracker({
		sourceId: "s1",
		binHz: BIN_HZ,
		blockMs: 50,
		hangBlocks: 3,
		maxTracks: 4,
		maxTrackBlocks: 100,
		idPrefix: "t",
		...over,
	})
	t.beginEpoch({
		stream: 1,
		epoch: 1,
		centreHz: CENTRE,
		tuningTrust: "commanded",
	})
	return t
}
/** A block whose PSD carries flat emissions `[startBin, endBin, dBFS]`. */
function block(
	index: number,
	emissions: [number, number, number][],
	over: Partial<TrackerBlock> = {},
): { segs: Segment[]; b: TrackerBlock } {
	const powerDb = new Float32Array(N).fill(FLOOR)
	const floorDb = new Float32Array(N).fill(FLOOR)
	for (const [a, e, db] of emissions)
		for (let i = a; i < e; i++) powerDb[i] = db
	const on = new Uint8Array(N)
	for (let i = 0; i < N; i++) on[i] = (powerDb[i] ?? 0) > FLOOR + 4 ? 1 : 0
	const segs = segment(on, powerDb, floorDb, {
		gapBins: 2,
		usableStartBin: 26,
		usableEndBin: 231,
		exclusionEdges: [],
		rasterBinEdges: [],
		skirtDb: 30,
		inWindow: false,
	})
	return {
		segs,
		b: {
			endSample: (index + 1) * BLOCK,
			powerDb,
			floorDb,
			blockFloorDb: FLOOR,
			thresholdDb: 4,
			gap: false,
			overload: false,
			...over,
		},
	}
}
function run(
	t: Tracker,
	index: number,
	emissions: [number, number, number][],
	over: Partial<TrackerBlock> = {},
): PipelineEvent[] {
	const { segs, b } = block(index, emissions, over)
	return t.block(segs, b)
}
function tracksOf(
	events: PipelineEvent[],
	kind: "track-open" | "track-update" | "track-close",
): TrackSnapshot[] {
	return events.flatMap(e => (e.kind === kind ? [e.track] : []))
}

describe("Tracker", () => {
	it("opens, updates at 2 blocks, and closes quiet after the hang", () => {
		const t = tracker()
		const opened = tracksOf(run(t, 0, [[140, 149, -20]]), "track-open")
		expect(opened).toHaveLength(1)
		expect(opened[0]!.blocks).toBe(1)
		expect(opened[0]!.startSample).toBe(0)
		const updated = tracksOf(run(t, 1, [[140, 149, -20]]), "track-update")
		expect(updated.map(u => u.blocks)).toEqual([2])
		expect(run(t, 2, [])).toEqual([])
		expect(run(t, 3, [])).toEqual([])
		const closing = run(t, 4, [])
		expect(closing).toHaveLength(1)
		const c = closing[0]!
		expect(c.kind === "track-close" && c.endReason).toBe("quiet")
		if (c.kind !== "track-close") return
		expect(c.track.lastSample).toBe(2 * BLOCK)
		expect(c.track.centreHz).toBeCloseTo(CENTRE + (144 - N / 2) * BIN_HZ, 0)
		expect(c.track.obwHz).toBe(9000)
		expect(c.track.obwMethod).toBe("-20dB")
		expect(c.track.peakDbfs).toBe(-20)
		expect(c.track.maxBlockSnrDb).toBe(40)
		expect(c.track.snrDb).toBeCloseTo(40, 1)
		expect(c.track.floorDbfs).toBe(FLOOR)
		expect(c.track.spectralShape).toBe("flat")
		expect(c.track.tuningTrust).toBe("commanded")
	})

	it("reports on-bin width below 20 dB SNR", () => {
		const t = tracker()
		run(t, 0, [[140, 147, -50]])
		const closing = [...run(t, 1, []), ...run(t, 2, []), ...run(t, 3, [])]
		const c = tracksOf(closing, "track-close")[0]!
		expect(c.obwMethod).toBe("on-bins")
		expect(c.obwHz).toBe(7000)
	})

	it("never holds more than maxTracks open; the rest are transients", () => {
		const t = tracker({ maxTracks: 2 })
		const ev = run(t, 0, [
			[60, 66, -20],
			[100, 106, -25],
			[150, 156, -30],
		])
		expect(tracksOf(ev, "track-open")).toHaveLength(2)
		expect(t.openCount).toBe(2)
		const transients = ev.filter(e => e.kind === "transient")
		expect(transients).toHaveLength(1)
		expect(
			transients[0]!.kind === "transient" && transients[0]!.centreHz,
		).toBeCloseTo(CENTRE + (152.5 - N / 2) * BIN_HZ, 0)
	})

	it("turns a truncated new segment into a transient and makes truncation sticky on an open track", () => {
		const t = tracker()
		const first = run(t, 0, [[26, 30, -20]])
		expect(tracksOf(first, "track-open")).toHaveLength(0)
		expect(first.some(e => e.kind === "transient")).toBe(true)
		run(t, 1, [[40, 49, -20]])
		const widened = run(t, 2, [[27, 49, -20]])
		const upd = tracksOf(widened, "track-update")
		expect(upd).toHaveLength(1)
		expect(upd[0]!.flags.truncated).toBe(true)
		run(t, 3, [[40, 49, -20]])
		const closed = tracksOf(
			[...run(t, 4, []), ...run(t, 5, []), ...run(t, 6, [])],
			"track-close",
		)
		expect(closed[0]!.flags.truncated).toBe(true)
	})

	it("does not open tracks in gap blocks and closes with endReason gap after a gap hang", () => {
		const t = tracker()
		expect(
			tracksOf(run(t, 0, [[140, 149, -20]], { gap: true }), "track-open"),
		).toHaveLength(0)
		run(t, 1, [[140, 149, -20]])
		run(t, 2, [], { gap: true })
		run(t, 3, [], { gap: true })
		const ev = run(t, 4, [], { gap: true })
		expect(
			ev.map(e => (e.kind === "track-close" ? e.endReason : e.kind)),
		).toEqual(["gap"])
	})

	it("splits a track at maxTrackBlocks with endReason max-duration and keeps following it", () => {
		const t = tracker({ maxTrackBlocks: 3 })
		run(t, 0, [[140, 149, -20]])
		run(t, 1, [[140, 149, -20]])
		const ev = run(t, 2, [[140, 149, -20]])
		const closed = ev.find(e => e.kind === "track-close")
		const reopened = tracksOf(ev, "track-open")
		expect(closed?.kind === "track-close" && closed.endReason).toBe(
			"max-duration",
		)
		expect(reopened).toHaveLength(1)
		expect(reopened[0]!.trackId).not.toBe(
			closed?.kind === "track-close" ? closed.track.trackId : "",
		)
		expect(reopened[0]!.startSample).toBe(2 * BLOCK)
	})

	it("closes every open track with endReason retune on a new epoch", () => {
		const t = tracker()
		run(t, 0, [
			[60, 66, -20],
			[140, 149, -20],
		])
		const ev = t.beginEpoch({
			stream: 1,
			epoch: 2,
			centreHz: CENTRE + 1e6,
			tuningTrust: "commanded",
		})
		expect(
			ev.map(e => (e.kind === "track-close" ? e.endReason : e.kind)),
		).toEqual(["retune", "retune"])
		expect(t.openCount).toBe(0)
	})

	it("builds a 1 ms envelope from frames and measures the TDMA signature", () => {
		const t = tracker({ hangBlocks: 10 })
		const frameDb = new Float32Array(N)
		let last: PipelineEvent[] = []
		for (let blk = 0; blk < 12; blk++) {
			if (blk > 0) {
				for (let f = 0; f < 50; f++) {
					const ms = blk * 50 + f
					const on = ms % 60 < 27.5
					frameDb.fill(FLOOR)
					for (let i = 140; i < 149; i++) frameDb[i] = on ? -20 : FLOOR
					t.frame(frameDb, ms * 256)
				}
			}
			last = run(t, blk, [[140, 149, -24]])
		}
		const snap = [
			...tracksOf(last, "track-update"),
			...tracksOf(t.closeAll("job-end"), "track-close"),
		].at(-1)!
		expect(snap.acf30).toBeLessThanOrEqual(-0.5)
		expect(snap.acf60).toBeGreaterThanOrEqual(0.5)
		expect(snap.dutyCycle).toBeCloseTo(27.5 / 60, 1)
	})

	it("trackBinsMask marks the current bins of tracks with enough blocks", () => {
		const t = tracker()
		run(t, 0, [[60, 66, -20]])
		run(t, 1, [
			[60, 66, -20],
			[140, 149, -20],
		])
		const m = new Uint8Array(N)
		t.trackBinsMask(m, 2)
		expect(Array.from(m.slice(60, 66))).toEqual([1, 1, 1, 1, 1, 1])
		expect(m[140]).toBe(0)
		t.trackBinsMask(m, 1)
		expect(m[140]).toBe(1)
	})
})
