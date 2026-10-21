import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ScannerIdentifyEventData } from "@wavekit/api-types"
import { IDENTIFY_KEEP_JOBS } from "../../../../src/core/scanner/identify.js"
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
			},
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
			h.service.identify({ sourceId: "rtl", target: { frequencyHz: CENTRE } }),
		).rejects.toMatchObject({
			statusCode: 409,
			code: "SCANNER_SOURCE_BUSY",
			details: { holderJobId: expect.any(String) },
		})
		await h.service.stop()
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
