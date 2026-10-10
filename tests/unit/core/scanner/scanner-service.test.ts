import type { EventEmitter } from "node:events"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { chooseLeaseHolder } from "../../../../src/core/scanner/job-runner.js"
import type { ScanJob } from "@wavekit/api-types"
import {
	CENTRE,
	feedTone,
	feedTones,
	serviceHarness,
	tick,
} from "../../../mocks/scanner/service-fakes.js"

type Harness = ReturnType<typeof serviceHarness>
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
		await tick(5)
		feedTone(h.fanout, 0.1, 0, 0, seed + i)
	}
	await tick()
}

describe("ScannerService", () => {
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
	})

	// Feature: signal-discovery-scanner, Property 16: Priority
	// Validates: spec § 10.2
	it("keeps at most one lease holder per source and it is the best runnable sweep", async () => {
		type Op =
			| { t: "create"; priority: number }
			| { t: "cancel" | "pause" | "resume"; idx: number }
		const op: fc.Arbitrary<Op> = fc.oneof(
			fc.record({
				t: fc.constant("create" as const),
				priority: fc.integer({ min: 0, max: 100 }),
			}),
			fc.record({
				t: fc.constantFrom(
					"cancel" as const,
					"pause" as const,
					"resume" as const,
				),
				idx: fc.nat(5),
			}),
		)
		await fc.assert(
			fc.asyncProperty(
				fc.array(op, { minLength: 1, maxLength: 12 }),
				async ops => {
					const h = serviceHarness({
						patch: s => {
							s.passive.enabled = false
						},
					})
					await h.service.start()
					const ids: string[] = []
					try {
						for (const o of ops) {
							try {
								if (o.t === "create") {
									const id = (await h.service.createJob(sweep(o.priority))).id
									ids.push(id)
									// R1: a starting holder is never handed over; let it run so preemption is exercised.
									await untilRunning(h, id)
								} else {
									const id = ids[o.idx % Math.max(1, ids.length)]
									if (!id) continue
									if (o.t === "cancel") await h.service.cancelJob(id)
									if (o.t === "pause") await h.service.pauseJob(id)
									if (o.t === "resume")
										await h.service.resumeJob(id, { takeover: true })
								}
							} catch (err) {
								expect(err).toMatchObject({ statusCode: expect.any(Number) })
							}
							await tick()
							const jobs = h.service
								.listJobs()
								.filter(j => j.spec.mode === "sweep")
							const holder = (
								h.service as unknown as {
									arbiter: {
										holder(id: string): { jobId: string } | undefined
									}
								}
							).arbiter.holder("rtl")
							const runnable = jobs.filter(
								j =>
									["starting", "running", "holding"].includes(j.state) ||
									(j.state === "paused" &&
										(j.reason === "operator" || j.reason === "preempted-job")),
							)
							const best = chooseLeaseHolder(
								runnable.map(j => ({
									jobId: j.id,
									priority: j.spec.priority,
									createdAt: Date.parse(j.createdAt),
								})),
							)
							// R1: a holder still in `starting` keeps the lease (a better job's create got 409).
							const holderStarting =
								holder !== undefined &&
								jobs.find(j => j.id === holder.jobId)?.state === "starting"
							if (best === null) expect(holder).toBeUndefined()
							else if (!holderStarting) expect(holder?.jobId).toBe(best)
						}
					} finally {
						await h.service.stop()
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)

	it("restores the tuner at shutdown and pauses the job with core-restart on the next boot", async () => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		await h.service.start()
		const job = await h.service.createJob(sweep(50))
		await tick(20)
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
		await tick(20)
		expect(h.service.getJob(low.id)).toMatchObject<Partial<ScanJob>>({
			state: "paused",
			reason: "preempted-job",
		})
		expect(holderOf(h)).toBe(high.id)
		await h.service.cancelJob(high.id)
		await tick(20)
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
		await tick(20)
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
		await tick(20)
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
		await tick(20)
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
		await tick(20)
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
		// The real controller updates the caps after each write; here they follow 80 ms late.
		h.sources.caps.set("rtl", { ...h.configCaps, centerFreq: scanHz })
		const setFrequency = h.tuner.setFrequency.bind(h.tuner)
		h.tuner.setFrequency = async (sourceId, hz, opts) => {
			await setFrequency(sourceId, hz, opts)
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
	})

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
	})

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
		})
		expect(target("n96")).toEqual({
			sourceId: "rtl",
			hz: CENTRE + 12_500,
			nxdn: "nxdn96",
		})
		expect(target("pager")).toEqual({ sourceId: "rtl", hz: CENTRE })
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
		await tick(20)
		expect(h.service.getJob(job.id)?.state).toBe("running")
		expect(h.service.getJob("passive-rtl")?.state).toBe("running")
		await h.service.stop()
	})

	it("creates the passive job once the source connects when its caps were absent at boot", async () => {
		const h = serviceHarness({ liveCaps: false })
		await h.service.start()
		// the engine could not start without live caps: no job is left stuck in "starting"
		expect(h.service.getJob("passive-rtl")).toBeUndefined()
		h.sources.caps.set("rtl", h.configCaps)
		h.sources.emit("connected", "rtl")
		await tick(20)
		feedTone(h.fanout, 0.5, 93_750)
		await tick(100)
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
		await tick(20)
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
			{ offsetHz: 100_000, amp: 0.4 },
			{ offsetHz: 150_000, amp: 0.4 },
			{ offsetHz: 50_000, amp: 0.08 }, // 2 × 100 kHz − 150 kHz
		])
		await tick(50)
		const internals = h.service as unknown as {
			ambient: EventEmitter
			live: Map<
				string,
				{ epoch: number; lastTrack: { centreHz: number } | null }
			>
		}
		const hz = CENTRE + 50_000
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
	})
})
