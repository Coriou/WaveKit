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

const engineConfig = (h: Harness) => h.service.spectrum.engine("rtl")?.config()

/** The sweep scheduler's block geometry (private runner state). */
const schedulerBlocks = (h: Harness, jobId: string): number | undefined =>
	(
		h.service as unknown as {
			drivers: Map<
				string,
				{ scheduler: { blockGeometry(): { blockSamples: number } } | null }
			>
		}
	).drivers
		.get(jobId)
		?.scheduler?.blockGeometry().blockSamples

const blockSamplesOf = (cfg: {
	integrationMs: number
	sampleRateHz: number
	fftSize: number
}): number =>
	Math.max(
		1,
		Math.round((cfg.integrationMs * cfg.sampleRateHz) / (cfg.fftSize * 1000)),
	) * cfg.fftSize

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

	it("re-applies the holder's tuning on a hand-over and a hand-back, with the scheduler's block geometry (finding 2)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const a = await h.service.createJob(sweep(30))
		await untilRunning(h, a.id)
		expect(a.spec.integrationMs).toBe(50)
		expect(engineConfig(h)?.integrationMs).toBe(50)
		const b = await h.service.createJob({ ...sweep(60), sensitivity: "high" })
		expect(b.spec.integrationMs).toBe(100)
		await untilRunning(h, b.id, 40)
		expect(h.service.getJob(a.id)?.reason).toBe("preempted-job")
		expect(engineConfig(h)?.integrationMs).toBe(100)
		expect(schedulerBlocks(h, b.id)).toBe(blockSamplesOf(engineConfig(h)!))
		// B ends: the lease goes back to A, and so do A's integration and threshold.
		await h.service.cancelJob(b.id)
		await settled(h.service)
		expect(h.service.getJob(a.id)?.state).toBe("running")
		const cfg = engineConfig(h)!
		expect(cfg.integrationMs).toBe(50)
		expect(cfg.thresholdDb).toBeNull()
		expect(schedulerBlocks(h, a.id)).toBe(blockSamplesOf(cfg))
		await h.service.stop()
	})

	it("returns the engine to the default tuning when a sweep with thresholdDb ends (finding 2)", async () => {
		// The passive job keeps the engine up after the sweep.
		const h = serviceHarness()
		await h.service.start()
		await vi.waitFor(
			() => expect(h.service.getJob("passive-rtl")?.state).toBe("running"),
			WAIT,
		)
		const defaults = engineConfig(h)!
		const job = await h.service.createJob({
			...sweep(50),
			thresholdDb: 20,
			sensitivity: "high",
		})
		await untilRunning(h, job.id)
		expect(engineConfig(h)).toMatchObject({
			thresholdDb: 20,
			integrationMs: 100,
		})
		await h.service.cancelJob(job.id)
		await settled(h.service)
		expect(h.service.spectrum.engine("rtl")).toBeDefined()
		expect(engineConfig(h)).toMatchObject({
			thresholdDb: null,
			integrationMs: defaults.integrationMs,
			fftSize: defaults.fftSize,
			faTargetPerMhzMin: defaults.faTargetPerMhzMin,
		})
		await h.service.stop()
	})
})
