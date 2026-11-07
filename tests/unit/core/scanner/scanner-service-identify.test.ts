import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ScannerIdentifyEventData } from "@wavekit/api-types"
import {
	IDENTIFY_KEEP_JOBS,
	IDENTIFY_MAX_ALIVE_JOBS,
} from "../../../../src/core/scanner/identify.js"
import type { JobDriver } from "../../../../src/core/scanner/job-runner.js"
import type { ScannerSettings } from "../../../../src/core/scanner/types.js"
import {
	CENTRE,
	feedTone,
	serviceHarness,
	settled,
	tick,
} from "../../../mocks/scanner/service-fakes.js"

const noPassive = {
	patch: (s: ScannerSettings) => {
		s.passive.enabled = false
	},
}

async function until(pred: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms
	while (!pred() && Date.now() < end) await tick(20)
}

describe("ScannerService.identify (spec § 10.8)", () => {
	it.each([{ frequencyHz: CENTRE + 100_000 }, { all: true as const }])(
		"bounds identify startup without IQ: %j",
		async target => {
			const h = serviceHarness(noPassive)
			await h.service.start()
			try {
				const job = await h.service.identify({
					sourceId: "rtl",
					target,
					timeoutMs: 1000,
				})
				const drivers = (
					h.service as unknown as { drivers: Map<string, JobDriver> }
				).drivers
				const driver = drivers.get(job.id)!
				driver.tick(Date.parse(job.createdAt) + 999)
				await settled(h.service)
				expect(h.service.getJob(job.id)?.state).toBe("starting")
				driver.tick(Date.parse(job.createdAt) + 1000)
				await settled(h.service)
				expect(h.service.getJob(job.id)).toMatchObject({
					state: "failed",
					reason: "tuner-unavailable",
				})
				if ("frequencyHz" in target)
					expect(h.service.getJob(job.id)?.identify?.targets[0]).toMatchObject({
						state: "unidentified",
						trials: [],
						result: {
							measurements: { peakDbfs: null, snrDb: null, floorDbfs: null },
						},
					})
				expect(h.decoders.held.size).toBe(0)
				feedTone(h.fanout, 0.1, 100_000)
				await settled(h.service)
				expect(h.service.getJob(job.id)?.state).toBe("failed")
			} finally {
				await h.service.stop()
			}
		},
	)

	it.each([{ frequencyHz: CENTRE + 100_000 }, { all: true as const }])(
		"handles source-down before identify's first epoch: %j",
		async target => {
			const h = serviceHarness(noPassive)
			await h.service.start()
			try {
				const job = await h.service.identify({ sourceId: "rtl", target })
				h.sources.emit("disconnected", "rtl")
				await settled(h.service)
				expect(h.service.getJob(job.id)).toMatchObject({
					state: "failed",
					reason: "tuner-unavailable",
				})
				expect(h.decoders.held.size).toBe(0)
			} finally {
				await h.service.stop()
			}
		},
	)

	it("refuses a target outside the window and a source whose tuner a sweep holds", async () => {
		const h = serviceHarness(noPassive)
		await h.service.start()
		// FS 1.024 Msps: usable window CENTRE ± 409.6 kHz (from the source caps; no engine is open yet)
		await expect(
			h.service.identify({
				sourceId: "rtl",
				target: { frequencyHz: CENTRE + 600_000 },
			}),
		).rejects.toMatchObject({
			statusCode: 409,
			code: "OUT_OF_WINDOW",
			details: {
				window: { startHz: CENTRE - 409_600, endHz: CENTRE + 409_600 },
				next: {
					method: "POST",
					path: "/api/tuner/rtl/tune",
					// 100 kHz off the target: past the 12.5 kHz DC admission, inside the usable span.
					body: { frequencyHz: CENTRE + 500_000 },
					effect: expect.stringContaining("Moves the receiver") as string,
					then: { method: "POST", path: "/api/scanner/identify" },
				},
			},
		})
		// 1 MHz of bandwidth does not fit ± 409.6 kHz anywhere: no call, and a reason.
		const tooWide = { frequencyHz: CENTRE + 600_000, bandwidthHz: 1_000_000 }
		const refusal = await h.service
			.identify({ sourceId: "rtl", target: tooWide })
			.catch((err: unknown) => err as { details: { next: object } })
		expect((refusal as { details: { next: object } }).details.next).toEqual({
			effect: expect.stringContaining("No retune helps") as string,
		})
		await h.service.createJob({
			sourceId: "rtl",
			mode: "sweep",
			ranges: [{ startHz: 450_000_000, endHz: 450_200_000 }],
			takeover: true,
			resume: { autoAfterIdleMs: null },
		})
		await settled(h.service)
		await expect(
			h.service.identify({ sourceId: "rtl", target: tooWide }),
		).rejects.toMatchObject({
			code: "SCANNER_SOURCE_BUSY",
			details: {
				next: { effect: expect.stringContaining("No retune helps") as string },
			},
		})
		await expect(
			h.service.identify({ sourceId: "rtl", target: { frequencyHz: CENTRE } }),
		).rejects.toMatchObject({
			statusCode: 409,
			code: "SCANNER_SOURCE_BUSY",
			details: {
				reason: "held",
				holderJobId: expect.any(String),
				next: {
					method: "POST",
					path: "/api/tuner/rtl/tune",
					body: { frequencyHz: CENTRE - 100_000, preempt: true },
					effect: expect.stringContaining("preempt: true takes") as string,
					then: { method: "POST", path: "/api/scanner/identify" },
				},
			},
		})
		// The whole window has no frequency of its own: the call stays on the centre.
		await expect(
			h.service.identify({ sourceId: "rtl", target: { all: true } }),
		).rejects.toMatchObject({
			code: "SCANNER_SOURCE_BUSY",
			details: { next: { body: { preempt: true } } },
		})
		await h.service.stop()
	})

	describe("a same-frequency request while a job runs", () => {
		const ask = (
			h: ReturnType<typeof serviceHarness>,
			over: { frequencyHz?: number; protocols?: ("dmr" | "p25p1")[] } = {},
		) =>
			h.service.identifyOrJoin({
				sourceId: "rtl",
				target: { frequencyHz: over.frequencyHz ?? CENTRE + 100_000 },
				protocols: over.protocols ?? ["dmr"],
			})

		it("returns the running job, and starts no second one", async () => {
			const h = serviceHarness(noPassive)
			await h.service.start()
			const first = await ask(h)
			expect(first.joined).toBe(false)
			const again = await ask(h)
			expect(again).toMatchObject({ joined: true, job: { id: first.job.id } })
			await h.service.stop()
		})

		it.each([1, 900, 1000, 6000, 6250])(
			"a request %i Hz off gets its own job: never another signal's answer",
			async offsetHz => {
				const h = serviceHarness(noPassive)
				await h.service.start()
				const first = await ask(h)
				const off = await ask(h, { frequencyHz: CENTRE + 100_000 + offsetHz })
				expect(off.joined).toBe(false)
				expect(off.job.id).not.toBe(first.job.id)
				await h.service.stop()
			},
		)

		it("a narrower request at the same frequency gets its own job", async () => {
			const h = serviceHarness(noPassive)
			await h.service.start()
			const first = await h.service.identifyOrJoin({
				sourceId: "rtl",
				target: { frequencyHz: CENTRE + 100_000, bandwidthHz: 12_500 },
				protocols: ["dmr"],
			})
			const narrower = await ask(h)
			expect(narrower.joined).toBe(false)
			expect(narrower.job.id).not.toBe(first.job.id)
			await h.service.stop()
		})

		it(`at ${IDENTIFY_MAX_ALIVE_JOBS} alive jobs a new request is refused, a repeat still joins`, async () => {
			const h = serviceHarness(noPassive)
			await h.service.start()
			const ids: string[] = []
			for (let i = 0; i < IDENTIFY_MAX_ALIVE_JOBS; i++) {
				const { job, joined } = await ask(h, {
					frequencyHz: CENTRE + 100_000 + i * 12_500,
				})
				expect(joined).toBe(false)
				ids.push(job.id)
			}
			const refused: unknown = await ask(h, {
				frequencyHz: CENTRE + 300_000,
			}).catch((err: unknown) => err)
			expect(refused).toMatchObject({
				statusCode: 409,
				code: "SCANNER_IDENTIFY_BUSY",
			})
			const { next } = (
				refused as {
					details: { next: { jobs: { id: string; path: string }[] } }
				}
			).details
			expect(next.jobs.map(j => j.id)).toEqual(ids)
			expect(next.jobs[0]?.path).toBe(`/api/scanner/jobs/${ids[0]}`)
			expect(h.service.listJobs()).toHaveLength(IDENTIFY_MAX_ALIVE_JOBS)
			// The same question joins: it starts nothing.
			const repeat = await ask(h)
			expect(repeat).toMatchObject({ joined: true, job: { id: ids[0] } })
			// One ended makes room, and an ended job is not counted.
			await h.service.cancelJob(ids[1]!)
			await settled(h.service)
			const room = await ask(h, { frequencyHz: CENTRE + 300_000 })
			expect(room.joined).toBe(false)
			await h.service.stop()
		}, 20_000)

		it("the bound is per source, and counts a whole-window job", async () => {
			const h = serviceHarness(noPassive)
			await h.service.start()
			for (let i = 0; i < IDENTIFY_MAX_ALIVE_JOBS - 1; i++)
				await ask(h, { frequencyHz: CENTRE + 100_000 + i * 12_500 })
			await h.service.identifyOrJoin({
				sourceId: "rtl",
				target: { all: true },
			})
			await expect(
				ask(h, { frequencyHz: CENTRE + 300_000 }),
			).rejects.toMatchObject({ code: "SCANNER_IDENTIFY_BUSY" })
			await h.service.stop()
		}, 20_000)

		it("a wider target does not inherit a narrower job's answer", async () => {
			const h = serviceHarness(noPassive)
			await h.service.start()
			const target = (bandwidthHz: number) => ({
				sourceId: "rtl",
				target: { frequencyHz: CENTRE + 100_000, bandwidthHz },
				protocols: ["dmr" as const],
			})
			const first = await h.service.identifyOrJoin(target(2_000))
			const wider = await h.service.identifyOrJoin(target(20_000))
			expect(wider.joined).toBe(false)
			expect(wider.job.id).not.toBe(first.job.id)
			await h.service.stop()
		})

		it("starts a new job for a protocol the running job does not cover", async () => {
			const h = serviceHarness(noPassive)
			await h.service.start()
			const first = await ask(h)
			const other = await ask(h, { protocols: ["p25p1"] })
			expect(other.joined).toBe(false)
			expect(other.job.id).not.toBe(first.job.id)
			await h.service.stop()
		})

		it("starts a new job once the running one has finished", async () => {
			const h = serviceHarness(noPassive)
			await h.service.start()
			const first = await ask(h)
			await h.service.cancelJob(first.job.id)
			await settled(h.service)
			const next = await ask(h)
			expect(next.joined).toBe(false)
			expect(next.job.id).not.toBe(first.job.id)
			await h.service.stop()
		})
	})

	describe("nothing through the real service, on its own clock", () => {
		const CHUNK_MS = 50
		const clocked = () => {
			const clock = { now: 1_000_000 }
			const h = serviceHarness({ ...noPassive, now: () => clock.now })
			return { h, clock }
		}
		/** One 50 ms block of noise, on the service clock: wall-clock delays cannot make a gap. */
		const feedBlock = async (
			h: ReturnType<typeof serviceHarness>,
			clock: { now: number },
			seed: number,
		): Promise<void> => {
			feedTone(h.fanout, CHUNK_MS / 1000, 0, 0, seed)
			await settled(h.service)
			clock.now += CHUNK_MS
			await tick(30)
		}
		const ask = (h: ReturnType<typeof serviceHarness>) =>
			h.service.identify({
				sourceId: "rtl",
				target: { frequencyHz: CENTRE + 100_000 },
				protocols: ["dmr"],
				timeoutMs: 1000,
				record: false,
			})

		it("noise through the deadline: nothing", async () => {
			const { h, clock } = clocked()
			await h.service.start()
			const job = await ask(h)
			for (let i = 0; i < 400; i++) {
				await feedBlock(h, clock, 100 + i)
				if (h.service.getJob(job.id)?.state === "completed") break
			}
			const target = h.service.getJob(job.id)!.identify!.targets[0]!
			expect(target.verdict).toEqual({ code: "nothing", protocol: "dmr" })
			expect(target.result?.measurements.snrDb).not.toBeNull()
			await h.service.stop()
		}, 60_000)

		it("the source stays connected at rate 0 after real blocks: no-samples, not nothing", async () => {
			const { h, clock } = clocked()
			await h.service.start()
			const job = await ask(h)
			for (let i = 0; i < 400; i++) {
				await feedBlock(h, clock, 100 + i)
				if (h.service.getJob(job.id)?.state === "running") break
			}
			expect(h.service.getJob(job.id)?.state).toBe("running")
			for (let i = 0; i < 4; i++) await feedBlock(h, clock, 600 + i)
			// The dongle is pulled behind rtl_tcp: connected, no bytes, no source-down.
			for (let i = 0; i < 400; i++) {
				clock.now += CHUNK_MS
				await tick(30)
				if (h.service.getJob(job.id)?.state === "completed") break
			}
			const target = h.service.getJob(job.id)!.identify!.targets[0]!
			expect(target.verdict).toEqual({
				code: "could-not-test",
				why: "no-samples",
				protocol: "dmr",
			})
			await h.service.stop()
		}, 60_000)
	})

	it("refuses kind: identify on POST /jobs (identify has its own route)", async () => {
		const h = serviceHarness(noPassive)
		await h.service.start()
		await expect(
			h.service.createJob({
				sourceId: "rtl",
				mode: "in-window",
				kind: "identify",
			}),
		).rejects.toMatchObject({
			statusCode: 400,
			code: "SCANNER_IDENTIFY_VIA_JOBS",
		})
		expect(h.service.listJobs()).toEqual([])
		await h.service.stop()
	})

	it("ends a waiting target with ended: window-moved when a takeover sweep takes the tuner", async () => {
		const h = serviceHarness(noPassive)
		await h.service.start()
		const job = await h.service.identify({
			sourceId: "rtl",
			target: { frequencyHz: CENTRE + 100_000 },
			timeoutMs: 60_000,
			record: false,
		})
		feedTone(h.fanout, 1, 0, 0, 12) // noise only: the target waits for a signal
		await until(
			() =>
				h.service.getJob(job.id)?.identify?.targets[0]?.state ===
				"waiting-for-signal",
		)
		await h.service.createJob({
			sourceId: "rtl",
			mode: "sweep",
			ranges: [{ startHz: 450_000_000, endHz: 450_200_000 }],
			takeover: true,
			resume: { autoAfterIdleMs: null },
		})
		await until(() => h.service.getJob(job.id)?.state === "completed")
		expect(h.service.getJob(job.id)!.identify!.targets[0]).toMatchObject({
			state: "unidentified",
			trials: [],
			result: { ended: "window-moved" },
		})
		await h.service.stop()
	}, 20_000)

	it("keeps only the newest IDENTIFY_KEEP_JOBS ended identify jobs listed", async () => {
		const h = serviceHarness(noPassive)
		await h.service.start()
		const ids: string[] = []
		for (let i = 0; i <= IDENTIFY_KEEP_JOBS + 1; i++) {
			const job = await h.service.identify({
				sourceId: "rtl",
				target: { frequencyHz: CENTRE + 100_000 },
				record: false,
			})
			ids.push(job.id)
			if (i <= IDENTIFY_KEEP_JOBS) await h.service.cancelJob(job.id)
		}
		// 51 ended when the 52nd was created: the oldest went, the newest 50 ended plus the running one stay
		const listed = h.service.listJobs().map(j => j.id)
		expect(listed).toHaveLength(IDENTIFY_KEEP_JOBS + 1)
		expect(listed).not.toContain(ids[0])
		expect(listed).toEqual(expect.arrayContaining(ids.slice(1)))
		await h.service.stop()
	}, 60_000)

	it("keeps a carrier unlabelled without trial evidence, and never persists the identify job", async () => {
		const h = serviceHarness(noPassive)
		const events: ScannerIdentifyEventData[] = []
		h.service.on("identify", (d: ScannerIdentifyEventData) => events.push(d))
		await h.service.start()
		const job = await h.service.identify({
			sourceId: "rtl",
			target: { frequencyHz: CENTRE + 100_000, bandwidthHz: 6250 },
			record: false,
		})
		expect(job.spec.kind).toBe("identify")
		feedTone(h.fanout, 2, 100_000)
		// WG11 req 1.3: the test band plans list a 6.25 kHz raster here, so the carrier first gets
		// the three narrow digital trials (one run each, IDENTIFY_MIN_HOLD_MS 1800 or the mode's
		// 2000 ms plus start latency); the golden before WG11 was `trials: []`.
		await until(() => events.at(-1)?.state === "trying")
		expect(events.at(-1)?.trials).toEqual([
			expect.objectContaining({
				protocol: "analog-fm",
				outcome: "unsupported",
			}),
			expect.objectContaining({
				protocol: "nxdn48",
				decoder: "dsd-fme",
				mode: "nxdn48",
			}),
			expect.objectContaining({
				protocol: "dpmr",
				decoder: "dsd-fme",
				mode: "dpmr",
			}),
			expect.objectContaining({
				protocol: "dstar",
				decoder: "dsd-fme",
				mode: "auto",
			}),
		])
		// Three runs one after another take about 7 s of real time: cancel after the plan is pinned.
		await h.service.cancelJob(job.id)
		await until(() => h.service.getJob(job.id)?.state === "cancelled")
		const [target] = h.service.getJob(job.id)!.identify!.targets
		expect(target).toMatchObject({
			state: "unidentified",
			result: {
				hint: "carrier",
				measurements: { source: "track", class: "carrier" },
			},
		})
		expect(target!.trials.map(t => [t.protocol, t.outcome])).toEqual([
			["analog-fm", "unsupported"],
			["nxdn48", "cancelled"],
			["dpmr", "cancelled"],
			["dstar", "cancelled"],
		])
		expect(
			Math.abs(target!.result!.measurements.centreHz - (CENTRE + 100_000)),
		).toBeLessThan(1000)
		await h.service.stop()
		expect(readFileSync(join(h.dir, "jobs.json"), "utf8")).not.toContain(job.id)
	}, 20_000)

	it("answers a click on the DC spike with the artefact and starts no probe", async () => {
		const h = serviceHarness(noPassive)
		await h.service.start()
		const job = await h.service.identify({
			sourceId: "rtl",
			target: { frequencyHz: CENTRE },
			record: false,
		})
		feedTone(h.fanout, 1, 0, 0, 12) // noise only
		await until(() => h.service.getJob(job.id)?.state === "completed")
		expect(h.service.getJob(job.id)!.identify!.targets[0]).toMatchObject({
			state: "unidentified",
			trials: [],
			result: { artefact: "dc" },
		})
		expect(h.decoders.created.size).toBe(0)
		await h.service.stop()
	}, 20_000)

	it("refuses pause and edits on an identify job, and cancels it", async () => {
		const h = serviceHarness(noPassive)
		await h.service.start()
		const job = await h.service.identify({
			sourceId: "rtl",
			target: { frequencyHz: CENTRE + 100_000 },
			record: false,
		})
		await expect(h.service.pauseJob(job.id)).rejects.toMatchObject({
			statusCode: 409,
			code: "SCANNER_IDENTIFY_NOT_PAUSABLE",
		})
		await expect(
			h.service.patchJob(job.id, { thresholdDb: 9 }),
		).rejects.toMatchObject({
			statusCode: 409,
			code: "SCANNER_IDENTIFY_NOT_EDITABLE",
		})
		expect((await h.service.cancelJob(job.id)).state).toBe("cancelled")
		await h.service.stop()
	})
})
