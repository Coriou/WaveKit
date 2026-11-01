import { describe, expect, it } from "vitest"
import type {
	BlockSummary,
	PipelineConfig,
	PipelineEvent,
} from "../../../../src/core/spectrum/types.js"
import { CENTRE } from "../../../mocks/scanner/service-fakes.js"
import { makeService } from "./frame-tracks-service-harness.js"

const BINS = 16

function summary(cfg: PipelineConfig, epoch: number, i: number): BlockSummary {
	const binHz = cfg.sampleRateHz / cfg.fftSize
	return {
		sourceId: cfg.sourceId,
		stream: 0,
		epoch,
		endSample: i,
		centreHz: CENTRE,
		sampleRateHz: cfg.sampleRateHz,
		binHz,
		startHz: CENTRE - (BINS / 2) * binHz,
		bins: Array.from({ length: BINS }, (_, b) => (b === 3 ? -20 : -80)),
		floorDbfs: -80,
		thresholdDb: 10,
		tracks: [],
		masks: { dcHz: CENTRE, dcGuardHz: 1500, spurRanges: [] },
		floorOccupied: false,
		overload: false,
	}
}

/**
 * The spectrum feed (block summaries with bins) stays on while no display client is subscribed:
 * the scanner reads summary bins (PSD evidence, spectrum identify) and every block (activity,
 * drivers), occupancy history reads summary tracks, and a late subscriber's backfill and the
 * status `latestFrame` read the summary ring. Only the per-client frame build is skipped.
 */
describe("spectrum feed with and without display clients", () => {
	it("stays enabled across subscribe and unsubscribe; summaries reach consumers with no client", async () => {
		const h = makeService()
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		const feeds = () =>
			h
				.host()
				.inputs.flatMap(i => (i.kind === "spectrum-feed" ? [i.enabled] : []))
		expect(feeds()).toEqual([true])
		const seen: PipelineEvent["kind"][] = []
		h.service.on("pipeline", (_id: string, ev: PipelineEvent) =>
			seen.push(ev.kind),
		)
		h.host().epoch(1, true)
		for (let i = 0; i < 40; i++) {
			h.host().summary(summary(h.host().cfg, 1, i))
			h.advance(50)
		}
		// no client: the scanner and occupancy still see every block, no frame is built
		expect(seen.filter(k => k === "block-summary")).toHaveLength(40)
		expect(h.frames).toHaveLength(0)

		await h.service.subscribe("c-source", {
			sourceId: "rtl",
			hz: 5,
			bins: 128,
			backfillMs: 1_000,
		})
		const profile = h.profiles.find(p => p.clientId === "c-source")
		// the ring filled while nobody watched: the late subscriber gets its backfill
		expect(profile?.backfill.length).toBeGreaterThan(0)
		for (let i = 40; i < 50; i++) {
			h.host().summary(summary(h.host().cfg, 1, i))
			h.advance(50)
		}
		expect(h.frames.length).toBeGreaterThan(0)

		await h.service.unsubscribe("c-source")
		const framesAfter = h.frames.length
		for (let i = 50; i < 60; i++) {
			h.host().summary(summary(h.host().cfg, 1, i))
			h.advance(50)
		}
		expect(h.frames).toHaveLength(framesAfter)
		expect(seen.filter(k => k === "block-summary")).toHaveLength(60)
		expect(feeds()).toEqual([true])
		await h.service.stop()
	})
})
