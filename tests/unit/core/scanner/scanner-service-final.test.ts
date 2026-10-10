/**
 * S1-B final whole-branch review fixes (final-review-s1b.md): H4 restore after an outage, engine
 * tuning that follows the lease holder, and the minor lifecycle findings.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { ScanJob } from "@wavekit/api-types"
import type { ScannerSettings } from "../../../../src/core/scanner/types.js"
import {
	CENTRE,
	feedTone,
	serviceHarness,
	settled,
} from "../../../mocks/scanner/service-fakes.js"

type Harness = ReturnType<typeof serviceHarness>
/** Bound for state reached through I/O or the arbiter (vi.waitFor), never a fixed sleep. */
const WAIT = { timeout: 5_000, interval: 5 }
const noPassive = (s: ScannerSettings): void => {
	s.passive.enabled = false
}

const sweep = (priority: number) => ({
	sourceId: "rtl",
	mode: "sweep" as const,
	ranges: [{ startHz: 450_000_000, endHz: 450_200_000 }],
	priority,
	takeover: true,
	resume: { autoAfterIdleMs: null },
})

/** Feeds noise until the sweep leaves `starting` (its first own epoch needs samples after the retune). */
async function untilRunning(h: Harness, id: string, seed = 20): Promise<void> {
	for (let i = 0; i < 50 && h.service.getJob(id)?.state === "starting"; i++) {
		await settled(h.service)
		feedTone(h.fanout, 0.1, 0, 0, seed + i)
	}
	await settled(h.service)
}

const scannerFrequencyWrites = (h: Harness, from = 0): number[] =>
	h.tuner.sent
		.slice(from)
		.filter(c => c.origin === "scanner" && c.name === "set-frequency")
		.map(c => c.value)

/** Cancels a running sweep while its source is down: every tuner write fails. */
async function cancelDuringOutage(h: Harness): Promise<string> {
	h.sources.emit("payload-started", "rtl")
	const job = await h.service.createJob(sweep(50))
	await untilRunning(h, job.id)
	expect(h.tuner.states.get("rtl")!.frequency).not.toBe(CENTRE)
	h.sources.emit("disconnected", "rtl")
	await settled(h.service)
	expect(h.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
		state: "paused",
		reason: "source-down",
	})
	h.tuner.failAll = new Error("Source rtl is not connected")
	await h.service.cancelJob(job.id)
	await settled(h.service)
	expect(h.service.getJob(job.id)?.state).toBe("cancelled")
	expect(h.service.getJob(job.id)?.unrestorable).toContain("frequency")
	h.tuner.failAll = null
	return job.id
}

describe("ScannerService (S1-B final review)", () => {
	it("restores the snapshot on reconnect after a cancel from paused(source-down) (finding 1, H4)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		await cancelDuringOutage(h)
		const before = h.tuner.sent.length
		// The controller replays the scanner's last hop on reconnect (§ 10.3), then the payload starts.
		h.sources.emit("payload-started", "rtl")
		await vi.waitFor(
			() => expect(scannerFrequencyWrites(h, before)).toEqual([CENTRE]),
			WAIT,
		)
		expect(h.tuner.states.get("rtl")!.frequency).toBe(CENTRE)
		await h.service.stop()
	})

	it("keeps the recovery record of a deleted job and restores it after a restart (finding 1 ruling)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const id = await cancelDuringOutage(h)
		h.service.deleteJob(id)
		await h.service.stop()
		const file = JSON.parse(readFileSync(join(h.dir, "jobs.json"), "utf8")) as {
			jobs: { id: string }[]
			leases?: { jobId: string }[]
		}
		expect(file.jobs.map(j => j.id)).not.toContain(id)
		expect(file.leases).toMatchObject([
			{ jobId: id, snapshot: { frequency: CENTRE } },
		])
		const again = serviceHarness({ dir: h.dir, patch: noPassive })
		// The dongle kept the last hop across the restart.
		again.tuner.states.get("rtl")!.frequency = 450_100_000
		await again.service.start()
		again.sources.emit("payload-started", "rtl")
		await vi.waitFor(
			() => expect(scannerFrequencyWrites(again)).toEqual([CENTRE]),
			WAIT,
		)
		await again.service.stop()
	})
})
