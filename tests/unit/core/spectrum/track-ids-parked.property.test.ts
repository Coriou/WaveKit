// tests/unit/core/spectrum/track-ids-parked.property.test.ts
/**
 * Scanner redesign R 1.5 (WG11 5.1): on a parked window nothing changes the epoch, so one
 * emission keeps one frame track id for its life: burst gaps shorter than the tracker's hang
 * and the max-duration rollover keep it. Sample counts only, no wall clock.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { BlockTrack } from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	tone,
} from "../../../mocks/scanner/signals.js"
import { CENTRE, Harness } from "./pipeline-harness.js"

const RATE = 32_000
const OFFSET = 5_000
const HANG_MS = 500
const MAX_TRACK_MS = 400 // the 120 s rollover, scaled down

describe("track ids under a parked job", () => {
	// Feature: scanner-redesign, Property 5: Track ids survive parking
	// Validates: Requirements 1.5, 2.6
	it("one emission with gaps shorter than the hang keeps one frame track id across rollovers", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 1_000_000 }),
				fc.array(
					fc.record({
						onMs: fc.integer({ min: 250, max: 450 }),
						gapMs: fc.integer({ min: 0, max: 200 }),
					}),
					{ minLength: 3, maxLength: 4 },
				),
				(seed, bursts) => {
					const h = new Harness({
						format: "FLOAT32LE",
						sampleRateHz: RATE,
						trackHangMs: HANG_MS,
						maxTrackMs: MAX_TRACK_MS,
					})
					h.start()
					const rng = mulberry32(seed)
					for (const [i, b] of bursts.entries()) {
						const on = Math.round((b.onMs * RATE) / 1000)
						const iq = gaussianNoise(rng, on, 0.005)
						addInto(iq, tone(on, RATE, OFFSET, 0.05))
						h.push(iq, 4096)
						// the last burst ends the sequence: no trailing gap
						if (i === bursts.length - 1) break
						const gap = Math.round((b.gapMs * RATE) / 1000)
						if (gap > 0) h.push(gaussianNoise(rng, gap, 0.005), 4096)
					}
					// no epoch change on a parked window
					expect(
						new Set(h.of("epoch-started").map(e => e.epoch)).size,
					).toBeLessThanOrEqual(1)
					const near = h
						.of("block-summary")
						.map(e =>
							e.summary.tracks.find(
								t =>
									t.startHz <= CENTRE + OFFSET &&
									t.endHz >= CENTRE + OFFSET &&
									t.trackId !== undefined,
							),
						)
						.filter((t): t is BlockTrack => t !== undefined)
					expect(near.length).toBeGreaterThan(0)
					const ids = new Set(near.map(t => t.trackId))
					expect([...ids]).toHaveLength(1)
					// at least 750 ms of emission: the rollover happened at least once. The tracker
					// closes a snapshot only there while the emission lasts (WG11 5.1).
					expect(h.of("track-close").length).toBeGreaterThan(0)
					for (const c of h.of("track-close"))
						expect(c.endReason).toBe("max-duration")
				},
			),
			{ numRuns: 100 },
		)
	}, 30_000)
})
