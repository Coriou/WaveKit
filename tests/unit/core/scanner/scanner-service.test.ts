import type { EventEmitter } from "node:events"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { ProbePool } from "../../../../src/core/scanner/probes/probe-pool.js"
import { probeRequest } from "../../../mocks/scanner/probe-fakes.js"
import type { JobRecord } from "../../../../src/core/scanner/job-runner.js"
import { ScannerLifecycleOwner } from "../../../../src/core/scanner/channel/consumer-lifecycle.js"
import {
	ScannerService,
	type ScannerServiceDeps,
} from "../../../../src/core/scanner/scanner-service.js"
import { ArbiterFakeTuner } from "../../../mocks/scanner/arbiter-fakes.js"
import type { ScanJob } from "@wavekit/api-types"
import {
	CENTRE,
	feedTone,
	feedTones,
	serviceHarness,
	settled,
	tick,
} from "../../../mocks/scanner/service-fakes.js"
import { meteredCheck } from "./passive-elu-fixture.js"

type Harness = ReturnType<typeof serviceHarness>
/** Bound for state reached through I/O or the arbiter (vi.waitFor), never a fixed sleep. */
const WAIT = { timeout: 5_000, interval: 5 }
const holderOf = (h: Harness): string | undefined =>
	(
		h.service as unknown as {
			arbiter: { holder(id: string): { jobId: string } | undefined }
		}
	).arbiter.holder("rtl")?.jobId

const sweep = (priority: number) => ({
	sourceId: "rtl",
	mode: "sweep" as const,
	ranges: [{ startHz: 450_000_000, endHz: 450_200_000 }],
	priority,
	takeover: true,
	resume: { autoAfterIdleMs: null },
})

/**
 * Feeds noise until the sweep leaves `starting` (its first own epoch needs samples after the
 * retune). Ruling R1: the lease is never handed over from a starting job, so tests that preempt
 * a sweep first let it run.
 */
async function untilRunning(h: Harness, id: string, seed = 20): Promise<void> {
	for (let i = 0; i < 50 && h.service.getJob(id)?.state === "starting"; i++) {
		await settled(h.service)
		feedTone(h.fanout, 0.1, 0, 0, seed + i)
	}
	await settled(h.service)
}

