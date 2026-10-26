import { rm } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"
import { CaptureRecorder } from "../../../../src/core/scanner/evidence/capture-recorder.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import type { ScannerServiceDeps } from "../../../../src/core/scanner/scanner-service.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"
import { CENTRE, serviceHarness } from "../../../mocks/scanner/service-fakes.js"

// DQ 1.4e: burst capture and automatic IQ capture refuse edge tracks and tracks past the 0.8 span
// (±409.6 kHz at 1.024 Msps).

interface Internal {
	deps: ScannerServiceDeps
	openCapture(live: LiveObservation, track: TrackSnapshot): void
	requestIqCapture(live: LiveObservation, track: TrackSnapshot): void
}

function liveOf(track: TrackSnapshot, jobId: string): LiveObservation {
	return {
		observationId: `o_${track.trackId}`,
		sourceId: "rtl",
		trackId: track.trackId,
		epoch: track.epoch,
		jobIds: [jobId],
		discoveryId: "d_edge",
		startedAt: 0,
		classification: { class: "unknown", hypotheses: [], tier: "spectral" },
		probeIds: new Set(),
		lastActivityAt: 0,
		lastIngestAt: 0,
		lastTrack: track,
		decoded: false,
		encrypted: false,
	}
}

async function run(
	offsetHz: number,
	obwHz: number,
	edge: boolean,
	what: "burst" | "iq",
): Promise<number> {
	const open = vi.spyOn(CaptureRecorder.prototype, "open")
	const h = serviceHarness({ patch: s => void (s.passive.enabled = false) })
	const internal = h.service as unknown as Internal
	const capture = vi.fn().mockReturnValue({ refused: "budget" })
	try {
		await h.service.start()
		const job = await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [{ startHz: 446_000_000, endHz: 446_100_000 }],
			capture: { enabled: true, preMs: 200, postMs: 100 },
		})
		const track = makeTrack({
			id: `t_${what}`,
			centreHz: CENTRE + offsetHz,
			startedAt: 0,
			obwHz,
		})
		track.flags.edge = edge
		track.gate = "passed"
		const live = liveOf(track, job.id)
		if (what === "burst") {
			open.mockClear()
			internal.openCapture(live, track)
			return open.mock.calls.length
		}
		internal.deps = {
			...internal.deps,
			iqCapture: { ...internal.deps.iqCapture, capture } as never,
		}
		internal.requestIqCapture(live, track)
		return capture.mock.calls.length
	} finally {
		open.mockRestore()
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	}
}

describe("captures keep to the usable span", () => {
	it("burst capture: a gate-passed track at +460.8 kHz (0.9 Nyquist) opens nothing", async () => {
		expect(await run(460_800, 12_500, true, "burst")).toBe(0)
		expect(await run(460_800, 12_500, false, "burst")).toBe(0)
	})

	it("burst capture: at the bound it opens, one hertz past it does not, and edge alone refuses", async () => {
		// 403 350 + 12 500 / 2 = 409 600 Hz, exactly the 0.8 bound.
		expect(await run(403_350, 12_500, false, "burst")).toBe(1)
		expect(await run(403_351, 12_500, false, "burst")).toBe(0)
		expect(await run(-403_350, 12_500, false, "burst")).toBe(1)
		expect(await run(100_000, 12_500, true, "burst")).toBe(0)
	})

	it("IQ capture: an edge track at +408 kHz with 1 kHz OBW (inside 0.8) is not captured", async () => {
		expect(await run(408_000, 1_000, true, "iq")).toBe(0)
		expect(await run(408_000, 1_000, false, "iq")).toBe(1)
	})

	it("IQ capture: at the bound it captures, one hertz past it does not", async () => {
		expect(await run(409_100, 1_000, false, "iq")).toBe(1)
		expect(await run(409_101, 1_000, false, "iq")).toBe(0)
	})
})
