/**
 * WG11 req 5.1 (review MAJ3): a frame track's identity survives the tracker's max-duration
 * rollover. The tracker still closes the track at maxTrackMs and opens a successor with a new
 * id and fresh stats (the scanner's view is unchanged); the frame keeps the chain id, the
 * chain start, the chain's block count, surfaced and spur state, and its SNR and peak continue
 * (chain mean / chain max). The identity lookup is keyed on the chain's current tracker id.
 * Sample counts only: no wall clock.
 */
import { describe, expect, it } from "vitest"
import type { SpectrumFrameTrackScanner } from "@wavekit/api-types"
import { Tracker } from "../../../../src/core/spectrum/emissions/tracker.js"
import type { Segment } from "../../../../src/core/spectrum/emissions/segmenter.js"
import { blockTrackOf } from "../../../../src/core/spectrum/frame-tracks.js"
import type {
	BlockSummary,
	BlockTrack,
	PipelineEvent,
} from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	tone,
} from "../../../mocks/scanner/signals.js"
import { CENTRE, FS, Harness } from "./pipeline-harness.js"
import { richScenario } from "./frame-tracks-harness.js"
import { makeService } from "./frame-tracks-service-harness.js"

const TN = 64
const TBIN_HZ = 1_000
const TFS = TN * TBIN_HZ
const BLOCK_SAMPLES = Math.round((50 * TBIN_HZ * TN) / 1000)
const MAX_BLOCKS = 4

function seg(peakDb: number): Segment {
	return {
		startBin: 20,
		endBin: 24,
		peakBin: 21,
		peakDb,
		centroidBin: 21.5,
		flags: { truncated: false, skirt: false, edge: false },
	}
}

function makeTracker(): Tracker {
	const t = new Tracker({
		sourceId: "s",
		binHz: TBIN_HZ,
		blockMs: 50,
		hangBlocks: 2,
		maxTracks: 8,
		maxTrackBlocks: MAX_BLOCKS,
		idPrefix: "s-0-",
	})
	t.beginEpoch({ stream: 1, epoch: 1, centreHz: 0, tuningTrust: "commanded" })
	return t
}

/** One block of a single steady emission at `peakDb`; the frame track and the tracker events. */
function step(tracker: Tracker, i: number, peakDb: number) {
	const s = seg(peakDb)
	const power = new Float32Array(TN).fill(-100)
	for (let k = s.startBin; k < s.endBin; k++) power[k] = peakDb
	const events = tracker.block([s], {
		endSample: (i + 1) * BLOCK_SAMPLES,
		powerDb: power,
		floorDb: new Float32Array(TN).fill(-100),
		blockFloorDb: -100,
		thresholdDb: 6,
		gap: false,
		overload: false,
	})
	const a = tracker.associationOf(s)
	const bt = blockTrackOf(
		1,
		2,
		{ burst: false, iqImage: false, edge: false },
		a,
		TFS,
		2,
	)
	return { a, bt, events }
}