describe("ScannerService", () => {
	it("preserves external-control resume readiness while the arbiter owns refusal", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const job = await h.service.createJob(sweep(50))
		const inspected = h.service as unknown as {
			jobs: Map<string, JobRecord>
			arbiter: { operatorIdleSince(sourceId: string): number | null }
			autoResumeReady(record: JobRecord): boolean
		}
		const record = inspected.jobs.get(job.id)!
		record.state = "paused"
		record.reason = "preempted-operator"
		record.spec.resume.autoAfterIdleMs = 1000
		vi.spyOn(inspected.arbiter, "operatorIdleSince").mockReturnValue(null)
		expect(inspected.autoResumeReady(record)).toBe(true)
		await h.service.stop()
	})
	it("emits activity updates only when a job's resume view changes", async () => {
		const h = serviceHarness({ patch: noPassive })
		let changed = () => {}
		let audio = false
		const inspected = h.service as unknown as {
			deps: ScannerServiceDeps
			tick(): void
		}
		inspected.deps.operatorActivity = {
			current: () => ({ audio, recording: false }),
			onChange: cb => {
				changed = cb
				return () => {}
			},
		}
		await h.service.start()
		const job = await h.service.createJob({
			...sweep(50),
			resume: { autoAfterIdleMs: 1000 },
		})
		await untilRunning(h, job.id)
		const emitted: ScanJob[] = []
		h.service.on("job", (dto: ScanJob) => emitted.push(dto))
		changed()
		expect(emitted).toHaveLength(0)
		h.tuner.external("rtl", "set-frequency", 433920000, "rest")
		await settled(h.service)
		emitted.length = 0
		audio = true
		changed()
		expect(emitted.map(dto => dto.id)).toEqual([job.id])
		changed()
		expect(emitted).toHaveLength(1)
		await h.service.pauseJob(job.id)
		emitted.length = 0
		inspected.tick()
		emitted.length = 0
		audio = false
		changed()
		expect(emitted).toHaveLength(0)
		await h.service.stop()
	})
	it("holds automatic resume during operator audio and restarts full idle after hang", async () => {
		const h = serviceHarness({ patch: noPassive })
		let clock = Date.now()
		let audio = true
		let changed = () => {}
		let removed = false
		const inspected = h.service as unknown as {
			deps: ScannerServiceDeps
			now: () => number
		}
		inspected.now = () => clock
		inspected.deps.operatorActivity = {
			current: () => ({ audio, recording: false, sourceId: "rtl" }),
			onChange: cb => {
				changed = cb
				return () => {
					removed = true
				}
			},
		}
		await h.service.start()
		const job = await h.service.createJob({
			...sweep(50),
			resume: { autoAfterIdleMs: 1000 },
		})
		await untilRunning(h, job.id)
		h.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
		await settled(h.service)
		clock += 10000
		changed()
		expect(h.service.getJob(job.id)).toMatchObject({
			reason: "preempted-operator",
			resumeAt: null,
			resumeHeldBy: "audio",
		})
		audio = false
		changed()
		clock += 3000
		expect(h.service.getJob(job.id)?.resumeAt).toBe(
			new Date(clock + 1000).toISOString(),
		)
		clock += 999
		await tick(30)
		expect(h.service.getJob(job.id)?.state).toBe("paused")
		clock += 1
		await vi.waitFor(
			() => expect(h.service.getJob(job.id)?.state).toBe("running"),
			WAIT,
		)
		await h.service.stop()
		expect(removed).toBe(true)
	})
	it("Stay here without the lease persists as operator pause rather than boot auto-resume", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const job = await h.service.createJob({
			...sweep(50),
			resume: { autoAfterIdleMs: 1000, onBoot: true },
		})
		await untilRunning(h, job.id)
		h.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
		await settled(h.service)
		const stayed = await h.service.pauseJob(job.id)
		expect(stayed).toMatchObject({
			state: "paused",
			reason: "operator",
			resumeAt: null,
			resumeHeldBy: null,
		})
		expect(holderOf(h)).toBeUndefined()
		await h.service.stop()
		const restored = serviceHarness({ dir: h.dir, patch: noPassive })
		await restored.service.start()
		expect(restored.service.getJob(job.id)).toMatchObject({
			state: "paused",
			reason: "operator",
			resumeAt: null,
		})
		await restored.service.resumeJob(job.id, { takeover: true })
		expect(restored.service.getJob(job.id)?.state).toBe("running")
		expect(holderOf(restored)).toBe(job.id)
		expect(restored.service.status().engines.length).toBeGreaterThan(0)
		await vi.waitFor(
			() =>
				expect(
					restored.tuner.sent.some(
						command =>
							command.name === "set-frequency" &&
							command.value >= 450000000 &&
							command.value <= 450200000,
					),
				).toBe(true),
			WAIT,
		)
		await restored.service.stop()
	}, 20_000)

	it("phase40 preserves a channel component UNKNOWN and attempts every subscription remover", async () => {
		const h = serviceHarness()
		const original = new Error("first remover unavailable")
		const failedOff = vi.fn(() => {
			throw original
		})
		const siblingOff = vi.fn()
		const actualDrain = vi.fn()
		let started = false
		const actualOutcome = Promise.resolve({
			ok: false as const,
			state: "unknown" as const,
			detail: "Actual channel filesystem cleanup unknown",
		})
		const component = {
			sealAdmission: vi.fn(),
			stop: vi.fn(() => {
				if (!started) {
					started = true
					actualDrain()
				}
				return actualOutcome
			}),
			sweepSettledReferences: vi.fn(),
		}
		// Component boundary fixture only; these outcomes do not manufacture native proof.
		const boundary = h.service as unknown as {
			channelTaps: typeof component
			channelSubscriptions: (() => void)[]
		}
		boundary.channelTaps = component
		boundary.channelSubscriptions.push(failedOff, siblingOff)
		const handle = h.service.beginStop()
		await expect(handle.producerSettled).rejects.toMatchObject({
			message: "Actual channel filesystem cleanup unknown",
		})
		// Two independent phase slots request the same real component's cached first drain.
		expect(component.stop).toHaveBeenCalledTimes(2)
		expect(actualDrain).toHaveBeenCalledOnce()
		expect(failedOff).toHaveBeenCalledOnce()
		expect(siblingOff).toHaveBeenCalledOnce()
		expect(boundary.channelSubscriptions).toEqual([failedOff])
		await expect(h.service.finalizeStopNative()).rejects.toMatchObject({
			message: "Actual channel filesystem cleanup unknown",
		})
	})

	it("creates the passive job and credits one emission to every covering in-window job", async () => {
		const h = serviceHarness()
		await h.service.start()
		const op = await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [{ startHz: 446_000_000, endHz: 446_300_000 }],
		})
		feedTone(h.fanout, 2, 93_750)
		feedTone(h.fanout, 1, 0, 0, 12) // noise only: the track closes and is ingested
		await tick(1500)
		const items = h.service.listDiscoveries({}).items
		const near = items.filter(
			d => Math.abs(d.frequencyHz - (CENTRE + 93_750)) < 2_000,
		)
		expect(near).toHaveLength(1)
		expect(near[0]!.jobIds.sort()).toEqual([op.id, "passive-rtl"].sort())
		// in-window jobs never command the tuner (P5)
		expect(h.tuner.sent.filter(c => c.origin === "scanner")).toEqual([])
		await h.service.stop()
	}, 20_000)

	it("restores the tuner at shutdown and pauses the job with core-restart on the next boot", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		const job = await h.service.createJob(sweep(50))
		await settled(h.service)
		expect(h.tuner.states.get("rtl")!.frequency).not.toBe(CENTRE)
		await h.service.stop()
		const writes = h.tuner.sent
			.filter(c => c.origin === "scanner")
			.map(c => [c.name, c.value])
		expect(writes.at(-1)).toEqual(["set-frequency", CENTRE])
		// the shutdown restore cleared the persisted lease: a reboot writes nothing on payload-started
		const again = serviceHarness({
			dir: h.dir,
			patch: s => {
				s.passive.enabled = false
			},
		})
		await again.service.start()
		expect(again.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "core-restart",
		})
		const before = again.tuner.sent.length
		again.sources.emit("payload-started", "rtl")
		await tick(10)
		expect(again.tuner.sent.slice(before)).toEqual([])
		await again.service.stop()
	})

	it("disables a source's passive job at runtime and keeps it disabled after a restart", async () => {
		const h = serviceHarness()
		await h.service.start()
		expect(h.service.listJobs().map(j => j.id)).toContain("passive-rtl")
		const view = await h.service.patchSettings({ passive: { rtl: false } })
		expect(view.passiveBySource["rtl"]).toBe(false)
		expect(view.provenance["passiveBySource.rtl"]).toBe("runtime")
		expect(h.service.listJobs().map(j => j.id)).not.toContain("passive-rtl")
		await h.service.stop()
		expect(existsSync(join(h.dir, "settings.json"))).toBe(true)
		const again = serviceHarness({ dir: h.dir })
		await again.service.start()
		expect(again.service.listJobs().map(j => j.id)).not.toContain("passive-rtl")
		await again.service.stop()
	})

	it("refuses a sweep that would disturb consumers without takeover", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [{ startHz: 446_000_000, endHz: 446_200_000 }],
		})
		await expect(
			h.service.createJob({ ...sweep(50), takeover: false }),
		).rejects.toMatchObject({
			statusCode: 409,
			code: "SCANNER_TAKEOVER_REQUIRED",
		})
		await expect(
			h.service.createJob({ sourceId: "rtl", kind: "monitor" }),
		).rejects.toMatchObject({
			statusCode: 400,
			code: "SCANNER_MONITOR_UNAVAILABLE",
		})
		await h.service.stop()
	})

	it("hands the lease back to a preempted sweep without resume-blocked (impact excludes the job itself)", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		const low = await h.service.createJob(sweep(30))
		await untilRunning(h, low.id)
		const high = await h.service.createJob(sweep(60))
		await settled(h.service)
		expect(h.service.getJob(low.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "preempted-job",
		})
		expect(holderOf(h)).toBe(high.id)
		const inspected = h.service as unknown as { deps: ScannerServiceDeps }
		inspected.deps.operatorActivity = {
			current: () => ({ audio: true, recording: true }),
			onChange: () => () => {},
		}
		expect(h.service.getJob(low.id)).toMatchObject({
			resumeAt: null,
			resumeHeldBy: null,
		})
		await h.service.cancelJob(high.id)
		await settled(h.service)
		expect(h.service.getJob(low.id)?.state).toBe("running")
		expect(holderOf(h)).toBe(low.id)
		await h.service.stop()
	})

	it("hands the lease back when a preempting sweep fails to start", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		const low = await h.service.createJob(sweep(30))
		await untilRunning(h, low.id)
		const holdSource = h.decoders.holdSource.bind(h.decoders)
		h.decoders.holdSource = (sourceId, reason, holderId) =>
			holderId === low.id
				? holdSource(sourceId, reason, holderId)
				: Promise.reject(new Error("hold failed"))
		await expect(h.service.createJob(sweep(60))).rejects.toThrow("hold failed")
		await settled(h.service)
		expect(h.service.getJob(low.id)?.state).toBe("running")
		expect(holderOf(h)).toBe(low.id)
		await h.service.stop()
	})

	it("refuses to hand the lease over from a starting holder (ruling R1)", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
				s.sweep.markers = true
			},
		})
		await h.service.start()
		// markers and no samples: the first own epoch waits for its marker run, so the sweep stays in "starting"
		const low = await h.service.createJob(sweep(30))
		await settled(h.service)
		expect(h.service.getJob(low.id)?.state).toBe("starting")
		await expect(h.service.createJob(sweep(60))).rejects.toMatchObject({
			statusCode: 409,
			code: "SCANNER_SOURCE_BUSY",
			message: "holder is starting",
		})
		expect(holderOf(h)).toBe(low.id)
		expect(h.service.getJob(low.id)?.state).toBe("starting")
		// an operator write while it starts fails it (tuner-error), it is never left holding nothing
		h.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
		await settled(h.service)
		expect(h.service.getJob(low.id)).toMatchObject<Partial<ScanJob>>({
			state: "failed",
			reason: "tuner-unavailable",
		})
		expect(holderOf(h)).toBeUndefined()
		expect(h.decoders.isSourceHeld("rtl")).toBe(false)
		await h.service.stop()
	})

	it("moves an operator-paused lease holder to preempted-job and hands the lease back to it", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		const first = await h.service.createJob(sweep(30))
		await untilRunning(h, first.id)
		await h.service.pauseJob(first.id)
		const second = await h.service.createJob(sweep(60))
		expect(h.service.getJob(first.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "preempted-job",
		})
		await h.service.cancelJob(second.id)
		await settled(h.service)
		expect(holderOf(h)).toBe(first.id)
		await h.service.stop()
	})

	it("releases the lease and the decoder hold when a sweep fails to start", async () => {
		const h = serviceHarness({
			liveCaps: false,
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		await expect(h.service.createJob(sweep(50))).rejects.toThrow()
		expect(holderOf(h)).toBeUndefined()
		expect(h.decoders.isSourceHeld("rtl")).toBe(false)
		expect(h.service.listJobs()).toEqual([])
		h.sources.caps.set("rtl", h.configCaps)
		const job = await h.service.createJob(sweep(50))
		expect(holderOf(h)).toBe(job.id)
		await h.service.stop()
	})

	it("releases the decoder hold only once the source caps show the restored tuning", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		const job = await h.service.createJob(sweep(50))
		await untilRunning(h, job.id)
		const scanHz = h.tuner.states.get("rtl")!.frequency
		expect(scanHz).not.toBe(CENTRE)
		// The harness tuner updates the caps with each write, like the real controller; here they follow 80 ms late.
		expect(h.sources.getCaps("rtl")?.centerFreq).toBe(scanHz)
		h.tuner.setFrequency = async (sourceId, hz, opts) => {
			await ArbiterFakeTuner.prototype.setFrequency.call(
				h.tuner,
				sourceId,
				hz,
				opts,
			)
			setTimeout(() => h.sources.setCaps(sourceId, { centerFreq: hz }), 80)
		}
		const releaseSource = h.decoders.releaseSource.bind(h.decoders)
		const capsAtRelease: (number | undefined)[] = []
		h.decoders.releaseSource = (sourceId, holderId) => {
			capsAtRelease.push(h.sources.getCaps(sourceId)?.centerFreq)
			return releaseSource(sourceId, holderId)
		}
		await h.service.cancelJob(job.id)
		expect(h.tuner.states.get("rtl")!.frequency).toBe(CENTRE)
		expect(capsAtRelease).toEqual([CENTRE])
		expect(h.decoders.isSourceHeld("rtl")).toBe(false)
		await h.service.stop()
	})

	it("closes the open observations of a source when its engine stops (R2)", async () => {
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
		feedTone(h.fanout, 2, 93_750)
		await tick(50)
		const internals = h.service as unknown as {
			live: Map<string, { trackId: string }>
		}
		expect(internals.live.size).toBeGreaterThan(0)
		// the last job ends: the engine stops with the tone still on
		await h.service.cancelJob(job.id)
		expect(internals.live.size).toBe(0)
		const d = h.service
			.listDiscoveries({})
			.items.find(x => Math.abs(x.frequencyHz - (CENTRE + 93_750)) < 2_000)
		expect(d).toBeDefined()
		const obs = h.service.discoveryObservations(d!.id, null, 10).items
		expect(obs.length).toBeGreaterThan(0)
		expect(obs.every(o => o.endReason === "job-end")).toBe(true)
		await h.service.stop()
	}, 20_000)

	it("closes each observation once across a new stream, ignoring the pipeline's late closes (R2)", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [{ startHz: 446_000_000, endHz: 446_300_000 }],
		})
		const closes = new Map<string, number>()
		h.service.on(
			"activity",
			(a: { observationId: string; active: boolean }) => {
				if (!a.active)
					closes.set(a.observationId, (closes.get(a.observationId) ?? 0) + 1)
			},
		)
		feedTone(h.fanout, 1, 93_750)
		await tick(50)
		const internals = h.service as unknown as {
			live: Map<string, { observationId: string }>
		}
		const before = [...internals.live.values()].map(o => o.observationId)
		expect(before.length).toBeGreaterThan(0)
		// reconnect boundary: the engine announces stream 1, then the pipeline closes stream 0's tracks itself
		h.sources.emit("disconnected", "rtl")
		h.sources.emit("payload-started", "rtl")
		feedTone(h.fanout, 1, 93_750, 0.5, 31)
		await tick(50)
		for (const id of before) expect(closes.get(id)).toBe(1)
		expect([...closes.values()].every(n => n === 1)).toBe(true)
		// a late close never re-creates (and closes) a second observation of the old track
		const d = h.service
			.listDiscoveries({})
			.items.find(x => Math.abs(x.frequencyHz - (CENTRE + 93_750)) < 2_000)
		expect(d).toBeDefined()
		const gapClosed = h.service
			.discoveryObservations(d!.id, null, 50)
			.items.filter(o => o.endReason === "gap")
		expect(gapClosed).toHaveLength(1)
		// the tone continues as a new observation of the new stream
		const after = [...internals.live.values()].map(o => o.observationId)
		expect(after.length).toBeGreaterThan(0)
		expect(after.some(id => before.includes(id))).toBe(false)
		await h.service.stop()
	}, 20_000)

	it("a job that joins a display-opened engine keeps its tracks (stream floor, Task 37a review finding 1)", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		const inWindow = {
			sourceId: "rtl",
			mode: "in-window" as const,
			ranges: [{ startHz: 446_000_000, endHz: 446_300_000 }],
		}
		const internals = h.service as unknown as {
			live: Map<string, { observationId: string }>
			streamFloor: Map<string, number>
		}
		// a job's engine stops: its "stop" moves the floor past that instance's stream
		const first = await h.service.createJob(inWindow)
		await untilRunning(h, first.id)
		await h.service.cancelJob(first.id)
		expect(h.service.spectrum.sourceIds()).toEqual([])
		// a waterfall reopens the engine (display demand emits no stream event), then a job joins it
		await h.service.spectrum.subscribe("c1", undefined)
		const second = await h.service.createJob(inWindow)
		await untilRunning(h, second.id)
		const engine = h.service.spectrum.engine("rtl")!
		expect(internals.streamFloor.get("rtl")).toBe(engine.accounting().stream)
		feedTone(h.fanout, 2, 93_750)
		await tick(50)
		expect(internals.live.size).toBeGreaterThan(0)
		const d = h.service
			.listDiscoveries({})
			.items.find(x => Math.abs(x.frequencyHz - (CENTRE + 93_750)) < 2_000)
		const gaps = d
			? h.service
					.discoveryObservations(d.id, null, 50)
					.items.filter(o => o.endReason === "gap")
			: []
		expect(gaps).toEqual([])
		await h.service.spectrum.unsubscribe("c1")
		await h.service.stop()
	}, 20_000)

	it("targets ambient dsd-fme decoders with their NXDN flavour (Task 34 carry)", () => {
		const dsd = (id: string, mode: string) => ({
			id,
			type: "dsd-fme",
			enabled: true,
			sourceId: "rtl",
			options: { mode, offsetHz: 12_500 },
		})
		const h = serviceHarness({
			decoderConfigs: [
				dsd("n48", "nxdn48"),
				dsd("n96", "nxdn"),
				{
					id: "pager",
					type: "multimon-ng",
					enabled: true,
					sourceId: "rtl",
					options: {},
				},
			],
		})
		const target = (id: string): unknown =>
			(
				h.service as unknown as { ambientTarget(id: string): unknown }
			).ambientTarget(id)
		expect(target("n48")).toEqual({
			sourceId: "rtl",
			hz: CENTRE + 12_500,
			nxdn: "nxdn48",
			targetsHz: [CENTRE + 12_500],
			external: true,
		})
		expect(target("n96")).toEqual({
			sourceId: "rtl",
			hz: CENTRE + 12_500,
			nxdn: "nxdn96",
			targetsHz: [CENTRE + 12_500],
			external: true,
		})
		// WG7: every target and the input kind (unknown here: the fake has no running instance).
		expect(target("pager")).toEqual({
			sourceId: "rtl",
			hz: CENTRE,
			targetsHz: [CENTRE],
			external: true,
		})
	})

	it("starts with empty state when the persisted state cannot be read", async () => {
		const h = serviceHarness()
		// a journal "file" that is a directory: load() rejects with EISDIR
		mkdirSync(join(h.dir, "journal", "observations-20261010.jsonl"), {
			recursive: true,
		})
		await h.service.start()
		expect(h.service.listDiscoveries({}).items).toEqual([])
		const job = await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [{ startHz: 446_000_000, endHz: 446_300_000 }],
		})
		await settled(h.service)
		expect(h.service.getJob(job.id)?.state).toBe("running")
		expect(h.service.getJob("passive-rtl")?.state).toBe("running")
		await h.service.stop()
	})

	// Lifecycle regression coverage.

	const noPassive = (s: { passive: { enabled: boolean } }): void => {
		s.passive.enabled = false
	}
	const unreadableJournal = (dir: string): void => {
		mkdirSync(join(dir, "journal", "observations-20261010.jsonl"), {
			recursive: true,
		})
	}
	const internalsOf = (h: Harness) =>
		h.service as unknown as {
			persistence: { loadConfig(): Promise<unknown> }
			drivers: Map<string, { dispose(): Promise<void> }>
			checkPassiveCost(now: number): Promise<void>
		}

	it("keeps jobs, the persisted lease and settings when only the journal is unreadable (finding 1)", async () => {
		const a = serviceHarness({ patch: noPassive })
		await a.service.start()
		const job = await a.service.createJob(sweep(50))
		await untilRunning(a, job.id)
		await a.service.patchSettings({ detection: { sensitivity: "high" } })
		await vi.waitFor(
			() =>
				expect(
					JSON.parse(readFileSync(join(a.dir, "jobs.json"), "utf8")).jobs[0]
						.lease?.jobId,
				).toBe(job.id),
			WAIT,
		)
		// the state a crash during the sweep leaves: the job with its lease
		const crashedJobs = readFileSync(join(a.dir, "jobs.json"), "utf8")
		expect(JSON.parse(crashedJobs).jobs[0].lease.jobId).toBe(job.id)
		await a.service.stop()
		writeFileSync(join(a.dir, "jobs.json"), crashedJobs)
		unreadableJournal(a.dir)
		const b = serviceHarness({ dir: a.dir, patch: noPassive })
		await b.service.start()
		expect(b.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "core-restart",
		})
		// the persisted lease is recovered: the pre-crash centre is restored on connection
		b.tuner.states.get("rtl")!.frequency = 450_100_000
		b.sources.emit("payload-started", "rtl")
		await vi.waitFor(
			() =>
				expect(
					b.tuner.sent.some(
						c => c.origin === "scanner" && c.name === "set-frequency",
					),
				).toBe(true),
			WAIT,
		)
		expect(
			b.tuner.sent.filter(
				c => c.origin === "scanner" && c.name === "set-frequency",
			),
		).toEqual([expect.objectContaining({ value: CENTRE })])
		// PATCH merges with the overrides read from settings.json
		await b.service.patchSettings({ storage: { maxRecordingsMb: 100 } })
		const saved = JSON.parse(
			readFileSync(join(a.dir, "settings.json"), "utf8"),
		).settings
		expect(saved).toEqual({
			detection: { sensitivity: "high" },
			storage: { maxRecordingsMb: 100 },
		})
		await b.service.stop()
	})

	it("never writes jobs, settings or engine state when none of the state can be read (finding 1 backstop)", async () => {
		const a = serviceHarness({ patch: noPassive })
		await a.service.start()
		await a.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [{ startHz: 446_000_000, endHz: 446_300_000 }],
		})
		await a.service.patchSettings({ detection: { sensitivity: "high" } })
		await a.service.stop()
		unreadableJournal(a.dir)
		const files = ["jobs.json", "settings.json", join("engine", "rtl.json")]
		const before = files.map(f => readFileSync(join(a.dir, f), "utf8"))
		const b = serviceHarness({ dir: a.dir, patch: noPassive })
		internalsOf(b).persistence.loadConfig = () =>
			Promise.reject(new Error("unreadable"))
		await b.service.start()
		await expect(b.service.createJob(sweep(50))).rejects.toMatchObject({
			statusCode: 503,
			code: "SCANNER_STATE_UNAVAILABLE",
		})
		await expect(
			b.service.patchSettings({ storage: { maxRecordingsMb: 100 } }),
		).rejects.toMatchObject({ statusCode: 503 })
		const inWindow = await b.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [{ startHz: 446_000_000, endHz: 446_300_000 }],
		})
		await settled(b.service)
		expect(b.service.getJob(inWindow.id)?.state).toBe("running")
		await b.service.cancelJob(inWindow.id)
		await b.service.stop()
		expect(files.map(f => readFileSync(join(a.dir, f), "utf8"))).toEqual(before)
	})

	it("holds a paused multi-hop sweep still and moves on after resume (finding 2)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const job = await h.service.createJob({
			...sweep(50),
			ranges: [{ startHz: 450_000_000, endHz: 452_400_000 }],
		})
		expect(job.plan.hops.length).toBeGreaterThan(1)
		await untilRunning(h, job.id)
		const centres = () =>
			new Set(
				h.tuner.sent
					.filter(c => c.origin === "scanner" && c.name === "set-frequency")
					.map(c => c.value),
			)
		for (let i = 0; i < 40 && centres().size < 2; i++) {
			feedTone(h.fanout, 0.1, 0, 0, 40 + i)
			await tick(5)
		}
		expect(centres().size).toBeGreaterThan(1)
		await h.service.pauseJob(job.id)
		await settled(h.service)
		const sent = h.tuner.sent.length
		for (let i = 0; i < 15; i++) {
			feedTone(h.fanout, 0.1, 0, 0, 90 + i)
			await tick(5)
		}
		expect(h.tuner.sent.length).toBe(sent)
		expect(h.service.getJob(job.id)?.progress.probes).toEqual([])
		await h.service.resumeJob(job.id, { takeover: false })
		for (let i = 0; i < 10; i++) {
			feedTone(h.fanout, 0.1, 0, 0, 120 + i)
			await tick(5)
		}
		expect(h.tuner.sent.length).toBeGreaterThan(sent)
		await h.service.stop()
	}, 20_000)

	it("hands the lease back when the preemptor completes on its stop condition (finding 4)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const low = await h.service.createJob(sweep(30))
		await untilRunning(h, low.id)
		const high = await h.service.createJob({
			...sweep(60),
			stop: { afterSweeps: 1 },
		})
		await settled(h.service)
		expect(h.service.getJob(low.id)?.reason).toBe("preempted-job")
		for (
			let i = 0;
			i < 60 && h.service.getJob(high.id)?.state !== "completed";
			i++
		) {
			feedTone(h.fanout, 0.1, 0, 0, 200 + i)
			await tick(5)
		}
		expect(h.service.getJob(high.id)?.state).toBe("completed")
		await settled(h.service)
		expect(h.service.getJob(low.id)?.state).toBe("running")
		expect(holderOf(h)).toBe(low.id)
		await h.service.stop()
	}, 20_000)

	it("keeps an operator pause when a REST write takes the lease, and re-acquires it on resume (finding 5)", async () => {
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
		expect(holderOf(h)).toBeUndefined()
		expect(h.decoders.isSourceHeld("rtl")).toBe(false)
		await h.service.resumeJob(job.id, { takeover: false })
		expect(h.service.getJob(job.id)?.state).toBe("running")
		expect(holderOf(h)).toBe(job.id)
		expect(h.decoders.isSourceHeld("rtl")).toBe(true)
		await h.service.stop()
	})

	it("blocks the resume of an operator pause whose lease another sweep took (finding 5)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const job = await h.service.createJob(sweep(30))
		await untilRunning(h, job.id)
		await h.service.pauseJob(job.id)
		h.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
		await settled(h.service)
		const other = await h.service.createJob(sweep(60))
		await untilRunning(h, other.id)
		await expect(
			h.service.resumeJob(job.id, { takeover: false }),
		).rejects.toMatchObject({ statusCode: 409, code: "SCANNER_SOURCE_BUSY" })
		expect(h.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "resume-blocked",
		})
		expect(holderOf(h)).toBe(other.id)
		await h.service.stop()
	})

	it("refuses a lower-priority sweep with details.holderJobId while another job holds the lease (Task 38)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const high = await h.service.createJob(sweep(60))
		await untilRunning(h, high.id)
		await expect(h.service.createJob(sweep(30))).rejects.toMatchObject({
			statusCode: 409,
			code: "SCANNER_SOURCE_BUSY",
			message: `Lease held by scanner job ${high.id}`,
			details: { holderJobId: high.id },
		})
		expect(holderOf(h)).toBe(high.id)
		await h.service.stop()
	})

	// ---- explicit resume of a preempted sweep ----

	it("resumes a sweep preempted by an operator write at once", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const job = await h.service.createJob(sweep(50))
		await untilRunning(h, job.id)
		h.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
		await settled(h.service)
		expect(h.service.getJob(job.id)?.reason).toBe("preempted-operator")
		await h.service.resumeJob(job.id, { takeover: false })
		expect(h.service.getJob(job.id)?.state).toBe("running")
		expect(holderOf(h)).toBe(job.id)
		await h.service.stop()
	})

	it("refuses the resume of a relay-preempted sweep while the relay holds control", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const job = await h.service.createJob(sweep(50))
		await untilRunning(h, job.id)
		h.tuner.setControl("rtl", "external")
		await settled(h.service)
		expect(h.service.getJob(job.id)?.reason).toBe("preempted-relay")
		await expect(
			h.service.resumeJob(job.id, { takeover: false }),
		).rejects.toMatchObject({ statusCode: 409, code: "SCANNER_SOURCE_BUSY" })
		expect(h.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "preempted-relay",
		})
		h.tuner.setControl("rtl", "internal")
		await h.service.resumeJob(job.id, { takeover: false })
		expect(h.service.getJob(job.id)?.state).toBe("running")
		expect(holderOf(h)).toBe(job.id)
		await h.service.stop()
	})

	/** low(30) and mid(40) wait as preempted-job; high(60), operator-paused, lost the lease to a REST write. */
	async function twoWaiters() {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		const low = await h.service.createJob(sweep(30))
		await untilRunning(h, low.id)
		const mid = await h.service.createJob(sweep(40))
		await untilRunning(h, mid.id)
		const high = await h.service.createJob(sweep(60))
		await untilRunning(h, high.id)
		await h.service.pauseJob(high.id)
		h.tuner.external("rtl", "set-frequency", 433_920_000, "rest")
		await settled(h.service)
		expect(h.service.getJob(low.id)?.reason).toBe("preempted-job")
		expect(h.service.getJob(mid.id)?.reason).toBe("preempted-job")
		expect(h.service.getJob(high.id)?.reason).toBe("operator")
		expect(holderOf(h)).toBeUndefined()
		return { h, low, mid, high }
	}

	it("resumes only the best preempted-job waiter on a free lease (P16)", async () => {
		const { h, low, mid } = await twoWaiters()
		await expect(
			h.service.resumeJob(low.id, { takeover: true }),
		).rejects.toMatchObject({ statusCode: 409, code: "SCANNER_SOURCE_BUSY" })
		expect(h.service.getJob(low.id)?.reason).toBe("preempted-job")
		expect(holderOf(h)).toBeUndefined()
		await h.service.resumeJob(mid.id, { takeover: false })
		expect(h.service.getJob(mid.id)?.state).toBe("running")
		expect(holderOf(h)).toBe(mid.id)
		// a held lease refuses any other waiter
		await expect(
			h.service.resumeJob(low.id, { takeover: true }),
		).rejects.toMatchObject({
			statusCode: 409,
			message: `Lease held by scanner job ${mid.id}`,
		})
		await h.service.stop()
	})

	it("widens a queued filtered arbitration with an unfiltered request (R3)", async () => {
		const { h, mid } = await twoWaiters()
		const internals = h.service as unknown as {
			queueArbitration(
				sourceId: string,
				eligible?: (r: unknown) => boolean,
			): void
		}
		internals.queueArbitration("rtl", () => false)
		internals.queueArbitration("rtl")
		await settled(h.service)
		// the widened run handed the best waiter its preemptor-idle; high (created after mid) grew
		// mid's impact, so it is blocked rather than running. A filtered-only run leaves it waiting.
		expect(h.service.getJob(mid.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "resume-blocked",
		})
		await h.service.stop()
	}, 20_000)

	it("never turns a malformed discovery id into a path (Task 36 review)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		// a file outside evidence/ that a traversal would reach
		mkdirSync(join(h.dir, "secret"), { recursive: true })
		writeFileSync(join(h.dir, "secret", "psd.json"), "{}")
		mkdirSync(join(h.dir, "evidence", "keep"), { recursive: true })
		for (const id of ["../secret", "d_../../secret", "d_x/..", ""]) {
			await expect(h.service.evidencePath(id, "psd")).rejects.toMatchObject({
				statusCode: 404,
				code: "SCANNER_DISCOVERY_NOT_FOUND",
			})
			await expect(h.service.evidencePath(id, "iq")).rejects.toMatchObject({
				statusCode: 404,
			})
		}
		await expect(
			h.service.deleteDiscovery("../evidence"),
		).rejects.toMatchObject({
			statusCode: 404,
			code: "SCANNER_DISCOVERY_NOT_FOUND",
		})
		expect(existsSync(join(h.dir, "evidence", "keep"))).toBe(true)
		// a well-formed id without evidence is simply absent
		await expect(h.service.evidencePath("d_01ABC", "psd")).resolves.toBeNull()
		await h.service.stop()
	})

	it("answers an invalid settings patch with 400 and rolls back a patch it could not save (finding 7)", async () => {
		const h = serviceHarness({ patch: noPassive })
		await h.service.start()
		await expect(
			h.service.patchSettings({ cpuBudgetCores: -1 }),
		).rejects.toMatchObject({
			statusCode: 400,
			code: "SCANNER_SETTINGS_INVALID",
		})
		const internals = h.service as unknown as {
			persistence: { writeSettings(): Promise<void> }
		}
		internals.persistence.writeSettings = () =>
			Promise.reject(new Error("disk full"))
		await expect(
			h.service.patchSettings({ detection: { sensitivity: "high" } }),
		).rejects.toMatchObject({
			statusCode: 500,
			code: "SCANNER_SETTINGS_WRITE_FAILED",
		})
		const view = h.service.settingsView()
		expect(view.effective.detection.sensitivity).toBe("normal")
		expect(view.provenance["detection.sensitivity"]).not.toBe("runtime")
		await h.service.stop()
	})

	it("reports disposal failure after sibling shutdown, and a failed start keeps its own error (finding 8)", async () => {
		const h = serviceHarness({ liveCaps: false, patch: noPassive })
		const svc = h.service as unknown as {
			createDriver(r: unknown): { dispose(): Promise<void> }
		}
		const createDriver = svc.createDriver.bind(h.service)
		svc.createDriver = r => {
			const d = createDriver(r)
			d.dispose = () => Promise.reject(new Error("dispose failed"))
			return d
		}
		await h.service.start()
		await expect(h.service.createJob(sweep(50))).rejects.toMatchObject({
			code: "SCANNER_SOURCE_NOT_IQ",
		})
		h.sources.caps.set("rtl", h.configCaps)
		const job = await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [{ startHz: 446_000_000, endHz: 446_300_000 }],
		})
		await expect(h.service.stop()).rejects.toMatchObject({
			code: "SCANNER_COMPONENT_CLEANUP_FAILED",
		})
		const jobs = JSON.parse(readFileSync(join(h.dir, "jobs.json"), "utf8"))
			.jobs as { id: string }[]
		expect(jobs.map(j => j.id)).toEqual([job.id])
		expect(existsSync(join(h.dir, "discoveries.json"))).toBe(true)
		await expect(h.service.stop()).rejects.toMatchObject({
			code: "SCANNER_COMPONENT_CLEANUP_FAILED",
		})
	})

	it("marks a persisted job that no longer plans as failed (finding 9)", async () => {
		const a = serviceHarness({ patch: noPassive })
		await a.service.start()
		const job = await a.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [{ startHz: 446_000_000, endHz: 446_300_000 }],
		})
		await a.service.stop()
		const file = JSON.parse(readFileSync(join(a.dir, "jobs.json"), "utf8"))
		file.jobs[0].spec.sourceId = "gone"
		writeFileSync(join(a.dir, "jobs.json"), JSON.stringify(file))
		const b = serviceHarness({ dir: a.dir, patch: noPassive })
		await b.service.start()
		expect(b.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
			state: "failed",
			reason: "invalid",
		})
		await b.service.stop()
	})

	it("judges an engine's passive cost over its first minute, then every five minutes (finding 10, WG11 req 2)", async () => {
		const h = serviceHarness()
		await h.service.start()
		const check = meteredCheck(h.service)
		const engine = h.service.spectrum.engine("rtl")!
		const openedAt = h.service.spectrum.openedAt("rtl")!
		engine.utilization = () => 0.1
		await check(openedAt + 61_000)
		// WG11 req 2: no check is due before the five minute recheck, so a spike in between is ignored
		engine.utilization = () => 0.9
		await check(openedAt + 61_000 + 299_000)
		expect(h.service.getJob("passive-rtl")).toBeDefined()
		await h.service.stop()
		const costly = serviceHarness()
		await costly.service.start()
		const e2 = costly.service.spectrum.engine("rtl")!
		e2.utilization = () => 0.9
		await meteredCheck(costly.service)(
			costly.service.spectrum.openedAt("rtl")! + 61_000,
		)
		expect(costly.service.getJob("passive-rtl")).toBeUndefined()
		expect(costly.service.status().engines[0]?.passive.disabledReason).toMatch(
			/engine-cpu 90 %/,
		)
		await costly.service.stop()
	})

	it("creates the passive job once the source connects when its caps were absent at boot", async () => {
		const h = serviceHarness({ liveCaps: false })
		await h.service.start()
		// the engine could not start without live caps: no job is left stuck in "starting"
		expect(h.service.getJob("passive-rtl")).toBeUndefined()
		h.sources.caps.set("rtl", h.configCaps)
		h.sources.emit("connected", "rtl")
		await vi.waitFor(
			() => expect(h.service.getJob("passive-rtl")?.state).toBe("running"),
			WAIT,
		)
		expect(h.service.getJob("passive-rtl")?.state).toBe("running")
		await h.service.stop()
	})

	it("neither resumes persisted jobs nor commands the tuner while the scanner is disabled", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		const job = await h.service.createJob({
			...sweep(50),
			resume: { autoAfterIdleMs: null, onBoot: true },
		})
		await settled(h.service)
		await h.service.stop()
		const again = serviceHarness({
			dir: h.dir,
			patch: s => {
				s.enabled = false
				s.passive.enabled = false
			},
		})
		await again.service.start()
		const before = again.tuner.sent.length
		again.sources.emit("payload-started", "rtl")
		await tick(50)
		expect(again.service.getJob(job.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "core-restart",
		})
		expect(again.tuner.sent.slice(before)).toEqual([])
		await again.service.stop()
	})

	it("keeps a decode at 2f1 − f2 of two stronger tracks below decoded (cap applied before the decode)", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [{ startHz: 446_000_000, endHz: 446_400_000 }],
		})
		feedTones(h.fanout, 2, [
			{ offsetHz: 106_250, amp: 0.4 },
			{ offsetHz: 156_250, amp: 0.4 },
			{ offsetHz: 56_250, amp: 0.08 }, // 2 × 106.25 kHz − 156.25 kHz, all on the 12.5 kHz raster
		])
		await tick(50)
		const internals = h.service as unknown as {
			ambient: EventEmitter
			live: Map<
				string,
				{ epoch: number; lastTrack: { centreHz: number } | null }
			>
		}
		const hz = CENTRE + 56_250
		const im = [...internals.live.values()].find(
			o => Math.abs((o.lastTrack?.centreHz ?? 0) - hz) < 2_000,
		)
		expect(im).toBeDefined()
		const epoch = im!.epoch
		internals.ambient.emit("evidence", {
			decoderId: "dmr-ambient",
			sourceId: "rtl",
			hz,
			ev: {
				protocol: "dmr",
				identity: { kind: "dmr-cc", value: "1" },
				metadata: {},
				// A checked decode tests the intermod cap, independently of sync rejection.
				contentVerified: true,
				crcClean: true,
				at: Date.now(),
				epoch,
				origin: "ambient",
				decoderId: "dmr-ambient",
			},
		})
		const d = h.service
			.listDiscoveries({})
			.items.find(x => Math.abs(x.frequencyHz - hz) < 2_000)
		expect(d).toBeDefined()
		expect(d!.confidence).not.toBe("decoded")
		expect(d!.confidenceCap).toBe("suspected-intermod")
		// Observation.decode carries the evidence (PlanReviewC #0)
		const obs = h.service.discoveryObservations(d!.id, null, 10).items
		expect(
			obs.some(o => (o.decode ?? []).some(e => e.identity?.value === "1")),
		).toBe(true)
		await h.service.stop()
	}, 20_000)
})

