import { rm } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import type {
	ScannerDiscoveryEventData,
	ScannerProgressEventData,
} from "@wavekit/api-types"
import {
	CENTRE,
	feedTone,
	serviceHarness,
	settled,
	tick,
} from "../../../mocks/scanner/service-fakes.js"

const OFFSET = 93_750
const near = (hz: number): boolean => Math.abs(hz - (CENTRE + OFFSET)) < 2_000
const inWindow = {
	sourceId: "rtl",
	mode: "in-window" as const,
	ranges: [{ startHz: 446_000_000, endHz: 446_300_000 }],
}

describe("ScannerService per-job hit statistics (WG2 req 13)", () => {
	it("counts hits into progress, discovery events and the hits list; resets on start, keeps on resume, drops on delete", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		try {
			await h.service.start()
			const discoveries: ScannerDiscoveryEventData[] = []
			const progress: ScannerProgressEventData[] = []
			h.service.on("discovery", (e: ScannerDiscoveryEventData) =>
				discoveries.push(e),
			)
			h.service.on("progress", (e: ScannerProgressEventData) =>
				progress.push(e),
			)
			const job = await h.service.createJob(inWindow)
			expect(h.service.getJob(job.id)!.progress.hitStats).toEqual({
				discoveries: 0,
				hits: 0,
				newDiscoveries: 0,
				truncated: false,
			})
			feedTone(h.fanout, 2, OFFSET)
			feedTone(h.fanout, 1, 0, 0, 12)
			await tick(1500)
			const d = h.service
				.listDiscoveries({})
				.items.find(x => near(x.frequencyHz))
			expect(d).toBeDefined()

			const stats = h.service.getJob(job.id)!.progress.hitStats!
			expect(stats.hits).toBeGreaterThanOrEqual(1)
			expect(stats.newDiscoveries).toBeGreaterThanOrEqual(1)
			expect(stats.truncated).toBe(false)
			const list = h.service.jobHits(job.id, 100)
			expect(list.jobId).toBe(job.id)
			expect(list.stats).toEqual(stats)
			const mine = list.hits.find(x => x.discoveryId === d!.id)
			expect(mine).toMatchObject({
				jobId: job.id,
				discoveryId: d!.id,
				firstSeenInJob: true,
			})
			expect(list.hits.reduce((a, x) => a + x.hits, 0)).toBe(stats.hits)

			// The created event of the job's own observation carries its hit.
			const created = discoveries.find(
				e => e.change === "created" && e.discovery.id === d!.id,
			)
			expect(created?.jobHits).toEqual([
				expect.objectContaining({
					jobId: job.id,
					discoveryId: d!.id,
					firstSeenInJob: true,
				}),
			])
			// An operator edit is not caused by an observation: no jobHits.
			discoveries.length = 0
			await h.service.patchDiscovery(d!.id, { label: "x" })
			expect(discoveries.at(-1)?.jobHits).toBeUndefined()

			// Kept on pause and resume.
			await h.service.pauseJob(job.id)
			await h.service.resumeJob(job.id, { takeover: false })
			await settled(h.service)
			expect(h.service.getJob(job.id)!.progress.hitStats).toEqual(stats)
			const p = progress.filter(e => e.jobId === job.id).at(-1)
			expect(p).toBeDefined()
			expect(p!.hits).toBe(stats.hits)
			expect(p!.newDiscoveries).toBe(stats.newDiscoveries)

			// A new job starts at zero; hitting the known discovery is not "first seen" there.
			await h.service.cancelJob(job.id)
			const second = await h.service.createJob(inWindow)
			expect(h.service.jobHits(second.id, 100).stats.hits).toBe(0)
			feedTone(h.fanout, 2, OFFSET, 0.5, 31)
			feedTone(h.fanout, 1, 0, 0, 32)
			await tick(1500)
			const again = h.service
				.jobHits(second.id, 100)
				.hits.find(x => x.discoveryId === d!.id)
			expect(again).toBeDefined()
			expect(again!.firstSeenInJob).toBe(false)
			// The ended job keeps its counts until it is deleted.
			expect(h.service.jobHits(job.id, 100).stats).toEqual(stats)
			h.service.deleteJob(job.id)
			expect(() => h.service.jobHits(job.id, 100)).toThrow(
				expect.objectContaining({ code: "SCANNER_JOB_NOT_FOUND" }),
			)
			await h.service.stop()
		} finally {
			await rm(h.dir, { recursive: true, force: true })
		}
	}, 30_000)
})