describe("frame track identity across the max-duration rollover (tracker level)", () => {
	it("keeps the chain id, start, block count, surfaced and spur; the tracker still re-opens", () => {
		const tracker = makeTracker()
		const out: { a: ReturnType<typeof step>["a"]; bt: BlockTrack }[] = []
		const allEvents: PipelineEvent[] = []
		for (let i = 0; i < 3 * (MAX_BLOCKS - 1); i++) {
			// strong first, weaker after the first rollover: the peak must stay the chain max
			const r = step(tracker, i, i < MAX_BLOCKS ? -40 : -60)
			if (i === 1) {
				const mask = new Uint8Array(TN)
				mask.fill(1, 18, 26)
				allEvents.push(...tracker.flagSpurs(mask))
			}
			out.push({ a: r.a, bt: r.bt })
			allEvents.push(...r.events)
		}
		// the scanner's view is today's: max-duration closes and fresh successor opens
		const closes = allEvents.filter(
			e => e.kind === "track-close" && e.endReason === "max-duration",
		)
		expect(closes).toHaveLength(2)
		const opens = allEvents.filter(e => e.kind === "track-open")
		expect(
			opens.map(e => (e.kind === "track-open" ? e.track.trackId : "")),
		).toEqual(["s-0-1", "s-0-2", "s-0-3"])
		for (const e of opens.slice(1))
			if (e.kind === "track-open") {
				expect(e.track.blocks).toBe(1) // successor stats restart for the scanner
				expect(e.track.flags.spur).toBe(false)
			}
		// the frame's view: one chain
		for (const [i, { bt }] of out.entries()) {
			expect(bt.trackId).toBe("s-0-1")
			expect(bt.blocks).toBe(i + 1)
			expect(bt.ageMs).toBe((i + 1) * 50)
			// flagged after block 1's summary: sticky from block 2, through both rollovers
			if (i >= 2) {
				expect(bt.flags.spur).toBe(true)
				expect(bt.surfaced).toBe(false) // a spur never surfaces, before or after
			}
			expect(bt.peakDbfs).toBe(-40)
		}
		// the current tracker id rides along (host-internal) only once it differs
		expect(out[0]?.bt.trackerId).toBeUndefined()
		const ids = out.map(o => o.a?.trackerId)
		expect(new Set(ids)).toEqual(new Set(["s-0-1", "s-0-2", "s-0-3"]))
		for (const { a, bt } of out)
			expect(bt.trackerId).toBe(
				a?.trackerId === "s-0-1" ? undefined : a?.trackerId,
			)
	})

	it("surfaced stays true across the rollover and SNR continues as the chain mean", () => {
		const tracker = makeTracker()
		const rows = []
		for (let i = 0; i < 2 * MAX_BLOCKS + 1; i++)
			rows.push(step(tracker, i, -60))
		const rollIdx = rows.findIndex(r =>
			r.events.some(
				e => e.kind === "track-close" && e.endReason === "max-duration",
			),
		)
		expect(rollIdx).toBeGreaterThan(0)
		const before = rows[rollIdx - 1]!.bt
		const after = rows[rollIdx]!.bt
		const next = rows[rollIdx + 1]!.bt
		expect(after.trackId).toBe(before.trackId)
		expect(next.trackId).toBe(before.trackId)
		expect(before.surfaced).toBe(true)
		expect(after.surfaced).toBe(true) // the successor alone has 1 block (< minSurfaceBlocks 2)
		expect(next.surfaced).toBe(true)
		expect(after.blocks).toBe((before.blocks ?? 0) + 1)
		expect(next.blocks).toBe((before.blocks ?? 0) + 2)
		expect((after.ageMs ?? 0) - (before.ageMs ?? 0)).toBe(50)
		// constant emission: the chain mean SNR is unchanged by the rollover
		expect(after.snrDb).toBe(before.snrDb)
		expect(after.peakDbfs).toBe(before.peakDbfs)
	})

	it("a new epoch breaks the chain: the next track has a new frame id", () => {
		const tracker = makeTracker()
		let last: BlockTrack | undefined
		for (let i = 0; i < MAX_BLOCKS + 2; i++) last = step(tracker, i, -60).bt
		expect(last?.trackerId).toBeDefined() // rolled over once in epoch 1
		const epoch1 = last!.trackId
		tracker.closeAll("retune")
		tracker.beginEpoch({
			stream: 1,
			epoch: 2,
			centreHz: 0,
			tuningTrust: "commanded",
		})
		const first = step(tracker, MAX_BLOCKS + 2, -60).bt
		expect(first.trackId).not.toBe(epoch1)
		expect(first.trackerId).toBeUndefined()
		expect(first.blocks).toBe(1)
		expect(first.ageMs).toBe(50)
	})
})

describe("frame track identity across the max-duration rollover (pipeline level)", () => {
	it("one steady tone keeps one frame id across rollovers; a new epoch gives a new id", () => {
		// maxTrackMs 500 ms = 10 blocks of 50 ms; 2 s of a steady tone, then a retune
		const h = new Harness(
			{ format: "FLOAT32LE", maxTrackMs: 500 },
			{ provisionalWindowMs: 1_000 },
		)
		h.start()
		const total = 2 * FS
		const iq = gaussianNoise(mulberry32(5), total, 0.005)
		addInto(iq, tone(total, FS, 33_300, 0.05))
		for (let at = 0; at < total; at += FS / 4)
			h.push(
				{
					re: iq.re.subarray(at, at + FS / 4),
					im: iq.im.subarray(at, at + FS / 4),
				},
				8192,
			)
		const maxDur = h
			.of("track-close")
			.filter(e => e.endReason === "max-duration")
		expect(maxDur.length).toBeGreaterThan(1)
		const near = (s: BlockSummary) =>
			s.tracks.find(
				t => t.startHz <= CENTRE + 33_300 && t.endHz >= CENTRE + 33_300,
			)
		const tracked = h
			.of("block-summary")
			.map(e => near(e.summary))
			.filter((t): t is BlockTrack => t?.trackId !== undefined)
		expect(tracked.length).toBeGreaterThan(20)
		const id = tracked[0]!.trackId
		expect(tracked.every(t => t.trackId === id)).toBe(true)
		expect(tracked.some(t => t.trackerId !== undefined)).toBe(true)
		for (let i = 1; i < tracked.length; i++) {
			expect(tracked[i]!.blocks).toBeGreaterThan(tracked[i - 1]!.blocks ?? 0)
			expect(tracked[i]!.ageMs).toBeGreaterThan(tracked[i - 1]!.ageMs ?? 0)
		}
		expect(tracked.slice(2).every(t => t.surfaced === true)).toBe(true)
		// the internal id is the current tracker id of the chain (without `${sourceId}-`)
		const opened = new Set(h.of("track-open").map(e => e.track.trackId))
		for (const t of tracked)
			expect(
				opened.has(`${h.config.sourceId}-${t.trackerId ?? t.trackId}`),
			).toBe(true)
		// a new epoch: a new chain
		h.pending({ epoch: 2, centreHz: CENTRE + 1e6 })
		const after = Math.round(0.6 * FS)
		const iq2 = gaussianNoise(mulberry32(6), after, 0.005)
		// another baseband offset: the same one would read as the previous epoch's stale emitter
		addInto(iq2, tone(after, FS, -45_100, 0.05))
		h.push(iq2, 8192)
		const later = h
			.of("block-summary")
			.filter(e => e.summary.epoch === 2)
			.map(e => e.summary.tracks.find(t => t.trackId !== undefined))
			.filter((t): t is BlockTrack => t !== undefined)
		expect(later.length).toBeGreaterThan(0)
		expect(later.every(t => t.trackId !== id)).toBe(true)
	}, 60_000)
})