describe("R14 immutable scanner component phase", () => {
	it("owns actual partial arbiter registrations before the constructor assignment (C6)", async () => {
		const h = serviceHarness()
		const deps = (h.service as unknown as { deps: ScannerServiceDeps }).deps
		await h.service.stop()
		const owner = new ScannerLifecycleOwner()
		const unrelated = vi.fn()
		h.sources.on("disconnected", unrelated)
		const original = new Error("removed registration failed")
		const failRegistration = (event: string | symbol): void => {
			if (event === "removed") throw original
		}
		h.sources.on("newListener", failRegistration)
		expect(() => new ScannerService({ ...deps, construction: owner })).toThrow(
			original,
		)
		owner.completeConstruction({
			ok: false,
			state: "failed",
			detail: "Original construction failed",
		})
		await expect(owner.beginStop().producerSettled).rejects.toMatchObject({
			code: "SCANNER_COMPONENT_CLEANUP_FAILED",
		})
		expect(h.tuner.listeners("command-sent")).toEqual([])
		expect(h.tuner.listeners("control-mode-changed")).toEqual([])
		expect(h.sources.listeners("disconnected")).toEqual([unrelated])
		expect(h.sources.listeners("removed")).toEqual([])
		await expect(owner.finalizeStopNative(undefined)).rejects.toMatchObject({
			message: "Original construction failed",
		})
		h.sources.off("newListener", failRegistration)
		h.sources.off("disconnected", unrelated)
	})

	it("partial removal failure cannot prevent sibling removal or rewrite the first failure (C6)", async () => {
		const h = serviceHarness()
		const deps = (h.service as unknown as { deps: ScannerServiceDeps }).deps
		await h.service.stop()
		const owner = new ScannerLifecycleOwner()
		const original = new Error("Original removed registration error")
		const failRegistration = (event: string | symbol): void => {
			if (event === "removed") throw original
		}
		h.sources.on("newListener", failRegistration)
		const actualOff = h.tuner.off.bind(h.tuner)
		const removal = vi
			.spyOn(h.tuner, "off")
			.mockImplementation((event, listener) => {
				if (event === "command-sent") throw new Error("owned removal failed")
				return actualOff(event, listener)
			})
		expect(() => new ScannerService({ ...deps, construction: owner })).toThrow(
			original,
		)
		owner.completeConstruction({
			ok: false,
			state: "failed",
			detail: "Immutable original construction failure",
		})
		await expect(owner.beginStop().producerSettled).rejects.toMatchObject({
			message: "Immutable original construction failure",
		})
		expect(h.tuner.listenerCount("command-sent")).toBe(1)
		expect(h.tuner.listeners("control-mode-changed")).toEqual([])
		expect(h.sources.listeners("disconnected")).toEqual([])
		await expect(owner.finalizeStopNative(undefined)).rejects.toMatchObject({
			message: "Immutable original construction failure",
		})
		removal.mockRestore()
		h.sources.off("newListener", failRegistration)
		// Explicit fixture cleanup; the owner did not claim this unresolved listener settled.
		for (const listener of h.tuner.listeners("command-sent"))
			h.tuner.off("command-sent", listener as (...args: unknown[]) => void)
	})
	it("an early own failure cannot complete40 while an independent component remains held", async () => {
		const h = serviceHarness({
			patch: settings => {
				settings.passive.enabled = false
			},
		})
		const owner = (
			h.service as unknown as {
				consumerLifecycle: ScannerLifecycleOwner
			}
		).consumerLifecycle
		let release!: () => void
		const held = new Promise<void>(resolve => {
			release = resolve
		})
		expect(
			owner.ownCleanup("classifier", () =>
				Promise.resolve({
					ok: false,
					state: "failed",
					detail: "fixture own failure",
				}),
			),
		).toBe(true)
		expect(
			owner.ownCleanup("admission", async () => {
				await held
				return { ok: true }
			}),
		).toBe(true)
		const first = h.service.beginStop()
		expect(h.service.beginStop()).toBe(first)
		let settledPhase = false
		void first.producerSettled.then(
			() => {
				settledPhase = true
			},
			() => {
				settledPhase = true
			},
		)
		await Promise.resolve()
		await Promise.resolve()
		expect(settledPhase).toBe(false)
		release()
		await expect(first.producerSettled).rejects.toMatchObject({
			code: "SCANNER_COMPONENT_CLEANUP_FAILED",
		})
		await expect(h.service.finalizeStopNative()).rejects.toMatchObject({
			code: "SCANNER_COMPONENT_CLEANUP_FAILED",
		})
		await expect(h.service.stop()).rejects.toMatchObject({
			code: "SCANNER_COMPONENT_CLEANUP_FAILED",
		})
	})
})

