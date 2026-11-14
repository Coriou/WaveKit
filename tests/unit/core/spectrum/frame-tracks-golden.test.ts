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
import { FS } from "../../../mocks/scanner/service-fakes.js"

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
 * epochs 2 and 3 now accepted from their first block. The rich goldens were recorded again when a
 * verified mask began to lift only for energy on its own footprint: in epoch 3 (blocks 65 and 68)
 * a burst two bins past comb tooth 136 no longer lifts the tooth, so the burst's track starts at
 * its own edge and the floor moves slightly.
 */
const GOLDEN = {
	richSummaries: {
		blocks: 74,
		sha256: "d61416089c199dabb642998ccf76657c1b86bc9db67542c68824784f4fb1f37b",
	},
	untrackedSummaries: {
		blocks: 24,
		sha256: "31b881c9dac2b310dfb23d83cabf7ce0064d04e156feb767c9adf38ba3c738a3",
	},
	/**
	 * The rich scenario's service output (three epochs, see frame-tracks-harness), with trust from
	 * the tuning ledger: byte-identical to the same scenario under the earlier tuner-state trust
	 * rule (26b9e88539a51c0ed4f36785adf4716a5ea6f011565b8b9b60465b700dc0702c) except the
	 * `tuningTrust` of eight live frames, the first four after each of the two retunes, now
	 * `unverified` where that rule said `commanded`. The engine reads a summary's block at its own
	 * block length, 50 ms at the caps rate (51 200 samples at 1.024 Msps), but the fixture's
	 * summaries were recorded at 256 ksps, 12 800 samples apart: each block the engine reads back
	 * spans the three summaries before it too, so the first four of an epoch reach before the
	 * retune's receipt (written at the epoch's first sample) and the ledger proves the old centre
	 * there. Every other frame stays `commanded`.
	 */
	serviceOutput: {
		frames: 47,
		sha256: "96f172c33483ddcfd1a578246c8d0d886b4e691adef5432292ef04ca5dd78113",
	},
}

/** Feeds summaries through a SpectrumService over a fake host: a default client and a source client with backfill. */
async function serviceOutput(summaries: readonly BlockSummary[]) {
	// The receiver was told the centre and the rate the summaries were measured at (ledger receipts settled before the engine's first byte); each summary's
	// payload is forwarded before it (the fake host gets no bytes), and a centre change is written
	// at its epoch's first sample. The fake link has no in-flight delay (settle 0).
	const h = makeService({
		proven: { rateHz: summaries[0]!.sampleRateHz, settleMs: 0 },
	})
	const ledger = h.receiverLedger!
	// Payload other consumers took after the proof and before the engine opened: one engine block
	// (50 ms at the caps rate), so a first block's lower bound still lies after the receipts.
	ledger.advance(ledger.bps * Math.round((FS * 50) / 1000))
	const opened = ledger.ledger.position("rtl")!.pos
	const forward = (endSample: number) => {
		const need =
			opened + ledger.bps * endSample - ledger.ledger.position("rtl")!.pos
		if (need > 0) ledger.advance(need)
	}
	await h.service.start()
	await h.service.acquire("rtl", "job:a")
	await h.service.subscribe("c-default", undefined)
	let epoch = 0
	let prevEnd = 0
	let subscribed = false
	for (const [i, s] of summaries.entries()) {
		if (s.epoch !== epoch) {
			if (epoch !== 0) {
				forward(prevEnd)
				ledger.write("set-frequency", s.centreHz, "operator")
			}
			h.host().epoch(s.epoch, epoch === 0)
			epoch = s.epoch
		}
		prevEnd = s.endSample
		forward(s.endSample)
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