const IDENTITY: SpectrumFrameTrackScanner = {
	discoveryId: "d_01JABCDEFGHJKMNPQRSTVWXYZ0",
	protocol: "dmr",
	confidence: "decoded",
}

describe("identity lookup after a rollover (service level)", () => {
	const base = richScenario().summaries.find(
		s => s.epoch === 1 && s.tracks.some(t => t.trackId !== undefined),
	)!
	/** A summary whose first tracked track has rolled over: chain id `chain`, current `cur`. */
	const rolled = (sourceId: string): BlockSummary => {
		const copy = structuredClone({ ...base, sourceId, stream: 0 })
		const t = copy.tracks.find(x => x.trackId !== undefined)!
		t.trackId = "mguu1x2s-1"
		t.trackerId = "mguu1x2s-5"
		return copy
	}

	it("asks with the successor's full tracker id and the frame's own source; the frame keeps the chain id and never carries trackerId", async () => {
		const h = makeService({ extraSourceIds: ["b"] })
		const asked: [string, string][] = []
		h.service.setTrackIdentityLookup((sourceId, trackId) => {
			asked.push([sourceId, trackId])
			return sourceId === "rtl" && trackId === "rtl-mguu1x2s-5"
				? IDENTITY
				: null
		})
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		await h.service.acquire("b", "job:b")
		await h.service.subscribe("c-default", undefined)
		for (const id of ["rtl", "b"]) {
			h.hostOf(id).epoch(1, true)
			h.hostOf(id).summary(rolled(id))
		}
		const frameOf = (id: string) =>
			h.service.status().sources.find(s => s.sourceId === id)?.latestFrame
		const a = frameOf("rtl")!
		const b = frameOf("b")!
		expect(asked).toContainEqual(["rtl", "rtl-mguu1x2s-5"])
		expect(asked).toContainEqual(["b", "b-mguu1x2s-5"])
		expect(asked.some(([, t]) => t.endsWith("mguu1x2s-1"))).toBe(false)
		expect(asked.every(([s, t]) => t.startsWith(`${s}-`))).toBe(true)
		const ta = a.tracks.find(t => t.trackId === "mguu1x2s-1")
		expect(ta?.scanner).toEqual(IDENTITY)
		// equal suffixes on another source never cross-match
		expect(JSON.stringify(b)).not.toContain('"scanner"')
		const wire = JSON.stringify([a, b, h.frames.map(f => f.frame)])
		expect(wire).not.toContain("trackerId")
		expect(wire).not.toContain("mguu1x2s-5")
		await h.service.stop()
	})

	it("without a lookup the internal id is still stripped from frames", async () => {
		const h = makeService()
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		await h.service.subscribe("c-default", undefined)
		h.host().epoch(1, true)
		h.host().summary(rolled("rtl"))
		const frame = h.service
			.status()
			.sources.find(s => s.sourceId === "rtl")?.latestFrame
		expect(frame?.tracks.some(t => t.trackId === "mguu1x2s-1")).toBe(true)
		expect(JSON.stringify([frame, h.frames.map(f => f.frame)])).not.toContain(
			"trackerId",
		)
		await h.service.stop()
	})
})
