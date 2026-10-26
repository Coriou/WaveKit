import { rm } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import type { ScannerServiceDeps } from "../../../../src/core/scanner/scanner-service.js"
import { USABLE_FRACTION } from "../../../../src/core/spectrum/spectrum-engine.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"
import {
	CENTRE,
	FS,
	serviceHarness,
} from "../../../mocks/scanner/service-fakes.js"

// DQ 1.4e: automatic analog trials keep to the usable 0.8 span; edge tracks never start one.

const BOUND_HZ = (USABLE_FRACTION * FS) / 2 // 409 600 Hz at 1.024 Msps

interface Internal {
	deps: ScannerServiceDeps
	requestJobAnalog(live: LiveObservation, track: TrackSnapshot): void
	rastersAt(
		sourceId: string,
		hz: number,
	): { spacingHz: number; firstChannelHz?: number }[]
}

/** runLive calls for one observation at `offsetHz` with the given edge flag and width. */
async function trials(
	offsetHz: number,
	edge: boolean,
	obwHz = 12_500,
): Promise<number> {
	const h = serviceHarness({
		patch: s => {
			s.passive.enabled = false
		},
	})
	const internal = h.service as unknown as Internal
	const runLive = vi.fn().mockResolvedValue({ malformed: true })
	internal.deps = { ...internal.deps, analogTrial: { run: vi.fn(), runLive } }
	try {
		await h.service.start()
		const job = await h.service.createJob({
			mode: "in-window",
			sourceId: "rtl",
			ranges: [{ startHz: 446_000_000, endHz: 446_100_000 }],
			signalsOnly: false,
		})
		const track = makeTrack({
			id: "t_edge",
			centreHz: CENTRE + offsetHz,
			startedAt: 0,
			obwHz,
		})
		track.flags.edge = edge
		const live: LiveObservation = {
			observationId: "o_edge",
			sourceId: "rtl",
			trackId: track.trackId,
			epoch: track.epoch,
			jobIds: [job.id],
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
		internal.requestJobAnalog(live, track)
		await Promise.resolve()
		await Promise.resolve()
		return runLive.mock.calls.length
	} finally {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	}
}

/** The analog channel grid the service uses at `hz` (finest raster, else 6.25 kHz from 0). */
async function grid(hz: number): Promise<{ spacing: number; origin: number }> {
	const h = serviceHarness({ patch: s => void (s.passive.enabled = false) })
	try {
		await h.service.start()
		await h.service.createJob({
			mode: "in-window",
			sourceId: "rtl",
			ranges: [{ startHz: 446_000_000, endHz: 446_100_000 }],
			signalsOnly: false,
		})
		const r = (h.service as unknown as Internal)
			.rastersAt("rtl", hz)
			.sort((a, b) => a.spacingHz - b.spacingHz)[0]
		return { spacing: r?.spacingHz ?? 6250, origin: r?.firstChannelHz ?? 0 }
	} finally {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	}
}

describe("automatic analog trials and the usable span", () => {
	it("an edge track at 0.9 of Nyquist (+460.8 kHz, 12.5 kHz wide) starts no trial", async () => {
		expect(await trials(460_800, true)).toBe(0)
	})

	it("an unflagged track whose channel reaches past 0.8 starts no trial either", async () => {
		expect(await trials(460_800, false)).toBe(0)
	})

	it("bound: the outermost channel inside 0.8 is tried on both sides, the next one out is not", async () => {
		const g = await grid(CENTRE + BOUND_HZ)
		// The outermost channel whose upper edge is at or inside the bound.
		const k = Math.floor(
			(CENTRE + BOUND_HZ - g.spacing / 2 - g.origin) / g.spacing,
		)
		const inside = g.origin + k * g.spacing - CENTRE
		expect(inside + g.spacing / 2).toBeLessThanOrEqual(BOUND_HZ)
		expect(await trials(inside, false)).toBe(1)
		expect(await trials(inside + g.spacing, false)).toBe(0)
		expect(await trials(-inside, false)).toBe(1)
		expect(await trials(-(inside + g.spacing), false)).toBe(0)
	})

	it("an edge flag alone refuses a channel inside the span", async () => {
		expect(await trials(100_000, false)).toBe(1)
		expect(await trials(100_000, true)).toBe(0)
	})
})
