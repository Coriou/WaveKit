import { describe, expect, it, vi } from "vitest"
import type * as ClassifierModule from "../../../../src/core/scanner/classify/classifier.js"
import type { Classification } from "../../../../src/core/scanner/types.js"
import type {
	PipelineEvent,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"
import {
	CENTRE,
	feedTone,
	serviceHarness,
	tick,
} from "../../../mocks/scanner/service-fakes.js"

// S1 classifies every track at the spectral tier. Pretend the classifier reached the channel tier
// (Task 41), so the § 4.7 crediting rule has something to pull down.
vi.mock(
	"../../../../src/core/scanner/classify/classifier.js",
	async importOriginal => {
		const actual = await importOriginal<typeof ClassifierModule>()
		return {
			...actual,
			classifySpectral: (
				...args: Parameters<typeof actual.classifySpectral>
			): Classification => ({
				...actual.classifySpectral(...args),
				tier: "channel",
			}),
		}
	},
)

describe("ScannerService trust crediting (§ 4.7)", () => {
	it("credits a track of an untracked-retune (unverified) epoch only at the spectral tier", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		const job = await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [{ startHz: 446_000_000, endHz: 446_300_000 }],
		})
		for (
			let i = 0;
			i < 50 && h.service.getJob(job.id)?.state !== "running";
			i++
		) {
			await tick(5)
			feedTone(h.fanout, 0.1, 0, 0, 40 + i)
		}
		expect(h.service.getJob(job.id)?.state).toBe("running")
		const engine = h.service.spectrum.engine("rtl")!
		// What the pipeline delivers around its untracked-retune alarm (Task 10b): the alarm, the
		// unverified epoch's start, then tracks labelled with that epoch's trust.
		const deliver = (events: PipelineEvent[]) =>
			(engine as unknown as { onEvents(ev: PipelineEvent[]): void }).onEvents(
				events,
			)
		const { stream, epoch } = engine.currentEpoch()
		const track = (id: string, hz: number, over: Partial<TrackSnapshot>) => ({
			...makeTrack({ id, centreHz: hz, startedAt: 0 }),
			sourceId: "rtl",
			stream,
			...over,
		})
		deliver([
			{
				kind: "track-open",
				track: track("before", CENTRE + 50_000, { epoch }),
			},
		])
		const retuned = epoch + 10
		deliver([
			{
				kind: "untracked-retune",
				epoch: retuned,
				startSample: 0,
				deltaHz: 25_000,
			},
			{
				kind: "epoch-started",
				epoch: retuned,
				startSample: 0,
				settleMode: "none",
			},
		])
		expect(engine.currentEpoch()).toMatchObject({
			epoch: retuned,
			tuningTrust: "unverified",
		})
		deliver([
			{
				kind: "track-open",
				track: track("after", CENTRE + 120_000, {
					epoch: retuned,
					tuningTrust: "unverified",
				}),
			},
		])
		const live = (
			h.service as unknown as {
				live: Map<string, { classification: Classification }>
			}
		).live
		expect(live.get("t-before")?.classification.tier).toBe("channel")
		expect(live.get("t-after")?.classification.tier).toBe("spectral")
		await h.service.cancelJob(job.id)
		await h.service.stop()
	})
})
