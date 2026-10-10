import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ScannerIdentifyEventData } from "@wavekit/api-types"
import type { ScannerSettings } from "../../../../src/core/scanner/types.js"
import {
	CENTRE,
	feedTone,
	serviceHarness,
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
		await tick(20)
		await expect(
			h.service.identify({ sourceId: "rtl", target: { frequencyHz: CENTRE } }),
		).rejects.toMatchObject({ statusCode: 409, code: "SCANNER_SOURCE_BUSY" })
		await h.service.stop()
	})

	it("identifies a carrier from the spectrum without a trial, and never persists the identify job", async () => {
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
		await until(() => h.service.getJob(job.id)?.state === "completed")
		const [target] = h.service.getJob(job.id)!.identify!.targets
		expect(target).toMatchObject({
			state: "candidate",
			trials: [],
			result: {
				protocol: "carrier",
				measurements: { source: "track", class: "carrier" },
			},
		})
		expect(
			Math.abs(target!.result!.measurements.centreHz - (CENTRE + 100_000)),
		).toBeLessThan(1000)
		expect(events.at(-1)?.state).toBe("candidate")
		expect(h.decoders.created.size).toBe(0)
		await h.service.stop()
		expect(readFileSync(join(h.dir, "jobs.json"), "utf8")).not.toContain(job.id)
	})

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
	})

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
