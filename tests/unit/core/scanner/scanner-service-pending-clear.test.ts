import { describe, expect, it, vi } from "vitest"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { PipelineEvent } from "../../../../src/core/spectrum/types.js"
import {
	feedTone,
	serviceHarness,
	tick,
} from "../../../mocks/scanner/service-fakes.js"

// WG15 DQ 1.5: a retune (the pipeline's epoch-started) drops that source's pending evidence.
describe("ScannerService pending clear on retune (DQ 1.5)", () => {
	it("clears the source's pending entries on epoch-started and on source removal", async () => {
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
		const store = (h.service as unknown as { store: DiscoveryStore }).store
		const clear = vi.spyOn(store, "clearPending")
		const engine = h.service.spectrum.engine("rtl")!
		const { epoch } = engine.currentEpoch()
		const events: PipelineEvent[] = [
			{
				kind: "epoch-started",
				epoch: epoch + 1,
				startSample: 0,
				settleMode: "none",
			},
		]
		;(engine as unknown as { onEvents(ev: PipelineEvent[]): void }).onEvents(
			events,
		)
		expect(clear).toHaveBeenCalledWith("rtl")
		await h.service.cancelJob(job.id)
		await h.service.stop()
	})
})
