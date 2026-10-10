import { beforeEach, describe, expect, it } from "vitest"
import { classifySpectral } from "../../../../src/core/scanner/classify/classifier.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { counterIds } from "../../../mocks/scanner/observations.js"
import {
	heavyTailedNoise,
	mulberry32,
} from "../../../mocks/scanner/signals.js"
import { FS, Harness, yieldToRpc } from "../spectrum/pipeline-harness.js"

const SIGMA = 0.01
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

const msOf = (sample: number): number => T0 + (sample / FS) * 1000

interface Run {
	tracks: TrackSnapshot[]
	discoveries: number
	/** The track of every ingest that created a discovery, with the discovery's observation count. */
	created: { track: TrackSnapshot; observations: number }[]
}

/**
 * 60 s of the P4 heavy-tailed noise model (pipeline-p4.test.ts) through the real pipeline, classified by
 * `classifySpectral` and ingested on every track update and close, as the service does (§ 7.2).
 */
function surfaceFromNoise(
	seed: number,
	noise: { eventsPerMhzMin: number; eventMs: number },
): Run {
	const rng = mulberry32(seed)
	const h = new Harness({ format: "FLOAT32LE" })
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
	})
	h.start({ feed: false })
	for (let s = 0; s < 60; s++) {
		h.push(
			heavyTailedNoise(rng, FS, SIGMA, {
				fs: FS,
				eventsPerMhzSec: noise.eventsPerMhzMin / 60,
				excessDb: 13,
				eventMs: noise.eventMs,
			}),
			16_384,
		)
	}
	const created: Run["created"] = []
	for (const e of h.events) {
		if (e.kind !== "track-update" && e.kind !== "track-close") continue
		const t = e.track
		const r = store.ingest({
			id: `o-${t.trackId}`,
			sourceId: t.sourceId,
			jobIds: ["job-1"],
			track: t,
			classification: classifySpectral(t, { priors: {}, protocols: [] }),
			startedAt: msOf(t.startSample),
			...(e.kind === "track-close"
				? { endedAt: msOf(t.lastSample), endReason: e.endReason }
				: {}),
			singleBlockSurfacingAllowed: false,
		})
		if (r.change === "created")
			created.push({
				track: t,
				observations: store.get(r.discoveryId ?? "")?.observationCount ?? 0,
			})
	}
	return {
		tracks: h.tracks(),
		discoveries: store.snapshot().discoveries.length,
		created,
	}
}

const singleBlockLongPath = (t: TrackSnapshot): boolean =>
	t.blocks === 1 && !t.flags.burst

describe("surfacing filter on heavy-tailed noise, end to end (§ 7.2)", () => {
	beforeEach(yieldToRpc)

	it.each([1, 2, 3])(
		"surfaces no discovery from 60 s of calibrated P4 noise (seed %i)",
		seed => {
			// "False alarms never become discoveries"
			const run = surfaceFromNoise(seed, { eventsPerMhzMin: 1, eventMs: 5 })
			expect(run.discoveries).toBe(0)
		},
		120_000,
	)

	it.each([1, 2, 3])(
		"never surfaces a single-block noise track on its spectral class alone (seed %i)",
		seed => {
			// 25 ms events, 60× the calibrated rate: longer than a burst (≤ 15 ms) so the long path owns them,
			// shorter than a block so most cross k in one block only, and every such track gets a spectral class
			const run = surfaceFromNoise(seed, { eventsPerMhzMin: 60, eventMs: 25 })
			expect(run.tracks.filter(singleBlockLongPath).length).toBeGreaterThan(0)
			// rules (a) and the burst rule may still surface noise here (P4/P20 calibration, Task 49); rule (c) may not,
			// and rule (d) creates only on the third hit
			expect(
				run.created.filter(
					c => singleBlockLongPath(c.track) && c.observations < 3,
				),
			).toEqual([])
		},
		120_000,
	)
})
