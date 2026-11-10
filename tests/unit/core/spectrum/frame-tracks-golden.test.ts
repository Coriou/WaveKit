import { describe, expect, it } from "vitest"
import type { BlockSummary } from "../../../../src/core/spectrum/types.js"
import {
	COMB_BINS,
	richScenario,
	sha256,
	stripTrackFields,
	untrackedScenario,
} from "./frame-tracks-harness.js"
import { makeService } from "./frame-tracks-service-harness.js"

/**
 * WG11 lane TR goldens (req 5.1, 5.6; common brief §5): recorded from the frozen code at
 * 14f2feaa before any lane edit. With the WG11 frame-track fields stripped, block summaries and
 * every frame the service sends (live, snapshot, backfill) stay byte-identical.
 *
 * The rich goldens were re-recorded once the spur masks needed verification: the scenario's comb
 * is now a weak receiver comb seen under three centres (it masks in epoch 3), and the old comb
 * fast path no longer masks the real tones it had joined to the comb (33.3 and 60.5 kHz, the
 * image). Every other summary field and frame was left as the frozen code had it.
 */
const GOLDEN = {
	richSummaries: {
		blocks: 74,
		sha256: "499df05d572ed7d5540d4c28f6a71dc86becf3ee42ff9432bc6293cec440886f",
	},
	untrackedSummaries: {
		blocks: 24,
		sha256: "31b881c9dac2b310dfb23d83cabf7ce0064d04e156feb767c9adf38ba3c738a3",
	},
	serviceOutput: {
		frames: 47,
		sha256: "84369de38f6f1a1891f92331855cc7da556a973c30a3efe1e5410c5dd28d560d",
	},
}

/** Feeds summaries through a SpectrumService over a fake host: a default client and a source client with backfill. */
async function serviceOutput(summaries: readonly BlockSummary[]) {
	const h = makeService()
	await h.service.start()
	await h.service.acquire("rtl", "job:a")
	await h.service.subscribe("c-default", undefined)
	let epoch = 0
	let subscribed = false
	for (const [i, s] of summaries.entries()) {
		if (s.epoch !== epoch) {
			h.host().epoch(s.epoch, epoch === 0)
			epoch = s.epoch
		}
		h.host().summary({ ...s, stream: 0 }) // the fake engine reports stream 0
		h.advance(50)
		if (i === 30 && !subscribed) {
			subscribed = true
			await h.service.subscribe("c-source", {
				sourceId: "rtl",
				hz: 5,
				bins: 2048,
				backfillMs: 5_000,
			})
		}
	}
	await h.service.stop()
	return { profiles: h.profiles, frames: h.frames }
}

/** Built once at collection (outside any test's timeout): the pipeline runs are the slow part. */
const RICH = richScenario()
const UNTRACKED = untrackedScenario()

describe("WG11 TR goldens (frozen code)", () => {
	it("rich scenario block summaries are byte-identical with the new fields stripped", () => {
		const { summaries } = RICH
		expect(summaries).toHaveLength(GOLDEN.richSummaries.blocks)
		expect(sha256(JSON.stringify(stripTrackFields(summaries)))).toBe(
			GOLDEN.richSummaries.sha256,
		)
		// the scenario covers what it claims: bursts, images and two epochs on frame tracks
		const segs = summaries.flatMap(s => s.tracks)
		expect(segs.some(t => t.flags.burst)).toBe(true)
		expect(segs.some(t => t.flags.iqImage)).toBe(true)
		expect(new Set(summaries.map(s => s.epoch))).toEqual(new Set([1, 2, 3]))
		// WG11: tracked segments carry the fields, a spur track among them
		expect(segs.filter(t => t.trackId !== undefined).length).toBeGreaterThan(0)
		expect(segs.some(t => t.flags.spur === true)).toBe(true)
		expect(segs.some(t => t.flags.burst && t.trackId !== undefined)).toBe(true)
	})

	it("the comb masks only once verified under two centres, and the real tones stay tracks", () => {
		const { summaries } = RICH
		const offsets = (s: BlockSummary) =>
			s.tracks.map(t => (t.startHz + t.endHz) / 2 - s.centreHz)
		const has = (s: BlockSummary, hz: number) =>
			offsets(s).some(o => Math.abs(o - hz) <= 2_500)
		const toothHz = COMB_BINS.map(b => (b - 128 + 0.1) * 1_000)
		const byEpoch = (e: number) => summaries.filter(s => s.epoch === e)
		// one centre (epoch 1), then two (epoch 2): no line masks, every tooth is a track
		for (const s of [...byEpoch(1), ...byEpoch(2)])
			expect(s.masks.spurRanges).toEqual([])
		const lastOne = byEpoch(1).at(-1)!
		for (const hz of toothHz) expect(has(lastOne, hz)).toBe(true)
		// the real tones the comb fast path used to mask are tracks to the end of epoch 1
		for (const hz of [33_300, 60_500, -60_500])
			expect(has(lastOne, hz)).toBe(true)
		// epoch 3: verified, the teeth mask after its first block; the fresh tone stays a track
		const three = byEpoch(3)
		const masked = three.slice(1).filter(s => s.masks.spurRanges.length > 0)
		expect(masked.length).toBeGreaterThan(0)
		const quiet = three.at(-1)!
		expect(quiet.masks.spurRanges).toHaveLength(COMB_BINS.length)
		for (const hz of toothHz) expect(has(quiet, hz)).toBe(false)
		expect(has(quiet, 62_500)).toBe(true)
	})

	it("untracked segments (maxTracks 1) are byte-identical, fields and all", () => {
		const { summaries, harness } = UNTRACKED
		expect(summaries).toHaveLength(GOLDEN.untrackedSummaries.blocks)
		expect(harness.of("transient").length).toBeGreaterThan(0)
		const untracked = summaries
			.flatMap(s => s.tracks)
			.filter(t => t.trackId === undefined)
		expect(untracked.length).toBeGreaterThan(0)
		// an untracked segment is today's segment exactly: three keys, three flags
		for (const t of untracked) {
			expect(Object.keys(t)).toEqual(["startHz", "endHz", "flags"])
			expect(Object.keys(t.flags)).toEqual(["burst", "iqImage", "edge"])
		}
		expect(sha256(JSON.stringify(stripTrackFields(summaries)))).toBe(
			GOLDEN.untrackedSummaries.sha256,
		)
	})

	it("service frames (live, snapshot, backfill) are byte-identical with the new fields stripped and carry no scanner field without a lookup", async () => {
		const out = await serviceOutput(RICH.summaries)
		const text = JSON.stringify(out)
		expect(text).not.toContain('"scanner"')
		expect(out.frames.length).toBe(GOLDEN.serviceOutput.frames)
		expect(sha256(JSON.stringify(stripTrackFields(out)))).toBe(
			GOLDEN.serviceOutput.sha256,
		)
	})
})