describe("NC4 EACH nested component stop initiation", () => {
	it.each([false, true])(
		"starts unrelated stops while original probe cleanup is held (failure=%s)",
		async failIndependent => {
			const h = serviceHarness({
				patch: s => {
					s.passive.enabled = false
				},
			})
			await h.service.start()
			await h.service.createJob({ sourceId: "rtl", mode: "in-window" })
			const internals = h.service as unknown as {
				probes: ProbePool
				ambient: { stop(): void }
				recorder: { stop(): Promise<void> }
				deps: ScannerServiceDeps
			}
			const ambientStop = vi.spyOn(internals.ambient, "stop")
			const captureStop = vi.spyOn(internals.recorder, "stop")
			const cpuStop = vi.fn(() => {
				if (failIndependent) throw new TypeError("CPU stop failure")
			})
			internals.deps.cpuMeter = {
				start: vi.fn(),
				stop: cpuStop,
				normalisedPercent: null,
			}
			const epoch = h.service.spectrum.engine("rtl")!.currentEpoch()
			const result = internals.probes.request(
				probeRequest({
					epoch: epoch.epoch,
					targetHz: CENTRE + 25_000,
					holdMs: 60_000,
				}),
			)
			expect(result).toHaveProperty("started")
			if (!("started" in result))
				throw new TypeError("fixture probe not admitted")
			await vi.waitFor(() =>
				expect(h.decoders.created.has(result.started)).toBe(true),
			)
			let release!: () => void
			h.decoders.removeGate = new Promise<void>(resolve => {
				release = resolve
			})
			const remove = vi.spyOn(h.decoders, "removeEphemeralDecoder")
			const handle = h.service.beginStop()
			let complete = false
			const outcome = handle.producerSettled.then(
				() => {
					complete = true
					return undefined
				},
				error => {
					complete = true
					return error as unknown
				},
			)
			await vi.waitFor(() => expect(remove).toHaveBeenCalled())
			await vi.waitFor(() => expect(cpuStop).toHaveBeenCalledOnce())
			expect(ambientStop).toHaveBeenCalledOnce()
			expect(captureStop).toHaveBeenCalledOnce()
			expect(complete).toBe(false)
			release()
			const settledOutcome = await outcome
			expect(h.decoders.created.size).toBe(0)
			expect(h.service.beginStop()).toBe(handle)
			if (failIndependent) {
				expect(settledOutcome).toMatchObject({
					code: "SCANNER_COMPONENT_CLEANUP_FAILED",
				})
				const final = h.service.finalizeStopNative()
				await expect(final).rejects.toMatchObject({
					code: "SCANNER_COMPONENT_CLEANUP_FAILED",
				})
				expect(h.service.finalizeStopNative()).toBe(final)
			} else {
				expect(settledOutcome).toBeUndefined()
				await h.service.finalizeStopNative()
			}
		},
	)
})
