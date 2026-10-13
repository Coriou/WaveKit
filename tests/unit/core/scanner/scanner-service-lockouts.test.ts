import { rm } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import type { ScanJob } from "@wavekit/api-types"
import type { ScanRange } from "../../../../src/core/scanner/types.js"
import {
	CENTRE,
	feedTone,
	serviceHarness,
	tick,
} from "../../../mocks/scanner/service-fakes.js"

const OFFSET = 93_750
const PMR: ScanRange = {
	startHz: 446_000_000,
	endHz: 446_200_000,
	rasters: [{ spacingHz: 12_500, firstChannelHz: 446_006_250 }],
	obwHz: [9000],
}
const channels = (job: ScanJob): number =>
	job.plan.hops.reduce((a, h) => a + h.channelCount, 0)

describe("ScannerService: Ignore skips sweeps (WG2 req 12)", () => {
	it("replans live sweeps when a lockout is set, cleared or deleted, without touching the stored spec", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		try {
			await h.service.start()
			const win = await h.service.createJob({
				sourceId: "rtl",
				mode: "in-window",
				ranges: [{ startHz: 446_000_000, endHz: 446_300_000 }],
			})
			feedTone(h.fanout, 2, OFFSET)
			feedTone(h.fanout, 1, 0, 0, 12)
			await tick(1500)
			const d = h.service
				.listDiscoveries({})
				.items.find(x => Math.abs(x.frequencyHz - (CENTRE + OFFSET)) < 2_000)
			expect(d).toBeDefined()
			await h.service.cancelJob(win.id)

			const job = await h.service.createJob({
				sourceId: "rtl",
				mode: "sweep",
				ranges: [PMR],
				takeover: true,
				resume: { autoAfterIdleMs: null },
			})
			const before = h.service.getJob(job.id)!
			expect("lockoutExclusions" in before).toBe(false)
			const events: ScanJob[] = []
			h.service.on("job", (dto: ScanJob) => {
				if (dto.id === job.id) events.push(dto)
			})

			await h.service.patchDiscovery(d!.id, { lockout: true })
			const locked = h.service.getJob(job.id)!
			expect(locked.lockoutExclusions).toHaveLength(1)
			const [x] = locked.lockoutExclusions!
			expect(x).toMatchObject({ discoveryId: d!.id, applied: true })
			expect(x!.startHz).toBeLessThanOrEqual(d!.frequencyHz)
			expect(x!.endHz).toBeGreaterThanOrEqual(d!.frequencyHz)
			expect(channels(locked)).toBe(channels(before) - 1)
			expect(locked.spec).toEqual(before.spec)
			expect(locked.spec.exclusions).toEqual([])
			expect(events.at(-1)?.lockoutExclusions).toEqual(locked.lockoutExclusions)
			// The preview of the same spec shows the lockout too.
			expect(
				h.service.preview({ sourceId: "rtl", mode: "sweep", ranges: [PMR] })
					.lockoutExclusions,
			).toEqual(locked.lockoutExclusions)
			// A patch of another key keeps the lockout (same plan path).
			const patched = await h.service.patchJob(job.id, { thresholdDb: 9 })
			expect(patched.job.lockoutExclusions).toEqual(locked.lockoutExclusions)

			// Setting it again changes nothing: no replan, no event.
			const count = events.length
			await h.service.patchDiscovery(d!.id, { lockout: true, label: "x" })
			expect(events.length).toBe(count)

			// 12.5: clearing restores the plan.
			await h.service.patchDiscovery(d!.id, { lockout: false })
			const cleared = h.service.getJob(job.id)!
			expect("lockoutExclusions" in cleared).toBe(false)
			expect(cleared.plan).toEqual(before.plan)
			expect(channels(cleared)).toBe(channels(before))

			// Restored jobs plan with the lockouts; deleting a locked discovery drops its exclusion.
			await h.service.patchDiscovery(d!.id, { lockout: true })
			expect(h.service.getJob(job.id)!.lockoutExclusions).toHaveLength(1)
			await h.service.stop()
			const again = serviceHarness({
				dir: h.dir,
				patch: s => {
					s.passive.enabled = false
				},
			})
			await again.service.start()
			try {
				const restored = again.service.getJob(job.id)!
				expect(restored.state).not.toBe("failed")
				expect(restored.lockoutExclusions).toEqual(locked.lockoutExclusions)
				expect(restored.spec.exclusions).toEqual([])
				await again.service.deleteDiscovery(d!.id)
				expect("lockoutExclusions" in again.service.getJob(job.id)!).toBe(false)
			} finally {
				await again.service.stop()
			}
		} finally {
			await rm(h.dir, { recursive: true, force: true })
		}
	}, 20_000)
})
