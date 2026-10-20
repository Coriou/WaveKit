/**
 * WG12 req 6.1: a gated track that opened with the job is preferred over a
 * nearer track that was already on the air.
 */
import { describe, expect, it } from "vitest"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

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
