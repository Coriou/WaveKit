import { describe, expect, it } from "vitest"
import type { BlockSummary } from "../../../../src/core/spectrum/types.js"
import {
	COMB_BINS,
	combHz,
	EPOCH3_TOOTH_BURSTS_MS,
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
 * The rich scenario was rebuilt when spur masks began to need verification, and its goldens are
 * a new recording from the code of that change, no longer the frozen code's output: a weak
 * receiver comb under three centres (it masks in epoch 3), a third epoch, and the real tones the
 * old comb fast path had masked (33.3 and 60.5 kHz, the image) are tracks. Only the untracked
 * goldens are still the frozen code's. They were recorded again when unverified receiver lines
 * stopped causing stale discards after a retune: epochs 1 to 3 as before, epoch 1 byte-identical,
 * epochs 2 and 3 now accepted from their first block.
 */
const GOLDEN = {
	richSummaries: {
		blocks: 74,
		sha256: "e56e839f7e4abd7ac5823b9884d662ce8a17ea05f408687322f20f5343b39f95",
	},
	untrackedSummaries: {
		blocks: 24,
		sha256: "31b881c9dac2b310dfb23d83cabf7ce0064d04e156feb767c9adf38ba3c738a3",
	},
	serviceOutput: {
		frames: 47,
		sha256: "d9cff7e019c9138168cc07964f50167020693fd193e26b324b23c242f42fc8d1",
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
		// epoch 3: verified in its first block, every tooth masks from the second on, except the
		// tooth a burst lifts while it is on air (50 ms blocks: a burst at t ms is in block ⌊t/50⌋)
		const three = byEpoch(3)
		expect(three[0]!.masks.spurRanges).toEqual([])
		const burstBlocks = new Set(
			EPOCH3_TOOTH_BURSTS_MS.map(ms => Math.floor(ms / 50)),
		)
		for (const [i, s] of three.entries()) {
			if (i === 0) continue
			const lifted = burstBlocks.has(i) ? 1 : 0
			expect(s.masks.spurRanges).toHaveLength(COMB_BINS.length - lifted)
		}
		const quiet = three.at(-1)!
		const maskedHz = quiet.masks.spurRanges.map(
			r => (r.startHz + r.endHz) / 2 - quiet.centreHz,
		)
		expect(maskedHz).toHaveLength(toothHz.length)
		for (const [k, hz] of toothHz.entries())
			expect(Math.abs(maskedHz[k]! - hz)).toBeLessThanOrEqual(1_000)
		for (const hz of toothHz) expect(has(quiet, hz)).toBe(false)
		expect(has(quiet, 62_500)).toBe(true)
	})

	it("no block is stale-discarded: the harness feeds only the new centre after each retune", () => {
		// an unverified comb and the steady tones are receiver-line candidates at both retunes; the
		// stale check used to drop 20 blocks per retune for them (1 s, STALE_MAX_MS, of 50 ms blocks)
		expect(RICH.harness.of("stale-discard")).toEqual([])
		for (const e of [2, 3])
			expect(RICH.summaries.filter(s => s.epoch === e)).toHaveLength(12) // 0.6 s / 50 ms
	})

	it("a real tone in a verified tooth's slot stays a track while the tooth masks", () => {
		// 4 bins from the tooth at bin 56: inside its 13-bin slot (±6 bins), outside its ±1-bin
		// mask footprint. 10 dB per bin, like a tooth: slot level (13 + 2 × 1.5 × 10) / 13 ≈ 3.3,
		// +5.2 dB, under the 6 dB bound, so the tooth stays verified and quiet and keeps masking.
		const toneHz = combHz(56) + 4_000
		const { summaries } = richScenario(undefined, {}, undefined, {
			epoch3Tones: [{ hz: toneHz, perBinSnrDb: 10 }],
		})
		const quiet = summaries.filter(s => s.epoch === 3).at(-1)!
		const offsets = quiet.tracks.map(
			t => (t.startHz + t.endHz) / 2 - quiet.centreHz,
		)
		const maskedHz = quiet.masks.spurRanges.map(
			r => (r.startHz + r.endHz) / 2 - quiet.centreHz,
		)
		expect(maskedHz).toHaveLength(COMB_BINS.length)
		expect(maskedHz.some(o => Math.abs(o - combHz(56)) <= 1_000)).toBe(true)
		expect(offsets.some(o => Math.abs(o - toneHz) <= 1_000)).toBe(true)
		expect(offsets.some(o => Math.abs(o - combHz(56)) <= 1_000)).toBe(false)
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
