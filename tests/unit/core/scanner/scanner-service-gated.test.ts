/**
 * WG12 req 6.1: a gated track that opened with the job is preferred over a
 * nearer track that was already on the air.
 */
import { describe, expect, it } from "vitest"
import type {
	JobDriver,
	LiveObservation,
} from "../../../../src/core/scanner/job-runner.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import {
	feedTone,
	FS,
	serviceHarness,
	settled,
} from "../../../mocks/scanner/service-fakes.js"

const HZ = 446_125_000
const JOB_START = 1_000_000

function observation(
	trackId: string,
	centreHz: number,
	startedAt: number,
	passed: boolean,
): LiveObservation {
	const track: TrackSnapshot = trackOf({
		trackId,
		sourceId: "rtl",
		centreHz,
		startSample: 1_000,
		...(passed ? { gate: "passed" as const, gatePassedSample: 1_000 } : {}),
	})
	return {
		observationId: `o_${trackId}`,
		sourceId: "rtl",
		trackId,
		epoch: track.epoch,
		jobIds: [],
		discoveryId: null,
		startedAt,
		...(passed ? { gatePassedAt: startedAt } : {}),
		classification: { class: "tdma-ms", hypotheses: [], tier: "spectral" },
		probeIds: new Set(),
		lastActivityAt: startedAt,
		lastIngestAt: 0,
		lastTrack: track,
		decoded: false,
		encrypted: false,
	}
}

function gateOf(live: Map<string, LiveObservation>) {
	const h = serviceHarness()
	const service = h.service as unknown as {
		live: Map<string, LiveObservation>
		gatedTransmission(
			sourceId: string,
			hz: number,
			toleranceHz: number,
			jobStartedMs: number,
		): { startSample: number; atMs: number } | null
	}
	for (const [id, obs] of live) service.live.set(id, obs)
	return {
		pick: (jobStartedMs = JOB_START) =>
			service.gatedTransmission("rtl", HZ, 5_000, jobStartedMs),
		stop: () => h.service.stop(),
	}
}

describe("gated transmission selection", () => {
	it("prefers a track gated at or after the job start over a nearer older one", async () => {
		const live = new Map<string, LiveObservation>([
			["old-near", observation("old-near", HZ + 100, JOB_START - 5_000, true)],
			["new-far", observation("new-far", HZ + 2_000, JOB_START, true)],
		])
		const gate = gateOf(live)
		try {
			expect(gate.pick()).toEqual({ startSample: 1_000, atMs: JOB_START })
		} finally {
			await gate.stop()
		}
	})

	it("keeps the nearest track when every gate is older than the job", async () => {
		const live = new Map<string, LiveObservation>([
			["old-far", observation("old-far", HZ + 3_000, JOB_START - 8_000, true)],
			["old-near", observation("old-near", HZ + 100, JOB_START - 1_000, true)],
		])
		const gate = gateOf(live)
		try {
			expect(gate.pick()).toEqual({
				startSample: 1_000,
				atMs: JOB_START - 1_000,
			})
		} finally {
			await gate.stop()
		}
	})

	it("keeps the nearest track among those gated with the job", async () => {
		const live = new Map<string, LiveObservation>([
			["fresh-far", observation("fresh-far", HZ + 3_000, JOB_START + 10, true)],
			["fresh-near", observation("fresh-near", HZ + 100, JOB_START + 50, true)],
		])
		const gate = gateOf(live)
		try {
			expect(gate.pick()).toEqual({
				startSample: 1_000,
				atMs: JOB_START + 50,
			})
		} finally {
			await gate.stop()
		}
	})

	it("does not consider an open track past the 256 scanned", async () => {
		const live = new Map<string, LiveObservation>()
		for (let i = 0; i < 256; i++)
			live.set(`skip-${i}`, observation(`skip-${i}`, HZ, JOB_START, false))
		live.set("late", observation("late", HZ, JOB_START, true))
		const gate = gateOf(live)
		try {
			expect(gate.pick()).toBeNull()
		} finally {
			await gate.stop()
		}
	})
})

describe("gate receipt timing through ScannerService", () => {
	it.each(["pending", "open", "ungated"] as const)(
		"accepts a 300 ms gate near the wait deadline (initial track: %s)",
		async initial => {
			const alreadyOpen = initial === "open"
			const h = serviceHarness({
				patch: s => {
					s.passive.enabled = false
				},
			})
			let now = JOB_START
			const service = h.service as unknown as {
				now: () => number
				onTrack(
					sourceId: string,
					ev: { kind: "track-open" | "track-update"; track: TrackSnapshot },
				): void
				live: Map<string, LiveObservation>
				drivers: Map<string, JobDriver>
				gatedTransmission(
					sourceId: string,
					hz: number,
					toleranceHz: number,
					jobStartedMs: number,
				): { startSample: number; atMs: number } | null
			}
			service.now = () => now
			await h.service.start()
			try {
				// A covering job also lets a transmission predate the identify job.
				await h.service.createJob({
					sourceId: "rtl",
					mode: "in-window",
					ranges: [{ startHz: HZ - 5000, endHz: HZ + 5000 }],
					priority: 50,
					takeover: true,
					resume: { autoAfterIdleMs: null },
				})
				feedTone(h.fanout, 0.2, 0, 0)
				await settled(h.service)
				const epoch = h.service.spectrum.engine("rtl")!.currentEpoch()!
				const track = trackOf({
					trackId: "timed",
					sourceId: "rtl",
					centreHz: HZ,
					epoch: epoch.epoch,
					startSample: 1000,
					...(initial === "ungated" ? {} : { gate: "pending" as const }),
				})
				if (initial === "ungated") delete track.gate
				service.onTrack("rtl", { kind: "track-open", track })
				expect(service.live.has(track.trackId)).toBe(initial === "ungated")
				const pass = () =>
					service.onTrack("rtl", {
						kind: "track-update",
						track: {
							...track,
							gate: "passed",
							gatePassedSample: 1000 + FS * 0.3,
						},
					})
				if (alreadyOpen) pass()
				const job = await h.service.identify({
					sourceId: "rtl",
					target: { frequencyHz: HZ },
					waitUntilSignal: true,
					waitMs: 1000,
					timeoutMs: 2000,
					record: false,
				})
				await settled(h.service)
				now = JOB_START + 900
				if (!alreadyOpen) pass()
				const expectedAt = alreadyOpen ? JOB_START : now
				expect(service.gatedTransmission("rtl", HZ, 5000, JOB_START)).toEqual({
					startSample: 1000 + FS * 0.3,
					atMs: expectedAt,
				})
				now = JOB_START + 1000
				service.drivers.get(job.id)!.tick(now)
				await settled(h.service)
				const target = h.service.getJob(job.id)!.identify!.targets[0]!
				expect(target.state).not.toBe("waiting-for-signal")
				expect(target.result?.ended).not.toBe("no-signal")
				// Later updates must preserve the original gate receipt.
				pass()
				expect(
					service.gatedTransmission("rtl", HZ, 5000, JOB_START)?.atMs,
				).toBe(expectedAt)
			} finally {
				await h.service.stop()
			}
		},
	)
})
