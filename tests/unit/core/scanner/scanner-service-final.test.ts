/**
 * S1-B final whole-branch review fixes (final-review-s1b.md): H4 restore after an outage, engine
 * tuning that follows the lease holder, and the minor lifecycle findings.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { ScanJob } from "@wavekit/api-types"
import { ArbiterFakeTuner } from "../../../mocks/scanner/arbiter-fakes.js"
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

const holderOf = (h: Harness): string | undefined =>
	(
		h.service as unknown as {
			arbiter: { holder(id: string): { jobId: string } | undefined }
		}
	).arbiter.holder("rtl")?.jobId

/** Runs `during` while stop() awaits the capture recorder (after the drivers were disposed). */
function duringStop(h: Harness, during: () => Promise<void>): void {
	const internals = h.service as unknown as {
		recorder: { stop(): Promise<void> }
	}
	const stop = internals.recorder.stop.bind(internals.recorder)
	internals.recorder.stop = async () => {
		await during()
		await stop()
	}
}

const passiveSettled = (h: Harness): Promise<void> =>
	(h.service as unknown as { passiveChain: Promise<void> }).passiveChain

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

	it("frees a preempted-job waiter's decoders when the preemptor loses the lease to the operator (finding 3)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const a = await h.service.createJob(sweep(30))
		await untilRunning(h, a.id)
		const b = await h.service.createJob(sweep(60))
		await untilRunning(h, b.id, 40)
		expect(h.service.getJob(a.id)?.reason).toBe("preempted-job")
		expect([...(h.decoders.held.get("rtl") ?? [])].sort()).toEqual(
			[a.id, b.id].sort(),
		)
		h.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
		await settled(h.service)
		expect(h.service.getJob(b.id)?.reason).toBe("preempted-operator")
		expect(h.service.getJob(a.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "preempted-job",
		})
		// No sweep holds the tuner and the operator owns it: configured decoders run again.
		expect(h.decoders.isSourceHeld("rtl")).toBe(false)
		// The preemptor ends: the lease goes back to A, which holds the decoders again.
		await h.service.cancelJob(b.id)
		await settled(h.service)
		expect(h.service.getJob(a.id)?.state).toBe("running")
		expect([...(h.decoders.held.get("rtl") ?? [])]).toEqual([a.id])
		await h.service.stop()
	})

	it("answers every SCANNER_SOURCE_BUSY with details.reason (finding 4)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const high = await h.service.createJob(sweep(60))
		await untilRunning(h, high.id)
		await expect(h.service.createJob(sweep(30))).rejects.toMatchObject({
			statusCode: 409,
			code: "SCANNER_SOURCE_BUSY",
			details: { reason: "held", holderJobId: high.id },
		})
		await expect(
			h.service.identify({
				sourceId: "rtl",
				target: { frequencyHz: 450_100_000 },
			}),
		).rejects.toMatchObject({
			code: "SCANNER_SOURCE_BUSY",
			details: { reason: "held", holderJobId: high.id },
		})
		// A relay client: the preview refuses.
		h.tuner.setControl("rtl", "external")
		await settled(h.service)
		await expect(h.service.createJob(sweep(90))).rejects.toMatchObject({
			code: "SCANNER_SOURCE_BUSY",
			details: { reason: "relay" },
		})
		h.tuner.setControl("rtl", "internal")
		await h.service.stop()
		// A higher-priority sweep while the holder is still starting (markers and no samples).
		const m = serviceHarness({
			patch: s => {
				s.passive.enabled = false
				s.sweep.markers = true
			},
		})
		await m.service.start()
		const starting = await m.service.createJob(sweep(40))
		await settled(m.service)
		expect(m.service.getJob(starting.id)?.state).toBe("starting")
		await expect(m.service.createJob(sweep(90))).rejects.toMatchObject({
			code: "SCANNER_SOURCE_BUSY",
			details: { reason: "holder-starting", holderJobId: starting.id },
		})
		await m.service.stop()
	})

	it("emits nothing more for a job deleted before its teardown finished (finding 4)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const job = await h.service.createJob(sweep(50))
		await untilRunning(h, job.id)
		// The caps never show the restored tuning: the teardown waits for them (bounded, 1 s).
		h.tuner.setFrequency = (sourceId, hz, opts) =>
			ArbiterFakeTuner.prototype.setFrequency.call(h.tuner, sourceId, hz, opts)
		const events: string[] = []
		h.service.on("job", (j: ScanJob) => events.push(`${j.id}:${j.state}`))
		const cancelled = h.service.cancelJob(job.id)
		await vi.waitFor(
			() => expect(h.service.getJob(job.id)?.state).toBe("cancelled"),
			WAIT,
		)
		h.service.deleteJob(job.id)
		const deletedAt = events.length
		await cancelled
		await settled(h.service)
		expect(events.slice(deletedAt)).toEqual([])
		await h.service.stop()
	})

	it("needs takeover to resume a lease-less operator pause when the impact grew (finding 8)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const job = await h.service.createJob(sweep(50))
		await untilRunning(h, job.id)
		await h.service.pauseJob(job.id)
		h.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
		await settled(h.service)
		expect(h.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "operator",
		})
		// The operator started a decoder on the source after taking the tuner.
		h.decoders.getAllStatus = () =>
			[
				{
					id: "dmr-1",
					sourceId: "rtl",
					running: true,
					suspended: false,
					startMode: "auto",
				},
			] as never
		await expect(
			h.service.resumeJob(job.id, { takeover: false }),
		).rejects.toMatchObject({
			statusCode: 409,
			code: "SCANNER_TAKEOVER_REQUIRED",
			details: { impact: { runningDecoders: ["dmr-1"] } },
		})
		expect(h.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "operator",
		})
		await h.service.resumeJob(job.id, { takeover: true })
		expect(h.service.getJob(job.id)?.state).toBe("running")
		await h.service.stop()
	})

	it("runs no boot resume when the source reconnects while stop() runs (finding 5)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const job = await h.service.createJob({
			...sweep(50),
			resume: { autoAfterIdleMs: null, onBoot: true },
		})
		await untilRunning(h, job.id)
		await h.service.stop()
		const again = serviceHarness({ dir: h.dir, patch: noPassive })
		await again.service.start()
		expect(again.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "core-restart",
		})
		duringStop(again, async () => {
			again.sources.emit("payload-started", "rtl")
			await settled(again.service)
		})
		const before = again.tuner.sent.length
		await again.service.stop()
		await settled(again.service)
		expect(holderOf(again)).toBeUndefined()
		expect(again.decoders.isSourceHeld("rtl")).toBe(false)
		expect(again.service.spectrum.engine("rtl")).toBeUndefined()
		expect(scannerFrequencyWrites(again, before)).toEqual([])
		expect(again.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "core-restart",
		})
	})

	it("starts no passive job once stop() began (finding 5)", async () => {
		const h = serviceHarness()
		await h.service.start()
		await h.service.patchSettings({ passive: { rtl: false } })
		expect(h.service.getJob("passive-rtl")).toBeUndefined()
		duringStop(h, async () => {
			await h.service.patchSettings({ passive: { rtl: true } })
			await passiveSettled(h)
		})
		await h.service.stop()
		expect(h.service.getJob("passive-rtl")).toBeUndefined()
		expect(h.service.spectrum.engine("rtl")).toBeUndefined()
	})

	it("never rebuilds a removed source's passive job on caps changes, and does once it connects again (finding 6)", async () => {
		const h = serviceHarness()
		await h.service.start()
		await vi.waitFor(
			() => expect(h.service.getJob("passive-rtl")?.state).toBe("running"),
			WAIT,
		)
		h.sources.emit("source-removed", "rtl")
		await settled(h.service)
		expect(h.service.getJob("passive-rtl")?.state).toBe("failed")
		h.sources.setCaps("rtl", { centerFreq: CENTRE + 25_000 })
		await passiveSettled(h)
		await settled(h.service)
		expect(h.service.getJob("passive-rtl")?.state ?? "none").not.toMatch(
			/^(pending|starting|running)$/,
		)
		expect(h.service.spectrum.engine("rtl")).toBeUndefined()
		h.sources.emit("connected", "rtl")
		await vi.waitFor(
			() => expect(h.service.getJob("passive-rtl")?.state).toBe("running"),
			WAIT,
		)
		await h.service.stop()
	})

	it("ignores the caps changes of its own sweep hops for passive jobs (finding 6)", async () => {
		const h = serviceHarness()
		await h.service.start()
		await vi.waitFor(
			() => expect(h.service.getJob("passive-rtl")?.state).toBe("running"),
			WAIT,
		)
		const ensure = vi.spyOn(
			h.service as unknown as { ensurePassiveJobs(): Promise<void> },
			"ensurePassiveJobs",
		)
		const job = await h.service.createJob(sweep(50))
		await untilRunning(h, job.id)
		expect(h.tuner.states.get("rtl")!.frequency).not.toBe(CENTRE)
		expect(ensure).not.toHaveBeenCalled()
		await h.service.stop()
	})

	it("merges a PATCH into the operator's spec: derived fields follow and keep honest provenance (finding 7)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const job = await h.service.createJob(sweep(50))
		await untilRunning(h, job.id)
		expect(job.spec.integrationMs).toBe(50)
		const { job: patched } = await h.service.patchJob(job.id, {
			sensitivity: "high",
		})
		expect(patched.spec).toMatchObject({
			mode: "sweep",
			sourceId: "rtl",
			sensitivity: "high",
			integrationMs: 100,
		})
		expect(patched.spec.provenance).toMatchObject({
			sensitivity: "operator",
			integrationMs: "default",
			dwellMs: "default",
			"hold.policy": "default",
		})
		// The lease holder's engine follows its new integration (finding 2).
		expect(engineConfig(h)?.integrationMs).toBe(100)
		await h.service.stop()
	})

	it("needs takeover to resume a lease-less operator pause that would take the lease from a lower-priority sweep (re-review R1)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const p = await h.service.createJob(sweep(80))
		await untilRunning(h, p.id)
		await h.service.pauseJob(p.id)
		h.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
		await settled(h.service)
		expect(holderOf(h)).toBeUndefined()
		const q = await h.service.createJob(sweep(50))
		await untilRunning(h, q.id, 40)
		expect(holderOf(h)).toBe(q.id)
		await expect(
			h.service.resumeJob(p.id, { takeover: false }),
		).rejects.toMatchObject({
			statusCode: 409,
			code: "SCANNER_TAKEOVER_REQUIRED",
			details: { impact: { scannerJobs: [q.id] } },
		})
		expect(h.service.getJob(p.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "operator",
		})
		expect(holderOf(h)).toBe(q.id)
		await h.service.resumeJob(p.id, { takeover: true })
		await settled(h.service)
		expect(h.service.getJob(p.id)?.state).toBe("running")
		expect(holderOf(h)).toBe(p.id)
		expect(h.service.getJob(q.id)?.reason).toBe("preempted-job")
		await h.service.stop()
	})
})
