import { describe, expect, it } from "vitest"
import type { BlockSummary } from "../../../../src/core/spectrum/types.js"
import {
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
 */
const GOLDEN = {
	richSummaries: {
		blocks: 62,
		sha256: "950dbf910fc03e51b4eeed5bb05726222e6e7b1026a70acaee6b8d219bcb91c8",
	},
	untrackedSummaries: {
		blocks: 24,
		sha256: "31b881c9dac2b310dfb23d83cabf7ce0064d04e156feb767c9adf38ba3c738a3",
	},
	serviceOutput: {
		frames: 38,
		sha256: "65b0e9be20523fd82201f289ec773fff4b06387e426170dd8959d3c50ba1e2e8",
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
		expect(new Set(summaries.map(s => s.epoch))).toEqual(new Set([1, 2]))
		// WG11: tracked segments carry the fields, a spur track among them
		expect(segs.filter(t => t.trackId !== undefined).length).toBeGreaterThan(0)
		expect(segs.some(t => t.flags.spur === true)).toBe(true)
		expect(segs.some(t => t.flags.burst && t.trackId !== undefined)).toBe(true)
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
