import { describe, expect, it, vi } from "vitest"
import { CaptureRecorder } from "../../../../src/core/scanner/evidence/capture-recorder.js"
import {
	feedTone,
	serviceHarness,
	tick,
} from "../../../mocks/scanner/service-fakes.js"

const RANGE = [{ startHz: 446_000_000, endHz: 446_300_000 }]

describe("ScannerService burst capture wiring", () => {
	it("opens a capture for a track covered by a capture-enabled job", async () => {
		const open = vi.spyOn(CaptureRecorder.prototype, "open")
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		try {
			await h.service.start()
			const job = await h.service.createJob({
				sourceId: "rtl",
				mode: "in-window",
				ranges: RANGE,
				capture: { enabled: true, preMs: 200, postMs: 100 },
			})
			feedTone(h.fanout, 2, 93_750)
			await tick(1000)
			expect(open).toHaveBeenCalledWith(
				expect.objectContaining({
					jobId: job.id,
					sourceId: "rtl",
					spec: expect.objectContaining({
						enabled: true,
						preMs: 200,
						postMs: 100,
					}),
				}),
			)
			await h.service.stop()
		} finally {
			open.mockRestore()
		}
	})

	it("keeps a closed burst as a listed capture and holds the pre-roll in the ring", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		try {
			await h.service.start()
			await h.service.createJob({
				sourceId: "rtl",
				mode: "in-window",
				ranges: RANGE,
				capture: {
					enabled: true,
					preMs: 4000,
					postMs: 100,
					onlyDecoded: false,
				},
			})
			feedTone(h.fanout, 1, 93_750)
			feedTone(h.fanout, 3.5, 93_750, 0)
			await tick(500)
			const captures = h.service.listCaptures()
			expect(captures).toHaveLength(1)
			const c = captures[0]!
			expect(c).toMatchObject({
				sourceId: "rtl",
				mode: "wideband",
				decoded: false,
				sampleRateHz: 1_024_000,
				postTruncated: false,
			})
			expect(h.service.capturePath(c.id, "cu8")).not.toBeNull()
			expect(h.service.capturePath(c.id, "json")).not.toBeNull()
			// ringSeconds is 3 s; a 4 s pre-roll keeps 5 s.
			const engine = h.service.spectrum.engine("rtl")!
			const edge = engine.liveEdge()
			expect(engine.readRing(0, edge)?.startSample).toBe(0)
			expect(edge).toBeGreaterThan(4 * 1_024_000)
			await h.service.stop()
		} finally {
			await h.service.stop()
		}
	}, 30_000)

	it("opens none when no covering job has capture enabled", async () => {
		const open = vi.spyOn(CaptureRecorder.prototype, "open")
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		try {
			await h.service.start()
			await h.service.createJob({
				sourceId: "rtl",
				mode: "in-window",
				ranges: RANGE,
			})
			feedTone(h.fanout, 2, 93_750)
			await tick(1000)
			expect(open).not.toHaveBeenCalled()
			await h.service.stop()
		} finally {
			open.mockRestore()
		}
	})
})
